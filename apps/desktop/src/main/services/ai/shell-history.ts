import { open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SshPool } from '../connection/ssh-pool';
import { execCommand } from '../connection/exec';
import { shQuote } from '../../util/shell';

/** 每个历史文件只读最后这么多行 */
const TAIL_LINES = 5000;
/** 本机文件只读最后这么多字节 */
const LOCAL_TAIL_BYTES = 2 * 1024 * 1024;
/** 读到的结果缓存这么久（打开面板、输入时都用缓存，过期后再读） */
const TTL_MS = 30_000;
const MAX_ENTRIES = 8000;
const MAX_COMMAND = 500;

export interface ShellHistory {
  /** 去重后的命令，最近的在前 */
  entries: string[];
  /** 历史文件里最新的修改时间（毫秒）；bash 退出时才写历史，比它新的 iTerminal 记录排在前面 */
  mtime: number | null;
  /** 读到的历史文件 */
  files: string[];
  /** 读取失败的原因（这时 entries 为空，只用 iTerminal 自己的记录） */
  error?: string;
  at: number;
}

type Kind = 'bash' | 'zsh' | 'fish' | 'ps';

function kindOf(path: string): Kind {
  if (/zsh_history$|\.zhistory$/.test(path)) return 'zsh';
  if (/fish_history$/.test(path)) return 'fish';
  if (/ConsoleHost_history\.txt$/i.test(path)) return 'ps';
  return 'bash';
}

/** zsh 写历史时把高位字节 metafy：0x83 后面的字节要异或 0x20 才是原字节（中文命令不还原会乱码） */
export function unmetafy(buf: Buffer): Buffer {
  if (!buf.includes(0x83)) return buf;
  const out = Buffer.alloc(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x83 && i + 1 < buf.length) out[n++] = buf[++i] ^ 0x20;
    else out[n++] = buf[i];
  }
  return out.subarray(0, n);
}

/**
 * 解析历史文件，按文件里的先后顺序返回命令：
 * - bash：一行一条，HISTTIMEFORMAT 打开时前面有 `#1700000000` 时间戳行；
 * - zsh：EXTENDED_HISTORY 格式 `: 1700000000:0;命令`，多行命令每行末尾是反斜杠；
 * - fish：`- cmd: 命令` / `  when: …`；
 * - PowerShell（PSReadLine）：一行一条，行尾 ` 续行。
 */
export function parseHistory(text: string, kind: Kind): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  if (kind === 'fish') {
    for (const l of lines) {
      const m = /^- cmd: (.*)$/.exec(l);
      if (m) out.push(m[1].replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
    }
    return out;
  }
  let cur: string | null = null;
  const cont = kind === 'ps' ? /`$/ : /\\$/;
  for (const raw of lines) {
    if (cur !== null) {
      // zsh 的续行反斜杠是写文件时加的，不是命令的一部分；PowerShell 的 ` 是命令本身的续行符
      cur = `${kind === 'zsh' ? cur.slice(0, -1) : cur}\n${raw}`;
      if (!cont.test(raw)) {
        out.push(cur);
        cur = null;
      }
      continue;
    }
    if (kind === 'bash' && /^#\d{9,}$/.test(raw)) continue;
    let line = raw;
    if (kind === 'zsh') line = raw.replace(/^: \d+:\d+;/, '');
    if (!line.trim()) continue;
    // bash 不会把多行命令写成续行；zsh / PowerShell 的续行要拼回去
    if (kind !== 'bash' && cont.test(line)) cur = line;
    else out.push(line);
  }
  if (cur !== null) out.push(kind === 'zsh' ? cur.slice(0, -1) : cur);
  return out;
}

/** 几个历史文件合成一份：修改时间新的文件排在后面，整体倒序后去重（保留最近一次） */
export function combine(files: { path: string; mtime: number; text: string }[]): { entries: string[]; mtime: number | null } {
  const sorted = [...files].sort((a, b) => a.mtime - b.mtime);
  const all: string[] = [];
  for (const f of sorted) all.push(...parseHistory(f.text, kindOf(f.path)));
  const seen = new Set<string>();
  const entries: string[] = [];
  for (let i = all.length - 1; i >= 0 && entries.length < MAX_ENTRIES; i--) {
    const c = all[i].trim();
    if (!c || c.length > MAX_COMMAND || seen.has(c)) continue;
    seen.add(c);
    entries.push(c);
  }
  return { entries, mtime: sorted.length ? sorted[sorted.length - 1].mtime : null };
}

const MARK = '@@ITM-HIST';

/** 远端读取历史文件的脚本（用 sh 执行：登录 shell 可能是 fish / csh）；有 base64 时编码传输，zsh 的 metafy 字节不会被 UTF-8 解码弄坏 */
export function remoteScript(): string {
  const files = ['"$HOME/.bash_history"', '"$HOME/.zsh_history"', '"$HOME/.zhistory"', '"$HOME/.local/share/fish/fish_history"'];
  const script = [
    `for f in ${files.join(' ')}; do`,
    '  [ -f "$f" ] && [ -r "$f" ] || continue',
    '  m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)',
    `  if command -v base64 >/dev/null 2>&1; then printf '\\n${MARK} b64 %s %s\\n' "$m" "$f"; tail -n ${TAIL_LINES} "$f" | base64;`,
    `  else printf '\\n${MARK} raw %s %s\\n' "$m" "$f"; tail -n ${TAIL_LINES} "$f"; fi`,
    'done',
  ].join('\n');
  return `sh -c ${shQuote(script)}`;
}

/** 解析远端脚本的输出 */
export function parseRemote(stdout: string): { path: string; mtime: number; text: string }[] {
  const out: { path: string; mtime: number; text: string }[] = [];
  const re = new RegExp(`^${MARK} (b64|raw) (\\d+) (.+)$`, 'gm');
  const marks = [...stdout.matchAll(re)];
  marks.forEach((m, i) => {
    const start = m.index! + m[0].length + 1;
    const end = i + 1 < marks.length ? marks[i + 1].index! : stdout.length;
    const body = stdout.slice(start, end);
    const path = m[3];
    let buf: Buffer = m[1] === 'b64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : Buffer.from(body, 'utf8');
    if (kindOf(path) === 'zsh') buf = unmetafy(buf);
    out.push({ path, mtime: Number(m[2]) * 1000, text: buf.toString('utf8') });
  });
  return out;
}

async function readTail(path: string): Promise<{ text: string; mtime: number } | null> {
  try {
    const st = await stat(path);
    if (!st.isFile()) return null;
    const fh = await open(path, 'r');
    try {
      const len = Math.min(st.size, LOCAL_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      let b = kindOf(path) === 'zsh' ? unmetafy(buf) : buf;
      // 从文件中间开始读的：丢掉第一行（可能只有半行）
      if (len < st.size) b = b.subarray(b.indexOf(0x0a) + 1);
      return { text: b.toString('utf8'), mtime: st.mtimeMs };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** 本机的历史文件 */
function localFiles(): string[] {
  const home = homedir();
  const files = [join(home, '.bash_history'), join(home, '.zsh_history'), join(home, '.zhistory'), join(home, '.local', 'share', 'fish', 'fish_history')];
  if (process.platform === 'win32' && process.env.APPDATA) files.push(join(process.env.APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'));
  return files;
}

/**
 * Shell 自己的历史命令（history 命令看到的那些）：远端主机通过 exec 通道读 ~/.bash_history、~/.zsh_history、fish 历史，
 * 本机直接读文件。只读不改；结果缓存 30 秒。
 */
export class ShellHistoryService {
  private readonly cache = new Map<string, ShellHistory>();
  private readonly pending = new Map<string, Promise<ShellHistory>>();

  constructor(
    private readonly pool: Pick<SshPool, 'acquire' | 'release' | 'isConnected'>,
    private readonly isSsh: (hostId: string) => boolean,
    private readonly now: () => number = Date.now,
    private readonly files: () => string[] = localFiles,
  ) {}

  private key(hostId: string | null): string {
    return hostId ?? 'local';
  }

  /** 缓存里的结果（不读取） */
  peek(hostId: string | null): ShellHistory | null {
    return this.cache.get(this.key(hostId)) ?? null;
  }

  fresh(hostId: string | null): boolean {
    const c = this.peek(hostId);
    return !!c && this.now() - c.at < TTL_MS;
  }

  /** 远端主机已经连着（或者是本机）：可以在后台读取，不会新建连接 */
  canPrefetch(hostId: string | null): boolean {
    return !hostId || (this.isSsh(hostId) && this.pool.isConnected(hostId));
  }

  /** 读取（force 时忽略缓存）；同一台主机同时只读一次 */
  load(owner: number, hostId: string | null, force = false): Promise<ShellHistory> {
    const key = this.key(hostId);
    if (!force && this.fresh(hostId)) return Promise.resolve(this.cache.get(key)!);
    const running = this.pending.get(key);
    if (running) return running;
    const p = (hostId ? this.readRemote(owner, hostId) : this.readLocal())
      .catch((e: unknown): ShellHistory => ({ entries: [], mtime: null, files: [], error: e instanceof Error ? e.message : String(e), at: this.now() }))
      .then((r) => {
        this.cache.set(key, r);
        return r;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  /** 输入提示用：有新鲜的缓存直接用；连着的主机最多等 waitMs 去读，超时先返回旧缓存（读完的结果下次用） */
  async quick(owner: number, hostId: string | null, waitMs: number): Promise<ShellHistory | null> {
    if (this.fresh(hostId)) return this.peek(hostId);
    if (!this.canPrefetch(hostId)) return this.peek(hostId);
    const p = this.load(owner, hostId);
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), waitMs));
    return (await Promise.race([p, timeout])) ?? this.peek(hostId);
  }

  invalidate(hostId: string | null): void {
    this.cache.delete(this.key(hostId));
  }

  private async readLocal(): Promise<ShellHistory> {
    const files: { path: string; mtime: number; text: string }[] = [];
    for (const path of this.files()) {
      const r = await readTail(path);
      if (r) files.push({ path, ...r });
    }
    return { ...combine(files), files: files.map((f) => f.path), at: this.now() };
  }

  private async readRemote(owner: number, hostId: string): Promise<ShellHistory> {
    if (!this.isSsh(hostId)) return { entries: [], mtime: null, files: [], error: '不是 SSH 主机，没有 shell 历史', at: this.now() };
    const conn = await this.pool.acquire(hostId, owner);
    try {
      const r = await execCommand(conn.client, remoteScript(), { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024, closeStdin: true });
      if (r.timedOut) throw new Error('读取历史命令超时');
      const files = parseRemote(r.stdout);
      if (!files.length) return { entries: [], mtime: null, files: [], error: '没有找到 ~/.bash_history / ~/.zsh_history', at: this.now() };
      return { ...combine(files), files: files.map((f) => f.path), at: this.now() };
    } finally {
      this.pool.release(conn);
    }
  }
}
