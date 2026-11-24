/**
 * 问题反馈和诊断日志（第十三轮，文档一 6.27.1）。
 * 诊断日志（操作轨迹）一直在本机记录：主进程写 {userData}/logs/main.log（超过 2MB 轮转为 main.old.log），内存里保留最近 1000 条；
 * 反馈时把环境信息、操作轨迹、错误、日志尾部打包成 diagnostics.json / diagnostics.md，和截图一起提交到服务端。
 */

export type DiagLevel = 'debug' | 'info' | 'warn' | 'error';
/** app 应用、ipc 界面调用主进程、event 主进程推送的状态、ui 用户操作、console 界面日志、error 异常、net 访问服务端 */
export type DiagCategory = 'app' | 'ipc' | 'event' | 'ui' | 'console' | 'error' | 'net';

/** 一条操作轨迹（breadcrumb） */
export interface DiagEntry {
  /** 时间（毫秒时间戳） */
  t: number;
  level: DiagLevel;
  cat: DiagCategory;
  msg: string;
  data?: unknown;
  /** main：主进程；renderer：界面 */
  src?: 'main' | 'renderer';
}

/** 诊断包（diagnostics.json），服务端管理后台据此画时间线 */
export interface Diagnostics {
  format: 'itm-diag';
  version: 1;
  createdAt: number;
  /** 环境信息：分节 → 名称 → 值 */
  env: FeedbackEnv;
  breadcrumbs: DiagEntry[];
  errors: DiagEntry[];
  /** main.old.log + main.log 的最后 300KB */
  logTail: string;
}

export type FeedbackEnv = Record<string, Record<string, string | number | boolean | null>>;

export type FeedbackCategory = 'BUG' | 'SUGGESTION' | 'QUESTION' | 'OTHER';
export const FEEDBACK_CATEGORY_LABEL: Record<FeedbackCategory, string> = { BUG: '问题', SUGGESTION: '建议', QUESTION: '咨询', OTHER: '其他' };
export type FeedbackStatus = 'NEW' | 'PROCESSING' | 'RESOLVED' | 'CLOSED';
export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = { NEW: '已提交', PROCESSING: '处理中', RESOLVED: '已解决', CLOSED: '已关闭' };

export const FEEDBACK_MAX_IMAGES = 6;
export const FEEDBACK_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** 截图 / 图片（界面里预览，提交时交给主进程） */
export interface FeedbackImage {
  name: string;
  /** image/png、image/jpeg、image/gif、image/webp */
  type: string;
  /** base64（不带 data: 前缀） */
  data: string;
  size: number;
}

/** 提交前的预览（和服务端看到的一样） */
export interface FeedbackPreview {
  env: FeedbackEnv;
  /** diagnostics.md 的内容（不含用户填写的描述） */
  markdown: string;
  breadcrumbs: number;
  errors: number;
  logBytes: number;
  /** anonymous = 本地模式，走匿名接口（不告诉界面服务端地址） */
  target: { anonymous: boolean };
}

export interface FeedbackInput {
  category: FeedbackCategory;
  title: string;
  description: string;
  contact: string;
  images: FeedbackImage[];
  /** 附带诊断信息（环境 + 操作轨迹 + 错误 + 日志尾部） */
  includeDiagnostics: boolean;
  /** IP 地址替换成 HOST_IP_n */
  maskIps: boolean;
}

export interface FeedbackRecord {
  id: number;
  category: FeedbackCategory;
  title: string;
  status: FeedbackStatus;
  reply: string;
  handledAt: number | null;
  createdAt: number;
}
