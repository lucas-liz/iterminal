import { lstat, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import type { FileEntry, FileType } from '@itm/protocol';
import { UserError } from '../../util/errors';
import { compareEntries, permsOf } from './file-mode';

/** 本地文件浏览（SFTP 双栏的左侧）。删除一律进废纸篓 / 回收站。 */
export class LocalFs {
  constructor(
    private readonly trashItem: (path: string) => Promise<void>,
    private readonly revealItem: (path: string) => void,
  ) {}

  home(): string {
    return homedir();
  }

  async list(path: string): Promise<FileEntry[]> {
    const dir = normalizeLocal(path);
    const dirents = await readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.map(async (d): Promise<FileEntry | null> => {
        const full = join(dir, d.name);
        try {
          const ls = await lstat(full);
          let type: FileType = ls.isDirectory() ? 'dir' : ls.isFile() ? 'file' : ls.isSymbolicLink() ? 'link' : 'other';
          let size = ls.size;
          if (type === 'link') {
            const target = await stat(full).catch(() => null);
            if (target) {
              type = target.isDirectory() ? 'dir' : 'link';
              size = target.size;
            }
          }
          return {
            name: d.name,
            path: full,
            type,
            size,
            mtime: ls.mtimeMs,
            perms: process.platform === 'win32' ? '' : permsOf(ls.mode),
          };
        } catch {
          return null; // 没有权限读取属性的条目直接跳过
        }
      }),
    );
    return entries.filter((e): e is FileEntry => e !== null).sort(compareEntries);
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(normalizeLocal(path));
  }

  async rename(from: string, to: string): Promise<void> {
    const target = normalizeLocal(to);
    if (await lstat(target).catch(() => null)) {
      throw new UserError('目标已存在');
    }
    await rename(normalizeLocal(from), target);
  }

  async trash(paths: string[]): Promise<void> {
    for (const p of paths) {
      await this.trashItem(normalizeLocal(p));
    }
  }

  reveal(path: string): void {
    this.revealItem(normalizeLocal(path));
  }
}

export function normalizeLocal(path: string): string {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new UserError('本地路径必须是绝对路径');
  }
  return normalize(path);
}
