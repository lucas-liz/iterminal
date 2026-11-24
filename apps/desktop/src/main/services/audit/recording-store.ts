import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RecordingInfo, RecordingData } from '@itm/protocol';
import type { Db } from '../db/database';
import { openWith, sealWith } from '../sync/e2e-crypto';
import { hkdf } from '../../util/kdf';
import { UserError } from '../../util/errors';

/**
 * 会话录像（文档一 6.1 / 6.12）：asciicast v2，只记录输出（"o"）和窗口大小变化（"r"），
 * 不记录键盘输入（输入里可能有在提示符下敲的密码）。
 *
 * 文件格式（.itmrec）：`ITMREC1\n` 之后是一个个加密块：uint32 长度 + iv(12) | AES-256-GCM(若干行 asciicast JSON) | tag(16)。
 * 密钥由保险库密钥派生，和数据库一样只有本机档案能解开；AAD 为 recording:{id}:{块序号}，块不能被调换或删除后拼接。
 */
const MAGIC = Buffer.from('ITMREC1\n');
const FLUSH_MS = 2000;
const FLUSH_BYTES = 64 * 1024;
/** 单个录像的上限（明文），超过后停止记录并标记 */
const MAX_BYTES = 100 * 1024 * 1024;

interface Row {
  id: string;
  session_id: string;
  kind: string;
  host_id: string | null;
  host_name: string;
  username: string | null;
  cols: number;
  rows: number;
  file: string;
  bytes: number;
  duration_ms: number;
  truncated: number;
  started_at: number;
  ended_at: number | null;
}

const toInfo = (r: Row): RecordingInfo => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind as RecordingInfo['kind'],
  hostId: r.host_id,
  hostName: r.host_name,
  username: r.username ?? null,
  cols: r.cols,
  rows: r.rows,
  bytes: r.bytes,
  durationMs: r.duration_ms,
  truncated: !!r.truncated,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

export interface Recorder {
  /** 录像 ID（定时任务的执行记录链接到回放，第二十七轮）；测试替身可以没有 */
  id?: string;
  output(text: string): void;
  resize(cols: number, rows: number): void;
  end(): void;
}

export class RecordingStore {
  private readonly key: Buffer;
  /** 录制中的会话：id → 结束函数 */
  private readonly live = new Map<string, () => void>();

  constructor(
    private readonly db: Db,
    private readonly dir: string,
    vaultKey: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    this.key = hkdf(vaultKey, 'itm-recording-v1', 'enc');
    this.recoverUnfinished();
  }

  /**
   * 应用意外退出（崩溃、强制结束、断电）后，上次录制中的录像没有正常结束（ended_at 为空，一直显示「录制中」）：
   * 打开档案时把它们补成已结束——数据每 2 秒落盘一次，时长和大小用最后一次落盘时的值，没写完的最后一块读取时会忽略（第二十六轮）
   */
  private recoverUnfinished(): void {
    try {
      this.db
        .prepare('UPDATE session_recording SET ended_at = started_at + duration_ms WHERE ended_at IS NULL')
        .run();
    } catch {
      // 表还不存在（迁移之前）等：忽略
    }
  }

  /** 自定义的录像目录（设置 → 存储位置）；空表示 {档案目录}/recordings */
  private customRoot: () => string = () => '';
  setRoot(root: () => string): void {
    this.customRoot = root;
  }

  /** 当前的录像目录 */
  root(): string {
    return this.customRoot() || join(this.dir, 'recordings');
  }

  /** 数据库里的 file：默认目录下存相对路径（recordings/…），自定义目录存绝对路径 */
  private abs(file: string): string {
    return isAbsolute(file) ? file : join(this.dir, file);
  }

  /**
   * 把已有的录像移到新的录像目录（正在录制的除外，结束后仍然留在原处，可以再移一次）。
   * 返回移动的个数和失败的个数。
   */
  moveAll(newRoot: string): { moved: number; failed: number } {
    const target = newRoot || join(this.dir, 'recordings');
    let moved = 0;
    let failed = 0;
    for (const r of this.db.prepare<[], { id: string; file: string; started_at: number }>('SELECT id, file, started_at FROM session_recording WHERE ended_at IS NOT NULL').all()) {
      const from = this.abs(r.file);
      const month = new Date(r.started_at).toISOString().slice(0, 7);
      const to = join(target, month, `${r.id}.itmrec`);
      if (from === to) continue;
      try {
        if (!existsSync(from)) continue;
        mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
        try {
          renameSync(from, to);
        } catch {
          // 跨磁盘：复制后删除
          copyFileSync(from, to);
          unlinkSync(from);
        }
        const rel = relative(this.dir, to);
        const file = !newRoot && !rel.startsWith('..') && !isAbsolute(rel) ? rel : to;
        this.db.prepare('UPDATE session_recording SET file = ? WHERE id = ?').run(file, r.id);
        moved++;
      } catch {
        failed++;
      }
    }
    return { moved, failed };
  }

  /** 开始录像；返回的 Recorder 在会话结束时必须 end() */
  start(meta: { sessionId: string; kind: RecordingInfo['kind']; hostId: string | null; hostName: string; username?: string | null; cols: number; rows: number; term?: string }): Recorder {
    const id = randomUUID();
    const started = this.now();
    const month = new Date(started).toISOString().slice(0, 7);
    const custom = this.customRoot();
    const rel = custom ? join(custom, month, `${id}.itmrec`) : join('recordings', month, `${id}.itmrec`);
    const abs = this.abs(rel);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    writeFileSync(abs, MAGIC, { mode: 0o600 });
    this.db
      .prepare('INSERT INTO session_recording (id, session_id, kind, host_id, host_name, username, cols, rows, file, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, meta.sessionId, meta.kind, meta.hostId, meta.hostName, meta.username || null, meta.cols, meta.rows, rel, started);

    let buf: string[] = [JSON.stringify({ version: 2, width: meta.cols, height: meta.rows, timestamp: Math.floor(started / 1000), title: meta.hostName, env: { TERM: meta.term ?? 'xterm-256color' } })];
    let bufBytes = 0;
    let bytes = 0;
    let chunk = 0;
    let truncated = false;
    let ended = false;
    let timer: NodeJS.Timeout | null = null;
    const fd = openSync(abs, 'a');
    const t = (): number => Math.round(this.now() - started) / 1000;

    // 数据库已经关闭（退出过程中）时只丢掉元数据更新，不能把异常抛到主进程
    const update = (sql: string, ...args: (string | number)[]): void => {
      try {
        this.db.prepare(sql).run(...args);
      } catch {
        // 忽略
      }
    };
    const flush = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!buf.length) return;
      const sealed = sealWith(this.key, Buffer.from(buf.join('\n') + '\n', 'utf8'), `recording:${id}:${chunk++}`);
      const len = Buffer.alloc(4);
      len.writeUInt32BE(sealed.length);
      writeSync(fd, Buffer.concat([len, sealed]));
      buf = [];
      bufBytes = 0;
      update('UPDATE session_recording SET bytes = ?, duration_ms = ? WHERE id = ?', bytes, Math.round(this.now() - started), id);
    };
    const push = (line: string): void => {
      buf.push(line);
      bufBytes += line.length;
      if (bufBytes >= FLUSH_BYTES) flush();
      else if (!timer) timer = setTimeout(flush, FLUSH_MS);
    };

    const end = (): void => {
      if (ended) return;
      ended = true;
      flush();
      closeSync(fd);
      this.live.delete(id);
      update('UPDATE session_recording SET ended_at = ?, bytes = ?, duration_ms = ? WHERE id = ?', this.now(), bytes, Math.round(this.now() - started), id);
    };
    this.live.set(id, end);

    return {
      id,
      output: (text) => {
        if (ended || truncated || !text) return;
        bytes += Buffer.byteLength(text);
        if (bytes > MAX_BYTES) {
          truncated = true;
          push(JSON.stringify([t(), 'o', '\r\n[录像超过 100MB，之后的输出没有记录]\r\n']));
          update('UPDATE session_recording SET truncated = 1 WHERE id = ?', id);
          return;
        }
        push(JSON.stringify([t(), 'o', text]));
      },
      resize: (cols, rows) => {
        if (ended || truncated) return;
        push(JSON.stringify([t(), 'r', `${cols}x${rows}`]));
      },
      end,
    };
  }

  /** 结束所有录制中的录像（退出、切换档案时在关闭数据库之前调用） */
  endAll(): void {
    for (const end of [...this.live.values()]) end();
  }

  list(filter: { q?: string; hostId?: string | null; username?: string; kind?: string | null; from?: number; to?: number; limit?: number; offset?: number } = {}): { items: RecordingInfo[]; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.q?.trim()) {
      where.push('host_name LIKE ?');
      args.push(`%${filter.q.trim()}%`);
    }
    if (filter.hostId) {
      where.push('host_id = ?');
      args.push(filter.hostId);
    }
    if (filter.username?.trim()) {
      where.push('username LIKE ?');
      args.push(`%${filter.username.trim()}%`);
    }
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    if (filter.from) {
      where.push('started_at >= ?');
      args.push(filter.from);
    }
    if (filter.to) {
      where.push('started_at < ?');
      args.push(filter.to);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.prepare<(string | number)[], { n: number }>(`SELECT count(*) AS n FROM session_recording ${w}`).get(...args)?.n ?? 0;
    const items = this.db
      .prepare<(string | number)[], Row>(`SELECT * FROM session_recording ${w} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(filter.limit ?? 50, 500), filter.offset ?? 0)
      .map(toInfo);
    return { items, total };
  }

  private row(id: string): Row {
    const r = this.db.prepare<[string], Row>('SELECT * FROM session_recording WHERE id = ?').get(id);
    if (!r) throw new UserError('录像不存在');
    return r;
  }

  /** 解密整段录像（asciicast v2 文本） */
  readCast(id: string): string {
    const r = this.row(id);
    const abs = this.abs(r.file);
    if (!existsSync(abs)) throw new UserError('录像文件不存在（可能已被清理）');
    const buf = readFileSync(abs);
    if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new UserError('录像文件已损坏');
    let off = MAGIC.length;
    let chunk = 0;
    const parts: string[] = [];
    while (off + 4 <= buf.length) {
      const len = buf.readUInt32BE(off);
      off += 4;
      if (off + len > buf.length) break; // 最后一块没写完（异常退出）：忽略
      try {
        parts.push(openWith(this.key, buf.subarray(off, off + len), `recording:${id}:${chunk++}`).toString('utf8'));
      } catch {
        throw new UserError('录像无法解密（可能来自其他档案，或者文件已被改动）');
      }
      off += len;
    }
    return parts.join('');
  }

  info(id: string): RecordingInfo {
    return toInfo(this.row(id));
  }

  /** 回放用：header + 事件 */
  read(id: string): RecordingData {
    const info = toInfo(this.row(id));
    const lines = this.readCast(id).split('\n').filter(Boolean);
    const header = JSON.parse(lines[0] ?? '{}') as { width?: number; height?: number };
    const events: RecordingData['events'] = [];
    for (const l of lines.slice(1)) {
      try {
        const e = JSON.parse(l) as [number, string, string];
        if (Array.isArray(e) && typeof e[0] === 'number' && (e[1] === 'o' || e[1] === 'r') && typeof e[2] === 'string') events.push(e as RecordingData['events'][number]);
      } catch {
        // 忽略损坏的行
      }
    }
    return { info, cols: header.width ?? info.cols, rows: header.height ?? info.rows, events };
  }

  /** 导出为标准 asciicast v2 文件（明文，可以用 asciinema play 回放） */
  exportCast(id: string, path: string): void {
    writeFileSync(path, this.readCast(id), { mode: 0o600 });
  }

  delete(ids: string[]): void {
    for (const id of ids) {
      if (this.live.has(id)) throw new UserError('这个会话还在录制中，结束后才能删除');
      const r = this.db.prepare<[string], Row>('SELECT * FROM session_recording WHERE id = ?').get(id);
      if (!r) continue;
      rmSync(this.abs(r.file), { force: true });
      this.db.prepare('DELETE FROM session_recording WHERE id = ?').run(id);
    }
  }

  /** 清理超过保留天数的录像；keepUnuploaded：账号模式下还没上传到服务端的先保留 */
  cleanup(retentionDays: number, keepUnuploaded = false): number {
    const before = this.now() - retentionDays * 86_400_000;
    const old = this.db
      .prepare<[number], { id: string }>(`SELECT id FROM session_recording WHERE started_at < ? AND ended_at IS NOT NULL${keepUnuploaded ? ' AND uploaded = 1' : ''}`)
      .all(before);
    this.delete(old.map((r) => r.id).filter((id) => !this.live.has(id)));
    return old.length;
  }

  /** 录像占用的磁盘空间（字节） */
  diskUsage(): number {
    let total = 0;
    for (const r of this.db.prepare<[], { file: string }>('SELECT file FROM session_recording').all()) {
      try {
        total += statSync(this.abs(r.file)).size;
      } catch {
        // 文件已被删除
      }
    }
    return total;
  }
}
