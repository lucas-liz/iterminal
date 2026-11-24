import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as pty from 'node-pty';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_VENDOR_PRESETS,
  DEFAULT_SETTINGS,
  effortFor,
  guessModel,
  knownModel,
  thinkingBudgetFor,
  thinkingControlOf,
  vendorsInTab,
  webSearchEndpoints,
  type AgentConversationView,
  type AiProviderInput,
  type IpcEventName,
  type IpcEvents,
  type ModelRef,
} from '@itm/protocol';
import { AnthropicClient, OpenAiClient, type ResolvedModel as CoreResolved, type StoredMessage } from '@itm/agent-core';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { createRepos } from './support/repos';
import { probeResponder, startLlmMock, type LlmMock } from './support/llm-mock';
import { AiProviderRepo, type ResolvedModel } from '../src/main/services/ai/provider-repo';
import { probeModel, testImagePng } from '../src/main/services/ai/model-probe';
import { fetchModelList } from '../src/main/services/ai/model-list';
import { HttpWebSearch, ServerWebSearchClient, WebSearchService, parseSearchResults } from '../src/main/services/ai/web-search';
import { sanitizeServerWeb, sanitizeTeamPolicy, sanitizeTeamProviders } from '../src/main/services/server/team-policy';
import { SettingsRepo } from '../src/main/services/settings/settings-repo';
import { formatTokens, parseTokens } from '../src/renderer/src/util/model-tokens';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SessionManager } from '../src/main/services/connection/session-manager';
import { MonitorService } from '../src/main/services/monitor/monitor-service';
import { SkillStore } from '../src/main/services/ai/skills';
import { AgentService } from '../src/main/services/ai/agent-service';
import { InlineRuntime } from '../src/main/services/ai/runtime';
import { AuditRepo } from '../src/main/services/audit/audit-repo';

/**
 * 第二十五轮（文档一 6.39）：联网搜索独立成工具（服务端默认 / 自己配置 DeepSeek 或自定义格式）、模型的思考控制方式和档位、
 * 图片发送格式、「检测模型能力」、图片识别 Fallback、按 NewMax 重排的厂商预设。
 */

describe('模型能力的协议', () => {
  it('思考控制方式：模型设置了就用它；列了档位或本身靠强度控制的方式 → 自适应档位；否则仅开关', () => {
    expect(thinkingControlOf({ thinkingControl: 'budget', efforts: ['low'] }, 'thinking-type')).toBe('budget');
    expect(thinkingControlOf({ efforts: ['low', 'high'] }, 'thinking-type')).toBe('effort');
    expect(thinkingControlOf({}, 'anthropic')).toBe('effort');
    expect(thinkingControlOf({}, 'openai-effort')).toBe('effort');
    expect(thinkingControlOf({}, 'thinking-type')).toBe('toggle');
    expect(thinkingControlOf({}, null)).toBe('toggle');
  });

  it('Token 预算：按档位换算，不超过最大输出的一半，至少 1024', () => {
    expect(thinkingBudgetFor('high', { maxOutput: 128_000 })).toBe(16_384);
    expect(thinkingBudgetFor('max', { maxOutput: 32_000 })).toBe(16_000);
    expect(thinkingBudgetFor(null, { maxOutput: 128_000, thinkingBudget: 4000 })).toBe(4000);
    expect(thinkingBudgetFor('minimal', { maxOutput: 1500 })).toBe(1024);
  });

  it('DeepSeek 官方换算：极低 → 低，中 / 超高 → 高', () => {
    const ds = { id: 'deepseek-flash', efforts: ['low', 'high', 'max'] as ('low' | 'high' | 'max')[] };
    expect(effortFor('minimal', ds)).toBe('low');
    expect(effortFor('medium', ds)).toBe('high');
    expect(effortFor('xhigh', ds)).toBe('high');
    expect(effortFor('minimal', { id: 'gpt-6-astra', efforts: ['low', 'medium'] })).toBe('low');
  });

  it('厂商预设：按 推荐 / 国内 / 聚合 / 海外 / 本地 分类；自定义在本地模型里；预设里不再有联网搜索', () => {
    expect(vendorsInTab('recommended').map((p) => p.key)).toEqual(['deepseek', 'qwen', 'zhipu', 'moonshot']);
    expect(vendorsInTab('local').map((p) => p.key)).toEqual(['ollama', 'lmstudio', 'custom']);
    expect(vendorsInTab('aggregator').map((p) => p.key)).toEqual(expect.arrayContaining(['openrouter', 'siliconflow', 'modelscope']));
    expect(vendorsInTab('intl').every((p) => p.needsProxy)).toBe(true);
    expect(JSON.stringify(AI_VENDOR_PRESETS)).not.toContain('webSearch');
    // 每个预设模型都写明了思考控制方式；列了档位的一定是自适应档位或 Token 预算
    for (const m of AI_VENDOR_PRESETS.flatMap((p) => p.models)) {
      if (m.reasoning && m.reasoning !== 'none') expect(m.thinkingControl, m.id).toBeTruthy();
      if (m.efforts?.length) expect(['effort', 'budget'], m.id).toContain(m.thinkingControl);
    }
  });

  it('按模型 ID 认出已知模型（大小写、厂商/模型 形式都认）；认不出时按 ID 推断', () => {
    expect(knownModel('DeepSeek-Flash')).toMatchObject({ id: 'DeepSeek-Flash', supportsImages: true, efforts: ['low', 'high', 'max'] });
    expect(knownModel('moonshotai/kimi-k3')).toMatchObject({ reasoning: 'always', supportsImages: true });
    expect(knownModel('glm-4.6v')).toMatchObject({ supportsImages: true, contextWindow: 128_000 });
    expect(knownModel('nobody-knows')).toBeNull();
    expect(guessModel('OPENAI_COMPAT', 'qwen3-vl-72b')).toMatchObject({ supportsImages: true, reasoning: 'optional' });
    expect(guessModel('OPENAI_COMPAT', 'llama-3-8b')).toMatchObject({ supportsImages: false, reasoning: 'none', contextWindow: 128_000 });
  });

  it('联网搜索地址：DeepSeek 由根地址拼出来（去掉 /v1），自定义用填写的地址', () => {
    expect(webSearchEndpoints({ format: 'deepseek', baseUrl: '', searchUrl: '', fetchUrl: '' })).toEqual({ search: 'https://api.deepseek.com/v1/tools/search', fetch: 'https://api.deepseek.com/v1/tools/fetch' });
    expect(webSearchEndpoints({ format: 'deepseek', baseUrl: 'https://proxy.example.com/v1/', searchUrl: '', fetchUrl: '' }).search).toBe('https://proxy.example.com/v1/tools/search');
    expect(webSearchEndpoints({ format: 'custom', baseUrl: '', searchUrl: ' https://api.moonshot.cn/v1/tools/search ', fetchUrl: '' })).toEqual({ search: 'https://api.moonshot.cn/v1/tools/search', fetch: null });
  });

  it('上下文窗口的输入：纯数字按 k、支持 k / M，最大 10M；显示成 128K / 1M / 256K（1024 进制）', () => {
    expect(parseTokens('128')).toBe(128_000);
    expect(parseTokens('200k')).toBe(200_000);
    expect(parseTokens('1M')).toBe(1_000_000);
    expect(parseTokens('1.5m')).toBe(1_500_000);
    expect(parseTokens(' ')).toBeNull();
    expect(parseTokens('11M')).toBeNaN();
    expect(parseTokens('abc')).toBeNaN();
    expect(formatTokens(128_000)).toBe('128K');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(1_048_576)).toBe('1M');
    expect(formatTokens(262_144)).toBe('256K');
    expect(formatTokens(8192)).toBe('8K');
    expect(formatTokens(202_752)).toBe('198K');
    expect(formatTokens(1_050_000)).toBe('1.05M');
  });
});

// ---------------------------------------------------------------- 发给模型的参数

const user = (text: string, image = false): StoredMessage => ({
  role: 'user',
  mode: 'ask',
  blocks: [...(image ? [{ kind: 'image' as const, label: 'a.png', text: '[图片 a.png]', image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' } }] : []), { kind: 'question', text }],
});

describe('思考参数和图片格式（OpenAI 兼容 / Anthropic）', () => {
  let mock: LlmMock;
  beforeAll(async () => {
    mock = await startLlmMock();
  });
  afterAll(async () => {
    await mock.close();
  });
  const call = async (r: CoreResolved, image = false): Promise<Record<string, unknown>> => {
    mock.enqueue({ text: 'ok' });
    const n = mock.requests.length;
    const client = r.provider.type === 'ANTHROPIC' ? new AnthropicClient(r) : new OpenAiClient(r);
    await client.call({ system: 's', messages: [user('hi', image)], tools: [], signal: new AbortController().signal, onText: () => undefined, onThinking: () => undefined });
    return mock.requests[n].body;
  };
  const params = { thinking: true, effort: 'high' as const, temperature: null, topP: null, timeoutMs: 30_000 };

  it('千问 Token 预算：enable_thinking + thinking_budget（按档位换算）；仅开关的模型不发强度', async () => {
    const base = { provider: { id: 'p', name: 'Q', type: 'OPENAI_COMPAT' as const, baseUrl: mock.url, thinkingStyle: 'qwen' as const }, apiKey: 'k' };
    const budget = await call({ ...base, model: { id: 'qwen3.7-plus', contextWindow: 100_000, maxOutput: 65_536, reasoning: 'optional', thinkingControl: 'budget', efforts: ['low', 'medium', 'high'] }, params });
    expect(budget).toMatchObject({ enable_thinking: true, thinking_budget: 16_384 });
    expect(budget.reasoning_effort).toBeUndefined();
    const toggle = await call({ ...base, model: { id: 'qwen3.7-plus', contextWindow: 100_000, maxOutput: 65_536, reasoning: 'optional', thinkingControl: 'toggle', efforts: ['low', 'high'] }, params });
    expect(toggle).toMatchObject({ enable_thinking: true });
    expect(toggle.reasoning_effort).toBeUndefined();
    expect(toggle.thinking_budget).toBeUndefined();
  });

  it('DeepSeek 自适应档位：thinking.enabled + reasoning_effort；图片默认 data URL，标了纯 base64 的模型只发 base64', async () => {
    const r = { provider: { id: 'p', name: 'D', type: 'OPENAI_COMPAT' as const, baseUrl: mock.url, thinkingStyle: 'thinking-type' as const }, apiKey: 'k' };
    const ds = await call({ ...r, model: { id: 'deepseek-flash', contextWindow: 100_000, maxOutput: 8000, reasoning: 'optional', efforts: ['low', 'high', 'max'], supportsImages: true }, params: { ...params, effort: 'minimal' } }, true);
    expect(ds).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low' });
    expect(JSON.stringify(ds.messages)).toContain('"url":"data:image/png;base64,iVBORw0KGgo="');
    const raw = await call({ ...r, model: { id: 'glm-4v', contextWindow: 100_000, maxOutput: 8000, supportsImages: true, imageFormat: 'base64' }, params }, true);
    expect(JSON.stringify(raw.messages)).toContain('"url":"iVBORw0KGgo="');
  });

  it('Anthropic 格式的 Token 预算：thinking.enabled + budget_tokens，不发 output_config.effort', async () => {
    const body = await call({
      provider: { id: 'p', name: 'A', type: 'ANTHROPIC', baseUrl: mock.url, thinkingStyle: 'anthropic' },
      apiKey: 'k',
      model: { id: 'claude-haiku-4-5', contextWindow: 200_000, maxOutput: 64_000, reasoning: 'optional', thinkingControl: 'budget' },
      params: { ...params, effort: 'medium' },
    });
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.output_config).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 检测模型能力

describe('检测模型能力', () => {
  let mock: LlmMock;
  beforeAll(async () => {
    mock = await startLlmMock();
  });
  afterAll(async () => {
    await mock.close();
  });
  afterEach(() => mock.respond(null));
  const target = (model: string, style: 'thinking-type' | 'anthropic' | 'none' = 'thinking-type', type: 'OPENAI_COMPAT' | 'ANTHROPIC' = 'OPENAI_COMPAT'): ResolvedModel => ({
    provider: { id: 'd', name: 'D', type, baseUrl: mock.url, hasKey: true, models: [], enabled: true, vendor: null, thinkingStyle: style, echoReasoning: false, updatedAt: 0 },
    apiKey: 'k',
    model: { id: model, contextWindow: 128_000, maxOutput: 8192 },
  });

  it('DeepSeek 式的模型：图片（data URL）、工具、能关闭的思考；档位按官方换算后是 低 / 高 / 最高；窗口从模型列表读', async () => {
    mock.respond(probeResponder({ images: true, tools: true, thinking: 'optional', efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] }));
    const r = target('mock-vision');
    r.model.id = 'deepseek-flash';
    const res = await probeModel(r, { listModels: async () => [{ id: 'deepseek-flash', contextWindow: 1_000_000 }] });
    expect(res).toMatchObject({ ok: true, images: true, imageFormat: 'data-url', tools: true, reasoning: 'optional', thinkingControl: 'effort', efforts: ['low', 'high', 'max'], contextWindow: 1_000_000 });
    expect(res.reply).toBe('OK');
    expect(res.requests).toBeGreaterThanOrEqual(10);
  });

  it('只认纯 base64 的图片、不会调用工具、思考关不掉、不校验档位', async () => {
    mock.respond(probeResponder({ images: true, base64Only: true, tools: false, thinking: 'always', efforts: null }));
    const res = await probeModel(target('glm-x'));
    expect(res).toMatchObject({ ok: true, images: true, imageFormat: 'base64', tools: false, reasoning: 'always', efforts: null, thinkingControl: 'toggle' });
    expect(res.notes?.thinking).toContain('不校验');
    expect(res.notes?.tools).toContain('没有调用工具');
  });

  it('看不了图片、不会思考：图片被拒绝时给出原因；Anthropic 格式也能检测', async () => {
    mock.respond(probeResponder({ images: false, tools: true, thinking: 'none', efforts: null }));
    const res = await probeModel(target('plain'));
    expect(res).toMatchObject({ ok: true, images: false, tools: true, reasoning: 'none' });
    expect(res.notes?.images).toContain('拒绝了图片');
    mock.respond(probeResponder({ images: true, tools: true, thinking: 'optional', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }));
    const a = await probeModel(target('claude-sonnet-5-5', 'anthropic', 'ANTHROPIC'));
    expect(a).toMatchObject({ ok: true, images: true, tools: true, reasoning: 'optional', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
  });

  it('连不上 / Key 不对：直接停下，说明原因', async () => {
    const r = target('x');
    r.provider.baseUrl = 'http://127.0.0.1:9';
    const res = await probeModel(r, { timeoutMs: 3000 });
    expect(res.ok).toBe(false);
    expect(res.notes?.connect).toMatch(/连不上|超时/);
    mock.respond(() => ({ httpError: { status: 401, body: { error: { message: 'Authentication Fails' } } } }));
    const bad = await probeModel(target('x'));
    expect(bad).toMatchObject({ ok: false, notes: { connect: expect.stringContaining('API Key 无效') } });
  });

  it('测试图片是合法的 PNG；模型列表里的上下文窗口能读出来', async () => {
    const png = Buffer.from(testImagePng(), 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([64, 32]);
    const list = await fetchModelList(target('x'));
    expect(list.find((m) => m.id === 'mock-vision')).toMatchObject({ contextWindow: 262_144 });
    expect(list.find((m) => m.id === 'mock-coder')?.contextWindow).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 联网搜索

describe('联网搜索（独立的工具）', () => {
  let dir: string;
  let db: Db;
  let settings: SettingsRepo;
  const vaultKey = randomBytes(32);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'itm-r25-web-'));
    db = openDatabase(join(dir, 'db'), randomBytes(32));
    settings = new SettingsRepo(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('默认用服务端的配置、新对话默认不联网；旧版本「绑定提供商」的设置不再认，回到默认', () => {
    expect(DEFAULT_SETTINGS['ai.webSearch']).toMatchObject({ source: 'server', format: 'deepseek', defaultOn: false });
    db.prepare("INSERT INTO setting (key, value, updated_at) VALUES ('ai.webSearch', ?, 0)").run(JSON.stringify({ providerId: 'x', count: 5, defaultOn: true }));
    expect(settings.get('ai.webSearch')).toEqual(DEFAULT_SETTINGS['ai.webSearch']);
    expect(() => settings.set('ai.webSearch', { ...DEFAULT_SETTINGS['ai.webSearch'], searchUrl: 'ftp://x' })).toThrow('不合法');
    settings.set('ai.visionFallback', { enabled: true, model: { providerId: 'p', modelId: 'm' } });
    settings.set('ai.providerOrder', ['team:1', 'p']);
    settings.set('ai.thinkingEffort', 'minimal');
    expect(settings.get('ai.providerOrder')).toEqual(['team:1', 'p']);
  });

  it('状态：服务端没登录 / 没配置、自己配置没 Key 时说明原因；Key 加密保存，不在 setting.getAll 里', () => {
    let server: { info: ReturnType<typeof sanitizeServerWeb>; request: never } | null = null;
    const svc = new WebSearchService({ db, vaultKey, setting: () => settings.get('ai.webSearch'), server: () => server });
    expect(svc.status()).toMatchObject({ available: false, reason: expect.stringContaining('需要登录') });
    server = { info: null, request: (() => undefined) as never };
    expect(svc.status().reason).toContain('服务端还没有配置联网搜索');
    server = { info: sanitizeServerWeb({ enabled: true, format: 'deepseek', label: '团队 DeepSeek', count: 6 }), request: (() => undefined) as never };
    expect(svc.status()).toMatchObject({ available: true, label: '团队 DeepSeek（服务端）', fetch: true });
    expect(svc.count()).toBe(6);

    settings.set('ai.webSearch', { ...settings.get('ai.webSearch'), source: 'personal', count: 3 });
    expect(svc.status()).toMatchObject({ available: false, hasKey: false, reason: expect.stringContaining('API Key') });
    svc.saveKey('sk-web');
    expect(svc.status()).toMatchObject({ available: true, label: 'DeepSeek', hasKey: true });
    expect(svc.count()).toBe(3);
    expect(JSON.stringify(settings.getAll())).not.toContain('sk-web');
    expect(JSON.stringify(db.prepare('SELECT value FROM setting').all())).not.toContain('sk-web');
    svc.saveKey(null);
    expect(svc.hasKey()).toBe(false);
  });

  it('自定义格式：同时带 query / text_query、count / limit；认 Kimi 的 search_results；没填读取地址时不能读网页', async () => {
    const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
    const http = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
      return new Response(JSON.stringify({ search_results: [{ title: 'K', url: 'https://kimi.example/a', site_name: 'kimi', snippet: '摘要', date: '2026-10-01', text: '' }] }), { status: 200 });
    }) as typeof fetch;
    const c = new HttpWebSearch({ format: 'custom', search: 'https://api.moonshot.cn/v1/tools/search', fetch: null, apiKey: 'kk', label: '自定义' }, http);
    const r = await c.search('nginx', 4, new AbortController().signal);
    expect(calls[0]).toEqual({ url: 'https://api.moonshot.cn/v1/tools/search', body: { query: 'nginx', text_query: 'nginx', count: 4, limit: 4 }, auth: 'Bearer kk' });
    expect(r).toEqual([{ title: 'K', url: 'https://kimi.example/a', site: 'kimi', date: '2026-10-01', snippet: '摘要', summary: '摘要' }]);
    expect(c.canFetch).toBe(false);
    await expect(c.fetchPage('https://a.example', new AbortController().signal)).rejects.toThrow('没有配置网页读取接口');
    // 其他常见的返回格式
    expect(parseSearchResults({ data: [{ link: 'https://x.example', title: 'X', description: 'd' }] })).toEqual([{ title: 'X', url: 'https://x.example', site: null, date: null, snippet: 'd', summary: 'd' }]);
    expect(parseSearchResults({ data: { results: [{ url: 'https://y.example' }] } })[0].title).toBe('https://y.example');
  });

  it('服务端默认搜索：读不到网页的配置不提供 web_fetch；请求失败原样报错', async () => {
    const c = new ServerWebSearchClient((async () => {
      throw new Error('服务端返回 429：今天的联网搜索次数已经用完（每人每天 500 次），明天恢复');
    }) as never, { enabled: true, format: 'custom', label: '公司搜索', count: 5, fetch: false });
    expect(c.canFetch).toBe(false);
    await expect(c.search('x', 3, new AbortController().signal)).rejects.toThrow(/^今天的联网搜索次数已经用完/);
    await expect(c.fetchPage('https://a.example', new AbortController().signal)).rejects.toThrow('没有配置网页读取接口');
  });
});

// ---------------------------------------------------------------- 模型配置的保存和团队模型

describe('模型配置的新字段', () => {
  it('保存：思考控制方式、工具调用、图片格式、检测结果；不认识的值丢掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'itm-r25-p-'));
    try {
      const db = openDatabase(join(dir, 'db'), randomBytes(32));
      const repo = new AiProviderRepo(db, randomBytes(32));
      const input: AiProviderInput = {
        name: 'X', type: 'OPENAI_COMPAT', baseUrl: 'https://x.example/v1', apiKey: 'k', enabled: true,
        models: [
          {
            id: 'a', contextWindow: 100_000, maxOutput: 8000, reasoning: 'optional', thinkingControl: 'budget', efforts: ['minimal', 'high'], supportsTools: false, imageFormat: 'base64',
            probe: { at: 1, images: true, imageFormat: 'base64', tools: false, reasoning: 'optional', efforts: ['high', 'bogus' as never], notes: { images: 'ok', evil: 'x' } as never },
          },
          { id: 'b', contextWindow: 100_000, maxOutput: 8000, thinkingControl: 'weird' as never, imageFormat: 'url' as never },
        ],
      };
      const p = repo.save(null, input);
      expect(p.models[0]).toMatchObject({ thinkingControl: 'budget', efforts: ['minimal', 'high'], supportsTools: false, imageFormat: 'base64', probe: { images: true, efforts: ['high'], notes: { images: 'ok' } } });
      expect(p.models[0].probe?.notes).not.toHaveProperty('evil');
      expect(p.models[1]).toMatchObject({ thinkingControl: null, imageFormat: null, supportsTools: null, probe: null });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('团队模型带上新字段；服务端的默认联网搜索只取认识的字段（没有 Key）', () => {
    const t = sanitizeTeamProviders([{ id: '1', name: 'T', type: 'OPENAI_COMPAT', models: [{ id: 'm', thinkingControl: 'toggle', supportsTools: false, imageFormat: 'base64', efforts: ['minimal', 'x'] }] }]);
    expect(t[0].models[0]).toMatchObject({ thinkingControl: 'toggle', supportsTools: false, imageFormat: 'base64', efforts: ['minimal'] });
    const p = sanitizeTeamPolicy({ commandRules: [], maskRules: [] }, 1, [], { enabled: true, format: 'custom', label: '公司搜索', count: 99, fetch: false, apiKey: 'secret' });
    expect(p?.webSearch).toEqual({ enabled: true, format: 'custom', label: '公司搜索', count: 8, fetch: false });
    expect(sanitizeServerWeb({ enabled: false })).toBeNull();
    expect(sanitizeServerWeb(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- 图片识别 Fallback

const OWNER = 3;
const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
let approval: ApprovalEngine;

describe('图片识别 Fallback', () => {
  let dir: string;
  let db: Db;
  let mock: LlmMock;
  let agent: AgentService;
  let repos: ReturnType<typeof createRepos>;
  let pool: SshPool;
  let views: AgentConversationView[];
  let pro: ModelRef;
  let vision: ModelRef;
  let providers: AiProviderRepo;
  const emit = <E extends IpcEventName>(_o: number, event: E, payload: IpcEvents[E]): void => {
    if (event === 'agent.update') views.push(payload as AgentConversationView);
  };
  async function idle(id: string): Promise<AgentConversationView> {
    const start = Date.now();
    for (;;) {
      const v = views.filter((x) => x.id === id).at(-1);
      if (v && !v.running && v.messages.length > 0) return v;
      if (Date.now() - start > 8000) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'itm-r25-vision-'));
    db = openDatabase(join(dir, 'db'), randomBytes(32));
    const vaultKey = randomBytes(32);
    repos = createRepos(db, vaultKey);
    repos.settings.set('ai.llmReview', false);
    approval ??= await createApprovalEngine(wasm);
    views = [];
    pool = new SshPool(repos.hosts, new PromptBroker(emit), 5000);
    const sessions = new SessionManager(pool, repos.hosts, emit, (f, a, o) => pty.spawn(f, a, { name: 'xterm-256color', ...o }));
    providers = new AiProviderRepo(db, vaultKey);
    mock = await startLlmMock();
    agent = new AgentService({
      db, providers, sessions, pool, hosts: repos.hosts, folders: repos.folders, credentials: repos.credentials,
      monitor: new MonitorService(pool, emit, sessions), skills: new SkillStore(join(dir, 'skills')), settings: repos.settings, audit: new AuditRepo(db), approval, emit,
      runtime: new InlineRuntime(),
      policy: () => ({ ...DEFAULT_POLICY, allowLlmReview: false }),
    });
    const p = providers.save(null, {
      name: 'DeepSeek', type: 'OPENAI_COMPAT', baseUrl: mock.url, apiKey: 'k', enabled: true, vendor: 'deepseek', thinkingStyle: 'thinking-type', echoReasoning: true,
      models: [{ id: 'deepseek-v4-pro', contextWindow: 100_000, maxOutput: 8000, reasoning: 'optional', efforts: ['low', 'high', 'max'] }, { id: 'mock-vision', contextWindow: 100_000, maxOutput: 8000, supportsImages: true }],
    });
    pro = { providerId: p.id, modelId: 'deepseek-v4-pro' };
    vision = { providerId: p.id, modelId: 'mock-vision' };
  });
  afterEach(async () => {
    pool.closeAll();
    await mock.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const img = { name: 'err.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' };

  it('标明不能调用工具的模型：智能体模式直接说明，Ask 模式照常', async () => {
    const p = providers.save(null, { name: 'Sol', type: 'OPENAI', baseUrl: mock.url, apiKey: 'k', enabled: true, models: [{ id: 'gpt-6.1-sol', contextWindow: 100_000, maxOutput: 8000, supportsTools: false }] });
    const sol = { providerId: p.id, modelId: 'gpt-6.1-sol' };
    const c = agent.create(sol);
    expect(() => agent.send(OWNER, c.id, '重启 nginx', 'agent', sol, { terminals: [], skillIds: [] })).toThrow('不能调用工具');
    mock.enqueue({ text: '可以用 systemctl restart nginx' });
    agent.send(OWNER, c.id, '怎么重启 nginx', 'ask', sol, { terminals: [], skillIds: [] });
    expect((await idle(c.id)).error ?? null).toBeNull();
  });

  it('没开 Fallback：看不了图片的模型发图片直接报错，提示去设置', () => {
    const c = agent.create(pro);
    expect(() => agent.send(OWNER, c.id, '这个报错是什么', 'ask', pro, { terminals: [], skillIds: [], images: [img] })).toThrow('图片识别 Fallback');
  });

  it('开了 Fallback：先让识图模型转成文字（带图片），再把识别结果交给当前模型（不带图片）', async () => {
    repos.settings.set('ai.visionFallback', { enabled: true, model: vision });
    const c = agent.create(pro);
    mock.enqueue({ text: '终端里显示：Permission denied (publickey)' }, { text: '是公钥没有配置好' });
    const n = mock.requests.length;
    agent.send(OWNER, c.id, '这个报错是什么', 'ask', pro, { terminals: [], skillIds: [], images: [img] }, { enabled: false });
    const v = await idle(c.id);
    expect(v.error ?? null).toBeNull();
    const [desc, answer] = [mock.requests[n].body, mock.requests[n + 1].body];
    expect(desc.model).toBe('mock-vision');
    expect(JSON.stringify(desc.messages)).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(JSON.stringify(desc.messages)).toContain('图片识别助手');
    expect(answer.model).toBe('deepseek-v4-pro');
    const sent = JSON.stringify(answer.messages);
    expect(sent).not.toContain('image_url');
    expect(sent).toContain('【图片识别结果】');
    expect(sent).toContain('Permission denied (publickey)');
  });
});
