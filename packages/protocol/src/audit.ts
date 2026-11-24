/**
 * 本地审计与会话录像（文档一 6.12）。本地模式下只保存在本机（默认保留 30 天）；登录后作为 Outbox 上报。
 */
export type AuditSourceKind = 'USER' | 'AGENT' | 'SKILL' | 'SCHEDULE' | 'MCP_EXTERNAL';

export interface AuditEntry {
  id: number;
  kind: 'COMMAND' | 'EVENT';
  source: AuditSourceKind | null;
  /** EVENT 的类型，例如 CREDENTIAL_REVEAL */
  eventType: string | null;
  hostId: string | null;
  hostName: string | null;
  sessionId: string | null;
  command: string | null;
  risk: string | null;
  decision: string | null;
  exitCode: number | null;
  detail: Record<string, unknown> | null;
  createdAt: number;
  uploaded: boolean;
  /** 登录主机的用户名（来自对应的连接录像，没有录像时为主机设置里的用户名；第三十五轮） */
  account?: string | null;
  /** 对应的连接录像（可以直接回放；第三十五轮） */
  recordingId?: string | null;
}

export interface AuditFilter {
  kind: 'COMMAND' | 'EVENT';
  source?: AuditSourceKind | null;
  risk?: string | null;
  q?: string;
  /** 只看这台主机（第三十五轮） */
  hostId?: string | null;
  /** 只按命令内容搜索（命令包含，第三十五轮） */
  command?: string;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

export interface RecordingInfo {
  id: string;
  sessionId: string;
  /** agent：没有打开终端时 Agent 在后台通道执行的命令（第二十六轮），每台主机每个对话一段；schedule：定时任务每次执行每台主机一段（第二十七轮） */
  kind: 'ssh' | 'telnet' | 'serial' | 'local' | 'agent' | 'schedule';
  hostId: string | null;
  hostName: string;
  /** 登录主机用的用户名（第三十五轮，运维审计的连接日志；之前的录像和本机终端为 null） */
  username: string | null;
  cols: number;
  rows: number;
  /** 记录的输出字节数 */
  bytes: number;
  durationMs: number;
  truncated: boolean;
  startedAt: number;
  /** 还在录制中为 null */
  endedAt: number | null;
}

/** 回放数据：asciicast v2 的事件，[秒, 'o' 输出 | 'r' 窗口大小, 数据] */
export interface RecordingData {
  info: RecordingInfo;
  cols: number;
  rows: number;
  events: [number, 'o' | 'r', string][];
}

/** 录像里执行过的命令（第十二轮）：按命令审计记录的时间对应到录像的时间轴 */
export interface RecordingCommand {
  /** 距离录像开始的毫秒数 */
  offsetMs: number;
  command: string;
  source: AuditSourceKind | null;
  /** 执行结果（Agent 执行的命令才有） */
  exitCode: number | null;
}

export const AUDIT_SOURCE_LABEL: Record<AuditSourceKind, string> = {
  USER: '手动',
  AGENT: 'Agent',
  SKILL: 'Skill',
  SCHEDULE: '定时任务',
  MCP_EXTERNAL: '外部 Agent（MCP）',
};
