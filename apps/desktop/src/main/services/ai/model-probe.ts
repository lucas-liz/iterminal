import { deflateSync } from 'node:zlib';
import { EFFORTS, effortFor, knownModel, type Effort, type ImageFormat, type ModelProbeResult, type ProbeCapability, type ReasoningSupport, type ThinkingStyle } from '@itm/protocol';
import type { ResolvedModel } from './provider-repo';
import { UserError } from '../../util/errors';

/**
 * 检测模型能力（第二十五轮，文档一 6.39，参考 NewMax 的「检测模型能力」）：直接发几条很短的请求，看接口怎么回应。
 * - 连通：最短的一问一答，失败就停（Key、地址、模型 ID 不对）；
 * - 上下文窗口：模型列表接口给出的（OpenRouter、Kimi、vLLM 等），没有时用已知模型表；
 * - 图片：发一张左红右蓝的图，问两边的颜色。先用 data URL，接口不认时再试纯 base64；能答对才算支持；
 * - 工具调用：给一个工具让模型调用；
 * - 思考：分别发「关闭」和「开启」，看有没有思考内容、关闭会不会报错；再逐个试思考强度，接口不校验强度时不下结论。
 * 每个请求都很短（max_tokens 很小），一共十次左右；费用以厂商计费为准。
 */
export interface ProbeDeps {
  http?: typeof fetch;
  /** 模型列表（带上下文窗口），读不到时返回空 */
  listModels?: () => Promise<{ id: string; contextWindow?: number }[]>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface ChatReply {
  status: number;
  /** 请求被拒绝时接口给的说明 */
  error: string;
  text: string;
  reasoning: string;
  toolCalls: number;
}

interface ChatRequest {
  prompt: string;
  system?: string;
  /** 图片（base64）和发送格式 */
  image?: { data: string; format: ImageFormat };
  tools?: boolean;
  maxTokens: number;
  /** 额外的请求字段（思考参数等） */
  extra?: Record<string, unknown>;
}

const TOOL = { name: 'get_magic_number', description: '返回今天的幸运数字。用户问幸运数字时必须调用这个工具。', parameters: { type: 'object', properties: {}, required: [] as string[] } };

export async function probeModel(r: ResolvedModel, d: ProbeDeps = {}): Promise<ModelProbeResult> {
  const http = d.http ?? fetch;
  const timeoutMs = d.timeoutMs ?? 90_000;
  const anthropic = r.provider.type === 'ANTHROPIC';
  const style: ThinkingStyle = r.provider.thinkingStyle ?? (anthropic ? 'anthropic' : 'none');
  const notes: Partial<Record<ProbeCapability, string>> = {};
  let requests = 0;

  const chat = async (q: ChatRequest): Promise<ChatReply> => {
    requests++;
    const signal = d.signal ? AbortSignal.any([d.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const base = r.provider.baseUrl.replace(/\/+$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    let url: string;
    let body: Record<string, unknown>;
    if (anthropic) {
      url = `${base}/v1/messages`;
      if (r.apiKey) headers['x-api-key'] = r.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      const content: unknown[] = [{ type: 'text', text: q.prompt }];
      if (q.image) content.unshift({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: q.image.data } });
      body = {
        model: r.model.id,
        max_tokens: q.maxTokens,
        messages: [{ role: 'user', content }],
        ...(q.system ? { system: q.system } : {}),
        ...(q.tools ? { tools: [{ name: TOOL.name, description: TOOL.description, input_schema: TOOL.parameters }] } : {}),
        ...q.extra,
      };
    } else {
      url = `${base}/chat/completions`;
      if (r.apiKey) headers.authorization = `Bearer ${r.apiKey}`;
      const content = q.image
        ? [
            { type: 'text', text: q.prompt },
            { type: 'image_url', image_url: { url: q.image.format === 'base64' ? q.image.data : `data:image/png;base64,${q.image.data}` } },
          ]
        : q.prompt;
      body = {
        model: r.model.id,
        max_tokens: q.maxTokens,
        stream: false,
        messages: [...(q.system ? [{ role: 'system', content: q.system }] : []), { role: 'user', content }],
        ...(q.tools ? { tools: [{ type: 'function', function: TOOL }] } : {}),
        ...q.extra,
      };
    }
    let res: Response;
    try {
      res = await http(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (d.signal?.aborted) throw new UserError('已停止');
      const err = e as Error & { cause?: { code?: string } };
      return { status: 0, error: err.name === 'TimeoutError' ? `等待超时（${Math.round(timeoutMs / 1000)} 秒）` : `连不上接口：${err.cause?.code ?? err.message}`, text: '', reasoning: '', toolCalls: 0 };
    }
    const raw = await res.text();
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 不是 JSON：错误时把原文当说明
    }
    if (!res.ok) return { status: res.status, error: errorOf(j, raw), text: '', reasoning: '', toolCalls: 0 };
    return { status: res.status, error: '', ...(anthropic ? parseAnthropic(j) : parseOpenAi(j)) };
  };

  const started = Date.now();
  // ---------------------------------------------------------------- 连通
  const hello = await chat({ prompt: '这是一次连接测试，请只回复「OK」。', maxTokens: 256, extra: offParams(style, r.model.id) ?? undefined });
  // 关闭思考的参数被拒绝时，不带思考参数再试一次（有的模型思考关不掉）
  const first = hello.status >= 400 && hello.status < 500 && offParams(style, r.model.id) ? await chat({ prompt: '这是一次连接测试，请只回复「OK」。', maxTokens: 1024 }) : hello;
  const latencyMs = Date.now() - started;
  if (first.status !== 200) {
    notes.connect = describeStatus(first);
    return { ok: false, latencyMs, reply: '', requests, at: Date.now(), images: null, tools: null, reasoning: null, notes };
  }

  // ---------------------------------------------------------------- 上下文窗口
  let contextWindow: number | null = null;
  try {
    const list = (await d.listModels?.()) ?? [];
    const hit = list.find((x) => x.id === r.model.id);
    if (hit?.contextWindow && hit.contextWindow >= 1000) contextWindow = hit.contextWindow;
  } catch {
    // 拿不到模型列表：用已知模型表
  }
  if (!contextWindow) {
    const known = knownModel(r.model.id);
    if (known) {
      contextWindow = known.contextWindow;
      notes.context = '接口没有给出上下文窗口，按已知模型表填写';
    } else notes.context = '接口没有给出上下文窗口，请按厂商文档填写';
  }

  // ---------------------------------------------------------------- 图片
  let images: boolean | null = null;
  let imageFormat: ImageFormat | null = null;
  const png = testImagePng();
  const imagePrompt = '图片左半边和右半边分别是什么颜色？只用中文回答，格式：左X右Y。';
  const quiet = offParams(style, r.model.id) && first === hello ? offParams(style, r.model.id)! : undefined;
  const formats: ImageFormat[] = anthropic ? ['data-url'] : ['data-url', 'base64'];
  for (const format of formats) {
    const a = await chat({ prompt: imagePrompt, image: { data: png, format }, maxTokens: quiet ? 256 : 2048, extra: quiet });
    if (a.status === 200) {
      const t = a.text;
      if (/红|red/i.test(t) && /蓝|blue/i.test(t)) {
        images = true;
        imageFormat = format;
      } else {
        images = false;
        notes.images = a.text.trim() ? `模型回复没有认出图片内容：${a.text.trim().slice(0, 80)}` : '模型没有回复图片内容（可能不支持图片）';
      }
      break;
    }
    images = false;
    notes.images = `接口拒绝了图片（${describeStatus(a)}）`;
    if (a.status === 0 || a.status === 401 || a.status === 429) {
      images = null;
      break;
    }
  }

  // ---------------------------------------------------------------- 工具调用
  let tools: boolean | null = null;
  const t = await chat({ prompt: '今天的幸运数字是多少？请调用工具查询。', tools: true, maxTokens: quiet ? 256 : 2048, extra: quiet });
  if (t.status === 200) {
    tools = t.toolCalls > 0;
    if (!tools) notes.tools = '模型没有调用工具（智能体模式需要工具调用）';
  } else if (t.status >= 400 && t.status < 500 && t.status !== 401 && t.status !== 429) {
    tools = false;
    notes.tools = `接口拒绝了工具定义（${describeStatus(t)}）`;
  } else notes.tools = describeStatus(t);

  // ---------------------------------------------------------------- 思考
  const question = '17 × 23 等于多少？只回答数字。';
  let reasoning: ReasoningSupport | null = null;
  let efforts: Effort[] | null = null;
  const on = onParams(style, r.model.id);
  const off = offParams(style, r.model.id);
  const withOn = await chat({ prompt: question, maxTokens: 2048, extra: on ?? undefined });
  const thinks = withOn.status === 200 && withOn.reasoning.trim().length > 0;
  let offOk: boolean | null = null;
  if (off) {
    const withOff = await chat({ prompt: question, maxTokens: 256, extra: off });
    if (withOff.status === 200) offOk = withOff.reasoning.trim().length === 0;
    else if (withOff.status >= 400 && withOff.status < 500 && withOff.status !== 401 && withOff.status !== 429) offOk = false;
  }
  if (withOn.status !== 200) {
    notes.thinking = `开启思考的请求被拒绝（${describeStatus(withOn)}）`;
    reasoning = withOn.status >= 400 && withOn.status < 500 && withOn.status !== 429 ? 'none' : null;
  } else if (thinks) reasoning = offOk === false || !off ? 'always' : offOk ? 'optional' : null;
  else {
    reasoning = 'none';
    notes.thinking = style === 'none' || style === 'tags' ? '回复里没有思考内容' : '开启思考后回复里没有思考内容';
  }
  if (reasoning && reasoning !== 'none' && offOk === null && off) notes.thinking = '没能判断思考能不能关闭';

  // 思考强度：先发一个不存在的档位，接口照样接受就说明它不校验，逐个试也没有意义
  if (reasoning && reasoning !== 'none') {
    const effortParam = (e: string): Record<string, unknown> | null => effortParams(style, e, on);
    const bogus = effortParam('bogus-level');
    if (bogus) {
      const b = await chat({ prompt: '1+1=?', maxTokens: 64, extra: bogus });
      if (b.status === 200) notes.thinking = '接口不校验思考强度参数，没法判断支持哪几档，请按厂商文档选择';
      else {
        const accepted: Effort[] = [];
        // 三个一组并发，节省时间
        for (let i = 0; i < EFFORTS.length; i += 3) {
          const group = EFFORTS.slice(i, i + 3);
          const replies = await Promise.all(group.map((e) => chat({ prompt: '1+1=?', maxTokens: 64, extra: effortParam(e)! })));
          replies.forEach((x, k) => {
            if (x.status === 200) accepted.push(group[k]);
          });
        }
        // 厂商官方写明会换算的档位（DeepSeek：中 → 高）不算单独的一档
        efforts = accepted.filter((e) => effortFor(e, { id: r.model.id, efforts: accepted }) === e);
        if (!efforts.length) efforts = null;
      }
    }
  }

  return {
    ok: true,
    latencyMs,
    reply: first.text.trim().slice(0, 200) || '（模型没有返回文字）',
    requests,
    at: Date.now(),
    contextWindow,
    images,
    imageFormat,
    tools,
    reasoning,
    thinkingControl: reasoning && reasoning !== 'none' ? (efforts?.length ? 'effort' : 'toggle') : null,
    efforts,
    notes,
  };
}

// ---------------------------------------------------------------- 各厂商的思考参数

/** 关闭思考的参数；接口没有关闭方式时返回 null */
function offParams(style: ThinkingStyle, modelId: string): Record<string, unknown> | null {
  switch (style) {
    case 'openai-effort':
      return { reasoning_effort: 'none' };
    case 'qwen':
      return { enable_thinking: false };
    case 'thinking-type':
    case 'minimax':
      return { thinking: { type: 'disabled' } };
    case 'openrouter':
      return { reasoning: { effort: 'none' } };
    case 'anthropic':
      return /claude-sonnet-5-5/.test(modelId) ? { thinking: { type: 'between_tools' } } : { thinking: { type: 'disabled' } };
    default:
      return null;
  }
}

/** 开启思考的参数；不需要参数时返回 null */
function onParams(style: ThinkingStyle, modelId: string): Record<string, unknown> | null {
  switch (style) {
    case 'qwen':
      return { enable_thinking: true };
    case 'thinking-type':
      return { thinking: { type: 'enabled' } };
    case 'minimax':
      return { thinking: { type: 'adaptive' }, reasoning_split: true };
    case 'openrouter':
      return { reasoning: { enabled: true } };
    case 'anthropic':
      return /claude-(opus|sonnet)-(4-[678]|5)|claude-haiku-5|claude-(fable|mythos)/.test(modelId) ? { thinking: { type: 'adaptive' } } : { thinking: { type: 'enabled', budget_tokens: 1024 } };
    default:
      return null;
  }
}

/** 带思考强度的参数（开启思考的参数 + 强度）；这种发送方式没有强度时返回 null */
function effortParams(style: ThinkingStyle, effort: string, on: Record<string, unknown> | null): Record<string, unknown> | null {
  switch (style) {
    case 'openai-effort':
    case 'qwen':
    case 'thinking-type':
    case 'minimax':
      return { ...on, reasoning_effort: effort };
    case 'openrouter':
      return { reasoning: { effort } };
    case 'anthropic':
      return { ...on, output_config: { effort } };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 解析回复

function parseOpenAi(j: Record<string, unknown>): Omit<ChatReply, 'status' | 'error'> {
  const msg = ((j.choices as Record<string, unknown>[] | undefined)?.[0]?.message ?? {}) as Record<string, unknown>;
  let text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? (msg.content as { text?: string }[]).map((p) => p.text ?? '').join('') : '';
  let reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : typeof msg.reasoning === 'string' ? msg.reasoning : '';
  const tag = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(text);
  if (tag) {
    reasoning ||= tag[1];
    text = text.slice(tag[0].length);
  }
  // 有的接口不返回思考内容，只在用量里写思考 token 数
  const usage = j.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
  if (!reasoning && (usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0) reasoning = '（接口没有返回思考内容，但用量里有思考 token）';
  return { text, reasoning, toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0 };
}

function parseAnthropic(j: Record<string, unknown>): Omit<ChatReply, 'status' | 'error'> {
  const blocks = Array.isArray(j.content) ? (j.content as Record<string, unknown>[]) : [];
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join(''),
    reasoning: blocks.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').map((b) => String(b.thinking ?? '（加密的思考内容）')).join(''),
    toolCalls: blocks.filter((b) => b.type === 'tool_use').length,
  };
}

function errorOf(j: Record<string, unknown>, raw: string): string {
  const e = j.error as Record<string, unknown> | string | undefined;
  const m = typeof e === 'string' ? e : (e?.message ?? j.message ?? j.msg);
  return (typeof m === 'string' ? m : raw.trim()).slice(0, 200);
}

function describeStatus(a: ChatReply): string {
  if (a.status === 0) return a.error;
  if (a.status === 401 || a.status === 403) return `API Key 无效或没有权限（${a.status}）${a.error ? `：${a.error}` : ''}`;
  if (a.status === 404) return `模型或接口地址不存在（404）${a.error ? `：${a.error}` : ''}`;
  if (a.status === 429) return `请求太频繁或额度不足（429）${a.error ? `：${a.error}` : ''}`;
  return `HTTP ${a.status}${a.error ? `：${a.error}` : ''}`;
}

// ---------------------------------------------------------------- 测试图片

/** 64×32 的 PNG：左半边红、右半边蓝（不依赖图片库，手写 PNG 编码） */
export function testImagePng(): string {
  const w = 64;
  const h = 32;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // 不做行过滤
    for (let x = 0; x < w; x++) {
      const i = row + 1 + x * 3;
      if (x < w / 2) raw[i] = 0xe0;
      else {
        raw[i + 1] = 0x40;
        raw[i + 2] = 0xe0;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return png.toString('base64');
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
