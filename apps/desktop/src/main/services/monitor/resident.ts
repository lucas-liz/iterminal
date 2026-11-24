import type { MetricsSnapshot, MonitorAlert, MonitorAlertConfig } from '@itm/protocol';
import type { MonitorService } from './monitor-service';

/** 后台订阅用的「窗口」：没有窗口可以提示（连接需要输入密码时直接失败），也不推送事件 */
export const BACKGROUND_OWNER = -1;

/** 检查断开的常驻主机、持续告警的间隔 */
const TICK_MS = 30_000;
/** 连不上持续多久算离线告警 */
const OFFLINE_AFTER_MS = 2 * 60_000;
/** 重连间隔：1、2、5、10 分钟，之后每 10 分钟 */
const RETRY_STEPS_MS = [60_000, 120_000, 300_000, 600_000];

export interface ResidentDeps {
  monitor: Pick<MonitorService, 'subscribe' | 'unsubscribe' | 'restart' | 'latest' | 'onSnapshot'>;
  /** 常驻主机（只包含还存在的 SSH 主机） */
  hostIds(): string[];
  config(): MonitorAlertConfig;
  /** 远程监控在设置里关闭了 */
  disabled(): boolean;
  hostName(id: string): string;
  notify(title: string, body: string): void;
  emit(list: MonitorAlert[]): void;
  /** 告警开始（持续够久后）和恢复：交给告警中心记录日志、自动排查、发邮件（第二十八轮） */
  onAlert?(alert: MonitorAlert, snap: MetricsSnapshot, cfg: MonitorAlertConfig): void;
  onClear?(hostId: string, kind: MonitorAlert['kind']): void;
  now?: () => number;
}

interface HostState {
  /** 超过阈值开始的时间 */
  over: Partial<Record<MonitorAlert['kind'], number>>;
  /** 上次通知的时间 */
  notifiedAt: Partial<Record<MonitorAlert['kind'], number>>;
  /** 上次交给告警中心的时间（同样按冷却时间，避免指标在阈值附近来回跳时反复记录） */
  raisedAt: Partial<Record<MonitorAlert['kind'], number>>;
  retry: number;
  nextRetryAt: number;
}

/**
 * 常驻监控（第二十七轮）：「监控」里设为常驻的主机在应用运行期间一直在后台采集（不用打开终端或监控页），
 * 历史数据照常记录；CPU / 内存超过阈值持续几分钟、磁盘超过阈值、连不上超过 2 分钟时发系统通知（同类告警有冷却时间）。
 */
export class ResidentMonitor {
  private readonly watching = new Set<string>();
  private readonly state = new Map<string, HostState>();
  private readonly active = new Map<string, MonitorAlert>();
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly d: ResidentDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  start(): void {
    if (this.timer) return;
    this.off = this.d.monitor.onSnapshot((s) => this.onSnapshot(s));
    this.sync();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
    for (const id of [...this.watching]) this.d.monitor.unsubscribe(BACKGROUND_OWNER, id);
    this.watching.clear();
  }

  /** 常驻主机列表或设置变化后调用：订阅新增的，取消移除的 */
  sync(): void {
    const want = new Set(this.d.disabled() ? [] : this.d.hostIds());
    for (const id of [...this.watching]) {
      if (want.has(id)) continue;
      this.watching.delete(id);
      this.state.delete(id);
      this.d.monitor.unsubscribe(BACKGROUND_OWNER, id);
      this.clearHost(id);
    }
    for (const id of want) {
      if (this.watching.has(id)) continue;
      this.watching.add(id);
      this.state.set(id, { over: {}, notifiedAt: {}, raisedAt: {}, retry: 0, nextRetryAt: 0 });
      this.d.monitor.subscribe(BACKGROUND_OWNER, id);
    }
  }

  alerts(): MonitorAlert[] {
    return [...this.active.values()].sort((a, b) => a.since - b.since);
  }

  /** 定时：断开的主机按退避重连，持续的告警到时间后通知 */
  tick(): void {
    const now = this.now();
    for (const id of this.watching) {
      const st = this.state.get(id);
      const snap = this.d.monitor.latest(id);
      if (!st) continue;
      if (snap && snap.state === 'error') {
        if (now >= st.nextRetryAt && this.d.monitor.restart(id)) {
          st.nextRetryAt = now + RETRY_STEPS_MS[Math.min(st.retry, RETRY_STEPS_MS.length - 1)];
          st.retry++;
        }
        this.evaluate(id, snap, now);
      }
    }
  }

  private onSnapshot(snap: MetricsSnapshot): void {
    if (!this.watching.has(snap.hostId)) return;
    const st = this.state.get(snap.hostId);
    if (st && snap.state === 'ok') {
      st.retry = 0;
      st.nextRetryAt = 0;
    }
    this.evaluate(snap.hostId, snap, this.now());
  }

  private evaluate(hostId: string, snap: MetricsSnapshot, now: number): void {
    const st = this.state.get(hostId);
    if (!st) return;
    const cfg = this.d.config();
    const found = new Map<MonitorAlert['kind'], string>();
    if (snap.state === 'error') {
      if (cfg.offline !== false) found.set('offline', `连不上：${snap.message}`);
    } else if (snap.state === 'ok') {
      if (snap.cpu && snap.cpu.usage >= cfg.cpu) found.set('cpu', `CPU ${snap.cpu.usage.toFixed(0)}%`);
      const memPct = snap.mem.total ? (snap.mem.used / snap.mem.total) * 100 : 0;
      if (memPct >= cfg.mem) found.set('mem', `内存 ${memPct.toFixed(0)}%`);
      const full = snap.disks.filter((x) => x.usePct >= cfg.disk).sort((a, b) => b.usePct - a.usePct);
      if (full.length) found.set('disk', full.map((x) => `${x.mount} ${x.usePct.toFixed(0)}%`).join('、'));
    }
    let changed = false;
    for (const kind of ['cpu', 'mem', 'disk', 'offline'] as const) {
      const text = found.get(kind);
      const key = `${hostId}:${kind}`;
      if (!text) {
        delete st.over[kind];
        if (this.active.delete(key)) {
          changed = true;
          this.d.onClear?.(hostId, kind);
        }
        continue;
      }
      // 只读到一次快照的「连不上」不算：没有快照前的 CPU 尖峰也不算
      const since = st.over[kind] ?? now;
      st.over[kind] = since;
      const sustain = kind === 'offline' ? OFFLINE_AFTER_MS : kind === 'disk' ? 0 : cfg.sustainMin * 60_000;
      if (now - since < sustain) continue;
      const prev = this.active.get(key);
      const alert: MonitorAlert = { hostId, kind, text, since, notified: prev?.notified ?? false };
      const last = st.notifiedAt[kind];
      if (cfg.notify && !alert.notified && (last === undefined || now - last >= cfg.cooldownMin * 60_000)) {
        st.notifiedAt[kind] = now;
        alert.notified = true;
        const name = this.d.hostName(hostId);
        this.d.notify(`常驻监控：${name}${kind === 'offline' ? '连不上' : '需要注意'}`, kind === 'offline' ? text : `${text}（阈值 ${kind === 'cpu' ? cfg.cpu : kind === 'mem' ? cfg.mem : cfg.disk}%）`);
      }
      if (!prev || prev.text !== text || prev.notified !== alert.notified) changed = true;
      this.active.set(key, alert);
      const raised = st.raisedAt[kind];
      if (!prev && (raised === undefined || now - raised >= cfg.cooldownMin * 60_000)) {
        st.raisedAt[kind] = now;
        this.d.onAlert?.(alert, snap, cfg);
      }
    }
    if (changed) this.d.emit(this.alerts());
  }

  private clearHost(hostId: string): void {
    let changed = false;
    for (const key of [...this.active.keys()]) {
      if (key.startsWith(`${hostId}:`)) {
        this.active.delete(key);
        changed = true;
      }
    }
    if (changed) this.d.emit(this.alerts());
  }
}
