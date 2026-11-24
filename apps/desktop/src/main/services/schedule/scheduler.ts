import { randomUUID } from 'node:crypto';
import {
  describeSchedule,
  nextRunAt,
  validateSchedule,
  type AgentPolicy,
  type AgentStep,
  type Host,
  type LocalTask,
  type LocalTaskInput,
  type ScheduleApproval,
  type ScheduleCheck,
  type ScheduleSpec,
  type TaskHostStatus,
  type TaskPlan,
  type TaskPlanStep,
  type TaskPlanGen,
  type TaskRunFilter,
  type TaskRunStep,
  type TaskRunView,
  type TaskTrialResult,
  type ReportLevel,
  type TaskAlertOptions,
  REPORT_LEVEL_LABEL,
} from '@itm/protocol';
import type { RaiseInput } from '../alert/alert-center';
import { AUTO_APPROVE_PROMPT, parseAutoApprove } from '@itm/agent-core';
import { applyPolicy, type ApprovalEngine, type EvaluateContext, type PolicyConfig } from '@itm/approval';
import type { Db } from '../db/database';
import type { HostRepo } from '../hosts/host-repo';
import type { SshPool } from '../connection/ssh-pool';
import { execCommand } from '../connection/exec';
import type { AuditRepo } from '../audit/audit-repo';
import type { AgentService } from '../ai/agent-service';
import { UserError } from '../../util/errors';
import { classifySql } from '@itm/approval';
import type { Masker } from '@itm/masking';
import type { ReportWebhook, SqlReportOptions } from '@itm/protocol';
import type { DbService } from '../database/db-service';
import { dialectOf } from '../database/db-tools';
import { normalizeReport, normalizeWebhook, runSqlReport, sendWebhook, testMessage, type ReportDeps } from './sql-report';
import type { Recorder } from '../audit/recording-store';
import { levelFromHosts, normalizePlan, parseReportLevel, parseTrialAnswer, recordingText, REPORT_SYSTEM_PROMPT, reportInput, stepsFor, trialPrompt } from './plan';

const MAX_OUTPUT = 64 * 1024;
const CONCURRENCY = 5;
const TICK_MS = 15_000;
const APPROVAL_TIMEOUT_MS = 30 * 60_000;
const AI_POLICIES = ['READONLY', 'AI_REVIEW', 'APPROVE', 'AUTO'] as const;
/** 试运行的超时 */
const TRIAL_TIMEOUT_MS = 10 * 60_000;
/** 执行方案里单条命令的超时上限 */
const STEP_TIMEOUT_MS = 10 * 60_000;
const STEP_OUTPUT = 16 * 1024;
const ACTIVE: TaskHostStatus[] = ['PENDING', 'RUNNING', 'WAITING_APPROVAL'];

interface TaskRow {
  id: string;
  name: string;
  enabled: number;
  type: LocalTask['type'];
  command: string | null;
  prompt: string | null;
  host_ids: string;
  schedule: string;
  ai_assist: number;
  goal: string | null;
  ai_policy: LocalTask['aiPolicy'];
  timeout_min: number;
  notify_on_failure: number;
  created_by: LocalTask['createdBy'];
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: LocalTask['lastStatus'];
  db_id: string | null;
  db_database: string | null;
  report: string | null;
  plan: string | null;
  plan_gen?: string | null;
  alert: string | null;
}

interface RunRow {
  run_id: string;
  task_id: string;
  task_name: string | null;
  type: TaskRunView['type'];
  target: string;
  status: TaskRunView['status'];
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  hosts: string;
  origin: 'SERVER' | 'LOCAL';
  conversation_id: string | null;
  report_level?: string | null;
}

const toTask = (r: TaskRow): LocalTask => ({
  id: r.id,
  name: r.name,
  enabled: !!r.enabled,
  type: r.type,
  command: r.command,
  prompt: r.prompt,
  hostIds: JSON.parse(r.host_ids) as string[],
  schedule: JSON.parse(r.schedule) as ScheduleSpec,
  aiAssist: !!r.ai_assist,
  goal: r.goal,
  aiPolicy: r.ai_policy,
  timeoutMin: r.timeout_min,
  notifyOnFailure: !!r.notify_on_failure,
  createdBy: r.created_by,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  nextRunAt: r.next_run_at,
  lastRunAt: r.last_run_at,
  lastStatus: r.last_status,
  ...(r.type === 'SQL' ? { dbId: r.db_id, database: r.db_database, report: r.report ? (JSON.parse(r.report) as SqlReportOptions) : null } : {}),
  ...(r.type === 'AGENT_PROMPT' ? { plan: r.plan ? (JSON.parse(r.plan) as TaskPlan) : null, planGen: r.plan_gen ? (JSON.parse(r.plan_gen) as TaskPlanGen) : null } : {}),
  alert: r.alert ? (JSON.parse(r.alert) as TaskAlertOptions) : null,
});

/** 告警设置：不认识的值按不告警 */
function normalizeAlert(a: TaskAlertOptions | null | undefined): TaskAlertOptions | null {
  if (!a || typeof a !== 'object' || !['FAILED', 'ISSUES', 'ALWAYS'].includes(a.when)) return null;
  return { when: a.when, email: a.email !== false };
}

export const toRunView = (r: RunRow): TaskRunView => ({
  runId: r.run_id,
  taskId: r.task_id,
  taskName: r.task_name,
  type: r.type,
  target: r.target,
  status: r.status,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  summary: r.summary,
  hosts: JSON.parse(r.hosts) as TaskRunView['hosts'],
  origin: r.origin,
  conversationId: r.conversation_id,
  reportLevel: r.report_level === 'OK' || r.report_level === 'WARN' || r.report_level === 'ERROR' ? r.report_level : null,
});

/** 通知正文：报告的前几行 */
const firstLines = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n')
    .slice(0, 200);
const clip = (s: string, max = MAX_OUTPUT): string => (s.length > max ? `${s.slice(0, max)}\n…（输出超过 ${Math.round(max / 1024)}KB，已截断）` : s);
const tail = (s: string, max: number): string => (s.length > max ? `…${s.slice(-max)}` : s);

/**
 * 定时任务里 Agent 的写操作：等用户在「定时任务」页批准（应用不在前台时发系统通知），超时按拒绝处理。
 */
export class ScheduleApprovals {
  private readonly pending = new Map<string, { a: ScheduleApproval; resolve(ok: boolean): void; timer: NodeJS.Timeout }>();

  constructor(private readonly d: { emit(list: ScheduleApproval[]): void; notify(a: ScheduleApproval): void; now?: () => number }) {}

  list(): ScheduleApproval[] {
    return [...this.pending.values()].map((p) => p.a).sort((a, b) => a.createdAt - b.createdAt);
  }

  request(a: Omit<ScheduleApproval, 'id' | 'createdAt' | 'expiresAt'>, timeoutMs = APPROVAL_TIMEOUT_MS): Promise<boolean> {
    const now = (this.d.now ?? Date.now)();
    const full: ScheduleApproval = { ...a, id: randomUUID(), createdAt: now, expiresAt: now + timeoutMs };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.finish(full.id, false), timeoutMs);
      timer.unref?.();
      this.pending.set(full.id, { a: full, resolve, timer });
      this.d.emit(this.list());
      this.d.notify(full);
    });
  }

  decide(id: string, approve: boolean): void {
    if (!this.pending.has(id)) throw new UserError('这条审批已经处理过或已过期');
    this.finish(id, approve);
  }

  /** 任务取消 / 结束时拒绝它还没处理的审批 */
  cancelRun(runId: string): void {
    for (const p of [...this.pending.values()]) if (p.a.runId === runId) this.finish(p.a.id, false);
  }

  stop(): void {
    for (const id of [...this.pending.keys()]) this.finish(id, false);
  }

  private finish(id: string, ok: boolean): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(ok);
    this.d.emit(this.list());
  }
}

export interface SchedulerDeps {
  db: Db;
  hosts: HostRepo;
  pool: SshPool;
  approval: ApprovalEngine;
  policy(): PolicyConfig;
  audit: AuditRepo;
  agent: Pick<AgentService, 'runUnattended'>;
  /** 连接主机、显示提示用的窗口 */
  owner(): number;
  emitRun(run: TaskRunView): void;
  emitTasks(list: LocalTask[]): void;
  emitApprovals(list: ScheduleApproval[]): void;
  /** 系统通知（应用不在前台时） */
  notify(title: string, body: string): void;
  /** 数据库（SQL 报表，第十八轮）；没有时不能创建 SQL 报表 */
  databases?: DbService;
  /** SQL 报表的 AI 总结和脱敏 */
  ask?: ReportDeps['ask'];
  masker?: () => Masker;
  fetch?: ReportDeps['fetch'];
  /** 执行方案的终端录像（受「会话录像」和主机的录像开关控制，第二十七轮） */
  recordings?: { start(meta: { sessionId: string; kind: 'schedule'; hostId: string; hostName: string; cols: number; rows: number }): Recorder | null };
  /** 试运行的进度 */
  emitTrial?(token: string, text: string): void;
  /** 告警中心（第二十八轮）：按任务的告警设置记录告警、自动排查、发邮件 */
  alerts?: { raise(input: RaiseInput): unknown; resolvePrefix(prefix: string): void };
  now?: () => number;
}

/**
 * 本机定时任务（第四轮）：用户手动创建，或 Agent 用 schedule_task 创建（用户批准后）。应用运行时每 15 秒检查一次到期的任务。
 * - 命令任务：逐台主机执行（创建任务时用户已经确认过这条命令，执行时只检查是否被策略禁止）；开启「AI 协助」时，
 *   失败的主机交给 Agent 朝着「最终目的」排查处理，处理完再执行一次原命令验证。
 * - AI 任务：每次执行时把任务描述交给 Agent（无人值守），写操作按任务的权限上限决定自动执行还是等用户批准。
 * 执行记录和服务端派发的任务一起放在 task_run 表（origin = LOCAL）。
 */
export class LocalScheduler {
  readonly approvals: ScheduleApprovals;
  private readonly running = new Map<string, { runId: string; abort: AbortController }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: SchedulerDeps) {
    this.approvals = new ScheduleApprovals({
      emit: d.emitApprovals,
      notify: (a) => d.notify(`定时任务「${a.taskName}」等你批准`, `${a.hostName}：${a.command}`.slice(0, 200)),
      now: d.now,
    });
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  start(): void {
    if (this.timer) return;
    // 应用没运行时错过的执行不补跑：从现在重新算下一次
    const now = this.now();
    for (const t of this.list()) {
      if (!t.enabled || t.nextRunAt === null || t.nextRunAt > now - 60_000) continue;
      const next = t.schedule.kind === 'once' ? null : nextRunAt(t.schedule, now);
      this.d.db.prepare('UPDATE schedule_task SET next_run_at = ?, enabled = ? WHERE id = ?').run(next, next === null ? 0 : 1, t.id);
    }
    // 上次退出时还在后台生成的执行方案：标记为中断，用户点「重新生成」
    for (const t of this.list()) {
      if (t.planGen?.status === 'RUNNING' && !this.gens.has(t.id)) this.setGen(t.id, { ...t.planGen, status: 'FAILED', endedAt: now, message: '应用退出，生成中断了，请重新生成' });
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const r of this.running.values()) r.abort.abort();
    for (const g of this.gens.values()) g.abort();
    this.gens.clear();
    this.approvals.stop();
  }

  /** 执行到期的任务（测试里直接调用） */
  tick(): void {
    const due = this.d.db
      .prepare<[number], TaskRow>('SELECT * FROM schedule_task WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?')
      .all(this.now())
      .map(toTask);
    // 执行方案还在后台生成的 AI 任务先不执行，生成好后再按计划执行
    for (const t of due) if (!this.running.has(t.id) && !this.gens.has(t.id)) void this.execute(t, false).catch(() => undefined);
  }

  // ---------------------------------------------------------------- 任务

  list(): LocalTask[] {
    return this.d.db.prepare<[], TaskRow>('SELECT * FROM schedule_task ORDER BY created_at').all().map((r) => this.withProgress(toTask(r)));
  }

  get(id: string): LocalTask | null {
    const r = this.d.db.prepare<[string], TaskRow>('SELECT * FROM schedule_task WHERE id = ?').get(id);
    return r ? this.withProgress(toTask(r)) : null;
  }

  /** 后台生成执行方案的进度只放在内存里（变化太频繁，不写库） */
  private withProgress(t: LocalTask): LocalTask {
    const p = this.genProgress.get(t.id);
    return p && t.planGen?.status === 'RUNNING' ? { ...t, planGen: { ...t.planGen, message: p } } : t;
  }

  /** 检查输入；有问题时抛出 UserError */
  validate(input: LocalTaskInput): LocalTaskInput {
    if (!input || typeof input !== 'object') throw new UserError('任务内容不正确');
    const name = String(input.name ?? '').trim();
    if (!name) throw new UserError('请填写任务名称');
    if (name.length > 60) throw new UserError('任务名称最多 60 个字');
    if (input.type !== 'COMMAND' && input.type !== 'AGENT_PROMPT' && input.type !== 'SQL') throw new UserError('任务类型不正确');
    if (input.type === 'SQL') return this.validateSql(input, name);
    const command = input.type === 'COMMAND' ? String(input.command ?? '').trim() : null;
    const prompt = input.type === 'AGENT_PROMPT' ? String(input.prompt ?? '').trim() : null;
    if (input.type === 'COMMAND' && !command) throw new UserError('请填写要执行的命令');
    if (command && command.length > 10_000) throw new UserError('命令太长（最多 10000 个字符）');
    if (input.type === 'AGENT_PROMPT' && !prompt) throw new UserError('请填写交给 Agent 的任务描述');
    if (prompt && prompt.length > 4000) throw new UserError('任务描述太长（最多 4000 个字）');
    const hostIds = Array.isArray(input.hostIds) ? [...new Set(input.hostIds.map(String))] : [];
    if (!hostIds.length) throw new UserError('请选择目标主机');
    if (hostIds.length > 100) throw new UserError('一个任务最多 100 台主机');
    let plan: TaskPlan | null = null;
    if (input.type === 'AGENT_PROMPT' && input.plan) {
      try {
        plan = normalizePlan(input.plan, hostIds, normalizeWebhook);
      } catch (e) {
        throw new UserError((e as Error).message);
      }
      if (plan && !plan.steps.length) plan = null;
    }
    for (const id of hostIds) {
      const h = this.d.hosts.get(id);
      if (!h) throw new UserError('有主机已被删除，请重新选择');
      if (input.type === 'COMMAND' && h.protocol !== 'SSH') throw new UserError(`「${h.name}」是 ${h.protocol} 主机，命令任务只支持 SSH 主机`);
      if (plan && h.protocol !== 'SSH') throw new UserError(`「${h.name}」是 ${h.protocol} 主机，按执行方案执行只支持 SSH 主机`);
    }
    const err = validateSchedule(input.schedule, this.now());
    if (err) throw new UserError(err);
    const goal = input.goal ? String(input.goal).trim().slice(0, 1000) || null : null;
    const aiPolicy = AI_POLICIES.includes(input.aiPolicy) ? input.aiPolicy : 'APPROVE';
    const timeoutMin = Math.min(Math.max(Math.round(Number(input.timeoutMin) || 30), 1), 1440);
    return {
      name,
      enabled: input.enabled !== false,
      type: input.type,
      command,
      prompt,
      hostIds,
      schedule: input.schedule,
      aiAssist: input.type === 'COMMAND' && !!input.aiAssist,
      goal,
      aiPolicy,
      timeoutMin,
      notifyOnFailure: input.notifyOnFailure !== false,
      ...(input.type === 'AGENT_PROMPT' ? { plan } : {}),
      alert: normalizeAlert(input.alert),
    };
  }

  /** SQL 报表：一个数据库、一条只读 SQL、报表设置（文档一 6.32.3） */
  private validateSql(input: LocalTaskInput, name: string): LocalTaskInput {
    if (!this.d.databases) throw new UserError('这里不支持 SQL 报表');
    const asset = input.dbId ? this.d.databases.get(input.dbId) : null;
    if (!asset) throw new UserError('请选择数据库');
    const sql = String(input.command ?? '').trim();
    if (!sql) throw new UserError('请填写 SQL');
    const c = classifySql(sql, dialectOf(asset.type));
    if (c.level !== 'L0') throw new UserError(`SQL 报表只能执行一条只读 SQL：${c.reasons.join('；')}`);
    const err = validateSchedule(input.schedule, this.now());
    if (err) throw new UserError(err);
    return {
      name,
      enabled: input.enabled !== false,
      type: 'SQL',
      command: sql,
      prompt: null,
      hostIds: [],
      schedule: input.schedule,
      aiAssist: false,
      goal: null,
      aiPolicy: 'READONLY',
      timeoutMin: Math.min(Math.max(Math.round(Number(input.timeoutMin) || 10), 1), 120),
      notifyOnFailure: input.notifyOnFailure !== false,
      dbId: asset.id,
      database: String(input.database ?? '').trim().slice(0, 128) || null,
      report: normalizeReport(input.report),
      alert: normalizeAlert(input.alert),
    };
  }

  /** 编辑框里的「发送测试消息」 */
  async testWebhook(w: ReportWebhook): Promise<void> {
    await sendWebhook(normalizeWebhook(w), testMessage(this.now()), { fetch: this.d.fetch, now: () => this.now() });
  }

  /**
   * 保存任务。opts.generatePlan：AI 任务没有执行方案时在后台生成，生成好后自动设置（第二十九轮，编辑框和 Agent 创建的任务用）；
   * 不传时保持原来的行为（没有方案的 AI 任务每次交给 Agent 自由执行）。
   */
  save(id: string | null, raw: LocalTaskInput, createdBy: LocalTask['createdBy'] = 'USER', opts: { generatePlan?: boolean } = {}): LocalTask {
    const v = this.validate(raw);
    const before = id ? this.get(id) : null;
    if (v.type === 'COMMAND') {
      const denied = this.checkSync(v.command!, v.hostIds, createdBy).find((c) => c.decision === 'DENY');
      if (denied) throw new UserError(`这条命令在「${denied.hostName}」上会被拒绝：${denied.reasons.join('；')}`);
    }
    if (v.type === 'AGENT_PROMPT' && v.plan) {
      // 执行方案：被策略禁止的命令不能保存；「只读」权限下不能有写操作
      for (const step of v.plan.steps) {
        const checks = this.checkSync(step.command, step.hostId ? [step.hostId] : v.hostIds, 'USER');
        const denied = checks.find((c) => c.decision === 'DENY');
        if (denied) throw new UserError(`方案里的命令「${step.command.split('\n')[0].slice(0, 60)}」在「${denied.hostName}」上会被拒绝：${denied.reasons.join('；')}`);
        const write = checks.find((c) => c.level !== 'L0');
        if (write && v.aiPolicy === 'READONLY') throw new UserError(`权限是「只读」，方案里不能有写操作：「${step.command.split('\n')[0].slice(0, 60)}」（可以改成「AI 审批」或「保存时我确认」）`);
      }
    }
    const now = this.now();
    const next = v.enabled ? nextRunAt(v.schedule, now) : null;
    const existed = !!id;
    if (id) {
      if (!this.get(id)) throw new UserError('任务不存在');
      this.d.db
        .prepare(
          `UPDATE schedule_task SET name = ?, enabled = ?, type = ?, command = ?, prompt = ?, host_ids = ?, schedule = ?, ai_assist = ?, goal = ?, ai_policy = ?,
             timeout_min = ?, notify_on_failure = ?, updated_at = ?, next_run_at = ?, db_id = ?, db_database = ?, report = ?, plan = ?, alert = ? WHERE id = ?`,
        )
        .run(v.name, v.enabled ? 1 : 0, v.type, v.command, v.prompt, JSON.stringify(v.hostIds), JSON.stringify(v.schedule), v.aiAssist ? 1 : 0, v.goal, v.aiPolicy, v.timeoutMin, v.notifyOnFailure ? 1 : 0, now, next, ...sqlCols(v), planCol(v), alertCol(v), id);
    } else {
      id = randomUUID();
      this.d.db
        .prepare(
          `INSERT INTO schedule_task (id, name, enabled, type, command, prompt, host_ids, schedule, ai_assist, goal, ai_policy, timeout_min, notify_on_failure, created_by, created_at, updated_at, next_run_at, db_id, db_database, report, plan, alert)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, v.name, v.enabled ? 1 : 0, v.type, v.command, v.prompt, JSON.stringify(v.hostIds), JSON.stringify(v.schedule), v.aiAssist ? 1 : 0, v.goal, v.aiPolicy, v.timeoutMin, v.notifyOnFailure ? 1 : 0, createdBy, now, now, next, ...sqlCols(v), planCol(v), alertCol(v));
    }
    // AI 任务没有执行方案：在后台生成，生成好后自动设置（第二十九轮）；手动给了方案时停止还在进行的生成
    if (v.type === 'AGENT_PROMPT') {
      const gen = this.get(id)!.planGen;
      if (v.plan) {
        if (this.gens.has(id)) {
          this.gens.get(id)!.abort();
          this.gens.delete(id);
          this.setGen(id, null);
        }
      } else if (this.gens.has(id) || opts.generatePlan) {
        // 正在生成且任务说明、主机都没变：接着生成，不重新开始
        const same = !!before && before.prompt === v.prompt && before.goal === v.goal && JSON.stringify(before.hostIds) === JSON.stringify(v.hostIds);
        if (!(gen?.status === 'RUNNING' && this.gens.has(id) && same)) this.startPlanGen(id);
      }
    } else if (this.gens.has(id)) {
      this.gens.get(id)!.abort();
      this.gens.delete(id);
      this.setGen(id, null);
    }
    const saved = this.get(id)!;
    this.d.audit.event(
      existed ? 'SCHEDULE_UPDATE' : 'SCHEDULE_CREATE',
      {
        taskId: id,
        name: v.name,
        type: v.type,
        ...(v.type === 'SQL' ? { sql: v.command, db: this.d.databases?.get(v.dbId ?? '')?.name ?? v.dbId, webhooks: v.report?.webhooks.length ?? 0 } : v.command ? { command: v.command } : { prompt: v.prompt }),
        ...(v.plan ? { plan: v.plan.steps.map((st) => (st.hostId ? `[${this.d.hosts.get(st.hostId)?.name ?? st.hostId}] ${st.command}` : st.command)) } : {}),
        hosts: v.hostIds.map((h) => this.d.hosts.get(h)?.name ?? h),
        schedule: describeSchedule(v.schedule),
        aiAssist: v.aiAssist,
        aiPolicy: v.aiPolicy,
      },
      createdBy === 'AGENT' ? 'AGENT' : 'USER',
    );
    this.changed();
    return saved;
  }

  delete(id: string): void {
    const r = this.running.get(id);
    if (r) {
      r.abort.abort();
      this.approvals.cancelRun(r.runId);
    }
    this.gens.get(id)?.abort();
    this.gens.delete(id);
    const t = this.get(id);
    this.d.db.prepare('DELETE FROM schedule_task WHERE id = ?').run(id);
    if (t) this.d.audit.event('SCHEDULE_DELETE', { taskId: id, name: t.name });
    this.changed();
  }

  enable(id: string, enabled: boolean): LocalTask {
    const t = this.get(id);
    if (!t) throw new UserError('任务不存在');
    const next = enabled ? nextRunAt(t.schedule, this.now()) : null;
    if (enabled && next === null) throw new UserError(t.schedule.kind === 'once' ? '执行时间已经过去，请编辑任务修改时间' : '计划无效，请编辑任务');
    this.d.db.prepare('UPDATE schedule_task SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, next, this.now(), id);
    this.changed();
    return this.get(id)!;
  }

  /** 立即执行一次（不影响计划） */
  runNow(id: string): { runId: string } {
    const t = this.get(id);
    if (!t) throw new UserError('任务不存在');
    if (this.running.has(id)) throw new UserError('这个任务正在执行');
    if (this.gens.has(id)) throw new UserError('执行方案还在后台生成，生成好后再执行');
    const runId = randomUUID();
    void this.execute(t, true, runId).catch(() => undefined);
    return { runId };
  }

  cancel(runId: string): void {
    for (const r of this.running.values()) {
      if (r.runId !== runId) continue;
      r.abort.abort();
      this.approvals.cancelRun(runId);
      return;
    }
  }

  /** 每台主机上这条命令的判定：只有被策略禁止的主机不能执行 */
  async check(command: string, hostIds: string[], createdBy: LocalTask['createdBy'] = 'USER'): Promise<ScheduleCheck[]> {
    const out: ScheduleCheck[] = [];
    for (const id of hostIds.slice(0, 100)) {
      const h = this.d.hosts.get(id);
      if (!h) continue;
      const ev = await this.evaluate(command, h, createdBy);
      out.push({ hostId: h.id, hostName: h.name, level: ev.effectiveLevel, decision: ev.decision === 'DENY' ? 'DENY' : 'RUN', reasons: ev.reasons });
    }
    return out;
  }

  /** 保存时的同步检查（只看规则分类，不调用 LLM 复核） */
  private checkSync(command: string, hostIds: string[], createdBy: LocalTask['createdBy']): ScheduleCheck[] {
    return hostIds.flatMap((id) => {
      const h = this.d.hosts.get(id);
      if (!h) return [];
      const ev = applyPolicy(this.d.approval.classify(command), command, this.policyCtx(h, createdBy), true);
      return [{ hostId: h.id, hostName: h.name, level: ev.effectiveLevel, decision: ev.decision === 'DENY' ? ('DENY' as const) : ('RUN' as const), reasons: ev.reasons }];
    });
  }

  private policyCtx(h: Host, createdBy: LocalTask['createdBy']): EvaluateContext {
    const eff = this.d.hosts.effective(h.id, null);
    // 用户自己写的命令不受「Agent 权限」限制；Agent 创建的任务按主机的 Agent 权限
    const agentPolicy: AgentPolicy = createdBy === 'AGENT' ? eff.agentPolicy : 'AUTO';
    return { hostDenylist: h.cmdDenylist, agentPolicy, production: eff.production, folderNames: eff.folderPath ? eff.folderPath.split(' / ') : [], policy: this.d.policy() };
  }

  private evaluate(command: string, h: Host, createdBy: LocalTask['createdBy']): ReturnType<ApprovalEngine['evaluate']> {
    return this.d.approval.evaluate(command, this.policyCtx(h, createdBy), { autoReadonly: true });
  }

  /** 执行记录（第二十七轮加了按主机、状态、关键字、时间筛选） */
  runs(f: TaskRunFilter = {}): { items: TaskRunView[]; total: number } {
    const conds: string[] = [];
    const args: unknown[] = [];
    if (f.taskId) {
      conds.push('task_id = ?');
      args.push(f.taskId);
    }
    if (f.hostId) {
      // hosts 是 JSON 数组：按 "hostId":"…" 匹配（ID 是 UUID，不会误中）
      conds.push('instr(hosts, ?) > 0');
      args.push(JSON.stringify({ hostId: f.hostId }).slice(1, -1));
    }
    if (f.status === 'ISSUES') conds.push("(status IN ('FAILED', 'PARTIAL', 'TIMEOUT') OR report_level IN ('WARN', 'ERROR'))");
    else if (f.status) {
      conds.push('status = ?');
      args.push(f.status);
    }
    const q = f.q?.trim();
    if (q) {
      conds.push("(instr(lower(coalesce(task_name, '')), lower(?)) > 0 OR instr(lower(target), lower(?)) > 0 OR instr(lower(coalesce(summary, '')), lower(?)) > 0)");
      args.push(q, q, q);
    }
    if (f.from) {
      conds.push('started_at >= ?');
      args.push(f.from);
    }
    if (f.to) {
      conds.push('started_at <= ?');
      args.push(f.to);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = this.d.db.prepare<unknown[], { n: number }>(`SELECT count(*) AS n FROM task_run ${where}`).get(...args)?.n ?? 0;
    const items = this.d.db
      .prepare<unknown[], RunRow>(`SELECT * FROM task_run ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Math.max(1, f.limit ?? 50), 200), Math.max(0, f.offset ?? 0))
      .map(toRunView);
    return { items, total };
  }

  run(runId: string): TaskRunView | null {
    const r = this.d.db.prepare<[string], RunRow>('SELECT * FROM task_run WHERE run_id = ?').get(runId);
    return r ? toRunView(r) : null;
  }

  // ---------------------------------------------------------------- 执行方案（第二十七轮）

  private readonly trials = new Map<string, AbortController>();

  /** 执行方案每条命令在每台主机上的判定 */
  async checkPlan(steps: TaskPlanStep[], hostIds: string[]): Promise<ScheduleCheck[][]> {
    const out: ScheduleCheck[][] = [];
    for (const st of steps.slice(0, 50)) {
      const command = String(st?.command ?? '').trim();
      out.push(command ? await this.check(command, st.hostId ? [st.hostId] : hostIds, 'USER') : []);
    }
    return out;
  }

  /**
   * 试运行：AI 用只读命令在目标主机上做一次任务里的检查，给出以后定时执行的命令清单和汇总要求。
   * 写操作不会执行（权限上限只读、审批一律拒绝），交互类工具（提问、主机记忆）不提供。
   */
  async trial(owner: number, token: string, raw: LocalTaskInput): Promise<TaskTrialResult> {
    if (raw?.type !== 'AGENT_PROMPT') throw new UserError('只有 AI 任务需要试运行');
    const v = this.validate({ ...raw, name: String(raw.name ?? '').trim() || '未命名任务', plan: null });
    if (this.trials.has(token)) throw new UserError('试运行已经在进行');
    const ctl = new AbortController();
    this.trials.set(token, ctl);
    try {
      return await this.generate(owner, v, raw.plan?.push ?? null, ctl.signal, (text) => this.d.emitTrial?.(token, text));
    } finally {
      this.trials.delete(token);
    }
  }

  /** 试运行生成执行方案（编辑框里的试运行和后台生成共用） */
  private async generate(owner: number, v: LocalTaskInput, push: TaskPlan['push'], signal: AbortSignal, onProgress: (text: string) => void): Promise<TaskTrialResult> {
    const hosts = v.hostIds.map((id) => this.d.hosts.get(id)).filter((h): h is Host => !!h);
    onProgress('正在连接主机…');
    const r = await this.d.agent.runUnattended(owner, {
      kind: 'prompt',
      title: `${v.name}（试运行）`,
      prompt: trialPrompt({ name: v.name, prompt: v.prompt ?? '', goal: v.goal, hosts }),
      hostIds: hosts.map((h) => h.id),
      policyCap: 'READONLY',
      timeoutMs: TRIAL_TIMEOUT_MS,
      note: '（定时任务试运行：只执行只读命令，写操作不会执行）',
      approvalLabel: '试运行',
      approve: () => Promise.resolve(false),
      signal,
      onProgress,
    });
    if (r.status === 'CANCELLED') throw new UserError('已取消试运行');
    if (r.status === 'TIMEOUT') throw new UserError('试运行超时（10 分钟），可以把任务说明写得更具体一些再试');
    if (r.status === 'FAILED') throw new UserError(`试运行失败：${r.text || '模型没有返回结果'}`);
    const text = r.restore(r.text);
    const parsed = parseTrialAnswer(
      text,
      hosts,
      r.steps.map((st) => ({ ...st, command: r.restore(st.command) })),
    );
    if (!parsed.steps.length) throw new UserError('AI 没有给出可以定时执行的命令，可以把任务说明写得更具体一些再试，或者手动添加命令');
    const plan = normalizePlan({ steps: parsed.steps, report: parsed.report, generatedAt: this.now(), conversationId: r.conversationId, push }, v.hostIds, normalizeWebhook)!;
    this.d.audit.event('SCHEDULE_TRIAL', { name: v.name, hosts: hosts.map((h) => h.name), steps: plan.steps.length, conversationId: r.conversationId });
    return { plan, report: parsed.body + (parsed.fromSteps ? '\n\n（AI 没有按格式给出方案，下面的命令取自试运行里成功执行过的只读命令，请检查后保存。）' : ''), conversationId: r.conversationId };
  }

  // ---------------------------------------------------------------- 后台生成执行方案（第二十九轮）

  private readonly gens = new Map<string, AbortController>();
  private readonly genProgress = new Map<string, string>();
  private genEmitAt = 0;
  private genEmitTimer: NodeJS.Timeout | null = null;

  private setGen(id: string, gen: TaskPlanGen | null): void {
    this.d.db.prepare('UPDATE schedule_task SET plan_gen = ? WHERE id = ?').run(gen ? JSON.stringify(gen) : null, id);
    if (gen?.status !== 'RUNNING') this.genProgress.delete(id);
  }

  /** 进度变化很频繁：最多每秒推送一次任务列表 */
  private emitGenProgress(): void {
    if (this.genEmitTimer) return;
    const wait = Math.max(0, 1000 - (Date.now() - this.genEmitAt));
    this.genEmitTimer = setTimeout(() => {
      this.genEmitTimer = null;
      this.genEmitAt = Date.now();
      this.changed();
    }, wait);
    this.genEmitTimer.unref?.();
  }

  /** 开始（或重新开始）后台生成；生成好后自动设置到任务上 */
  startPlanGen(id: string): LocalTask {
    const t = this.get(id);
    if (!t) throw new UserError('任务不存在');
    if (t.type !== 'AGENT_PROMPT') throw new UserError('只有 AI 任务需要生成执行方案');
    if (this.running.has(id)) throw new UserError('这个任务正在执行，执行完再生成');
    this.gens.get(id)?.abort();
    const ctl = new AbortController();
    this.gens.set(id, ctl);
    const startedAt = this.now();
    this.genProgress.set(id, '正在准备…');
    this.setGen(id, { status: 'RUNNING', startedAt, endedAt: null, message: null, report: null, conversationId: null });
    this.changed();
    const finish = (gen: TaskPlanGen, plan?: TaskPlan): void => {
      if (this.gens.get(id) !== ctl) return;
      this.gens.delete(id);
      if (!this.get(id)) return;
      if (plan) {
        // 生成期间错过的执行不补跑：从现在重新算下一次
        const cur = this.get(id)!;
        const next = cur.enabled && cur.nextRunAt !== null && cur.nextRunAt <= this.now() ? nextRunAt(cur.schedule, this.now()) : cur.nextRunAt;
        this.d.db.prepare('UPDATE schedule_task SET plan = ?, next_run_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), next, this.now(), id);
      }
      this.setGen(id, gen);
      this.changed();
    };
    void (async () => {
      try {
        const v = this.validate({ ...t, plan: null } as LocalTaskInput);
        const r = await this.generate(this.d.owner(), v, t.plan?.push ?? null, ctl.signal, (text) => {
          if (this.gens.get(id) !== ctl) return;
          this.genProgress.set(id, text);
          this.emitGenProgress();
        });
        if (ctl.signal.aborted) return;
        const cur = this.get(id);
        if (!cur) return;
        const { plan, notes } = this.adoptPlan(cur, r.plan);
        if (!plan.steps.length) throw new UserError(`生成的命令都不能用：${notes.join('；')}`);
        plan.report = r.plan.report || cur.plan?.report || '';
        plan.push = cur.plan?.push ?? null;
        const confirm = plan.steps.filter((s) => s.confirm).length;
        const message = [`生成了 ${plan.steps.length} 条命令`, ...notes, confirm ? `${confirm} 条写操作等你确认（打开任务检查后保存）` : ''].filter(Boolean).join('；');
        finish({ status: 'DONE', startedAt, endedAt: this.now(), message, report: r.report, conversationId: r.conversationId }, plan);
        this.d.audit.event('SCHEDULE_PLAN_AUTO', { taskId: id, name: cur.name, plan: plan.steps.map((st) => (st.hostId ? `[${this.d.hosts.get(st.hostId)?.name ?? st.hostId}] ${st.command}` : st.command)), notes });
        this.d.notify(`定时任务「${cur.name}」的执行方案已生成`, message.slice(0, 200));
      } catch (e) {
        if (ctl.signal.aborted && this.gens.get(id) !== ctl) return;
        const msg = ctl.signal.aborted ? '已取消生成' : (e as Error).message;
        finish({ status: 'FAILED', startedAt, endedAt: this.now(), message: msg, report: null, conversationId: null });
        if (!ctl.signal.aborted) this.d.notify(`定时任务「${t.name}」的执行方案没有生成`, msg.slice(0, 200));
      }
    })();
    return this.get(id)!;
  }

  /** 取消后台生成 */
  cancelPlanGen(id: string): LocalTask {
    const ctl = this.gens.get(id);
    if (ctl) {
      this.gens.delete(id);
      ctl.abort();
      const t = this.get(id);
      if (t?.planGen) this.setGen(id, { ...t.planGen, status: 'FAILED', endedAt: this.now(), message: '已取消生成' });
      this.changed();
    }
    const t = this.get(id);
    if (!t) throw new UserError('任务不存在');
    return t;
  }

  /**
   * 后台生成的方案自动设置前的检查（没有人在旁边确认）：被策略拒绝的命令去掉；「只读」权限下去掉写操作；
   * 「保存时我确认」下写操作标记为待确认，用户在编辑框保存后才执行；「AI 审批」下写操作执行前照常由 AI 判断。
   */
  private adoptPlan(task: LocalTask, raw: TaskPlan): { plan: TaskPlan; notes: string[] } {
    const steps: TaskPlanStep[] = [];
    let denied = 0;
    let writes = 0;
    for (const st of raw.steps) {
      const checks = this.checkSync(st.command, st.hostId ? [st.hostId] : task.hostIds, 'USER');
      if (checks.some((c) => c.decision === 'DENY')) {
        denied++;
        continue;
      }
      const write = checks.some((c) => c.level !== 'L0');
      if (write && task.aiPolicy === 'READONLY') {
        writes++;
        continue;
      }
      steps.push({ ...st, ...(write && (task.aiPolicy === 'APPROVE' || task.aiPolicy === 'AUTO') ? { confirm: true } : {}) });
    }
    const notes = [denied ? `去掉了 ${denied} 条会被策略拒绝的命令` : '', writes ? `权限是「只读」，去掉了 ${writes} 条写操作` : ''].filter(Boolean);
    return { plan: { ...raw, steps }, notes };
  }

  trialCancel(token: string): void {
    this.trials.get(token)?.abort();
  }

  private changed(): void {
    this.d.emitTasks(this.list());
  }

  // ---------------------------------------------------------------- 执行

  private saveRun(v: TaskRunView): void {
    this.d.db
      .prepare(
        `INSERT INTO task_run (run_id, task_id, task_name, type, target, status, started_at, ended_at, summary, hosts, origin, conversation_id, report_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LOCAL', ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, summary = excluded.summary, hosts = excluded.hosts, conversation_id = excluded.conversation_id, report_level = excluded.report_level`,
      )
      .run(v.runId, v.taskId, v.taskName, v.type, v.target, v.status, v.startedAt, v.endedAt, v.summary, JSON.stringify(v.hosts), v.conversationId ?? null, v.reportLevel ?? null);
    this.d.emitRun({ ...v, hosts: v.hosts.map((h) => ({ ...h })) });
  }

  private async execute(task: LocalTask, manual: boolean, runId: string = randomUUID()): Promise<void> {
    if (this.running.has(task.id)) return;
    const abort = new AbortController();
    this.running.set(task.id, { runId, abort });
    const timeoutMs = task.timeoutMin * 60_000;
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    const started = this.now();
    // 先推进计划，执行时间长也不会重复触发
    if (!manual) {
      const next = task.schedule.kind === 'once' ? null : nextRunAt(task.schedule, started);
      this.d.db.prepare('UPDATE schedule_task SET last_run_at = ?, next_run_at = ?, enabled = ? WHERE id = ?').run(started, next, next === null ? 0 : 1, task.id);
    } else {
      this.d.db.prepare('UPDATE schedule_task SET last_run_at = ? WHERE id = ?').run(started, task.id);
    }

    const view: TaskRunView = {
      runId,
      taskId: task.id,
      taskName: task.name,
      type: task.type,
      target: (task.type === 'AGENT_PROMPT' ? task.prompt! : task.command!).slice(0, 2000),
      reportLevel: null,
      status: 'RUNNING',
      startedAt: started,
      endedAt: null,
      summary: null,
      hosts:
        task.type === 'SQL'
          ? [{ hostId: task.dbId ?? '', hostName: `数据库 · ${this.d.databases?.get(task.dbId ?? '')?.name ?? '（已删除）'}`, status: 'PENDING', exitCode: null, output: '', message: null }]
          : task.hostIds.map((id) => ({ hostId: id, hostName: this.d.hosts.get(id)?.name ?? id, status: 'PENDING', exitCode: null, output: '', message: null })),
      origin: 'LOCAL',
      conversationId: null,
    };
    this.saveRun(view);
    this.changed();
    const progress = (i: number, status: TaskHostStatus, message: string | null, extra: Partial<TaskRunView['hosts'][number]> = {}): void => {
      view.hosts[i] = { ...view.hosts[i], status, message, ...extra };
      this.saveRun(view);
    };

    let aiText = '';
    try {
      const hosts = task.hostIds.map((id) => this.d.hosts.get(id));
      hosts.forEach((h, i) => !h && progress(i, 'SKIPPED', '主机已被删除'));
      if (task.type === 'SQL') {
        progress(0, 'RUNNING', '正在查询…');
        if (!this.d.databases) throw new Error('这里不支持 SQL 报表');
        const r = await runSqlReport(task, this.d.owner(), abort.signal, {
          databases: this.d.databases,
          masker: this.d.masker ?? (() => ({ mask: (t: string) => ({ text: t, hits: {}, forcePrivate: false }) }) as unknown as Masker),
          ask: this.d.ask,
          notify: (title, body) => this.d.notify(title, body),
          fetch: this.d.fetch,
          now: () => this.now(),
        });
        progress(0, abort.signal.aborted ? 'FAILED' : r.status, abort.signal.aborted ? '已取消或超时' : r.message, { output: clip(r.output), exitCode: r.status === 'SUCCESS' ? 0 : 1 });
        view.summary = r.message;
      } else if (task.type === 'COMMAND') {
        const all = hosts.map((h, i) => ({ h, i })).filter((x): x is { h: Host; i: number } => !!x.h);
        await this.runCommand(task, view, all, abort.signal, progress, null);
        const failed = all.filter(({ i }) => view.hosts[i].status === 'FAILED');
        if (task.aiAssist && failed.length && !abort.signal.aborted) {
          failed.forEach(({ i }) => progress(i, 'RUNNING', 'Agent 正在排查处理…'));
          const r = await this.d.agent.runUnattended(this.d.owner(), {
            kind: 'prompt',
            title: task.name,
            prompt: this.assistPrompt(task, failed.map(({ h, i }) => ({ name: h.name, ...view.hosts[i] }))),
            hostIds: failed.map(({ h }) => h.id),
            policyCap: task.aiPolicy,
            timeoutMs: Math.max(60_000, timeoutMs - (this.now() - started)),
            ...this.approver(task, runId),
          });
          view.conversationId = r.conversationId;
          aiText = r.text;
          if (!abort.signal.aborted) await this.runCommand(task, view, failed, abort.signal, progress, 'Agent 处理后重新执行');
          else failed.forEach(({ i }) => progress(i, 'FAILED', '任务超时'));
        }
      } else if (task.plan?.steps.length) {
        // 按执行方案执行（第二十七轮）：只执行固化下来的命令，再由 AI 写报告
        const all = hosts.map((h, i) => ({ h, i })).filter((x): x is { h: Host; i: number } => !!x.h);
        await this.runPlan(task, task.plan, view, all, abort.signal, progress, started + timeoutMs);
        if (!abort.signal.aborted) {
          const r = await this.writeReport(task, task.plan, view);
          aiText = r.text;
          view.reportLevel = r.level;
          view.summary = r.text;
        }
      } else if (task.planGen) {
        throw new Error(task.planGen.status === 'FAILED' ? `还没有执行方案（${task.planGen.message ?? '生成失败'}），请打开任务重新生成` : '还没有执行方案');
      } else {
        // 旧版本的 AI 任务（没有执行方案）：每次交给 Agent 执行
        const ids = hosts.filter((h): h is Host => !!h).map((h) => h.id);
        hosts.forEach((h, i) => h && progress(i, 'RUNNING', null));
        const r = await this.d.agent.runUnattended(this.d.owner(), {
          kind: 'prompt',
          title: task.name,
          prompt: `${task.prompt}${task.goal ? `\n\n最终目的：${task.goal}` : ''}\n\n最后用几句话总结：做了什么、结果如何、还有什么需要人工处理。`,
          hostIds: ids,
          policyCap: task.aiPolicy,
          timeoutMs: Math.max(60_000, timeoutMs - (this.now() - started)),
          ...this.approver(task, runId),
        });
        view.conversationId = r.conversationId;
        aiText = r.text;
        hosts.forEach((h, i) => {
          if (!h) return;
          const steps = r.steps.filter((s) => s.hostName === h.name);
          const failed = steps.some((s) => s.status === 'error');
          const denied = steps.some((s) => s.status === 'rejected');
          progress(i, r.status === 'TIMEOUT' ? 'FAILED' : r.status === 'FAILED' || failed ? 'FAILED' : denied ? 'DENIED' : 'SUCCESS', r.status === 'TIMEOUT' ? '超时' : denied ? '有操作没有被批准' : null, {
            output: clip(steps.map((s) => `$ ${s.command}\n${s.output}`).join('\n\n')),
            exitCode: steps.at(-1)?.exitCode ?? null,
          });
        });
        if (r.status === 'TIMEOUT') view.status = 'TIMEOUT';
      }
    } catch (e) {
      view.summary = (e as Error).message;
      view.hosts = view.hosts.map((h) => (ACTIVE.includes(h.status) ? { ...h, status: 'FAILED', message: (e as Error).message } : h));
      view.status = 'FAILED';
    } finally {
      clearTimeout(timer);
      this.running.delete(task.id);
      this.approvals.cancelRun(runId);
    }

    if (view.status === 'RUNNING') {
      view.hosts = view.hosts.map((h) => (ACTIVE.includes(h.status) ? { ...h, status: 'FAILED', message: abort.signal.aborted ? '已取消或超时' : h.message } : h));
      const ok = view.hosts.filter((h) => h.status === 'SUCCESS').length;
      view.status = abort.signal.aborted ? (this.now() - started >= timeoutMs - 1000 ? 'TIMEOUT' : 'CANCELLED') : ok === view.hosts.length && ok > 0 ? 'SUCCESS' : ok === 0 ? 'FAILED' : 'PARTIAL';
    }
    view.endedAt = this.now();
    const count = (s: TaskHostStatus): number => view.hosts.filter((h) => h.status === s).length;
    const counts = `成功 ${count('SUCCESS')} 台，失败 ${count('FAILED')} 台${count('DENIED') ? `，拒绝 ${count('DENIED')} 台` : ''}${count('SKIPPED') ? `，跳过 ${count('SKIPPED')} 台` : ''}`;
    if (!view.summary) view.summary = aiText ? `${counts}\n\n${aiText.slice(0, 8000)}` : counts;
    this.saveRun(view);
    this.d.db.prepare('UPDATE schedule_task SET last_status = ? WHERE id = ?').run(view.status, task.id);
    this.changed();
    const failed = ['FAILED', 'PARTIAL', 'TIMEOUT'].includes(view.status);
    if (task.notifyOnFailure && failed) {
      this.d.notify(`定时任务「${task.name}」${view.status === 'PARTIAL' ? '部分失败' : view.status === 'TIMEOUT' ? '超时' : '失败'}`, counts);
    } else if (task.notifyOnFailure && view.reportLevel && view.reportLevel !== 'OK') {
      this.d.notify(`定时任务「${task.name}」：${REPORT_LEVEL_LABEL[view.reportLevel]}`, firstLines(view.summary ?? counts));
    }
    if (task.plan?.push && (task.plan.push.when === 'ALWAYS' || failed || (view.reportLevel && view.reportLevel !== 'OK'))) {
      await this.pushReport(task, task.plan, view);
    }
    this.raiseAlert(task, view, failed);
  }

  /**
   * 按任务的告警设置记录告警（第二十八轮）：失败 / 结论不正常时由 AI 自动只读排查（SQL 报表没有主机，不排查），按设置发邮件；
   * 这次执行正常时，之前还在告警中的这个任务的告警标记为恢复。
   */
  private raiseAlert(task: LocalTask, view: TaskRunView, failed: boolean): void {
    const a = task.alert;
    if (!a || !this.d.alerts) return;
    const issue = failed || (!!view.reportLevel && view.reportLevel !== 'OK');
    const prefix = `schedule:${task.id}:`;
    if (!issue) this.d.alerts.resolvePrefix(prefix);
    const fire = a.when === 'ALWAYS' || (a.when === 'FAILED' && failed) || (a.when === 'ISSUES' && issue);
    if (!fire) return;
    const bad = view.hosts.filter((h) => h.status !== 'SUCCESS' || h.steps?.some((s) => s.skipped || (s.exitCode !== null && s.exitCode !== 0)));
    const targets = (issue ? (failed && bad.length ? bad : view.hosts) : view.hosts).map((h) => this.d.hosts.get(h.hostId)).filter((h): h is Host => !!h);
    const status = { RUNNING: '执行中', SUCCESS: '成功', PARTIAL: '部分失败', FAILED: '失败', TIMEOUT: '超时', CANCELLED: '已取消' }[view.status];
    const verdict = view.reportLevel ? `，结论：${REPORT_LEVEL_LABEL[view.reportLevel]}` : '';
    try {
      this.d.alerts.raise({
        source: 'SCHEDULE',
        level: failed || view.reportLevel === 'ERROR' ? 'CRIT' : issue ? 'WARN' : 'INFO',
        title: `定时任务「${task.name}」${status}${verdict}`,
        detail: [
          `计划：${describeSchedule(task.schedule)}；开始：${new Date(view.startedAt).toLocaleString('zh-CN', { hour12: false })}`,
          ...view.hosts.map((h) => `- ${h.hostName}：${h.status}${h.message ? `（${h.message}）` : ''}`),
          '',
          (view.summary ?? '').slice(0, 6000),
        ].join('\n'),
        hosts: task.type === 'SQL' ? [] : targets,
        sourceName: task.name,
        key: `${prefix}${view.runId}`,
        metrics: null,
        related: { taskId: task.id, runId: view.runId },
        email: a.email,
        diagnose: issue && task.type !== 'SQL',
      });
      if (!issue) this.d.alerts.resolvePrefix(prefix);
    } catch {
      // 告警记录失败不影响任务结果
    }
  }

  /** 报告推送到机器人 / Webhook（失败记在执行记录的摘要后面，不影响任务结果） */
  private async pushReport(task: LocalTask, plan: TaskPlan, view: TaskRunView): Promise<void> {
    const level = view.reportLevel ? REPORT_LEVEL_LABEL[view.reportLevel] : '';
    const title = `【定时任务】${task.name}${level ? ` · ${level}` : ''}`;
    const time = new Date(view.startedAt).toLocaleString('zh-CN', { hour12: false });
    const body = (view.summary ?? '').slice(0, 6000);
    const msg = {
      title,
      markdown: `### ${title}\n- 时间：${time}\n- 主机：${view.hosts.map((h) => h.hostName).join('、')}\n\n${body}`,
      text: `${title}\n时间：${time}\n\n${body}`,
      data: { taskId: task.id, runId: view.runId, status: view.status, level: view.reportLevel ?? null, startedAt: view.startedAt },
    };
    const errors: string[] = [];
    for (const w of plan.push?.webhooks ?? []) {
      try {
        await sendWebhook(w, msg, { fetch: this.d.fetch, now: () => this.now() });
      } catch (e) {
        errors.push(`${w.name || w.kind}：${(e as Error).message}`);
      }
    }
    if (errors.length) {
      view.summary = `${view.summary ?? ''}\n\n> 报告推送失败：${errors.join('；')}`;
      this.saveRun(view);
    }
  }

  /**
   * 写操作的处理（第二十七轮和 Agent 权限对齐）：只读 → 一律跳过；AI 审批 → AI 判断（生产环境、高危一律跳过）；
   * 需要我批准 → 在「定时任务」页等用户批准；自动 → 由审批引擎决定（高危仍等用户批准）。
   */
  private approver(task: LocalTask, runId: string): { note: string; approvalLabel: string; approve(step: AgentStep): Promise<boolean> } {
    if (task.aiPolicy === 'READONLY') {
      return { note: '（定时任务，无人值守执行：权限是只读，写操作不会执行）', approvalLabel: '只读权限', approve: () => Promise.resolve(false) };
    }
    if (task.aiPolicy === 'AI_REVIEW') {
      return {
        note: '（定时任务，无人值守执行：写操作由 AI 审批，没有通过的会跳过）',
        approvalLabel: 'AI 审批',
        approve: async (step) => {
          const host = task.hostIds.map((id) => this.d.hosts.get(id)).find((h) => h?.name === step.hostName) ?? null;
          const r = await this.aiReview(step.command, host, step.level ?? 'L1', step.reasons);
          step.reasons = [...step.reasons, r.reason];
          return r.ok;
        },
      };
    }
    return { note: '（定时任务，无人值守执行：写操作需要用户在「定时任务」页批准）', approvalLabel: '用户批准', approve: (step) => this.askApproval(task, runId, step) };
  }

  /** AI 审批一条写操作：快速模型判断；生产环境、高危命令一律不放行（无人值守时没人兜底）。告警自动排查也用它 */
  async aiReview(command: string, host: Host | null, level: string, reasons: string[]): Promise<{ ok: boolean; reason: string }> {
    if (level === 'L2' || level === 'DENY') return { ok: false, reason: 'AI 审批：无人值守时不执行高危命令' };
    if (host) {
      const eff = this.d.hosts.effective(host.id, null);
      const prod = eff.production || (eff.folderPath ? eff.folderPath.split(' / ') : []).some((n) => this.d.policy().prodFolderNames.includes(n));
      if (prod) return { ok: false, reason: 'AI 审批：生产环境的写操作不在无人值守时执行' };
    }
    if (!this.d.ask) return { ok: false, reason: 'AI 审批：没有可用的模型' };
    const masked = this.d.masker ? this.d.masker().mask(command).text : command;
    const text = `${host ? `主机：${host.name}（${host.osInfo ?? '系统未知'}）` : '主机：未知'}\n命令：\n${masked}\n\n规则引擎判定：${level}（${reasons.join('；') || '无'}）\n（这是无人值守的定时任务，没有人在旁边确认）`;
    try {
      const v = parseAutoApprove(await this.d.ask(AUTO_APPROVE_PROMPT, text, 30_000));
      if (v?.auto) return { ok: true, reason: `AI 审批通过：${v.reason || '判断为常规操作'}` };
      return { ok: false, reason: v ? `AI 审批没有放行：${v.reason || '有风险'}` : 'AI 审批没有给出明确结论' };
    } catch (e) {
      return { ok: false, reason: `AI 审批失败：${(e as Error).message.slice(0, 80)}` };
    }
  }

  /** 按执行方案逐台主机执行（每台主机一条连接、一段录像，命令按顺序执行） */
  private async runPlan(
    task: LocalTask,
    plan: TaskPlan,
    view: TaskRunView,
    targets: { h: Host; i: number }[],
    signal: AbortSignal,
    progress: (i: number, s: TaskHostStatus, m: string | null, extra?: Partial<TaskRunView['hosts'][number]>) => void,
    deadline: number,
  ): Promise<void> {
    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { h, i } = next;
        const mine = stepsFor(plan, h.id);
        if (signal.aborted) {
          progress(i, 'FAILED', '已取消或超时');
          continue;
        }
        if (!mine.length) {
          progress(i, 'SKIPPED', '方案里没有这台主机的命令');
          continue;
        }
        progress(i, 'RUNNING', `0/${mine.length}`);
        const sessionId = `schedule:${view.runId}:${h.id}`;
        let rec: Recorder | null = null;
        try {
          rec = this.d.recordings?.start({ sessionId, kind: 'schedule', hostId: h.id, hostName: h.name, cols: 120, rows: 32 }) ?? null;
        } catch {
          rec = null;
        }
        rec?.output(`\x1b[2m[定时任务「${task.name}」· ${new Date(view.startedAt).toLocaleString('zh-CN', { hour12: false })} · ${h.name}]\x1b[0m\r\n`);
        const results: TaskRunStep[] = [];
        const update = (status: TaskHostStatus, message: string | null): void =>
          progress(i, status, message, { steps: results.map((r) => ({ ...r })), recordingId: rec?.id ?? null, output: clip(results.map((r) => `$ ${r.command}\n${r.skipped ? `（没有执行：${r.skipped}）` : r.output}`).join('\n\n')) });
        try {
          const conn = await this.d.pool.acquire(h.id, this.d.owner());
          try {
            for (const [n, st] of mine.entries()) {
              if (signal.aborted) break;
              const t0 = this.now();
              const ev = await this.evaluate(st.command, h, 'USER');
              const audit = (decision: 'AUTO' | 'APPROVED' | 'DENIED', exitCode?: number | null, extra: Record<string, unknown> = {}): void =>
                this.d.audit.command({
                  source: 'SCHEDULE',
                  hostId: h.id,
                  hostName: h.name,
                  sessionId: rec ? sessionId : null,
                  command: st.command,
                  risk: ev.effectiveLevel,
                  decision,
                  exitCode: exitCode ?? null,
                  detail: { runId: view.runId, taskId: task.id, taskName: task.name, purpose: st.purpose, reasons: ev.reasons, ...extra },
                });
              let skipped: string | null = null;
              let note: string | null = null;
              if (ev.decision === 'DENY') skipped = `被策略拒绝：${ev.reasons.join('；')}`;
              else if (ev.effectiveLevel !== 'L0') {
                if (task.aiPolicy === 'READONLY') skipped = '权限是只读，跳过写操作';
                else if (task.aiPolicy === 'AI_REVIEW') {
                  const r = await this.aiReview(st.command, h, ev.effectiveLevel, ev.reasons);
                  if (r.ok) note = r.reason;
                  else skipped = r.reason;
                } else if (st.confirm) skipped = '后台生成的写操作还没有确认（打开任务检查后保存即确认）';
                else note = '保存执行方案时你已确认';
              }
              if (skipped) {
                audit('DENIED', null, { skipped });
                results.push({ command: st.command, purpose: st.purpose, exitCode: null, output: '', skipped, note: null, durationMs: 0 });
                rec?.output(recordingText({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), host: h.name, command: st.command, output: '', result: `没有执行：${skipped}` }));
                update('RUNNING', `${n + 1}/${mine.length}`);
                continue;
              }
              const left = Math.max(5_000, deadline - this.now());
              const r = await execCommand(conn.client, st.command, { timeoutMs: Math.min(STEP_TIMEOUT_MS, left), maxBytes: MAX_OUTPUT, signal });
              const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
              audit(ev.decision === 'AUTO' && ev.effectiveLevel === 'L0' ? 'AUTO' : 'APPROVED', r.code, note ? { note } : {});
              results.push({ command: st.command, purpose: st.purpose, exitCode: r.code, output: clip(out, STEP_OUTPUT), skipped: null, note: r.timedOut ? '执行超时' : note, durationMs: this.now() - t0 });
              rec?.output(recordingText({ time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), host: h.name, command: st.command, output: out, result: r.timedOut ? '执行超时' : `退出码 ${r.code}` }));
              update('RUNNING', `${n + 1}/${mine.length}`);
            }
          } finally {
            this.d.pool.release(conn);
          }
          const bad = results.filter((r) => !r.skipped && r.exitCode !== 0).length;
          const skipped = results.filter((r) => r.skipped).length;
          if (signal.aborted && results.length < mine.length) update('FAILED', '已取消或超时');
          else update(bad ? 'FAILED' : 'SUCCESS', [bad ? `${bad} 条命令失败` : '', skipped ? `${skipped} 条没有执行` : ''].filter(Boolean).join('，') || null);
        } catch (e) {
          rec?.output(`\r\n\x1b[31m${(e as Error).message}\x1b[0m\r\n`);
          update('FAILED', (e as Error).message);
        } finally {
          rec?.end();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker));
  }

  /** 执行完让 AI 按汇总要求写报告；没有模型或失败时按执行结果给结论 */
  private async writeReport(task: LocalTask, plan: TaskPlan, view: TaskRunView): Promise<{ text: string; level: ReportLevel }> {
    const fallback = levelFromHosts(view.hosts);
    const count = (st: TaskHostStatus): number => view.hosts.filter((h) => h.status === st).length;
    const counts = `成功 ${count('SUCCESS')} 台，失败 ${count('FAILED')} 台${count('SKIPPED') ? `，跳过 ${count('SKIPPED')} 台` : ''}`;
    if (!this.d.ask) return { text: `结论：${REPORT_LEVEL_LABEL[fallback]}\n\n${counts}`, level: fallback };
    const input = reportInput({ name: task.name, prompt: task.prompt, goal: task.goal, rule: plan.report, hosts: view.hosts });
    const masked = this.d.masker ? this.d.masker().mask(input).text : input;
    try {
      const text = (await this.d.ask(REPORT_SYSTEM_PROMPT, masked, 180_000)).trim();
      const level = parseReportLevel(text) ?? fallback;
      // 执行失败的主机不能被报告说成「正常」
      return { text, level: fallback === 'ERROR' ? 'ERROR' : level };
    } catch (e) {
      return { text: `结论：${REPORT_LEVEL_LABEL[fallback]}\n\n${counts}\n\n（AI 报告生成失败：${(e as Error).message.slice(0, 200)}）`, level: fallback };
    }
  }

  private askApproval(task: LocalTask, runId: string, step: AgentStep): Promise<boolean> {
    return this.approvals.request({
      runId,
      taskId: task.id,
      taskName: task.name,
      hostName: step.hostName,
      command: step.command,
      level: step.level ?? 'L1',
      reasons: step.reasons,
      explanation: step.explanation ?? null,
    });
  }

  private assistPrompt(task: LocalTask, failed: { name: string; exitCode: number | null; output: string; message: string | null }[]): string {
    return [
      `定时任务「${task.name}」在下面的主机上执行失败，需要你排查原因并处理。`,
      '',
      '每次执行的命令：',
      '```bash',
      task.command ?? '',
      '```',
      task.goal ? `\n最终目的：${task.goal}` : '',
      '',
      '失败情况：',
      ...failed.map((f) => `- ${f.name}：${f.exitCode !== null ? `退出码 ${f.exitCode}` : (f.message ?? '执行失败')}\n${tail(f.output, 2000).replace(/^/gm, '    ')}`),
      '',
      '要求：',
      '1. 先用只读命令确认原因，再处理；只做和目标相关的修改；',
      '2. 处理后验证（任务结束后系统还会重新执行一次原命令确认）；',
      '3. 最后用几句话总结：原因、做了什么、是否解决、还需要人工处理什么。',
    ]
      .filter((l) => l !== null)
      .join('\n');
  }

  /** 逐台主机执行命令（创建任务时已经确认过命令，只检查是否被策略禁止） */
  private async runCommand(
    task: LocalTask,
    view: TaskRunView,
    targets: { h: Host; i: number }[],
    signal: AbortSignal,
    progress: (i: number, s: TaskHostStatus, m: string | null, extra?: Partial<TaskRunView['hosts'][number]>) => void,
    phase: string | null,
  ): Promise<void> {
    const command = task.command ?? '';
    const queue = [...targets];
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { h, i } = next;
        if (signal.aborted) {
          progress(i, 'FAILED', '已取消或超时');
          continue;
        }
        const ev = await this.evaluate(command, h, task.createdBy);
        const audit = (decision: 'AUTO' | 'APPROVED' | 'DENIED', exitCode?: number | null): void =>
          this.d.audit.command({
            source: 'SCHEDULE',
            hostId: h.id,
            hostName: h.name,
            command,
            risk: ev.effectiveLevel,
            decision,
            exitCode: exitCode ?? null,
            detail: { runId: view.runId, taskId: task.id, taskName: task.name, createdBy: task.createdBy, reasons: ev.reasons, ...(phase ? { phase } : {}) },
          });
        if (ev.decision === 'DENY') {
          audit('DENIED');
          progress(i, 'DENIED', `被策略拒绝：${ev.reasons.join('；')}`);
          continue;
        }
        progress(i, 'RUNNING', phase ? `${phase}…` : null);
        try {
          const conn = await this.d.pool.acquire(h.id, this.d.owner());
          try {
            const r = await execCommand(conn.client, command, { timeoutMs: task.timeoutMin * 60_000, maxBytes: MAX_OUTPUT, signal });
            // 创建任务时用户已经确认过这条命令
            audit(ev.decision === 'AUTO' ? 'AUTO' : 'APPROVED', r.code);
            const out = clip(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim());
            const before = phase ? `${view.hosts[i].output ? `${view.hosts[i].output}\n\n── ${phase} ──\n` : ''}` : '';
            progress(i, r.code === 0 ? 'SUCCESS' : 'FAILED', r.timedOut ? '执行超时' : r.code === 0 ? (phase ? `${phase}成功` : null) : `退出码 ${r.code}`, {
              output: clip(before + out),
              exitCode: r.code,
            });
          } finally {
            this.d.pool.release(conn);
          }
        } catch (e) {
          progress(i, 'FAILED', (e as Error).message);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, queue.length)) }, worker));
  }
}

/** 给 Agent 看的任务列表（schedule_list） */
export function describeTasks(list: LocalTask[], hostName: (id: string) => string, dbName?: (id: string) => string | undefined): string {
  if (!list.length) return '本机还没有定时任务。';
  const fmt = (t: number | null): string => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—');
  return list
    .map(
      (t) =>
        `- ${t.name}（${t.enabled ? '启用' : '停用'}，${t.type === 'COMMAND' ? '命令任务' : t.type === 'SQL' ? 'SQL 报表' : 'AI 任务'}，${t.createdBy === 'AGENT' ? 'Agent 创建' : '用户创建'}）：${describeSchedule(t.schedule)}；` +
        `${t.type === 'SQL' ? `数据库 ${dbName?.(t.dbId ?? '') ?? t.dbId}；SQL ${t.command?.replace(/\s+/g, ' ').slice(0, 120)}${t.report?.when === 'ROWS' ? '（有结果时才发）' : ''}` : `主机 ${t.hostIds.map(hostName).join('、')}；`}` +
        `${t.type === 'COMMAND' ? `命令 ${t.command?.split('\n')[0]}${t.aiAssist ? '（失败时 Agent 介入）' : ''}` : t.type === 'SQL' ? '' : `任务 ${t.prompt?.slice(0, 80)}${t.plan ? `（执行方案 ${t.plan.steps.length} 条命令）` : ''}`}；上次结果 ${t.lastStatus ?? '—'}；下次执行 ${fmt(t.nextRunAt)}`,
    )
    .join('\n');
}

/** 告警设置列 */
function alertCol(v: LocalTaskInput): string | null {
  return v.alert ? JSON.stringify(v.alert) : null;
}

/** AI 任务的执行方案列 */
function planCol(v: LocalTaskInput): string | null {
  return v.type === 'AGENT_PROMPT' && v.plan ? JSON.stringify(v.plan) : null;
}

/** SQL 报表的三列（其他类型为空） */
function sqlCols(v: LocalTaskInput): [string | null, string | null, string | null] {
  return v.type === 'SQL' ? [v.dbId ?? null, v.database ?? null, v.report ? JSON.stringify(v.report) : null] : [null, null, null];
}
