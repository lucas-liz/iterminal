/**
 * 第二十八轮：告警中心（告警日志、AI 自动只读排查、邮件）、常驻监控触发告警（外部告警接入第二十九轮已去掉）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MONITOR_ALERT, type AlertMailStatus, type Host, type MetricsSnapshot, type MonitorAlert } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { AlertCenter, describeMetrics, diagnosisPrompt, metricsOf, type RaiseInput } from '../src/main/services/alert/alert-center';
import { ResidentMonitor } from '../src/main/services/monitor/resident';

const snap = (hostId: string, cpu: number): MetricsSnapshot => ({
  hostId,
  ts: 1000,
  state: 'ok',
  hostname: 'x',
  kernel: 'k',
  uptimeSec: 86_400,
  load: [1, 1, 1],
  cpu: { usage: cpu, user: cpu, system: 0, iowait: 0, cores: 4 },
  tempC: null,
  mem: { total: 100, used: 50, available: 50, swapTotal: 0, swapUsed: 0 },
  disks: [{ mount: '/', fs: 'ext4', size: 100, used: 40, usePct: 40 }],
  diskIo: null,
  net: [],
  gpus: [],
  procs: [{ pid: 7, user: 'root', cpu: 88, mem: 2, rss: 1, command: 'java -jar app.jar' }],
});

describe('告警中心', () => {
  let dir: string;
  let db: Db;
  let mails: { subject: string; text: string }[];
  let mailStatus: AlertMailStatus;
  let runs: { prompt: string; hostIds: string[] }[];
  let notices: string[];
  let center: AlertCenter;
  const host = { id: 'h1', name: 'web-01', address: '10.0.0.8', protocol: 'SSH', osInfo: null } as unknown as Host;
  const base = (p: Partial<RaiseInput> = {}): RaiseInput => ({
    source: 'MONITOR',
    level: 'WARN',
    title: 'web-01 CPU 使用率过高：CPU 96%',
    detail: 'CPU 96%（阈值 90%）',
    hosts: [host],
    sourceName: '常驻监控 · CPU',
    key: 'monitor:h1:cpu',
    metrics: metricsOf(snap('h1', 96)),
    email: true,
    diagnose: true,
    ...p,
  });
  const idle = async (): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      const all = center.list({ limit: 200 }).items;
      if (all.every((e) => !e.diagnosis || !['QUEUED', 'RUNNING'].includes(e.diagnosis.status)) && all.every((e) => e.mail)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'itm-r28-'));
    db = openDatabase(join(dir, 'db'), randomBytes(32));
    mails = [];
    mailStatus = 'SENT';
    runs = [];
    notices = [];
    center = new AlertCenter({
      db,
      hosts: { get: (id) => (id === 'h1' ? host : null) },
      agent: {
        runUnattended: async (_owner, o) => {
          runs.push({ prompt: o.prompt, hostIds: o.hostIds });
          // 只读排查里出现写操作时交给 AI 审批
          const ok = await o.approve({ command: 'systemctl restart app', hostName: 'web-01', level: 'L1', reasons: [] });
          return { conversationId: 'conv-1', text: `结论：异常\n## 原因\njava 进程占满 CPU（写操作${ok ? '放行' : '没有放行'}）`, status: 'SUCCESS', restore: (t: string) => t };
        },
      },
      owner: () => 1,
      review: async () => ({ ok: false, reason: 'AI 审批没有放行' }),
      mail: async (subject, text) => {
        mails.push({ subject, text });
        return { status: mailStatus };
      },
      notify: (t) => void notices.push(t),
      emit: () => undefined,
    });
  });

  afterEach(() => {
    center.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('记录告警和当时的指标；AI 只读排查后把告警、指标、结论一起发邮件；同一个键告警中只累加次数', async () => {
    const e = center.raise(base());
    expect(e).toMatchObject({ status: 'FIRING', count: 1, hostName: 'web-01' });
    expect(e.metrics).toMatchObject({ cpu: 96, cores: 4, mem: 50 });
    await idle();
    const done = center.get(e.id)!;
    expect(done.diagnosis).toMatchObject({ status: 'DONE', level: 'ERROR', conversationId: 'conv-1' });
    expect(done.diagnosis?.report).toContain('写操作没有放行');
    expect(done.mail?.status).toBe('SENT');
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toContain('只用只读命令');
    expect(runs[0].prompt).toContain('CPU 96%');
    expect(mails[0].subject).toContain('AI 结论：异常');
    expect(mails[0].text).toContain('java -jar app.jar');
    expect(mails[0].text).toContain('java 进程占满 CPU');
    // 还在告警中：再次触发只累加次数，不重复排查和发邮件
    center.raise(base());
    expect(center.get(e.id)!.count).toBe(2);
    await idle();
    expect(runs).toHaveLength(1);
    expect(mails).toHaveLength(1);
    // 恢复后再触发是新的一条；同一台主机 15 分钟内不重复排查
    center.resolve('monitor:h1:cpu');
    expect(center.get(e.id)!.status).toBe('RESOLVED');
    const e2 = center.raise(base());
    await idle();
    expect(center.get(e2.id)!.diagnosis?.status).toBe('SKIPPED');
    expect(runs).toHaveLength(1);
    expect(mails).toHaveLength(2);
    // 手动重新排查不受 15 分钟限制
    center.diagnose(e2.id);
    await idle();
    expect(center.get(e2.id)!.diagnosis?.status).toBe('DONE');
  });

  it('没有主机或不需要排查时立即发邮件；关闭邮件时不发；没有登录时记录原因；筛选和按前缀恢复', async () => {
    center.raise(base({ source: 'EXTERNAL', hosts: [], key: 'ext:r:1', title: '外部告警', diagnose: true }));
    center.raise(base({ source: 'SCHEDULE', key: 'schedule:t1:run1', title: '定时任务「巡检」成功', level: 'INFO', diagnose: false, email: false }));
    mailStatus = 'NOT_LOGGED_IN';
    center.raise(base({ source: 'SCHEDULE', key: 'schedule:t1:run2', title: '定时任务「巡检」失败', level: 'CRIT', hosts: [], diagnose: false }));
    await idle();
    const all = center.list({});
    expect(all.total).toBe(3);
    expect(all.items.map((e) => [e.title, e.mail?.status])).toEqual([
      ['定时任务「巡检」失败', 'NOT_LOGGED_IN'],
      ['定时任务「巡检」成功', 'OFF'],
      ['外部告警', 'SENT'],
    ]);
    expect(runs).toHaveLength(0);
    expect(center.list({ source: 'SCHEDULE' }).total).toBe(2);
    expect(center.list({ level: 'CRIT' }).total).toBe(1);
    expect(center.list({ q: '外部' }).total).toBe(1);
    center.resolvePrefix('schedule:t1:');
    expect(center.list({ status: 'FIRING' }).total).toBe(1);
    // 没有登录是预期内的，不弹提醒
    expect(notices.some((n) => n.includes('没有发出'))).toBe(false);
  });

  it('指标说明和排查提示词', () => {
    const m = metricsOf(snap('h1', 50), { alertname: 'X' })!;
    const text = describeMetrics(m);
    expect(text).toContain('CPU 50%（4 核）');
    expect(text).toContain('/ 40%');
    expect(text).toContain('alertname=X');
    expect(metricsOf(null)).toBeNull();
    expect(metricsOf({ hostId: 'h', ts: 0, state: 'error', message: 'x' }, { a: '1' })?.extra).toEqual({ a: '1' });
    const p = diagnosisPrompt({ title: 't', level: 'CRIT', source: 'EXTERNAL', sourceName: 'Prometheus', detail: 'd', createdAt: 0, metrics: null }, ['web-01']);
    expect(p).toContain('结论：正常');
    expect(p).toContain('不要做任何修改');
  });
});

describe('常驻监控触发告警', () => {
  it('持续超过阈值时交给告警中心（同类告警按冷却时间），恢复时通知恢复；关闭「连不上算告警」后不告警', () => {
    let now = 10_000_000;
    let listener: ((s: MetricsSnapshot) => void) | null = null;
    const latest = new Map<string, MetricsSnapshot>();
    const raised: MonitorAlert[] = [];
    const cleared: string[] = [];
    let offline = true;
    const r = new ResidentMonitor({
      monitor: { subscribe: () => undefined, unsubscribe: () => undefined, restart: () => false, latest: (id) => latest.get(id) ?? null, onSnapshot: (fn) => ((listener = fn), () => (listener = null)) },
      hostIds: () => ['h1'],
      config: () => ({ ...DEFAULT_MONITOR_ALERT, sustainMin: 0, cooldownMin: 30, offline }),
      disabled: () => false,
      hostName: () => 'web-01',
      notify: () => undefined,
      emit: () => undefined,
      onAlert: (a) => void raised.push(a),
      onClear: (h, k) => void cleared.push(`${h}:${k}`),
      now: () => now,
    });
    r.start();
    const push = (s: MetricsSnapshot): void => {
      latest.set(s.hostId, s);
      listener!(s);
    };
    push(snap('h1', 95));
    expect(raised.map((a) => a.kind)).toEqual(['cpu']);
    push(snap('h1', 20));
    expect(cleared).toEqual(['h1:cpu']);
    now += 60_000;
    push(snap('h1', 95));
    expect(raised).toHaveLength(1);
    now += 31 * 60_000;
    push(snap('h1', 20));
    push(snap('h1', 95));
    expect(raised).toHaveLength(2);
    offline = false;
    push({ hostId: 'h1', ts: 0, state: 'error', message: '超时' });
    now += 5 * 60_000;
    r.tick();
    expect(raised.map((a) => a.kind)).toEqual(['cpu', 'cpu']);
    r.stop();
  });
});
