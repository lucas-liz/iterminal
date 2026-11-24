import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, posix } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ConflictPolicy, TransferItem, TransferState } from '@itm/protocol';
import { describeErrorCode, UserError } from '../../util/errors';
import type { Emit } from '../connection/emitter';
import { fileTypeOf } from './file-mode';
import { normalizeLocal } from './local-fs';
import { normalizeRemote, type SftpService } from './sftp-service';
import type { RemoteFs } from './remote-fs';

/** 进度事件的最小间隔 */
const PROGRESS_INTERVAL_MS = 100;
/** 每个文件最多尝试几次（出错后自动重试，从已经写入的位置继续） */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 600;
/** 这么久没有任何进展就当作连接卡死，按失败重试 */
const STALL_MS = 30_000;
/** SFTP 读写块大小 */
const CHUNK = 64 * 1024;

interface PlanEntry {
  kind: 'dir' | 'file';
  /** 相对传输根的路径（用 / 分隔），根本身为 '' */
  rel: string;
  size: number;
}

interface Job {
  state: TransferState;
  owner: number;
  item: TransferItem;
  policy: ConflictPolicy;
  canceled: boolean;
  /** 暂停：和取消一样中止，但保留已经写入的部分，继续时按断点续传（第十六轮） */
  paused: boolean;
  /** 当前正在写的目标文件；fresh 表示是这次新建的（取消时删除），续传的不删 */
  partial: { path: string; fresh: boolean } | null;
  abort: AbortController;
  /** 测速：最近两秒的 [时间, 累计字节] */
  samples: [number, number][];
}

export interface TransferOptions {
  /** 限速（字节 / 秒，0 = 不限）；每次读取都取最新的设置 */
  rateLimit?: () => number;
  /** 同一个 SFTP 会话同时进行的传输数 */
  concurrency?: () => number;
  now?: () => number;
}

/** 令牌桶限速：所有传输共用 */
export class RateLimiter {
  private tokens = 0;
  private last: number;

  constructor(
    private readonly rate: () => number,
    private readonly now: () => number = Date.now,
  ) {
    this.last = now();
  }

  async take(n: number, signal?: AbortSignal): Promise<void> {
    for (;;) {
      const rate = this.rate();
      if (rate <= 0) return;
      const t = this.now();
      // 最多攒 1 秒的令牌
      this.tokens = Math.min(rate, this.tokens + ((t - this.last) / 1000) * rate);
      this.last = t;
      if (this.tokens >= n || (this.tokens >= rate && n > rate)) {
        this.tokens -= n;
        return;
      }
      const wait = Math.max(5, Math.ceil(((Math.min(n, rate) - this.tokens) / rate) * 1000));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new CanceledError());
          },
          { once: true },
        );
      });
    }
  }
}

/** 统计字节数（进度）并限速 */
class Meter extends Transform {
  constructor(
    private readonly onBytes: (n: number) => void,
    private readonly limiter: RateLimiter,
    private readonly signal: AbortSignal,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.limiter.take(chunk.length, this.signal).then(
      () => {
        this.onBytes(chunk.length);
        cb(null, chunk);
      },
      (e) => cb(e as Error),
    );
  }
}

/** 名称 (1).扩展名、名称 (2).扩展名 …… */
function numbered(name: string, n: number): string {
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${ext && ext !== name ? ext : ''}`;
}

/** 文件本身的问题（不存在、没权限、磁盘满），重试也没用 */
function permanent(e: unknown): boolean {
  if (e instanceof UserError || e instanceof CanceledError) return true;
  const code = (e as { code?: unknown }).code;
  return code === 2 || code === 3 || code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOSPC' || code === 'EROFS';
}

/**
 * 上传 / 下载（文档一 6.3）：
 * - 同一个 SFTP 会话最多同时进行 concurrency 个传输（默认 3），其余排队；
 * - 目录递归传输（跳过目录里的符号链接，避免循环）；
 * - 目标已存在时按冲突策略处理：覆盖 / 跳过 / 改名 / 断点续传；
 * - 出错后自动重试（最多 3 次），从已经写入的位置继续；
 * - 所有传输共用一个限速令牌桶。
 */
export class TransferService {
  private readonly jobs = new Map<string, Job>();
  private readonly queued = new Map<string, Job[]>();
  private readonly active = new Map<string, number>();
  private readonly limiter: RateLimiter;
  private readonly now: () => number;

  constructor(
    private readonly sftp: SftpService,
    private readonly emit: Emit,
    private readonly opts: TransferOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.limiter = new RateLimiter(opts.rateLimit ?? (() => 0), this.now);
  }

  start(owner: number, sftpId: string, direction: 'upload' | 'download', items: TransferItem[]): string[] {
    if (!this.sftp.has(owner, sftpId)) {
      throw new UserError('SFTP 会话已关闭，请重新打开');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new UserError('没有要传输的文件');
    }
    const ids: string[] = [];
    for (const raw of items) {
      const item = { localPath: normalizeLocal(raw.localPath), remotePath: normalizeRemote(raw.remotePath), cleanupRemote: direction === 'download' && raw.cleanupRemote === true };
      const policy: ConflictPolicy = raw.conflict === 'skip' || raw.conflict === 'rename' || raw.conflict === 'resume' ? raw.conflict : 'overwrite';
      const transferId = randomUUID();
      const job: Job = {
        owner,
        item,
        policy,
        canceled: false,
        paused: false,
        partial: null,
        abort: new AbortController(),
        samples: [],
        state: {
          transferId,
          sftpId,
          direction,
          name: direction === 'upload' ? basename(item.localPath) : posix.basename(item.remotePath),
          transferred: 0,
          total: 0,
          status: 'queued',
          speed: 0,
          skipped: 0,
          retries: 0,
          localPath: item.localPath,
          remotePath: item.remotePath,
          createdAt: this.now(),
          finishedAt: null,
        },
      };
      this.jobs.set(transferId, job);
      ids.push(transferId);
      this.report(job);
      const q = this.queued.get(sftpId) ?? [];
      q.push(job);
      this.queued.set(sftpId, q);
    }
    this.pump(sftpId);
    return ids;
  }

  cancel(owner: number, transferId: string): void {
    const job = this.jobs.get(transferId);
    if (!job || job.owner !== owner || job.canceled) {
      return;
    }
    job.canceled = true;
    job.abort.abort();
    if (job.state.status === 'paused') {
      void this.cleanupPartial(job);
      this.done(job, 'canceled');
      return;
    }
    if (job.state.status === 'queued') {
      const q = this.queued.get(job.state.sftpId);
      if (q) this.queued.set(job.state.sftpId, q.filter((j) => j !== job));
      this.done(job, 'canceled');
    }
    // 运行中的：pipeline 收到中止信号后销毁读写流，run() 按「已取消」收尾
  }

  /** 暂停：中止当前的读写，保留已经传了的部分（第十六轮） */
  pause(owner: number, transferId: string): void {
    const job = this.jobs.get(transferId);
    if (!job || job.owner !== owner || job.canceled || job.paused) return;
    if (job.state.status === 'queued') {
      const q = this.queued.get(job.state.sftpId);
      if (q) this.queued.set(job.state.sftpId, q.filter((j) => j !== job));
      job.paused = true;
      job.state.status = 'paused';
      job.state.speed = 0;
      this.report(job);
      return;
    }
    if (job.state.status !== 'running') return;
    job.paused = true;
    job.abort.abort();
    // run() 收到中止后按「已暂停」收尾
  }

  /** 继续：重新排队，已经存在的部分按断点续传（大小相同的文件直接跳过） */
  resume(owner: number, transferId: string): void {
    const job = this.jobs.get(transferId);
    if (!job || job.owner !== owner || job.state.status !== 'paused') return;
    if (!this.sftp.has(owner, job.state.sftpId)) {
      this.done(job, 'error', 'SFTP 会话已关闭，请重新上传');
      return;
    }
    job.paused = false;
    job.canceled = false;
    job.abort = new AbortController();
    job.policy = 'resume';
    job.samples = [];
    job.state.status = 'queued';
    job.state.message = undefined;
    this.report(job);
    const q = this.queued.get(job.state.sftpId) ?? [];
    q.push(job);
    this.queued.set(job.state.sftpId, q);
    this.pump(job.state.sftpId);
  }

  /** 按并发上限启动排队中的任务 */
  private pump(sftpId: string): void {
    const limit = Math.max(1, Math.min(8, this.opts.concurrency?.() ?? 3));
    const q = this.queued.get(sftpId) ?? [];
    while ((this.active.get(sftpId) ?? 0) < limit && q.length) {
      const job = q.shift()!;
      this.active.set(sftpId, (this.active.get(sftpId) ?? 0) + 1);
      void this.run(job).finally(() => {
        this.active.set(sftpId, (this.active.get(sftpId) ?? 1) - 1);
        if (!this.active.get(sftpId)) this.active.delete(sftpId);
        this.pump(sftpId);
      });
    }
    if (!q.length) this.queued.delete(sftpId);
  }

  private async run(job: Job): Promise<void> {
    if (job.canceled || job.paused) {
      return;
    }
    job.state.status = 'running';
    this.report(job);
    const { owner, item } = job;
    const { sftpId, direction } = job.state;
    try {
      let remote = await this.sftp.transferChannel(owner, sftpId);
      const plan = direction === 'upload' ? await planLocal(item.localPath) : await planRemote(remote, item.remotePath);
      job.state.total = plan.reduce((n, e) => n + e.size, 0);
      this.report(job);

      let done = 0;
      let lastReport = 0;
      for (const entry of plan) {
        if (job.canceled || job.paused) {
          throw new CanceledError();
        }
        const local = entry.rel ? join(item.localPath, ...entry.rel.split('/')) : item.localPath;
        const remotePath = entry.rel ? posix.join(item.remotePath, entry.rel) : item.remotePath;
        if (entry.kind === 'dir') {
          if (direction === 'upload') {
            if (!(await remote.exists(remotePath))) {
              await remote.mkdir(remotePath);
            }
          } else {
            await mkdir(local, { recursive: true });
          }
          continue;
        }
        const onBytes = (fileDone: number): void => {
          job.state.transferred = done + fileDone;
          const t = this.now();
          if (t - lastReport >= PROGRESS_INTERVAL_MS) {
            lastReport = t;
            this.measure(job);
            this.report(job);
          }
        };
        /** 重试时接着写上一次没写完的那个文件 */
        let resumeAt: string | null = null;
        for (let attempt = 1; ; attempt++) {
          try {
            await this.copyFile(job, remote, direction, local, remotePath, entry.size, onBytes, resumeAt);
            break;
          } catch (e) {
            if (job.canceled || job.paused || permanent(e) || attempt >= MAX_ATTEMPTS) throw e;
            // 网络中断等：等一下，重新打开传输 channel，从已经写入的位置继续
            job.state.retries = (job.state.retries ?? 0) + 1;
            this.report(job);
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
            if (job.canceled) throw new CanceledError();
            remote = await this.sftp.transferChannel(owner, sftpId);
            resumeAt = job.partial?.path ?? resumeAt;
          }
        }
        done += entry.size;
        job.state.transferred = done;
      }
      this.done(job, 'done');
    } catch (e) {
      if (job.paused && !job.canceled) {
        // 暂停：保留已经写入的部分，任务留在列表里等继续（暂停后取消时再按「新建的部分」清理）
        job.state.status = 'paused';
        job.state.speed = 0;
        this.report(job);
        return;
      }
      if (job.canceled || e instanceof CanceledError) {
        await this.cleanupPartial(job);
        this.done(job, 'canceled');
      } else {
        this.done(job, 'error', e instanceof UserError ? e.message : (describeErrorCode((e as { code?: unknown }).code) ?? (e as Error).message));
      }
    } finally {
      // 打包下载：服务器上的临时压缩包用完即删（暂停时留着，继续时还要用）
      if (item.cleanupRemote && !job.paused) await this.sftp.removeArchive(owner, sftpId, item.remotePath);
    }
  }

  /**
   * 复制一个文件。目标已存在时按冲突策略决定：从头写、从目标大小续写、换个名字，或者跳过。
   */
  private async copyFile(
    job: Job,
    remote: RemoteFs,
    direction: 'upload' | 'download',
    local: string,
    remotePath: string,
    size: number,
    onBytes: (n: number) => void,
    resumeAt: string | null,
  ): Promise<void> {
    let target = resumeAt ?? (direction === 'upload' ? remotePath : local);
    const policy: ConflictPolicy = resumeAt ? 'resume' : job.policy;
    const existing = direction === 'upload' ? await remote.exists(target) : await stat(target).catch(() => null);
    let offset = 0;
    if (existing) {
      if (policy === 'skip') {
        job.state.skipped = (job.state.skipped ?? 0) + 1;
        onBytes(size);
        return;
      }
      if (policy === 'rename') {
        target = await this.freeName(direction, remote, target);
      } else if (policy === 'resume') {
        if (existing.size === size) {
          onBytes(size);
          return;
        }
        if (existing.size < size) offset = existing.size;
      }
    }
    // 重试接着写的文件沿用第一次的 fresh 标记（第一次新建的，取消时照样删除）
    job.partial = { path: target, fresh: resumeAt ? (job.partial?.fresh ?? false) : offset === 0 && (!existing || policy !== 'resume') };
    onBytes(offset);
    let n = offset;
    const meter = new Meter(
      (bytes) => {
        n += bytes;
        onBytes(n);
      },
      this.limiter,
      job.abort.signal,
    );
    if (remote.closed) throw new Error('SFTP 传输通道已断开');
    let src: NodeJS.ReadableStream & { destroy(e?: Error): void };
    let dst: NodeJS.WritableStream & { destroy(e?: Error): void };
    if (direction === 'upload') {
      const st = await stat(local);
      src = createReadStream(local, { start: offset, highWaterMark: CHUNK });
      dst = remote.createWriteStream(target, { flags: offset ? 'r+' : 'w', start: offset, mode: st.mode & 0o777 });
    } else {
      src = remote.createReadStream(remotePath, { start: offset, highWaterMark: CHUNK });
      dst = createWriteStream(target, { flags: offset ? 'r+' : 'w', start: offset });
    }
    // channel 关闭（或卡住没有响应）后 ssh2 的读写流不会报错也不会结束，要自己盯着，否则 pipeline 会一直挂着
    let fail: (e: Error) => void = () => undefined;
    const broken = new Promise<never>((_res, rej) => {
      fail = (err) => {
        src.destroy(err);
        dst.destroy(err);
        rej(err);
      };
    });
    broken.catch(() => undefined);
    const unsubscribe = remote.onClose(() => fail(new Error('SFTP 传输通道已断开')));
    let lastN = n;
    let lastAt = this.now();
    const watchdog = setInterval(() => {
      if (n !== lastN) {
        lastN = n;
        lastAt = this.now();
      } else if (this.now() - lastAt > STALL_MS) {
        fail(new Error(`传输超时：${STALL_MS / 1000} 秒没有进展`));
      }
    }, 1000);
    try {
      await Promise.race([pipeline(src, meter, dst, { signal: job.abort.signal }), broken]);
    } finally {
      clearInterval(watchdog);
      unsubscribe();
    }
    job.partial = null;
  }

  /** 改名策略：找一个不存在的「名称 (n).扩展名」 */
  private async freeName(direction: 'upload' | 'download', remote: RemoteFs, path: string): Promise<string> {
    const isRemote = direction === 'upload';
    const dir = isRemote ? posix.dirname(path) : dirname(path);
    const name = isRemote ? posix.basename(path) : basename(path);
    for (let i = 1; i < 1000; i++) {
      const candidate = isRemote ? posix.join(dir, numbered(name, i)) : join(dir, numbered(name, i));
      const taken = isRemote ? await remote.exists(candidate) : await stat(candidate).catch(() => null);
      if (!taken) return candidate;
    }
    throw new UserError(`找不到可用的文件名：${name}`);
  }

  private measure(job: Job): void {
    const t = this.now();
    job.samples.push([t, job.state.transferred]);
    while (job.samples.length > 2 && t - job.samples[0][0] > 2000) job.samples.shift();
    const [t0, b0] = job.samples[0];
    job.state.speed = t > t0 ? Math.round(((job.state.transferred - b0) * 1000) / (t - t0)) : 0;
  }

  private async cleanupPartial(job: Job): Promise<void> {
    const p = job.partial;
    job.partial = null;
    // 续传的文件保留已经写入的部分，下次还能接着传
    if (!p || !p.fresh) {
      return;
    }
    try {
      if (job.state.direction === 'download') {
        await rm(p.path, { force: true });
      } else {
        const remote = await this.sftp.transferChannel(job.owner, job.state.sftpId);
        await remote.unlink(p.path);
      }
    } catch {
      // 尽力而为：连接已断开或文件已不存在
    }
  }

  private done(job: Job, status: 'done' | 'error' | 'canceled', message?: string): void {
    job.state.status = status;
    job.state.speed = 0;
    job.state.finishedAt = this.now();
    if (message) {
      job.state.message = message;
    }
    this.report(job);
    this.jobs.delete(job.state.transferId);
  }

  private report(job: Job): void {
    this.emit(job.owner, 'transfer.progress', { ...job.state });
  }
}

class CanceledError extends Error {}

async function planLocal(root: string): Promise<PlanEntry[]> {
  const st = await stat(root);
  if (st.isFile()) {
    return [{ kind: 'file', rel: '', size: st.size }];
  }
  if (!st.isDirectory()) {
    throw new UserError(`不支持传输这种类型的文件：${basename(root)}`);
  }
  const out: PlanEntry[] = [{ kind: 'dir', rel: '', size: 0 }];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const d of await readdir(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        out.push({ kind: 'dir', rel: childRel, size: 0 });
        await walk(full, childRel);
      } else if (d.isFile()) {
        out.push({ kind: 'file', rel: childRel, size: (await lstat(full)).size });
      }
    }
  };
  await walk(root, '');
  return out;
}

async function planRemote(remote: RemoteFs, root: string): Promise<PlanEntry[]> {
  const st = await remote.stat(root);
  const type = fileTypeOf(st.mode);
  if (type === 'file') {
    return [{ kind: 'file', rel: '', size: st.size }];
  }
  if (type !== 'dir') {
    throw new UserError(`不支持传输这种类型的文件：${posix.basename(root)}`);
  }
  const out: PlanEntry[] = [{ kind: 'dir', rel: '', size: 0 }];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const { filename, attrs } of await remote.readdir(dir)) {
      const childRel = rel ? `${rel}/${filename}` : filename;
      const t = fileTypeOf(attrs.mode);
      if (t === 'dir') {
        out.push({ kind: 'dir', rel: childRel, size: 0 });
        await walk(posix.join(dir, filename), childRel);
      } else if (t === 'file') {
        out.push({ kind: 'file', rel: childRel, size: attrs.size });
      }
    }
  };
  await walk(root, '');
  return out;
}
