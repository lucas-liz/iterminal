/**
 * 服务端连接、定时任务执行器和远程审批（文档一 6.11、文档二第 7 章）。只在账号模式下启用。
 */
export interface ServerState {
  /** 是否配置了服务端（账号模式） */
  enabled: boolean;
  status: 'off' | 'connecting' | 'online' | 'offline';
  /** 服务端地址：只在主进程里有，发给界面时为 null（界面上不显示服务端地址） */
  url: string | null;
  lastError: string | null;
  connectedAt: number | null;
}

/** 本机保存的账号档案（可以直接切换，令牌过期时重新输入密码） */
export interface AccountProfile {
  id: string;
  username: string;
  displayName: string;
}

/**
 * 账号登录状态（文档一 2.3、文档二 6.1）。
 * valid：令牌可用；expired：刷新令牌失效，需要重新输入密码；revoked：设备被管理员吊销；none：本地模式。
 */
/**
 * 默认的服务端地址：仓库内留空，仅在本地打包时从被 .gitignore 忽略的 `.env`（ITM_DEFAULT_SERVER_URL）注入；
 * 未配置时为纯本地模式（也可由企业预置 ServerUrl 或管理员隐藏设置指定）。
 * 地址只在主进程里使用，界面上任何地方都不显示（登录框也不能填写）。
 */
export const DEFAULT_SERVER_URL = '';
/** 以前的默认地址（可选在本地 `.env` 通过 ITM_LEGACY_SERVER_URLS 注入）：用于旧账号档案启动时迁移 */
export const LEGACY_SERVER_URLS: readonly string[] = [];

export interface AccountState {
  status: 'none' | 'valid' | 'expired' | 'revoked';
  /** 当前档案（本地模式为 local） */
  profileId: string;
  username: string | null;
  displayName: string | null;
  /** 邮箱、头像（data URL，登录时从服务端取回缓存在本机）；没有时为 null */
  email: string | null;
  avatar: string | null;
  /** 过期 / 吊销的原因 */
  message: string | null;
  /** 本机所有的账号档案 */
  profiles: AccountProfile[];
  /** 服务端下发的策略：团队模型数量、是否还允许个人模型（本地模式为 null） */
  team: { models: number; allowPersonalProvider: boolean } | null;
}

/**
 * 隐藏的服务端地址设置（设置 → 关于里连续点 5 次软件图标，输入管理员密码）。
 * custom：管理员设置的地址（没有设置时为 null）；source：当前用的是哪个地址（不把默认地址告诉界面）
 */
export interface AdminServerConfig {
  custom: string | null;
  source: 'custom' | 'preset' | 'default';
}

export interface AdminServerTest {
  ok: boolean;
  message: string;
  ms: number;
}

/** 登录：连接哪个服务端由主进程决定（企业预置地址 > 默认地址；重新登录时用档案自己的地址），界面不传地址 */
export interface LoginInput {
  username: string;
  password: string;
  /** 首次登录时把本地模式的主机、命令、笔记、凭证导入到账号（文档一 6.10.8） */
  importLocal?: boolean;
}

/** 别人（或无人值守任务）请你审批的命令 */
export interface RemoteApproval {
  approvalId: string;
  runId: string;
  taskName: string | null;
  host: string;
  command: string;
  risk: string;
  reasons: string[];
  explanation: string | null;
  diff: string | null;
  expiresAt: number;
  receivedAt: number;
}

export type TaskType = 'COMMAND' | 'SKILL' | 'AGENT_PROMPT' | 'SQL';
export type TaskHostStatus = 'PENDING' | 'RUNNING' | 'WAITING_APPROVAL' | 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'DENIED';

/** 执行记录的筛选（第二十七轮） */
export interface TaskRunFilter {
  limit?: number;
  offset?: number;
  taskId?: string;
  /** 执行过这台主机的记录 */
  hostId?: string;
  /** 状态；ISSUES = 失败 / 部分成功 / 超时，或巡检结论是需要注意 / 异常 */
  status?: TaskRunView['status'] | 'ISSUES';
  /** 任务名称、内容、报告里的关键字 */
  q?: string;
  from?: number;
  to?: number;
}

/** 执行方案里一条命令在一台主机上的结果 */
export interface TaskRunStep {
  command: string;
  purpose: string;
  /** null：没有执行（skipped 说明原因） */
  exitCode: number | null;
  output: string;
  /** 没有执行的原因（被策略拒绝、只读、AI 没有放行……） */
  skipped?: string | null;
  /** 写操作的判定说明（例如「AI 审批通过：……」） */
  note?: string | null;
  durationMs: number;
}

/** 本设备执行过的任务（task.dispatch） */
export interface TaskRunView {
  runId: string;
  taskId: string;
  taskName: string | null;
  type: TaskType;
  status: 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'TIMEOUT' | 'CANCELLED';
  /** 简短说明：命令、Skill 名称或提示词 */
  target: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  hosts: {
    hostId: string;
    hostName: string;
    status: TaskHostStatus;
    exitCode: number | null;
    output: string;
    message: string | null;
    /** 按执行方案执行时每条命令的结果（第二十七轮） */
    steps?: TaskRunStep[];
    /** 这台主机这次执行的终端录像（审计&回放） */
    recordingId?: string | null;
  }[];
  /** 巡检结论（AI 任务的报告第一行） */
  reportLevel?: 'OK' | 'WARN' | 'ERROR' | null;
  /** SERVER：服务端派发；LOCAL：本机定时任务 */
  origin?: 'SERVER' | 'LOCAL';
  /** Agent 介入处理时的对话（可以在 AI 对话里查看过程） */
  conversationId?: string | null;
}

/** 账号能检索的团队知识库（AI 引用知识库时选择） */
export interface KbCollectionInfo {
  id: string;
  name: string;
  description: string | null;
}
