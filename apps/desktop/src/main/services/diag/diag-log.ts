import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mask } from '@itm/masking';
import type { DiagCategory, DiagEntry, DiagLevel } from '@itm/protocol';

const MAX_FILE = 2 * 1024 * 1024;
const RING = 1000;
const MAX_MSG = 2000;
const MAX_DATA = 4000;
/** 字段名像秘密的一律不记（参数摘要、事件数据） */
const SECRET_KEY = /pass|secret|token|key|credential|otp|cookie|auth|code|recovery|phrase|seed|words|content|data|text|body|answer|prompt|script|image/i;

/** 把任意值压成短小、可序列化的摘要：去掉像秘密的字段、长字符串截断、深度最多 3 层、数组最多 20 项 */
export function summarize(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…(${v.length})` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return String(v);
  if (v instanceof Error) return { name: v.name, message: v.message, ...(v.stack ? { stack: v.stack.split('\n').slice(0, 12).join('\n') } : {}) };
  if (depth >= 3) return Array.isArray(v) ? `[${v.length} 项]` : '{…}';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => summarize(x, depth + 1)).concat(v.length > 20 ? [`…共 ${v.length} 项`] : []);
  if (typeof v === 'object') {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `<${(v as Uint8Array).length} 字节>`;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) {
      // 设置项的名称（setting.set 的 key）不是秘密
      if (SECRET_KEY.test(k) && k !== 'key') continue;
      if (typeof x === 'function') continue;
      out[k] = summarize(x, depth + 1);
    }
    return out;
  }
  return String(v);
}

/**
 * 诊断日志（第十三轮，文档一 6.27.1）：应用级（不属于档案），一行一条 JSON，写 {logs}/main.log，超过 2MB 改名为 main.old.log（只保留一份，
 * 和 electron-log 的默认做法一样）。内存里保留最近 1000 条作为操作轨迹（breadcrumbs），反馈时附带。写入前统一脱敏。
 * 没有调用 init（单元测试）时只保留在内存里。
 */
export class DiagLog {
  private dir: string | null = null;
  private ring: DiagEntry[] = [];
  private pending: string[] = [];
  private pendingBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private size = 0;

  init(dir: string): void {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    try {
      this.size = statSync(this.file).size;
    } catch {
      this.size = 0;
    }
  }

  get logDir(): string | null {
    return this.dir;
  }

  private get file(): string {
    return join(this.dir!, 'main.log');
  }

  private get oldFile(): string {
    return join(this.dir!, 'main.old.log');
  }

  log(level: DiagLevel, cat: DiagCategory, msg: string, data?: unknown, src: 'main' | 'renderer' = 'main', t = Date.now()): void {
    const e: DiagEntry = { t, level, cat, msg: mask(String(msg)).slice(0, MAX_MSG), src };
    if (data !== undefined) {
      try {
        const json = mask(JSON.stringify(summarize(data)) ?? '');
        e.data = json.length > MAX_DATA ? `${json.slice(0, MAX_DATA)}…` : JSON.parse(json);
      } catch {
        e.data = '（无法序列化）';
      }
    }
    this.ring.push(e);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    if (!this.dir) return;
    const line = JSON.stringify(e);
    this.pending.push(line);
    this.pendingBytes += line.length;
    // 错误立即落盘；缓冲太大时也立即写（轮转按每批检查）
    if (level === 'error' || this.pendingBytes > 128 * 1024) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 500);
  }

  info(cat: DiagCategory, msg: string, data?: unknown): void {
    this.log('info', cat, msg, data);
  }

  warn(cat: DiagCategory, msg: string, data?: unknown): void {
    this.log('warn', cat, msg, data);
  }

  error(cat: DiagCategory, msg: string, data?: unknown): void {
    this.log('error', cat, msg, data);
  }

  /** 界面交过来的操作轨迹：时间、级别、分类按白名单校验 */
  push(entries: unknown): void {
    if (!Array.isArray(entries)) return;
    const LEVELS: DiagLevel[] = ['debug', 'info', 'warn', 'error'];
    const CATS: DiagCategory[] = ['ui', 'console', 'error', 'app'];
    for (const raw of entries.slice(0, 200)) {
      if (!raw || typeof raw !== 'object') continue;
      const x = raw as Partial<DiagEntry>;
      const level = LEVELS.includes(x.level as DiagLevel) ? (x.level as DiagLevel) : 'info';
      const cat = CATS.includes(x.cat as DiagCategory) ? (x.cat as DiagCategory) : 'ui';
      const t = typeof x.t === 'number' && Math.abs(x.t - Date.now()) < 3_600_000 ? x.t : Date.now();
      this.log(level, cat, typeof x.msg === 'string' ? x.msg : '', x.data, 'renderer', t);
    }
  }

  /** 把缓冲写进文件；超过上限时轮转 */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dir || !this.pending.length) return;
    const text = `${this.pending.join('\n')}\n`;
    this.pending = [];
    this.pendingBytes = 0;
    try {
      if (this.size + text.length > MAX_FILE && existsSync(this.file)) {
        rmSync(this.oldFile, { force: true });
        renameSync(this.file, this.oldFile);
        this.size = 0;
      }
      appendFileSync(this.file, text, { mode: 0o600 });
      this.size += Buffer.byteLength(text);
    } catch {
      // 日志写不进去不影响使用
    }
  }

  /** 内存里的操作轨迹（按时间） */
  entries(): DiagEntry[] {
    return [...this.ring].sort((a, b) => a.t - b.t);
  }

  /** 最近的错误（error 级别，以及 console 里的 error） */
  errors(limit = 50): DiagEntry[] {
    return this.entries()
      .filter((e) => e.level === 'error')
      .slice(-limit);
  }

  /** main.old.log + main.log 的最后 maxBytes 字节（从完整的一行开始） */
  tail(maxBytes = 300 * 1024): string {
    this.flush();
    if (!this.dir) return this.ring.map((e) => JSON.stringify(e)).join('\n');
    const read = (path: string, want: number): string => {
      try {
        const size = statSync(path).size;
        const len = Math.min(size, want);
        const fd = openSync(path, 'r');
        try {
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, size - len);
          return buf.toString('utf8');
        } finally {
          closeSync(fd);
        }
      } catch {
        return '';
      }
    };
    let text = read(this.file, maxBytes);
    if (Buffer.byteLength(text) < maxBytes) text = read(this.oldFile, maxBytes - Buffer.byteLength(text)) + text;
    const nl = text.indexOf('\n');
    // 第一行可能被截断
    return Buffer.byteLength(text) >= maxBytes && nl >= 0 ? text.slice(nl + 1) : text;
  }
}

/** 整个应用一个 */
export const diag = new DiagLog();

/** 不记进操作轨迹的高频 IPC 通道 */
const QUIET = /^(session\.(write|resize)|monitor\.|completion\.|diag\.|transfer\.progress|agent\.usage|history\.list|setting\.getAll|app\.info|host\.list|folder\.list|tag\.list)/;

/** IPC 路由的钩子：通道、耗时、结果（参数只保留短小的非敏感字段）。error 是转换前的原始错误，userError 表示业务错误（提示给用户的） */
export function logIpc(channel: string, arg: unknown, ms: number, error?: unknown, userError = false): void {
  if (QUIET.test(channel) && !error) return;
  const data: Record<string, unknown> = { ms };
  const a = summarize(arg);
  if (a !== undefined && a !== null && !(typeof a === 'object' && Object.keys(a as object).length === 0)) data.arg = a;
  if (!error) return diag.log('info', 'ipc', channel, data);
  data.error = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  if (code !== undefined) data.code = code;
  if (!userError && error instanceof Error && error.stack) data.stack = error.stack.split('\n').slice(0, 10).join('\n');
  diag.log(userError ? 'warn' : 'error', 'ipc', `${channel} 失败`, data);
}
