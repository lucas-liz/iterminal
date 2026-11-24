import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir as mkdirLocal } from 'node:fs/promises';
import { dirname as dirnameLocal, join as joinLocal, posix } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Client, SFTPWrapper, Stats } from 'ssh2';
import type { Readable, Writable } from 'node:stream';
import type { FileEntry } from '@itm/protocol';
import type { RemoteFs } from './remote-fs';
import type { FileTransfer } from '@itm/protocol';
import type { HostRepo } from '../hosts/host-repo';
import type { PromptBroker } from '../connection/prompt-broker';
import { describeFtpError, FtpRemote, type FtpOptions } from './ftp-remote';
import { ShellRemote } from './shell-remote';

/** 实际使用的文件协议 */
export type FileProtocol = 'sftp' | 'shell' | 'ftp' | 'ftps';
import { UserError } from '../../util/errors';
import { shQuote } from '../../util/shell';
import { execCommand } from '../connection/exec';
import type { PooledConnection, SshPool } from '../connection/ssh-pool';
import { compareEntries, fileTypeOf, ownerOf, permsOf } from './file-mode';

/** 远端 SFTP 操作的 Promise 封装 */
export class Remote implements RemoteFs {
  readonly kind = 'sftp' as const;
  /** channel 已关闭（连接断开、被取消）：传输重试时要重新打开 */
  closed = false;
  private readonly closeHandlers = new Set<() => void>();

  constructor(readonly sftp: SFTPWrapper) {
    sftp.once('close', () => this.markClosed());
    sftp.once('end', () => this.markClosed());
  }

  /** channel 关闭时回调（马上关闭的不用等服务器确认）；返回取消订阅的函数 */
  onClose(fn: () => void): () => void {
    if (this.closed) {
      fn();
      return () => undefined;
    }
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  /** 主动关闭：立即通知正在进行的读写（ssh2 要等服务器确认关闭才发 close 事件，读写流在这之前会一直挂着） */
  abort(): void {
    this.markClosed();
    this.sftp.end();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of [...this.closeHandlers]) fn();
    this.closeHandlers.clear();
  }

  /** 列目录：所有者 / 组的名字取自 longname（ls -l 格式），没有时用 uid / gid */
  readdir(path: string): Promise<{ filename: string; attrs: Stats & { owner?: string; group?: string } }[]> {
    return new Promise((res, rej) =>
      this.sftp.readdir(path, (e, list) => (e ? rej(e) : res(list.map((it) => ({ filename: it.filename, attrs: Object.assign(it.attrs, ownerOf(it.longname, it.attrs)) }))))),
    );
  }
  stat(path: string): Promise<Stats> {
    return new Promise((res, rej) => this.sftp.stat(path, (e, s) => (e ? rej(e) : res(s))));
  }
  lstat(path: string): Promise<Stats> {
    return new Promise((res, rej) => this.sftp.lstat(path, (e, s) => (e ? rej(e) : res(s))));
  }
  realpath(path: string): Promise<string> {
    return new Promise((res, rej) => this.sftp.realpath(path, (e, p) => (e ? rej(e) : res(p))));
  }
  mkdir(path: string): Promise<void> {
    return new Promise((res, rej) => this.sftp.mkdir(path, (e) => (e ? rej(e) : res())));
  }
  rename(from: string, to: string): Promise<void> {
    return new Promise((res, rej) => this.sftp.rename(from, to, (e) => (e ? rej(e) : res())));
  }
  unlink(path: string): Promise<void> {
    return new Promise((res, rej) => this.sftp.unlink(path, (e) => (e ? rej(e) : res())));
  }
  rmdir(path: string): Promise<void> {
    return new Promise((res, rej) => this.sftp.rmdir(path, (e) => (e ? rej(e) : res())));
  }
  /** 不存在时返回 null */
  async exists(path: string): Promise<Stats | null> {
    try {
      return await this.stat(path);
    } catch (e) {
      if ((e as { code?: unknown }).code === 2) {
        return null;
      }
      throw e;
    }
  }
  end(): void {
    this.sftp.end();
  }
  createReadStream(path: string, opts?: { start?: number; highWaterMark?: number }): Readable {
    return this.sftp.createReadStream(path, opts);
  }
  createWriteStream(path: string, opts?: { flags?: 'w' | 'r+'; start?: number; mode?: number }): Writable {
    return this.sftp.createWriteStream(path, opts);
  }
}

export function openSftp(client: Client): Promise<Remote> {
  return new Promise((res, rej) => client.sftp((e, s) => (e ? rej(e) : res(new Remote(s)))));
}

interface SftpSession {
  id: string;
  owner: number;
  /** SFTP 时复用的 SSH 连接；FTP 时为 null */
  conn: PooledConnection | null;
  /** FTP 的连接参数（传输通道要单独再连一条） */
  ftp: FtpOptions | null;
  /** SSH 命令通道（服务器没有 sftp-server） */
  shell: boolean;
  /** 浏览用的 channel */
  browse: RemoteFs;
  /** 传输用的独立 channel：取消传输时只重建它，不影响浏览 */
  transfer: Promise<RemoteFs> | null;
  transferRemote: RemoteFs | null;
}

export interface FileServiceDeps {
  /** 主机配置和解密后的认证信息（FTP 用同样的用户名密码登录） */
  hosts: Pick<HostRepo, 'get' | 'connectInfo'>;
  prompts: Pick<PromptBroker, 'ask'>;
}

/**
 * SFTP：每个 SFTP 标签页一个会话，复用连接池里的 SSH 连接。
 */
export class SftpService {
  private readonly sessions = new Map<string, SftpSession>();

  constructor(
    private readonly pool: SshPool,
    private readonly deps: FileServiceDeps | null = null,
  ) {}

  /**
   * 打开文件会话。按主机的「文件传输方式」：
   * - 自动（默认）：先用 SFTP；SSH 能连上但 SFTP 子系统打不开时，用同样的用户名密码连 FTP（先试 TLS）；
   * - SFTP / FTP / FTPS：只用指定的方式。
   */
  async open(owner: number, hostId: string): Promise<{ sftpId: string; home: string; protocol: FileProtocol; notice?: string }> {
    const ft: FileTransfer = this.deps?.hosts.get(hostId)?.fileTransfer ?? { mode: 'AUTO', ftpPort: 21 };
    if (ft.mode === 'FTP' || ft.mode === 'FTPS') return this.openFtp(owner, hostId, ft);
    const conn = await this.pool.acquire(hostId, owner);
    if (ft.mode === 'SHELL') {
      if (!(await ShellRemote.probe(conn.client))) {
        this.pool.release(conn);
        throw new UserError('服务器不支持 SSH 命令通道传输文件（需要 stat -c 和 cat，例如 GNU coreutils 或 busybox）');
      }
      return this.openShell(owner, conn);
    }
    let browse: Remote;
    try {
      browse = await openSftp(conn.client);
    } catch (e) {
      const reason = (e as Error).message;
      if (ft.mode === 'AUTO') {
        // 1. 服务器没有 sftp-server（例如 exit code 127）：只要终端能用，就用 SSH 命令传文件
        if (await ShellRemote.probe(conn.client)) {
          const r = await this.openShell(owner, conn);
          return { ...r, notice: `服务器没有可用的 SFTP（${reason}），已自动改用 SSH 命令通道传输文件` };
        }
        this.pool.release(conn);
        // 2. 再试 FTP（同样的用户名密码）
        if (this.deps) {
          try {
            const r = await this.openFtp(owner, hostId, ft);
            return { ...r, notice: `服务器没有可用的 SFTP（${reason}），已自动改用 ${r.protocol === 'ftps' ? 'FTPS（加密）' : 'FTP（明文传输）'}` };
          } catch (fe) {
            throw new UserError(`无法打开 SFTP：${reason}（服务器可能没有启用 SFTP 子系统）；SSH 命令通道不可用（缺少 stat / cat）；改用 FTP 也失败：${describeFtpError(fe)}`);
          }
        }
      } else {
        this.pool.release(conn);
      }
      throw new UserError(`无法打开 SFTP：${reason}（服务器可能没有启用 SFTP 子系统，可以在主机设置里把文件传输方式改成「SSH 命令」或 FTP）`);
    }
    const home = await browse.realpath('.').catch(() => '/');
    const id = randomUUID();
    this.sessions.set(id, { id, owner, conn, ftp: null, shell: false, browse, transfer: null, transferRemote: null });
    return { sftpId: id, home, protocol: 'sftp' };
  }

  /** 临时打开一个文件通道（Agent 的文件工具用）：用完调用 close */
  async openTemp(owner: number, hostId: string): Promise<{ remote: RemoteFs; protocol: FileProtocol; close(): void }> {
    const r = await this.open(owner, hostId);
    const s = this.sessions.get(r.sftpId)!;
    return { remote: s.browse, protocol: r.protocol, close: () => this.close(owner, r.sftpId) };
  }

  /** SSH 命令通道：复用终端的 SSH 连接，用 stat / cat 等命令读写文件 */
  private async openShell(owner: number, conn: PooledConnection): Promise<{ sftpId: string; home: string; protocol: 'shell' }> {
    const browse = new ShellRemote(conn.client);
    const home = await browse.realpath('.').catch(() => '/');
    const id = randomUUID();
    this.sessions.set(id, { id, owner, conn, ftp: null, shell: true, browse, transfer: null, transferRemote: null });
    return { sftpId: id, home, protocol: 'shell' };
  }

  /** FTP / FTPS：用主机的用户名和密码登录；主机用密钥认证时询问 FTP 密码 */
  private async openFtp(owner: number, hostId: string, ft: FileTransfer): Promise<{ sftpId: string; home: string; protocol: 'ftp' | 'ftps' }> {
    if (!this.deps) throw new UserError('FTP 不可用');
    const info = this.deps.hosts.connectInfo(hostId);
    if (info.jumpHostIds.length || info.proxy) throw new UserError('经跳板机或代理连接的主机不支持 FTP（FTP 需要直接连到服务器）');
    const user = info.auth.username;
    let password = info.auth.method === 'PASSWORD' ? info.auth.password : undefined;
    if (!password) {
      const ans = await this.deps.prompts.ask(owner, {
        kind: 'password',
        hostName: info.host.name,
        username: user,
        message: `${ft.mode === 'AUTO' ? '服务器没有 SFTP，改用 FTP 登录' : 'FTP 登录'}（${info.host.address}:${ft.ftpPort}）`,
        forPassphrase: false,
        rememberable: false,
      });
      if (ans.kind !== 'password' || ans.value == null) throw new UserError('已取消');
      password = ans.value;
    }
    const opts: FtpOptions = { host: info.host.address, port: ft.ftpPort, user, password, tls: ft.mode === 'FTPS' ? 'required' : ft.mode === 'FTP' ? 'off' : 'try', timeoutMs: 15_000 };
    let browse: FtpRemote;
    try {
      browse = await FtpRemote.connect(opts);
    } catch (e) {
      throw new UserError(describeFtpError(e));
    }
    const home = await browse.realpath('.').catch(() => '/');
    const id = randomUUID();
    // 传输通道沿用这次实际协商的加密方式
    this.sessions.set(id, { id, owner, conn: null, ftp: { ...opts, tls: browse.secure ? 'required' : 'off' }, shell: false, browse, transfer: null, transferRemote: null });
    return { sftpId: id, home, protocol: browse.secure ? 'ftps' : 'ftp' };
  }

  close(owner: number, sftpId: string): void {
    const s = this.sessions.get(sftpId);
    if (!s || s.owner !== owner) {
      return;
    }
    this.sessions.delete(sftpId);
    s.browse.end();
    void s.transfer?.then((t) => t.end(), () => undefined);
    if (s.conn) this.pool.release(s.conn);
  }

  closeAllOf(owner: number): void {
    for (const s of [...this.sessions.values()]) {
      if (s.owner === owner) {
        this.close(owner, s.id);
      }
    }
  }

  async list(owner: number, sftpId: string, path: string): Promise<FileEntry[]> {
    const { browse } = this.require(owner, sftpId);
    const dir = normalizeRemote(path);
    const items = await browse.readdir(dir);
    const entries = await Promise.all(
      items.map(async ({ filename, attrs }): Promise<FileEntry> => {
        const full = posix.join(dir, filename);
        let type = fileTypeOf(attrs.mode);
        let size = attrs.size;
        if (type === 'link') {
          // 指向目录的链接按目录展示，方便进入；断开的链接保持 link
          const target = await browse.stat(full).catch(() => null);
          if (target) {
            type = fileTypeOf(target.mode) === 'dir' ? 'dir' : 'link';
            size = target.size;
          }
        }
        return { name: filename, path: full, type, size, mtime: attrs.mtime * 1000, perms: permsOf(attrs.mode), owner: attrs.owner, group: attrs.group };
      }),
    );
    return entries.sort(compareEntries);
  }

  async mkdir(owner: number, sftpId: string, path: string): Promise<void> {
    await this.require(owner, sftpId).browse.mkdir(normalizeRemote(path));
  }

  async rename(owner: number, sftpId: string, from: string, to: string): Promise<void> {
    const { browse } = this.require(owner, sftpId);
    const target = normalizeRemote(to);
    if (await browse.exists(target)) {
      throw new UserError('目标已存在');
    }
    await browse.rename(normalizeRemote(from), target);
  }

  async delete(owner: number, sftpId: string, paths: string[]): Promise<void> {
    const { browse } = this.require(owner, sftpId);
    for (const p of paths) {
      const path = normalizeRemote(p);
      if (path === '/') {
        throw new UserError('不能删除根目录');
      }
      await removeRemote(browse, path);
    }
  }

  /** 传输专用 channel（懒加载；已经关闭时重新打开） */
  transferChannel(owner: number, sftpId: string): Promise<RemoteFs> {
    const s = this.require(owner, sftpId);
    if (s.transferRemote?.closed) {
      s.transfer = null;
      s.transferRemote = null;
    }
    if (!s.transfer) {
      const p = (s.ftp ? FtpRemote.connect(s.ftp) : s.shell ? Promise.resolve(new ShellRemote(s.conn!.client)) : openSftp(s.conn!.client)).then((r: RemoteFs) => {
        if (s.transfer === p) s.transferRemote = r;
        return r;
      });
      p.catch(() => {
        if (s.transfer === p) s.transfer = null;
      });
      s.transfer = p;
    }
    return s.transfer;
  }

  /** 取消传输：关掉传输 channel，正在进行的读写会立即失败；下次传输时重新打开 */
  resetTransferChannel(owner: number, sftpId: string): void {
    const s = this.sessions.get(sftpId);
    if (!s || s.owner !== owner || !s.transfer) {
      return;
    }
    const old = s.transfer;
    s.transfer = null;
    s.transferRemote = null;
    void old.then((t) => t.abort(), () => undefined);
  }

  /**
   * 在服务器上打包（tar.gz）：同一目录下的若干文件 / 目录 → /tmp/itm-archive-XXXX/名称.tar.gz。
   * 需要 SSH 连接（FTP 不支持）。打包可能很久（大目录），超时 30 分钟。
   */
  async compress(owner: number, sftpId: string, paths: string[]): Promise<{ path: string; name: string; size: number }> {
    const s = this.require(owner, sftpId);
    if (!s.conn) throw new UserError('FTP 连接不能在服务器上压缩，请直接下载');
    const list = [...new Set(paths.map(normalizeRemote))];
    if (!list.length) throw new UserError('没有选择要压缩的文件');
    if (list.some((p) => p === '/')) throw new UserError('不能压缩根目录');
    const parent = posix.dirname(list[0]);
    if (list.some((p) => posix.dirname(p) !== parent)) throw new UserError('只能压缩同一个目录下的文件');
    const names = list.map((p) => posix.basename(p));
    const base = (names.length === 1 ? names[0] : `${posix.basename(parent) || 'files'}-${names.length}项`).replace(/[/\\\u0000-\u001f]/g, '_');
    const name = `${base}.tar.gz`;
    const tmp = `/tmp/itm-archive-${randomBytes(6).toString('hex')}`;
    const target = `${tmp}/${name}`;
    const cmd = `umask 077 && mkdir -p ${shQuote(tmp)} && cd ${shQuote(parent)} && tar -czf ${shQuote(target)} -- ${names.map(shQuote).join(' ')} && wc -c < ${shQuote(target)}`;
    const r = await execCommand(s.conn.client, cmd, { timeoutMs: 30 * 60_000 });
    if (r.code !== 0) {
      void execCommand(s.conn.client, `rm -rf ${shQuote(tmp)}`, { timeoutMs: 30_000 }).catch(() => undefined);
      throw new UserError(r.timedOut ? '压缩超时（超过 30 分钟）' : `压缩失败：${(r.stderr || r.stdout).trim().slice(0, 300) || `退出码 ${r.code}`}`);
    }
    return { path: target, name, size: Number(r.stdout.trim()) || 0 };
  }

  // ---------------------------------------------------------------- 文件面板（第十六轮，参考 iShell）

  /** 在服务器上执行命令（需要 SSH 连接；FTP 时报错） */
  private async run(owner: number, sftpId: string, cmd: string, what: string, timeoutMs = 10 * 60_000): Promise<string> {
    const s = this.require(owner, sftpId);
    if (!s.conn) throw new UserError(`FTP 连接不支持${what}，请改用 SFTP 或 SSH 命令通道`);
    const r = await execCommand(s.conn.client, cmd, { timeoutMs });
    if (r.code !== 0) throw new UserError(r.timedOut ? `${what}超时` : `${what}失败：${(r.stderr || r.stdout).trim().slice(0, 300) || `退出码 ${r.code}`}`);
    return r.stdout;
  }

  /** 目录里不冲突的名字：名称 (1).扩展名 */
  private async freeName(remote: RemoteFs, dir: string, name: string): Promise<string> {
    let target = posix.join(dir, name);
    // backup.tar.gz → backup (1).tar.gz（不是 backup.tar (1).gz）
    const m = /^(.+?)(\.tar\.(?:gz|bz2|xz|zst)|\.[^.]+)$/i.exec(name);
    const stem = m ? m[1] : name;
    const ext = m ? m[2] : '';
    for (let i = 1; await remote.exists(target); i++) target = posix.join(dir, `${stem} (${i})${ext}`);
    return target;
  }

  /** 新建空文件（已经有同名的文件或目录时报错） */
  async createFile(owner: number, sftpId: string, path: string): Promise<void> {
    const { browse } = this.require(owner, sftpId);
    const p = normalizeRemote(path);
    if (await browse.exists(p)) throw new UserError('已经有同名的文件或目录');
    await new Promise<void>((resolve, reject) => {
      const w = browse.createWriteStream(p, { flags: 'w' });
      w.once('error', reject);
      w.once('close', () => resolve());
      w.end();
    });
  }

  /** 修改权限：mode 是权限位（例如 0o755）；目录可以递归（需要 SSH） */
  async chmod(owner: number, sftpId: string, paths: string[], mode: number, recursive: boolean): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw new UserError('权限不正确');
    const list = [...new Set((paths ?? []).map(normalizeRemote))].filter((x) => x !== '/');
    if (!list.length) throw new UserError('没有选择文件');
    // 路径都是绝对路径（以 / 开头），不会被当成选项；BSD 的 chmod 不认模式后面的 --
    await this.run(owner, sftpId, `chmod ${recursive ? '-R ' : ''}${mode.toString(8).padStart(3, '0')} ${list.map(shQuote).join(' ')}`, '修改权限', 120_000);
  }

  /** 在服务器上复制到目标目录（cp -a）；目标里已经有同名的就改名为「名称 (1)」 */
  async copy(owner: number, sftpId: string, paths: string[], destDir: string): Promise<{ copied: string[] }> {
    const { browse } = this.require(owner, sftpId);
    const dest = normalizeRemote(destDir);
    const st = await browse.exists(dest);
    if (!st || fileTypeOf(st.mode) !== 'dir') throw new UserError(`目标目录不存在：${dest}`);
    const copied: string[] = [];
    for (const src of [...new Set((paths ?? []).map(normalizeRemote))]) {
      if (dest === src || dest.startsWith(`${src}/`)) throw new UserError(`不能把「${posix.basename(src)}」复制到它自己里面`);
      const target = await this.freeName(browse, dest, posix.basename(src));
      await this.run(owner, sftpId, `cp -a -- ${shQuote(src)} ${shQuote(target)}`, '复制');
      copied.push(target);
    }
    return { copied };
  }

  /** 移动到目标目录（重命名）；目标里已经有同名的时报错，不覆盖 */
  async move(owner: number, sftpId: string, paths: string[], destDir: string): Promise<{ moved: string[] }> {
    const { browse } = this.require(owner, sftpId);
    const dest = normalizeRemote(destDir);
    const st = await browse.exists(dest);
    if (!st || fileTypeOf(st.mode) !== 'dir') throw new UserError(`目标目录不存在：${dest}`);
    const moved: string[] = [];
    for (const src of [...new Set((paths ?? []).map(normalizeRemote))]) {
      if (posix.dirname(src) === dest) continue;
      if (dest === src || dest.startsWith(`${src}/`)) throw new UserError(`不能把「${posix.basename(src)}」移动到它自己里面`);
      const target = posix.join(dest, posix.basename(src));
      if (await browse.exists(target)) throw new UserError(`目标目录里已经有「${posix.basename(src)}」`);
      await browse.rename(src, target);
      moved.push(target);
    }
    return { moved };
  }

  /** 压缩到同一个目录：tar.gz 或 zip（需要服务器上有 tar / zip） */
  async archive(owner: number, sftpId: string, paths: string[], name: string, format: 'tar.gz' | 'zip'): Promise<{ path: string }> {
    const list = [...new Set((paths ?? []).map(normalizeRemote))];
    if (!list.length) throw new UserError('没有选择要压缩的文件');
    const parent = posix.dirname(list[0]);
    if (list.some((p) => posix.dirname(p) !== parent)) throw new UserError('只能压缩同一个目录下的文件');
    const ext = format === 'zip' ? '.zip' : '.tar.gz';
    const base = String(name ?? '').trim().replace(/[/\\\u0000-\u001f]/g, '_').replace(/\.(zip|tar\.gz|tgz)$/i, '') || 'archive';
    const { browse } = this.require(owner, sftpId);
    const target = await this.freeName(browse, parent, `${base}${ext}`);
    const names = list.map((p) => shQuote(posix.basename(p))).join(' ');
    // zip 不一定认 --：用 ./名称 防止以 - 开头的文件名被当成选项（zip 会去掉开头的 ./）
    const zipNames = list.map((p) => shQuote(`./${posix.basename(p)}`)).join(' ');
    const cmd =
      format === 'zip'
        ? `command -v zip >/dev/null 2>&1 || { echo '服务器上没有 zip 命令，请改用 tar.gz' >&2; exit 127; }; cd ${shQuote(parent)} && zip -qr ${shQuote(target)} ${zipNames}`
        : `cd ${shQuote(parent)} && tar -czf ${shQuote(target)} -- ${names}`;
    await this.run(owner, sftpId, cmd, '压缩', 30 * 60_000);
    return { path: target };
  }

  /**
   * 拖到本机（第十六轮）：Electron 的 startDrag 只能拖本机已经存在的文件，所以先把选中的文件 / 目录下载到 dir。
   * 总大小超过 limit 时不下载，返回 tooLarge（界面改为普通下载）。返回顶层的本机路径。
   */
  async downloadForDrag(owner: number, sftpId: string, paths: string[], dir: string, limit: number): Promise<{ files: string[] } | { tooLarge: true; total: number }> {
    const { browse } = this.require(owner, sftpId);
    const list = [...new Set((paths ?? []).map(normalizeRemote))];
    if (!list.length) throw new UserError('没有选择文件');
    type Item = { remote: string; rel: string; dir: boolean; size: number };
    const items: Item[] = [];
    let total = 0;
    const walk = async (remote: string, rel: string, depth: number): Promise<void> => {
      const st = await browse.lstat(remote);
      const type = fileTypeOf(st.mode);
      if (type === 'link') return;
      if (type === 'dir') {
        items.push({ remote, rel, dir: true, size: 0 });
        if (depth > 20) return;
        for (const { filename } of await browse.readdir(remote)) {
          if (filename === '.' || filename === '..') continue;
          await walk(posix.join(remote, filename), `${rel}/${filename}`, depth + 1);
          if (total > limit) return;
        }
        return;
      }
      total += st.size;
      items.push({ remote, rel, dir: false, size: st.size });
    };
    for (const p of list) {
      await walk(p, posix.basename(p) || 'root', 0);
      if (total > limit) return { tooLarge: true, total };
    }
    const channel = await this.transferChannel(owner, sftpId);
    for (const it of items) {
      const local = joinLocal(dir, ...it.rel.split('/'));
      if (it.dir) {
        await mkdirLocal(local, { recursive: true });
        continue;
      }
      await mkdirLocal(dirnameLocal(local), { recursive: true });
      await pipeline(channel.createReadStream(it.remote), createWriteStream(local));
    }
    return { files: list.map((p) => joinLocal(dir, posix.basename(p) || 'root')) };
  }

  /** 删除 compress 打的临时压缩包（只允许 /tmp/itm-archive-*） */
  async removeArchive(owner: number, sftpId: string, path: string): Promise<void> {
    const p = normalizeRemote(path);
    const m = /^(\/tmp\/itm-archive-[0-9a-f]{12})\/[^/]+$/.exec(p);
    const s = this.sessions.get(sftpId);
    if (!m || !s || s.owner !== owner || !s.conn || s.conn.closed) return;
    await execCommand(s.conn.client, `rm -rf ${shQuote(m[1])}`, { timeoutMs: 30_000 }).catch(() => undefined);
  }

  has(owner: number, sftpId: string): boolean {
    return this.sessions.get(sftpId)?.owner === owner;
  }

  private require(owner: number, sftpId: string): SftpSession {
    const s = this.sessions.get(sftpId);
    if (!s || s.owner !== owner) {
      throw new UserError('SFTP 会话已关闭，请重新打开');
    }
    if (s.conn?.closed) {
      throw new UserError(`连接已断开${s.conn.error ? `：${s.conn.error}` : ''}，请重新打开`);
    }
    if (!s.conn && s.browse.closed) {
      throw new UserError('FTP 连接已断开，请重新打开');
    }
    return s;
  }
}

/** 递归删除；符号链接只删链接本身，不跟进 */
async function removeRemote(remote: RemoteFs, path: string): Promise<void> {
  const st = await remote.lstat(path);
  if (fileTypeOf(st.mode) === 'dir') {
    for (const { filename } of await remote.readdir(path)) {
      await removeRemote(remote, posix.join(path, filename));
    }
    await remote.rmdir(path);
  } else {
    await remote.unlink(path);
  }
}

export function normalizeRemote(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new UserError('远端路径必须是绝对路径');
  }
  return posix.normalize(path);
}
