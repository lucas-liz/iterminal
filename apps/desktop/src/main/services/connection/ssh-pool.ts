import { connect as tcpConnect, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { Client, utils, type AnyAuthMethod, type AuthenticationType, type KeyboardInteractiveCallback, type NextAuthHandler, type Prompt } from 'ssh2';
import type { Host, HostTestResult } from '@itm/protocol';
import type { ConnectInfo, HostRepo, ResolvedAuth } from '../hosts/host-repo';
import { sha256Fingerprint } from '../vault/credential-repo';
import { describeConnectError, UserError } from '../../util/errors';
import { looksLikeOtpPrompt, totp } from '../../util/totp';
import { execCommand } from './exec';
import type { PromptBroker } from './prompt-broker';
import { connectViaProxy } from './proxy';
import { NOOP_TRACER, TraceHub, type Tracer } from './conn-trace';

/** 连接超时和重试（设置 → 终端，文档一 6.15.3） */
export interface ConnectOptions {
  /** TCP 连接和 SSH 握手各自的超时 */
  timeoutMs: number;
  /** 网络错误自动重试的次数（0 = 不重试） */
  retries: number;
}

/** 可以自动重试的网络错误：TCP 超时、连接被拒 / 重置、握手超时 */
class RetryableError extends UserError {}

/** 已经写进连接日志的错误（避免同一个错误在多层各写一遍） */
const LOGGED = new WeakSet<object>();
function logFailure(trace: Tracer, e: unknown): void {
  if (!e || typeof e !== 'object' || LOGGED.has(e)) return;
  LOGGED.add(e);
  const msg = (e as Error).message;
  if (msg === '已取消连接') trace.warn('取消', '已取消连接');
  else trace.error('错误', msg);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

const AUTH_LABEL: Record<string, string> = {
  password: '密码认证',
  publickey: '公钥认证',
  agent: 'ssh-agent 认证',
  'keyboard-interactive': '键盘交互认证',
};

/** 连接阶段最多询问几次密码 / 口令 */
const MAX_PROMPTS = 3;
/** keyboard-interactive 最多几轮（密码 + 验证码这类多步认证） */
const MAX_KBD_ROUNDS = 5;
/** 递归经过跳板的最大深度（防御性限制，正常配置远小于它） */
const MAX_DEPTH = 8;

export interface PooledConnection {
  readonly hostId: string;
  readonly host: Host;
  readonly client: Client;
  /** 登录用的用户名（运维审计的连接日志，第三十五轮） */
  readonly username?: string;
  /** 连接断开的原因（正常关闭时为 null） */
  error: string | null;
  closed: boolean;
  /** 连接池内部：连接失效时移出连接池 */
  onDead?: () => void;
}

/** 底层已经结束但 ssh2 迟迟没有发出 close 时，等这么久再强制关闭 */
const FORCE_CLOSE_MS = 1000;

/** ssh2 Client 内部的底层流（TCP socket，或经跳板时上一跳的 direct-tcpip 通道） */
function sockOf(client: Client): (Duplex & { _readableState?: { ended: boolean } }) | undefined {
  return (client as unknown as { _sock?: Duplex & { _readableState?: { ended: boolean } } })._sock;
}

/** 连接还能用：没有关闭，底层流可写且没有收到 EOF（和 ssh2 判断 Not connected 的条件一致） */
function isAlive(conn: PooledConnection): boolean {
  if (conn.closed) return false;
  const sock = sockOf(conn.client);
  return !!sock && sock.writable && sock._readableState?.ended === false;
}

/** 已经强制关闭过的底层流 */
const KILLED = new WeakSet<object>();

/**
 * 强制关闭一条已经失效的连接。TCP socket 直接 destroy；经跳板的通道要等跳板机回 CHANNEL_CLOSE 才会发出 close，
 * 而跳板机到已宕目标的 TCP 可能要很久才超时，所以这里直接替它发出 close，让 ssh2 清理这条连接上的所有通道。
 */
function killConnection(conn: PooledConnection): void {
  const sock = sockOf(conn.client);
  if (!sock || sock.destroyed || KILLED.has(sock)) return;
  KILLED.add(sock);
  if (sock instanceof Socket) {
    sock.destroy();
    return;
  }
  sock.destroy();
  sock.emit('close');
  // 跳板机之后真的回了 CHANNEL_CLOSE 时不要再触发一次
  sock.removeAllListeners('close');
}

interface Entry {
  conn: Promise<PooledConnection>;
  refs: number;
  settled: PooledConnection | null;
  /** 连接过程的日志（同时等待这条连接的会话都能看到） */
  hub: TraceHub;
  /** 所有等待者都取消时中止连接 */
  controller: AbortController;
}

/** 一跳的连接目标。rememberId 为空时（测试连接）不保存用户在提示框里输入的密码。 */
interface HopTarget {
  host: Host;
  auth: ResolvedAuth;
  rememberId: string | null;
}

/** ssh-agent 地址：Windows 用 OpenSSH Agent 的命名管道 */
export function defaultAgent(): string | undefined {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\openssh-ssh-agent';
  }
  return process.env.SSH_AUTH_SOCK || undefined;
}

/** 主机公钥 blob 的第一个字段就是算法名（string：uint32 长度 + 内容） */
export function hostKeyType(key: Buffer): string {
  if (key.length < 4) {
    return 'unknown';
  }
  const len = key.readUInt32BE(0);
  return len > 0 && len < 64 && key.length >= 4 + len ? key.subarray(4, 4 + len).toString('latin1') : 'unknown';
}

/**
 * SSH 连接池：同一台主机的交互终端、SFTP、监控和 Agent 复用一条 TCP 连接，按用途开不同 channel（文档一 5.3）。
 * 引用计数归零时断开。
 *
 * 跳板机：主机的有效跳板链（自己设置的，或者继承分组的默认跳板机）为 [J1, J2] 时，连接路径为 本机 → J1 → J2 → 目标。
 * J1 从连接池获取（按 J1 自己的跳板设置连接，并和其他会话共享）；J2 和目标是这条连接专用的，
 * 通过上一跳的 direct-tcpip 通道建立。每一跳都各自校验主机指纹、各自认证。
 * 代理（SOCKS5 / HTTP）只用于直连的第一跳。
 */
export class SshPool {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly hosts: HostRepo,
    private readonly prompts: PromptBroker,
    private readonly readyTimeoutMs = 20_000,
    /** 共享凭证被使用时记录最近使用时间 */
    private readonly onCredentialUsed: (credentialId: string) => void = () => undefined,
    /** 连接超时与重试；不传时（测试）15 秒超时、不重试 */
    private readonly connectOptions: () => ConnectOptions = () => ({ timeoutMs: 15_000, retries: 0 }),
  ) {}

  /**
   * 获取（必要时建立）到主机的连接；调用方用完必须 release。path 是正在建立中的跳板路径，用于发现循环。
   * trace：连接过程的日志和步骤；trace.signal 取消时只放弃这一个等待者，所有等待者都取消后才中止连接。
   */
  async acquire(hostId: string, owner: number, path: string[] = [], trace: Tracer = NOOP_TRACER): Promise<PooledConnection> {
    if (path.includes(hostId) || path.length >= MAX_DEPTH) {
      throw new UserError('跳板设置形成了循环，请检查跳板机配置');
    }
    let entry = this.entries.get(hostId);
    if (entry?.settled && !isAlive(entry.settled)) {
      // 底层连接已经不可用（例如目标重启后跳板通道只收到 EOF、迟迟收不到 close）：丢掉它重新连接
      this.entries.delete(hostId);
      killConnection(entry.settled);
      entry = undefined;
    }
    if (entry?.settled) {
      trace.success('复用', `复用已建立的连接（${entry.settled.host.name}）`);
      trace.step('auth', 'done');
      entry.refs++;
      return entry.settled;
    }
    if (!entry) {
      const info = this.hosts.connectInfo(hostId);
      if (info.host.protocol !== 'SSH') throw new UserError(`「${info.host.name}」不是 SSH 主机`);
      const controller = new AbortController();
      const hub = new TraceHub(controller.signal);
      const created: Entry = {
        conn: Promise.resolve(null as unknown as PooledConnection),
        refs: 0,
        settled: null,
        hub,
        controller,
      };
      // 先挂上日志再开始连接，第一条日志就能送到
      created.hub.attach(trace);
      created.conn = this.connectChain(info, hostId, owner, [...path, hostId], hub);
      entry = created;
      this.entries.set(hostId, created);
      created.conn.then(
        (c) => {
          created.settled = c;
          c.onDead = () => {
            if (this.entries.get(hostId) === created) {
              this.entries.delete(hostId);
            }
          };
          if (c.closed) c.onDead();
        },
        () => {
          if (this.entries.get(hostId) === created) {
            this.entries.delete(hostId);
          }
        },
      );
    } else {
      entry.hub.attach(trace);
    }
    const e = entry;
    e.refs++;
    try {
      if (!trace.signal) return await e.conn;
      if (trace.signal.aborted) throw new UserError('已取消连接');
      const signal = trace.signal;
      return await new Promise<PooledConnection>((resolve, reject) => {
        const onAbort = (): void => {
          reject(new UserError('已取消连接'));
          // 这个等待者放弃了；没有其他人在等时中止连接
          if (e.refs <= 1 && !e.settled) e.controller.abort();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        e.conn.then(
          (c) => {
            signal.removeEventListener('abort', onAbort);
            if (signal.aborted) return;
            resolve(c);
          },
          (err: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(err as Error);
          },
        );
      });
    } catch (err) {
      e.refs--;
      // 连接建好了但这个等待者已经取消：交还引用
      if (e.settled && e.refs <= 0) this.release(e.settled);
      throw err;
    }
  }

  /** 这台主机已经有可用的连接（后台读取时只复用现有连接，不为它新建连接、不弹密码框） */
  isConnected(hostId: string): boolean {
    const settled = this.entries.get(hostId)?.settled;
    return !!settled && isAlive(settled);
  }

  release(conn: PooledConnection): void {
    const entry = this.entries.get(conn.hostId);
    if (!entry || entry.settled !== conn) {
      conn.client.end();
      return;
    }
    entry.refs--;
    if (entry.refs <= 0) {
      this.entries.delete(conn.hostId);
      conn.client.end();
    }
  }

  closeAll(): void {
    for (const entry of this.entries.values()) {
      entry.settled?.client.end();
    }
    this.entries.clear();
  }

  /**
   * 测试连接：按表单配置（可能还没保存）建立一次连接，执行 uname 后立即断开。不进入连接池。
   */
  async test(target: ConnectInfo, owner: number, trace: Tracer = NOOP_TRACER): Promise<HostTestResult> {
    const started = Date.now();
    const conn = await this.connectChain(target, null, owner, [target.host.id], trace);
    const latencyMs = Date.now() - started;
    let os: string | null = null;
    try {
      trace.step('channel', 'active');
      trace.info('通道', '执行 uname -srm 读取系统信息');
      const r = await execCommand(conn.client, 'uname -srm', { timeoutMs: 5000, maxBytes: 1024 });
      os = r.code === 0 ? r.stdout.trim() || null : null;
      if (os) trace.success('通道', `系统：${os}`);
      else trace.warn('通道', '没有读到系统信息（可能是网络设备），认证已成功');
    } catch {
      // 网络设备等不支持 exec 的目标：只要认证成功就算通过
      trace.warn('通道', '目标不支持执行命令（可能是网络设备），认证已成功');
    } finally {
      trace.step('ready', 'done');
      trace.success('完成', `测试连接成功，用时 ${latencyMs}ms`);
      conn.client.end();
    }
    if (os && target.host.id !== '__test__') this.hosts.setOsInfo(target.host.id, os);
    const via = target.jumpHostIds.map((id) => this.hosts.get(id)?.name ?? '（已删除）');
    return { latencyMs, os, via };
  }

  /**
   * 建立到目标的 TCP 通道（不做 SSH 握手）：经过跳板链 / 代理 / 直连。Telnet 也通过它走跳板机。
   * 返回的 cleanup 必须在通道用完后调用（释放跳板连接）。
   */
  async openTunnel(info: ConnectInfo, owner: number, path: string[], trace: Tracer = NOOP_TRACER): Promise<{ sock: Duplex | undefined; cleanup: () => void }> {
    const jumps = info.jumpHostIds;
    if (jumps.length === 0) {
      if (!info.proxy) return { sock: undefined, cleanup: () => undefined };
      const p = info.proxy;
      trace.info('代理', `通过 ${p.type} 代理 ${p.host}:${p.port} 连接 ${info.host.address}:${info.host.port}`);
      const sock = await connectViaProxy(p, info.host.address, info.host.port).catch((e: unknown) => {
        trace.error('代理', (e as Error).message);
        throw e;
      });
      trace.success('代理', '代理已连通');
      return { sock, cleanup: () => sock.destroy() };
    }
    const total = jumps.length;
    const nameOf = (id: string): string => this.hosts.get(id)?.name ?? id;
    trace.info('跳板', `经过 ${total} 台跳板机：${jumps.map(nameOf).join(' → ')}`);
    const first = await this.acquire(jumps[0], owner, path, trace.hop(`[跳板 1/${total} ${nameOf(jumps[0])}]`));
    const dedicated: Client[] = [];
    const cleanup = (): void => {
      dedicated.forEach((c) => c.end());
      this.release(first);
    };
    try {
      let prev = first.client;
      let prevName = first.host.name;
      for (const [i, jid] of jumps.slice(1).entries()) {
        const hop = this.hosts.connectInfo(jid);
        const hopTrace = trace.hop(`[跳板 ${i + 2}/${total} ${hop.host.name}]`);
        hopTrace.info('通道', `通过「${prevName}」打开到 ${hop.host.address}:${hop.host.port} 的通道`);
        const sock = await forward(prev, prevName, hop.host);
        const client = await this.openHop({ host: hop.host, auth: hop.auth, rememberId: jid }, owner, sock, hopTrace);
        dedicated.push(client);
        prev = client;
        prevName = hop.host.name;
      }
      trace.info('通道', `通过「${prevName}」打开到 ${info.host.address}:${info.host.port} 的通道`);
      return { sock: await forward(prev, prevName, info.host), cleanup };
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  /**
   * 建立一条不进连接池的专用连接（例如密钥轮换时用新密钥验证登录）。调用方负责 end()。
   */
  async connectDedicated(info: ConnectInfo, owner: number): Promise<Client> {
    const conn = await this.connectChain(info, null, owner, [info.host.id]);
    return conn.client;
  }

  /** 按跳板链建立到目标的连接 */
  private async connectChain(info: ConnectInfo, rememberId: string | null, owner: number, path: string[], trace: Tracer = NOOP_TRACER): Promise<PooledConnection> {
    trace.step('connect', 'active');
    trace.info('连接', `连接到 ${info.host.address}:${info.host.port}（${info.host.name}${info.auth.username ? `，用户 ${info.auth.username}` : ''}）`);
    let tunnel: { sock: Duplex | undefined; cleanup: () => void };
    try {
      tunnel = await this.openTunnel(info, owner, path, trace);
    } catch (e) {
      logFailure(trace, e);
      trace.step(trace.current, 'error');
      throw e;
    }
    try {
      const client = await this.openHop({ host: info.host, auth: info.auth, rememberId }, owner, tunnel.sock, trace);
      if (info.auth.credentialId) this.onCredentialUsed(info.auth.credentialId);
      return this.wrap(info.host, client, tunnel.cleanup, info.auth.username);
    } catch (e) {
      tunnel.cleanup();
      logFailure(trace, e);
      trace.step(trace.current, 'error');
      throw e;
    }
  }

  /**
   * 包装认证成功的连接。连接断开（close），或者底层已经结束但还没发出 close（end / 认证后的 error，例如 keepalive 超时）时：
   * 标记为已关闭、移出连接池、释放跳板；收不到 close 时稍等一会儿强制关掉，让这条连接上的通道（终端、SFTP、监控）都收到 close。
   */
  private wrap(host: Host, client: Client, onClose: () => void, username?: string): PooledConnection {
    const conn: PooledConnection = { hostId: host.id, host, client, username: username || host.username || undefined, error: null, closed: false };
    let done = false;
    let closeTimer: NodeJS.Timeout | null = null;
    const dead = (): void => {
      conn.closed = true;
      if (done) return;
      done = true;
      conn.onDead?.();
      onClose();
    };
    const dying = (): void => {
      dead();
      if (!closeTimer) {
        closeTimer = setTimeout(() => killConnection(conn), FORCE_CLOSE_MS);
        closeTimer.unref?.();
      }
    };
    client.on('error', (err) => {
      conn.error = describeConnectError(err);
      dying();
    });
    client.on('end', dying);
    client.on('close', () => {
      if (closeTimer) clearTimeout(closeTimer);
      dead();
    });
    return conn;
  }

  /**
   * 建立一跳 SSH 连接，认证成功后返回。sock 为空时自己建立 TCP 连接：超时、连接被拒、握手超时自动重试（文档一 6.15.3）；
   * 经过代理 / 跳板时 sock 只能用一次，不重试。
   */
  private async openHop(target: HopTarget, owner: number, sock: Duplex | undefined, trace: Tracer = NOOP_TRACER): Promise<Client> {
    const { timeoutMs, retries } = this.connectOptions();
    if (sock) return this.sshHandshake(target, owner, sock, trace, timeoutMs);
    const { host } = target;
    const attempts = retries + 1;
    for (let attempt = 1; ; attempt++) {
      if (trace.signal?.aborted) throw new UserError('已取消连接');
      trace.info('TCP', `正在建立 Socket 连接：${host.address}:${host.port}（尝试 ${attempt}/${attempts}，超时 ${Math.round(timeoutMs / 1000)}s）`);
      try {
        const tcp = await openSocket(host.address, host.port, timeoutMs, trace.signal);
        trace.success('TCP', `Socket 连接成功：${host.address}:${host.port}`);
        return await this.sshHandshake(target, owner, tcp, trace, timeoutMs);
      } catch (e) {
        const msg = (e as Error).message;
        if (!(e instanceof RetryableError) || attempt >= attempts || trace.signal?.aborted) {
          throw e instanceof RetryableError ? new UserError(msg) : e;
        }
        const delay = 400 * 2 ** (attempt - 1);
        trace.error('错误', msg);
        trace.warn('重试', `${/超时/.test(msg) ? '连接超时' : '连接失败'}，${delay}ms 后重试（${attempt + 1}/${attempts}）…`);
        await sleep(delay, trace.signal);
      }
    }
  }

  /** 在已经连通的 sock 上做 SSH 握手、校验指纹、认证 */
  private async sshHandshake(target: HopTarget, owner: number, sock: Duplex, trace: Tracer, handshakeTimeoutMs: number): Promise<Client> {
    const { host, auth, rememberId } = target;
    const canRemember = auth.rememberable && rememberId !== null;
    let promptsLeft = MAX_PROMPTS;
    let canceled = false;
    let hostKeyRejected = false;

    // 加密私钥没有保存口令：握手前先问，免得认证失败才发现
    let passphrase = auth.passphrase;
    if (auth.method === 'KEY' && auth.privateKey) {
      let parsed = utils.parseKey(auth.privateKey, passphrase);
      while (parsed instanceof Error && /encrypted|passphrase|decrypt|bad/i.test(parsed.message)) {
        if (promptsLeft-- <= 0) {
          throw new UserError('私钥口令不正确');
        }
        const ans = await this.prompts.ask(owner, {
          kind: 'password',
          hostName: host.name,
          username: auth.username,
          message: passphrase ? '口令不正确，请重新输入私钥口令' : '请输入私钥口令',
          forPassphrase: true,
          rememberable: canRemember,
        });
        if (ans.kind !== 'password' || ans.value == null) {
          throw new UserError('已取消连接');
        }
        passphrase = ans.value;
        parsed = utils.parseKey(auth.privateKey, passphrase);
        if (!(parsed instanceof Error) && ans.remember && canRemember) {
          this.hosts.remember(rememberId!, 'passphrase', passphrase);
        }
      }
      promptsLeft = MAX_PROMPTS;
    }

    // 认证顺序：主机配置的方式 → 服务器要求 keyboard-interactive 时按提示自动应答（密码 / TOTP）→ 询问密码（最多 3 次）
    const queue: AnyAuthMethod[] = [];
    const username = auth.username;
    if (auth.method === 'KEY' && auth.privateKey) {
      queue.push({ type: 'publickey', username, key: auth.privateKey, passphrase });
    } else if (auth.method === 'PASSWORD' && auth.password) {
      queue.push({ type: 'password', username, password: auth.password });
    } else if (auth.method === 'AGENT') {
      const agent = defaultAgent();
      if (agent) {
        queue.push({ type: 'agent', username, agent });
      }
    }
    let typedPassword: { value: string; remember: boolean } | null = null;
    let attempted = false;
    let kbdRounds = 0;
    // 测试连接（rememberId 为空）时，配置的认证方式失败就直接报错，不再弹窗要密码；
    // 只有没有配置任何秘密（例如「每次询问」）时才询问
    const allowFallbackPrompt = rememberId !== null || queue.length === 0;

    // 握手超时：ssh2 自带的 readyTimeout 会把等待用户输入的时间也算进去，所以关掉它（readyTimeout: 0），
    // 自己计时，询问用户期间暂停
    const client = new Client();
    let ready = false;
    let timedOut = false;
    /** 握手阶段（还没收到服务端的 SSH 响应）超时可以重试；认证阶段超时不重试 */
    let phase: 'handshake' | 'auth' = 'handshake';
    let timer: NodeJS.Timeout | null = null;
    const disarm = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const arm = (): void => {
      disarm();
      timer = setTimeout(
        () => {
          timedOut = true;
          client.destroy();
        },
        phase === 'handshake' ? handshakeTimeoutMs : this.readyTimeoutMs,
      );
    };
    const ask: PromptBroker['ask'] = async (o, req) => {
      disarm();
      try {
        return await this.prompts.ask(o, req);
      } finally {
        if (!ready) {
          arm();
        }
      }
    };

    /** keyboard-interactive：密码提示用已知密码，验证码提示用 TOTP，其余询问用户 */
    const answerPrompts = async (prompts: Prompt[]): Promise<string[] | null> => {
      const answers: string[] = [];
      for (const p of prompts) {
        const text = (p.prompt ?? '').trim();
        if (looksLikeOtpPrompt(text)) {
          if (auth.otpSeed) {
            answers.push(totp(auth.otpSeed).code);
            continue;
          }
          const ans = await ask(owner, { kind: 'password', hostName: host.name, username, message: text || '请输入验证码', forPassphrase: false, otp: true, rememberable: false });
          if (ans.kind !== 'password' || ans.value == null) return null;
          answers.push(ans.value);
          continue;
        }
        const known = typedPassword?.value ?? auth.password;
        if (known && (/password|密码|passcode/i.test(text) || prompts.length === 1) && kbdRounds <= 1) {
          answers.push(known);
          continue;
        }
        const ans = await ask(owner, {
          kind: 'password',
          hostName: host.name,
          username,
          message: text || null,
          forPassphrase: false,
          rememberable: canRemember && /password|密码/i.test(text),
        });
        if (ans.kind !== 'password' || ans.value == null) return null;
        if (/password|密码/i.test(text)) typedPassword = { value: ans.value, remember: ans.remember };
        answers.push(ans.value);
      }
      return answers;
    };

    const kbdStep = (): AnyAuthMethod => ({
      type: 'keyboard-interactive',
      username,
      prompt: (_name: string, _instructions: string, _lang: string, prompts: Prompt[], finish: KeyboardInteractiveCallback) => {
        kbdRounds++;
        if (prompts.length === 0) {
          finish([]);
          return;
        }
        void answerPrompts(prompts).then((answers) => {
          if (!answers) {
            canceled = true;
            finish([]);
            client.end();
            return;
          }
          finish(answers);
        });
      },
    });

    const authHandler = (methodsLeft: AuthenticationType[] | null, partial: boolean | null, next: NextAuthHandler): void => {
      const stop = (): void => (next as unknown as (v: false) => void)(false);
      if (canceled) {
        stop();
        return;
      }
      if (attempted && !partial) trace.warn('认证', `认证没有通过${methodsLeft?.length ? `，服务端允许：${methodsLeft.join(', ')}` : ''}`);
      if (partial) trace.success('认证', `部分认证通过，还需要：${methodsLeft?.join(', ') ?? '其他方式'}`);
      const step = queue.shift();
      if (step) {
        attempted = true;
        trace.info('认证', `尝试${AUTH_LABEL[step.type] ?? step.type}（用户 ${username}）`);
        next(step);
        return;
      }
      const allowPassword = !methodsLeft || methodsLeft.includes('password');
      const allowKeyboard = !!methodsLeft?.includes('keyboard-interactive');
      // 部分成功（例如公钥通过后还要验证码）、服务器只允许 keyboard-interactive、或者凭证带 TOTP：按提示自动应答
      if (allowKeyboard && kbdRounds < MAX_KBD_ROUNDS && (partial || !allowPassword || !!auth.otpSeed)) {
        attempted = true;
        trace.info('认证', `尝试键盘交互认证（用户 ${username}）`);
        next(kbdStep());
        return;
      }
      if (!allowFallbackPrompt || (!allowPassword && !allowKeyboard) || promptsLeft-- <= 0) {
        stop();
        return;
      }
      trace.info('认证', '等待输入密码');
      void ask(owner, {
        kind: 'password',
        hostName: host.name,
        username,
        message: attempted ? '认证失败，请重新输入密码' : null,
        forPassphrase: false,
        rememberable: canRemember,
      }).then((ans) => {
        if (ans.kind !== 'password' || ans.value == null) {
          canceled = true;
          stop();
          return;
        }
        attempted = true;
        trace.info('认证', `尝试密码认证（用户 ${username}）`);
        const value = ans.value;
        typedPassword = { value, remember: ans.remember };
        if (allowPassword) {
          next({ type: 'password', username, password: value });
        } else {
          kbdRounds = 0;
          next(kbdStep());
        }
      });
    };

    const hostVerifier = (key: Buffer, verify: (valid: boolean) => void): void => {
      const keyType = hostKeyType(key);
      const fingerprint = sha256Fingerprint(key);
      const known = this.hosts.knownFingerprint(host.address, host.port, keyType);
      if (known === fingerprint) {
        trace.success('指纹', `主机指纹已信任：${keyType} ${fingerprint}`);
        verify(true);
        return;
      }
      if (known) trace.error('指纹', `主机指纹和上次不一致！上次 ${known}，这次 ${fingerprint}`);
      else trace.warn('指纹', `首次连接，等待确认主机指纹：${keyType} ${fingerprint}`);
      void ask(owner, {
        kind: 'hostKey',
        hostName: host.name,
        address: host.address,
        port: host.port,
        keyType,
        fingerprint,
        previousFingerprint: known,
      }).then((ans) => {
        if (ans.kind === 'hostKey' && ans.accept) {
          this.hosts.saveFingerprint(host.address, host.port, keyType, fingerprint);
          trace.success('指纹', '已信任并保存主机指纹');
          verify(true);
        } else {
          hostKeyRejected = true;
          verify(false);
        }
      });
    };

    const failure = (err?: unknown): string =>
      hostKeyRejected
        ? `已拒绝「${host.name}」的主机指纹，连接已中止`
        : canceled
          ? '已取消连接'
          : timedOut
            ? phase === 'handshake'
              ? `SSH 握手超时（${host.address}:${host.port}）：TCP 已连接，但 ${Math.round(handshakeTimeoutMs / 1000)}s 内没有收到有效的 SSH 响应；请确认端口运行的是 SSH 服务`
              : `连接「${host.name}」超时`
            : signalAborted()
              ? '已取消连接'
              : err
              ? describeConnectError(err)
              : '连接已关闭';

    const signalAborted = (): boolean => !!trace.signal?.aborted;
    const fail = (msg: string): Error => (timedOut && phase === 'handshake' ? new RetryableError(msg) : new UserError(msg));
    return new Promise<Client>((resolve, reject) => {
      const onAbort = (): void => {
        canceled = true;
        client.destroy();
      };
      trace.signal?.addEventListener('abort', onAbort, { once: true });
      client.on('handshake', (n) => {
        phase = 'auth';
        trace.success('握手', `SSH 握手完成（${n.kex} / ${n.cs.cipher}）`);
        trace.step('auth', 'active');
        if (!ready) arm();
      });
      client.on('ready', () => {
        ready = true;
        disarm();
        trace.signal?.removeEventListener('abort', onAbort);
        trace.success('认证', `认证成功（用户 ${username}）`);
        trace.step('auth', 'done');
        if (typedPassword?.remember && canRemember) {
          this.hosts.remember(rememberId!, 'password', typedPassword.value);
        }
        resolve(client);
      });
      client.on('error', (err) => {
        if (!ready) {
          disarm();
          trace.signal?.removeEventListener('abort', onAbort);
          reject(fail(failure(err)));
        }
      });
      client.on('close', () => {
        disarm();
        trace.signal?.removeEventListener('abort', onAbort);
        if (!ready) {
          reject(fail(failure())); // 已经 reject 过时这里无效
        }
      });
      trace.info('握手', '正在交换协议版本和加密算法…');
      client.connect({
        sock,
        username,
        readyTimeout: 0,
        keepaliveInterval: host.keepaliveSec > 0 ? host.keepaliveSec * 1000 : 0,
        keepaliveCountMax: 3,
        hostVerifier,
        authHandler: authHandler as unknown as (a: AuthenticationType[], b: boolean, c: NextAuthHandler) => void,
      });
      arm();
    });
  }
}

/** 通过上一跳打开到下一跳的 TCP 通道（direct-tcpip） */
function forward(via: Client, viaName: string, to: Host): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    via.forwardOut('127.0.0.1', 0, to.address, to.port, (err, stream) => {
      if (err) {
        reject(new UserError(`跳板机「${viaName}」无法连接到 ${to.address}:${to.port}（${err.message}）`));
      } else {
        resolve(stream);
      }
    });
  });
}

/** 自己建立 TCP 连接（可以单独计时、取消、重试），再交给 ssh2 */
function openSocket(address: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UserError('已取消连接'));
      return;
    }
    const sock = tcpConnect({ host: address, port });
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      sock.removeListener('error', onError);
      if (err) {
        sock.destroy();
        reject(err);
      } else {
        resolve(sock);
      }
    };
    const onAbort = (): void => finish(new UserError('已取消连接'));
    const onError = (e: NodeJS.ErrnoException): void => {
      const msg = `${describeConnectError(e)}（${address}:${port}）`;
      finish(e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' ? new RetryableError(msg) : new UserError(msg));
    };
    const timer = setTimeout(() => finish(new RetryableError(`TCP 连接超时（${address}:${port}，${Math.round(timeoutMs / 1000)}s 内没有响应）`)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    sock.once('error', onError);
    sock.once('connect', () => finish(null));
  });
}
