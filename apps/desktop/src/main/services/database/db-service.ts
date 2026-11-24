import { createServer, type Server, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ClientChannel } from 'ssh2';
import type { Credential, DbAsset, DbAssetInput, DbTestOutcome } from '@itm/protocol';
import type { HostRepo } from '../hosts/host-repo';
import type { SshPool } from '../connection/ssh-pool';
import type { CredentialRepo } from '../vault/credential-repo';
import { UserError } from '../../util/errors';
import { normalizeDbInput, type DbAssetRepo } from './db-asset-repo';
import { describeDbError, openDriver, type DbDriver, type DbTarget, type RunOptions, type RunResult } from './drivers';

/** 一次工具调用的数据库连接（经过 SSH 主机时带着本机隧道），用完必须 close */
export interface DbSession {
  readonly asset: DbAsset;
  readonly driver: DbDriver;
  /** 实际连接的库（参数 → 资产的默认库） */
  readonly database: string;
  run(sql: string, o: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
}

export interface DbServiceDeps {
  repo: DbAssetRepo;
  credentials: CredentialRepo;
  hosts: HostRepo;
  pool: SshPool;
}

interface Tunnel {
  port: number;
  /** 经过 SSH 主机连接数据库失败的原因（例如那台主机连不上数据库端口） */
  lastError: string | null;
  close(): void;
}

/** 在本机 127.0.0.1 开一个临时端口，经过连接池里的 SSH 连接转发到数据库（和终端、SFTP 共用一条 SSH 连接） */
async function openTunnel(pool: SshPool, hostId: string, owner: number, dstHost: string, dstPort: number): Promise<Tunnel> {
  const conn = await pool.acquire(hostId, owner);
  const sockets = new Set<Socket | Duplex>();
  const t: Tunnel = { port: 0, lastError: null, close: () => undefined };
  const server: Server = createServer((sock) => {
    sock.pause();
    sockets.add(sock);
    const forward = (cb: (err: Error | undefined, ch: ClientChannel) => void): void => {
      // 连接已经断开时 ssh2 会同步抛出 Not connected（在 net.Server 的回调里抛出会变成未捕获异常）
      try {
        conn.client.forwardOut('127.0.0.1', 0, dstHost, dstPort, cb);
      } catch (e) {
        cb(e as Error, undefined as unknown as ClientChannel);
      }
    };
    forward((err, ch) => {
      if (err) {
        t.lastError = `SSH 主机「${conn.host.name}」连不上 ${dstHost}:${dstPort}（${err.message}）`;
        sock.destroy();
        return;
      }
      sockets.add(ch);
      const close = (): void => {
        sock.destroy();
        ch.destroy();
        sockets.delete(sock);
        sockets.delete(ch);
      };
      sock.on('error', close).on('close', close);
      ch.on('error', close).on('close', close);
      sock.pipe(ch).pipe(sock);
      sock.resume();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (e) {
    pool.release(conn);
    throw new UserError(`无法在本机开启数据库隧道：${(e as Error).message}`);
  }
  server.on('error', () => undefined);
  t.port = (server.address() as { port: number }).port;
  let closed = false;
  t.close = () => {
    if (closed) return;
    closed = true;
    server.close();
    for (const s of sockets) s.destroy();
    pool.release(conn);
  };
  return t;
}

/**
 * 数据库连接（文档一 6.31.4）：解析密码 / 凭证，按需要建立 SSH 隧道，连接数据库。
 * 每次工具调用新建一个连接，用完关闭；SSH 连接复用连接池。
 */
export class DbService {
  constructor(private readonly d: DbServiceDeps) {}

  get(id: string): DbAsset | null {
    return this.d.repo.get(id);
  }

  /** 资产引用的凭证（Agent 检查「禁止 AI 引用」） */
  credentialOf(asset: Pick<DbAsset, 'credentialId'>): Credential | null {
    return asset.credentialId ? this.d.credentials.get(asset.credentialId) : null;
  }

  /** 连接信息：引用凭证时用凭证的密码（资产没填用户名时也用凭证的用户名），否则用资产自己保存的密码 */
  private target(asset: Omit<DbAssetInput, 'password'>, ownPassword: string | null): DbTarget {
    let username = asset.username;
    let password = ownPassword;
    if (asset.credentialId) {
      const cred = this.d.credentials.get(asset.credentialId);
      if (!cred) throw new UserError('引用的凭证已被删除，请重新选择');
      if (cred.type !== 'DB' && cred.type !== 'PASSWORD') throw new UserError(`凭证「${cred.name}」不是数据库账号或密码类型`);
      password = this.d.credentials.secrets(cred.id).password ?? null;
      username = username || cred.username || '';
      this.d.credentials.markUsed(cred.id);
    }
    if (asset.type !== 'SQLITE' && !username) throw new UserError('没有设置用户名：请在数据库或它引用的凭证里填写');
    return { type: asset.type, host: asset.host, port: asset.port, database: asset.database, username, password, ssl: asset.ssl, filePath: asset.filePath };
  }

  private async connect(owner: number, asset: Omit<DbAssetInput, 'password'>, ownPassword: string | null, database: string | undefined): Promise<{ driver: DbDriver; tunnel: Tunnel | null; database: string }> {
    const target = this.target(asset, ownPassword);
    if (database !== undefined) target.database = database;
    let tunnel: Tunnel | null = null;
    if (asset.type !== 'SQLITE' && asset.viaHostId) {
      const host = this.d.hosts.get(asset.viaHostId);
      if (!host) throw new UserError('经过的 SSH 主机已被删除，请重新选择');
      if (host.protocol !== 'SSH') throw new UserError(`「${host.name}」不是 SSH 主机，不能用来连接数据库`);
      tunnel = await openTunnel(this.d.pool, host.id, owner, asset.host, asset.port);
      target.host = '127.0.0.1';
      target.port = tunnel.port;
    }
    try {
      return { driver: await openDriver(target), tunnel, database: target.database };
    } catch (e) {
      const why = tunnel?.lastError;
      tunnel?.close();
      if (why) throw new UserError(`连接数据库失败：${why}`);
      throw e;
    }
  }

  /** 打开已保存的数据库（Agent 工具用）；database 不填时用资产的默认库 */
  async open(owner: number, assetId: string, database?: string): Promise<DbSession> {
    const asset = this.d.repo.require(assetId);
    const c = await this.connect(owner, asset, this.d.repo.password(asset.id), database || undefined);
    let closed = false;
    return {
      asset,
      driver: c.driver,
      database: c.database,
      run: (sql, o) => c.driver.run(sql, o),
      close: async () => {
        if (closed) return;
        closed = true;
        await c.driver.close().catch(() => undefined);
        c.tunnel?.close();
      },
    };
  }

  /** 测试连接（编辑框里的「测试连接」，不需要先保存）：版本、延迟、可见的库数量 */
  async test(owner: number, id: string | null, input: DbAssetInput): Promise<DbTestOutcome> {
    const started = Date.now();
    let c: Awaited<ReturnType<DbService['connect']>> | null = null;
    try {
      const v = normalizeDbInput(input);
      const own = typeof input.password === 'string' && input.password !== '' ? input.password : input.password === undefined && id ? this.d.repo.password(id) : null;
      c = await this.connect(owner, v, own, undefined);
      const latencyMs = Date.now() - started;
      const listSql = v.type === 'MYSQL' ? 'SELECT count(*) FROM information_schema.schemata' : v.type === 'POSTGRES' ? 'SELECT count(*) FROM pg_database WHERE NOT datistemplate' : null;
      let databases: number | null = null;
      if (listSql) {
        const r = await c.driver.run(listSql, { readOnly: true, maxRows: 1, timeoutMs: 10_000 }).catch(() => null);
        databases = r?.rows[0] ? Number(r.rows[0][0]) : null;
      }
      return { ok: true, version: c.driver.version, latencyMs, databases };
    } catch (e) {
      return { ok: false, error: e instanceof UserError ? e.message : describeDbError(e) };
    } finally {
      await c?.driver.close().catch(() => undefined);
      c?.tunnel?.close();
    }
  }
}
