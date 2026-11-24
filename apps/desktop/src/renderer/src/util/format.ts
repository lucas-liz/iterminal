export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「3 分钟前」「昨天」这类相对时间 */
export function formatRelative(ms: number | null): string {
  if (!ms) return '从未连接';
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return formatTime(ms).slice(0, 10);
}

/** 远端路径拼接 / 取上级（POSIX） */
export function joinRemote(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}
export function parentRemote(path: string): string {
  if (path === '/') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const i = trimmed.lastIndexOf('/');
  return i <= 0 ? '/' : trimmed.slice(0, i);
}

/** 「user@host:~$ ls -la」这样带提示符的单行命令：去掉提示符 */
export function stripPrompt(text: string): string {
  if (text.includes('\n')) return text;
  // 提示符：user@host[:目录]、[user@host 目录]、~ 或 / 开头的目录，或者没有（行首直接是 $ / #）
  const m = /^(?:\S+@\S+?(?::\S*)?|\[[^\]]+\]|~[\w./-]*|\/[\w./-]*)?\s*[$#%>]\s+(.+)$/.exec(text);
  return m ? m[1] : text;
}
