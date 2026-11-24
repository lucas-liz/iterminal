/** 执行 .sh 脚本（文件面板 / 终端右键「执行」，第三十三轮）：生成发到终端的命令 */

/** 没有执行权限时：先 chmod u+x 再执行，或者用 bash 解释执行（不改权限） */
export type ShFix = 'none' | 'chmod' | 'bash';

/** 是不是 .sh 脚本的路径（终端里选中的文字：不含空白和 shell 特殊字符） */
export function isShPath(text: string): boolean {
  const t = text.trim();
  return t.length <= 1024 && /\.sh$/i.test(t) && /^[^\s'"`;|&<>$()*?{}[\]\\]+$/.test(t);
}

/** 按需加单引号：只含安全字符时原样输出（命令好读） */
export function shArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** 路径加引号；~/ 开头的保留 ~ 让 shell 展开 */
function shPath(p: string): string {
  return p.startsWith('~/') ? `~/${shArg(p.slice(2))}` : shArg(p);
}

/** 绝对路径（或 ~/ 开头）；相对路径在知道当前目录时拼成绝对路径，否则返回 null */
export function absoluteOf(path: string, cwd: string | null): string | null {
  const p = path.trim();
  if (p.startsWith('/') || p.startsWith('~/')) return p;
  if (!cwd) return null;
  const parts = `${cwd.replace(/\/+$/, '')}/${p}`.split('/');
  const out: string[] = [];
  for (const s of parts) {
    if (s === '' || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return `/${out.join('/')}`;
}

function split(p: string): { dir: string; name: string } {
  const t = p.replace(/\/+$/, '');
  const i = t.lastIndexOf('/');
  if (i < 0) return { dir: '.', name: t };
  return { dir: i === 0 ? '/' : t.slice(0, i), name: t.slice(i + 1) };
}

/**
 * 两种执行方式的命令：
 * - inDir：到脚本所在目录执行（cd 目录 && ./脚本）——脚本里用相对路径时需要；
 * - direct：在当前目录直接用完整路径执行。
 * 相对路径且不知道当前目录时按相对路径生成（在终端当前目录下执行）。
 */
export function shCommands(path: string, cwd: string | null, fix: ShFix = 'none'): { inDir: string; direct: string } {
  const abs = absoluteOf(path, cwd);
  const p = abs ?? path.trim();
  const { dir, name } = split(p);
  const local = `./${shArg(name)}`;
  const run = (target: string): string => (fix === 'bash' ? `bash ${target}` : fix === 'chmod' ? `chmod u+x ${target} && ${target}` : target);
  const inDir = dir === '.' ? run(local) : `cd ${shPath(dir)} && ${run(local)}`;
  const target = p.includes('/') ? shPath(p) : local;
  return { inDir, direct: run(target) };
}
