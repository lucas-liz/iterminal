import type { WebSearchSetting } from './settings';

/**
 * 联网搜索（第二十五轮，文档一 6.39）：搜索是一个独立的工具，不再和某个模型提供商绑定。
 * - 服务端默认：管理员在管理后台配置搜索服务和 Key（Key 不下发），客户端经服务端调用；
 * - 自己配置：DeepSeek 格式（DeepSeek Search / Fetch 接口），或者自定义（DeepSeek 风格的接口，兼容 Kimi 等字段名）。
 */
export type WebSearchFormat = 'deepseek' | 'custom';
export const WEB_SEARCH_FORMATS: { value: WebSearchFormat; label: string; hint: string }[] = [
  { value: 'deepseek', label: 'DeepSeek', hint: 'DeepSeek 的 Search / Fetch 接口（POST /v1/tools/search、/v1/tools/fetch），使用 DeepSeek API Key' },
  {
    value: 'custom',
    label: '自定义',
    hint: '填写搜索接口和网页读取接口的完整地址：请求体同时带 query / text_query、count / limit，返回 results / search_results / data 里的 title、url、snippet 都能识别（例如 Kimi 的 /v1/tools/search）',
  },
];

/** DeepSeek 官方的搜索服务根地址 */
export const DEEPSEEK_WEB_BASE = 'https://api.deepseek.com';

/** 搜索 / 网页读取的实际地址：DeepSeek 格式由根地址拼出来，自定义直接用填写的地址（读取地址可以留空） */
export function webSearchEndpoints(s: Pick<WebSearchSetting, 'format' | 'baseUrl' | 'searchUrl' | 'fetchUrl'>): { search: string; fetch: string | null } {
  if (s.format === 'custom') return { search: s.searchUrl.trim(), fetch: s.fetchUrl.trim() || null };
  const base = (s.baseUrl.trim() || DEEPSEEK_WEB_BASE).replace(/\/+$/, '').replace(/\/(v1|anthropic)$/i, '');
  return { search: `${base}/v1/tools/search`, fetch: `${base}/v1/tools/fetch` };
}

/** 服务端配置的默认联网搜索（GET /api/v1/ai/web，不含 Key） */
export interface ServerWebSearch {
  enabled: boolean;
  format: WebSearchFormat;
  /** 界面上显示的名称 */
  label: string;
  count: number;
  /** 能不能读取网页（自定义格式没配读取地址时不能） */
  fetch: boolean;
}

/** 输入框「联网」开关和设置页显示用的状态（IPC web.status） */
export interface WebSearchStatus {
  /** 现在能不能联网搜索 */
  available: boolean;
  /** 搜索服务的显示名称，例如「DeepSeek（服务端）」 */
  label: string | null;
  /** 不能用的原因 */
  reason: string | null;
  /** 实际使用的配置来源 */
  source: WebSearchSetting['source'];
  /** 服务端的默认配置（没登录、服务端没配置或版本旧时为 null） */
  server: ServerWebSearch | null;
  /** 自己配置的 Key 已保存 */
  hasKey: boolean;
  /** 能用 web_fetch 读取网页 */
  fetch: boolean;
}

export const WEB_SEARCH_NO_SERVER = '服务端还没有配置联网搜索：请联系管理员在管理后台「大模型 → 联网搜索」里配置，或者在「设置 → AI 模型 → 联网搜索」里改用自己的 Key';
export const WEB_SEARCH_NO_KEY = '联网搜索还没有配置：请在「设置 → AI 模型 → 联网搜索」里填写搜索服务的 API Key';
