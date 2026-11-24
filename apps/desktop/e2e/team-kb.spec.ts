import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../test/support/mock-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 团队知识库（文档二 5.8）：登录后 AI 助手的 kb_search 调用服务端检索，按账号角色过滤；本地模式不提供这个工具。
 */
let root: string;
let mock: MockServer;
let llm: LlmMock;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // 登录框里没有服务端地址：测试用 ITM_DEFAULT_SERVER_URL 指定（只在没有打包时生效）
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '', ITM_DEFAULT_SERVER_URL: mock.url };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);
type View = { running: boolean; messages: { role: string; steps?: { tool: string; status: string; output: string; hostName: string }[] }[] };
const toolNames = (body: Record<string, unknown>): string[] => ((body.tools as { function?: { name: string }; name?: string }[]) ?? []).map((t) => t.function?.name ?? t.name ?? '');

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-kb-'));
  llm = await startLlmMock();
  mock = await startMockServer();
  mock.setPolicy({ commandRules: [], maskRules: [], unattendedCap: 'READONLY', allowLlmReview: false, allowPersonalProvider: true, version: 'v1' });
  mock.setTeamModels([{ id: '100', name: '公司千问', type: 'OPENAI_COMPAT', thinkingStyle: 'none', echoReasoning: false, models: [{ id: 'qwen-max', contextWindow: 32000, maxOutput: 4096 }] }], llm.url);
  mock.setKb([
    { title: 'Nginx 手册', section: 'Nginx 运维 / 502 排查', content: '先检查上游服务是否存活，再看 error.log 里的 upstream prematurely closed。', score: 1, source: '运维手册', documentId: 1, chunkId: 11 },
    { title: '证书', section: null, content: 'certbot renew --dry-run', score: 0.4, source: '运维手册', documentId: 2, chunkId: 12 },
  ]);
});

test.afterAll(async () => {
  await mock?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('团队知识库：本地模式不提供 kb_search；登录后 AI 检索服务端知识库，结果带章节和出处', async () => {
  const { app, page } = await launch();

  // 本地模式：个人模型，发给模型的工具里没有 kb_search
  const mine = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: '我的模型', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'sk-mine', models: [{ id: 'm', contextWindow: 32000, maxOutput: 4096 }], enabled: true },
  });
  const refs = { terminals: [], skillIds: [] };
  let conv = await call<{ id: string }>(page, 'agent.create', { model: { providerId: mine.id, modelId: 'm' } });
  llm.enqueue({ text: '好' });
  await call(page, 'agent.send', { id: conv.id, text: 'hi', mode: 'ask', model: { providerId: mine.id, modelId: 'm' }, refs });
  await expect.poll(async () => (await call<View>(page, 'agent.get', { id: conv.id })).running, { timeout: 15_000 }).toBe(false);
  expect(toolNames(llm.requests.at(-1)!.body)).not.toContain('kb_search');
  expect(toolNames(llm.requests.at(-1)!.body)).toContain('run_command');

  // 登录
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(mock.user.username);
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  await expect.poll(async () => (await call<{ id: string }[]>(page, 'ai.providers.list')).map((p) => p.id), { timeout: 10_000 }).toContain('team:100');

  // 团队模型 + 知识库：模型调用 kb_search → 服务端检索 → 结果放进 untrusted 交给模型
  const model = { providerId: 'team:100', modelId: 'qwen-max' };
  conv = await call<{ id: string }>(page, 'agent.create', { model });
  const n = llm.requests.length;
  llm.enqueue({ toolCalls: [{ id: 'kb1', name: 'kb_search', input: { query: 'nginx 502', top_k: 1 } }] }, { text: '按运维手册：先检查上游服务。' });
  await call(page, 'agent.send', { id: conv.id, text: 'nginx 502 怎么排查', mode: 'ask', model, refs });
  await expect.poll(async () => (await call<View>(page, 'agent.get', { id: conv.id })).running, { timeout: 15_000 }).toBe(false);
  expect(toolNames(llm.requests[n].body)).toContain('kb_search');
  expect(mock.rest.filter((r) => r.path === '/api/v1/kb/search').map((r) => r.body)).toEqual([{ query: 'nginx 502', topK: 1 }]);
  const view = await call<View>(page, 'agent.get', { id: conv.id });
  const step = view.messages.flatMap((m) => m.steps ?? []).find((s) => s.tool === 'kb_search')!;
  expect(step).toMatchObject({ status: 'done', hostName: '知识库' });
  expect(step.output).toContain('[1] Nginx 手册 · Nginx 运维 / 502 排查（相关度 1.00，来源 运维手册）');
  expect(step.output).not.toContain('certbot');
  expect(JSON.stringify(llm.requests[n + 1].body.messages)).toMatch(/<untrusted>[^]*upstream prematurely closed/);

  // 界面：引用面板提示已登录、AI 会按需检索知识库
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await page.getByTestId('refs-expand').click();
  await expect(page.getByTestId('refs-kb')).toContainText('AI 会按需检索团队知识库');
  await app.close();
});
