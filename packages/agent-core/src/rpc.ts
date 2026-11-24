import { UserError } from './errors';

/**
 * 主进程和 Agent 进程（utilityProcess）之间的双向 RPC（文档一 5.1）。消息走结构化克隆，只传普通对象。
 * 两边都可以发起请求：主进程 → Agent（run / call / stop），Agent → 主进程（执行工具、持久化消息、流式输出）。
 */
export type RpcMessage =
  | { t: 'req'; id: number; m: string; p: unknown }
  | { t: 'res'; id: number; ok: true; v: unknown }
  | { t: 'res'; id: number; ok: false; e: { message: string; name: string } }
  | { t: 'cancel'; id: number }
  | { t: 'evt'; m: string; p: unknown };

export type RpcHandler = (params: never, ctx: { signal: AbortSignal }) => unknown;

export class RpcPeer {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly listeners = new Map<string, (p: unknown) => void>();
  private readonly running = new Map<number, AbortController>();
  private closed: Error | null = null;

  constructor(private readonly send: (msg: RpcMessage) => void) {}

  handle<P, R>(method: string, fn: (params: P, ctx: { signal: AbortSignal }) => R | Promise<R>): void {
    this.handlers.set(method, fn as unknown as RpcHandler);
  }

  /** 单向事件（流式输出这类不需要回应的消息） */
  on<P>(event: string, fn: (p: P) => void): void {
    this.listeners.set(event, fn as (p: unknown) => void);
  }

  emit(event: string, payload: unknown): void {
    if (!this.closed) this.send({ t: 'evt', m: event, p: payload });
  }

  request<R>(method: string, params: unknown, signal?: AbortSignal): Promise<R> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.seq;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      if (signal) {
        const onAbort = (): void => this.send({ t: 'cancel', id });
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      this.send({ t: 'req', id, m: method, p: params });
    });
  }

  receive(msg: RpcMessage): void {
    switch (msg.t) {
      case 'req': {
        const fn = this.handlers.get(msg.m);
        const ac = new AbortController();
        this.running.set(msg.id, ac);
        Promise.resolve()
          .then(() => {
            if (!fn) throw new Error(`未知的 RPC 方法：${msg.m}`);
            return fn(msg.p as never, { signal: ac.signal });
          })
          .then(
            (v) => this.send({ t: 'res', id: msg.id, ok: true, v }),
            (e: unknown) => {
              const err = e instanceof Error ? e : new Error(String(e));
              this.send({ t: 'res', id: msg.id, ok: false, e: { message: err.message, name: err.name } });
            },
          )
          .finally(() => this.running.delete(msg.id));
        return;
      }
      case 'res': {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.v);
        else p.reject(msg.e.name === 'UserError' ? new UserError(msg.e.message) : Object.assign(new Error(msg.e.message), { name: msg.e.name }));
        return;
      }
      case 'cancel':
        this.running.get(msg.id)?.abort();
        return;
      case 'evt':
        this.listeners.get(msg.m)?.(msg.p);
        return;
    }
  }

  /** 对方进程退出：所有等待中的请求都以 reason 失败，正在处理的请求中止 */
  close(reason: Error): void {
    this.closed = reason;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
    for (const ac of this.running.values()) ac.abort();
    this.running.clear();
  }
}
