/**
 * 告警中心（第二十八轮，文档一 6.42）：常驻监控、定时任务
 * 触发的告警都记到本机的告警日志里（当时的指标、详情、原始内容），有对应主机时由 AI 自动只读排查，结果发到当前登录账号的邮箱。
 */

/** EXTERNAL：第二十八轮的外部告警接入（第二十九轮已去掉，只为显示旧记录保留） */
export type AlertSource = 'MONITOR' | 'SCHEDULE' | 'EXTERNAL';
export type AlertLevel = 'INFO' | 'WARN' | 'CRIT';

export const ALERT_SOURCE_LABEL: Record<AlertSource, string> = { MONITOR: '常驻监控', SCHEDULE: '定时任务', EXTERNAL: '外部告警' };
export const ALERT_LEVEL_LABEL: Record<AlertLevel, string> = { INFO: '通知', WARN: '警告', CRIT: '严重' };

/** 告警时的主机指标（常驻监控的快照；外部告警有对应主机且正在监控时也带上） */
export interface AlertMetrics {
  at: number;
  cpu: number | null;
  cores: number | null;
  mem: number | null;
  swap: number | null;
  load: [number, number, number] | null;
  disks: { mount: string; usePct: number }[];
  rxBps: number | null;
  txBps: number | null;
  uptimeSec: number | null;
  /** 占用最高的几个进程 */
  procs: { pid: number; user: string; cpu: number; mem: number; command: string }[];
  /** 外部告警带的标签、数值等（键值对） */
  extra?: Record<string, string>;
}

/** 发邮件的结果：没有登录、账号没有邮箱、服务端没有配置邮件服务器时不发 */
export type AlertMailStatus = 'SENT' | 'OFF' | 'NOT_LOGGED_IN' | 'NO_EMAIL' | 'NO_SMTP' | 'RATE_LIMITED' | 'FAILED';
export const ALERT_MAIL_LABEL: Record<AlertMailStatus, string> = {
  SENT: '已发邮件',
  OFF: '没有开启邮件',
  NOT_LOGGED_IN: '没有登录，没有发邮件',
  NO_EMAIL: '账号没有邮箱，没有发邮件',
  NO_SMTP: '服务端没有配置邮件服务器',
  RATE_LIMITED: '邮件太频繁，已跳过',
  FAILED: '邮件发送失败',
};

export interface AlertDiagnosis {
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';
  /** 排查的对话（可以在 AI 对话里查看过程） */
  conversationId: string | null;
  /** 报告（Markdown，第一行是结论） */
  report: string | null;
  level: 'OK' | 'WARN' | 'ERROR' | null;
  message: string | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface AlertEvent {
  id: string;
  source: AlertSource;
  level: AlertLevel;
  title: string;
  /** 详情（纯文本 / Markdown） */
  detail: string;
  hostId: string | null;
  hostName: string | null;
  /** 来源名称：监控项、定时任务名、外部接入名 */
  sourceName: string;
  /** 去重键：同一个键在告警中时只累加次数，不重复排查 */
  key: string;
  status: 'FIRING' | 'RESOLVED';
  count: number;
  createdAt: number;
  lastAt: number;
  resolvedAt: number | null;
  metrics: AlertMetrics | null;
  diagnosis: AlertDiagnosis | null;
  mail: { status: AlertMailStatus; at: number; message: string | null } | null;
  /** 外部告警的原始内容（截断到 16KB） */
  raw: string | null;
  /** 关联：定时任务的执行记录（receiverId 是第二十九轮去掉的外部告警接入留下的旧记录） */
  related: { taskId?: string; runId?: string; receiverId?: string } | null;
}

export interface AlertFilter {
  limit?: number;
  offset?: number;
  source?: AlertSource;
  level?: AlertLevel;
  status?: 'FIRING' | 'RESOLVED';
  hostId?: string;
  q?: string;
  from?: number;
  to?: number;
}

/** 定时任务的告警：什么时候算告警、要不要发邮件（第二十八轮） */
export interface TaskAlertOptions {
  /** NEVER 不告警；FAILED 失败 / 超时；ISSUES 失败或报告结论需要注意 / 异常；ALWAYS 每次结束都记录并发邮件 */
  when: 'NEVER' | 'FAILED' | 'ISSUES' | 'ALWAYS';
  email: boolean;
}
export const DEFAULT_TASK_ALERT: TaskAlertOptions = { when: 'ISSUES', email: true };
