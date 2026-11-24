import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../test/support/mock-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 团队模型（文档二 5.5）：登录后列出管理员配置的模型，经服务端代理调用（客户端用登录令牌，服务端换上真实 Key）；
 * 管理员只允许团队模型时，个人模型停用、不能添加。
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
const draft = { name: 'x', type: 'OPENAI_COMPAT', baseUrl: 'http://x', models: [{ id: 'm', contextWindow: 32000, maxOutput: 4096 }], enabled: true };

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-team-'));
  llm = await startLlmMock();
  mock = await startMockServer();
  mock.setPolicy({ commandRules: [], maskRules: [], unattendedCap: 'READONLY', allowLlmReview: true, allowPersonalProvider: true, version: 'v1' });
  mock.setTeamModels(
    [
      { id: '100', name: '公司千问', type: 'OPENAI_COMPAT', thinkingStyle: 'none', echoReasoning: false, models: [{ id: 'qwen-max', displayName: '通义千问 Max', contextWindow: 32000, maxOutput: 4096 }] },
      { id: '200', name: '公司 Claude', type: 'ANTHROPIC', thinkingStyle: 'anthropic', echoReasoning: false, models: [{ id: 'claude-x', contextWindow: 200000, maxOutput: 8000 }] },
    ],
    llm.url,
  );
});

test.afterAll(async () => {
  await mock?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('团队模型：登录后列出、经服务端代理调用（OpenAI 兼容和 Anthropic）；只允许团队模型时个人模型停用', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(mock.user.username);
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });

  // 团队模型出现在列表最前面（只读、不带地址）；这时还允许个人模型
  await expect.poll(async () => (await call<{ id: string }[]>(page, 'ai.providers.list')).map((p) => p.id).slice(0, 2), { timeout: 10_000 }).toEqual(['team:100', 'team:200']);
  const list = await call<{ id: string; name: string; source?: string; enabled: boolean; baseUrl: string }[]>(page, 'ai.providers.list');
  expect(list[0]).toMatchObject({ source: 'team', name: '公司千问', enabled: true, baseUrl: '' });
  const mine = await call<{ id: string }>(page, 'ai.providers.save', { id: null, input: { ...draft, name: '我的模型', baseUrl: llm.url, apiKey: 'sk-mine' } });
  await expect(call(page, 'ai.providers.delete', { id: 'team:100' })).rejects.toThrow('管理员在管理后台配置');

  // OpenAI 兼容：客户端带登录令牌，服务端（模拟）换成真实 Key 转给上游
  llm.enqueue({ text: '连接成功' });
  const r = await call<{ reply: string }>(page, 'ai.providers.test', { id: 'team:100', input: draft, modelId: 'qwen-max' });
  expect(r.reply).toBe('连接成功');
  expect(mock.proxied.at(-1)).toEqual({ path: '/api/v1/llm/proxy/100/chat/completions', auth: `Bearer ${mock.token}` });
  expect(llm.requests.at(-1)!.headers.authorization).toBe('Bearer sk-upstream');
  expect((llm.requests.at(-1)!.body as { model: string }).model).toBe('qwen-max');

  // Anthropic：SDK 把登录令牌放在 x-api-key
  llm.enqueue({ text: 'pong' });
  expect((await call<{ reply: string }>(page, 'ai.providers.test', { id: 'team:200', input: draft, modelId: 'claude-x' })).reply).toBe('pong');
  expect(mock.proxied.at(-1)).toEqual({ path: '/api/v1/llm/proxy/200/v1/messages', auth: `Bearer ${mock.token}` });

  // 管理员改成只允许团队模型：重新连接后拉到新策略，个人模型停用、不能添加、不能调用
  mock.setPolicy({ commandRules: [], maskRules: [], unattendedCap: 'READONLY', allowLlmReview: true, allowPersonalProvider: false, version: 'v2' });
  mock.dropClients();
  await expect
    .poll(async () => (await call<{ id: string; blocked?: string | null }[]>(page, 'ai.providers.list')).find((p) => p.id === mine.id)?.blocked, { timeout: 20_000 })
    .toBe('管理员只允许使用团队模型');
  await expect(call(page, 'ai.providers.save', { id: null, input: { ...draft, name: '再加一个' } })).rejects.toThrow('只允许使用团队模型');
  await expect(call(page, 'agent.create', { model: { providerId: mine.id, modelId: 'm' } }).then((id) => call(page, 'agent.send', { id, text: 'hi', mode: 'ask' }))).rejects.toThrow();

  // 设置页：团队标签、提示，不能添加个人模型
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await expect(page.getByTestId('team-models-tip')).toContainText('只允许使用团队模型');
  await expect(page.getByTestId('team-provider-team:100')).toBeVisible();
  await expect(page.getByTestId('add-provider')).toBeDisabled();
  await app.close();
});
