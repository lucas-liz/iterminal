/**
 * AI 任务的执行方案（第二十七轮，文档一 6.41）：
 * 1. 创建时 AI 先用只读命令在目标主机上试运行一次，给出「每次定时执行的命令清单 + 汇总要求」；
 * 2. 之后按计划只执行清单里的命令（不再让 Agent 自由发挥，不会半夜提问或请求批准记忆）；
 * 3. 执行完把输出交给 AI 按汇总要求写报告，第一行是结论（正常 / 需要注意 / 异常）。
 * 这里是不依赖服务的纯逻辑，方便单元测试。
 */
import type { AgentStep, ReportLevel, ReportWebhook, TaskPlan, TaskPlanStep, TaskRunView } from '@itm/protocol';

export const PLAN_MAX_STEPS = 30;
const MAX_COMMAND = 4000;
const MAX_PURPOSE = 60;
const MAX_REPORT_RULE = 2000;

interface HostRef {
  id: string;
  name: string;
}

/**
 * 检查并整理执行方案：去掉空命令、重复命令和不在目标主机里的主机。
 * 用户保存时去掉「待确认」标记（保存即确认）；后台生成时 keepConfirm 保留。
 */
export function normalizePlan(raw: Partial<TaskPlan> | null | undefined, hostIds: string[], normalizeWebhook: (w: Partial<ReportWebhook>) => ReportWebhook, keepConfirm = false): TaskPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const seen = new Set<string>();
  const steps: TaskPlanStep[] = [];
  for (const s of Array.isArray(raw.steps) ? raw.steps : []) {
    if (!s || typeof s !== 'object') continue;
    const command = String(s.command ?? '').trim();
    if (!command) continue;
    if (command.length > MAX_COMMAND) throw new Error(`方案里的命令太长（最多 ${MAX_COMMAND} 个字符）`);
    const hostId = s.hostId && hostIds.includes(String(s.hostId)) ? String(s.hostId) : null;
    const key = `${hostId ?? '*'}\u0000${command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push({ hostId, command, purpose: String(s.purpose ?? '').trim().slice(0, MAX_PURPOSE), ...(keepConfirm && s.confirm ? { confirm: true } : {}) });
  }
  if (steps.length > PLAN_MAX_STEPS) throw new Error(`执行方案最多 ${PLAN_MAX_STEPS} 条命令`);
  const push = raw.push && typeof raw.push === 'object' ? raw.push : null;
  const webhooks = push && Array.isArray(push.webhooks) ? push.webhooks.slice(0, 10).map((w) => normalizeWebhook(w)) : [];
  return {
    steps,
    report: String(raw.report ?? '').trim().slice(0, MAX_REPORT_RULE),
    generatedAt: typeof raw.generatedAt === 'number' ? raw.generatedAt : null,
    conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : null,
    push: webhooks.length ? { when: push?.when === 'ISSUES' ? 'ISSUES' : 'ALWAYS', webhooks } : null,
  };
}

/** 这台主机要执行的命令（hostId 为空的是所有主机都执行） */
export function stepsFor(plan: TaskPlan, hostId: string): TaskPlanStep[] {
  return plan.steps.filter((s) => s.hostId === null || s.hostId === hostId);
}

/** 试运行的提示词 */
export function trialPrompt(o: { name: string; prompt: string; goal: string | null; hosts: HostRef[] }): string {
  return [
    `这是定时任务「${o.name}」的试运行。以后会按计划在这些主机上定时执行：${o.hosts.map((h) => h.name).join('、')}。`,
    '',
    `任务说明：\n${o.prompt}`,
    ...(o.goal ? ['', `最终目的：${o.goal}`] : []),
    '',
    '请按下面的步骤做：',
    '1. 只用只读命令在目标主机上把任务说明里的检查做一遍（不要做任何修改；不要提问，也不要记录主机记忆）。',
    '2. 确定以后每次定时执行时要运行的命令：必须非交互、可以重复执行、输出简洁（用 head / tail / awk / --format 等精简输出）；',
    '   「没有找到」之类的正常情况不要返回非 0 退出码（例如 grep 后面加 `|| true`）；同一台主机上的检查尽量合并，总共不超过 10 条。',
    '   如果任务确实需要修改系统（例如清理日志），可以把写操作放进方案，但试运行时不要执行。',
    '3. 先写一份这次检查的简短报告，然后在回答的最后附上执行方案，只能有一个 json 代码块，格式如下：',
    '```json',
    '{"steps":[{"host":"*","command":"df -h -x tmpfs -x devtmpfs","purpose":"磁盘使用率"}],"report":"磁盘使用率超过 85% 算需要注意，超过 95% 算异常"}',
    '```',
    'host 写 "*" 表示所有目标主机都执行，或者写某一台主机的名称；purpose 用几个字说明这条命令检查什么；',
    'report 写以后每次汇总报告时关注什么、什么情况算「需要注意」、什么情况算「异常」。',
  ].join('\n');
}

const JSON_BLOCK = /```(?:json)?\s*\n([\s\S]*?)\n?```/g;

/**
 * 从试运行的回答里取出执行方案：最后一个 json 代码块；没有或解析失败时，用试运行里成功执行过的只读命令兜底。
 * 返回去掉 json 代码块之后的报告正文。
 */
export function parseTrialAnswer(text: string, hosts: HostRef[], steps: Pick<AgentStep, 'command' | 'hostName' | 'status' | 'level' | 'exitCode'>[]): { steps: TaskPlanStep[]; report: string; body: string; fromSteps: boolean } {
  const blocks = [...text.matchAll(JSON_BLOCK)];
  const byName = new Map(hosts.map((h) => [h.name, h.id]));
  for (const m of blocks.reverse()) {
    let j: { steps?: { host?: unknown; command?: unknown; purpose?: unknown }[]; report?: unknown };
    try {
      j = JSON.parse(m[1]) as typeof j;
    } catch {
      continue;
    }
    if (!j || !Array.isArray(j.steps)) continue;
    const out: TaskPlanStep[] = [];
    for (const s of j.steps) {
      const command = typeof s?.command === 'string' ? s.command.trim() : '';
      if (!command) continue;
      const host = typeof s.host === 'string' ? s.host.trim() : '*';
      const hostId = host === '*' || host === '' ? null : (byName.get(host) ?? hosts.find((h) => h.id === host)?.id ?? null);
      out.push({ hostId, command, purpose: typeof s.purpose === 'string' ? s.purpose.trim().slice(0, MAX_PURPOSE) : '' });
    }
    if (!out.length) continue;
    return { steps: out.slice(0, PLAN_MAX_STEPS), report: typeof j.report === 'string' ? j.report.trim().slice(0, MAX_REPORT_RULE) : '', body: text.replace(m[0], '').trim(), fromSteps: false };
  }
  return { steps: stepsFromTrial(hosts, steps), report: '', body: text.trim(), fromSteps: true };
}

/** 兜底：试运行里成功执行的只读命令；所有主机都执行过的合并成一条 */
function stepsFromTrial(hosts: HostRef[], steps: Pick<AgentStep, 'command' | 'hostName' | 'status' | 'level' | 'exitCode'>[]): TaskPlanStep[] {
  const ok = steps.filter((s) => s.status === 'done' && (s.level ?? 'L0') === 'L0' && (s.exitCode ?? 0) === 0 && s.command.trim());
  const byCommand = new Map<string, Set<string>>();
  for (const s of ok) {
    const id = hosts.find((h) => h.name === s.hostName)?.id;
    if (!id) continue;
    const set = byCommand.get(s.command.trim()) ?? new Set<string>();
    set.add(id);
    byCommand.set(s.command.trim(), set);
  }
  const out: TaskPlanStep[] = [];
  for (const [command, ids] of byCommand) {
    if (ids.size === hosts.length) out.push({ hostId: null, command, purpose: '' });
    else for (const id of ids) out.push({ hostId: id, command, purpose: '' });
  }
  return out.slice(0, PLAN_MAX_STEPS);
}

/** 报告的系统提示词（不要出现「汇总」以外的工具说明：这是一次性请求，没有工具） */
export const REPORT_SYSTEM_PROMPT = [
  '你是运维巡检报告助手。根据定时任务在各台主机上执行的命令和输出，写一份简洁的中文报告（Markdown）。',
  '格式：',
  '- 第一行必须是「结论：正常」「结论：需要注意」「结论：异常」三者之一（有任何一项需要人工关注就不是正常；命令失败、主机连不上算异常）。',
  '- 接着「## 概览」：一两句话说明整体情况。',
  '- 「## 各主机情况」：每台主机一个小标题，列出关键数据（列表或表格）；没有问题的主机简短带过。',
  '- 「## 需要处理」：列出需要人工处理的问题和建议，命令放在 ```bash 代码块里；没有就写「无」。',
  '要求：只根据输出下结论，不要编造数据；被跳过或执行失败的命令要指出来；不要复述整段输出。',
].join('\n');

/** 报告的输入：任务、汇总要求、每台主机每条命令的输出（每段输出取末尾，总长度有上限） */
export function reportInput(o: { name: string; prompt: string | null; goal: string | null; rule: string; hosts: TaskRunView['hosts'] }, max = 60_000): string {
  const per = Math.max(800, Math.floor(max / Math.max(1, o.hosts.reduce((n, h) => n + (h.steps?.length ?? 1), 0))));
  const tail = (s: string): string => (s.length > per ? `…（前面省略）\n${s.slice(-per)}` : s);
  const lines: string[] = [`定时任务：${o.name}`];
  if (o.prompt) lines.push(`任务说明：${o.prompt}`);
  if (o.goal) lines.push(`最终目的：${o.goal}`);
  if (o.rule) lines.push(`汇总要求：${o.rule}`);
  for (const h of o.hosts) {
    lines.push('', `### 主机 ${h.hostName}${h.status === 'SUCCESS' ? '' : `（${h.message ?? h.status}）`}`);
    for (const s of h.steps ?? []) {
      lines.push(`$ ${s.command}${s.purpose ? `    # ${s.purpose}` : ''}`);
      if (s.skipped) lines.push(`（没有执行：${s.skipped}）`);
      else lines.push(`（退出码 ${s.exitCode ?? '—'}）`, tail(s.output.trim() || '（没有输出）'));
    }
    if (!h.steps?.length && h.output) lines.push(tail(h.output));
  }
  return lines.join('\n');
}

/** 一次执行整理成笔记时交给 AI 的内容：报告 + 各主机命令输出（第二十九轮） */
export function runNoteInput(v: TaskRunView, time: string): string {
  const head = [`定时任务：${v.taskName ?? v.taskId}`, `执行时间：${time}`, `状态：${v.status}`, `任务内容：${v.target.slice(0, 1000)}`];
  const body = reportInput({ name: v.taskName ?? v.taskId, prompt: null, goal: null, rule: '', hosts: v.hosts }, 80_000).split('\n').slice(1).join('\n');
  return [...head, '', '## 执行结果的报告 / 总结', v.summary?.trim() || '（没有）', '', '## 各主机的命令和输出', body].join('\n');
}

/** 报告第一行的结论 */
export function parseReportLevel(text: string): ReportLevel | null {
  const head = text.trim().split('\n').slice(0, 3).join('\n');
  const m = /结论\s*[:：]\s*\**\s*(正常|需要注意|注意|异常)/.exec(head);
  if (!m) return null;
  return m[1] === '正常' ? 'OK' : m[1] === '异常' ? 'ERROR' : 'WARN';
}

/** 没有 AI 报告时按执行结果给结论 */
export function levelFromHosts(hosts: TaskRunView['hosts']): ReportLevel {
  if (hosts.some((h) => h.status === 'FAILED')) return 'ERROR';
  if (hosts.some((h) => h.status !== 'SUCCESS' || h.steps?.some((s) => s.skipped))) return 'WARN';
  return 'OK';
}

/** 一条命令的录像文本（和 Agent 的后台录像风格一致） */
export function recordingText(o: { time: string; host: string; command: string; output: string; result: string }): string {
  const out = o.output.replace(/\r?\n/g, '\r\n');
  return `\r\n\x1b[1;36m⏱ 定时任务\x1b[0m\x1b[2m ${o.time} · ${o.host}\x1b[0m\r\n\x1b[1m$ ${o.command.replace(/\r?\n/g, '\r\n  ')}\x1b[0m\r\n${out}${out && !out.endsWith('\r\n') ? '\r\n' : ''}\x1b[2m[${o.result}]\x1b[0m\r\n`;
}
