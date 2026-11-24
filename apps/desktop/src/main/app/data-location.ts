import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

/**
 * 自定义本地数据目录（设置 → 存储位置）。
 *
 * 默认数据目录（Electron 的 userData）里放一个 data-location.json 指向实际的目录。更换目录时先写入
 * 「待迁移」，重启后在打开任何数据之前把整个数据目录复制过去，再切换；原目录的数据保留作为备份。
 */
const FILE = 'data-location.json';
/** 不复制的文件：指向文件本身、Chromium 的单实例锁和缓存 */
const SKIP = new Set([FILE, 'SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile', 'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage']);

interface LocationFile {
  dir: string;
  /** 待迁移：重启时从 from 复制到 dir */
  move?: { from: string };
  /** 上一次迁移失败的原因 */
  error?: string;
}

function read(defaultDir: string): LocationFile | null {
  try {
    const v = JSON.parse(readFileSync(join(defaultDir, FILE), 'utf8')) as LocationFile;
    return v && typeof v.dir === 'string' && isAbsolute(v.dir) ? v : null;
  } catch {
    return null;
  }
}

function write(defaultDir: string, v: LocationFile | null): void {
  const f = join(defaultDir, FILE);
  if (!v) {
    if (existsSync(f)) unlinkSync(f);
    return;
  }
  mkdirSync(defaultDir, { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 2));
}

/**
 * 启动时调用（app ready 之前）：完成待迁移的复制，返回实际的数据目录（没有自定义时返回 defaultDir）。
 * 迁移失败时继续使用原目录，并记下错误原因（设置页显示）。
 */
export function applyDataLocation(defaultDir: string): string {
  const loc = read(defaultDir);
  if (!loc) return defaultDir;
  if (loc.move) {
    const from = loc.move.from;
    try {
      mkdirSync(loc.dir, { recursive: true });
      for (const name of readdirSync(from)) {
        if (SKIP.has(name)) continue;
        cpSync(join(from, name), join(loc.dir, name), { recursive: true, force: true, errorOnExist: false });
      }
      write(defaultDir, resolve(loc.dir) === resolve(defaultDir) ? null : { dir: loc.dir });
    } catch (e) {
      // 复制失败：回到原目录
      write(defaultDir, resolve(from) === resolve(defaultDir) ? { dir: defaultDir, error: (e as Error).message } : { dir: from, error: (e as Error).message });
      return from;
    }
    return loc.dir;
  }
  return existsSync(loc.dir) ? loc.dir : defaultDir;
}

export function locationError(defaultDir: string): string | null {
  return read(defaultDir)?.error ?? null;
}

/**
 * 更换数据目录：检查目标，写入待迁移，由调用方重启应用。target 为 null 表示回到默认目录。
 */
export function scheduleDataMove(defaultDir: string, currentDir: string, target: string | null): string {
  const dir = target ? resolve(target) : defaultDir;
  if (!isAbsolute(dir)) throw new Error('请选择一个绝对路径');
  if (resolve(dir) === resolve(currentDir)) throw new Error('和当前的数据目录相同');
  const rel = relative(currentDir, dir);
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('新目录不能在当前数据目录里面');
  const back = relative(dir, currentDir);
  if (!back.startsWith('..') && !isAbsolute(back) && resolve(dir) !== resolve(defaultDir)) throw new Error('新目录不能包含当前的数据目录');
  // 自定义目录必须是空目录（或者不存在），避免覆盖别的文件；回到默认目录时允许覆盖原来留下的备份
  if (target && existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error('目标不是目录');
    const rest = readdirSync(dir).filter((n) => n !== '.DS_Store');
    if (rest.length) throw new Error('请选择一个空目录（可以在里面新建一个文件夹）');
  }
  mkdirSync(dir, { recursive: true });
  // 先试一下能不能写
  const probe = join(dir, '.itm-write-test');
  writeFileSync(probe, 'ok');
  rmSync(probe, { force: true });
  write(defaultDir, { dir, move: { from: currentDir } });
  return dir;
}

/** 目录占用的空间（字节）；跳过读不到的文件，最多统计 20 万个文件 */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let count = 0;
  const walk = async (d: string): Promise<void> => {
    let items: import('node:fs').Dirent[];
    try {
      items = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      if (++count > 200_000) return;
      const p = join(d, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.isFile()) {
        try {
          total += (await stat(p)).size;
        } catch {
          // 文件被删除等
        }
      }
    }
  };
  if (dir && existsSync(dir)) await walk(dir);
  return total;
}
