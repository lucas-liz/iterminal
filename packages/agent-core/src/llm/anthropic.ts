import Anthropic from '@anthropic-ai/sdk';
import { thinkingBudgetFor, thinkingControlOf } from '@itm/protocol';
import type { ResolvedModel } from '../model';
import { UserError } from '../errors';
import type { LlmCallInput, LlmCallResult, LlmClient, StopKind, StoredMessage, ToolCall } from './types';

/** 支持 adaptive thinking 的 Claude 模型（Haiku 4.5 及更早的模型不支持，不发 thinking 参数） */
const ADAPTIVE_THINKING = /claude-(opus|sonnet)-(4-[678]|5)|claude-haiku-5|claude-(fable|mythos)/;
/** 思考关不掉的模型（发 disabled 会 400）：不管配置成什么都按始终思考处理 */
const ALWAYS_THINKING = /claude-(fable|mythos)|claude-opus-5-5/;
/** 不能用 disabled 关闭思考、要发 between_tools 的模型（Sonnet 5.5） */
const BETWEEN_TOOLS = /claude-sonnet-5-5/;
/** 不接受温度 / Top-P 的模型（Opus 4.7 起、Sonnet 5、Haiku 5.5、Fable、Mythos） */
const NO_SAMPLING = /claude-(opus-(4-[78]|5)|sonnet-5|haiku-5|fable|mythos)/;
const ABOVE_HIGH = new Set(['xhigh', 'max']);
/** 支持服务端拒绝回退（fallbacks: "default"）的模型 */
const SERVER_FALLBACK = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

export function isOfficialAnthropic(baseUrl: string): boolean {
  return /^https:\/\/api\.anthropic\.com(\/|$)/.test(baseUrl);
}

/** 把本地消息转成 Messages API 的格式。Anthropic 自己产生的回答原样回传（含思考块），保证历史不被改写。 */
export function toAnthropicMessages(messages: StoredMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'notice') continue;
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: m.blocks.map((b): Anthropic.ContentBlockParam =>
          b.kind === 'image' && b.image
            ? { type: 'image', source: { type: 'base64', media_type: b.image.mediaType as 'image/png', data: b.image.data } }
            : { type: 'text', text: b.text },
        ),
      });
    } else if (m.role === 'assistant') {
      if (m.provider === 'anthropic' && m.raw && m.raw.length > 0) {
        out.push({ role: 'assistant', content: m.raw as Anthropic.ContentBlockParam[] });
        continue;
      }
      const content: Anthropic.ContentBlockParam[] = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      if (content.length > 0) out.push({ role: 'assistant', content });
    } else {
      out.push({
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.callId, content: r.content, is_error: r.isError })),
      });
    }
  }
  return out;
}

function stopKind(reason: string | null | undefined): StopKind {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

/** 流式结束后拿到的完整消息里我们用到的字段（普通接口和 beta 接口的类型不同，这里只取公共部分） */
interface FinalMessageLike {
  content: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

interface StreamLike {
  on(event: 'text', cb: (delta: string) => void): unknown;
  on(event: 'thinking', cb: (delta: string) => void): unknown;
  finalMessage(): Promise<unknown>;
}

export function describeAnthropicError(e: unknown): Error {
  if (e instanceof Anthropic.AuthenticationError) return new UserError('API Key 无效（401），请在「设置 → AI 模型」里检查');
  if (e instanceof Anthropic.PermissionDeniedError) return new UserError(`没有权限使用这个模型（403）：${e.message}`);
  if (e instanceof Anthropic.NotFoundError) return new UserError(`模型或接口地址不存在（404）：${e.message}`);
  if (e instanceof Anthropic.RateLimitError) return new UserError('请求过于频繁或额度不足（429），请稍后再试');
  if (e instanceof Anthropic.BadRequestError) return new UserError(`请求被拒绝（400）：${e.message}`);
  if (e instanceof Anthropic.APIUserAbortError) return new UserError('已停止');
  if (e instanceof Anthropic.APIConnectionError) return new UserError(`无法连接到模型接口：${e.message}`);
  if (e instanceof Anthropic.APIError) return new UserError(`模型接口错误（${e.status ?? '未知'}）：${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(private readonly resolved: ResolvedModel) {
    if (!resolved.apiKey) throw new UserError(`「${resolved.provider.name}」还没有填写 API Key`);
    this.client = new Anthropic({ apiKey: resolved.apiKey, baseURL: resolved.provider.baseUrl, maxRetries: 2, ...(resolved.params ? { timeout: resolved.params.timeoutMs } : {}) });
  }

  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const { model, provider, params: p } = this.resolved;
    // 深度思考（文档一 6.15.5）：不支持的模型不发 thinking；可选的模型按会话开关；开启时不能设置温度
    const reasoning = ALWAYS_THINKING.test(model.id) ? 'always' : (model.reasoning ?? (ADAPTIVE_THINKING.test(model.id) ? 'optional' : 'none'));
    const thinkingOn = reasoning === 'always' || (reasoning === 'optional' && (p ? p.thinking : true));
    // 控制方式（第二十五轮）：Token 预算 → thinking.enabled + budget_tokens（Claude 旧模型、兼容 Anthropic 格式的第三方接口）；
    // 仅开关 → 不发 effort；自适应档位 → adaptive + output_config.effort
    const control = thinkingControlOf(model, provider.thinkingStyle ?? 'anthropic');
    let effort = control === 'toggle' ? null : (p?.effort ?? model.effort ?? null);
    if (effort === 'minimal') effort = 'low';
    // 关闭思考（disabled / between_tools）只能在 high 及以下的强度使用
    if (reasoning !== 'none' && !thinkingOn && effort && ABOVE_HIGH.has(effort)) effort = 'high';
    const budget = control === 'budget' && thinkingOn ? Math.min(thinkingBudgetFor(effort, model), model.maxOutput - 1) : null;
    const sampling = !thinkingOn && !NO_SAMPLING.test(model.id);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: model.id,
      max_tokens: model.maxOutput,
      system: input.system,
      messages: toAnthropicMessages(input.messages),
      ...(input.tools.length > 0
        ? { tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) }
        : {}),
      // system 和工具定义不变、历史只追加，自动缓存可以命中之前的前缀
      cache_control: { type: 'ephemeral' },
      ...(reasoning === 'none'
        ? {}
        : budget
          ? { thinking: { type: 'enabled', budget_tokens: budget } }
          : thinkingOn
            ? { thinking: { type: 'adaptive', display: 'summarized' } }
            : { thinking: { type: BETWEEN_TOOLS.test(model.id) ? 'between_tools' : 'disabled' } }),
      ...(effort && !budget && (reasoning !== 'none' || model.effort) ? { output_config: { effort } } : {}),
      ...(sampling && p?.temperature != null ? { temperature: p.temperature } : {}),
      ...(sampling && p?.topP != null ? { top_p: p.topP } : {}),
    } as Anthropic.MessageCreateParamsNonStreaming;
    // 官方接口上为支持的模型开启服务端拒绝回退；自定义地址（代理 / 中转）可能不认识 beta 参数，不开启。
    // 工具参数很短，不开启 eager_input_streaming（代理常常不支持这个字段）。
    let stream: StreamLike;
    try {
      stream =
        isOfficialAnthropic(provider.baseUrl) && SERVER_FALLBACK.test(model.id)
          ? (this.client.beta.messages.stream(
              { ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming), betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' },
              { signal: input.signal },
            ) as unknown as StreamLike)
          : (this.client.messages.stream(params, { signal: input.signal }) as unknown as StreamLike);
      stream.on('text', (d) => input.onText(d));
      stream.on('thinking', (d) => input.onThinking(d));
      const msg = (await stream.finalMessage()) as FinalMessageLike;
      const toolCalls: ToolCall[] = [];
      let text = '';
      let thinking = '';
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) text += b.text;
        else if (b.type === 'thinking' && b.thinking) thinking += b.thinking;
        else if (b.type === 'tool_use' && b.id && b.name) {
          const args = b.input && typeof b.input === 'object' && !Array.isArray(b.input) ? (b.input as Record<string, unknown>) : null;
          toolCalls.push({ id: b.id, name: b.name, args: args ?? {}, argsError: args ? undefined : '工具参数不是 JSON 对象' });
        }
      }
      const stop = stopKind(msg.stop_reason);
      const u = msg.usage;
      return {
        provider: 'anthropic',
        text,
        thinking,
        toolCalls,
        stop,
        stopDetail: stop === 'refusal' ? (msg.stop_details?.category ?? undefined) : undefined,
        raw: msg.content as unknown[],
        usage: { input: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens },
      };
    } catch (e) {
      throw describeAnthropicError(e);
    }
  }
}
