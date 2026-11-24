import type { ConnLogEntry, ConnStep, ConnStepStatus } from '@itm/protocol';

/**
 * 连接日志与步骤（文档一 6.15.2 / 6.15.3）。SshPool 在建立连接的各个阶段写日志、推进步骤；
 * 测试连接收集成数组返回，打开终端时通过 session.progress 事件推给界面。
 */
export interface Tracer {
  info(tag: string, text: string): void;
  success(tag: string, text: string): void;
  warn(tag: string, text: string): void;
  error(tag: string, text: string): void;
  /** 推进步骤；跳板机上的日志不改变目标的步骤 */
  step(step: ConnStep, status: ConnStepStatus): void;
  /** 当前步骤（日志归到哪一步） */
  readonly current: ConnStep;
  /** 取消连接 */
  readonly signal?: AbortSignal;
  /** 跳板机的日志：加前缀，归到「建立连接」，不推进目标的步骤 */
  hop(prefix: string): Tracer;
}

export const STEPS: ConnStep[] = ['connect', 'auth', 'channel', 'ready'];
const MAX_ENTRIES = 300;

type Listener = (e: { entry: ConnLogEntry | null; steps: Record<ConnStep, ConnStepStatus> }) => void;

export class ConnTrace implements Tracer {
  readonly entries: ConnLogEntry[] = [];
  readonly steps: Record<ConnStep, ConnStepStatus> = { connect: 'pending', auth: 'pending', channel: 'pending', ready: 'pending' };
  private readonly listeners = new Set<Listener>();

  constructor(
    readonly signal?: AbortSignal,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): ConnStep {
    return STEPS.find((s) => this.steps[s] === 'active') ?? STEPS.find((s) => this.steps[s] === 'pending') ?? 'ready';
  }

  /** 订阅新日志和步骤变化 */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(level: ConnLogEntry['level'], tag: string, text: string, step: ConnStep = this.current): void {
    const entry: ConnLogEntry = { t: this.now(), step, level, tag, text };
    if (this.entries.length < MAX_ENTRIES) this.entries.push(entry);
    this.listeners.forEach((l) => l({ entry, steps: { ...this.steps } }));
  }

  info(tag: string, text: string): void {
    this.push('info', tag, text);
  }
  success(tag: string, text: string): void {
    this.push('success', tag, text);
  }
  warn(tag: string, text: string): void {
    this.push('warn', tag, text);
  }
  error(tag: string, text: string): void {
    this.push('error', tag, text);
  }

  step(step: ConnStep, status: ConnStepStatus): void {
    if (this.steps[step] === status) return;
    // 推进到后面的步骤时，前面还没完成的步骤视为完成
    if (status === 'active' || status === 'done') {
      for (const s of STEPS) {
        if (s === step) break;
        if (this.steps[s] !== 'done') this.steps[s] = 'done';
      }
    }
    this.steps[step] = status;
    this.listeners.forEach((l) => l({ entry: null, steps: { ...this.steps } }));
  }

  /** 失败：当前进行中的步骤标红（连接池已经记录过失败的步骤时不再重复） */
  fail(text: string): void {
    if (STEPS.some((s) => this.steps[s] === 'error')) return;
    const cur = this.current;
    this.push('error', '错误', text, cur);
    this.step(cur, 'error');
  }

  hop(prefix: string): Tracer {
    return scoped(this, prefix);
  }
}

/** 跳板机上的日志视图 */
function scoped(root: ConnTrace | Tracer, prefix: string): Tracer {
  const log = (level: ConnLogEntry['level']) => (tag: string, text: string) => {
    const t = `${prefix}${tag ? ` ${tag}` : ''}`;
    if (root instanceof ConnTrace) root.push(level, t, text, 'connect');
    else root[level](t, text);
  };
  return {
    info: log('info'),
    success: log('success'),
    warn: log('warn'),
    error: log('error'),
    step: () => undefined,
    get current(): ConnStep {
      return 'connect';
    },
    signal: root.signal,
    hop: (p: string) => scoped(root, `${prefix} › ${p}`),
  };
}

/** 什么都不记的 Tracer（连接池内部的后台连接，例如监控、Agent） */
export const NOOP_TRACER: Tracer = {
  info: () => undefined,
  success: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  step: () => undefined,
  current: 'connect',
  hop: () => NOOP_TRACER,
};

/**
 * 同一条连接被多个会话等待时（例如同时打开两个终端），把日志同时写给所有等待者；后加入的先补发之前的日志。
 */
export class TraceHub implements Tracer {
  private readonly history: { level: ConnLogEntry['level']; tag: string; text: string; step: ConnStep }[] = [];
  private readonly stepsLog: [ConnStep, ConnStepStatus][] = [];
  private readonly followers = new Set<Tracer>();
  private cur: ConnStep = 'connect';

  constructor(readonly signal?: AbortSignal) {}

  get current(): ConnStep {
    return this.cur;
  }

  attach(t: Tracer): () => void {
    for (const [s, st] of this.stepsLog) t.step(s, st);
    for (const h of this.history) t[h.level](h.tag, h.text);
    this.followers.add(t);
    return () => this.followers.delete(t);
  }

  private emit(level: ConnLogEntry['level'], tag: string, text: string): void {
    if (this.history.length < MAX_ENTRIES) this.history.push({ level, tag, text, step: this.cur });
    this.followers.forEach((f) => f[level](tag, text));
  }

  info(tag: string, text: string): void {
    this.emit('info', tag, text);
  }
  success(tag: string, text: string): void {
    this.emit('success', tag, text);
  }
  warn(tag: string, text: string): void {
    this.emit('warn', tag, text);
  }
  error(tag: string, text: string): void {
    this.emit('error', tag, text);
  }
  step(step: ConnStep, status: ConnStepStatus): void {
    if (status === 'active') this.cur = step;
    this.stepsLog.push([step, status]);
    this.followers.forEach((f) => f.step(step, status));
  }
  hop(prefix: string): Tracer {
    return scoped(this, prefix);
  }
}
