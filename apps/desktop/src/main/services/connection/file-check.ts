import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { SshPool } from './ssh-pool';
import { execCommand } from './exec';
import { shQuote } from '../../util/shell';

export interface ExecCheck {
  exists: boolean;
  isFile: boolean;
  /** 当前登录用户有执行权限 */
  executable: boolean;
}

/** 远端检查脚本的输出：N 不存在 / D 不是普通文件 / X 可执行 / F 没有执行权限 */
export function parseExecCheck(out: string): ExecCheck {
  const c = out.trim().slice(-1);
  return { exists: c !== 'N' && c !== '', isFile: c === 'X' || c === 'F', executable: c === 'X' };
}

/** 远端的检查命令；~/ 开头的路径按登录用户的 HOME 展开 */
export function execCheckCommand(path: string): string {
  const p = path.startsWith('~/') ? `"$HOME"/${shQuote(path.slice(2))}` : shQuote(path);
  return `sh -c ${shQuote(`p=${p}; [ -e "$p" ] || { echo N; exit 0; }; [ -f "$p" ] || { echo D; exit 0; }; [ -x "$p" ] && echo X || echo F`)}`;
}

/**
 * 执行脚本前检查（文件面板 / 终端右键「执行」）：文件是否存在、当前用户有没有执行权限。
 * 远端复用终端所在的 SSH 连接；hostId 为 null 时检查本机文件。
 */
export async function checkExecutable(pool: Pick<SshPool, 'acquire' | 'release'>, owner: number, hostId: string | null, path: string): Promise<ExecCheck> {
  if (!hostId) {
    const p = path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path;
    try {
      const st = await stat(p);
      if (!st.isFile()) return { exists: true, isFile: false, executable: false };
      const ok = await access(p, constants.X_OK).then(
        () => true,
        () => false,
      );
      return { exists: true, isFile: true, executable: ok };
    } catch {
      return { exists: false, isFile: false, executable: false };
    }
  }
  const conn = await pool.acquire(hostId, owner);
  try {
    const r = await execCommand(conn.client, execCheckCommand(path), { timeoutMs: 10_000, maxBytes: 1024, closeStdin: true });
    if (r.timedOut) throw new Error('检查执行权限超时');
    return parseExecCheck(r.stdout);
  } finally {
    pool.release(conn);
  }
}
