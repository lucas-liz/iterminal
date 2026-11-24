import { isIP } from 'node:net';
import {
  WEB_SEARCH_COUNT,
  WEB_SEARCH_NO_KEY,
  WEB_SEARCH_NO_SERVER,
  webSearchEndpoints,
  type AgentWebResult,
  type ServerWebSearch,
  type WebSearchSetting,
  type WebSearchStatus,
} from '@itm/protocol';
import type { Db } from '../db/database';
import { open, seal } from '../vault/vault';
import { UserError } from '../../util/errors';

/**
 * 联网搜索（文档一 6.38；第二十五轮改成独立的工具，文档一 6.39）：Agent 的 web_search / web_fetch 由客户端执行，任何能调用工具的模型都能用。
 * 搜索服务和对话模型无关：用服务端的默认配置（管理员配置 Key，经服务端转发），或者自己配置 DeepSeek / 自定义格式的接口。
 */
export interface WebSearchClient {
  /** 界面和审计里显示的搜索服务名称 */
  readonly label: string;
  /** 能不能读取网页（自定义格式没填读取地址时不能） */
  readonly canFetch: boolean;
  search(query: string, count: number, signal: AbortSignal): Promise<WebSearchResult[]>;
  fetchPage(url: string, signal: AbortSignal): Promise<WebPage>;
}

export interface WebSearchResult extends AgentWebResult {
  /** 界面上显示的短摘要 */
  snippet: string;
  /** 给模型看的长摘要（没有时用 snippet） */
  summary: string;
}

export interface WebPage {
  url: string;
  title: string;
  /** Markdown 正文 */
  content: string;
}

/** DeepSeek 官方限制：查询词 1–128 个字符，网址最长 8192 */
export const MAX_QUERY_CHARS = 128;
export const MAX_URL_CHARS = 8192;
const TIMEOUT_MS = 45_000;

/** 对话接口地址去掉 /v1、/anthropic 后缀，就是 Search / Fetch 的根地址 */
export function webToolBase(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/(v1|anthropic)$/i, '');
}

/**
 * 自己配置的搜索服务（HTTP 直连）：
 * - deepseek：POST {根地址}/v1/tools/search {query, count} → {results: [...]}；/v1/tools/fetch {url} → {title, content}；
 * - custom：请求体同时带 DeepSeek 和 Kimi 的字段名（query / text_query、count / limit，多余的字段两家都会忽略），
 *   返回里 results / search_results / data / items 都认，字段名 url / link、snippet / summary / text 等都认。
 */
export class HttpWebSearch implements WebSearchClient {
  readonly canFetch: boolean;

  constructor(
    private readonly o: { format: WebSearchSetting['format']; search: string; fetch: string | null; apiKey: string; label: string },
    private readonly http: typeof fetch = fetch,
  ) {
    this.canFetch = !!o.fetch;
  }

  get label(): string {
    return this.o.label;
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<WebSearchResult[]> {
    const q = query.slice(0, MAX_QUERY_CHARS);
    const body = this.o.format === 'custom' ? { query: q, text_query: q, count, limit: count } : { query: q, count };
    return parseSearchResults(await this.post('search', this.o.search, body, signal)).slice(0, Math.max(count, 1));
  }

  async fetchPage(url: string, signal: AbortSignal): Promise<WebPage> {
    if (!this.o.fetch) throw new UserError('这个搜索服务没有配置网页读取接口，只能搜索');
    return { url, ...parsePage(await this.post('fetch', this.o.fetch, { url }, signal)) };
  }

  private async post(tool: 'search' | 'fetch', url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.http(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
    } catch (e) {
      if (signal.aborted) throw new UserError('已停止');
      if ((e as Error).name === 'TimeoutError') throw new UserError(`${tool === 'search' ? '联网搜索' : '读取网页'}超时（${TIMEOUT_MS / 1000} 秒），请稍后再试`);
      throw new UserError(`连不上${this.o.label}的${tool === 'search' ? '搜索' : '网页读取'}接口：${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new UserError(describeWebError(tool, res.status, errorText(text), false));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UserError(`${tool === 'search' ? '联网搜索' : '读取网页'}返回的不是 JSON（HTTP ${res.status}）`);
    }
  }
}

/** 经服务端登录会话发请求（ServerLink.request） */
export type ServerRequest = <T>(method: 'GET' | 'POST', path: string, body?: unknown, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<T>;

/** 服务端的默认搜索（管理员配置，Key 不下发）：POST /api/v1/ai/web/search、/fetch，服务端统一换成 DeepSeek 的返回格式 */
export class ServerWebSearchClient implements WebSearchClient {
  readonly label: string;
  readonly canFetch: boolean;

  constructor(
    private readonly request: ServerRequest,
    info: ServerWebSearch,
  ) {
    this.label = `${info.label}（服务端）`;
    this.canFetch = info.fetch;
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<WebSearchResult[]> {
    return parseSearchResults(await this.call('/api/v1/ai/web/search', { query: query.slice(0, MAX_QUERY_CHARS), count }, signal)).slice(0, Math.max(count, 1));
  }

  async fetchPage(url: string, signal: AbortSignal): Promise<WebPage> {
    if (!this.canFetch) throw new UserError('服务端的搜索服务没有配置网页读取接口，只能搜索');
    return { url, ...parsePage(await this.call('/api/v1/ai/web/fetch', { url }, signal)) };
  }

  private async call(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    try {
      return await this.request<unknown>('POST', path, body, { signal, timeoutMs: TIMEOUT_MS + 15_000 });
    } catch (e) {
      if (signal.aborted) throw new UserError('已停止');
      const msg = (e as Error).message ?? '';
      // 老版本服务端没有这两个接口（若依 No static resource / 第十五轮起的「接口不存在」）
      if (/No static resource|接口不存在/i.test(msg)) throw new UserError('服务端版本较旧，还不支持联网搜索，请联系管理员更新服务端');
      throw new UserError(msg.replace(/^服务端返回 \d+：/, ''));
    }
  }
}

/** 各家返回格式里的结果列表（DeepSeek results、Kimi search_results、常见的 data / items） */
export function parseSearchResults(j: unknown): WebSearchResult[] {
  const o = (j ?? {}) as Record<string, unknown>;
  const data = o.data as Record<string, unknown> | unknown[] | undefined;
  const list = [o.results, o.search_results, Array.isArray(data) ? data : data?.results, o.items, j].find(Array.isArray) as Record<string, unknown>[] | undefined;
  return (list ?? [])
    .filter((x) => x && typeof x === 'object' && (typeof x.url === 'string' || typeof x.link === 'string'))
    .map((x) => {
      const url = str(x.url) || str(x.link);
      const snippet = str(x.snippet) || str(x.summary) || str(x.description) || str(x.text).slice(0, 300) || str(x.content).slice(0, 300);
      return {
        title: str(x.title) || url,
        url,
        site: str(x.site_name) || str(x.site) || str(x.source) || null,
        date: str(x.date) || str(x.published_date) || str(x.publishedDate) || null,
        snippet,
        summary: str(x.summary) || snippet,
      };
    });
}

/** 网页读取的返回：title + content（或 text / markdown，或者包在 data 里） */
function parsePage(j: unknown): { title: string; content: string } {
  const o = (j ?? {}) as Record<string, unknown>;
  const d = (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
  return { title: str(d.title) || str(o.title), content: str(d.content) || str(d.text) || str(d.markdown) || str(o.content) };
}

/** 按 DeepSeek 文档的状态码说明换成中文提示 */
export function describeWebError(tool: 'search' | 'fetch', status: number, message: string, team: boolean): string {
  const what = tool === 'search' ? '联网搜索' : '读取网页';
  const detail = message ? `：${message}` : '';
  if (status === 401) return team ? '登录已过期，请重新登录后再试' : '联网搜索的 API Key 无效（401），请在「设置 → AI 模型 → 联网搜索」里检查';
  if (status === 402) return team ? '服务端搜索服务的账户余额不足（402），请联系管理员' : '搜索服务的账户余额不足（402），充值后再试';
  if (status === 403) return tool === 'fetch' ? `这个网页被安全策略拒绝读取（403）${detail}` : `没有权限使用${what}（403）${detail}`;
  if (status === 404) return tool === 'fetch' ? '没能读取到这个网页的正文（404），换一个链接试试' : `${what}接口不存在（404），请检查接口地址${detail}`;
  if (status === 408 || status === 504) return `${what}超时（${status}），请稍后再试`;
  if (status === 413) return `${what}请求太大（413）`;
  if (status === 429) return `${what}太频繁（429），请稍后再试${detail}`;
  if (status === 400) return `${what}的参数不正确（400）${detail}`;
  return `${what}失败（HTTP ${status}）${detail}`;
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: { message?: unknown } | string; msg?: unknown; message?: unknown };
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.msg ?? j.message);
    return typeof m === 'string' ? m.slice(0, 300) : '';
  } catch {
    return body.trim().slice(0, 200);
  }
}

// ---------------------------------------------------------------- 用哪个搜索服务

/** 自己配置的 Key 存在 setting 表里但不在设置校验表中，不会随 setting.getAll 发给渲染进程（和本机 MCP 令牌一样） */
const KEY_ROW = 'secret.webSearchKey';

export interface WebSearchDeps {
  db: Db;
  vaultKey: Buffer;
  setting(): WebSearchSetting;
  /** 服务端：登录后才有；info 是管理员配置的默认搜索（没配置为 null） */
  server(): { info: ServerWebSearch | null; request: ServerRequest } | null;
  http?: typeof fetch;
  now?: () => number;
}

export class WebSearchService {
  constructor(private readonly d: WebSearchDeps) {}

  private readKey(): string | null {
    const row = this.d.db.prepare<[string], { value: string }>('SELECT value FROM setting WHERE key = ?').get(KEY_ROW);
    if (!row) return null;
    try {
      return open(this.d.vaultKey, Buffer.from(JSON.parse(row.value) as string, 'base64'), KEY_ROW) || null;
    } catch {
      return null;
    }
  }

  hasKey(): boolean {
    return !!this.readKey();
  }

  saveKey(apiKey: string | null): void {
    const key = (apiKey ?? '').trim();
    if (!key) {
      this.d.db.prepare('DELETE FROM setting WHERE key = ?').run(KEY_ROW);
      return;
    }
    if (key.length > 500 || /\s/.test(key)) throw new UserError('API Key 格式不正确');
    const enc = JSON.stringify(seal(this.d.vaultKey, key, KEY_ROW).toString('base64'));
    this.d.db
      .prepare(
        `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(KEY_ROW, enc, (this.d.now ?? Date.now)());
  }

  /** 当前设置下的状态（输入框的开关、设置页） */
  status(): WebSearchStatus {
    const s = this.d.setting();
    const server = this.d.server();
    const hasKey = this.hasKey();
    const base = { source: s.source, server: server?.info ?? null, hasKey };
    try {
      const c = this.client();
      return { ...base, available: true, label: c.label, reason: null, fetch: c.canFetch };
    } catch (e) {
      return { ...base, available: false, label: null, reason: (e as Error).message, fetch: false };
    }
  }

  /** 按设置选搜索服务；不能用时报错（说明怎么配置），不静默关掉 */
  client(setting = this.d.setting(), apiKey?: string | null): WebSearchClient {
    if (setting.source === 'server') {
      const server = this.d.server();
      if (!server) throw new UserError('使用服务端的联网搜索需要登录；也可以在「设置 → AI 模型 → 联网搜索」里改用自己的 Key');
      if (!server.info?.enabled) throw new UserError(WEB_SEARCH_NO_SERVER);
      return new ServerWebSearchClient(server.request, server.info);
    }
    const key = (apiKey ?? '').trim() || this.readKey();
    if (!key) throw new UserError(WEB_SEARCH_NO_KEY);
    const ep = webSearchEndpoints(setting);
    if (setting.format === 'custom') {
      if (!/^https?:\/\/\S+$/i.test(ep.search)) throw new UserError('自定义搜索接口的地址要以 http:// 或 https:// 开头');
      if (ep.fetch && !/^https?:\/\/\S+$/i.test(ep.fetch)) throw new UserError('网页读取接口的地址要以 http:// 或 https:// 开头');
    }
    let label = setting.format === 'custom' ? '自定义搜索' : 'DeepSeek';
    if (setting.format === 'custom') {
      try {
        label = `自定义搜索（${new URL(ep.search).host}）`;
      } catch {
        // 地址不对时上面已经报错
      }
    }
    return new HttpWebSearch({ format: setting.format, search: ep.search, fetch: ep.fetch, apiKey: key, label }, this.d.http);
  }

  /** 每次搜索的条数：用服务端的默认配置时按管理员设置的，自己配置时按设置里的 */
  count(): number {
    const s = this.d.setting();
    return s.source === 'server' ? (this.d.server()?.info?.count ?? s.count) : s.count;
  }

  /** 设置页「测试」：用表单里的配置搜一次 */
  async test(setting: WebSearchSetting, apiKey?: string | null, query = 'iTerminal'): Promise<{ latencyMs: number; label: string; results: { title: string; url: string }[] }> {
    const c = this.client(setting, apiKey);
    const t0 = Date.now();
    const results = await c.search(query.trim() || 'iTerminal', Math.min(Math.max(setting.count, WEB_SEARCH_COUNT.min), 5), AbortSignal.timeout(60_000));
    return { latencyMs: Date.now() - t0, label: c.label, results: results.map((r) => ({ title: r.title, url: r.url })) };
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------- 发出去之前的检查

/** 内网 IPv4（10/8、172.16/12、192.168/16、127/8、169.254/16、100.64/10、0/8） */
const PRIVATE_V4 = /\b(?:10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}|0(?:\.\d{1,3}){3})\b/g;

/** 查询词里的内网地址换成占位符（不管有没有打开「IP 脱敏」，内网地址都不发到搜索服务） */
export function scrubQuery(query: string, hostTerms: string[] = []): string {
  let out = query.replace(PRIVATE_V4, '[内网地址]').replace(/\bHOST_IP_\d+\b/g, '[内网地址]');
  // 第三十二轮：引用主机的地址和「一看就是内部名字」的主机名也不发给搜索服务
  for (const term of hostTerms) out = out.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[内部主机]');
  return out.replace(/\s+/g, ' ').trim();
}

/** 哪些主机名 / 地址要从搜索词里去掉：地址一律去掉，主机名只去掉带点、下划线、短横或数字的（通用词不动） */
export function hostTerms(items: { name: string; address: string }[]): string[] {
  const out = new Set<string>();
  for (const h of items) {
    if (h.address.trim().length >= 3) out.add(h.address.trim());
    const n = h.name.trim();
    if (n.length >= 3 && /[._\d-]/.test(n)) out.add(n);
  }
  // 长的先替换，避免短的把长的切开
  return [...out].sort((a, b) => b.length - a.length);
}

const INTERNAL_SUFFIX = /\.(local|localdomain|internal|intranet|lan|corp|home|arpa)$/i;

/** 只能读公网的 http / https 网页；返回 null 表示可以读，否则是拒绝的原因 */
export function checkPublicUrl(raw: string): string | null {
  if (raw.length > MAX_URL_CHARS) return `网址太长（超过 ${MAX_URL_CHARS} 个字符）`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '网址格式不正确，需要以 http:// 或 https:// 开头';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '只能读取 http / https 网页';
  if (u.username || u.password) return '网址里不能带用户名或密码';
  if (/HOST_IP_\d+/.test(raw)) return '不能读取内网地址';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || INTERNAL_SUFFIX.test(host)) return '不能读取本机或内网地址';
  const ip = isIP(host);
  if (ip === 4) {
    PRIVATE_V4.lastIndex = 0;
    if (PRIVATE_V4.test(host)) return '不能读取内网地址';
  } else if (ip === 6) {
    if (host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:')) return '不能读取本机或内网地址';
  } else if (!host.includes('.')) {
    return '不能读取内网主机名（没有域名后缀）';
  }
  return null;
}
