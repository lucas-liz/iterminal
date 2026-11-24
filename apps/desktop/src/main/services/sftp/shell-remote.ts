import { posix } from 'node:path';
import { PassThrough, Writable, type Readable } from 'node:stream';
import type { Client, ClientChannel } from 'ssh2';
import { shQuote } from '../../util/shell';
import { execCommand } from '../connection/exec';
import type { RemoteFs, RemoteStats } from './remote-fs';

/** stat 的输出格式：原始 mode（十六进制）|大小|修改时间（秒）|所有者|所属组|名称 */
const FMT = `'%f|%s|%Y|%U|%G|%n'`;

export function parseStat(line: string): { stats: RemoteStats; name: string } | null {
  const m = /^([0-9a-fA-F]+)\|(\d+)\|(\d+)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line);
  if (!m) return null;
  return { stats: { mode: parseInt(m[1], 16), size: Number(m[2]), mtime: Number(m[3]), owner: m[4] || undefined, group: m[5] || undefined }, name: m[6] };
}

function failure(path: string, stderr: string, code: number | null): Error {
  const msg = stderr.trim().split('\n').pop() ?? '';
  if (/No such file|cannot stat|can't cd|not found|不存在/i.test(msg)) return Object.assign(new Error(`没有这个文件或目录：${path}`), { code: 2 });
  if (/Permission denied/i.test(msg)) return Object.assign(new Error(`没有权限：${path}`), { code: 3 });
  return new Error(msg || `远端命令失败（退出码 ${code ?? '未知'}）`);
}

/**
 * 通过 SSH 命令通道访问文件（服务器没有 sftp-server 时使用，例如报「exit code 127」）。
 * 只依赖终端本来就能用的 SSH exec：列目录用 find + stat，读用 cat / tail -c，写用 cat >（续传 cat >>），
 * 其他操作用 mkdir / mv / rm / rmdir / chmod。要求远端有 POSIX shell 和 GNU 或 busybox 的 stat。
 */
export class ShellRemote implements RemoteFs {
  readonly kind = 'shell' as const;
  private isClosed = false;
  private readonly handlers = new Set<() => void>();
  private readonly channels = new Set<ClientChannel>();

  private readonly onClientClose = (): void => this.markClosed();

  constructor(private readonly client: Client) {
    client.once('close', this.onClientClose);
  }

  /** 远端能不能用命令通道（stat 支持 -c、有 cat） */
  static async probe(client: Client): Promise<boolean> {
    try {
      const r = await execCommand(client, `stat -c %f / >/dev/null 2>&1 && command -v cat >/dev/null 2>&1 && echo itm-ok`, { timeoutMs: 10_000 });
      return r.code === 0 && r.stdout.includes('itm-ok');
    } catch {
      return false;
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  onClose(fn: () => void): () => void {
    if (this.isClosed) {
      fn();
      return () => undefined;
    }
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  /** 关闭这个对象开的所有通道（SSH 连接是共用的，不断开） */
  abort(): void {
    this.markClosed();
    for (const ch of this.channels) ch.close();
    this.channels.clear();
  }

  end(): void {
    this.abort();
  }

  private markClosed(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // 连接是共用的：不再需要时把监听去掉，避免越积越多
    this.client.removeListener('close', this.onClientClose);
    for (const fn of [...this.handlers]) fn();
    this.handlers.clear();
  }

  private async run(command: string, timeoutMs = 30_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
    if (this.isClosed) throw new Error('文件通道已关闭');
    const r = await execCommand(this.client, command, { timeoutMs, maxBytes: 16 * 1024 * 1024 });
    if (r.timedOut) throw new Error('远端命令超时');
    return r;
  }

  async readdir(path: string): Promise<{ filename: string; attrs: RemoteStats }[]> {
    // find 失败（没有 find、权限问题）时退回 shell 通配符
    const cmd =
      `cd -- ${shQuote(path)} || exit 3; ` +
      `if command -v find >/dev/null 2>&1; then find . -mindepth 1 -maxdepth 1 -exec stat -c ${FMT} {} + 2>/dev/null; ` +
      `else for f in .[!.]* ..?* *; do if [ -e "$f" ] || [ -L "$f" ]; then stat -c ${FMT} -- "$f"; fi; done; fi`;
    const r = await this.run(cmd);
    if (r.code === 3) throw failure(path, r.stderr, r.code);
    const out: { filename: string; attrs: RemoteStats }[] = [];
    for (const line of r.stdout.split('\n')) {
      const p = parseStat(line);
      if (!p) continue;
      const name = p.name.replace(/^\.\//, '');
      if (name && name !== '.' && name !== '..') out.push({ filename: name, attrs: p.stats });
    }
    return out;
  }

  private async statWith(path: string, follow: boolean): Promise<RemoteStats> {
    const r = await this.run(`stat ${follow ? '-L ' : ''}-c ${FMT} -- ${shQuote(path)}`);
    const p = r.code === 0 ? parseStat(r.stdout.trim().split('\n')[0] ?? '') : null;
    if (!p) throw failure(path, r.stderr, r.code);
    return p.stats;
  }

  stat(path: string): Promise<RemoteStats> {
    return this.statWith(path, true);
  }

  lstat(path: string): Promise<RemoteStats> {
    return this.statWith(path, false);
  }

  async realpath(path: string): Promise<string> {
    const r = await this.run(path === '.' || path === '' ? 'pwd -P' : `cd -- ${shQuote(path)} && pwd -P`);
    if (r.code !== 0) return posix.normalize(path === '.' ? '/' : path);
    return r.stdout.trim() || '/';
  }

  private async simple(cmd: string, path: string): Promise<void> {
    const r = await this.run(cmd);
    if (r.code !== 0) throw failure(path, r.stderr, r.code);
  }

  mkdir(path: string): Promise<void> {
    return this.simple(`mkdir -- ${shQuote(path)}`, path);
  }

  rename(from: string, to: string): Promise<void> {
    return this.simple(`mv -- ${shQuote(from)} ${shQuote(to)}`, from);
  }

  unlink(path: string): Promise<void> {
    return this.simple(`rm -f -- ${shQuote(path)}`, path);
  }

  rmdir(path: string): Promise<void> {
    return this.simple(`rmdir -- ${shQuote(path)}`, path);
  }

  async exists(path: string): Promise<RemoteStats | null> {
    try {
      return await this.stat(path);
    } catch (e) {
      if ((e as { code?: unknown }).code === 2) return null;
      throw e;
    }
  }

  /** 开一个 exec 通道（记下来，abort 时一起关掉） */
  private open(command: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (this.isClosed) return reject(new Error('文件通道已关闭'));
      this.client.exec(command, (err, ch) => {
        if (err) return reject(err);
        this.channels.add(ch);
        ch.on('close', () => this.channels.delete(ch));
        resolve(ch);
      });
    });
  }

  createReadStream(path: string, opts: { start?: number; highWaterMark?: number } = {}): Readable {
    const out = new PassThrough({ highWaterMark: opts.highWaterMark });
    const start = opts.start ?? 0;
    // tail -c +N 从第 N 个字节开始（从 1 数起），GNU 和 busybox 都支持
    const cmd = start > 0 ? `tail -c +${start + 1} -- ${shQuote(path)}` : `cat -- ${shQuote(path)}`;
    void this.open(cmd).then(
      (ch) => {
        let code: number | null = null;
        const err: Buffer[] = [];
        ch.stderr.on('data', (b: Buffer) => err.push(b));
        ch.on('exit', (c: number | null) => (code = c));
        ch.pipe(out, { end: false });
        ch.on('close', () => {
          if (code === 0) out.end();
          else out.destroy(failure(path, Buffer.concat(err).toString('utf8'), code));
        });
        out.on('close', () => ch.close());
      },
      (e: Error) => out.destroy(e),
    );
    return out;
  }

  createWriteStream(path: string, opts: { flags?: 'w' | 'r+'; start?: number; mode?: number } = {}): Writable {
    const append = opts.flags === 'r+' && (opts.start ?? 0) > 0;
    const chmod = opts.mode !== undefined && !append ? ` && chmod ${(opts.mode & 0o7777).toString(8)} ${shQuote(path)}` : '';
    const ready = this.open(`cat ${append ? '>>' : '>'} ${shQuote(path)}${chmod}`);
    // 写的一方 end() 之后要等远端 cat 正常退出才算完成
    const done = ready.then(
      (ch) =>
        new Promise<void>((resolve, reject) => {
          let code: number | null = null;
          const err: Buffer[] = [];
          // 标准输出没有内容，但必须读走，否则通道不会发出 close
          ch.resume();
          ch.stderr.on('data', (b: Buffer) => err.push(b));
          ch.on('exit', (c: number | null) => (code = c));
          ch.on('close', () => (code === 0 ? resolve() : reject(failure(path, Buffer.concat(err).toString('utf8'), code))));
        }),
    );
    done.catch(() => undefined);
    return new Writable({
      write(chunk: Buffer, _enc, cb) {
        ready.then(
          (ch) => {
            if (ch.write(chunk)) cb();
            else ch.once('drain', () => cb());
          },
          (e: Error) => cb(e),
        );
      },
      final(cb) {
        ready.then(
          (ch) => {
            ch.end();
            done.then(
              () => cb(),
              (e: Error) => cb(e),
            );
          },
          (e: Error) => cb(e),
        );
      },
      destroy(err, cb) {
        void ready.then(
          (ch) => ch.close(),
          () => undefined,
        );
        cb(err);
      },
    });
  }
}
