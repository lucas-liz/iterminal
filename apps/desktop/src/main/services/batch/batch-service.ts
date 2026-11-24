import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ApprovalEngine, EvaluateContext, Evaluation, PolicyConfig } from '@itm/approval';
import type { BatchCheck, BatchExecInput, BatchFilter, BatchHostResult, BatchHostStatus, BatchJob, BatchLocalItem, BatchStatus, BatchUploadInput, Host } from '@itm/protocol';
import type { Db } from '../db/database';
import type { HostRepo } from '../hosts/host-repo';
import type { SshPool } from '../connection/ssh-pool';
import type { SftpService } from '../sftp/sftp-service';
import type { RemoteFs } from '../sftp/remote-fs';
import type { AuditRepo } from '../audit/audit-repo';
import { execCommand } from '../connection/exec';
import { fileTypeOf } from '../sftp/file-mode';
import { UserError } from '../../util/errors';

/** 同时执行的主机数 */
const CONCURRENCY = 8;
/** 上传同时进行的主机数（每台主机一个文件通道） */
const UPLOAD_CONCURRENCY = 4;
/** 每台主机保存的输出上限 */
const MAX_OUTPUT = 256 * 1024;
/** 「不限制」时的上限：24 小时 */
const NO_LIMIT_MS = 24 * 3600_000;
const MAX_HOSTS = 500;
const MAX_COMMAND = 256 * 1024;
/** 进度推送的最小间隔 */
const EMIT_MS = 300;

export interface BatchDeps {
  db: Db;
  hosts: Pick<HostRepo, 'get' | 'effective' | 'connectInfo'>;
  pool: Pick<SshPool, 'acquire' | 'release'>;
  sftp: Pick<SftpService, 'openTemp'>;
  approval: Pick<ApprovalEngine, 'evaluate'>;
  policy(): PolicyConfig;
  audit: Pick<AuditRepo, 'command' | 'event'>;
  /** 推送进度（所有窗口） */
  emit(job: BatchJob): void;
  /** 连接主机时用哪个窗口（需要输入密码 / 确认主机密钥时弹在这个窗口里） */
  owner(): number;
  now?: () => number;
}

interface JobRow {
  id: string;
  kind: string;
  description: string;
  command: string | null;
  script: number;
  timeout_sec: number;
  remote_path: string | null;
  files: string | null;
  host_count: number;
  file_count: number;
  status: string;
  created_at: number;
  ended_at: number | null;
}

interface HostRow {
  job_id: string;
  host_id: string;
  host_name: string;
  address: string;
  username: string | null;
  status: string;
  exit_code: number | null;
  output: string;
  error: string | null;
  started_at: number | null;
  ended_at: number | null;
}

interface Live {
  job: BatchJob;
  hosts: BatchHostResult[];
  abort: AbortController;
  timer: NodeJS.Timeout | null;
  lastEmit: number;
}

const clip = (s: string): string => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（输出太长，后面的没有保存）` : s);
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function countsOf(hosts: BatchHostResult[]): BatchJob['counts'] {
  const c = { success: 0, failed: 0, running: 0, pending: 0 };
  for (const h of hosts) {
    if (h.status === 'success') c.success++;
    else if (h.status === 'running') c.running++;
    else if (h.status === 'pending') c.pending++;
    else c.failed++;
  }
  return c;
}

/** 所有主机结束后的任务状态 */
export function finalStatus(hosts: BatchHostResult[], cancelled: boolean): BatchStatus {
  const ok = hosts.filter((h) => h.status === 'success').length;
  if (cancelled && ok < hosts.length) return 'cancelled';
  if (ok === hosts.length) return 'success';
  return ok === 0 ? 'failed' : 'partial';
}

/** 上传路径里的变量：${username} 用户名、${home} 家目录；相对路径按家目录算 */
export function resolveRemotePath(raw: string, vars: { username: string; home: string }): string {
  let p = raw.trim().replace(/\$\{username\}/g, vars.username).replace(/\$\{home\}/g, vars.home);
  if (p === '~' || p.startsWith('~/')) p = vars.home + p.slice(1);
  if (!p.startsWith('/')) p = posix.join(vars.home || '/', p);
  return posix.normalize(p).replace(/\/+$/, '') || '/';
}

/** 脚本执行：写成临时脚本文件，有 shebang 时直接执行，否则用 bash（没有 bash 时用 sh），执行完删掉 */
export function scriptCommand(script: string, id: string): string {
  const file = `/tmp/.itm-batch-${id.replace(/[^\w-]/g, '').slice(0, 36)}.sh`;
  const body = script.replace(/\r\n/g, '\n');
  const marker = `ITM_BATCH_EOF_${id.replace(/[^\w]/g, '').slice(0, 12)}`;
  const run = body.startsWith('#!') ? shQuote(file) : `$(command -v bash >/dev/null 2>&1 && echo bash || echo sh) ${shQuote(file)}`;
  return `cat > ${shQuote(file)} <<'${marker}'\n${body}\n${marker}\nchmod 700 ${shQuote(file)} && ${run}; __itm_rc=$?; rm -f ${shQuote(file)}; exit $__itm_rc`;
}

/**
 * 批量执行（第三十五轮）：命令 / 脚本在每台主机的独立 exec 通道里执行（不占用终端），上传用文件通道（SFTP → SSH 命令通道 → FTP）。
 * 命令执行前经过规则引擎：命中黑名单（全局、团队、主机的命令黑名单）的主机不执行；每台主机的执行都写命令审计（来源「手动」）。
 */
export class BatchService {
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;

  constructor(private readonly d: BatchDeps) {
    this.now = d.now ?? Date.now;
    this.recoverUnfinished();
  }

  /** 应用退出时还在执行的任务：标记为失败 */
  private recoverUnfinished(): void {
    try {
      const at = this.now();
      this.d.db.prepare("UPDATE batch_job_host SET status = 'failed', error = '应用退出，执行中断', ended_at = ? WHERE status IN ('pending', 'running')").run(at);
      this.d.db.prepare("UPDATE batch_job SET status = 'failed', ended_at = ? WHERE status = 'running'").run(at);
    } catch {
      // 表还不存在（迁移之前）：忽略
    }
  }

  private ctx(h: Host): EvaluateContext {
    const eff = this.d.hosts.effective(h.id, null);
    // 用户自己批量执行的命令不受「Agent 权限」限制，黑名单、主机的命令黑名单照常生效
    return { hostDenylist: h.cmdDenylist, agentPolicy: 'AUTO', production: eff.production, folderNames: eff.folderPath ? eff.folderPath.split(' / ') : [], policy: this.d.policy() };
  }

  private targets(hostIds: unknown): Host[] {
    const ids = [...new Set(Array.isArray(hostIds) ? hostIds.map(String) : [])];
    if (!ids.length) throw new UserError('请选择主机');
    if (ids.length > MAX_HOSTS) throw new UserError(`一次最多选择 ${MAX_HOSTS} 台主机`);
    const hosts = ids.map((id) => this.d.hosts.get(id)).filter((h): h is Host => !!h);
    if (!hosts.length) throw new UserError('选择的主机不存在');
    const bad = hosts.filter((h) => h.protocol !== 'SSH');
    if (bad.length) throw new UserError(`批量执行只支持 SSH 主机：${bad.map((h) => h.name).slice(0, 5).join('、')}`);
    return hosts;
  }

  /** 执行前检查：最高风险等级和命中黑名单的主机 */
  async check(hostIds: string[], command: string): Promise<BatchCheck> {
    const hosts = this.targets(hostIds);
    const cmd = String(command ?? '');
    if (!cmd.trim()) throw new UserError('请输入要执行的命令');
    const rank = { L0: 0, L1: 1, L2: 2, DENY: 3 } as const;
    let level: BatchCheck['level'] = 'L0';
    const reasons = new Set<string>();
    const denied: BatchCheck['denied'] = [];
    for (const h of hosts) {
      const ev = await this.d.approval.evaluate(cmd, this.ctx(h), { autoReadonly: true });
      if (ev.decision === 'DENY') denied.push({ hostId: h.id, hostName: h.name, reasons: ev.reasons });
      else {
        if (rank[ev.effectiveLevel] > rank[level]) level = ev.effectiveLevel;
        ev.reasons.forEach((r) => reasons.add(r));
      }
    }
    if (denied.length === hosts.length) level = 'DENY';
    return { level, reasons: [...reasons].slice(0, 8), denied };
  }

  private hostResult(h: Host): BatchHostResult {
    let username: string | null = h.username || null;
    try {
      username = this.d.hosts.connectInfo(h.id).auth.username || username;
    } catch {
      // 凭证不可用等：执行时再报错
    }
    return { hostId: h.id, hostName: h.name, address: h.address, username, status: 'pending', exitCode: null, output: '', error: null, startedAt: null, endedAt: null };
  }

  private create(job: Omit<BatchJob, 'counts' | 'hosts'>, hosts: BatchHostResult[]): Live {
    const db = this.d.db;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO batch_job (id, kind, description, command, script, timeout_sec, remote_path, files, host_count, file_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(job.id, job.kind, job.description, job.command, job.script ? 1 : 0, job.timeoutSec, job.remotePath, JSON.stringify(job.files), job.hostCount, job.fileCount, job.status, job.createdAt);
      const ins = db.prepare('INSERT INTO batch_job_host (job_id, host_id, host_name, address, username, status) VALUES (?, ?, ?, ?, ?, ?)');
      for (const h of hosts) ins.run(job.id, h.hostId, h.hostName, h.address, h.username, h.status);
    })();
    const live: Live = { job: { ...job, counts: countsOf(hosts) }, hosts, abort: new AbortController(), timer: null, lastEmit: 0 };
    this.live.set(job.id, live);
    return live;
  }

  /** 一台主机的状态变化：写库并推送 */
  private update(live: Live, i: number, patch: Partial<BatchHostResult>, persist = true): void {
    const h = (live.hosts[i] = { ...live.hosts[i], ...patch });
    if (persist) {
      try {
        this.d.db
          .prepare('UPDATE batch_job_host SET status = ?, exit_code = ?, output = ?, error = ?, started_at = ?, ended_at = ? WHERE job_id = ? AND host_id = ?')
          .run(h.status, h.exitCode, clip(h.output), h.error, h.startedAt, h.endedAt, live.job.id, h.hostId);
      } catch {
        // 数据库已经关闭（退出过程中）
      }
    }
    this.schedule(live);
  }

  private view(live: Live): BatchJob {
    return { ...live.job, counts: countsOf(live.hosts), hosts: live.hosts.map((h) => ({ ...h })) };
  }

  private schedule(live: Live, force = false): void {
    const wait = EMIT_MS - (this.now() - live.lastEmit);
    if (force || wait <= 0) {
      if (live.timer) clearTimeout(live.timer);
      live.timer = null;
      live.lastEmit = this.now();
      this.d.emit(this.view(live));
    } else if (!live.timer) {
      live.timer = setTimeout(() => {
        live.timer = null;
        live.lastEmit = this.now();
        this.d.emit(this.view(live));
      }, wait);
    }
  }

  private finish(live: Live): void {
    const status = finalStatus(live.hosts, live.abort.signal.aborted);
    const endedAt = this.now();
    live.job = { ...live.job, status, endedAt };
    try {
      this.d.db.prepare('UPDATE batch_job SET status = ?, ended_at = ? WHERE id = ?').run(status, endedAt, live.job.id);
    } catch {
      // 忽略
    }
    this.live.delete(live.job.id);
    this.schedule(live, true);
  }

  private async runAll(live: Live, limit: number, one: (i: number, signal: AbortSignal) => Promise<void>): Promise<void> {
    const queue = live.hosts.map((_, i) => i);
    const worker = async (): Promise<void> => {
      for (let i = queue.shift(); i !== undefined; i = queue.shift()) {
        if (live.abort.signal.aborted) {
          this.update(live, i, { status: 'cancelled', error: '已取消', endedAt: this.now() });
          continue;
        }
        try {
          await one(i, live.abort.signal);
        } catch (e) {
          this.update(live, i, { status: live.abort.signal.aborted ? 'cancelled' : 'failed', error: (e as Error).message || String(e), endedAt: this.now() });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, Math.max(1, queue.length)) }, worker));
    this.finish(live);
  }

  /** 批量执行命令 / 脚本：立即返回任务，进度通过 batch.progress 推送 */
  async exec(input: BatchExecInput): Promise<BatchJob> {
    const hosts = this.targets(input?.hostIds);
    const command = String(input?.command ?? '');
    if (!command.trim()) throw new UserError('请输入要执行的命令');
    if (command.length > MAX_COMMAND) throw new UserError('命令太长（超过 256 KB）');
    const timeoutSec = Math.max(0, Math.min(86_400, Math.floor(Number(input?.timeoutSec) || 0)));
    const script = !!input?.script;
    const description = String(input?.description ?? '').trim().slice(0, 200);
    const id = randomUUID();
    const results = hosts.map((h) => this.hostResult(h));
    const live = this.create(
      { id, kind: 'exec', description, command, script, timeoutSec, remotePath: null, files: [], hostCount: hosts.length, fileCount: 0, status: 'running', createdAt: this.now(), endedAt: null },
      results,
    );
    const evals = new Map<string, Evaluation>();
    for (const h of hosts) evals.set(h.id, await this.d.approval.evaluate(command, this.ctx(h), { autoReadonly: true }));
    const remoteCmd = script ? scriptCommand(command, id) : command;
    void this.runAll(live, CONCURRENCY, async (i, signal) => {
      const h = hosts[i];
      const ev = evals.get(h.id)!;
      const audit = (decision: 'AUTO' | 'APPROVED' | 'DENIED', exitCode: number | null): void =>
        this.d.audit.command({ source: 'USER', hostId: h.id, hostName: h.name, command, risk: ev.effectiveLevel, decision, exitCode, detail: { batchId: id, description, script, reasons: ev.reasons } });
      if (ev.decision === 'DENY') {
        audit('DENIED', null);
        this.update(live, i, { status: 'denied', error: `命中黑名单，没有执行：${ev.reasons.join('；')}`, endedAt: this.now() });
        return;
      }
      this.update(live, i, { status: 'running', startedAt: this.now() });
      const conn = await this.d.pool.acquire(h.id, this.d.owner());
      try {
        const r = await execCommand(conn.client, remoteCmd, { timeoutMs: timeoutSec ? timeoutSec * 1000 : NO_LIMIT_MS, maxBytes: MAX_OUTPUT, signal, closeStdin: !script });
        // 用户在执行前已经确认过这条命令
        audit(ev.decision === 'AUTO' ? 'AUTO' : 'APPROVED', r.code);
        const output = `${r.stdout}${r.stderr ? `${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}` : ''}${r.truncated ? '\n…（输出太长，后面的没有保存）' : ''}`;
        const status: BatchHostStatus = r.aborted ? 'cancelled' : r.timedOut ? 'timeout' : r.code === 0 ? 'success' : 'failed';
        this.update(live, i, {
          status,
          exitCode: r.code,
          output,
          error: r.aborted ? '已取消' : r.timedOut ? `执行超时（${timeoutSec} 秒）` : r.code === 0 ? null : r.code === null ? '命令被终止' : `退出码 ${r.code}`,
          endedAt: this.now(),
        });
      } finally {
        this.d.pool.release(conn);
      }
    });
    return this.view(live);
  }

  /** 选中的本机文件 / 文件夹：大小和文件个数 */
  async inspectLocal(paths: string[]): Promise<BatchLocalItem[]> {
    const out: BatchLocalItem[] = [];
    for (const p of [...new Set((Array.isArray(paths) ? paths : []).map(String))].slice(0, 200)) {
      const st = await stat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        const files = await walk(p);
        out.push({ path: p, name: basename(p), dir: true, size: files.reduce((a, f) => a + f.size, 0), files: files.length });
      } else if (st.isFile()) out.push({ path: p, name: basename(p), dir: false, size: st.size, files: 1 });
    }
    return out;
  }

  /** 批量上传：每台主机把选中的文件 / 文件夹上传到远程目录（不存在时创建），同名文件覆盖 */
  async upload(input: BatchUploadInput): Promise<BatchJob> {
    const hosts = this.targets(input?.hostIds);
    const remotePath = String(input?.remotePath ?? '').trim();
    if (!remotePath) throw new UserError('请输入上传路径');
    const items = await this.inspectLocal(input?.localPaths ?? []);
    if (!items.length) throw new UserError('请选择要上传的文件');
    // 展开成文件列表：相对路径（文件夹保留目录结构）
    const files: { local: string; rel: string; size: number }[] = [];
    for (const it of items) {
      if (!it.dir) files.push({ local: it.path, rel: it.name, size: it.size });
      else for (const f of await walk(it.path)) files.push({ local: f.path, rel: posix.join(it.name, f.rel), size: f.size });
    }
    if (!files.length) throw new UserError('选择的文件夹是空的');
    const total = files.reduce((a, f) => a + f.size, 0);
    const description = String(input?.description ?? '').trim().slice(0, 200);
    const id = randomUUID();
    const results = hosts.map((h) => ({ ...this.hostResult(h), bytes: 0, totalBytes: total }));
    const live = this.create(
      { id, kind: 'upload', description, command: null, script: false, timeoutSec: 0, remotePath, files: items, hostCount: hosts.length, fileCount: files.length, status: 'running', createdAt: this.now(), endedAt: null },
      results,
    );
    this.d.audit.event('BATCH_UPLOAD', { batchId: id, description, remotePath, hosts: hosts.map((h) => h.name), files: items.map((f) => f.name), bytes: total });
    void this.runAll(live, UPLOAD_CONCURRENCY, async (i, signal) => {
      const h = hosts[i];
      this.update(live, i, { status: 'running', startedAt: this.now() });
      const ch = await this.d.sftp.openTemp(this.d.owner(), h.id);
      const stopOnAbort = (): void => ch.remote.abort();
      signal.addEventListener('abort', stopOnAbort, { once: true });
      try {
        const home = await ch.remote.realpath('.').catch(() => '/');
        const dir = resolveRemotePath(remotePath, { username: live.hosts[i].username ?? '', home });
        const lines: string[] = [`目标目录：${dir}`];
        await ensureDir(ch.remote, dir);
        let sent = 0;
        const made = new Set<string>([dir]);
        for (const f of files) {
          if (signal.aborted) throw new Error('已取消');
          const target = posix.join(dir, f.rel);
          const parent = posix.dirname(target);
          if (!made.has(parent)) {
            await ensureDir(ch.remote, parent);
            made.add(parent);
          }
          const counter = new Transform({
            transform: (chunk: Buffer, _enc, cb: TransformCallback) => {
              sent += chunk.length;
              this.update(live, i, { bytes: sent }, false);
              cb(null, chunk);
            },
          });
          try {
            await pipeline(createReadStream(f.local), counter, ch.remote.createWriteStream(target, { flags: 'w' }));
          } catch (e) {
            throw new Error(`${f.rel}：${(e as Error).message}`);
          }
          lines.push(`✓ ${f.rel}`);
          this.update(live, i, { output: lines.join('\n'), bytes: sent }, false);
        }
        this.update(live, i, { status: 'success', output: lines.join('\n'), bytes: total, endedAt: this.now() });
      } finally {
        signal.removeEventListener('abort', stopOnAbort);
        ch.close();
      }
    });
    return this.view(live);
  }

  cancel(id: string): void {
    this.live.get(String(id))?.abort.abort();
  }

  /** 退出 / 切换档案时：取消所有执行中的任务 */
  stopAll(): void {
    for (const l of this.live.values()) l.abort.abort();
  }

  delete(ids: string[]): void {
    const list = (Array.isArray(ids) ? ids : []).map(String);
    if (list.some((id) => this.live.has(id))) throw new UserError('任务还在执行中，结束后才能删除');
    const db = this.d.db;
    db.transaction(() => {
      for (const id of list) {
        db.prepare('DELETE FROM batch_job_host WHERE job_id = ?').run(id);
        db.prepare('DELETE FROM batch_job WHERE id = ?').run(id);
      }
    })();
  }

  private toJob(r: JobRow, hosts?: BatchHostResult[]): BatchJob {
    const live = this.live.get(r.id);
    if (live) return hosts ? this.view(live) : { ...live.job, counts: countsOf(live.hosts) };
    let files: BatchLocalItem[] = [];
    try {
      files = r.files ? (JSON.parse(r.files) as BatchLocalItem[]) : [];
    } catch {
      files = [];
    }
    const counts =
      hosts ? countsOf(hosts) : (() => {
        const rows = this.d.db.prepare<[string], { status: string; n: number }>('SELECT status, count(*) AS n FROM batch_job_host WHERE job_id = ? GROUP BY status').all(r.id);
        const c = { success: 0, failed: 0, running: 0, pending: 0 };
        for (const x of rows) {
          if (x.status === 'success') c.success += x.n;
          else if (x.status === 'running') c.running += x.n;
          else if (x.status === 'pending') c.pending += x.n;
          else c.failed += x.n;
        }
        return c;
      })();
    return {
      id: r.id,
      kind: r.kind as BatchJob['kind'],
      description: r.description,
      command: r.command,
      script: !!r.script,
      timeoutSec: r.timeout_sec,
      remotePath: r.remote_path,
      files,
      hostCount: r.host_count,
      fileCount: r.file_count,
      status: r.status as BatchStatus,
      createdAt: r.created_at,
      endedAt: r.ended_at,
      counts,
      ...(hosts ? { hosts } : {}),
    };
  }

  list(f: BatchFilter): { items: BatchJob[]; total: number } {
    const where: string[] = ['kind = ?'];
    const args: (string | number)[] = [f?.kind === 'upload' ? 'upload' : 'exec'];
    if (f?.q?.trim()) {
      const like = `%${f.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push("(description LIKE ? ESCAPE '\\' OR command LIKE ? ESCAPE '\\' OR remote_path LIKE ? ESCAPE '\\' OR files LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
    if (f?.status) {
      where.push('status = ?');
      args.push(f.status);
    }
    if (f?.from) {
      where.push('created_at >= ?');
      args.push(f.from);
    }
    if (f?.to) {
      where.push('created_at < ?');
      args.push(f.to);
    }
    const w = where.join(' AND ');
    const total = this.d.db.prepare<(string | number)[], { n: number }>(`SELECT count(*) AS n FROM batch_job WHERE ${w}`).get(...args)?.n ?? 0;
    const items = this.d.db
      .prepare<(string | number)[], JobRow>(`SELECT * FROM batch_job WHERE ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Math.max(1, f?.limit ?? 20), 200), Math.max(0, f?.offset ?? 0))
      .map((r) => this.toJob(r));
    return { items, total };
  }

  get(id: string): BatchJob {
    const live = this.live.get(String(id));
    if (live) return this.view(live);
    const r = this.d.db.prepare<[string], JobRow>('SELECT * FROM batch_job WHERE id = ?').get(String(id));
    if (!r) throw new UserError('执行记录不存在');
    const hosts = this.d.db
      .prepare<[string], HostRow>('SELECT * FROM batch_job_host WHERE job_id = ? ORDER BY rowid')
      .all(r.id)
      .map(
        (h): BatchHostResult => ({
          hostId: h.host_id,
          hostName: h.host_name,
          address: h.address,
          username: h.username,
          status: h.status as BatchHostStatus,
          exitCode: h.exit_code,
          output: h.output,
          error: h.error,
          startedAt: h.started_at,
          endedAt: h.ended_at,
        }),
      );
    return this.toJob(r, hosts);
  }
}

/** 远程目录逐级创建（已存在的跳过） */
async function ensureDir(remote: RemoteFs, dir: string): Promise<void> {
  const st = await remote.exists(dir);
  if (st) {
    if (fileTypeOf(st.mode) !== 'dir') throw new Error(`${dir} 已存在，但不是目录`);
    return;
  }
  const parent = posix.dirname(dir);
  if (parent !== dir) await ensureDir(remote, parent);
  try {
    await remote.mkdir(dir);
  } catch (e) {
    // 并发创建时可能已经被建好
    const again = await remote.exists(dir);
    if (!again || fileTypeOf(again.mode) !== 'dir') throw new Error(`创建目录 ${dir} 失败：${(e as Error).message}`);
  }
}

/** 本机文件夹里的所有文件（跳过符号链接） */
async function walk(root: string, rel = ''): Promise<{ path: string; rel: string; size: number }[]> {
  const out: { path: string; rel: string; size: number }[] = [];
  const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const r = rel ? posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile()) {
      const st = await stat(join(root, r)).catch(() => null);
      if (st) out.push({ path: join(root, r), rel: r, size: st.size });
    }
    if (out.length > 20_000) throw new UserError('文件太多（超过 2 万个），请打包后再上传');
  }
  return out;
}
