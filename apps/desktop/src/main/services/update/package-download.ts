import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { UserError } from '../../util/errors';

/** latest*.yml 里的一个文件（url 相对更新源） */
export interface ReleaseFile {
  url: string;
  sha512?: string;
  size?: number;
}

export interface DownloadProgress {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

type FetchLike = (url: string) => Promise<Response>;

/** 文件的完整地址：和 electron-updater generic provider 一样，相对「更新源/」 */
export function fileUrl(feed: string, url: string): string {
  return new URL(url, feed.endsWith('/') ? feed : `${feed}/`).href;
}

/** 文件名（url 的最后一段，解码后） */
export function fileNameOf(url: string): string {
  const last = url.split(/[?#]/)[0].split('/').pop() ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * 按扩展名的优先顺序挑一个文件。和 electron-updater 的 MacUpdater 一样：列表里有带 arm64 的文件时，
 * 按当前架构只看 arm64 的或者不带 arm64 的。
 */
export function pickFile(files: ReleaseFile[], exts: string[], arch = process.arch): ReleaseFile | null {
  const isArm = (f: ReleaseFile): boolean => /arm64/i.test(f.url);
  const list = files.some(isArm) ? files.filter((f) => isArm(f) === (arch === 'arm64')) : files;
  for (const ext of exts) {
    const hit = list.find((f) => fileNameOf(f.url).toLowerCase().endsWith(ext.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/**
 * 下载文件到 dest：先写 dest.part，边下边算 SHA-512（base64，和 latest*.yml 一样），校验通过后改名。
 * 校验不通过、大小不对时删掉临时文件并报错。
 */
export async function downloadFile(o: {
  url: string;
  dest: string;
  sha512?: string;
  size?: number;
  fetch: FetchLike;
  onProgress?: (p: DownloadProgress) => void;
  now?: () => number;
}): Promise<void> {
  const now = o.now ?? Date.now;
  const res = await o.fetch(o.url);
  if (!res.ok || !res.body) throw new UserError(`下载安装包失败（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || o.size || 0;
  mkdirSync(dirname(o.dest), { recursive: true });
  const part = `${o.dest}.part`;
  const out = createWriteStream(part);
  const hash = createHash('sha512');
  const started = now();
  let transferred = 0;
  let lastEmit = 0;
  const emit = (force: boolean): void => {
    const t = now();
    if (!o.onProgress || (!force && t - lastEmit < 200)) return;
    lastEmit = t;
    const secs = Math.max((t - started) / 1000, 0.001);
    o.onProgress({ percent: total ? Math.min((transferred / total) * 100, 100) : 0, bytesPerSecond: Math.round(transferred / secs), transferred, total });
  };
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      transferred += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
      emit(false);
    }
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
    emit(true);
    if (o.size && transferred !== o.size) throw new UserError(`安装包大小不对（${transferred} / ${o.size} 字节），请重试`);
    if (o.sha512 && hash.digest('base64') !== o.sha512) throw new UserError('下载的安装包校验失败（SHA-512 不一致），请重试');
    renameSync(part, o.dest);
  } catch (e) {
    out.destroy();
    rmSync(part, { force: true });
    throw e;
  }
}
