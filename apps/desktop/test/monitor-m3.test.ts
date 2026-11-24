import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcEventName, IpcEvents, MetricsSnapshot, PromptRequest } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { MetricStore, parseCustomSample } from '../src/main/services/monitor/metric-store';
import { MonitorService } from '../src/main/services/monitor/monitor-service';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { createRepos } from './support/repos';
import { startTestSshServer } from './support/ssh-server';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let dir: string;
let db: Db;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-mon3-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  now = Date.UTC(2026, 9, 1, 0, 0, 0);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function snap(ts: number, o: { cpu?: number; mem?: number; disk?: Record<string, number>; rx?: number } = {}): MetricsSnapshot {
  return {
    hostId: 'h1',
    ts,
    state: 'ok',
    hostname: 'web',
    kernel: 'Linux',
    uptimeSec: 100,
    load: [1, 0.5, 0.2],
    cpu: { usage: o.cpu ?? 10, user: 0, system: 0, iowait: 0, cores: 4 },
    tempC: null,
    mem: { total: 1000, used: (o.mem ?? 50) * 10, available: 0, swapTotal: 0, swapUsed: 0 },
    disks: Object.entries(o.disk ?? { '/': 50 }).map(([mount, pct]) => ({ mount, fs: 'ext4', size: 100, used: pct, usePct: pct })),
    diskIo: null,
    net: [{ name: 'eth0', ip: null, rxBps: o.rx ?? 100, txBps: 50, rxTotal: 0, txTotal: 0 }],
    gpus: [],
    procs: [],
  };
}

describe('监控历史', () => {
  it('按小时汇总：平均值、磁盘取最新；分几次写库时按采样数加权合并', () => {
    const store = new MetricStore(db, () => now);
    store.record(snap(now + 1000, { cpu: 10, mem: 40, disk: { '/': 50 } }));
    store.record(snap(now + 3000, { cpu: 30, mem: 60, disk: { '/': 51 } }));
    // 过了一分钟：写一次库
    now += 61_000;
    store.record(snap(now, { cpu: 50, mem: 50, disk: { '/': 52 } }));
    // 下一个小时
    store.record(snap(Date.UTC(2026, 9, 1, 1, 10), { cpu: 80 }));
    const h = store.history('h1', 1);
    expect(h).toHaveLength(2);
    expect(h[0].cpu).toBeCloseTo(30);
    expect(h[0].mem).toBeCloseTo(50);
    expect(h[0].disk).toEqual({ '/': 52 });
    expect(h[0].netRx).toBeCloseTo(100);
    expect(h[1].cpu).toBeCloseTo(80);
  });

  it('磁盘写满预测：持续增长的分区给出天数，平稳的不预测，数据太少不预测', () => {
    const store = new MetricStore(db, () => now);
    const start = now;
    // 7 天，每 2 小时一个采样：/ 每天涨 2 个百分点（80% 起），/data 一直 40%
    for (let t = start; t <= start + 7 * DAY; t += 2 * HOUR) {
      now = t;
      const days = (t - start) / DAY;
      store.record(snap(t, { disk: { '/': 80 + 2 * days, '/data': 40 } }));
    }
    now = start + 7 * DAY;
    const f = store.forecast('h1');
    const root = f.find((x) => x.mount === '/')!;
    expect(root.slopePerDay).toBeCloseTo(2, 1);
    expect(root.usedPct).toBeCloseTo(94, 0);
    expect(root.daysToFull).toBeCloseTo(3, 0);
    expect(f.find((x) => x.mount === '/data')!.daysToFull).toBeNull();
    // 最快写满的排在前面
    expect(f[0].mount).toBe('/');

    const fresh = new MetricStore(db, () => now);
    fresh.record({ ...snap(now), hostId: 'h2' });
    expect(fresh.forecast('h2')[0]).toMatchObject({ daysToFull: null, samples: 1 });
  });

  it('只保留 30 天', () => {
    const store = new MetricStore(db, () => now);
    store.record(snap(now));
    store.flushHost('h1');
    now += 31 * DAY;
    store.record(snap(now));
    store.flushAll();
    expect(store.history('h1', 30)).toHaveLength(1);
    expect(db.prepare('SELECT count(*) AS n FROM metric_sample').get()).toEqual({ n: 1 });
  });
});

describe('自定义采集脚本', () => {
  it('解析 key=value：键不区分大小写，挂载点保留大小写；没有指标时返回 null', () => {
    const s = parseCustomSample('h', 'CPU = 12.5\nmem: 63\nload=0.15 0.10 0.05\ndisk./=71\nDISK./Data=40\nuptime=3600\nhostname=sw01\n垃圾行', 1);
    expect(s).toMatchObject({ state: 'ok', source: 'custom', hostname: 'sw01', uptimeSec: 3600, load: [0.15, 0.1, 0.05] });
    if (s?.state !== 'ok') throw new Error('x');
    expect(s.cpu?.usage).toBe(12.5);
    expect(s.mem).toMatchObject({ total: 100, used: 63 });
    expect(s.disks.map((d) => [d.mount, d.usePct])).toEqual([
      ['/', 71],
      ['/Data', 40],
    ]);
    expect(parseCustomSample('h', 'hello\nworld', 1)).toBeNull();
    expect(parseCustomSample('h', 'cpu=250', 1)).toMatchObject({ cpu: { usage: 100 } });
  });

  it('主机配置了自定义脚本时按间隔执行并解析，结果也写进历史', async () => {
    mkdirSync(join(dir, 'remote'));
    const server = await startTestSshServer({ root: join(dir, 'remote') });
    const { hosts } = createRepos(db, randomBytes(32));
    const id = hosts.create({
      folderId: null,
      name: 'switch',
      address: '127.0.0.1',
      port: server.port,
      username: 'tester',
      authMethod: 'PASSWORD',
      password: 'pw',
      keepaliveSec: 0,
      startupScript: null,
      note: null,
      jumpHostIds: [],
      monitorScript: 'echo cpu=42; echo mem=55; echo disk./=70; echo hostname=sw-core',
    }).id;
    expect(hosts.get(id)?.monitorScript).toContain('cpu=42');
    const snaps: MetricsSnapshot[] = [];
    let broker: PromptBroker;
    const emit = <E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void => {
      if (event === 'prompt.request') setTimeout(() => broker.answer(owner, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true }), 1);
      if (event === 'monitor.update') snaps.push(payload as MetricsSnapshot);
    };
    broker = new PromptBroker(emit);
    const pool = new SshPool(hosts, broker, 5000);
    const store = new MetricStore(db);
    const mon = new MonitorService(pool, emit, { sshSessionsOf: () => [] });
    mon.attach({ store, customScript: (h) => hosts.get(h)?.monitorScript ?? null });
    mon.subscribe(1, id);
    const start = Date.now();
    while (!snaps.some((s) => s.state === 'ok') && Date.now() - start < 8000) await new Promise((r) => setTimeout(r, 20));
    const ok = snaps.find((s) => s.state === 'ok');
    expect(ok).toMatchObject({ source: 'custom', hostname: 'sw-core', cpu: { usage: 42 } });
    mon.unsubscribe(1, id);
    // 停止时把这一小时的累计写进库
    expect(store.history(id, 1)[0]).toMatchObject({ cpu: 42, mem: 55, disk: { '/': 70 } });
    pool.closeAll();
    await server.close();
  });
});
