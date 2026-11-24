import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 一轮回答的剧本 */
export interface TurnScript {
  thinking?: string;
  text?: string;
  /** extra：OpenAI 格式里工具调用上附加的字段（例如 Gemini 的 extra_content 思考签名） */
  toolCalls?: { id: string; name: string; input: Record<string, unknown>; extra?: Record<string, unknown> }[];
  /** OpenAI 格式：OpenRouter 的 reasoning_details（每个条目拆成两个分片发送） */
  reasoningDetails?: Record<string, unknown>[];
  /** Anthropic 的 stop_reason；OpenAI 的 finish_reason 会自动换算 */
  stop?: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';
  inputTokens?: number;
  /** 返回 HTTP 错误而不是正常回答 */
  httpError?: { status: number; body: unknown };
}

export interface LlmMock {
  url: string;
  /** 收到的请求（路径、请求头、JSON 请求体） */
  requests: { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[];
  enqueue(...turns: TurnScript[]): void;
  /** 清空还没用掉的剧本（上一个用例停在中途时剩下的） */
  clear(): void;
  /** 按请求内容决定回答（并行的子 Agent 请求顺序不固定时用）；返回 undefined 时再从队列里取 */
  respond(fn: ((body: Record<string, unknown>) => TurnScript | undefined) | null): void;
  /**
   * DeepSeek 的 Search / Fetch 接口（POST /v1/tools/search、/v1/tools/fetch，第二十四轮）：收到的请求和要返回的内容。
   * 不消耗回答剧本；reply 返回 { status, body }（默认 200 + 两条结果 / 一个网页）
   */
  web: {
    requests: { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[];
    reply: ((path: string, body: Record<string, unknown>) => { status: number; body: unknown }) | null;
  };
  close(): Promise<void>;
}

/** /v1/tools/search、/v1/tools/fetch 的默认返回 */
export function defaultWebReply(path: string, body: Record<string, unknown>): { status: number; body: unknown } {
  if (path.endsWith('/search')) {
    return {
      status: 200,
      body: {
        results: [
          { title: 'Nginx 502 排查', url: 'https://nginx.org/502', snippet: '检查 upstream', summary: '502 通常是上游没有响应：先看 upstream 是否存活。', site_name: 'nginx.org', date: '2026-06-01T00:00:00+00:00', rerank_score: 2.1, authority: 3, content: '' },
          { title: `关于「${String(body.query)}」`, url: 'https://example.com/a', snippet: '第二条', summary: '', site_name: null, date: null },
        ],
      },
    };
  }
  return { status: 200, body: { title: '示例网页', content: `# 示例网页\n\n${String(body.url)} 的正文。` } };
}

/** 把字符串切成几段，模拟流式分片到达 */
function pieces(s: string, n = 3): string[] {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

function anthropicEvents(t: TurnScript, model: string): object[] {
  const ev: object[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_mock', type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: t.inputTokens ?? 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ];
  let index = 0;
  if (t.thinking) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    for (const p of pieces(t.thinking)) ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: p } });
    ev.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig-mock' } });
    ev.push({ type: 'content_block_stop', index: index++ });
  }
  if (t.text) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
    for (const p of pieces(t.text)) ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: p } });
    ev.push({ type: 'content_block_stop', index: index++ });
  }
  for (const tc of t.toolCalls ?? []) {
    ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } });
    for (const p of pieces(JSON.stringify(tc.input))) ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: p } });
    ev.push({ type: 'content_block_stop', index: index++ });
  }
  const stop = t.stop ?? (t.toolCalls?.length ? 'tool_use' : 'end_turn');
  ev.push({
    type: 'message_delta',
    delta: { stop_reason: stop, stop_sequence: null, ...(stop === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber', explanation: null } } : {}) },
    usage: { output_tokens: 42 },
  });
  ev.push({ type: 'message_stop' });
  return ev;
}

function openaiChunks(t: TurnScript, model: string): object[] {
  const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1, model };
  const out: object[] = [];
  if (t.thinking) {
    for (const p of pieces(t.thinking)) out.push({ ...base, choices: [{ index: 0, delta: { reasoning_content: p }, finish_reason: null }] });
  }
  (t.reasoningDetails ?? []).forEach((d, index) => {
    const text = typeof d.text === 'string' ? d.text : '';
    const half = Math.ceil(text.length / 2);
    out.push({ ...base, choices: [{ index: 0, delta: { reasoning_details: [{ ...d, index, text: text.slice(0, half), signature: null }] }, finish_reason: null }] });
    out.push({ ...base, choices: [{ index: 0, delta: { reasoning_details: [{ type: d.type, index, text: text.slice(half), signature: d.signature ?? null }] }, finish_reason: null }] });
  });
  if (t.text) {
    for (const p of pieces(t.text)) out.push({ ...base, choices: [{ index: 0, delta: { content: p }, finish_reason: null }] });
  }
  (t.toolCalls ?? []).forEach((tc, i) => {
    const args = pieces(JSON.stringify(tc.input));
    out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: args[0] }, ...tc.extra }] }, finish_reason: null }] });
    for (const a of args.slice(1)) out.push({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: a } }] }, finish_reason: null }] });
  });
  const finish = t.stop === 'max_tokens' ? 'length' : t.stop === 'refusal' ? 'content_filter' : t.toolCalls?.length ? 'tool_calls' : 'stop';
  out.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  out.push({ ...base, choices: [], usage: { prompt_tokens: t.inputTokens ?? 100, completion_tokens: 42, total_tokens: (t.inputTokens ?? 100) + 42 } });
  return out;
}

/** 非流式的 OpenAI Chat Completions 返回 */
function openaiJson(t: TurnScript, model: string): object {
  const finish = t.stop === 'max_tokens' ? 'length' : t.toolCalls?.length ? 'tool_calls' : 'stop';
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: t.text ?? null,
          ...(t.thinking ? { reasoning_content: t.thinking } : {}),
          ...(t.toolCalls?.length ? { tool_calls: t.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) } : {}),
        },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: t.inputTokens ?? 100, completion_tokens: 42, total_tokens: (t.inputTokens ?? 100) + 42 },
  };
}

/** 非流式的 Anthropic Messages 返回 */
function anthropicJson(t: TurnScript, model: string): object {
  const content: object[] = [];
  if (t.thinking) content.push({ type: 'thinking', thinking: t.thinking, signature: 'sig-mock' });
  if (t.text) content.push({ type: 'text', text: t.text });
  for (const tc of t.toolCalls ?? []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  return { id: 'msg_mock', type: 'message', role: 'assistant', model, content, stop_reason: t.toolCalls?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 42 } };
}

/** 「检测模型能力」用的模拟模型：按能力回答图片、工具、思考和档位的探测请求（第二十五轮） */
export interface ProbeCaps {
  images: boolean;
  /** 只认纯 base64（data URL 返回 400） */
  base64Only?: boolean;
  tools: boolean;
  thinking: 'none' | 'optional' | 'always';
  /** 接受的思考强度（其余返回 400）；null = 不校验强度 */
  efforts: string[] | null;
}

export function probeResponder(cap: ProbeCaps): (body: Record<string, unknown>) => TurnScript {
  const bad = (msg: string): TurnScript => ({ httpError: { status: 400, body: { error: { message: msg, type: 'invalid_request_error' } } } });
  return (body) => {
    const effort = (body.reasoning_effort ?? (body.output_config as { effort?: string } | undefined)?.effort ?? (body.reasoning as { effort?: string } | undefined)?.effort) as string | undefined;
    const thinking = body.thinking as { type?: string } | undefined;
    const off = thinking?.type === 'disabled' || thinking?.type === 'between_tools' || body.enable_thinking === false || effort === 'none';
    if (off && cap.thinking === 'always') return bad('thinking cannot be disabled for this model');
    if (effort && effort !== 'none' && cap.efforts && !cap.efforts.includes(effort)) return bad(`invalid reasoning_effort: ${effort}`);
    const msgs = JSON.stringify(body.messages ?? []);
    const thinks = cap.thinking !== 'none' && !off ? '先想一想。' : undefined;
    if (/image_url|"type":"image"/.test(msgs)) {
      if (!cap.images) return /image_url/.test(msgs) ? bad('unknown variant `image_url`, expected `text`') : { text: '我看不到图片' };
      if (cap.base64Only && msgs.includes('data:image')) return bad('invalid image url');
      return { text: '左红右蓝', thinking: thinks };
    }
    if (Array.isArray(body.tools) && body.tools.length) return cap.tools ? { toolCalls: [{ id: 't1', name: 'get_magic_number', input: {} }], thinking: thinks } : { text: '不知道' };
    return { text: msgs.includes('17 × 23') ? '391' : 'OK', thinking: thinks };
  };
}

/** GET /models 返回的模型 */
export const MOCK_MODELS = ['deepseek-flash', 'deepseek-v4-pro', 'mock-coder', 'mock-vision'];

/** 本地模型接口：/v1/messages 按 Anthropic 格式、/chat/completions 按 OpenAI 格式，依次返回排队的剧本 */
export async function startLlmMock(): Promise<LlmMock> {
  const queue: TurnScript[] = [];
  const requests: LlmMock['requests'] = [];
  let responder: ((body: Record<string, unknown>) => TurnScript | undefined) | null = null;
  const web: LlmMock['web'] = { requests: [], reply: null };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // 获取模型列表（文档一 6.15.4）：不消耗剧本
      if (req.method === 'GET' && /\/models(\?|$)/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: MOCK_MODELS.map((id) => ({ id, object: 'model', owned_by: 'mock', ...(id === 'mock-vision' ? { context_length: 262_144 } : {}) })) }));
        return;
      }
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (/\/v1\/tools\/(search|fetch)$/.test(req.url ?? '')) {
        web.requests.push({ path: req.url ?? '', headers: req.headers, body });
        const r = (web.reply ?? defaultWebReply)(req.url ?? '', body);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
        return;
      }
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const turn = responder?.(body) ?? queue.shift() ?? { text: '（没有更多剧本）' };
      if (turn.httpError) {
        res.writeHead(turn.httpError.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(turn.httpError.body));
        return;
      }
      const model = String(body.model ?? 'mock');
      // 不是流式请求（「检测模型能力」，第二十五轮）：一次返回完整的 JSON
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify((req.url ?? '').includes('/messages') ? anthropicJson(turn, model) : openaiJson(turn, model)));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if ((req.url ?? '').includes('/messages')) {
        for (const e of anthropicEvents(turn, model)) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
      } else {
        for (const c of openaiChunks(turn, model)) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    enqueue: (...t) => queue.push(...t),
    clear: () => void queue.splice(0),
    respond: (fn) => {
      responder = fn;
    },
    web,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
