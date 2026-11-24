import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import type { RemoteEditState } from '@itm/protocol';
import { UserError } from '../../util/errors';
import type { Emit } from '../connection/emitter';
import { fileTypeOf } from './file-mode';
import { normalizeRemote, type SftpService } from './sftp-service';
import type { RemoteFs } from './remote-fs';

/** 内置编辑器能打开的最大文件 */
const MAX_TEXT = 2 * 1024 * 1024;
/** 外部编辑器保存后，等这么久没有新的修改再回传（编辑器保存时可能连续写好几次） */
const DEBOUNCE_MS = 400;

interface Edit {
  state: RemoteEditState;
  owner: number;
  /** 远端在我们最近一次下载 / 回传后的修改时间和大小（毫秒） */
  remoteMtime: number;
  remoteSize: number;
  mode: number | undefined;
  /** 最近一次和远端一致的本机内容的哈希 */
  hash: string;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
  busy: Promise<void>;
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export function readRemote(remote: RemoteFs, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const s = remote.createReadStream(path);
    s.on('data', (c: Buffer) => chunks.push(c));
    s.on('error', reject);
    s.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

export function writeRemote(remote: RemoteFs, path: string, data: Buffer, mode?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = remote.createWriteStream(path, { flags: 'w', ...(mode !== undefined ? { mode } : {}) });
    s.on('error', reject);
    s.on('close', () => resolve());
    s.end(data);
  });
}

/**
 * 在线编辑远端文件（文档一 6.3）：
 * - 内置编辑器：读出文本，保存时先比较远端的修改时间，别人改过就不写，交给用户决定；
 * - 系统默认程序：下载到临时目录打开，监视保存并自动回传；远端在这期间被改过时进入冲突状态，由用户选择覆盖或放弃。
 * 临时文件在结束编辑、关闭 SFTP 会话时删除。
 */
export class RemoteEditService {
  private readonly edits = new Map<string, Edit>();

  constructor(
    private readonly sftp: SftpService,
    private readonly emit: Emit,
    private readonly openPath: (path: string) => Promise<unknown> | void,
    private readonly tmpRoot: string = join(tmpdir(), 'iterminal-edit'),
    private readonly now: () => number = Date.now,
  ) {}

  async readText(owner: number, sftpId: string, path: string): Promise<{ content: string; mtime: number; size: number }> {
    const remote = await this.sftp.transferChannel(owner, sftpId);
    const p = normalizeRemote(path);
    const st = await remote.stat(p);
    if (fileTypeOf(st.mode) !== 'file') throw new UserError('只能编辑文件');
    if (st.size > MAX_TEXT) throw new UserError('文件超过 2MB，请下载后编辑，或用「用默认程序编辑」');
    const buf = await readRemote(remote, p);
    if (buf.subarray(0, 8192).includes(0)) throw new UserError('这不是文本文件');
    return { content: buf.toString('utf8'), mtime: st.mtime * 1000, size: st.size };
  }

  async writeText(owner: number, sftpId: string, path: string, content: string, expectMtime: number | null): Promise<{ ok: boolean; mtime: number }> {
    const remote = await this.sftp.transferChannel(owner, sftpId);
    const p = normalizeRemote(path);
    const st = await remote.exists(p);
    if (st && expectMtime !== null && st.mtime * 1000 !== expectMtime) return { ok: false, mtime: st.mtime * 1000 };
    await writeRemote(remote, p, Buffer.from(content, 'utf8'), st ? st.mode & 0o777 : undefined);
    const after = await remote.stat(p);
    return { ok: true, mtime: after.mtime * 1000 };
  }

  async editExternal(owner: number, sftpId: string, path: string): Promise<RemoteEditState> {
    const p = normalizeRemote(path);
    const dup = [...this.edits.values()].find((e) => e.owner === owner && e.state.sftpId === sftpId && e.state.path === p);
    if (dup) {
      await this.openPath(dup.state.localPath);
      return { ...dup.state };
    }
    const remote = await this.sftp.transferChannel(owner, sftpId);
    const st = await remote.stat(p);
    if (fileTypeOf(st.mode) !== 'file') throw new UserError('只能编辑文件');
    const buf = await readRemote(remote, p);
    const editId = randomUUID();
    const dir = join(this.tmpRoot, editId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const localPath = join(dir, posix.basename(p));
    await writeFile(localPath, buf, { mode: 0o600 });
    const edit: Edit = {
      owner,
      state: { editId, sftpId, path: p, localPath, state: 'watching', message: null, savedAt: null },
      remoteMtime: st.mtime * 1000,
      remoteSize: st.size,
      mode: st.mode & 0o777,
      hash: sha(buf),
      watcher: null,
      timer: null,
      busy: Promise.resolve(),
    };
    this.edits.set(editId, edit);
    // 监视目录而不是文件：很多编辑器保存时是「写新文件再改名」，监视文件会丢事件
    edit.watcher = watch(dir, (_ev, name) => {
      if (name && name.toString() !== posix.basename(p)) return;
      if (edit.timer) clearTimeout(edit.timer);
      edit.timer = setTimeout(() => {
        edit.timer = null;
        edit.busy = edit.busy.then(() => this.sync(edit, false));
      }, DEBOUNCE_MS);
    });
    edit.watcher.on('error', () => undefined);
    this.update(edit);
    await this.openPath(localPath);
    return { ...edit.state };
  }

  list(owner: number, sftpId: string | null): RemoteEditState[] {
    return [...this.edits.values()].filter((e) => e.owner === owner && (!sftpId || e.state.sftpId === sftpId)).map((e) => ({ ...e.state }));
  }

  /** 冲突时：overwrite = 用本机内容覆盖远端；discard = 放弃本机修改，重新下载远端的内容 */
  async resolve(owner: number, editId: string, action: 'overwrite' | 'discard'): Promise<void> {
    const edit = this.own(owner, editId);
    if (action === 'overwrite') {
      edit.busy = edit.busy.then(() => this.sync(edit, true));
      return edit.busy;
    }
    edit.busy = edit.busy.then(async () => {
      try {
        const remote = await this.sftp.transferChannel(edit.owner, edit.state.sftpId);
        const st = await remote.stat(edit.state.path);
        const buf = await readRemote(remote, edit.state.path);
        edit.hash = sha(buf);
        edit.remoteMtime = st.mtime * 1000;
        edit.remoteSize = st.size;
        await writeFile(edit.state.localPath, buf);
        this.update(edit, 'watching', '已重新下载远端的内容');
      } catch (e) {
        this.update(edit, 'error', (e as Error).message);
      }
    });
    return edit.busy;
  }

  stop(owner: number, editId: string): void {
    this.finish(this.own(owner, editId));
  }

  stopSftp(sftpId: string): void {
    for (const e of [...this.edits.values()]) if (e.state.sftpId === sftpId) this.finish(e);
  }

  stopAllOf(owner: number): void {
    for (const e of [...this.edits.values()]) if (e.owner === owner) this.finish(e);
  }

  stopAll(): void {
    for (const e of [...this.edits.values()]) this.finish(e);
  }

  /** 本机文件变了：和远端比较后回传 */
  private async sync(edit: Edit, force: boolean): Promise<void> {
    if (!this.edits.has(edit.state.editId)) return;
    let buf: Buffer;
    try {
      buf = await readFile(edit.state.localPath);
    } catch {
      return; // 编辑器保存过程中文件可能暂时不存在
    }
    const h = sha(buf);
    if (h === edit.hash && !force) return;
    try {
      const remote = await this.sftp.transferChannel(edit.owner, edit.state.sftpId);
      const st = await remote.exists(edit.state.path);
      if (!force && st && (st.mtime * 1000 !== edit.remoteMtime || st.size !== edit.remoteSize)) {
        this.update(edit, 'conflict', '远端文件在你编辑期间被其他人修改过');
        return;
      }
      this.update(edit, 'uploading');
      await writeRemote(remote, edit.state.path, buf, edit.mode);
      const after = await remote.stat(edit.state.path);
      edit.hash = h;
      edit.remoteMtime = after.mtime * 1000;
      edit.remoteSize = after.size;
      edit.state.savedAt = this.now();
      this.update(edit, 'uploaded');
    } catch (e) {
      this.update(edit, 'error', `回传失败：${(e as Error).message}`);
    }
  }

  private finish(edit: Edit): void {
    if (!this.edits.delete(edit.state.editId)) return;
    if (edit.timer) clearTimeout(edit.timer);
    edit.watcher?.close();
    void rm(join(this.tmpRoot, edit.state.editId), { recursive: true, force: true });
    this.update(edit, 'stopped');
  }

  private own(owner: number, editId: string): Edit {
    const e = this.edits.get(editId);
    if (!e || e.owner !== owner) throw new UserError('编辑已结束');
    return e;
  }

  private update(edit: Edit, state?: RemoteEditState['state'], message: string | null = null): void {
    if (state) {
      edit.state.state = state;
      edit.state.message = message;
    }
    this.emit(edit.owner, 'sftp.edit', { ...edit.state });
  }
}
