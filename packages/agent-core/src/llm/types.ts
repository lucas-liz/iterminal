import type { AgentMode, AgentStep, SkillRunView } from '@itm/protocol';

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** 模型给出的参数不是合法 JSON 对象时的说明 */
  argsError?: string;
  /** OpenAI 兼容接口：工具调用上厂商附加的字段（例如 Gemini 的 extra_content 思考签名），下一轮原样回传 */
  extra?: Record<string, unknown>;
}

/** 用户消息由多个块组成：本轮引用的终端上下文、Skill、模式说明和问题本身（按类别统计上下文占用） */
export interface UserBlock {
  kind: 'question' | 'context' | 'skill' | 'note' | 'summary' | 'kb' | 'file' | 'attachment' | 'image';
  text: string;
  /** context 块对应的终端编号 */
  label?: string;
  /** kind = image：图片内容（base64） */
  image?: { mediaType: string; data: string };
  /** 只对当前这一轮有效（例如 Ask 模式的说明）：之后的请求里不再带上，不会留在历史里影响后面的轮次 */
  transient?: boolean;
}

export interface ToolResultRecord {
  callId: string;
  name: string;
  /** 发给模型的内容（已脱敏、截断） */
  content: string;
  isError: boolean;
  /** 界面展示用 */
  step: AgentStep;
}

/**
 * 保存在本地的对话消息（与服务商无关）。历史只追加，不改写：发给模型的 system、tools 和之前的消息
 * 每一轮都完全一致（新模型的 preserved thinking 要求），引用内容也追加在当轮用户消息里。
 */
export type StoredMessage =
  | { role: 'user'; blocks: UserBlock[]; mode: AgentMode }
  | {
      role: 'assistant';
      text: string;
      thinking: string;
      toolCalls: ToolCall[];
      provider: 'anthropic' | 'openai';
      model: string;
      /** 下一轮原样回传：Anthropic 是原始 content（含思考块、签名）；OpenAI 兼容接口是 reasoning_details（OpenRouter） */
      raw?: unknown[];
      notice?: string;
      /** Skill 运行的结果卡片（只给界面看，文字部分照常发给模型） */
      skillRun?: SkillRunView;
    }
  | { role: 'tool_results'; results: ToolResultRecord[] }
  /** 只给界面看的提示（达到循环上限、连续失败停止等），不发给模型 */
  | { role: 'notice'; text: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmCallInput {
  system: string;
  messages: StoredMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  onText(delta: string): void;
  onThinking(delta: string): void;
}

export type StopKind = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface LlmCallResult {
  provider: 'anthropic' | 'openai';
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  stop: StopKind;
  /** 拒绝的类别等补充说明 */
  stopDetail?: string;
  raw?: unknown[];
  /** 本次请求的输入（含缓存）和输出 token */
  usage?: { input: number; output: number };
}

export interface LlmClient {
  call(input: LlmCallInput): Promise<LlmCallResult>;
}
