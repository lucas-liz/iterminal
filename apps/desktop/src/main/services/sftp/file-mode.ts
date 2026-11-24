import type { FileType } from '@itm/protocol';

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export function fileTypeOf(mode: number): FileType {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir';
    case S_IFREG:
      return 'file';
    case S_IFLNK:
      return 'link';
    default:
      return 'other';
  }
}

/** 0o100644 → -rw-r--r--；setuid / setgid / sticky 位和 ls 一样显示为 s / S、t / T（例如 /tmp 是 drwxrwxrwt） */
export function permsOf(mode: number): string {
  const t = fileTypeOf(mode);
  const head = t === 'dir' ? 'd' : t === 'link' ? 'l' : '-';
  const bits = ['r', 'w', 'x'];
  const chars: string[] = [];
  for (let i = 8; i >= 0; i--) {
    chars.push(mode & (1 << i) ? bits[(8 - i) % 3] : '-');
  }
  const special = (idx: number, flag: number, on: string): void => {
    if (mode & flag) chars[idx] = chars[idx] === 'x' ? on : on.toUpperCase();
  };
  special(2, 0o4000, 's');
  special(5, 0o2000, 's');
  special(8, 0o1000, 't');
  return head + chars.join('');
}

/**
 * SFTP 列目录时的所有者 / 组（第十六轮）：从 longname（ls -l 格式，例如
 * `-rw-r--r--    1 root     root         1234 Oct 17 14:03 app.log`）里取名字；
 * 没有 longname 或格式不对（部分服务器只给文件名）时用 uid / gid。
 */
export function ownerOf(longname: string | undefined, attrs: { uid?: number; gid?: number }): { owner?: string; group?: string } {
  const f = (longname ?? '').trim().split(/\s+/);
  if (f.length >= 8 && /^[-dlbcpsDw?][-rwxsStTlL+.@]{9}/.test(f[0]) && /^\d+$/.test(f[1])) return { owner: f[2], group: f[3] };
  return {
    owner: Number.isInteger(attrs.uid) ? String(attrs.uid) : undefined,
    group: Number.isInteger(attrs.gid) ? String(attrs.gid) : undefined,
  };
}

/** 目录排在前面，其余按名称（忽略大小写、自然数排序） */
export function compareEntries(a: { name: string; type: FileType }, b: { name: string; type: FileType }): number {
  const ad = a.type === 'dir' ? 0 : 1;
  const bd = b.type === 'dir' ? 0 : 1;
  return ad - bd || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}
