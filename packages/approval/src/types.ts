import type { AgentPolicy } from '@itm/protocol';

/** 命令风险等级（文档一 7.5）：L0 只读 / L1 写操作 / L2 高危 / DENY 被策略禁止 */
export type Level = 'L0' | 'L1' | 'L2';
export type RuleLevel = Level | 'DENY';

/** 命令规则（和服务端 ai_command_rule 的字段一致，服务端下发后客户端缓存） */
export interface CommandRule {
  id: number | string;
  level: RuleLevel;
  matchType: 'PREFIX' | 'REGEX' | 'EXACT';
  pattern: string;
  /** 越小越先匹配 */
  priority: number;
  scopeType?: 'GLOBAL' | 'TEAM' | 'FOLDER' | 'HOST';
  scopeId?: string | number;
  note?: string | null;
  enabled?: boolean;
}

/** 全局 AI 策略（服务端 ai_policy.config；本地模式使用客户端设置） */
export interface PolicyConfig {
  /** 生产环境分组的最低风险等级 */
  prodFolderMinLevel: Level;
  /** 名称是这些的分组也按生产环境处理 */
  prodFolderNames: string[];
  nightWindow: { enabled: boolean; from: string; to: string; tz?: string };
  maxCommandsPerTask: number;
  maxToolRounds: number;
  /** 无人值守（定时任务）的权限上限 */
  unattendedCap: AgentPolicy;
  allowLlmReview: boolean;
  /** 只读命令（L0）自动执行 */
  autoReadonlyDefault: boolean;
  /** 命令安全配置（文档一 6.15.7） */
  security: CommandSecurity;
}

/** 用户可以调整的命令安全策略 */
export interface CommandSecurity {
  /** 高危命令（L2）：输入主机名确认 / 单击批准 / 直接拒绝 */
  l2Decision: 'CONFIRM' | 'APPROVE' | 'DENY';
  /** 用户黑名单命中：直接拒绝 / 输入主机名确认 */
  blacklistDecision: 'DENY' | 'CONFIRM';
  /** 严格模式：不在任何规则里的未知命令直接拒绝 */
  strict: boolean;
  /** 命令最大长度（字符），超出拒绝 */
  maxLength: number;
}

export const DEFAULT_SECURITY: CommandSecurity = { l2Decision: 'CONFIRM', blacklistDecision: 'DENY', strict: false, maxLength: 10_000 };

export const DEFAULT_POLICY: PolicyConfig = {
  prodFolderMinLevel: 'L1',
  prodFolderNames: ['生产环境'],
  nightWindow: { enabled: false, from: '00:00', to: '08:00' },
  maxCommandsPerTask: 30,
  maxToolRounds: 40,
  unattendedCap: 'READONLY',
  allowLlmReview: true,
  autoReadonlyDefault: true,
  security: DEFAULT_SECURITY,
};

/** 一条简单命令的判定（审批卡片里逐条展示） */
export interface SegmentResult {
  /** 去掉 sudo、env 等包装后的命令文本 */
  text: string;
  level: RuleLevel;
  reasons: string[];
  ruleId?: number | string;
  /** 没有命中任何规则（严格模式下拒绝） */
  unknown?: boolean;
}

/** 风险判定结果（只看命令本身，不含策略） */
export interface Classification {
  level: RuleLevel;
  reasons: string[];
  matchedRules: (number | string)[];
  segments: SegmentResult[];
  /** 多条命令、命令替换、sh -c 等：LLM 复核时优先 */
  complex: boolean;
  /** tree-sitter 没能完整解析（至少按 L1 处理） */
  parseError: boolean;
}

/**
 * 执行决定：
 * - AUTO：直接执行；
 * - APPROVE：单击批准；
 * - CONFIRM：高危，输入主机名二次确认；
 * - REMOTE：无人值守任务里的写操作，转为远程审批；
 * - DENY：拒绝，并告诉 Agent 原因。
 */
export type Decision = 'AUTO' | 'APPROVE' | 'CONFIRM' | 'REMOTE' | 'DENY';

export interface EvaluateContext {
  /** 主机级命令黑名单（正则），命中 → DENY */
  hostDenylist?: string[];
  /** 有效 Agent 权限（主机 → 分组链 → 全局，就近生效，团队主机取最严格；对话里选的权限替换它）。AI_REVIEW 在这里按 APPROVE 判定，再由调用方交给 AI */
  agentPolicy: AgentPolicy;
  /** 所在分组是生产环境 */
  production: boolean;
  /** 所在分组的名称路径（用于按名称识别生产环境） */
  folderNames?: string[];
  policy: PolicyConfig;
  /** 无人值守（定时任务派发的执行） */
  unattended?: boolean;
  now?: Date;
}

export interface Evaluation extends Classification {
  /** 经过策略调整后的等级（例如生产环境把 L0 提到 L1） */
  effectiveLevel: RuleLevel;
  decision: Decision;
  /** 由 LLM 复核升级过 */
  reviewed?: { from: RuleLevel; to: RuleLevel; reason: string };
}

/** LLM 复核：返回模型认为的等级和理由；只用来升级，不会降级 */
export type LlmReviewer = (command: string, current: Classification) => Promise<{ level: Level; reason: string } | null>;
