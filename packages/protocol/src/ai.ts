// ------------------------------------------------------------------ AI 模型与 Agent（文档一第 7 章）

import type { DbResultTable } from './database';
import { AGENT_POLICY_CHOICES, type AgentPolicy } from './core';

/** OPENAI / OPENAI_COMPAT / OLLAMA 都走 OpenAI Chat Completions 协议；ANTHROPIC 走 Messages API */
export type AiProviderType = 'ANTHROPIC' | 'OPENAI' | 'OPENAI_COMPAT' | 'OLLAMA';
/** 思考强度：极低 / 低 / 中 / 高 / 超高 / 最高（minimal 第二十五轮加入，豆包 Seed Evolving、OpenAI 部分模型支持） */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * 深度思考参数的发送方式（文档一 6.15.4）：
 * - anthropic：adaptive thinking + output_config.effort；
 * - openai-effort：reasoning_effort，可开关的模型关闭时发 none（OpenAI、Gemini、Ollama）；
 * - qwen：enable_thinking + reasoning_effort（模型支持时）或 thinking_budget（通义千问）；
 * - thinking-type：thinking.type = enabled / disabled + reasoning_effort（DeepSeek、智谱 GLM、Kimi、豆包）；
 * - minimax：thinking.type = adaptive / disabled + reasoning_split + reasoning_effort（MiniMax）；
 * - openrouter：reasoning.effort，关闭时发 none；
 * - tags / none：不发参数（思考内容从 <think> 标签或 reasoning 字段解析）。
 * reasoning_effort 只在模型设置了 efforts（支持的思考强度）时发送；openai-effort / openrouter 本身就靠强度控制，总是发送。
 */
export type ThinkingStyle = 'anthropic' | 'openai-effort' | 'qwen' | 'thinking-type' | 'minimax' | 'openrouter' | 'tags' | 'none';
export const THINKING_STYLES: readonly ThinkingStyle[] = ['anthropic', 'openai-effort', 'qwen', 'thinking-type', 'minimax', 'openrouter', 'tags', 'none'];
export const EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const EFFORT_LABEL: Record<Effort, string> = { minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };

/**
 * 思考强度怎么控制（第二十五轮，文档一 6.39）：
 * - effort：自适应档位，按选择的档位发 reasoning_effort / output_config.effort 等；
 * - budget：Token 预算，按档位换算成思考 token 数（THINKING_BUDGETS）发 thinking_budget / budget_tokens；
 * - toggle：仅开关，只能开启或关闭思考，不发强度。
 */
export type ThinkingControl = 'effort' | 'budget' | 'toggle';
export const THINKING_CONTROLS: readonly ThinkingControl[] = ['effort', 'budget', 'toggle'];
/** Token 预算方式下各档位对应的思考 token 数（不超过模型最大输出的一半） */
export const THINKING_BUDGETS: Record<Effort, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16_384, xhigh: 32_768, max: 65_536 };

/** 模型实际的思考控制方式：模型设置了就用它；没设置时按发送方式推断（列了强度、或者本身靠强度控制的方式 → 自适应档位） */
export function thinkingControlOf(model: Pick<AiModelConfig, 'thinkingControl' | 'efforts'>, style: ThinkingStyle | null | undefined): ThinkingControl {
  if (model.thinkingControl && THINKING_CONTROLS.includes(model.thinkingControl)) return model.thinkingControl;
  if (model.efforts?.length) return 'effort';
  return style === 'openai-effort' || style === 'openrouter' || style === 'anthropic' ? 'effort' : 'toggle';
}

/** Token 预算方式下这一档的思考 token 数：不超过最大输出的一半，至少 1024 */
export function thinkingBudgetFor(effort: Effort | null, model: Pick<AiModelConfig, 'thinkingBudget' | 'maxOutput'>): number {
  const want = effort ? THINKING_BUDGETS[effort] : (model.thinkingBudget ?? THINKING_BUDGETS.medium);
  return Math.max(1024, Math.min(want, Math.floor(model.maxOutput / 2)));
}

/** 把想要的思考强度换成模型支持的最接近的一档（同样接近时取低的一档）；没有限制时原样返回 */
export function nearestEffort(want: Effort, supported: readonly Effort[] | null | undefined): Effort {
  if (!supported?.length || supported.includes(want)) return want;
  const rank = (e: Effort): number => EFFORTS.indexOf(e);
  return [...supported].sort((a, b) => Math.abs(rank(a) - rank(want)) - Math.abs(rank(b) - rank(want)) || rank(a) - rank(b))[0];
}

/**
 * 厂商官方的思考强度换算（按模型 ID 匹配，个人模型和团队模型都适用）：官方写明了怎么换算时按官方的来，
 * 否则用 nearestEffort。DeepSeek（2026-10 接口文档）：minimal → low，medium / xhigh → high。
 */
const EFFORT_ALIASES: { pattern: RegExp; map: Partial<Record<Effort, Effort>> }[] = [{ pattern: /^deepseek-/i, map: { minimal: 'low', medium: 'high', xhigh: 'high' } }];

/** 实际发给模型的思考强度：厂商的换算规则 > 最接近的一档 */
export function effortFor(want: Effort, model: { id: string; efforts?: readonly Effort[] | null }): Effort {
  const mapped = EFFORT_ALIASES.find((a) => a.pattern.test(model.id))?.map[want];
  if (mapped && (!model.efforts?.length || model.efforts.includes(mapped))) return mapped;
  return nearestEffort(want, model.efforts);
}
/** 模型是否支持深度思考：不支持 / 可以开关 / 始终思考 */
export type ReasoningSupport = 'none' | 'optional' | 'always';

export interface AiModelConfig {
  /** 请求里使用的模型 ID */
  id: string;
  displayName?: string;
  /** 上下文窗口（token），用于占用统计和自动压缩 */
  contextWindow: number;
  /** 单次最大输出（token） */
  maxOutput: number;
  /** 思考强度；不设置则使用全局默认或模型默认值（文档一 6.15.5） */
  effort?: Effort | null;
  /** 是否支持深度思考（不设置时按模型 ID 推断，例如 Claude Opus / Sonnet） */
  reasoning?: ReasoningSupport;
  /** 默认开启思考；null = 跟随全局默认 */
  thinkingDefault?: boolean | null;
  /** 模型支持的思考强度（发 reasoning_effort 时换成最接近的一档）；不设置时 thinking-type / qwen / minimax 方式不发强度 */
  efforts?: Effort[] | null;
  /** 思考预算 token（千问不支持 reasoning_effort 的模型） */
  thinkingBudget?: number | null;
  /** 温度 / Top-P；null = 使用全局默认或模型默认值 */
  temperature?: number | null;
  topP?: number | null;
  /** 支持图片输入 */
  supportsImages?: boolean;
  /** 思考强度的控制方式（第二十五轮）；不设置时按 thinkingControlOf 推断 */
  thinkingControl?: ThinkingControl | null;
  /** 能不能调用工具（智能体模式要用）；null / 不设置 = 没检测过，按能调用处理 */
  supportsTools?: boolean | null;
  /**
   * 图片怎么发（OpenAI 兼容接口，第二十五轮）：data-url = image_url 里放 data:image/…;base64,…（绝大多数厂商）；
   * base64 = image_url 里只放 base64（部分接口只认这种）。Anthropic 协议固定用 base64 图片块。不设置 = data-url
   */
  imageFormat?: ImageFormat | null;
  /** 最近一次「检测模型能力」的结果（「恢复检测结果」用）；手动修改不影响它 */
  probe?: ModelProbe | null;
}

export type ImageFormat = 'data-url' | 'base64';

/** 一项能力的检测结论：true 支持、false 不支持、null 没能判断（说明见 notes） */
export interface ModelProbe {
  at: number;
  /** 从模型列表接口读到的上下文窗口（没有时为空） */
  contextWindow?: number | null;
  images: boolean | null;
  imageFormat?: ImageFormat | null;
  tools: boolean | null;
  /** 思考：none 不支持 / optional 能开关 / always 关不掉 */
  reasoning: ReasoningSupport | null;
  thinkingControl?: ThinkingControl | null;
  /** 接口接受的思考强度 */
  efforts?: Effort[] | null;
  /** 每项能力的说明（为什么判断为不支持 / 没能判断） */
  notes?: Partial<Record<ProbeCapability, string>>;
}
export type ProbeCapability = 'connect' | 'context' | 'images' | 'tools' | 'thinking';

/** 「检测模型能力」的结果（ai.providers.probe） */
export interface ModelProbeResult extends ModelProbe {
  ok: boolean;
  latencyMs: number;
  /** 第一条测试请求的回复 */
  reply: string;
  /** 一共发了几次请求（费用以厂商计费为准） */
  requests: number;
}

/** 一次请求的思考与采样参数（由会话设置、模型设置、全局默认合并而来） */
export interface CallParams {
  thinking: boolean;
  effort: Effort | null;
  temperature: number | null;
  topP: number | null;
  /** 请求超时（毫秒） */
  timeoutMs: number;
}

/** 会话里的深度思考开关（输入框底部，按会话记住） */
export interface ThinkingChoice {
  enabled: boolean;
  effort?: Effort | null;
}

export interface AiProvider {
  id: string;
  name: string;
  type: AiProviderType;
  baseUrl: string;
  /** 是否保存了 API Key（不返回 Key 本身） */
  hasKey: boolean;
  models: AiModelConfig[];
  enabled: boolean;
  /** 厂商预设（AI_VENDOR_PRESETS 的 key）；自定义为 null */
  vendor: string | null;
  thinkingStyle: ThinkingStyle;
  /** 历史回答回传 reasoning_content（DeepSeek、千问、GLM、Kimi、MiniMax 等带工具调用时要求） */
  echoReasoning: boolean;
  updatedAt: number;
  /** team：管理员在服务端配置的团队模型（只读，经服务端代理调用，Key 不下发）；不设置为个人模型 */
  source?: 'team';
  /** 不能使用的原因（例如管理员只允许团队模型） */
  blocked?: string | null;
}

/** apiKey：undefined = 不修改，null / 空串 = 清除 */
export interface AiProviderInput {
  name: string;
  type: AiProviderType;
  baseUrl: string;
  apiKey?: string | null;
  models: AiModelConfig[];
  enabled: boolean;
  vendor?: string | null;
  thinkingStyle?: ThinkingStyle;
  echoReasoning?: boolean;
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export type AgentMode = 'agent' | 'ask';
/** 命令风险等级（文档一 7.5）；DENY 表示被策略禁止 */
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'DENY';

/** 审批引擎的执行决定：自动 / 单击批准 / 输入主机名二次确认 / 远程审批 / 拒绝 */
export type ApprovalDecisionKind = 'AUTO' | 'APPROVE' | 'CONFIRM' | 'REMOTE' | 'DENY';

/** Agent 引用的终端（默认是所有已连接的终端标签） */
export interface AgentTerminalRef {
  /** 终端标签 ID；没有打开终端的主机为 host:{hostId} */
  tabId: string;
  kind: 'ssh' | 'local' | 'telnet' | 'serial';
  title: string;
  sessionId: string | null;
  hostId: string | null;
}

/** 发给模型的图片 */
export interface AgentImage {
  name: string;
  /** image/jpeg | image/png | image/gif | image/webp */
  mediaType: string;
  /** base64（不含 data: 前缀） */
  data: string;
}
export const AGENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
export const MAX_AGENT_IMAGES = 5;
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** 输入框上方的上下文（文档一 7.4） */
export interface AgentRefs {
  terminals: AgentTerminalRef[];
  skillIds: string[];
  /** 整个分组：展开成其中的主机（包含子分组） */
  folderIds?: string[];
  /** 远端文件：只取尾部 tailLines 行（默认 200） */
  files?: { hostId: string; path: string; tailLines?: number }[];
  /** 本机文件（文本，最多 200KB） */
  attachments?: { name: string; path: string }[];
  /** 图片（文档一 6.15.8）：base64，每条消息最多 5 张、每张最多 5MB；只在这一次发送时带上 */
  images?: AgentImage[];
  /** 笔记 */
  noteIds?: string[];
  /**
   * 引用的团队知识库（登录后可用）：知识库 ID，'*' 表示全部可见的知识库。
   * 发送时主进程先用本轮问题检索，把命中的片段放进上下文，不会调用工具的模型也能用上知识库。
   */
  kbCollections?: string[];
  /** 启用的 MCP Server */
  mcpServerIds?: string[];
  /** 引用的数据库资产（编号 d1、d2…，文档一 6.31.3） */
  databaseIds?: string[];
  /** 每个引用终端带上的最近输出行数（只带模型还没看过的部分）；0 = 不带终端输出；不填时按设置 ai.terminalContext */
  terminalLines?: number;
  /**
   * SQL 工作台的 AI 对话（第二十九轮）：当前标签的数据库 / 库 / schema、选中的表和编辑器里的 SQL。
   * 主进程按问题挑出表结构放进上下文，Ask 模式下不调用工具也能写出 SQL。
   */
  sqlContext?: SqlChatContext;
}

export interface SqlChatContext {
  dbId: string;
  database: string | null;
  schema: string | null;
  /** 左侧树里选中的表（优先放进表结构） */
  tables?: string[];
  /** 编辑器里的 SQL（选中的部分或全部，最多 4000 字） */
  sql?: string;
}

/** ssh_exec_batch 的每台主机 */
export interface BatchItem {
  label: string;
  hostName: string;
  /** 每台主机的命令不同时（Skill 并行执行的批量审批）在这里给出 */
  command?: string;
  level: RiskLevel | null;
  decision: ApprovalDecisionKind | null;
  reasons: string[];
  /** 用户在审批卡片里勾选执行 */
  selected: boolean;
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped';
  exitCode: number | null;
  output: string;
}

export type AgentStepStatus = 'pending' | 'approval' | 'running' | 'done' | 'error' | 'rejected';

/** Agent 执行的一步（一次工具调用），在对话里显示在哪台主机上执行了什么 */
export interface AgentStep {
  id: string;
  tool: 'run_command' | 'read_terminal' | 'get_metrics' | string;
  /** 对话里的终端编号，例如 t1 */
  hostLabel: string;
  hostName: string;
  command: string;
  /** 模型给出的命令作用说明（文档一 6.15.1），只给人看 */
  explanation?: string;
  level: RiskLevel | null;
  reasons: string[];
  status: AgentStepStatus;
  exitCode: number | null;
  output: string;
  startedAt: number | null;
  finishedAt: number | null;
  /** 等待审批时的审批 ID */
  approvalId?: string;
  /** L2 高危命令需要输入的确认文字（主机名） */
  confirmText?: string;
  /** 审批引擎的决定 */
  decision?: ApprovalDecisionKind;
  /** LLM 复核升级过风险 */
  reviewed?: string;
  /** sftp_write：改动对比（unified diff） */
  diff?: string;
  /**
   * ask_user：问题和候选答案；answer 为用户的回答。
   * details[i] 是第 i 个选项的一句说明，recommended 是推荐选项的下标，multi = 可以多选（第二十六轮）
   */
  question?: { text: string; options: string[]; details?: string[]; recommended?: number | null; multi?: boolean };
  answer?: string;
  /** memory_propose：原来的和提议的主机记忆；auto = 本次验证过、自动记录的（第二十八轮） */
  memory?: { before: string; after: string; auto?: boolean; replaced?: string | null };
  /** 等待确认的截止时间：过了没有回应就自动跳过（主机记忆 10 秒，第二十八轮） */
  expiresAt?: number;
  /** ssh_exec_batch：每台主机的判定和结果 */
  batch?: BatchItem[];
  /** db_query / db_execute：结果表格（文档一 6.31.6） */
  table?: DbResultTable;
  /** web_search / web_fetch：搜索结果或读取的网页（文档一 6.38） */
  web?: { results: AgentWebResult[] };
}

/** 联网搜索的一条结果（界面展示用） */
export interface AgentWebResult {
  title: string;
  url: string;
  site?: string | null;
  /** 发布时间（RFC 3339 或日期），未知时为空 */
  date?: string | null;
  snippet?: string;
}

export type AgentViewMessage =
  | { id: string; role: 'user'; text: string; refLabels: string[]; mode: AgentMode; createdAt: number; compacted: boolean }
  | {
      id: string;
      role: 'assistant';
      text: string;
      thinking: string;
      steps: AgentStep[];
      model: string;
      createdAt: number;
      compacted: boolean;
      /** 例如「模型拒绝了这个请求」「输出被截断」 */
      notice?: string;
      /** Skill 运行的进度和结论 */
      skillRun?: SkillRunView;
    }
  | { id: string; role: 'summary'; text: string; createdAt: number }
  /** 达到循环上限、连续失败停止等提示 */
  | { id: string; role: 'notice'; text: string; createdAt: number };

export interface ContextUsage {
  /** 模型上下文窗口 */
  window: number;
  used: number;
  percent: number;
  categories: {
    /** 系统提示 + 工具定义 */
    system: number;
    /** 对话消息（问答、命令输出、摘要） */
    messages: number;
    skills: number;
    kb: number;
    /** 引用的终端主机（输出快照） */
    terminals: number;
  };
  /** 是否已用接口返回的真实用量校准过估算 */
  calibrated: boolean;
}

export interface AgentConversationView {
  id: string;
  title: string;
  model: ModelRef | null;
  messages: AgentViewMessage[];
  running: boolean;
  /** 正在生成的回答和思考摘要 */
  streamingText: string;
  streamingThinking: string;
  usage: ContextUsage;
  error: string | null;
  updatedAt: number;
}

export interface AgentConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** 正在执行（第二十六轮：会话列表里转圈） */
  running?: boolean;
}

/** Skill 声明的风险（文档一 7.6）：子 Agent 的权限不能超过它，也不能超过主机的有效 Agent 权限 */
export type SkillRisk = 'readonly' | 'write-needs-approval' | 'dangerous';

export interface SkillParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  description?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  /** 显示名（front matter 的 title，没有时同 name） */
  title: string;
  description: string;
  /** 估算的 token 数 */
  tokens: number;
  version: string | null;
  /** single = 一个 Agent 处理所有目标；parallel = 每台主机一个子 Agent 并行 */
  mode: 'single' | 'parallel';
  risk: SkillRisk;
  /** 并行时同时执行的主机数 */
  concurrency: number;
  /** stop = 第一台失败就取消其余 */
  onError: 'continue' | 'stop';
  /** summary = 最后让模型汇总；raw = 直接列出每台主机的结果 */
  output: 'summary' | 'raw';
  /** 默认目标：folder:分组名、tag:标签、主机名 */
  hosts: string[];
  params: SkillParam[];
  /** 允许使用的工具（空 = 默认的只读工具集） */
  allowedTools: string[];
  triggers: string[];
}

/** 运行 Skill 时选择的目标 */
export interface SkillTargets {
  hostIds?: string[];
  folderIds?: string[];
  tags?: string[];
}

export interface SkillRunHost {
  hostId: string;
  name: string;
  status: 'queued' | 'running' | 'waiting' | 'done' | 'error' | 'canceled';
  /** 子 Agent 最后给出的结论 */
  result: string;
  error: string | null;
  /** 执行过的命令（最近 20 条） */
  commands: { command: string; level: RiskLevel | null; status: AgentStep['status']; exitCode: number | null }[];
  startedAt: number | null;
  finishedAt: number | null;
}

/** 一次 Skill 运行（多主机并行时按主机逐行显示进度和结论） */
export interface SkillRunView {
  runId: string;
  skillId: string;
  skillName: string;
  mode: 'single' | 'parallel';
  risk: SkillRisk;
  concurrency: number;
  params: Record<string, string | number | boolean>;
  hosts: SkillRunHost[];
  summary: string | null;
  status: 'running' | 'done' | 'stopped' | 'error';
  startedAt: number;
  finishedAt: number | null;
}


// ------------------------------------------------------------------ 命令安全配置（文档一 6.15.7）

/** 快捷名单：白名单（只读）/ 危险命令（高危）/ 黑名单（禁止） */
export type CommandRuleList = 'WHITE' | 'DANGER' | 'BLACK';
export type CommandMatchType = 'PREFIX' | 'REGEX' | 'EXACT';

export interface UserCommandRule {
  id: string;
  /** 属于哪个快捷名单；null = 自定义规则 */
  list: CommandRuleList | null;
  level: RiskLevel;
  matchType: CommandMatchType;
  pattern: string;
  /** 自定义规则之间的顺序（越小越先匹配）；快捷名单固定排在自定义规则前面 */
  priority: number;
  note: string | null;
  enabled: boolean;
  updatedAt: number;
}

export interface UserCommandRuleInput {
  level: RiskLevel;
  matchType: CommandMatchType;
  pattern: string;
  priority?: number;
  note?: string | null;
  enabled?: boolean;
}

export interface BuiltinRuleView {
  id: string;
  level: RiskLevel;
  matchType: CommandMatchType;
  pattern: string;
  note: string | null;
}

/** 命令测试：拆分出的每条子命令、命中的规则和在当前策略下的处理方式 */
export interface CommandTestResult {
  level: RiskLevel;
  decision: ApprovalDecisionKind;
  reasons: string[];
  segments: { text: string; level: RiskLevel; rule: string | null; source: 'builtin' | 'user' | 'team' | null; unknown: boolean }[];
}

/**
 * 对话里临时调整的 Agent 权限（第十四轮）：输入框底栏的「权限」。只对当前对话生效，记在本机内存里（重启后回到跟随）。
 * FOLLOW 跟随主机 / 分组 / 设置里的 Agent 权限；其余三档和设置、分组、主机里的一样（AGENT_POLICY_CHOICES），替换主机的
 * Agent 权限（团队主机只能收紧）。黑名单、主机的命令黑名单、夜间窗口、生产环境分组、凭证禁止 AI 引用、Skill 的权限上限照常生效。
 */
export type ChatPolicyMode = 'FOLLOW' | 'APPROVE' | 'AI_REVIEW' | 'AUTO';
export interface ChatPolicy {
  mode: ChatPolicyMode;
  /** 完全允许时，高危命令仍然需要输入主机名确认（默认勾选） */
  confirmHighRisk: boolean;
}
export const DEFAULT_CHAT_POLICY: ChatPolicy = { mode: 'FOLLOW', confirmHighRisk: true };

export const CHAT_POLICY_OPTIONS: { value: ChatPolicyMode; short: string; label: string; description: string }[] = [
  { value: 'FOLLOW', short: '跟随分组', label: '跟随分组', description: '按主机 / 分组设置的 Agent 权限执行，没有设置时用「设置 → Agent 与审批」里的默认权限' },
  ...AGENT_POLICY_CHOICES,
];

/** 对话里选的权限 → Agent 权限（跟随时为 null）：完全允许并取消「高危命令需要二次确认」是 AUTO_ALL */
export function chatAgentPolicy(p: ChatPolicy | undefined): AgentPolicy | null {
  if (!p || p.mode === 'FOLLOW') return null;
  return p.mode === 'AUTO' && !p.confirmHighRisk ? 'AUTO_ALL' : p.mode;
}
