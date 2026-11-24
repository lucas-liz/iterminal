import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effortFor, type AgentConversationView, type AgentStep, type IpcEventName, type IpcEvents, type ModelRef } from '@itm/protocol';
import { WEB_TOOLS, type StoredMessage } from '@itm/agent-core';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { migrate, openDatabase, type Db } from '../src/main/services/db/database';
import { createRepos } from './support/repos';
import { startLlmMock, type LlmMock } from './support/llm-mock';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SessionManager } from '../src/main/services/connection/session-manager';
import { MonitorService } from '../src/main/services/monitor/monitor-service';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import { SkillStore } from '../src/main/services/ai/skills';
import { AgentService, imagesFor, MAX_HISTORY_IMAGES } from '../src/main/services/ai/agent-service';
import { InlineRuntime } from '../src/main/services/ai/runtime';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { ServerWebSearchClient, WebSearchService, checkPublicUrl, describeWebError, scrubQuery, webToolBase } from '../src/main/services/ai/web-search';
import { fitSize } from '../src/renderer/src/util/image-size';

/**
 * 第二十四轮（文档一 6.38）：DeepSeek 图片、思考强度按官方换算、联网搜索（客户端 web_search / web_fetch + DeepSeek Search / Fetch）。
 */

describe('思考强度按厂商换算', () => {
  it('DeepSeek 按官方：中 → 高、很高 → 高，其他档原样；别的厂商仍然取最接近的一档（同样接近取低的）', () => {
    const ds = { id: 'deepseek-flash', efforts: ['low', 'high', 'max'] as const };
    expect(effortFor('medium', { ...ds, efforts: [...ds.efforts] })).toBe('high');
    expect(effortFor('xhigh', { ...ds, efforts: [...ds.efforts] })).toBe('high');
    expect(effortFor('low', { ...ds, efforts: [...ds.efforts] })).toBe('low');
    expect(effortFor('max', { ...ds, efforts: [...ds.efforts] })).toBe('max');
    // 团队模型 / 没写支持的强度：照样按 DeepSeek 的规则
    expect(effortFor('medium', { id: 'deepseek-v4-pro', efforts: null })).toBe('high');
    expect(effortFor('medium', { id: 'glm-5.3', efforts: ['low', 'high', 'max'] })).toBe('low');
    expect(effortFor('medium', { id: 'gpt-6-astra', efforts: null })).toBe('medium');
  });
});

describe('发出去之前的检查', () => {
  it('查询词里的内网地址和 HOST_IP_n 换成占位符；公网地址保留', () => {
    expect(scrubQuery('10.0.3.7 和 192.168.1.20 连不上 8.8.8.8')).toBe('[内网地址] 和 [内网地址] 连不上 8.8.8.8');
    expect(scrubQuery('HOST_IP_2 上 nginx 502')).toBe('[内网地址] 上 nginx 502');
    expect(scrubQuery('172.15.0.1 172.16.0.1 100.64.1.1')).toBe('172.15.0.1 [内网地址] [内网地址]');
  });

  it('只读公网 http / https 网页：内网、本机、单段主机名、带账号密码、HOST_IP_n 都拒绝', () => {
    expect(checkPublicUrl('https://nginx.org/en/docs/')).toBeNull();
    expect(checkPublicUrl('http://8.8.8.8/a')).toBeNull();
    for (const bad of ['http://10.1.2.3/', 'http://127.0.0.1:8080', 'http://localhost/x', 'http://jenkins/job', 'http://git.corp/x', 'http://[::1]/', 'http://[fd00::1]/', 'https://user:pw@example.com/', 'ftp://example.com/', 'https://HOST_IP_1/', 'not a url']) {
      expect(checkPublicUrl(bad), bad).not.toBeNull();
    }
  });

  it('接口根地址：对话地址去掉 /v1、/anthropic', () => {
    expect(webToolBase('https://api.deepseek.com')).toBe('https://api.deepseek.com');
    expect(webToolBase('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com');
    expect(webToolBase('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com');
    expect(webToolBase('http://srv/prod-api/api/v1/llm/proxy/7')).toBe('http://srv/prod-api/api/v1/llm/proxy/7');
  });

  it('错误提示按 DeepSeek 文档的状态码', () => {
    expect(describeWebError('search', 401, '', false)).toContain('API Key 无效');
    expect(describeWebError('search', 402, '', false)).toContain('余额不足');
    expect(describeWebError('fetch', 404, '', false)).toContain('没能读取到这个网页的正文');
    expect(describeWebError('search', 404, '', false)).toContain('接口不存在');
    expect(describeWebError('search', 429, '', false)).toContain('太频繁');
  });
});

describe('图片', () => {
  const user = (n: number): StoredMessage => ({
    role: 'user',
    mode: 'ask',
    blocks: [
      ...Array.from({ length: n }, (_, i) => ({ kind: 'image' as const, label: `p${i}.png`, text: `[图片 p${i}.png]`, image: { mediaType: 'image/png', data: 'AAAA' } })),
      { kind: 'question' as const, text: '看看' },
    ],
  });

  it('模型不支持图片时历史图片换成文字占位；支持时只带最近 20 张；保存的历史不变', () => {
    const history = [user(5), user(5), user(5), user(5), user(5)];
    const none = imagesFor(history, false);
    expect(JSON.stringify(none)).not.toContain('"kind":"image"');
    expect(JSON.stringify(none)).toContain('当前模型不支持图片');
    const some = imagesFor(history, true);
    const count = (ms: StoredMessage[]): number => ms.flatMap((m) => (m.role === 'user' ? m.blocks : [])).filter((b) => b.kind === 'image').length;
    expect(count(some)).toBe(MAX_HISTORY_IMAGES);
    // 最早一条的 5 张被换掉，最近的都在
    expect(some[0].role === 'user' && some[0].blocks.every((b) => b.kind !== 'image')).toBe(true);
    expect(count([some[4]])).toBe(5);
    expect(count(history)).toBe(25);
  });

  it('缩图尺寸：长边不超过 2048，按比例', () => {
    expect(fitSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(fitSize(4096, 2304)).toEqual({ width: 2048, height: 1152 });
    expect(fitSize(3000, 6000)).toEqual({ width: 1024, height: 2048 });
  });

  it('迁移 15：已添加的 DeepSeek 提供商把 deepseek-flash（含旧名称）标记为支持图片，其他模型和别的厂商不变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'itm-r24-'));
    try {
      const db = openDatabase(join(dir, 'db'), randomBytes(32));
      const insert = db.prepare("INSERT INTO ai_provider (id, name, type, base_url, models, enabled, vendor, updated_at) VALUES (?, ?, 'OPENAI_COMPAT', ?, ?, 1, ?, 0)");
      const models = JSON.stringify([{ id: 'deepseek-flash', supportsImages: false }, { id: 'deepseek-v4-pro', supportsImages: false }, { id: 'deepseek-v4-flash-vision-exp' }]);
      insert.run('a', 'DeepSeek', 'https://api.deepseek.com', models, 'deepseek');
      insert.run('b', '自定义 DS', 'https://api.deepseek.com/v1', models, 'custom');
      insert.run('c', '网关', 'https://oneapi.example.com/v1', models, 'custom');
      db.pragma('user_version = 14');
      migrate(db);
      const get = (id: string): { id: string; supportsImages?: boolean }[] => JSON.parse(db.prepare<[string], { models: string }>('SELECT models FROM ai_provider WHERE id = ?').get(id)!.models);
      expect(get('a').map((m) => !!m.supportsImages)).toEqual([true, false, true]);
      expect(get('b').map((m) => !!m.supportsImages)).toEqual([true, false, true]);
      expect(get('c').map((m) => !!m.supportsImages)).toEqual([false, false, false]);
      expect(db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(15);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- Agent 里的联网搜索

const OWNER = 5;
const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
let approval: ApprovalEngine;

describe('Agent 联网搜索（web_search / web_fetch）', () => {
  let dir: string;
  let db: Db;
  let mock: LlmMock;
  let agent: AgentService;
  let providers: AiProviderRepo;
  let repos: ReturnType<typeof createRepos>;
  let audit: AuditRepo;
  let pool: SshPool;
  let views: AgentConversationView[];
  let ds: ModelRef;
  let qwen: ModelRef;
  let web: WebSearchService;

  const emit = <E extends IpcEventName>(_o: number, event: E, payload: IpcEvents[E]): void => {
    if (event === 'agent.update') views.push(payload as AgentConversationView);
  };
  const last = (id: string): AgentConversationView | undefined => views.filter((v) => v.id === id).at(-1);
  async function idle(id: string): Promise<AgentConversationView> {
    const start = Date.now();
    for (;;) {
      const v = last(id);
      if (v && !v.running && v.messages.length > 0) return v;
      if (Date.now() - start > 8000) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  const toolNames = (i: number): string[] => ((mock.requests[i].body.tools as { function: { name: string } }[] | undefined) ?? []).map((t) => t.function.name);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'itm-r24-agent-'));
    db = openDatabase(join(dir, 'db'), randomBytes(32));
    const vaultKey = randomBytes(32);
    repos = createRepos(db, vaultKey);
    repos.settings.set('ai.llmReview', false);
    audit = new AuditRepo(db);
    approval ??= await createApprovalEngine(wasm);
    views = [];
    const broker = new PromptBroker(emit);
    pool = new SshPool(repos.hosts, broker, 5000);
    const sessions = new SessionManager(pool, repos.hosts, emit, (f, a, o) => pty.spawn(f, a, { name: 'xterm-256color', ...o }));
    providers = new AiProviderRepo(db, vaultKey);
    mock = await startLlmMock();
    // 联网搜索（第二十五轮起和模型提供商无关）：自己配置的 DeepSeek 格式，地址换成模拟接口
    web = new WebSearchService({ db, vaultKey, setting: () => repos.settings.get('ai.webSearch'), server: () => null });
    repos.settings.set('ai.webSearch', { source: 'personal', format: 'deepseek', baseUrl: `${mock.url}/v1`, searchUrl: '', fetchUrl: '', count: 8, defaultOn: false });
    web.saveKey('ws-key');
    agent = new AgentService({
      webSearch: web,
      db, providers, sessions, pool, hosts: repos.hosts, folders: repos.folders, credentials: repos.credentials,
      monitor: new MonitorService(pool, emit, sessions), skills: new SkillStore(join(dir, 'skills')), settings: repos.settings, audit, approval, emit,
      runtime: new InlineRuntime(),
      policy: () => ({ ...DEFAULT_POLICY, allowLlmReview: false }),
    });
    // DeepSeek 预设（地址换成模拟接口）
    const p = providers.save(null, {
      name: 'DeepSeek', type: 'OPENAI_COMPAT', baseUrl: `${mock.url}/v1`, apiKey: 'ds-key', enabled: true, vendor: 'deepseek', thinkingStyle: 'thinking-type', echoReasoning: true,
      models: [{ id: 'deepseek-flash', contextWindow: 100_000, maxOutput: 8000, reasoning: 'optional', efforts: ['low', 'high', 'max'], supportsImages: true }, { id: 'deepseek-v4-pro', contextWindow: 100_000, maxOutput: 8000, reasoning: 'optional', efforts: ['low', 'high', 'max'] }],
    });
    ds = { providerId: p.id, modelId: 'deepseek-flash' };
    const q = providers.save(null, { name: '千问', type: 'OPENAI_COMPAT', baseUrl: mock.url, apiKey: 'k', enabled: true, models: [{ id: 'qwen-max', contextWindow: 32_000, maxOutput: 4000 }] });
    qwen = { providerId: q.id, modelId: 'qwen-max' };
  });

  afterEach(async () => {
    pool.closeAll();
    await mock.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('打开联网：工具列表多出 web_search / web_fetch，搜索用联网搜索自己的 Key；查询词脱敏；结果放进 <untrusted>、显示在步骤卡片上、写审计', async () => {
    const c = agent.create(qwen);
    mock.enqueue(
      { toolCalls: [{ id: 's1', name: 'web_search', input: { query: '10.0.0.8 nginx 502 HOST_IP_1', count: 3 } }] },
      { toolCalls: [{ id: 'f1', name: 'web_fetch', input: { url: 'https://nginx.org/502' } }] },
      { text: '按官方文档先查 upstream（来源：https://nginx.org/502）' },
    );
    const n = mock.requests.length;
    // 用千问对话、DeepSeek 格式的搜索服务：任何能调用工具的模型都能联网
    agent.send(OWNER, c.id, 'nginx 502 怎么查', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true);
    const v = await idle(c.id);
    expect(v.error ?? null).toBeNull();
    expect(toolNames(n)).toEqual(expect.arrayContaining(WEB_TOOLS.map((t) => t.name)));
    // Search：根地址去掉 /v1、带联网搜索的 Key（不是模型的）、内网地址不发出去、条数用模型给的
    expect(mock.web.requests[0].path).toBe('/v1/tools/search');
    expect(mock.web.requests[0].headers.authorization).toBe('Bearer ws-key');
    expect(mock.web.requests[0].body).toEqual({ query: '[内网地址] nginx 502 [内网地址]', count: 3 });
    expect(mock.web.requests[1]).toMatchObject({ path: '/v1/tools/fetch', body: { url: 'https://nginx.org/502' } });
    // 结果给模型：在 <untrusted> 里，带编号、链接、来源和长摘要
    const second = JSON.stringify(mock.requests[n + 1].body.messages);
    expect(second).toMatch(/<untrusted>[^]*\[1\] Nginx 502 排查[^]*链接：https:\/\/nginx.org\/502[^]*来源：nginx.org · 2026-06-01[^]*摘要：502 通常是上游没有响应/);
    expect(JSON.stringify(mock.requests[n + 2].body.messages)).toMatch(/<untrusted>[^]*网页：示例网页[^]*https:\/\/nginx.org\/502 的正文/);
    // 步骤卡片：结果列表
    const steps = v.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : []));
    const search = steps.find((s) => s.tool === 'web_search')!;
    expect(search).toMatchObject({ status: 'done', hostName: 'DeepSeek', command: '[内网地址] nginx 502 [内网地址]', output: '找到 2 条结果' });
    expect(search.web?.results[0]).toMatchObject({ title: 'Nginx 502 排查', url: 'https://nginx.org/502', site: 'nginx.org' });
    expect(steps.find((s) => s.tool === 'web_fetch')).toMatchObject({ status: 'done', hostName: 'nginx.org', web: { results: [{ url: 'https://nginx.org/502', title: '示例网页' }] } });
    // 审计：查询词和网址
    const events = audit.list({ kind: 'EVENT', limit: 10 }).items.filter((e) => e.eventType?.startsWith('AGENT_WEB_'));
    expect(events.map((e) => e.eventType).sort()).toEqual(['AGENT_WEB_FETCH', 'AGENT_WEB_SEARCH']);
    expect(events.find((e) => e.eventType === 'AGENT_WEB_SEARCH')?.detail).toMatchObject({ query: '[内网地址] nginx 502 [内网地址]', service: 'DeepSeek', results: 2 });
  });

  it('关闭联网：工具列表和以前一样；模型还按历史调用 web_search 时告诉它没有打开；读内网网址直接拒绝', async () => {
    const c = agent.create(qwen);
    mock.enqueue({ toolCalls: [{ id: 's1', name: 'web_search', input: { query: 'nginx' } }] }, { text: '好' });
    const n = mock.requests.length;
    agent.send(OWNER, c.id, '查一下', 'ask', qwen, { terminals: [], skillIds: [] });
    const v = await idle(c.id);
    expect(toolNames(n)).not.toContain('web_search');
    expect(mock.web.requests).toHaveLength(0);
    expect(v.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : [])).find((s) => s.tool === 'web_search')?.output).toContain('联网搜索没有打开');

    const c2 = agent.create(qwen);
    mock.enqueue({ toolCalls: [{ id: 'f1', name: 'web_fetch', input: { url: 'http://192.168.1.10/admin' } }] }, { text: '好' });
    agent.send(OWNER, c2.id, '看看', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true);
    const v2 = await idle(c2.id);
    expect(mock.web.requests).toHaveLength(0);
    expect(v2.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : [])).find((s) => s.tool === 'web_fetch')).toMatchObject({ status: 'error', output: '不能读取内网地址' });
  });

  it('自己拼出来的网址要先批准（第三十二轮）：搜索结果里的链接直接读，带查询参数或没搜到过的站点要批准', async () => {
    const steps = (id: string) => (last(id)?.messages ?? []).flatMap((m) => (m.role === 'assistant' ? m.steps : []));
    const waitApproval = async (id: string): Promise<AgentStep> => {
      const start = Date.now();
      for (;;) {
        const s = steps(id).find((x) => x.status === 'approval');
        if (s) return s;
        if (Date.now() - start > 8000) throw new Error('等待审批超时');
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    // 1) 先搜索，再读结果里的链接：不弹审批
    const c = agent.create(qwen);
    mock.enqueue(
      { toolCalls: [{ id: 's1', name: 'web_search', input: { query: 'nginx 502' } }] },
      { toolCalls: [{ id: 'f1', name: 'web_fetch', input: { url: 'https://nginx.org/502' } }] },
      { text: '好' },
    );
    agent.send(OWNER, c.id, '查一下', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true);
    await idle(c.id);
    expect(steps(c.id).find((x) => x.tool === 'web_fetch')).toMatchObject({ status: 'done' });
    expect(mock.web.requests.some((r) => r.path === '/v1/tools/fetch')).toBe(true);

    // 2) 同一个站点、但网址带查询参数（内容由模型自己拼）：要批准；拒绝后不读取
    const c2 = agent.create(qwen);
    mock.enqueue({ toolCalls: [{ id: 'f2', name: 'web_fetch', input: { url: 'https://nginx.org/x?d=secret' } }] }, { text: '好' });
    const before = mock.web.requests.length;
    agent.send(OWNER, c2.id, '读一下', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true);
    const pending = await waitApproval(c2.id);
    expect(pending).toMatchObject({ tool: 'web_fetch', level: 'L1', decision: 'APPROVE' });
    expect(pending.reasons.join()).toContain('查询参数');
    agent.approve(OWNER, c2.id, pending.approvalId!, { decision: 'reject' });
    const v2 = await idle(c2.id);
    expect(mock.web.requests.length).toBe(before);
    expect(steps(c2.id).find((x) => x.tool === 'web_fetch')).toMatchObject({ status: 'rejected' });
    expect(v2.error ?? null).toBeNull();

    // 3) 没搜到过的站点：也要批准；批准后读取，同一个站点之后不再问
    const c3 = agent.create(qwen);
    mock.enqueue(
      { toolCalls: [{ id: 'f3', name: 'web_fetch', input: { url: 'https://example.com/doc' } }] },
      { toolCalls: [{ id: 'f4', name: 'web_fetch', input: { url: 'https://example.com/doc2' } }] },
      { text: '好' },
    );
    agent.send(OWNER, c3.id, '读一下', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true);
    const p3 = await waitApproval(c3.id);
    expect(p3.reasons.join()).toContain('没有出现在本轮的搜索结果里');
    agent.approve(OWNER, c3.id, p3.approvalId!, { decision: 'approve' });
    await idle(c3.id);
    const fetched = steps(c3.id).filter((x) => x.tool === 'web_fetch');
    expect(fetched).toHaveLength(2);
    expect(fetched.every((x) => x.status === 'done')).toBe(true);
    // 第二次没有再弹审批（批准过的域名）
    expect(fetched[1].decision).toBeUndefined();
  });

  it('搜索失败（余额不足）：步骤显示原因，模型收到错误后照常回答', async () => {
    mock.web.reply = () => ({ status: 402, body: { error: { message: 'Insufficient Balance', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } } });
    const c = agent.create(ds);
    mock.enqueue({ toolCalls: [{ id: 's1', name: 'web_search', input: { query: 'nginx' } }] }, { text: '搜索不可用，先按经验排查' });
    const n = mock.requests.length;
    agent.send(OWNER, c.id, '查一下', 'agent', ds, { terminals: [], skillIds: [] }, undefined, undefined, true);
    const v = await idle(c.id);
    expect(v.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : [])).find((s) => s.tool === 'web_search')).toMatchObject({ status: 'error', output: expect.stringContaining('余额不足') });
    expect(JSON.stringify(mock.requests[n + 1].body.messages)).toContain('余额不足');
  });

  it('没有配置搜索服务时打开联网直接报错：没有 Key / 用服务端配置但没登录；自定义格式没填读取地址时只给 web_search', async () => {
    const c = agent.create(qwen);
    web.saveKey(null);
    expect(() => agent.send(OWNER, c.id, 'hi', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true)).toThrow(/API Key/);
    repos.settings.set('ai.webSearch', { ...repos.settings.get('ai.webSearch'), source: 'server' });
    expect(() => agent.send(OWNER, c.id, 'hi', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true)).toThrow(/需要登录/);
    // 自定义格式：同一个模拟接口，没填网页读取地址
    web.saveKey('ws-key');
    repos.settings.set('ai.webSearch', { source: 'personal', format: 'custom', baseUrl: '', searchUrl: `${mock.url}/v1/tools/search`, fetchUrl: '', count: 4, defaultOn: false });
    mock.enqueue({ text: '好' });
    const n = mock.requests.length;
    agent.send(OWNER, c.id, 'hi', 'ask', qwen, { terminals: [], skillIds: [] }, undefined, undefined, true);
    await idle(c.id);
    expect(toolNames(n)).toContain('web_search');
    expect(toolNames(n)).not.toContain('web_fetch');
  });

  it('DeepSeek 思考强度「中」按官方换成 high；换成不支持图片的模型后历史图片不再发送', async () => {
    const c = agent.create(ds);
    mock.enqueue({ text: '看到了' }, { text: '好的' });
    const n = mock.requests.length;
    agent.send(OWNER, c.id, '这张图是什么', 'ask', ds, { terminals: [], skillIds: [], images: [{ name: 'a.png', mediaType: 'image/png', data: 'iVBORw0KGgo=' }] }, { enabled: true, effort: 'medium' });
    await idle(c.id);
    expect(mock.requests[n].body).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(JSON.stringify(mock.requests[n].body.messages)).toContain('data:image/png;base64,iVBORw0KGgo=');
    // 同一个对话换成 V4 Pro（不支持图片）：图片换成文字占位，不会 400
    const pro = { providerId: ds.providerId, modelId: 'deepseek-v4-pro' };
    agent.send(OWNER, c.id, '继续', 'ask', pro, { terminals: [], skillIds: [] }, { enabled: false });
    await new Promise((r) => setTimeout(r, 50));
    const v = await idle(c.id);
    expect(v.error ?? null).toBeNull();
    const sent = JSON.stringify(mock.requests[n + 1].body.messages);
    expect(sent).not.toContain('image_url');
    expect(sent).toContain('当前模型不支持图片');
    expect(mock.requests[n + 1].body).toMatchObject({ thinking: { type: 'disabled' } });
    expect(mock.requests[n + 1].body.reasoning_effort).toBeUndefined();
  });

  it('服务端默认搜索：经登录会话调用 /api/v1/ai/web/search，名称带「服务端」；老服务端 404 提示更新', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const request = (async (_m: string, path: string, body?: unknown) => {
      calls.push({ path, body });
      if (path.endsWith('/fetch')) throw new Error('服务端返回 404：接口不存在：/prod-api/api/v1/ai/web/fetch（服务端可能还是旧版本，请升级）');
      return { results: [{ title: 't', url: 'https://a.example/x', snippet: 's' }] };
    }) as never;
    const client = new ServerWebSearchClient(request, { enabled: true, format: 'deepseek', label: 'DeepSeek', count: 8, fetch: true });
    const r = await client.search('x'.repeat(200), 5, new AbortController().signal);
    expect(client.label).toBe('DeepSeek（服务端）');
    expect(calls[0]).toEqual({ path: '/api/v1/ai/web/search', body: { query: 'x'.repeat(128), count: 5 } });
    expect(r).toEqual([{ title: 't', url: 'https://a.example/x', site: null, date: null, snippet: 's', summary: 's' }]);
    await expect(client.fetchPage('https://a.example/x', new AbortController().signal)).rejects.toThrow('服务端版本较旧');
  });
});
