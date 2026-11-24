import { randomUUID } from 'node:crypto';
import {
  ALERT_LEVEL_LABEL,
  ALERT_MAIL_LABEL,
  ALERT_SOURCE_LABEL,
  REPORT_LEVEL_LABEL,
  type AlertDiagnosis,
  type AlertEvent,
  type AlertFilter,
  type AlertLevel,
  type AlertMailStatus,
  type AlertMetrics,
  type AlertSource,
  type Host,
  type MetricsSnapshot,
} from '@itm/protocol';
import type { Db } from '../db/database';
import { parseReportLevel } from '../schedule/plan';
import { UserError } from '../../util/errors';

/** 自动排查的超时 */
const DIAG_TIMEOUT_MS = 10 * 60_000;
/** 同一台主机在这段时间里排查过，就不再为新告警重复排查 */
const DIAG_COOLDOWN_MS = 15 * 60_000;
/** 排队等排查的告警上限（告警风暴时多出来的直接跳过） */
const DIAG_QUEUE_MAX = 20;
/** 告警日志保留天数 */
const RETENTION_DAYS = 90;
const MAX_RAW = 16 * 1024;

interface Row {
  id: string;
  source: AlertSource;
  level: AlertLevel;
  title: string;
  detail: string;
  host_id: string | null;
  host_name: string | null;
  source_name: string;
  alert_key: string;
  status: 'FIRING' | 'RESOLVED';
  count: number;
  created_at: number;
  last_at: number;
  resolved_at: number | null;
  metrics: string | null;
  diagnosis: string | null;
  mail: string | null;
  raw: string | null;
  related: string | null;
}

const json = <T,>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};

const toEvent = (r: Row): AlertEvent => ({
  id: r.id,
  source: r.source,
  level: r.level,
  title: r.title,
  detail: r.detail,
  hostId: r.host_id,
  hostName: r.host_name,
  sourceName: r.source_name,
  key: r.alert_key,
  status: r.status,
  count: r.count,
  createdAt: r.created_at,
  lastAt: r.last_at,
  resolvedAt: r.resolved_at,
  metrics: json(r.metrics),
  diagnosis: json(r.diagnosis),
  mail: json(r.mail),
  raw: r.raw,
  related: json(r.related),
});

/** 监控快照 → 告警时的指标 */
export function metricsOf(s: MetricsSnapshot | null | undefined, extra?: Record<string, string>): AlertMetrics | null {
  if (!s || s.state !== 'ok') return extra && Object.keys(extra).length ? { at: Date.now(), cpu: null, cores: null, mem: null, swap: null, load: null, disks: [], rxBps: null, txBps: null, uptimeSec: null, procs: [], extra } : null;
  const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  return {
    at: s.ts,
    cpu: s.cpu ? Math.round(s.cpu.usage * 10) / 10 : null,
    cores: s.cpu?.cores ?? null,
    mem: pct(s.mem.used, s.mem.total),
    swap: pct(s.mem.swapUsed, s.mem.swapTotal),
    load: s.load,
    disks: [...s.disks].sort((a, b) => b.usePct - a.usePct).slice(0, 8).map((d) => ({ mount: d.mount, usePct: Math.round(d.usePct * 10) / 10 })),
    rxBps: s.net.reduce((a, n) => a + n.rxBps, 0),
    txBps: s.net.reduce((a, n) => a + n.txBps, 0),
    uptimeSec: s.uptimeSec || null,
    procs: (s.procs ?? []).slice(0, 5).map((p) => ({ pid: p.pid, user: p.user, cpu: p.cpu, mem: p.mem, command: p.command.slice(0, 200) })),
    ...(extra && Object.keys(extra).length ? { extra } : {}),
  };
}

/** 指标的文字说明（排查提示词和邮件里用） */
export function describeMetrics(m: AlertMetrics | null): string {
  if (!m) return '（没有采集到）';
  const lines: string[] = [];
  const top = [m.cpu !== null ? `CPU ${m.cpu}%${m.cores ? `（${m.cores} 核）` : ''}` : '', m.mem !== null ? `内存 ${m.mem}%` : '', m.swap ? `swap ${m.swap}%` : '', m.load ? `负载 ${m.load.map((x) => x.toFixed(2)).join(' / ')}` : '', m.uptimeSec ? `已运行 ${Math.floor(m.uptimeSec / 86400)} 天` : '']
    .filter(Boolean)
    .join('，');
  if (top) lines.push(top);
  if (m.disks.length) lines.push(`磁盘：${m.disks.map((d) => `${d.mount} ${d.usePct}%`).join('，')}`);
  if (m.rxBps !== null) lines.push(`网络：下行 ${Math.round((m.rxBps ?? 0) / 1024)} KB/s，上行 ${Math.round((m.txBps ?? 0) / 1024)} KB/s`);
  if (m.procs.length) lines.push(`占用最高的进程：\n${m.procs.map((p) => `  ${p.pid} ${p.user} CPU ${p.cpu}% 内存 ${p.mem}% ${p.command}`).join('\n')}`);
  if (m.extra) lines.push(`告警携带的信息：\n${Object.entries(m.extra).slice(0, 30).map(([k, v]) => `  ${k}=${v}`).join('\n')}`);
  return lines.join('\n') || '（没有采集到）';
}

/** 自动排查的提示词：只读，给结论和依据 */
export function diagnosisPrompt(e: Pick<AlertEvent, 'title' | 'level' | 'source' | 'sourceName' | 'detail' | 'createdAt' | 'metrics'>, hosts: string[]): string {
  return [
    `这是一条告警的自动排查（无人值守，没有人在旁边）。目标主机：${hosts.join('、')}。`,
    '',
    `告警：${e.title}`,
    `级别：${ALERT_LEVEL_LABEL[e.level]}；来源：${ALERT_SOURCE_LABEL[e.source]}（${e.sourceName}）；时间：${new Date(e.createdAt).toLocaleString('zh-CN', { hour12: false })}`,
    e.detail ? `详情：\n${e.detail}` : '',
    `告警时的指标：\n${describeMetrics(e.metrics)}`,
    '',
    '要求：',
    '1. 只用只读命令排查（查看进程、资源、日志、服务状态、最近的变更），不要做任何修改；需要处理的写进建议里，不要执行。',
    '2. 先确认告警现在是否还存在，再找原因；每个结论都要附上依据（哪条命令、关键输出）。',
    '3. 回答格式：第一行写「结论：正常」「结论：需要注意」或「结论：异常」（告警已经恢复且没有隐患算正常），',
    '   然后依次写「## 原因」「## 依据」「## 建议处理」（建议的命令放在 ```bash 代码块里）。简洁，不要复述整段输出。',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export interface RaiseInput {
  source: AlertSource;
  level: AlertLevel;
  title: string;
  detail: string;
  /** 告警对应的主机（排查的目标）；第一台作为显示的主机 */
  hosts: Pick<Host, 'id' | 'name' | 'address'>[];
  sourceName: string;
  key: string;
  metrics: AlertMetrics | null;
  raw?: string | null;
  related?: AlertEvent['related'];
  /** 发邮件 */
  email: boolean;
  /** 自动排查（有主机时）；定时任务成功时不排查 */
  diagnose: boolean;
}

export interface AlertCenterDeps {
  db: Db;
  hosts: { get(id: string): Host | null };
  /** 无人值守的 Agent（只读排查） */
  agent: {
    runUnattended(
      owner: number,
      o: {
        kind: 'prompt';
        title: string;
        prompt: string;
        hostIds: string[];
        policyCap: 'READONLY';
        approve(step: { command: string; hostName: string; level?: string | null; reasons: string[] }): Promise<boolean>;
        timeoutMs: number;
        note?: string;
        approvalLabel?: string;
      },
    ): Promise<{ conversationId: string; text: string; status: string; restore(t: string): string }>;
  };
  owner(): number;
  /** 写操作的 AI 审批（只读排查里极少出现；高危、生产环境一律不放行） */
  review(command: string, host: Host | null, level: string, reasons: string[]): Promise<{ ok: boolean; reason: string }>;
  /** 发邮件到当前登录账号的邮箱 */
  mail(subject: string, text: string): Promise<{ status: AlertMailStatus; message?: string | null }>;
  notify(title: string, body: string): void;
  emit(firing: number): void;
  /** 主机最近的监控快照（告警没有带指标时补上） */
  snapshot?(hostId: string): MetricsSnapshot | null;
  now?: () => number;
}

/**
 * 告警中心（第二十八轮）：记录告警日志（同一个键告警中只累加次数）、排队做 AI 只读排查（一次一个，同一台主机 15 分钟内不重复排查）、
 * 排查完（或者不需要排查时立即）把告警、指标和结论发到当前登录账号的邮箱。
 */
export class AlertCenter {
  private readonly queue: string[] = [];
  private running = false;
  private stopped = false;
  private readonly lastDiag = new Map<string, { at: number; alertId: string }>();

  constructor(private readonly d: AlertCenterDeps) {
    this.cleanup();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  stop(): void {
    this.stopped = true;
    this.queue.splice(0);
  }

  get(id: string): AlertEvent | null {
    const r = this.d.db.prepare<[string], Row>('SELECT * FROM alert_event WHERE id = ?').get(id);
    return r ? toEvent(r) : null;
  }

  firing(): number {
    return this.d.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM alert_event WHERE status = 'FIRING'").get()?.n ?? 0;
  }

  list(f: AlertFilter = {}): { items: AlertEvent[]; total: number; firing: number } {
    const conds: string[] = [];
    const args: unknown[] = [];
    const eq = (col: string, v: unknown): void => {
      conds.push(`${col} = ?`);
      args.push(v);
    };
    if (f.source) eq('source', f.source);
    if (f.level) eq('level', f.level);
    if (f.status) eq('status', f.status);
    if (f.hostId) eq('host_id', f.hostId);
    const q = f.q?.trim();
    if (q) {
      conds.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(detail), lower(?)) > 0 OR instr(lower(coalesce(host_name, '')), lower(?)) > 0 OR instr(lower(source_name), lower(?)) > 0)");
      args.push(q, q, q, q);
    }
    if (f.from) {
      conds.push('created_at >= ?');
      args.push(f.from);
    }
    if (f.to) {
      conds.push('created_at <= ?');
      args.push(f.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = this.d.db.prepare<unknown[], { n: number }>(`SELECT count(*) AS n FROM alert_event ${where}`).get(...args)?.n ?? 0;
    const items = this.d.db
      .prepare<unknown[], Row>(`SELECT * FROM alert_event ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Math.max(1, f.limit ?? 50), 200), Math.max(0, f.offset ?? 0))
      .map(toEvent);
    return { items, total, firing: this.firing() };
  }

  delete(ids: string[]): void {
    const stmt = this.d.db.prepare('DELETE FROM alert_event WHERE id = ?');
    this.d.db.transaction(() => ids.slice(0, 1000).forEach((id) => stmt.run(String(id))))();
    this.changed();
  }

  private cleanup(): void {
    try {
      this.d.db.prepare('DELETE FROM alert_event WHERE created_at < ?').run(this.now() - RETENTION_DAYS * 86_400_000);
    } catch {
      // 清理失败不影响使用
    }
  }

  private changed(): void {
    this.d.emit(this.firing());
  }

  private patch(id: string, cols: Partial<Record<'diagnosis' | 'mail' | 'status' | 'resolved_at' | 'count' | 'last_at' | 'level' | 'detail' | 'metrics', string | number | null>>): void {
    const keys = Object.keys(cols);
    if (!keys.length) return;
    this.d.db.prepare(`UPDATE alert_event SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => cols[k as keyof typeof cols] ?? null), id);
  }

  /**
   * 记录一条告警。同一个键还在告警中时只累加次数和更新时间（不重复排查、不重复发邮件），返回那一条。
   */
  raise(input: RaiseInput): AlertEvent {
    const now = this.now();
    const open = this.d.db.prepare<[string], Row>("SELECT * FROM alert_event WHERE alert_key = ? AND status = 'FIRING' ORDER BY created_at DESC LIMIT 1").get(input.key);
    if (open) {
      this.patch(open.id, { count: open.count + 1, last_at: now, ...(input.metrics && !open.metrics ? { metrics: JSON.stringify(input.metrics) } : {}) });
      this.changed();
      return this.get(open.id)!;
    }
    const id = randomUUID();
    const host = input.hosts[0] ?? null;
    if (!input.metrics && host) input = { ...input, metrics: metricsOf(this.d.snapshot?.(host.id)) };
    const canDiagnose = input.diagnose && input.hosts.length > 0;
    const diagnosis: AlertDiagnosis | null = canDiagnose ? { status: 'QUEUED', conversationId: null, report: null, level: null, message: null, startedAt: null, endedAt: null } : null;
    this.d.db
      .prepare(
        `INSERT INTO alert_event (id, source, level, title, detail, host_id, host_name, source_name, alert_key, status, count, created_at, last_at, resolved_at, metrics, diagnosis, mail, raw, related)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FIRING', 1, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.source,
        input.level,
        input.title.slice(0, 300),
        input.detail.slice(0, 16_000),
        host?.id ?? null,
        host ? (input.hosts.length > 1 ? `${host.name} 等 ${input.hosts.length} 台` : host.name) : null,
        input.sourceName.slice(0, 200),
        input.key.slice(0, 500),
        now,
        now,
        input.metrics ? JSON.stringify(input.metrics) : null,
        diagnosis ? JSON.stringify(diagnosis) : null,
        input.email ? null : JSON.stringify({ status: 'OFF', at: now, message: null }),
        input.raw ? input.raw.slice(0, MAX_RAW) : null,
        input.related ? JSON.stringify(input.related) : null,
      );
    this.targets.set(id, { hostIds: input.hosts.map((h) => h.id), email: input.email });
    this.changed();
    if (canDiagnose) this.enqueue(id);
    else if (input.email) void this.sendMail(id);
    return this.get(id)!;
  }

  /** 告警恢复（监控指标回落、定时任务恢复正常） */
  resolve(key: string): void {
    const r = this.d.db.prepare("UPDATE alert_event SET status = 'RESOLVED', resolved_at = ? WHERE alert_key = ? AND status = 'FIRING'").run(this.now(), key);
    if (r.changes) this.changed();
  }

  /** 某个前缀的告警全部恢复（定时任务这次执行正常时，之前的告警恢复） */
  resolvePrefix(prefix: string): void {
    const r = this.d.db.prepare("UPDATE alert_event SET status = 'RESOLVED', resolved_at = ? WHERE status = 'FIRING' AND substr(alert_key, 1, ?) = ?").run(this.now(), prefix.length, prefix);
    if (r.changes) this.changed();
  }

  /** 手动重新排查 */
  diagnose(id: string): void {
    const e = this.get(id);
    if (!e) throw new UserError('告警不存在或已删除');
    if (!e.hostId) throw new UserError('这条告警没有对应的主机，不能排查');
    if (this.queue.includes(id) || e.diagnosis?.status === 'RUNNING') throw new UserError('这条告警正在排查');
    if (!this.targets.has(id)) this.targets.set(id, { hostIds: [e.hostId], email: false });
    this.lastDiag.delete(e.hostId);
    this.patch(id, { diagnosis: JSON.stringify({ status: 'QUEUED', conversationId: null, report: null, level: null, message: null, startedAt: null, endedAt: null } satisfies AlertDiagnosis) });
    this.changed();
    this.enqueue(id, true);
  }

  /** 排查目标和邮件开关（只在内存里；重启后排队中的告警按跳过处理） */
  private readonly targets = new Map<string, { hostIds: string[]; email: boolean }>();

  private enqueue(id: string, manual = false): void {
    if (this.queue.length >= DIAG_QUEUE_MAX) {
      this.finishDiag(id, { status: 'SKIPPED', message: '同时排队的告警太多，这条没有排查' });
      return;
    }
    if (!manual) {
      const t = this.targets.get(id);
      const recent = t?.hostIds.map((h) => this.lastDiag.get(h)).find((x) => x && this.now() - x.at < DIAG_COOLDOWN_MS);
      if (recent) {
        this.finishDiag(id, { status: 'SKIPPED', message: '这台主机 15 分钟内刚排查过（见那条告警的排查结果），这次没有重复排查' });
        return;
      }
      t?.hostIds.forEach((h) => this.lastDiag.set(h, { at: this.now(), alertId: id }));
    }
    this.queue.push(id);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let id = this.queue.shift(); id && !this.stopped; id = this.queue.shift()) await this.runDiag(id);
    } finally {
      this.running = false;
    }
  }

  private async runDiag(id: string): Promise<void> {
    const e = this.get(id);
    const t = this.targets.get(id);
    if (!e || !t) return;
    const hosts = t.hostIds.map((h) => this.d.hosts.get(h)).filter((h): h is Host => !!h && h.protocol === 'SSH');
    if (!hosts.length) {
      this.finishDiag(id, { status: 'SKIPPED', message: '对应的主机不是 SSH 主机或已被删除' });
      return;
    }
    const startedAt = this.now();
    this.patch(id, { diagnosis: JSON.stringify({ status: 'RUNNING', conversationId: null, report: null, level: null, message: null, startedAt, endedAt: null } satisfies AlertDiagnosis) });
    this.changed();
    try {
      const r = await this.d.agent.runUnattended(this.d.owner(), {
        kind: 'prompt',
        title: `告警排查：${e.title}`.slice(0, 60),
        prompt: diagnosisPrompt(e, hosts.map((h) => h.name)),
        hostIds: hosts.map((h) => h.id),
        policyCap: 'READONLY',
        timeoutMs: DIAG_TIMEOUT_MS,
        note: '（告警自动排查，无人值守：只做只读检查；写操作由 AI 审批，一般不会放行）',
        approvalLabel: 'AI 审批',
        approve: async (step) => {
          const host = hosts.find((h) => h.name === step.hostName) ?? null;
          const v = await this.d.review(step.command, host, step.level ?? 'L1', step.reasons);
          step.reasons = [...step.reasons, v.reason];
          return v.ok;
        },
      });
      const text = r.restore(r.text).trim();
      const ok = r.status === 'SUCCESS' && !!text;
      this.finishDiag(id, {
        status: ok ? 'DONE' : 'FAILED',
        conversationId: r.conversationId,
        report: text || null,
        level: ok ? parseReportLevel(text) : null,
        message: r.status === 'TIMEOUT' ? '排查超时（10 分钟）' : r.status === 'FAILED' ? text || '排查失败' : null,
        startedAt,
      });
    } catch (e2) {
      this.finishDiag(id, { status: 'FAILED', message: (e2 as Error).message, startedAt });
    }
  }

  private finishDiag(id: string, d: Partial<AlertDiagnosis> & { status: AlertDiagnosis['status'] }): void {
    const full: AlertDiagnosis = { conversationId: null, report: null, level: null, message: null, startedAt: null, endedAt: this.now(), ...d };
    this.patch(id, { diagnosis: JSON.stringify(full) });
    this.changed();
    const e = this.get(id);
    if (e && full.status === 'DONE' && full.level && full.level !== 'OK') this.d.notify(`告警排查完成：${e.title}`, `结论：${REPORT_LEVEL_LABEL[full.level]}${e.hostName ? ` · ${e.hostName}` : ''}`);
    if (this.targets.get(id)?.email) void this.sendMail(id);
    this.targets.delete(id);
  }

  /** 邮件：告警、当时的指标、AI 排查结论 */
  private async sendMail(id: string): Promise<void> {
    const e = this.get(id);
    if (!e) return;
    const time = (t: number): string => new Date(t).toLocaleString('zh-CN', { hour12: false });
    const dg = e.diagnosis;
    const verdict = dg?.status === 'DONE' && dg.level ? REPORT_LEVEL_LABEL[dg.level] : null;
    const subject = `【${ALERT_LEVEL_LABEL[e.level]}】${e.title}${e.hostName ? ` · ${e.hostName}` : ''}${verdict ? ` · AI 结论：${verdict}` : ''}`;
    const text = [
      `告警：${e.title}`,
      `级别：${ALERT_LEVEL_LABEL[e.level]}　来源：${ALERT_SOURCE_LABEL[e.source]}（${e.sourceName}）`,
      e.hostName ? `主机：${e.hostName}` : '',
      `时间：${time(e.createdAt)}${e.status === 'RESOLVED' && e.resolvedAt ? `（${time(e.resolvedAt)} 已恢复）` : ''}`,
      '',
      e.detail ? `详情：\n${e.detail}\n` : '',
      `当时的指标：\n${describeMetrics(e.metrics)}`,
      '',
      dg
        ? dg.status === 'DONE'
          ? `AI 自动排查（只读）：\n${dg.report ?? ''}`
          : `AI 自动排查：${dg.status === 'SKIPPED' ? '没有排查' : '没有完成'}${dg.message ? `（${dg.message}）` : ''}`
        : '',
    ]
      .filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== ''))
      .join('\n');
    let mail: { status: AlertMailStatus; at: number; message: string | null };
    try {
      const r = await this.d.mail(subject, text);
      mail = { status: r.status, at: this.now(), message: r.message ?? null };
    } catch (err) {
      mail = { status: 'FAILED', at: this.now(), message: (err as Error).message.slice(0, 300) };
    }
    this.patch(id, { mail: JSON.stringify(mail) });
    this.changed();
    if (mail.status !== 'SENT' && mail.status !== 'NOT_LOGGED_IN' && mail.status !== 'NO_EMAIL') {
      // 服务端没有配置邮件、发送失败时在本机提醒一次（没有登录 / 没有邮箱是预期内的，不提醒）
      this.d.notify(`告警邮件没有发出：${e.title}`, `${ALERT_MAIL_LABEL[mail.status]}${mail.message ? `：${mail.message}` : ''}`);
    }
  }
}
