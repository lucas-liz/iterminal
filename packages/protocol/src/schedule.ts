/**
 * 本机定时任务（第四轮）：用户手动创建或 Agent 创建（需要用户批准），在这台电脑上按计划执行。
 * 应用运行时才会执行；错过的执行不补跑。
 */
import type { TaskRunView } from './server';
import type { TaskAlertOptions } from './alert';

export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'monthly' | 'once' | 'cron';

export interface ScheduleSpec {
  kind: ScheduleKind;
  /** interval：每隔多少分钟（1–10080） */
  everyMin?: number;
  /** daily / weekly / monthly：HH:mm */
  time?: string;
  /** weekly：0–6（周日 = 0），可以多选 */
  weekdays?: number[];
  /** monthly：每月几号（1–31，没有这一天的月份跳过） */
  monthDay?: number;
  /** once：执行时间（毫秒时间戳） */
  at?: number;
  /** cron：5 段表达式（分 时 日 月 周） */
  cron?: string;
}

export type LocalTaskType = 'COMMAND' | 'AGENT_PROMPT' | 'SQL';

/** 定时 SQL 报表的机器人 / Webhook（文档一 6.32.3） */
export type ReportWebhookKind = 'DINGTALK' | 'WECOM' | 'FEISHU' | 'WEBHOOK';
export interface ReportWebhook {
  kind: ReportWebhookKind;
  url: string;
  /** 钉钉加签密钥 / 飞书签名校验密钥 / 通用 Webhook 的 HMAC 密钥；不用时为空 */
  secret: string | null;
  /** 显示用的名称（例如「运维群」） */
  name: string | null;
}

export const REPORT_WEBHOOK_KINDS: { value: ReportWebhookKind; label: string }[] = [
  { value: 'DINGTALK', label: '钉钉机器人' },
  { value: 'WECOM', label: '企业微信机器人' },
  { value: 'FEISHU', label: '飞书机器人' },
  { value: 'WEBHOOK', label: '通用 Webhook' },
];

/** 定时 SQL 报表的设置 */
export interface SqlReportOptions {
  /** ALWAYS：每次都发；ROWS：查询有结果时才发（告警类） */
  when: 'ALWAYS' | 'ROWS';
  /** 报表里最多列出的行数（1–200） */
  maxRows: number;
  /** 让快速模型用几句话总结（发给模型的结果先脱敏） */
  aiSummary: boolean;
  /** 发出去的报表按列名脱敏 */
  maskColumns: boolean;
  /** 系统通知 */
  systemNotify: boolean;
  webhooks: ReportWebhook[];
}

export const DEFAULT_SQL_REPORT: SqlReportOptions = { when: 'ALWAYS', maxRows: 20, aiSummary: false, maskColumns: true, systemNotify: true, webhooks: [] };
/**
 * 写操作的处理方式（第二十七轮和 Agent 权限对齐）：
 * - READONLY：只读，写操作一律跳过；
 * - AI_REVIEW：AI 审批，执行前由 AI 判断，判断安全才执行，否则跳过并写进报告（不会半夜等人批准）；
 * - APPROVE：AI 任务的执行方案保存时由你确认（照清单执行）；命令任务失败后 Agent 新提出的写操作等你批准；
 * - AUTO：普通写操作自动执行，高危仍需批准（旧版本的选项）。
 */
export type LocalTaskAiPolicy = 'READONLY' | 'AI_REVIEW' | 'APPROVE' | 'AUTO';

/** AI 任务执行方案里的一条命令（第二十七轮） */
export interface TaskPlanStep {
  /** null = 所有目标主机 */
  hostId: string | null;
  command: string;
  /** 这条命令检查什么（报告里的小标题） */
  purpose: string;
  /** 后台生成的写操作，权限是「保存时我确认」时要等你在编辑框里保存（确认）后才执行（第二十九轮） */
  confirm?: boolean;
}

/** 后台生成执行方案（第二十九轮）：保存 AI 任务后由 AI 在后台试运行，生成好后自动设置到任务上，不用开着编辑框等 */
export interface TaskPlanGen {
  status: 'RUNNING' | 'DONE' | 'FAILED';
  startedAt: number;
  endedAt: number | null;
  /** 进行中：当前进度；结束：说明（失败原因、去掉了哪些命令） */
  message: string | null;
  /** 生成时这次检查的报告（Markdown） */
  report: string | null;
  conversationId: string | null;
}

/**
 * AI 任务的执行方案：创建时 AI 先在目标主机上试运行一次，把需要定时执行的命令固化下来；
 * 之后每次按计划只执行这些命令（不再让 Agent 自由发挥），执行完由 AI 按「汇总要求」写报告。
 */
export interface TaskPlan {
  steps: TaskPlanStep[];
  /** 汇总要求：报告关注什么、什么情况算异常 */
  report: string;
  generatedAt: number | null;
  /** 试运行的对话（可以在 AI 对话里查看过程） */
  conversationId: string | null;
  /** 报告推送：ALWAYS 每次都推送；ISSUES 只在结论是「需要注意 / 异常」时推送 */
  push?: { when: 'ALWAYS' | 'ISSUES'; webhooks: ReportWebhook[] } | null;
}

/** AI 试运行的结果（编辑框里展示，用户可以修改后保存） */
export interface TaskTrialResult {
  plan: TaskPlan;
  /** 试运行的报告 */
  report: string;
  conversationId: string;
}

/** 巡检结论：报告第一行「结论：正常 / 需要注意 / 异常」 */
export type ReportLevel = 'OK' | 'WARN' | 'ERROR';
export const REPORT_LEVEL_LABEL: Record<ReportLevel, string> = { OK: '正常', WARN: '需要注意', ERROR: '异常' };

export interface LocalTask {
  id: string;
  name: string;
  enabled: boolean;
  type: LocalTaskType;
  /** COMMAND：要执行的命令（可以是多行脚本） */
  command: string | null;
  /** AGENT_PROMPT：交给 Agent 的任务描述 */
  prompt: string | null;
  /** SQL：在这个数据库上执行 command 里的只读 SQL（第十八轮） */
  dbId?: string | null;
  /** SQL：库（空 = 数据库的默认库） */
  database?: string | null;
  /** SQL：报表设置 */
  report?: SqlReportOptions | null;
  /** AGENT_PROMPT：执行方案（第二十七轮）；旧任务没有时每次交给 Agent 自由执行 */
  plan?: TaskPlan | null;
  /** AGENT_PROMPT：后台生成执行方案的状态（第二十九轮）；没有生成过时为 null */
  planGen?: TaskPlanGen | null;
  /** 告警触发条件和邮件通知（第二十八轮）；null = 不告警 */
  alert?: TaskAlertOptions | null;
  hostIds: string[];
  schedule: ScheduleSpec;
  /** 命令任务：执行失败时让 Agent 介入排查和处理，处理后重新执行一次验证 */
  aiAssist: boolean;
  /** 最终目的：Agent 朝着这个目标处理（例如「nginx 正常对外提供服务」） */
  goal: string | null;
  aiPolicy: LocalTaskAiPolicy;
  /** 单次执行的超时（分钟） */
  timeoutMin: number;
  /** 失败时发系统通知 */
  notifyOnFailure: boolean;
  createdBy: 'USER' | 'AGENT';
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: TaskRunView['status'] | null;
}

export type LocalTaskInput = Pick<LocalTask, 'name' | 'enabled' | 'type' | 'command' | 'prompt' | 'hostIds' | 'schedule' | 'aiAssist' | 'goal' | 'aiPolicy' | 'timeoutMin' | 'notifyOnFailure' | 'dbId' | 'database' | 'report' | 'plan' | 'alert'>;

/** 定时任务里 Agent 的写操作等待用户批准（在「定时任务」页处理） */
export interface ScheduleApproval {
  id: string;
  runId: string;
  taskId: string;
  taskName: string;
  hostName: string;
  command: string;
  level: string;
  reasons: string[];
  explanation: string | null;
  createdAt: number;
  expiresAt: number;
}

/** 创建任务前的风险检查：每台主机上这条命令的判定 */
export interface ScheduleCheck {
  hostId: string;
  hostName: string;
  level: string;
  decision: 'RUN' | 'DENY';
  reasons: string[];
}

export const LOCAL_TASK_DEFAULTS: LocalTaskInput = {
  name: '',
  enabled: true,
  type: 'COMMAND',
  command: '',
  prompt: null,
  hostIds: [],
  schedule: { kind: 'daily', time: '02:00' },
  aiAssist: false,
  goal: null,
  aiPolicy: 'AI_REVIEW',
  timeoutMin: 30,
  notifyOnFailure: true,
};

// ------------------------------------------------------------------ cron

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const FIELD_RANGE: [number, number, string][] = [
  [0, 59, '分钟'],
  [0, 23, '小时'],
  [1, 31, '日'],
  [1, 12, '月'],
  [0, 7, '星期'],
];

function parseField(src: string, [min, max, name]: [number, number, string]): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`${name}「${part}」写法不对`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? (m[2] ? max : a);
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`${name}「${part}」超出范围（${min}–${max}）`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** 解析 5 段 cron 表达式；写错时抛出中文说明 */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 表达式需要 5 段：分 时 日 月 周');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELD_RANGE[i]));
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

function cronMatchesDay(f: CronFields, d: Date): boolean {
  const dom = f.dom.has(d.getDate());
  const dow = f.dow.has(d.getDay());
  // 和标准 cron 一样：日和周都限定时满足其一即可
  if (!f.domAny && !f.dowAny) return dom || dow;
  return dom && dow;
}

/** from 之后（不含）的下一个满足 cron 的时间（本地时区，精确到分钟）；两年内找不到返回 null */
export function cronNext(expr: string | CronFields, from: number): number | null {
  const f = typeof expr === 'string' ? parseCron(expr) : expr;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from + 2 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!f.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cronMatchesDay(f, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d.getTime();
  }
  return null;
}

// ------------------------------------------------------------------ 计划

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** 每天 / 每周 / 每月转成 cron */
function toCron(s: ScheduleSpec): string | null {
  const t = TIME_RE.exec(s.time ?? '');
  const hm = t ? `${Number(t[2])} ${Number(t[1])}` : null;
  switch (s.kind) {
    case 'daily':
      return hm && `${hm} * * *`;
    case 'weekly':
      return hm && s.weekdays?.length ? `${hm} * * ${[...new Set(s.weekdays)].sort().join(',')}` : null;
    case 'monthly':
      return hm && s.monthDay ? `${hm} ${s.monthDay} * *` : null;
    case 'cron':
      return s.cron?.trim() || null;
    default:
      return null;
  }
}

/** 计划是否有效；返回中文错误，没有问题时返回 null */
export function validateSchedule(s: ScheduleSpec, now = Date.now()): string | null {
  if (!s || typeof s !== 'object') return '请设置执行计划';
  switch (s.kind) {
    case 'interval':
      return Number.isInteger(s.everyMin) && s.everyMin! >= 1 && s.everyMin! <= 10_080 ? null : '间隔需要是 1–10080 分钟';
    case 'once':
      if (typeof s.at !== 'number' || !Number.isFinite(s.at)) return '请选择执行时间';
      return s.at <= now ? '执行时间已经过去' : null;
    case 'daily':
    case 'weekly':
    case 'monthly':
      if (!TIME_RE.test(s.time ?? '')) return '时间格式是 HH:mm，例如 02:30';
      if (s.kind === 'weekly' && (!Array.isArray(s.weekdays) || !s.weekdays.length || s.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) return '请选择星期几';
      if (s.kind === 'monthly' && (!Number.isInteger(s.monthDay) || s.monthDay! < 1 || s.monthDay! > 31)) return '每月的日期需要是 1–31';
      return null;
    case 'cron':
      try {
        parseCron(s.cron ?? '');
        return cronNext(s.cron!, now) === null ? '这个 cron 表达式两年内不会触发' : null;
      } catch (e) {
        return (e as Error).message;
      }
    default:
      return '不支持的计划类型';
  }
}

/** 下一次执行时间；once 已经执行过（或时间已过）时返回 null */
export function nextRunAt(s: ScheduleSpec, from: number): number | null {
  if (validateSchedule(s, s.kind === 'once' ? 0 : from)) return null;
  if (s.kind === 'interval') return from + s.everyMin! * 60_000;
  if (s.kind === 'once') return s.at! > from ? s.at! : null;
  const cron = toCron(s);
  return cron ? cronNext(cron, from) : null;
}

/** 接下来的几次执行时间（编辑框里预览） */
export function upcomingRuns(s: ScheduleSpec, from: number, count = 3): number[] {
  const out: number[] = [];
  let t = from;
  for (let i = 0; i < count; i++) {
    const n = nextRunAt(s, t);
    if (n === null) break;
    out.push(n);
    if (s.kind === 'once') break;
    t = n;
  }
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const fmt = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 计划的中文说明：每 15 分钟、每天 02:00、每周一、三 09:00 …… */
export function describeSchedule(s: ScheduleSpec): string {
  switch (s.kind) {
    case 'interval': {
      const m = s.everyMin ?? 0;
      return m % 1440 === 0 ? `每 ${m / 1440} 天` : m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`;
    }
    case 'daily':
      return `每天 ${s.time}`;
    case 'weekly':
      return `每周${[...new Set(s.weekdays ?? [])].sort().map((d) => WEEK[d]).join('、')} ${s.time}`;
    case 'monthly':
      return `每月 ${s.monthDay} 日 ${s.time}`;
    case 'once':
      return s.at ? `${fmt(s.at)} 执行一次` : '执行一次';
    case 'cron':
      return `cron：${s.cron}`;
    default:
      return '—';
  }
}
