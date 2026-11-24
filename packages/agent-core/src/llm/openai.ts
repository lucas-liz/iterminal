import OpenAI from 'openai';
import { effortFor, thinkingBudgetFor, thinkingControlOf, type Effort, type ImageFormat } from '@itm/protocol';
import type { ResolvedModel } from '../model';
import { UserError } from '../errors';
import type { LlmCallInput, LlmCallResult, LlmClient, StopKind, StoredMessage, ToolCall } from './types';

/**
 * opts.echoReasoning：历史回答回传 reasoning_content（DeepSeek 带工具时要求每一轮都回传，千问 Qwen3.8、GLM、Kimi、MiniMax 靠它保持思维链），
 * 以及 OpenRouter 的 reasoning_details（Claude 等模型调用工具时要求原样回传）。
 * 工具调用上厂商附加的字段（Gemini 的思考签名等）总是原样回传。
 */
export function toOpenAiMessages(system: string, messages: StoredMessage[], opts: { echoReasoning?: boolean; imageFormat?: ImageFormat | null } = {}): OpenAI.Chat.ChatCompletionMessageParam[] {
  // 图片：大多数接口认 data URL，少数只认纯 base64（「检测模型能力」会识别，第二十五轮）
  const imageUrl = (img: { mediaType: string; data: string }): string => (opts.imageFormat === 'base64' ? img.data : `data:${img.mediaType};base64,${img.data}`);
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'notice') continue;
    if (m.role === 'user') {
      const images = m.blocks.filter((b) => b.kind === 'image' && b.image);
      const text = m.blocks
        .filter((b) => b.kind !== 'image')
        .map((b) => b.text)
        .join('\n\n');
      // 有图片时用多段内容（文字 + image_url 的 data URL），没有图片时保持纯文字（兼容只认字符串的接口）
      out.push(
        images.length
          ? {
              role: 'user',
              content: [
                { type: 'text', text },
                ...images.map((b) => ({ type: 'image_url' as const, image_url: { url: imageUrl(b.image!) } })),
              ],
            }
          : { role: 'user', content: text },
      );
    } else if (m.role === 'assistant') {
      if (!m.text && m.toolCalls.length === 0) continue;
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(opts.echoReasoning && m.thinking ? { reasoning_content: m.thinking } : {}),
        ...(opts.echoReasoning && m.provider === 'openai' && m.raw?.length ? { reasoning_details: m.raw } : {}),
        ...(m.toolCalls.length > 0
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                ...tc.extra,
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      } as OpenAI.Chat.ChatCompletionAssistantMessageParam);
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.callId, content: r.content });
    }
  }
  return out;
}

function stopKind(reason: string | null | undefined, hasTools: boolean): StopKind {
  if (reason === 'tool_calls' || (hasTools && reason === 'stop')) return 'tool_use';
  if (reason === 'stop') return 'end';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return hasTools ? 'tool_use' : 'end';
}

export function describeOpenAiError(e: unknown): Error {
  if (e instanceof OpenAI.AuthenticationError) return new UserError('API Key 无效（401），请在「设置 → AI 模型」里检查');
  if (e instanceof OpenAI.PermissionDeniedError) return new UserError(`没有权限使用这个模型（403）：${e.message}`);
  if (e instanceof OpenAI.NotFoundError) return new UserError(`模型或接口地址不存在（404）：${e.message}`);
  if (e instanceof OpenAI.RateLimitError) return new UserError('请求过于频繁或额度不足（429），请稍后再试');
  if (e instanceof OpenAI.BadRequestError) return new UserError(`请求被拒绝（400）：${e.message}`);
  if (e instanceof OpenAI.APIUserAbortError) return new UserError('已停止');
  if (e instanceof OpenAI.APIConnectionError) return new UserError(`无法连接到模型接口：${e.message}`);
  if (e instanceof OpenAI.APIError) return new UserError(`模型接口错误（${e.status ?? '未知'}）：${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

/** OpenAI / DeepSeek / 通义 / vLLM / Ollama 等 OpenAI Chat Completions 兼容接口 */
export class OpenAiClient implements LlmClient {
  private readonly client: OpenAI;

  constructor(private readonly resolved: ResolvedModel) {
    if (!resolved.apiKey && resolved.provider.type === 'OPENAI') throw new UserError(`「${resolved.provider.name}」还没有填写 API Key`);
    // 本地 Ollama 等不需要 Key，但 SDK 要求非空
    this.client = new OpenAI({
      apiKey: resolved.apiKey || 'not-needed',
      baseURL: resolved.provider.baseUrl,
      maxRetries: 2,
      ...(resolved.params ? { timeout: resolved.params.timeoutMs } : {}),
    });
  }

  /**
   * 按厂商的方式发送深度思考参数（文档一 6.15.4 / 6.15.5）。第二十五轮按模型的控制方式区分：
   * 自适应档位发强度；Token 预算把档位换算成思考 token 数；仅开关只发开关。
   */
  private thinkingParams(): { extra: Record<string, unknown>; thinkingOn: boolean } {
    const { model, provider, params: p } = this.resolved;
    const reasoning = model.reasoning ?? 'none';
    const optional = reasoning === 'optional';
    const thinkingOn = reasoning === 'always' || (optional && !!p?.thinking);
    const control = thinkingControlOf(model, provider.thinkingStyle);
    // 思考强度按厂商的换算规则换成模型支持的一档（DeepSeek：中 → 高）；没选强度时不发，用模型默认值
    const want = p?.effort ?? model.effort ?? null;
    const effort: Effort | null = thinkingOn && want && control !== 'toggle' ? effortFor(want, model) : null;
    // thinking-type / qwen / minimax：只有自适应档位、且模型标明了支持的强度才发 reasoning_effort（不支持的模型会报错）
    const listedEffort = control === 'effort' && model.efforts?.length ? effort : null;
    const budget = control === 'budget' && thinkingOn ? thinkingBudgetFor(effort, model) : null;
    const extra: Record<string, unknown> = {};
    if (p && reasoning !== 'none') {
      switch (provider.thinkingStyle) {
        case 'openai-effort':
          if (!thinkingOn) extra.reasoning_effort = 'none';
          else if (effort) extra.reasoning_effort = effort;
          break;
        case 'qwen':
          if (optional) extra.enable_thinking = thinkingOn;
          // Qwen3.8 用 reasoning_effort，不能和 thinking_budget 同时设置
          if (listedEffort) extra.reasoning_effort = listedEffort;
          else if (budget) extra.thinking_budget = budget;
          // 老配置（没设置控制方式）填了思考预算：照旧发它
          else if (thinkingOn && (control !== 'toggle' || !model.thinkingControl) && model.thinkingBudget) extra.thinking_budget = model.thinkingBudget;
          break;
        case 'thinking-type':
          if (optional) extra.thinking = budget ? { type: 'enabled', budget_tokens: budget } : { type: thinkingOn ? 'enabled' : 'disabled' };
          else if (budget) extra.thinking = { type: 'enabled', budget_tokens: budget };
          if (listedEffort) extra.reasoning_effort = listedEffort;
          break;
        case 'minimax':
          if (optional) extra.thinking = { type: thinkingOn ? 'adaptive' : 'disabled' };
          // 思考内容放进 reasoning_content，而不是正文里的 <think> 标签
          extra.reasoning_split = true;
          if (listedEffort) extra.reasoning_effort = listedEffort;
          break;
        case 'openrouter':
          extra.reasoning = !thinkingOn ? { effort: 'none' } : budget ? { max_tokens: budget } : effort ? { effort } : { enabled: true };
          break;
        default:
          // 不发思考参数的接口（tags / none）：Token 预算方式按 vLLM、硅基流动等常见的 thinking_budget 发
          if (budget) extra.thinking_budget = budget;
          break;
      }
    }
    if (p) {
      // OpenAI 官方的推理模型不接受温度和 Top-P
      const noSampling = provider.type === 'OPENAI' && reasoning !== 'none';
      if (p.temperature != null && !noSampling) extra.temperature = p.temperature;
      if (p.topP != null && !noSampling) extra.top_p = p.topP;
    }
    return { extra, thinkingOn };
  }

  async call(input: LlmCallInput): Promise<LlmCallResult> {
    const tp = this.thinkingParams();
    const base: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      ...(tp.extra as object),
      model: this.resolved.model.id,
      messages: toOpenAiMessages(input.system, input.messages, { echoReasoning: this.resolved.provider.echoReasoning, imageFormat: this.resolved.model.imageFormat }),
      stream: true,
      ...(input.tools.length > 0
        ? { tools: input.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };
    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create({ ...base, stream_options: { include_usage: true } }, { signal: input.signal });
    } catch (e) {
      // 部分兼容服务不支持 stream_options，去掉后重试一次
      if (e instanceof OpenAI.BadRequestError && /stream_options/i.test(e.message)) {
        stream = await this.client.chat.completions.create(base, { signal: input.signal }).catch((err: unknown) => {
          throw describeOpenAiError(err);
        });
      } else {
        throw describeOpenAiError(e);
      }
    }
    let text = '';
    let thinking = '';
    let finish: string | null = null;
    // 部分模型把思考放在正文的 <think>…</think> 里（MiniMax、本机模型等）
    const tags = new ThinkTagSplitter(
      (t) => {
        text += t;
        input.onText(t);
      },
      (t) => {
        thinking += t;
        input.onThinking(t);
      },
    );
    let usage: LlmCallResult['usage'];
    const calls = new Map<number, { id: string; name: string; args: string; extra: Record<string, unknown> }>();
    // OpenRouter 的 reasoning_details：流式分片按 index 合并，文字字段拼接
    const details: Record<string, unknown>[] = [];
    try {
      for await (const chunk of stream) {
        if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
          reasoning_content?: string | null;
          reasoning?: string | null;
          reasoning_details?: Record<string, unknown>[] | null;
        };
        if (delta.content) tags.push(delta.content);
        const r = delta.reasoning_content ?? delta.reasoning;
        if (r) {
          thinking += r;
          input.onThinking(r);
        }
        for (const d of delta.reasoning_details ?? []) mergeDetail(details, d);
        for (const tc of delta.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: '', name: '', args: '', extra: {} };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          const { index: _i, id: _id, type: _t, function: _f, ...more } = tc as typeof tc & Record<string, unknown>;
          Object.assign(cur.extra, more);
          calls.set(tc.index, cur);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (e) {
      throw describeOpenAiError(e);
    }
    tags.end();
    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([i, c]) => {
        let args: Record<string, unknown> = {};
        let argsError: string | undefined;
        try {
          const parsed: unknown = c.args ? JSON.parse(c.args) : {};
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          else argsError = '工具参数不是 JSON 对象';
        } catch {
          argsError = '工具参数不是合法的 JSON';
        }
        return { id: c.id || `call_${i}_${Date.now()}`, name: c.name, args, argsError, ...(Object.keys(c.extra).length ? { extra: c.extra } : {}) };
      });
    return { provider: 'openai', text, thinking, toolCalls, stop: stopKind(finish, toolCalls.length > 0), usage, ...(details.length ? { raw: details } : {}) };
  }
}

/** 合并一个 reasoning_details 分片：同 index 的条目拼接 text / summary / data，其他字段以后到的为准 */
function mergeDetail(list: Record<string, unknown>[], d: Record<string, unknown>): void {
  const cur = d.index !== undefined ? list.find((x) => x.index === d.index) : undefined;
  if (!cur) {
    list.push({ ...d });
    return;
  }
  for (const [k, v] of Object.entries(d)) {
    if ((k === 'text' || k === 'summary' || k === 'data') && typeof v === 'string' && typeof cur[k] === 'string') cur[k] = (cur[k] as string) + v;
    else if (v !== null && v !== undefined) cur[k] = v;
  }
}

/**
 * 把正文开头的 <think>…</think> 拆成思考内容（流式，标签可能被拆到两个数据块里）。
 * 只处理出现在正文最前面的标签，正文中间出现的 <think> 当普通文字。
 */
export class ThinkTagSplitter {
  private state: 'start' | 'think' | 'text' = 'start';
  private buf = '';

  constructor(
    private readonly onText: (t: string) => void,
    private readonly onThink: (t: string) => void,
  ) {}

  push(chunk: string): void {
    if (this.state === 'text') {
      this.onText(chunk);
      return;
    }
    this.buf += chunk;
    if (this.state === 'start') {
      const trimmed = this.buf.trimStart();
      if (trimmed.length < 7 && '<think>'.startsWith(trimmed)) return; // 还不够判断
      if (!trimmed.startsWith('<think>')) {
        this.state = 'text';
        const t = this.buf;
        this.buf = '';
        this.onText(t);
        return;
      }
      this.state = 'think';
      this.buf = trimmed.slice(7);
    }
    const end = this.buf.indexOf('</think>');
    if (end >= 0) {
      if (end > 0) this.onThink(this.buf.slice(0, end));
      const rest = this.buf.slice(end + 8).replace(/^\s+/, '');
      this.buf = '';
      this.state = 'text';
      if (rest) this.onText(rest);
      return;
    }
    // 保留可能是结束标签开头的尾巴
    const keep = Math.min(this.buf.length, 7);
    const safe = this.buf.length - keep;
    if (safe > 0) {
      this.onThink(this.buf.slice(0, safe));
      this.buf = this.buf.slice(safe);
    }
  }

  end(): void {
    if (!this.buf) return;
    if (this.state === 'think') this.onThink(this.buf);
    else this.onText(this.buf);
    this.buf = '';
  }
}
