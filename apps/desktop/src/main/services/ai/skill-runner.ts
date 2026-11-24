import { randomUUID } from 'node:crypto';
import type { AgentStep, BatchItem, Folder, Host, RiskLevel, SkillRunHost, SkillRunView, SkillTargets } from '@itm/protocol';
import type { StepResponse, StepUi } from './tool-gateway';

/** 一次最多对多少台主机运行 */
export const MAX_SKILL_HOSTS = 200;
const LEVEL_ORDER: Record<string, number> = { L0: 0, L1: 1, L2: 2, L3: 3, DENY: 4 };

/**
 * 解析目标（文档一 7.6）：主机 ID、分组（含子分组）、标签，以及 Skill 声明的默认目标（folder:名称、tag:标签、主机名）。
 * 只保留 SSH 主机；返回去重后的主机和被跳过的数量。
 */
export function resolveSkillTargets(targets: SkillTargets, defaults: string[], hosts: Host[], folders: Folder[]): { hosts: Host[]; skipped: number } {
  const picked = new Map<string, Host>();
  const add = (h: Host | undefined): void => {
    if (h) picked.set(h.id, h);
  };
  const byFolder = (f: Folder | undefined): void => {
    if (!f) return;
    const ids = new Set(folders.filter((x) => x.path.startsWith(f.path)).map((x) => x.id));
    hosts.filter((h) => h.folderId && ids.has(h.folderId)).forEach(add);
  };
  const empty = !targets.hostIds?.length && !targets.folderIds?.length && !targets.tags?.length;
  for (const id of targets.hostIds ?? []) add(hosts.find((h) => h.id === id));
  for (const id of targets.folderIds ?? []) byFolder(folders.find((f) => f.id === id));
  for (const t of targets.tags ?? []) hosts.filter((h) => h.tags.some((x) => x.toLowerCase() === t.toLowerCase())).forEach(add);
  // 没有指定目标时用 Skill 声明的默认目标
  if (empty) {
    for (const d of defaults) {
      const [kind, ...rest] = d.split(':');
      const value = rest.join(':').trim();
      if (kind === 'folder' && value) byFolder(folders.find((f) => f.name === value || f.path === value));
      else if (kind === 'tag' && value) hosts.filter((h) => h.tags.some((x) => x.toLowerCase() === value.toLowerCase())).forEach(add);
      else add(hosts.find((h) => h.name === d || h.address === d));
    }
  }
  const all = [...picked.values()];
  const ssh = all.filter((h) => h.protocol === 'SSH');
  return { hosts: ssh.slice(0, MAX_SKILL_HOSTS), skipped: all.length - Math.min(ssh.length, MAX_SKILL_HOSTS) };
}

interface PendingApproval {
  hostName: string;
  step: AgentStep;
  resolve(r: StepResponse): void;
}

/**
 * 并行子 Agent 的写操作合并成一张批量审批卡片（文档一 7.6）：按主机列出命令，可以逐台勾选。
 * 所有正在运行的子 Agent 都停下来等审批时立即出卡片；否则等一小会儿（quietMs）攒一批，最长等 maxWaitMs。
 */
export class BatchApprovals {
  private pending: PendingApproval[] = [];
  private timer: NodeJS.Timeout | null = null;
  private firstAt = 0;

  constructor(
    private readonly o: {
      /** 把合并后的卡片交给界面，等用户批准 */
      ask(batch: AgentStep): Promise<StepResponse>;
      /** 是否所有还在运行的子 Agent 都在等审批 */
      allBlocked(): boolean;
      quietMs?: number;
      maxWaitMs?: number;
      now?: () => number;
    },
  ) {}

  get size(): number {
    return this.pending.length;
  }

  request(hostName: string, step: AgentStep): Promise<StepResponse> {
    return new Promise((resolve) => {
      if (this.pending.length === 0) this.firstAt = (this.o.now ?? Date.now)();
      this.pending.push({ hostName, step, resolve });
      this.schedule();
    });
  }

  /** 状态变化（有子 Agent 结束或者开始等待）时重新判断要不要马上出卡片 */
  poke(): void {
    if (this.pending.length) this.schedule();
  }

  /** 停止：所有等待中的都按拒绝处理 */
  rejectAll(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const p of this.pending.splice(0)) p.resolve({ decision: 'reject' });
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    const now = (this.o.now ?? Date.now)();
    const quiet = this.o.allBlocked() ? 0 : (this.o.quietMs ?? 600);
    const delay = Math.max(0, Math.min(quiet, (this.o.maxWaitMs ?? 3000) - (now - this.firstAt)));
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const items = this.pending.splice(0);
    if (items.length === 0) return;
    const level = items.reduce<RiskLevel | null>((m, i) => (i.step.level && (!m || LEVEL_ORDER[i.step.level] > LEVEL_ORDER[m]) ? i.step.level : m), null);
    const batch: BatchItem[] = items.map((i, n) => ({
      label: String(n + 1),
      hostName: i.hostName,
      command: i.step.command,
      level: i.step.level,
      decision: i.step.decision ?? null,
      reasons: i.step.reasons,
      selected: true,
      status: 'pending',
      exitCode: null,
      output: '',
    }));
    const step: AgentStep = {
      id: `batch-${randomUUID()}`,
      tool: 'ssh_exec_batch',
      hostLabel: '',
      hostName: `${items.length} 台主机`,
      command: `${items.length} 台主机上的写操作`,
      level,
      reasons: [...new Set(items.flatMap((i) => i.step.reasons))].slice(0, 5),
      status: 'approval',
      decision: 'APPROVE',
      exitCode: null,
      output: '',
      startedAt: (this.o.now ?? Date.now)(),
      finishedAt: null,
      batch,
    };
    const r = await this.o.ask(step);
    const chosen = r.decision === 'approve' ? new Set(r.hosts ?? batch.map((b) => b.label)) : new Set<string>();
    items.forEach((i, n) => i.resolve(chosen.has(String(n + 1)) ? { decision: 'approve' } : { decision: 'reject' }));
  }
}

export interface SkillJob {
  view: SkillRunView;
  hosts: Host[];
  concurrency: number;
  onError: 'continue' | 'stop';
  output: 'summary' | 'raw';
  /** 让一个子 Agent 处理这些主机，返回它最后的结论 */
  runOne(hosts: Host[], ui: StepUi, row: SkillRunHost[], signal: AbortSignal): Promise<string>;
  /** 汇总每台主机的结论 */
  summarize(results: SkillRunHost[], signal: AbortSignal): Promise<string>;
  /** 需要用户单独确认的步骤（高危命令要输入主机名、写文件看 diff） */
  askSingle(step: AgentStep): Promise<StepResponse>;
  ask(batch: AgentStep): Promise<StepResponse>;
  update(): void;
  now?: () => number;
}

/** 只有这类审批进批量卡片；需要输入主机名确认的高危命令、写文件仍然单独审批 */
const batchable = (step: AgentStep): boolean => step.decision === 'APPROVE' && step.tool === 'run_command';

/**
 * 执行一次 Skill：single 时一个 Agent 处理全部目标；parallel 时每台主机一个子 Agent（独立上下文），
 * 按 concurrency 并行，on-error: stop 时第一台失败就取消其余；最后按 output 汇总。
 */
export async function runSkillJob(job: SkillJob, signal: AbortSignal): Promise<void> {
  const now = job.now ?? Date.now;
  const v = job.view;
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const running = new Set<SkillRunHost>();
  /** 每台主机最近的步骤（用来刷新命令列表的状态） */
  const stepsOf = new WeakMap<SkillRunHost, AgentStep[]>();
  const sync = (row: SkillRunHost): void => {
    row.commands = (stepsOf.get(row) ?? []).map((s) => ({ command: s.command, level: s.level, status: s.status, exitCode: s.exitCode }));
  };
  const batch = new BatchApprovals({ ask: job.ask, allBlocked: () => running.size > 0 && [...running].every((r) => r.status === 'waiting'), now });

  /** 子 Agent 的步骤：记进对应主机的命令列表；审批走批量卡片或单独卡片 */
  const uiFor = (rows: SkillRunHost[]): StepUi => {
    const track = (step: AgentStep): void => {
      const row = rows.find((r) => r.name === step.hostName) ?? rows[0];
      if (!row || !step.command || step.tool === 'get_metrics' || step.tool === 'kb_search') return;
      const list = stepsOf.get(row) ?? [];
      if (!list.includes(step)) list.push(step);
      stepsOf.set(row, list.slice(-20));
      sync(row);
    };
    return {
      add: (step) => {
        track(step);
        job.update();
      },
      update: () => {
        rows.forEach(sync);
        job.update();
      },
      wait: async (step) => {
        track(step);
        const rowsWaiting = rows.filter((r) => r.status === 'running');
        rowsWaiting.forEach((r) => (r.status = 'waiting'));
        job.update();
        batch.poke();
        try {
          return await (batchable(step) && v.mode === 'parallel' ? batch.request(step.hostName, step) : job.askSingle(step));
        } finally {
          rowsWaiting.forEach((r) => {
            if (r.status === 'waiting') r.status = 'running';
          });
          job.update();
        }
      },
    };
  };

  const runRows = async (rows: SkillRunHost[], hosts: Host[]): Promise<void> => {
    if (abort.signal.aborted) {
      rows.forEach((r) => (r.status = 'canceled'));
      return;
    }
    rows.forEach((r) => {
      r.status = 'running';
      r.startedAt = now();
      running.add(r);
    });
    job.update();
    try {
      const text = await job.runOne(hosts, uiFor(rows), rows, abort.signal);
      rows.forEach((r) => {
        r.status = 'done';
        r.result = text;
      });
    } catch (e) {
      const canceled = abort.signal.aborted;
      rows.forEach((r) => {
        r.status = canceled ? 'canceled' : 'error';
        r.error = canceled ? null : (e as Error).message;
      });
      if (!canceled && job.onError === 'stop') abort.abort();
    } finally {
      rows.forEach((r) => {
        r.finishedAt = now();
        running.delete(r);
      });
      batch.poke();
      job.update();
    }
  };

  try {
    if (v.mode === 'single') {
      await runRows(v.hosts, job.hosts);
    } else {
      const queue = v.hosts.map((row, i) => ({ row, host: job.hosts[i] }));
      const worker = async (): Promise<void> => {
        for (;;) {
          const next = queue.shift();
          if (!next) return;
          await runRows([next.row], [next.host]);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(job.concurrency, queue.length)) }, worker));
    }
    batch.rejectAll();
    if (abort.signal.aborted && signal.aborted) {
      v.status = 'stopped';
    } else {
      const ok = v.hosts.filter((h) => h.status === 'done');
      if (ok.length === 0) {
        v.status = 'error';
        v.summary = '所有主机都执行失败，没有可以汇总的结果。';
      } else if (job.output === 'summary' && v.mode === 'parallel') {
        v.summary = await job.summarize(v.hosts, signal);
        v.status = 'done';
      } else {
        v.summary = v.mode === 'single' ? (ok[0].result ?? '') : null;
        v.status = 'done';
      }
    }
  } catch (e) {
    v.status = signal.aborted ? 'stopped' : 'error';
    if (!signal.aborted) v.summary = `汇总失败：${(e as Error).message}`;
  } finally {
    signal.removeEventListener('abort', onAbort);
    batch.rejectAll();
    v.hosts.forEach((h) => {
      if (h.status === 'queued' || h.status === 'running' || h.status === 'waiting') h.status = 'canceled';
    });
    v.finishedAt = now();
    job.update();
  }
}

/** 把每台主机的结论整理成纯文本（存进对话历史，之后追问时模型能看到） */
export function skillRunText(v: SkillRunView): string {
  const lines = [`Skill「${v.skillName}」在 ${v.hosts.length} 台主机上的执行结果：`];
  for (const h of v.hosts) {
    const status = h.status === 'done' ? '' : h.status === 'error' ? `（失败：${h.error}）` : '（已取消）';
    lines.push(`\n## ${h.name}${status}`);
    if (h.result && v.mode === 'parallel') lines.push(h.result);
  }
  if (v.summary) lines.push(`\n## 汇总\n${v.summary}`);
  return lines.join('\n');
}
