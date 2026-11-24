import { randomUUID } from 'node:crypto';
import type { ServerState } from '@itm/protocol';
import { diag } from '../diag/diag-log';
import { envelopeError } from '../../util/envelope';
import { redactServers } from '../../util/redact-server';

/** 诊断日志（第十三轮）：访问服务端的方法、路径（不含查询参数）、状态码、耗时；心跳、长连接票据不记 */
function logNet(method: string, path: string, status: number, ms: number, error?: string): void {
  const p = path.split('?')[0];
  if (!error && status < 400 && /^\/api\/v1\/(ws\/ticket|audit\/)/.test(p)) return;
  diag.log(error || status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'net', `${method} ${p} ${error ? '失败' : status}`, { ms, ...(error ? { error } : {}) });
}

/** WS 消息（文档二 7.2）：ack = true 的消息，接收方必须回 {type: 'ack', id} */
export interface WsMessage {
  type: string;
  id: string;
  ts: string;
  ack?: boolean;
  payload?: unknown;
}

export interface ServerLinkOptions {
  /** 服务端地址，例如 https://ops.iterminal.corp */
  baseUrl: string;
  /** 登录令牌（每次连接前取，可能已经刷新） */
  token(): Promise<string | null>;
  /** 令牌失效（HTTP 401）时刷新；返回 true 表示已经换上新令牌，请求重试一次 */
  onUnauthorized?(): Promise<boolean>;
  deviceId: string;
  clientVersion: string;
  onState(state: ServerState): void;
  /** 测试用：替换 WebSocket 和 fetch */
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** 心跳和重试间隔（毫秒），测试时调小 */
  pingMs?: number;
  ackTimeoutMs?: number;
  backoff?: { firstMs: number; maxMs: number };
  now?: () => number;
}

type Handler = (payload: unknown, msg: WsMessage) => void | Promise<void>;

/**
 * 服务端连接（文档二第 7 章）：换票 → 连接 → hello → 每 25 秒 ping；收到需要确认的消息回 ack 并按 id 去重；
 * 自己发出的需要确认的消息 10 秒没收到 ack 就重发，最多 3 次；断线后指数退避重连。
 */
export class ServerLink {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly handlers = new Map<string, Handler[]>();
  /** 已处理过的消息 id（去重），最多记 500 个 */
  private readonly seen: string[] = [];
  /** 等待 ack 的消息 */
  private readonly pendingAcks = new Map<string, { msg: WsMessage; tries: number; timer: NodeJS.Timeout }>();
  /** 离线时要发的消息（重连后发出） */
  private readonly queue: WsMessage[] = [];
  private state: ServerState;

  constructor(private readonly o: ServerLinkOptions) {
    this.state = { enabled: true, status: 'off', url: o.baseUrl, lastError: null, connectedAt: null };
  }

  get(): ServerState {
    return { ...this.state };
  }

  private set(p: Partial<ServerState>): void {
    this.state = { ...this.state, ...p };
    this.o.onState(this.get());
  }

  on(type: string, h: Handler): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), h]);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    for (const p of this.pendingAcks.values()) clearTimeout(p.timer);
    this.pendingAcks.clear();
    try {
      this.ws?.close();
    } catch {
      // 已经关闭
    }
    this.ws = null;
    this.set({ status: 'off' });
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private fetch(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }

  /** REST 调用（带登录令牌和设备标识），给执行器创建审批、审计上报等使用；401 时刷新令牌后重试一次 */
  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { signal?: AbortSignal; retried?: boolean; timeoutMs?: number } = {}): Promise<T> {
    const token = await this.o.token();
    // 默认 15 秒；联网搜索 / 网页读取经服务端转发，可以长一些
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? 15_000);
    const t0 = Date.now();
    const res = await this.fetch()(`${this.o.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-device-id': this.o.deviceId,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    }).catch((e: unknown) => {
      logNet(method, path, 0, Date.now() - t0, (e as Error).message);
      throw e;
    });
    logNet(method, path, res.status, Date.now() - t0);
    if (res.status === 401 && !opts.retried && this.o.onUnauthorized && (await this.o.onUnauthorized())) {
      return this.request<T>(method, path, body, { ...opts, retried: true });
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { message?: string; msg?: string };
        message = j.message ?? j.msg ?? message;
      } catch {
        // 不是 JSON：原样显示
      }
      throw new Error(res.status === 401 ? `登录已失效（401）：${message}` : `服务端返回 ${res.status}：${message}`);
    }
    const json = text ? (JSON.parse(text) as { data?: T } & T) : ({} as T);
    // 服务端统一响应 {code, message, data}；旧版服务端没有这个接口时若依返回 HTTP 200 + {code: 500}
    const err = envelopeError(res.status, json);
    if (err) throw new Error(err);
    return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
  }

  /** 原始请求（上传 multipart、下载二进制）：同样带登录令牌和设备标识，401 时刷新后重试一次；不解析响应 */
  async rawRequest(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: { body?: RequestInit['body']; headers?: Record<string, string>; timeoutMs?: number } = {},
    retried = false,
  ): Promise<Response> {
    const token = await this.o.token();
    const t0 = Date.now();
    const res = await this.fetch()(`${this.o.baseUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { 'x-device-id': this.o.deviceId, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(init.timeoutMs ?? 120_000),
    }).catch((e: unknown) => {
      logNet(method, path, 0, Date.now() - t0, (e as Error).message);
      throw e;
    });
    logNet(method, path, res.status, Date.now() - t0);
    if (res.status === 401 && !retried && this.o.onUnauthorized && (await this.o.onUnauthorized())) {
      return this.rawRequest(method, path, init, true);
    }
    return res;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.set({ status: 'connecting' });
    try {
      const { ticket } = await this.request<{ ticket: string }>('GET', '/api/v1/ws/ticket');
      if (this.stopped) return;
      const wsUrl = `${this.o.baseUrl.replace(/\/+$/, '').replace(/^http/i, 'ws')}/ws/client?ticket=${encodeURIComponent(ticket)}`;
      const WS = this.o.WebSocketImpl ?? WebSocket;
      const ws = new WS(wsUrl);
      this.ws = ws;
      ws.onopen = () => {
        this.attempt = 0;
        this.set({ status: 'online', lastError: null, connectedAt: (this.o.now ?? Date.now)() });
        this.raw({ type: 'hello', id: randomUUID(), ts: new Date().toISOString(), payload: { deviceId: this.o.deviceId, clientVersion: this.o.clientVersion, capabilities: ['executor', 'approval'] } });
        this.pingTimer = setInterval(() => this.raw({ type: 'ping', id: randomUUID(), ts: new Date().toISOString() }), this.o.pingMs ?? 25_000);
        // 离线期间排队的消息、还没确认的消息重新发出
        for (const m of this.queue.splice(0)) this.send(m.type, m.payload, { ack: m.ack, id: m.id });
        for (const p of this.pendingAcks.values()) this.raw(p.msg);
      };
      ws.onmessage = (ev) => void this.onMessage(String(ev.data));
      ws.onclose = () => this.onClosed('连接已断开');
      ws.onerror = () => this.onClosed('连接出错');
    } catch (e) {
      this.onClosed((e as Error).message);
    }
  }

  private onClosed(reason: string): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
    if (this.stopped) return;
    this.set({ status: 'offline', lastError: redactServers(reason) });
    if (this.retryTimer) return;
    const b = this.o.backoff ?? { firstMs: 1000, maxMs: 60_000 };
    const delay = Math.min(b.maxMs, b.firstMs * 2 ** this.attempt++) * (0.8 + Math.random() * 0.4);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private raw(m: WsMessage): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(m));
    return true;
  }

  /** 发送消息；ack = true 时等待确认，没确认就重发（最多 3 次） */
  send(type: string, payload: unknown, opts: { ack?: boolean; id?: string } = {}): string {
    const msg: WsMessage = { type, id: opts.id ?? randomUUID(), ts: new Date().toISOString(), ...(opts.ack ? { ack: true } : {}), payload };
    const sent = this.raw(msg);
    if (!opts.ack) {
      if (!sent) this.queue.push(msg);
      return msg.id;
    }
    const arm = (tries: number): NodeJS.Timeout =>
      setTimeout(() => {
        const p = this.pendingAcks.get(msg.id);
        if (!p) return;
        if (p.tries >= 3) {
          this.pendingAcks.delete(msg.id);
          return;
        }
        this.raw(msg);
        this.pendingAcks.set(msg.id, { msg, tries: p.tries + 1, timer: arm(p.tries + 1) });
      }, this.o.ackTimeoutMs ?? 10_000);
    this.pendingAcks.set(msg.id, { msg, tries: 1, timer: arm(1) });
    return msg.id;
  }

  private async onMessage(text: string): Promise<void> {
    let m: WsMessage;
    try {
      m = JSON.parse(text) as WsMessage;
    } catch {
      return;
    }
    if (!m || typeof m.type !== 'string') return;
    if (m.type === 'ack') {
      const p = this.pendingAcks.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pendingAcks.delete(m.id);
      }
      return;
    }
    if (m.type === 'pong') return;
    if (m.ack) this.raw({ type: 'ack', id: m.id, ts: new Date().toISOString() });
    // 重发的消息只处理一次
    if (m.id) {
      if (this.seen.includes(m.id)) return;
      this.seen.push(m.id);
      if (this.seen.length > 500) this.seen.shift();
    }
    for (const h of this.handlers.get(m.type) ?? []) {
      try {
        await h(m.payload, m);
      } catch {
        // 单个处理器出错不影响其他消息
      }
    }
  }
}
