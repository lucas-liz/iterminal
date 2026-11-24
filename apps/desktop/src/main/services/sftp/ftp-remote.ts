import { posix } from 'node:path';
import { PassThrough, Writable, type Readable } from 'node:stream';
import { Client, type FileInfo } from 'basic-ftp';
import type { RemoteFs, RemoteStats } from './remote-fs';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export interface FtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  /** 'required'：必须 TLS（FTPS 显式模式）；'try'：先试 TLS，服务器不支持时退回明文；'off'：明文 */
  tls: 'required' | 'try' | 'off';
  timeoutMs: number;
}

/** FTP 的列表项转换成和 SFTP 一样的属性（类型位 + 权限位） */
function statsOf(f: FileInfo): RemoteStats {
  const type = f.isDirectory ? S_IFDIR : f.isSymbolicLink ? S_IFLNK : S_IFREG;
  const p = f.permissions;
  const perms = p ? (p.user << 6) | (p.group << 3) | p.world : f.isDirectory ? 0o755 : 0o644;
  const time = f.modifiedAt?.getTime() ?? (f.rawModifiedAt ? Date.parse(f.rawModifiedAt) : NaN);
  return { mode: type | perms, size: f.size, mtime: Number.isFinite(time) ? Math.floor(time / 1000) : 0, owner: f.user || undefined, group: f.group || undefined };
}

/** 和 SFTP 一致：不存在时 code = 2（ENOENT） */
function notFound(path: string): Error {
  return Object.assign(new Error(`没有这个文件或目录：${path}`), { code: 2 });
}

/** FTP 错误换成中文说明 */
export function describeFtpError(e: unknown): string {
  const err = e as { code?: unknown; message?: string };
  const msg = err?.message ?? String(e);
  if (err?.code === 530 || /^530/.test(msg)) return 'FTP 登录失败：用户名或密码不正确';
  if (err?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(msg)) return 'FTP 端口连接被拒绝（服务器没有开 FTP 服务，或端口不对）';
  if (/timeout|ETIMEDOUT/i.test(msg)) return 'FTP 连接超时';
  if (err?.code === 'ENOTFOUND' || /ENOTFOUND/.test(msg)) return '找不到服务器地址';
  return msg;
}

/**
 * FTP / FTPS 实现的远端文件系统（服务器没有 SFTP 时使用）。
 * 一条 FTP 连接同一时间只能做一件事：所有操作排队依次执行；浏览和传输各用一条连接。
 * FTP 不能设置文件权限，上传时忽略 mode；续传用 APPE（追加），下载续传用 REST。
 */
export class FtpRemote implements RemoteFs {
  readonly kind = 'ftp' as const;
  private isClosed = false;
  private readonly handlers = new Set<() => void>();
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly client: Client,
    /** 实际是否加密（显示给用户看） */
    readonly secure: boolean,
  ) {
    client.ftp.socket.once('close', () => this.markClosed());
  }

  static async connect(o: FtpOptions): Promise<FtpRemote> {
    const attempt = async (secure: boolean): Promise<FtpRemote> => {
      const c = new Client(o.timeoutMs);
      try {
        // 内网 FTP 服务器大多是自签名证书：加密传输，但不校验证书（等同于首次使用即信任）
        await c.access({ host: o.host, port: o.port, user: o.user, password: o.password, secure, secureOptions: { rejectUnauthorized: false } });
        return new FtpRemote(c, secure);
      } catch (e) {
        c.close();
        throw e;
      }
    };
    if (o.tls === 'off') return attempt(false);
    try {
      return await attempt(true);
    } catch (e) {
      // 服务器不支持 AUTH TLS（5xx 回复）时退回明文；登录失败、连不上等直接报错
      const code = (e as { code?: unknown }).code;
      if (o.tls === 'try' && typeof code === 'number' && code >= 500 && code !== 530) return attempt(false);
      throw e;
    }
  }

  get closed(): boolean {
    return this.isClosed || this.client.closed;
  }

  onClose(fn: () => void): () => void {
    if (this.closed) {
      fn();
      return () => undefined;
    }
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  abort(): void {
    this.markClosed();
    this.client.close();
  }

  end(): void {
    this.markClosed();
    this.client.close();
  }

  private markClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const fn of [...this.handlers]) fn();
    this.handlers.clear();
  }

  /** 排队执行（basic-ftp 不允许同一连接上同时进行两个操作） */
  private run<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const next = this.chain.then(() => {
      if (this.closed) throw new Error('FTP 连接已断开');
      return fn(this.client);
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  async readdir(path: string): Promise<{ filename: string; attrs: RemoteStats }[]> {
    const list = await this.run((c) => c.list(path));
    return list.filter((f) => f.name !== '.' && f.name !== '..').map((f) => ({ filename: f.name, attrs: statsOf(f) }));
  }

  /** FTP 没有 stat：在上级目录的列表里找；列不出上级时用 SIZE / CWD 判断 */
  async stat(path: string): Promise<RemoteStats> {
    const p = posix.normalize(path);
    if (p === '/') return { mode: S_IFDIR | 0o755, size: 0, mtime: 0 };
    const name = posix.basename(p);
    const listed = await this.run((c) => c.list(posix.dirname(p))).catch(() => null);
    if (listed) {
      const f = listed.find((x) => x.name === name);
      if (!f) throw notFound(p);
      return statsOf(f);
    }
    return this.run(async (c) => {
      const size = await c.size(p).catch(() => null);
      if (size !== null) return { mode: S_IFREG | 0o644, size, mtime: Math.floor(((await c.lastMod(p).catch(() => null))?.getTime() ?? 0) / 1000) };
      const cwd = await c.pwd();
      try {
        await c.cd(p);
        return { mode: S_IFDIR | 0o755, size: 0, mtime: 0 };
      } catch {
        throw notFound(p);
      } finally {
        await c.cd(cwd).catch(() => undefined);
      }
    });
  }

  lstat(path: string): Promise<RemoteStats> {
    return this.stat(path);
  }

  async realpath(path: string): Promise<string> {
    if (path === '.' || path === '') return this.run((c) => c.pwd());
    return posix.normalize(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.run((c) => c.send(`MKD ${path}`));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.run((c) => c.rename(from, to));
  }

  async unlink(path: string): Promise<void> {
    await this.run((c) => c.remove(path));
  }

  async rmdir(path: string): Promise<void> {
    await this.run((c) => c.send(`RMD ${path}`));
  }

  async exists(path: string): Promise<RemoteStats | null> {
    try {
      return await this.stat(path);
    } catch (e) {
      if ((e as { code?: unknown }).code === 2) return null;
      throw e;
    }
  }

  createReadStream(path: string, opts: { start?: number; highWaterMark?: number } = {}): Readable {
    const out = new PassThrough({ highWaterMark: opts.highWaterMark });
    // downloadTo 结束时会 end() 目标流；出错时把错误交给读的一方
    this.run((c) => c.downloadTo(out, path, opts.start ?? 0)).catch((e: Error) => out.destroy(e));
    return out;
  }

  createWriteStream(path: string, opts: { flags?: 'w' | 'r+'; start?: number } = {}): Writable {
    const source = new PassThrough();
    const append = opts.flags === 'r+' && (opts.start ?? 0) > 0;
    const done = this.run((c) => (append ? c.appendFrom(source, path) : c.uploadFrom(source, path)));
    // 写的一方 end() 之后要等服务器确认上传完成（226）才算 finish，调用方据此判断成功
    const w = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (source.write(chunk)) cb();
        else source.once('drain', () => cb());
      },
      final(cb) {
        source.end();
        done.then(
          () => cb(),
          (e: Error) => cb(e),
        );
      },
      destroy(err, cb) {
        source.destroy(err ?? undefined);
        cb(err);
      },
    });
    done.catch((e: Error) => {
      if (!w.destroyed) w.destroy(e);
    });
    return w;
  }
}
