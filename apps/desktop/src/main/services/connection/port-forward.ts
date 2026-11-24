import { createServer, connect as netConnect, isIP, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { PortForward, PortForwardStatus } from '@itm/protocol';
import type { PortForwardRepo } from '../hosts/port-forward-repo';
import { UserError } from '../../util/errors';
import type { Emit } from './emitter';
import type { PooledConnection, SshPool } from './ssh-pool';

interface Running {
  fwd: PortForward;
  owner: number;
  conn: PooledConnection | null;
  server: Server | null;
  /** REMOTE：主机上实际监听的端口 */
  remotePort: number | null;
  sockets: Set<Duplex>;
  status: PortForwardStatus;
  stop(): void;
}

/** 双向转发，任意一边关闭时关闭另一边 */
function pipeBoth(a: Duplex, b: Duplex, sockets: Set<Duplex>, onChange: () => void): void {
  sockets.add(a);
  sockets.add(b);
  onChange();
  let done = false;
  const close = (): void => {
    if (done) return;
    done = true;
    a.destroy();
    b.destroy();
    sockets.delete(a);
    sockets.delete(b);
    onChange();
  };
  a.on('error', close).on('close', close);
  b.on('error', close).on('close', close);
  a.pipe(b).pipe(a);
}

/**
 * SOCKS5 握手（RFC 1928，只支持「无认证 + CONNECT」）：解析出目标地址后调用 open，成功则回复并开始转发。
 * 只监听本机地址时不需要认证；监听 0.0.0.0 时由用户自己承担风险（界面会提示）。
 */
function socks5(sock: Socket, open: (host: string, port: number) => Promise<Duplex>, sockets: Set<Duplex>, onChange: () => void): void {
  let buf = Buffer.alloc(0);
  let stage: 'greet' | 'request' | 'done' = 'greet';
  const fail = (code: number): void => {
    sock.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
  };
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    if (stage === 'greet') {
      if (buf.length < 2) return;
      if (buf[0] !== 5) return void sock.destroy();
      const n = buf[1];
      if (buf.length < 2 + n) return;
      const methods = [...buf.subarray(2, 2 + n)];
      buf = buf.subarray(2 + n);
      if (!methods.includes(0)) {
        sock.end(Buffer.from([5, 0xff]));
        return;
      }
      sock.write(Buffer.from([5, 0]));
      stage = 'request';
    }
    if (stage === 'request') {
      if (buf.length < 5) return;
      if (buf[0] !== 5) return void sock.destroy();
      if (buf[1] !== 1) return fail(7); // 只支持 CONNECT
      const atyp = buf[3];
      let host: string;
      let off: number;
      if (atyp === 1) {
        if (buf.length < 10) return;
        host = [...buf.subarray(4, 8)].join('.');
        off = 8;
      } else if (atyp === 3) {
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        host = buf.subarray(5, 5 + len).toString('utf8');
        off = 5 + len;
      } else if (atyp === 4) {
        if (buf.length < 22) return;
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(4 + i).toString(16));
        host = parts.join(':');
        off = 20;
      } else {
        return fail(8);
      }
      const port = buf.readUInt16BE(off);
      const rest = buf.subarray(off + 2);
      stage = 'done';
      sock.off('data', onData);
      sock.pause();
      open(host, port).then(
        (remote) => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) remote.write(rest);
          pipeBoth(sock, remote, sockets, onChange);
          sock.resume();
        },
        () => fail(5),
      );
    }
  };
  sock.on('data', onData);
  sock.on('error', () => sock.destroy());
}

/**
 * 端口转发（文档一 6.10.1 port_forward）：经过连接池里的 SSH 连接（和终端、SFTP 共用一条连接）。
 */
export class PortForwardService {
  private readonly running = new Map<string, Running>();

  constructor(
    private readonly repo: PortForwardRepo,
    private readonly pool: SshPool,
    private readonly emit: Emit,
  ) {}

  statuses(hostId: string | null): PortForwardStatus[] {
    return this.repo.list(hostId).map((f) => this.status(f));
  }

  status(f: PortForward): PortForwardStatus {
    return this.running.get(f.id)?.status ?? { id: f.id, hostId: f.hostId, state: 'stopped', message: null, connections: 0, boundPort: null };
  }

  async start(owner: number, id: string): Promise<PortForwardStatus> {
    const fwd = this.repo.require(id);
    const existing = this.running.get(id);
    if (existing && (existing.status.state === 'running' || existing.status.state === 'starting')) return existing.status;
    const r: Running = {
      fwd,
      owner,
      conn: null,
      server: null,
      remotePort: null,
      sockets: new Set(),
      status: { id, hostId: fwd.hostId, state: 'starting', message: null, connections: 0, boundPort: null },
      stop: () => undefined,
    };
    this.running.set(id, r);
    this.update(r);
    try {
      r.conn = await this.pool.acquire(fwd.hostId, owner);
      const conn = r.conn;
      const onConnClose = (): void => this.fail(r, conn.error ? `SSH 连接已断开：${conn.error}` : 'SSH 连接已断开');
      conn.client.once('close', onConnClose);
      const changed = (): void => {
        r.status = { ...r.status, connections: Math.floor(r.sockets.size / 2) };
        this.update(r);
      };
      const viaSsh = (host: string, port: number): Promise<Duplex> =>
        new Promise((resolve, reject) => {
          conn.client.forwardOut('127.0.0.1', 0, host, port, (err, ch) => (err ? reject(err) : resolve(ch)));
        });

      if (fwd.type === 'REMOTE') {
        const boundPort = await new Promise<number>((resolve, reject) => {
          conn.client.forwardIn(fwd.bindAddr, fwd.bindPort, (err, port) => (err ? reject(new UserError(`主机拒绝监听 ${fwd.bindAddr}:${fwd.bindPort}：${err.message}`)) : resolve(port || fwd.bindPort)));
        });
        r.remotePort = boundPort;
        const onTcp = (info: { destPort: number }, accept: () => Duplex, reject: () => void): void => {
          if (info.destPort !== boundPort) return;
          const local = netConnect(fwd.targetPort!, fwd.targetAddr!);
          local.once('connect', () => pipeBoth(accept(), local, r.sockets, changed));
          local.once('error', () => reject());
        };
        conn.client.on('tcp connection', onTcp);
        r.stop = () => {
          conn.client.off('tcp connection', onTcp);
          conn.client.off('close', onConnClose);
          conn.client.unforwardIn(fwd.bindAddr, boundPort, () => undefined);
        };
        r.status = { ...r.status, state: 'running', boundPort };
      } else {
        const server = createServer((sock) => {
          if (fwd.type === 'DYNAMIC') {
            socks5(sock, viaSsh, r.sockets, changed);
            return;
          }
          sock.pause();
          viaSsh(fwd.targetAddr!, fwd.targetPort!).then(
            (ch) => {
              pipeBoth(sock, ch, r.sockets, changed);
              sock.resume();
            },
            () => sock.destroy(),
          );
        });
        await new Promise<void>((resolve, reject) => {
          server.once('error', (e: NodeJS.ErrnoException) =>
            reject(new UserError(e.code === 'EADDRINUSE' ? `本机端口 ${fwd.bindPort} 已被占用` : `无法监听 ${fwd.bindAddr}:${fwd.bindPort}：${e.message}`)),
          );
          server.listen(fwd.bindPort, isIP(fwd.bindAddr) || fwd.bindAddr === 'localhost' ? fwd.bindAddr : '127.0.0.1', () => resolve());
        });
        server.on('error', () => undefined);
        r.server = server;
        r.stop = () => {
          conn.client.off('close', onConnClose);
          server.close();
        };
        r.status = { ...r.status, state: 'running', boundPort: (server.address() as { port: number }).port };
      }
      if (this.running.get(id) !== r) {
        // 启动过程中被停止了
        this.cleanup(r);
        return this.status(fwd);
      }
      this.update(r);
      return r.status;
    } catch (e) {
      if (this.running.get(id) === r) this.fail(r, (e as Error).message);
      else this.cleanup(r);
      throw e instanceof UserError ? e : new UserError((e as Error).message);
    }
  }

  stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    this.cleanup(r);
    r.status = { ...r.status, state: 'stopped', message: null, connections: 0, boundPort: null };
    this.update(r);
  }

  /** 打开这台主机的终端时，启动它设置了「自动启动」的转发（已经在运行的跳过，失败只更新状态） */
  autoStart(owner: number, hostId: string): void {
    for (const f of this.repo.list(hostId)) {
      if (!f.autoStart) continue;
      const st = this.running.get(f.id)?.status.state;
      if (st === 'running' || st === 'starting') continue;
      this.start(owner, f.id).catch(() => undefined);
    }
  }

  /** 删除转发配置、删除主机时停掉 */
  stopHost(hostId: string): void {
    for (const r of [...this.running.values()]) if (r.fwd.hostId === hostId) this.stop(r.fwd.id);
  }

  stopAllOf(owner: number): void {
    for (const r of [...this.running.values()]) if (r.owner === owner) this.stop(r.fwd.id);
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  private fail(r: Running, message: string): void {
    if (this.running.get(r.fwd.id) !== r) return;
    this.cleanup(r);
    r.status = { ...r.status, state: 'error', message, connections: 0, boundPort: null };
    this.update(r);
  }

  private cleanup(r: Running): void {
    try {
      r.stop();
    } catch {
      // 连接已经断开时取消转发会失败，忽略
    }
    r.stop = () => undefined;
    r.server?.close();
    r.server = null;
    for (const s of r.sockets) s.destroy();
    r.sockets.clear();
    if (r.conn) {
      this.pool.release(r.conn);
      r.conn = null;
    }
  }

  private update(r: Running): void {
    this.emit(r.owner, 'portforward.status', { ...r.status });
  }
}
