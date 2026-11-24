import { AGENT_POLICY_STRICTNESS, type AgentPolicy, type AgentStep, type Host, type TaskHostStatus, type TaskRunView, type TaskType } from '@itm/protocol';
import type { ApprovalEngine, PolicyConfig } from '@itm/approval';
import type { Db } from '../db/database';
import type { HostRepo } from '../hosts/host-repo';
import type { SshPool } from '../connection/ssh-pool';
import { execCommand } from '../connection/exec';
import type { AuditRepo } from '../audit/audit-repo';
import type { SettingsRepo } from '../settings/settings-repo';
import type { AgentService } from '../ai/agent-service';
import type { RemoteApprovals } from './remote-approvals';
import type { ServerLink } from './server-link';

/** task.dispatch 的 payload（文档二 7.2） */
interface Dispatch {
  runId: string;
  taskId: string;
  taskName?: string;
  type: TaskType;
  skill?: string;
  prompt?: string;
  command?: string;
  params?: Record<string, string | number | boolean>;
  hosts: (string | { id: string; name?: string })[];
  permissionCap?: AgentPolicy;
  timeoutMin?: number;
}

const MAX_OUTPUT = 64 * 1024;
const CONCURRENCY = 5;
const POLICIES: AgentPolicy[] = ['DENY', 'READONLY', 'APPROVE', 'AUTO'];

interface Row {
  run_id: string;
  task_id: string;
  task_name: string | null;
  type: TaskType;
  target: string;
  status: TaskRunView['status'];
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  hosts: string;
}

const toView = (r: Row): TaskRunView => ({
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
});

const clip = (s: string): string => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…（输出超过 64KB，已截断）` : s);

/**
 * 定时任务执行器（文档一 6.11）：接收服务端派发的 task.dispatch，在本设备上无人值守执行。
 * COMMAND 逐台主机过审批引擎（自动 / 远程审批 / 拒绝）后执行；SKILL、AGENT_PROMPT 交给 Agent 以无人值守模式运行。
 * 进度用 task.progress、结果用 task.result 回报，并记在本地 task_run 表里。
 */
export class TaskExecutor {
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly d: {
      db: Db;
      link: Pick<ServerLink, 'on' | 'send'>;
      approvals: Pick<RemoteApprovals, 'request'>;
      hosts: HostRepo;
      pool: SshPool;
      approval: ApprovalEngine;
      policy(): PolicyConfig;
      settings: SettingsRepo;
      audit: AuditRepo;
      agent: Pick<AgentService, 'runUnattended'>;
      /** 连接主机、显示提示用的窗口 */
      owner(): number;
      emit(run: TaskRunView): void;
      now?: () => number;
    },
  ) {
    d.link.on('task.dispatch', (p) => void this.run(p as Dispatch));
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  list(limit = 50, offset = 0): { items: TaskRunView[]; total: number } {
    const total = this.d.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM task_run').get()?.n ?? 0;
    const items = this.d.db
      .prepare<[number, number], Row>('SELECT * FROM task_run ORDER BY started_at DESC LIMIT ? OFFSET ?')
      .all(Math.min(limit, 200), Math.max(0, offset))
      .map(toView);
    return { items, total };
  }

  stopAll(): void {
    for (const c of this.running.values()) c.abort();
  }

  private save(v: TaskRunView): void {
    this.d.db
      .prepare(
        `INSERT INTO task_run (run_id, task_id, task_name, type, target, status, started_at, ended_at, summary, hosts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET status = excluded.status, ended_at = excluded.ended_at, summary = excluded.summary, hosts = excluded.hosts`,
      )
      .run(v.runId, v.taskId, v.taskName, v.type, v.target, v.status, v.startedAt, v.endedAt, v.summary, JSON.stringify(v.hosts));
    // 发出快照（view 之后还会继续变化）
    this.d.emit({ ...v, hosts: v.hosts.map((h) => ({ ...h })) });
  }

  /**
   * 服务端给的主机对应到本机：先按服务端 ID（账号档案里同步下来的主机带 srv_id）、再按本机 ID、最后按名称（名称唯一时）。
   * 管理后台填写目标主机时可以写主机名称。
   */
  private resolveHost(ref: string): { host: Host | null; error: string | null } {
    const byId = this.d.db.prepare<[string, string], { id: string }>('SELECT id FROM host WHERE (srv_id = ? OR id = ?) AND deleted = 0').get(ref, ref);
    if (byId) return { host: this.d.hosts.get(byId.id), error: null };
    const byName = this.d.db.prepare<[string], { id: string }>('SELECT id FROM host WHERE name = ? AND deleted = 0 LIMIT 2').all(ref);
    if (byName.length === 1) return { host: this.d.hosts.get(byName[0].id), error: null };
    return { host: null, error: byName.length > 1 ? `这台设备上有多台名为「${ref}」的主机，请在任务里改用主机 ID` : '这台设备上没有这台主机' };
  }

  async run(p: Dispatch): Promise<void> {
    if (!p || typeof p.runId !== 'string' || !['COMMAND', 'SKILL', 'AGENT_PROMPT'].includes(p.type)) return;
    // 重复派发（服务端重发）只执行一次
    if (this.running.has(p.runId) || this.d.db.prepare('SELECT 1 FROM task_run WHERE run_id = ?').get(p.runId)) return;
    const cap: AgentPolicy = POLICIES.includes(p.permissionCap as AgentPolicy) ? (p.permissionCap as AgentPolicy) : 'READONLY';
    const timeoutMs = Math.min(Math.max(Number(p.timeoutMin) || 30, 1), 24 * 60) * 60_000;
    const abort = new AbortController();
    this.running.set(p.runId, abort);
    const timer = setTimeout(() => abort.abort(), timeoutMs);

    const refs = (p.hosts ?? []).map((h) => (typeof h === 'string' ? { id: h, name: undefined } : { id: String(h.id), name: h.name })).slice(0, 500);
    const view: TaskRunView = {
      runId: p.runId,
      taskId: String(p.taskId ?? ''),
      taskName: p.taskName ? String(p.taskName).slice(0, 200) : null,
      type: p.type,
      target: String(p.type === 'COMMAND' ? (p.command ?? '') : p.type === 'SKILL' ? (p.skill ?? '') : (p.prompt ?? '')).slice(0, 2000),
      status: 'RUNNING',
      startedAt: this.now(),
      endedAt: null,
      summary: null,
      hosts: refs.map((r) => ({ hostId: r.id, hostName: r.name ?? r.id, status: 'PENDING', exitCode: null, output: '', message: null })),
    };
    this.save(view);
    const progress = (i: number, status: TaskHostStatus, message: string | null, extra: Partial<TaskRunView['hosts'][number]> = {}): void => {
      view.hosts[i] = { ...view.hosts[i], status, message, ...extra };
      this.save(view);
      const done = view.hosts.filter((h) => !['PENDING', 'RUNNING', 'WAITING_APPROVAL'].includes(h.status)).length;
      this.d.link.send('task.progress', { runId: p.runId, hostId: view.hosts[i].hostId, status, message, percent: Math.round((done / Math.max(1, view.hosts.length)) * 100) });
    };

    try {
      const resolved = refs.map((r) => this.resolveHost(r.id));
      const local = resolved.map((r) => r.host);
      resolved.forEach((r, i) => {
        if (r.host) view.hosts[i].hostName = r.host.name;
        else view.hosts[i] = { ...view.hosts[i], status: 'SKIPPED', message: r.error };
      });
      this.save(view);
      if (p.type === 'COMMAND') {
        await this.runCommand(p, view, local, cap, abort.signal, progress);
      } else {
        const hostIds = local.filter((h): h is Host => !!h).map((h) => h.id);
        local.forEach((h, i) => h && progress(i, 'RUNNING', null));
        const r = await this.d.agent.runUnattended(this.d.owner(), {
          kind: p.type === 'SKILL' ? 'skill' : 'prompt',
          title: view.taskName ?? view.target.slice(0, 40),
          skillId: p.skill,
          prompt: p.prompt,
          hostIds,
          params: p.params,
          policyCap: cap,
          timeoutMs,
          approve: (step: AgentStep) =>
            this.d.approvals.request(
              p.runId,
              { hostId: refs[local.findIndex((h) => h?.name === step.hostName)]?.id ?? '', hostName: step.hostName ?? undefined, command: step.command, risk: step.level ?? 'L1', reasons: step.reasons, explanation: step.explanation ?? null },
              timeoutMs,
            ),
        });
        // 每台主机的结果：取这台主机上最后一步的状态
        local.forEach((h, i) => {
          if (!h) return;
          const steps = r.steps.filter((s) => s.hostName === h.name);
          const failed = steps.some((s) => s.status === 'error' || (s.exitCode ?? 0) !== 0);
          const denied = steps.some((s) => s.status === 'rejected');
          progress(i, r.status === 'TIMEOUT' ? 'FAILED' : denied ? 'DENIED' : failed ? 'FAILED' : 'SUCCESS', r.status === 'TIMEOUT' ? '超时' : null, {
            output: clip(steps.map((s) => `$ ${s.command}\n${s.output}`).join('\n\n')),
            exitCode: steps.at(-1)?.exitCode ?? null,
          });
        });
        view.summary = r.text.slice(0, 8000) || null;
        if (r.status === 'TIMEOUT') view.status = 'TIMEOUT';
      }
    } catch (e) {
      view.summary = (e as Error).message;
      view.hosts = view.hosts.map((h) => (['PENDING', 'RUNNING', 'WAITING_APPROVAL'].includes(h.status) ? { ...h, status: 'FAILED', message: (e as Error).message } : h));
      view.status = 'FAILED';
    } finally {
      clearTimeout(timer);
      this.running.delete(p.runId);
    }
    if (view.status === 'RUNNING') {
      if (abort.signal.aborted) view.status = 'TIMEOUT';
      else {
        const ok = view.hosts.filter((h) => h.status === 'SUCCESS').length;
        view.status = ok === view.hosts.length && ok > 0 ? 'SUCCESS' : ok === 0 ? 'FAILED' : 'PARTIAL';
      }
    }
    view.endedAt = this.now();
    if (!view.summary && p.type === 'COMMAND') {
      const count = (s: TaskHostStatus): number => view.hosts.filter((h) => h.status === s).length;
      view.summary = `成功 ${count('SUCCESS')} 台，失败 ${count('FAILED')} 台，拒绝 ${count('DENIED')} 台，跳过 ${count('SKIPPED')} 台`;
    }
    this.save(view);
    this.d.link.send(
      'task.result',
      {
        runId: p.runId,
        status: view.status,
        summary: view.summary,
        hosts: view.hosts.map((h) => ({ hostId: h.hostId, status: h.status, exitCode: h.exitCode, output: h.output, message: h.message })),
      },
      { ack: true },
    );
  }

  private async runCommand(
    p: Dispatch,
    view: TaskRunView,
    local: (Host | null)[],
    cap: AgentPolicy,
    signal: AbortSignal,
    progress: (i: number, s: TaskHostStatus, m: string | null, extra?: Partial<TaskRunView['hosts'][number]>) => void,
  ): Promise<void> {
    const command = String(p.command ?? '').trim();
    if (!command) throw new Error('任务没有命令');
    const queue = local.map((h, i) => ({ h, i })).filter((x): x is { h: Host; i: number } => !!x.h);
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { h, i } = next;
        if (signal.aborted) {
          progress(i, 'FAILED', '任务超时');
          continue;
        }
        if (h.protocol !== 'SSH') {
          progress(i, 'SKIPPED', `${h.protocol} 主机不能执行命令任务`);
          continue;
        }
        const eff = this.d.hosts.effective(h.id, null);
        // 任务的权限上限作为无人值守上限：超出上限的写操作转为远程审批（主机自己的 Agent 权限照常生效）
        const policy = this.d.policy();
        const unattendedCap = AGENT_POLICY_STRICTNESS[cap] > AGENT_POLICY_STRICTNESS[policy.unattendedCap] ? cap : policy.unattendedCap;
        const ev = await this.d.approval.evaluate(
          command,
          {
            hostDenylist: h.cmdDenylist,
            agentPolicy: eff.agentPolicy,
            production: eff.production,
            folderNames: eff.folderPath ? eff.folderPath.split(' / ') : [],
            policy: { ...policy, unattendedCap },
            unattended: true,
          },
          { autoReadonly: this.d.settings.get('ai.autoApproveReadonly') },
        );
        const audit = (decision: 'AUTO' | 'APPROVED' | 'REJECTED' | 'DENIED', exitCode?: number | null): void =>
          this.d.audit.command({ source: 'SCHEDULE', hostId: h.id, hostName: h.name, command, risk: ev.effectiveLevel, decision, exitCode: exitCode ?? null, detail: { runId: p.runId, taskId: p.taskId, reasons: ev.reasons } });
        if (ev.decision === 'DENY') {
          audit('DENIED');
          progress(i, 'DENIED', `被策略拒绝：${ev.reasons.join('；')}`);
          continue;
        }
        let decision: 'AUTO' | 'APPROVED' = 'AUTO';
        if (ev.decision !== 'AUTO') {
          progress(i, 'WAITING_APPROVAL', `等待远程审批（${ev.reasons.join('；')}）`);
          const ok = await this.d.approvals
            .request(p.runId, { hostId: view.hosts[i].hostId, hostName: h.name, command, risk: ev.effectiveLevel, reasons: ev.reasons }, 30 * 60_000)
            .catch(() => false);
          if (!ok) {
            audit('REJECTED');
            progress(i, 'DENIED', '远程审批没有通过（被拒绝或已过期）');
            continue;
          }
          decision = 'APPROVED';
        }
        progress(i, 'RUNNING', null);
        try {
          const conn = await this.d.pool.acquire(h.id, this.d.owner());
          try {
            const r = await execCommand(conn.client, command, { timeoutMs: 10 * 60_000, maxBytes: MAX_OUTPUT, signal });
            audit(decision, r.code);
            const out = clip(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim());
            progress(i, r.code === 0 ? 'SUCCESS' : 'FAILED', r.timedOut ? '执行超时' : r.code === 0 ? null : `退出码 ${r.code}`, { output: out, exitCode: r.code });
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
