import type { DiskForecast, MetricSample, MetricsSnapshot } from '@itm/protocol';
import type { Db } from '../db/database';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 本地保留 30 天 */
const KEEP_DAYS = 30;
/** 内存里攒着的采样多久写一次库（2 秒一个采样，不能每个都写） */
const FLUSH_MS = 60_000;
/** 预测用最近 7 天的数据，至少 6 个小时的采样、跨度至少 6 小时 */
const FORECAST_DAYS = 7;
const MIN_POINTS = 6;

interface Acc {
  hour: number;
  n: number;
  cpu: number;
  cpuN: number;
  mem: number;
  load1: number;
  rx: number;
  tx: number;
  disk: Record<string, number>;
}

interface Row {
  ts: number;
  cpu: number | null;
  mem: number | null;
  load1: number | null;
  disk: string | null;
  net_rx: number | null;
  net_tx: number | null;
  n: number;
}

const avg = (sum: number, n: number): number | null => (n > 0 ? sum / n : null);

/**
 * 监控历史（文档一 6.4）：每台主机每小时一条（这一小时的平均值；磁盘取最新值），保留 30 天；
 * 用最近 7 天的磁盘使用率做线性回归，估算还有几天写满。
 */
export class MetricStore {
  private readonly acc = new Map<string, Acc>();
  private readonly lastFlush = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  record(snap: MetricsSnapshot): void {
    if (snap.state !== 'ok') return;
    const hour = Math.floor(snap.ts / HOUR) * HOUR;
    let a = this.acc.get(snap.hostId);
    if (a && a.hour !== hour) {
      this.flushHost(snap.hostId);
      a = undefined;
    }
    if (!a) {
      a = { hour, n: 0, cpu: 0, cpuN: 0, mem: 0, load1: 0, rx: 0, tx: 0, disk: {} };
      this.acc.set(snap.hostId, a);
      this.lastFlush.set(snap.hostId, this.now());
    }
    a.n++;
    if (snap.cpu) {
      a.cpu += snap.cpu.usage;
      a.cpuN++;
    }
    a.mem += snap.mem.total > 0 ? (snap.mem.used / snap.mem.total) * 100 : 0;
    a.load1 += snap.load[0];
    a.rx += snap.net.reduce((s, n) => s + n.rxBps, 0);
    a.tx += snap.net.reduce((s, n) => s + n.txBps, 0);
    for (const d of snap.disks) a.disk[d.mount] = d.usePct;
    if (this.now() - (this.lastFlush.get(snap.hostId) ?? 0) >= FLUSH_MS) this.flushHost(snap.hostId);
  }

  /** 把内存里这一小时的累计写进库（和库里已有的同一小时按采样数加权合并） */
  flushHost(hostId: string): void {
    const a = this.acc.get(hostId);
    if (!a || a.n === 0) return;
    this.lastFlush.set(hostId, this.now());
    const old = this.db.prepare<[string, number], Row>('SELECT ts, cpu, mem, load1, disk, net_rx, net_tx, n FROM metric_sample WHERE host_id = ? AND ts = ?').get(hostId, a.hour);
    const on = old?.n ?? 0;
    // 保留两位小数
    const r2 = (v: number): number => Math.round(v * 100) / 100;
    const merge = (oldV: number | null, sum: number, n: number): number | null => {
      const cur = avg(sum, n);
      if (cur === null) return oldV;
      if (oldV === null || on === 0) return r2(cur);
      return r2((oldV * on + sum) / (on + n));
    };
    const disk = { ...(old?.disk ? (JSON.parse(old.disk) as Record<string, number>) : {}), ...a.disk };
    this.db
      .prepare(
        `INSERT INTO metric_sample (host_id, ts, cpu, mem, load1, disk, net_rx, net_tx, n) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (host_id, ts) DO UPDATE SET cpu = excluded.cpu, mem = excluded.mem, load1 = excluded.load1, disk = excluded.disk,
           net_rx = excluded.net_rx, net_tx = excluded.net_tx, n = excluded.n`,
      )
      .run(
        hostId,
        a.hour,
        merge(old?.cpu ?? null, a.cpu, a.cpuN),
        merge(old?.mem ?? null, a.mem, a.n),
        merge(old?.load1 ?? null, a.load1, a.n),
        JSON.stringify(disk),
        merge(old?.net_rx ?? null, a.rx, a.n),
        merge(old?.net_tx ?? null, a.tx, a.n),
        on + a.n,
      );
    this.acc.set(hostId, { ...a, n: 0, cpu: 0, cpuN: 0, mem: 0, load1: 0, rx: 0, tx: 0, disk: {} });
  }

  flushAll(): void {
    for (const id of this.acc.keys()) this.flushHost(id);
    this.prune();
  }

  prune(): void {
    this.db.prepare('DELETE FROM metric_sample WHERE ts < ?').run(this.now() - KEEP_DAYS * DAY);
  }

  history(hostId: string, days: number): MetricSample[] {
    this.flushHost(hostId);
    const since = this.now() - Math.min(Math.max(days, 1), KEEP_DAYS) * DAY;
    return this.db
      .prepare<[string, number], Row>('SELECT ts, cpu, mem, load1, disk, net_rx, net_tx, n FROM metric_sample WHERE host_id = ? AND ts >= ? ORDER BY ts')
      .all(hostId, since)
      .map((r) => ({
        ts: r.ts,
        cpu: r.cpu,
        mem: r.mem,
        load1: r.load1,
        disk: r.disk ? (JSON.parse(r.disk) as Record<string, number>) : {},
        netRx: r.net_rx,
        netTx: r.net_tx,
      }));
  }

  /** 每个挂载点：最小二乘拟合「使用率 ~ 时间」，斜率为正时估算到 100% 的天数 */
  forecast(hostId: string): DiskForecast[] {
    const samples = this.history(hostId, FORECAST_DAYS);
    const mounts = new Set(samples.flatMap((s) => Object.keys(s.disk)));
    const out: DiskForecast[] = [];
    for (const mount of mounts) {
      const pts = samples.filter((s) => s.disk[mount] !== undefined).map((s) => ({ x: s.ts / DAY, y: s.disk[mount] }));
      const last = pts.at(-1)!;
      if (pts.length < MIN_POINTS || (pts.at(-1)!.x - pts[0].x) * 24 < MIN_POINTS) {
        out.push({ mount, usedPct: last.y, slopePerDay: 0, daysToFull: null, samples: pts.length });
        continue;
      }
      const n = pts.length;
      const mx = pts.reduce((s, p) => s + p.x, 0) / n;
      const my = pts.reduce((s, p) => s + p.y, 0) / n;
      const sxy = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
      const sxx = pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
      const slope = sxx > 0 ? sxy / sxx : 0;
      // 用拟合线在当前时刻的值估算，比最后一个采样更稳
      const nowX = this.now() / DAY;
      const fitted = my + slope * (nowX - mx);
      const daysToFull = slope > 0.01 ? Math.max(0, (100 - Math.max(fitted, last.y)) / slope) : null;
      out.push({ mount, usedPct: last.y, slopePerDay: slope, daysToFull, samples: n });
    }
    return out.sort((a, b) => (a.daysToFull ?? Infinity) - (b.daysToFull ?? Infinity));
  }
}

/**
 * 自定义采集脚本的输出（非 Linux 设备，文档一 6.4）：每行一个 key=value
 *   cpu=12.5   mem=63   load=0.15 0.10 0.05   disk./=71   disk./data=40   uptime=123456   hostname=sw01
 * 认不出的行忽略；至少要有 cpu、mem、disk 中的一项。
 */
export function parseCustomSample(hostId: string, text: string, ts: number): MetricsSnapshot | null {
  const kv = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_.][\w./-]*)\s*[=:]\s*(.+?)\s*$/.exec(line);
    // 键不区分大小写，但 disk. 后面的挂载点保留原样
    if (m) kv.set(/^disk\./i.test(m[1]) ? `disk.${m[1].slice(5)}` : m[1].toLowerCase(), m[2]);
  }
  const num = (k: string): number | null => {
    const v = kv.get(k);
    const n = v === undefined ? NaN : Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const clampPct = (v: number): number => Math.min(100, Math.max(0, v));
  const cpu = num('cpu');
  const mem = num('mem');
  const disks = [...kv.entries()]
    .filter(([k]) => k.startsWith('disk.'))
    .map(([k, v]) => ({ mount: k.slice(5) || '/', pct: Number.parseFloat(v) }))
    .filter((d) => Number.isFinite(d.pct));
  if (cpu === null && mem === null && disks.length === 0) return null;
  const load = (kv.get('load') ?? '')
    .split(/[\s,]+/)
    .map(Number.parseFloat)
    .filter(Number.isFinite);
  return {
    hostId,
    ts,
    state: 'ok',
    source: 'custom',
    hostname: kv.get('hostname') ?? '',
    kernel: kv.get('os') ?? '自定义采集',
    uptimeSec: num('uptime') ?? 0,
    load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0],
    cpu: cpu === null ? null : { usage: clampPct(cpu), user: 0, system: 0, iowait: 0, cores: 0 },
    tempC: num('temp'),
    // 自定义脚本只给使用率：按 100 份表示，界面只显示百分比
    mem: { total: 100, used: mem === null ? 0 : clampPct(mem), available: 0, swapTotal: 0, swapUsed: 0 },
    disks: disks.map((d) => ({ mount: d.mount, fs: '', size: 100, used: clampPct(d.pct), usePct: clampPct(d.pct) })),
    diskIo: null,
    net: [],
    gpus: [],
    procs: [],
  };
}
