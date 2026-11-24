import type { ResolvedModel } from './provider-repo';
import { UserError } from '../../util/errors';

/**
 * 获取模型列表（文档一 6.15.4）：OpenAI 兼容接口 GET {baseUrl}/models，Anthropic GET {baseUrl}/v1/models。
 * 只读取模型 ID，不保存任何东西。
 */
export async function fetchModelList(r: ResolvedModel, timeoutMs = 15_000): Promise<{ id: string; ownedBy?: string; contextWindow?: number }[]> {
  const base = r.provider.baseUrl.replace(/\/+$/, '');
  const anthropic = r.provider.type === 'ANTHROPIC';
  const url = anthropic ? `${base}/v1/models?limit=100` : `${base}/models`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (anthropic) {
    if (r.apiKey) headers['x-api-key'] = r.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (r.apiKey) {
    headers.authorization = `Bearer ${r.apiKey}`;
  }
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (err.name === 'TimeoutError') throw new UserError(`获取模型列表超时（${url}）`);
    throw new UserError(`无法连接到 ${url}：${err.cause?.code ?? err.message}`);
  }
  if (res.status === 401 || res.status === 403) throw new UserError(`API Key 无效或没有权限（${res.status}）`);
  if (res.status === 404) throw new UserError('这个接口不支持获取模型列表（404），请手动填写模型 ID');
  if (!res.ok) throw new UserError(`获取模型列表失败（HTTP ${res.status}）`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UserError('接口返回的不是 JSON');
  }
  const list = (body as { data?: unknown; models?: unknown })?.data ?? (body as { models?: unknown })?.models;
  if (!Array.isArray(list)) throw new UserError('接口返回的格式不认识（没有 data 数组）');
  const out = list
    .map((x) => {
      const o = x as { id?: unknown; name?: unknown; owned_by?: unknown };
      const id = typeof o.id === 'string' ? o.id : typeof o.name === 'string' ? o.name.replace(/^models\//, '') : '';
      const ctx = contextOf(x);
      return id ? { id, ...(typeof o.owned_by === 'string' ? { ownedBy: o.owned_by } : {}), ...(ctx ? { contextWindow: ctx } : {}) } : null;
    })
    .filter((x): x is { id: string; ownedBy?: string; contextWindow?: number } => !!x);
  return [...new Map(out.map((x) => [x.id, x])).values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1000);
}

/**
 * 模型列表里的上下文窗口（第二十五轮）：各家字段名不同——OpenRouter / Kimi context_length、vLLM max_model_len、
 * Gemini inputTokenLimit、部分网关 context_window / max_context_length / top_provider.context_length
 */
function contextOf(x: unknown): number | undefined {
  const o = (x ?? {}) as Record<string, unknown>;
  const top = (o.top_provider ?? {}) as Record<string, unknown>;
  for (const v of [o.context_length, o.context_window, o.max_context_length, o.max_model_len, o.inputTokenLimit, o.input_token_limit, top.context_length]) {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1000 && n <= 100_000_000) return Math.floor(n);
  }
  return undefined;
}
