import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { ClientChannel } from 'ssh2';
import { stripAnsi } from '@itm/agent-core';
import { DEFAULT_SERIAL, type ConnProgress, type SerialSessionState, type SessionStatus } from '@itm/protocol';
import type { HostRepo } from '../hosts/host-repo';
import { UserError } from '../../util/errors';
import type { Emit } from './emitter';
import type { PooledConnection, SshPool } from './ssh-pool';
import { createCodec, type Codec } from './codec';
import { ConnTrace } from './conn-trace';
import type { Recorder } from '../audit/recording-store';

/** 会话录像：打开会话时由档案决定是否录像（返回 null 表示不录） */
export type RecorderFactory = (meta: { sessionId: string; kind: 'ssh' | 'telnet' | 'serial' | 'local'; hostId: string | null; hostName: string; username?: string | null; cols: number; rows: number; term?: string }) => Recorder | null;
import { AutoLogin, TelnetProtocol } from './telnet';
import { connectViaProxy } from './proxy';
import type { SerialPortLike, SerialProvider } from './serial';
import { ByteQueue, TransferError, xmodemSend, ymodemSend } from './xmodem';

/** 输出合并窗口：把几毫秒内的多次输出合成一条 IPC 消息 */
const FLUSH_MS = 5;
/** 每个会话保留的最近输出（原始字符，供 Agent 引用终端上下文） */
const HISTORY_CHARS = 128 * 1024;
const TELNET_CONNECT_TIMEOUT = 15_000;
/** Telnet 自动登录只在连接后的这段时间里生效 */
const AUTOLOGIN_WINDOW = 60_000;
/** 串口发送文件的大小上限 */
const MAX_SEND_FILE = 32 * 1024 * 1024;

type SessionKind = 'ssh' | 'local' | 'telnet' | 'serial';

interface Session {
  id: string;
  owner: number;
  kind: SessionKind;
  /** SSH / Telnet / 串口会话所属主机；本地 Shell 为 null */
  hostId: string | null;
  /** shell 已经打开（用于把远端 shell 进程对应到会话） */
  ready: boolean;
  /** 最近的输出（含 ANSI 转义，读取时再清理） */
  history: string;
  /** 累计输出的字符数，用作「从上次读到的位置继续」的游标 */
  written: number;
  lastOutputAt: number;
  /** 正在录制的日志文件 */
  log: { path: string; stream: WriteStream } | null;
  /** 会话录像（asciicast，文档一 6.12） */
  recorder: Recorder | null;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  /** 串口会话的扩展能力 */
  serial?: SerialHandle;
}

interface SerialHandle {
  state: SerialSessionState;
  set(patch: Partial<Pick<SerialSessionState, 'hex' | 'timestamp' | 'dtr' | 'rts'>>): Promise<SerialSessionState>;
  sendBytes(b: Buffer): void;
  sendFile(path: string, protocol: 'xmodem' | 'ymodem', signal: AbortSignal): Promise<void>;
  cancelTransfer(): void;
}

/** node-pty 的最小接口，便于测试替换 */
export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type SpawnPty = (shell: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyLike;

export function defaultShell(env: 'system' | 'clean' = 'system'): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: 'powershell.exe', args: env === 'clean' ? ['-NoProfile'] : [] };
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  if (env === 'clean') {
    // 干净终端：不读 .zshrc / .bashrc 等启动文件（没有别名、插件和自定义提示符）
    const name = shell.split('/').pop() ?? '';
    if (name === 'zsh') return { shell, args: ['-f'] };
    if (name === 'bash') return { shell, args: ['--noprofile', '--norc'] };
    if (name === 'fish') return { shell, args: ['--no-config'] };
  }
  // 对齐系统终端：登录 shell，从 Finder / 开始菜单启动时也能拿到用户的 PATH
  return { shell, args: ['-l'] };
}

/** 干净终端的环境变量：只保留基本的几个，其余不继承 */
function cleanEnv(): NodeJS.ProcessEnv {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'PATHEXT', 'WINDIR'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  // 从 Finder 启动时 PATH 很短：补上常用目录
  if (process.platform !== 'win32') {
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    env.PATH = [...new Set([...(env.PATH ?? '').split(':').filter(Boolean), ...extra])].join(':');
  }
  env.LANG ??= 'en_US.UTF-8';
  return env;
}

/** 把 "48 65 6c 6C" / "48656c" / "0x48,0x65" 解析成字节 */
export function parseHex(text: string): Buffer {
  const clean = text.replace(/0x/gi, '').replace(/[\s,;:-]+/g, '');
  if (!clean) throw new UserError('请输入要发送的十六进制字节');
  if (!/^[0-9a-f]+$/i.test(clean) || clean.length % 2 !== 0) throw new UserError('十六进制格式不对：每个字节两位，例如 48 65 6C 6C 6F');
  return Buffer.from(clean, 'hex');
}

const DIM = (s: string): string => `\x1b[90m${s}\x1b[0m`;

/** Windows 的串口名不分大小写（COM3 = com3） */
const serialKey = (path: string): string => (process.platform === 'win32' ? path.toUpperCase() : path);

/** 把 serialport 的系统错误翻译成用户能处理的提示 */
export function serialOpenError(path: string, msg: string): string {
  if (/access denied|resource busy|ebusy|cannot lock port/i.test(msg)) {
    return `无法打开串口 ${path}：端口被占用（${msg}）。请关闭正在使用它的其他程序（串口调试助手、Arduino IDE、其他终端软件等）后点「重新连接」`;
  }
  if (/permission denied|eacces/i.test(msg)) {
    return `无法打开串口 ${path}：没有权限（${msg}）。Linux 上请把当前用户加入 dialout 组（sudo usermod -aG dialout $USER）后重新登录`;
  }
  if (/file not found|no such file|enoent|cannot find/i.test(msg)) {
    return `无法打开串口 ${path}：找不到这个串口（${msg}）。请检查设备是否插好、端口号是否正确`;
  }
  return `无法打开串口 ${path}：${msg}`;
}
const pad2 = (n: number): string => String(n).padStart(2, '0');
function clock(t: number): string {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

/**
 * 串口接收显示（文档一 6.2）：十六进制显示（每行 16 字节）、每行前加时间戳。
 */
export class SerialView {
  hex = false;
  timestamp = false;
  private lineStart = true;
  private col = 0;

  constructor(
    private readonly decode: (b: Buffer) => string,
    private readonly now: () => number = Date.now,
  ) {}

  render(b: Buffer): string {
    let out = '';
    const prefix = (): string => (this.timestamp ? DIM(`[${clock(this.now())}] `) : '');
    if (this.hex) {
      for (const byte of b) {
        if (this.lineStart) {
          out += prefix();
          this.lineStart = false;
        }
        out += byte.toString(16).toUpperCase().padStart(2, '0') + ' ';
        if (++this.col >= 16 || byte === 0x0a) {
          out += '\r\n';
          this.col = 0;
          this.lineStart = true;
        }
      }
      return out;
    }
    const text = this.decode(b);
    if (!this.timestamp) return text;
    for (const ch of text) {
      if (this.lineStart && ch !== '\n' && ch !== '\r') {
        out += prefix();
        this.lineStart = false;
      }
      out += ch;
      if (ch === '\n') this.lineStart = true;
    }
    return out;
  }

  /** 切换显示方式时从新的一行开始 */
  reset(): string {
    const nl = this.lineStart ? '' : '\r\n';
    this.lineStart = true;
    this.col = 0;
    return nl;
  }
}

/**
 * 交互终端会话：SSH shell channel（复用连接池里的连接）、本地 Shell（node-pty）、Telnet 和串口。
 */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  /** 正在使用的串口。串口是独占的：上一个连接还没关完就再打开，Windows 会报 Access denied */
  private readonly serialHolds = new Map<string, { sessionId: string; closing: boolean; released: Promise<void> }>();
  /** SSH 终端打开成功（启动这台主机设置了自动启动的端口转发） */
  onSshReady: ((owner: number, hostId: string) => void) | null = null;
  /** 会话录像（由 ProfileContext 设置） */
  recorderFactory: RecorderFactory | null = null;
  /** 本机终端的环境（设置 → 外观 → 本地终端环境） */
  localEnv: () => 'system' | 'clean' = () => 'system';

  constructor(
    private readonly pool: SshPool,
    private readonly hosts: HostRepo,
    private readonly emit: Emit,
    private readonly spawnPty: SpawnPty,
    private readonly serialProvider: SerialProvider | null = null,
    private readonly now: () => number = Date.now,
  ) {}

  private base(id: string, owner: number, kind: SessionKind, hostId: string | null): Omit<Session, 'write' | 'resize' | 'close'> {
    // 最近连接时间：开始连接时就更新（第二十六轮），断开时再更新一次
    if (hostId) this.touchHost(owner, hostId);
    return { id, owner, kind, hostId, ready: false, history: '', written: 0, lastOutputAt: this.now(), log: null, recorder: null };
  }

  /** 立即返回 sessionId，连接在后台进行，进度通过 session.status 事件通知。 */
  openSsh(owner: number, hostId: string, cols: number, rows: number): string {
    const host = this.hosts.require(hostId);
    const id = randomUUID();
    const out = this.output(owner, id);
    const codec = createCodec(host.encoding);
    let stream: ClientChannel | null = null;
    let conn: PooledConnection | null = null;
    let closed = false;
    let pendingSize: { cols: number; rows: number } | null = null;
    const prog = this.progress(owner, id);

    const session: Session = {
      ...this.base(id, owner, 'ssh', hostId),
      write: (data) => stream?.write(codec.encode(data)),
      resize: (c, r) => {
        if (stream) {
          stream.setWindow(r, c, 0, 0);
        } else {
          pendingSize = { cols: c, rows: r };
        }
      },
      close: () => {
        closed = true;
        if (stream) {
          stream.close();
        } else {
          // 还在连接中：取消连接
          prog.controller.abort();
          prog.done('cancelled');
          this.finish(id, owner, 'closed', '已取消连接');
        }
      },
    };
    this.sessions.set(id, session);
    this.status(owner, id, 'connecting');

    void (async () => {
      try {
        conn = await this.pool.acquire(hostId, owner, [], prog.trace);
      } catch (e) {
        if (closed) return;
        prog.done('error', (e as Error).message);
        this.finish(id, owner, 'error', (e as Error).message);
        return;
      }
      if (closed) {
        this.pool.release(conn);
        return;
      }
      const c = conn;
      const size = pendingSize ?? { cols, rows };
      const term = c.host.termType || 'xterm-256color';
      prog.trace.step('channel', 'active');
      prog.trace.info('通道', `打开终端通道（${term}，${size.cols}×${size.rows}）`);
      const failed = (err: Error): void => {
        this.pool.release(c);
        prog.done('error', `打开终端失败：${err.message}`);
        this.finish(id, owner, 'error', `打开终端失败：${err.message}`);
      };
      // 底层连接已经断开时 ssh2 会同步抛出 Not connected：同样按打开失败处理，不能让会话一直停在连接中
      try {
        c.client.shell({ term, cols: size.cols, rows: size.rows }, (err, ch) => {
          if (err) {
            failed(err);
            return;
          }
          prog.trace.success('通道', '终端通道已打开');
          prog.trace.step('ready', 'done');
          prog.trace.success('就绪', '连接就绪');
          prog.done('ready');
          stream = ch;
          session.ready = true;
          this.startRecording(session, { kind: 'ssh', hostName: host.name, username: c.username ?? host.username ?? null, cols: size.cols, rows: size.rows, term });
          const errCodec = createCodec(host.encoding);
          ch.on('data', (b: Buffer) => out.push(codec.decode(b)));
          ch.stderr.on('data', (b: Buffer) => out.push(errCodec.decode(b)));
          ch.on('close', () => {
            out.push(codec.end() + errCodec.end());
            out.flush();
            this.pool.release(c);
            this.finish(id, owner, closed ? 'closed' : c.error ? 'error' : 'closed', c.error ?? (closed ? undefined : '连接已断开'));
          });
          this.touchHost(owner, hostId);
          this.status(owner, id, 'ready');
          if (closed) {
            ch.close();
            return;
          }
          this.onSshReady?.(owner, hostId);
          if (c.host.startupScript) {
            ch.write(codec.encode(c.host.startupScript.replace(/\r?\n/g, '\r') + '\r'));
          }
        });
      } catch (e) {
        failed(e as Error);
      }
    })();
    return id;
  }

  openLocal(owner: number, cols: number, rows: number): string {
    const id = randomUUID();
    const out = this.output(owner, id);
    const localEnv = this.localEnv();
    const { shell, args } = defaultShell(localEnv);
    let pty: PtyLike;
    try {
      pty = this.spawnPty(shell, args, {
        cols,
        rows,
        cwd: homedir(),
        env: { ...(localEnv === 'clean' ? cleanEnv() : process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerminal' },
      });
    } catch (e) {
      throw new UserError(`无法启动本地 Shell（${shell}）：${(e as Error).message}`);
    }
    let closed = false;
    pty.onData((d) => out.push(d));
    pty.onExit(({ exitCode }) => {
      out.flush();
      this.finish(id, owner, 'closed', closed ? undefined : `进程已退出（退出码 ${exitCode}）`);
    });
    this.sessions.set(id, {
      ...this.base(id, owner, 'local', null),
      ready: true,
      write: (d) => pty.write(d),
      resize: (c, r) => pty.resize(c, r),
      close: () => {
        closed = true;
        pty.kill();
      },
    });
    this.startRecording(this.sessions.get(id)!, { kind: 'local', hostName: '本机', username: process.env.USER || process.env.USERNAME || null, cols, rows });
    this.status(owner, id, 'ready');
    return id;
  }

  /**
   * Telnet（文档一 6.2）：选项协商、窗口大小、按主机编码收发；出现 login: / Password: 时自动填写主机保存的用户名和密码。
   * 主机设置了代理时经过代理连接。
   */
  openTelnet(owner: number, hostId: string, cols: number, rows: number): string {
    const info = this.hosts.connectInfo(hostId);
    const host = info.host;
    if (host.protocol !== 'TELNET') throw new UserError(`「${host.name}」不是 Telnet 主机`);
    const id = randomUUID();
    const out = this.output(owner, id);
    const codec = createCodec(host.encoding);
    let socket: Socket | null = null;
    let closed = false;
    const proto = new TelnetProtocol((b) => socket?.write(b), host.termType || 'xterm-256color', cols, rows);
    const password = info.auth.method === 'PASSWORD' ? info.auth.password : undefined;
    const login = new AutoLogin(info.auth.username, password);
    let loginUntil = 0;
    let startup = !!host.startupScript;
    const prog = this.progress(owner, id);

    const send = (s: string): void => {
      socket?.write(proto.encode(codec.encode(s)));
    };
    const session: Session = {
      ...this.base(id, owner, 'telnet', hostId),
      write: send,
      resize: (c, r) => proto.resize(c, r),
      close: () => {
        closed = true;
        if (socket) socket.destroy();
        else {
          prog.controller.abort();
          prog.done('cancelled');
          this.finish(id, owner, 'closed', '已取消连接');
        }
      },
    };
    this.sessions.set(id, session);
    this.status(owner, id, 'connecting');

    void (async () => {
      let s: Socket;
      prog.trace.step('connect', 'active');
      prog.trace.info('TCP', info.proxy ? `通过 ${info.proxy.type} 代理连接 ${host.address}:${host.port}` : `正在建立 Socket 连接：${host.address}:${host.port}`);
      try {
        s = info.proxy
          ? await connectViaProxy(info.proxy, host.address, host.port, TELNET_CONNECT_TIMEOUT)
          : await new Promise<Socket>((resolve, reject) => {
              const sock = netConnect({ host: host.address, port: host.port });
              const timer = setTimeout(() => {
                sock.destroy();
                reject(new Error(`连接 ${host.address}:${host.port} 超时`));
              }, TELNET_CONNECT_TIMEOUT);
              sock.once('connect', () => {
                clearTimeout(timer);
                resolve(sock);
              });
              sock.once('error', (e) => {
                clearTimeout(timer);
                reject(new Error(`连接 ${host.address}:${host.port} 失败：${e.message}`));
              });
            });
      } catch (e) {
        if (closed) return;
        prog.done('error', (e as Error).message);
        this.finish(id, owner, 'error', (e as Error).message);
        return;
      }
      if (closed) {
        s.destroy();
        return;
      }
      prog.trace.success('TCP', `Socket 连接成功：${host.address}:${host.port}`);
      prog.trace.step('auth', 'done');
      prog.trace.success('协商', `终端类型 ${host.termType || 'xterm-256color'}，编码 ${codec.encoding}${password ? '，出现登录提示时自动填写用户名和密码' : ''}`);
      prog.trace.step('ready', 'done');
      prog.done('ready');
      socket = s;
      session.ready = true;
      this.startRecording(session, { kind: 'telnet', hostName: host.name, username: host.username || null, cols, rows, term: host.termType || 'xterm-256color' });
      loginUntil = this.now() + AUTOLOGIN_WINDOW;
      if (host.keepaliveSec > 0) s.setKeepAlive(true, host.keepaliveSec * 1000);
      s.setNoDelay(true);
      const runStartup = (): void => {
        if (!startup) return;
        startup = false;
        setTimeout(() => send(host.startupScript!.replace(/\r?\n/g, '\r') + '\r'), 800);
      };
      s.on('data', (b: Buffer) => {
        const text = codec.decode(proto.receive(b));
        out.push(text);
        if (!login.done && this.now() < loginUntil) {
          const reply = login.feed(text);
          if (reply) send(reply);
          if (login.done) runStartup();
        } else {
          runStartup();
        }
      });
      s.on('close', () => {
        out.push(codec.end());
        out.flush();
        this.finish(id, owner, 'closed', closed ? undefined : '连接已断开');
      });
      s.on('error', () => undefined);
      this.touchHost(owner, hostId);
      this.status(owner, id, 'ready');
    })();
    return id;
  }

  /**
   * 串口（文档一 6.2）：端口参数来自主机设置；回车按设置发送 CR / LF / CRLF，可以本地回显；
   * 接收可以切换十六进制显示和时间戳；可以控制 DTR / RTS、发送十六进制字节、用 XMODEM / YMODEM 发送文件。
   */
  openSerial(owner: number, hostId: string): string {
    const host = this.hosts.require(hostId);
    if (host.protocol !== 'SERIAL') throw new UserError(`「${host.name}」不是串口设备`);
    if (!this.serialProvider) throw new UserError('这台电脑上不能使用串口');
    const o = { ...DEFAULT_SERIAL, ...(host.serial ?? {}) };
    const id = randomUUID();
    const out = this.output(owner, id);
    const codec = createCodec(host.encoding);
    const view = new SerialView((b) => codec.decode(b), this.now);
    const eol = o.eol === 'LF' ? '\n' : o.eol === 'CRLF' ? '\r\n' : '\r';
    const key = serialKey(host.address);
    const prev = this.serialHolds.get(key);
    if (prev && !prev.closing) throw new UserError(`串口 ${host.address} 已经在另一个标签中打开，同一个串口同时只能打开一次`);
    let port: SerialPortLike;
    try {
      port = this.serialProvider.open({
        path: host.address,
        baudRate: Number(o.baudRate) || 115200,
        dataBits: o.dataBits,
        parity: o.parity,
        stopBits: o.stopBits,
        rtscts: o.flowControl === 'hardware',
        xon: o.flowControl === 'software',
        xoff: o.flowControl === 'software',
      });
    } catch (e) {
      throw new UserError(serialOpenError(host.address, (e as Error).message));
    }
    // 重新连接时等上一个连接把串口关掉再打开（最多等 3 秒）
    let release!: () => void;
    const hold = { sessionId: id, closing: false, released: new Promise<void>((r) => (release = r)) };
    this.serialHolds.set(key, hold);
    const releaseHold = (): void => {
      if (this.serialHolds.get(key) === hold) this.serialHolds.delete(key);
      release();
    };
    const prevReleased = prev ? Promise.race([prev.released, new Promise<void>((r) => setTimeout(r, 3000))]) : Promise.resolve();
    let closed = false;
    /** 发送文件期间，收到的字节交给传输协议，不显示 */
    let transfer: { queue: ByteQueue; abort: AbortController } | null = null;
    const state: SerialSessionState = { hex: false, timestamp: false, dtr: true, rts: true, transferring: null };
    const emitState = (): void => this.emit(owner, 'session.serial', { sessionId: id, state: { ...state } });
    const notice = (s: string): void => out.push(DIM(`\r\n[${s}]\r\n`));

    const sendBytes = (b: Buffer): void => {
      if (closed || !port.isOpen) throw new UserError('串口没有打开');
      port.write(b);
    };
    const handle: SerialHandle = {
      state,
      set: async (patch) => {
        if (patch.hex !== undefined && patch.hex !== state.hex) {
          out.push(view.reset());
          state.hex = view.hex = patch.hex;
        }
        if (patch.timestamp !== undefined && patch.timestamp !== state.timestamp) {
          out.push(view.reset());
          state.timestamp = view.timestamp = patch.timestamp;
        }
        const lines: { dtr?: boolean; rts?: boolean } = {};
        if (patch.dtr !== undefined) lines.dtr = patch.dtr;
        if (patch.rts !== undefined) lines.rts = patch.rts;
        if (Object.keys(lines).length) {
          await new Promise<void>((resolve, reject) => port.set(lines, (err) => (err ? reject(new UserError(`设置控制线失败：${err.message}`)) : resolve())));
          Object.assign(state, lines);
        }
        emitState();
        return { ...state };
      },
      sendBytes: (b) => {
        sendBytes(b);
        if (o.localEcho) out.push(DIM(`>> ${[...b].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ')}`) + '\r\n');
      },
      sendFile: async (path, protocol, signal) => {
        if (transfer) throw new UserError('已经有文件在发送中');
        const st = await stat(path).catch(() => null);
        if (!st?.isFile()) throw new UserError('文件不存在');
        if (st.size > MAX_SEND_FILE) throw new UserError('文件太大（串口发送最多 32MB）');
        const data = await readFile(path);
        const abort = new AbortController();
        const onAbort = (): void => abort.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        const queue = new ByteQueue((b) => port.write(b));
        transfer = { queue, abort };
        const name = basename(path);
        state.transferring = { name, protocol, sent: 0, total: data.length };
        emitState();
        notice(`${protocol.toUpperCase()} 发送 ${name}（${data.length} 字节），等待设备开始接收……`);
        let lastEmit = 0;
        const onProgress = (sent: number, total: number): void => {
          state.transferring = { name, protocol, sent, total };
          if (this.now() - lastEmit > 200 || sent === total) {
            lastEmit = this.now();
            emitState();
          }
        };
        try {
          if (protocol === 'ymodem') await ymodemSend(queue, [{ name, data, mtime: st.mtimeMs }], { signal: abort.signal, onProgress });
          else await xmodemSend(queue, data, { signal: abort.signal, onProgress });
          notice(`${protocol.toUpperCase()} 发送完成：${name}`);
        } catch (e) {
          notice(`${protocol.toUpperCase()} 发送失败：${e instanceof TransferError ? e.message : (e as Error).message}`);
          throw new UserError(e instanceof TransferError ? e.message : (e as Error).message);
        } finally {
          signal.removeEventListener('abort', onAbort);
          transfer = null;
          state.transferring = null;
          emitState();
        }
      },
      cancelTransfer: () => transfer?.abort.abort(),
    };

    const session: Session = {
      ...this.base(id, owner, 'serial', hostId),
      serial: handle,
      write: (data) => {
        if (closed || !port.isOpen || transfer) return;
        const text = data.replace(/\r/g, eol);
        port.write(codec.encode(text));
        if (o.localEcho) out.push(data.replace(/\r/g, '\r\n').replace(/\x7f/g, '\b \b'));
      },
      resize: () => undefined,
      close: () => {
        closed = true;
        hold.closing = true;
        transfer?.abort.abort();
        if (port.isOpen) port.close();
        else this.finish(id, owner, 'closed');
      },
    };
    this.sessions.set(id, session);
    this.status(owner, id, 'connecting');
    port.on('data', (b: Buffer) => {
      if (transfer) transfer.queue.push(b);
      else out.push(view.render(b));
    });
    port.on('error', () => undefined);
    port.on('close', (err) => {
      releaseHold();
      out.push(codec.end());
      out.flush();
      this.finish(id, owner, closed ? 'closed' : 'error', closed ? undefined : `串口已断开${err ? `：${err.message}` : ''}`);
    });
    const start = (): void => port.open((err) => {
      if (err) {
        releaseHold();
        this.finish(id, owner, 'error', serialOpenError(host.address, err.message));
        return;
      }
      if (closed) {
        port.close();
        return;
      }
      session.ready = true;
      this.startRecording(session, { kind: 'serial', hostName: host.name, cols: 80, rows: 24 });
      this.touchHost(owner, hostId);
      this.status(owner, id, 'ready');
      emitState();
      out.push(DIM(`[已打开 ${host.address} · ${o.baudRate} ${o.dataBits}${o.parity[0].toUpperCase()}${o.stopBits} · 回车发送 ${o.eol}]`) + '\r\n');
      if (host.startupScript) session.write(host.startupScript.replace(/\r?\n/g, '\r') + '\r');
    });
    void prevReleased.then(() => {
      if (closed) releaseHold();
      else start();
    });
    return id;
  }

  listSerialPorts(): ReturnType<SerialProvider['list']> {
    if (!this.serialProvider) return Promise.resolve([]);
    return this.serialProvider.list();
  }

  serial(owner: number, sessionId: string): SerialHandle {
    const s = this.own(owner, sessionId);
    if (!s?.serial) throw new UserError('不是串口会话或会话已关闭');
    return s.serial;
  }

  /** 开始 / 停止把终端输出录制到日志文件（去掉颜色等控制字符） */
  setLog(owner: number, sessionId: string, path: string | null): void {
    const s = this.own(owner, sessionId);
    if (!s) throw new UserError('会话已关闭');
    s.log?.stream.end();
    s.log = null;
    if (path) {
      const stream = createWriteStream(path, { flags: 'a' });
      stream.on('error', () => undefined);
      stream.write(`\n===== ${new Date(this.now()).toLocaleString('zh-CN', { hour12: false })} 开始录制 =====\n`);
      s.log = { path, stream };
    }
  }

  logOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.log?.path ?? null;
  }

  write(owner: number, sessionId: string, data: string): void {
    this.own(owner, sessionId)?.write(data);
  }

  resize(owner: number, sessionId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) {
      return;
    }
    const s = this.own(owner, sessionId);
    s?.resize(cols, rows);
    s?.recorder?.resize(cols, rows);
  }

  close(owner: number, sessionId: string): void {
    this.own(owner, sessionId)?.close();
  }

  /** 窗口关闭时关掉它的所有会话 */
  closeAllOf(owner: number): void {
    for (const s of [...this.sessions.values()]) {
      if (s.owner === owner) {
        s.close();
      }
    }
  }

  /** 这台主机已连接的终端会话（最近有输出的优先）；owner 不为空时只找这个窗口的 */
  sessionForHost(hostId: string, owner?: number): string | null {
    let best: Session | null = null;
    for (const s of this.sessions.values()) {
      if (s.hostId !== hostId || !s.ready || (owner !== undefined && s.owner !== owner)) continue;
      if (!best || s.lastOutputAt > best.lastOutputAt) best = s;
    }
    return best?.id ?? null;
  }

  /** 写一段内容到会话录像（例如 Agent 在这台主机上执行的命令和输出），不发给终端；没有在录像时返回 false */
  appendRecording(sessionId: string, text: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s?.recorder) return false;
    s.recorder.output(text);
    return true;
  }

  /** 打开的会话（问题反馈的诊断信息用）：类型和是否已连接，不含地址 */
  summary(): { kind: SessionKind; ready: boolean }[] {
    return [...this.sessions.values()].map((s) => ({ kind: s.kind, ready: s.ready }));
  }

  /** 会话的基本信息；已关闭时返回 null */
  info(sessionId: string): { owner: number; hostId: string | null; ready: boolean; kind: SessionKind } | null {
    const s = this.sessions.get(sessionId);
    return s ? { owner: s.owner, hostId: s.hostId, ready: s.ready, kind: s.kind } : null;
  }

  /**
   * 最近的输出（原始字符）。since 为上次返回的游标时只返回之后的新输出；
   * 游标已经滚出缓冲区时返回缓冲区里的全部内容。
   */
  recentOutput(sessionId: string, since: number | null): { raw: string; cursor: number } | null {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const start = s.written - s.history.length;
    const from = since === null ? start : Math.max(since, start);
    return { raw: s.history.slice(from - start), cursor: s.written };
  }

  /**
   * 向串口 / Telnet 会话发送一行命令并等待输出（Agent 的 serial_send）：
   * 给了 waitFor（正则）时等到新输出匹配为止；否则等到 idleMs 内没有新输出；最长 timeoutMs。
   */
  async sendAndWait(sessionId: string, data: string, waitFor: string | null, timeoutMs: number, signal: AbortSignal, idleMs = 2000): Promise<string> {
    const s = this.sessions.get(sessionId);
    if (!s || !s.ready) throw new UserError('会话已关闭');
    if (s.kind !== 'serial' && s.kind !== 'telnet') throw new UserError('只能向串口或 Telnet 会话发送');
    let re: RegExp | null = null;
    if (waitFor) {
      try {
        re = new RegExp(waitFor, 'm');
      } catch {
        throw new UserError(`等待的提示符不是合法的正则：${waitFor}`);
      }
    }
    const start = s.written;
    const sentAt = this.now();
    s.write(data.replace(/\r?\n$/, '') + '\r');
    const newText = (): string => {
      const r = this.recentOutput(sessionId, start);
      return r ? stripAnsi(r.raw) : '';
    };
    return await new Promise<string>((resolve, reject) => {
      const timer = setInterval(() => {
        const cur = this.sessions.get(sessionId);
        const text = newText();
        if (!cur) return finish(() => resolve(`${text}\n（会话已关闭）`));
        // 去掉回显的命令本身再匹配提示符
        const body = text.startsWith(data) ? text.slice(data.length) : text;
        if (re && re.test(body)) return finish(() => resolve(text));
        const now = this.now();
        if (!re && cur.lastOutputAt > sentAt && now - cur.lastOutputAt >= idleMs) return finish(() => resolve(text));
        if (now - sentAt >= timeoutMs) return finish(() => resolve(`${text}\n（等待 ${Math.round(timeoutMs / 1000)} 秒超时）`));
      }, 100);
      const onAbort = (): void => finish(() => reject(new UserError('已停止')));
      const finish = (f: () => void): void => {
        clearInterval(timer);
        signal.removeEventListener('abort', onAbort);
        f();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 某台主机上仍然打开着的 SSH 会话，按打开顺序 */
  sshSessionsOf(hostId: string): { id: string; owner: number }[] {
    return [...this.sessions.values()].filter((s) => s.kind === 'ssh' && s.hostId === hostId && s.ready).map((s) => ({ id: s.id, owner: s.owner }));
  }

  private own(owner: number, sessionId: string): Session | undefined {
    const s = this.sessions.get(sessionId);
    return s && s.owner === owner ? s : undefined;
  }

  private finish(id: string, owner: number, status: SessionStatus, message?: string): void {
    const s = this.sessions.get(id);
    if (!s) {
      return;
    }
    s.log?.stream.end();
    s.recorder?.end();
    s.recorder = null;
    this.sessions.delete(id);
    if (s.hostId) this.touchHost(owner, s.hostId);
    this.status(owner, id, status, message);
  }

  /** 更新主机的最近连接时间，并通知界面刷新主机列表 */
  private touchHost(owner: number, hostId: string): void {
    try {
      this.hosts.touchConnected(hostId);
      this.emit(owner, 'hosts.changed', { reason: 'connected' });
    } catch {
      // 主机已删除等：不影响会话
    }
  }

  private startRecording(session: Session, m: { kind: 'ssh' | 'telnet' | 'serial' | 'local'; hostName: string; username?: string | null; cols: number; rows: number; term?: string }): void {
    if (!this.recorderFactory || session.recorder) return;
    try {
      session.recorder = this.recorderFactory({ sessionId: session.id, hostId: session.hostId, ...m });
    } catch {
      // 录像失败不影响会话
      session.recorder = null;
    }
  }

  /** 连接进度（文档一 6.15.3）：日志和步骤变化推给界面 */
  private progress(owner: number, sessionId: string): { trace: ConnTrace; controller: AbortController; done(state: ConnProgress['state'], error?: string): void } {
    const controller = new AbortController();
    const trace = new ConnTrace(controller.signal, this.now);
    let finished = false;
    trace.subscribe(({ entry, steps }) => {
      if (!finished) this.emit(owner, 'session.progress', { sessionId, steps, entries: entry ? [entry] : [], state: 'connecting' });
    });
    return {
      trace,
      controller,
      done: (state, error) => {
        if (finished) return;
        if (state === 'error' && error) trace.fail(error);
        if (state === 'cancelled') trace.push('warn', '取消', '已取消连接');
        finished = true;
        this.emit(owner, 'session.progress', { sessionId, steps: { ...trace.steps }, entries: [], state, ...(error ? { error } : {}) });
      },
    };
  }

  private status(owner: number, sessionId: string, status: SessionStatus, message?: string): void {
    this.emit(owner, 'session.status', message ? { sessionId, status, message } : { sessionId, status });
  }

  private output(owner: number, sessionId: string): { push(s: string): void; flush(): void } {
    let buf = '';
    let timer: NodeJS.Timeout | null = null;
    const flush = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (buf) {
        this.emit(owner, 'session.data', { sessionId, data: buf });
        buf = '';
      }
    };
    return {
      push: (s) => {
        if (!s) {
          return;
        }
        const session = this.sessions.get(sessionId);
        if (session) {
          session.history += s;
          session.written += s.length;
          session.lastOutputAt = this.now();
          if (session.history.length > HISTORY_CHARS) session.history = session.history.slice(-HISTORY_CHARS);
          session.log?.stream.write(stripAnsi(s).replace(/\r\n?/g, '\n'));
          session.recorder?.output(s);
        }
        buf += s;
        timer ??= setTimeout(flush, FLUSH_MS);
      },
      flush,
    };
  }
}
