import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 和真实服务端（iterminal-ruoyi）联调，只在设置了 ITM_REAL_SERVER 时运行：
 *   ITM_REAL_SERVER=http://127.0.0.1:8080 npx playwright test e2e/real-server.spec.ts
 * 账号默认用若依初始化脚本里的管理员（ITM_REAL_USER / ITM_REAL_PASSWORD 可以覆盖），服务端需要关闭验证码。
 */
const BASE = process.env.ITM_REAL_SERVER ?? '';
const USER = process.env.ITM_REAL_USER ?? 'admin';
const PASSWORD = process.env.ITM_REAL_PASSWORD ?? '';

test.skip(!BASE || !process.env.ITM_REAL_PASSWORD, '没有设置 ITM_REAL_SERVER 和 ITM_REAL_PASSWORD');
test.describe.configure({ mode: 'serial' });

let root: string;
let ssh: TestSshServer;
let llm: LlmMock;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // 登录框里没有服务端地址：测试用 ITM_DEFAULT_SERVER_URL 指定（只在没有打包时生效）
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '', ITM_DEFAULT_SERVER_URL: BASE };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

/** 管理后台接口（若依的 AjaxResult：{code: 200, msg, data} / TableDataInfo：{rows, total}） */
async function admin<T = Record<string, unknown>>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-real-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('真实服务端：登录、团队规则、团队模型、知识库、管理后台派发任务（按主机名）、执行结果和审计回到后台、吊销设备', async () => {
  // 管理后台先建一个团队模型（上游是本机的模拟模型接口）
  const adminLogin = await admin<{ token: string }>(null, 'POST', '/login', { username: USER, password: PASSWORD });
  const adminToken = adminLogin.token;
  expect(adminToken, JSON.stringify(adminLogin)).toBeTruthy();
  const llmName = `联调模型-${Date.now()}`;
  const added = await admin<{ code: number; msg: string }>(adminToken, 'POST', '/iterminal/llm/provider', {
    providerName: llmName, providerType: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'sk-real-upstream',
    models: JSON.stringify([{ id: 'mock-model', contextWindow: 32000, maxOutput: 4096 }]),
  });
  expect(added.code, added.msg).toBe(200);
  const providerId = (await admin<{ rows: { providerId: number }[] }>(adminToken, 'GET', `/iterminal/llm/provider/list?providerName=${encodeURIComponent(llmName)}`)).rows[0].providerId;
  // 团队主机：指向本机的测试 SSH 服务器
  const teamName = `团队机-${Date.now()}`;
  const th = await admin<{ code: number; msg: string }>(adminToken, 'POST', '/iterminal/asset/host', { hostName: teamName, address: '127.0.0.1', port: ssh.port, username: 'tester', password: 'pw' });
  expect(th.code, th.msg).toBe(200);
  const teamHostId = (await admin<{ rows: { hostId: number }[] }>(adminToken, 'GET', `/iterminal/asset/host/list?hostName=${encodeURIComponent(teamName)}`)).rows[0].hostId;

  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(USER);
  await page.getByTestId('login-password').fill(PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'valid', { timeout: 20_000 });
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 20_000 });
  const deviceId = readFileSync(join(root, 'userData', 'device-id'), 'utf8').trim();

  // 团队规则（初始化脚本里的 3 条示例规则）
  await expect.poll(async () => (await call<{ team: unknown[] }>(page, 'cmdrule.list')).team.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect((await call<{ level: string }>(page, 'cmdrule.test', { command: 'mkfs.ext4 /dev/sdb1' })).level).toBe('DENY');

  // 团队主机：同步到本机，只读，凭证来自服务端
  await expect.poll(async () => (await call<{ name: string; team?: unknown }[]>(page, 'host.list')).find((h) => h.name === teamName)?.team, { timeout: 10_000 }).toEqual({ allowReveal: false });

  // 团队模型：经真实服务端代理调用，上游收到的是管理员配置的 Key
  await expect.poll(async () => (await call<{ id: string }[]>(page, 'ai.providers.list')).some((p) => p.id === `team:${providerId}`), { timeout: 10_000 }).toBe(true);
  llm.enqueue({ text: '连接成功' });
  const draft = { name: 'x', type: 'OPENAI_COMPAT', baseUrl: 'http://x', models: [{ id: 'mock-model', contextWindow: 32000, maxOutput: 4096 }], enabled: true };
  expect((await call<{ reply: string }>(page, 'ai.providers.test', { id: `team:${providerId}`, input: draft, modelId: 'mock-model' })).reply).toBe('连接成功');
  expect(llm.requests.at(-1)!.headers.authorization).toBe('Bearer sk-real-upstream');
  await expect
    .poll(async () => (await admin<{ rows: unknown[] }>(adminToken, 'GET', `/iterminal/llm/usage/list?providerId=${providerId}`)).rows.length, { timeout: 10_000 })
    .toBeGreaterThan(0);

  // 团队知识库：后台粘贴一篇文档，AI 助手的 kb_search 经真实服务端检索到（带章节和出处）
  const kbName = `联调知识库-${Date.now()}`;
  await admin(adminToken, 'POST', '/iterminal/kb/collection', { collectionName: kbName, description: '联调', roleKeys: '' });
  const kb = (await admin<{ data: { collection_id: number; collection_name: string }[] }>(adminToken, 'GET', '/iterminal/kb/collection/list')).data.find((c) => c.collection_name === kbName)!;
  await admin(adminToken, 'POST', '/iterminal/kb/document/text', { collectionId: kb.collection_id, title: '联调手册', content: '# 联调\n\n## 端口冲突\n\n用 lsof -i :18080 找到占用端口的进程。' });
  await expect
    .poll(async () => (await admin<{ data: { status: string }[] }>(adminToken, 'GET', `/iterminal/kb/document/list?collectionId=${kb.collection_id}`)).data[0]?.status, { timeout: 15_000 })
    .toBe('INDEXED');
  const kbModel = { providerId: `team:${providerId}`, modelId: 'mock-model' };
  const conv = await call<{ id: string }>(page, 'agent.create', { model: kbModel });
  llm.enqueue({ toolCalls: [{ id: 'kb1', name: 'kb_search', input: { query: '端口冲突 lsof', top_k: 3 } }] }, { text: '用 lsof 找到进程' });
  await call(page, 'agent.send', { id: conv.id, text: '端口被占用怎么办', mode: 'ask', model: kbModel, refs: { terminals: [], skillIds: [] } });
  await expect.poll(async () => (await call<{ running: boolean }>(page, 'agent.get', { id: conv.id })).running, { timeout: 15_000 }).toBe(false);
  const kbStep = (await call<{ messages: { steps?: { tool: string; output: string }[] }[] }>(page, 'agent.get', { id: conv.id })).messages.flatMap((m) => m.steps ?? []).find((x) => x.tool === 'kb_search');
  expect(kbStep?.output).toContain('[1] 联调手册 · 联调 / 端口冲突');
  expect(kbStep?.output).toContain(`来源 ${kbName}`);
  await admin(adminToken, 'DELETE', `/iterminal/kb/collection/${kb.collection_id}`);

  // 账号档案里建一台主机（名称 real-web-01），管理后台的任务按名称指定它
  await call(page, 'host.create', {
    folderId: null, name: 'real-web-01', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw',
    keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
  });
  // 首次连接要信任主机指纹：在界面里连一次
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-real-web-01').click();
  await page.getByRole('button', { name: '信任并连接' }).click();
  await expect(page.getByTestId('tab-real-web-01').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });

  // 管理后台：登录、新建任务、立即执行
  const login = await admin<{ token: string }>(null, 'POST', '/login', { username: USER, password: PASSWORD });
  expect(login.token, JSON.stringify(login)).toBeTruthy();
  const token = login.token;
  const marker = `hi-from-server-${Date.now()}`;
  const created = await admin<{ code: number; msg: string }>(token, 'POST', '/iterminal/task', {
    taskName: `联调任务 ${marker}`, taskType: 'COMMAND', command: `echo ${marker}`, deviceId, hosts: 'real-web-01',
    cronExpression: '0 0 3 * * ?', permissionCap: 'READONLY', timeoutMin: 5, status: '1',
  });
  expect(created.code, created.msg).toBe(200);
  const tasks = await admin<{ rows: { taskId: number; taskName: string }[] }>(token, 'GET', `/iterminal/task/list?taskName=${encodeURIComponent(marker)}`);
  const taskId = tasks.rows[0].taskId;
  const run = await admin<{ code: number; data: { runId: string } }>(token, 'PUT', `/iterminal/task/run/${taskId}`);
  expect(run.code).toBe(200);

  // 客户端执行完回报：执行记录成功，每台主机的输出里有标记
  await expect
    .poll(async () => (await admin<{ data: { status: string } }>(token, 'GET', `/iterminal/run/${run.data.runId}`)).data.status, { timeout: 30_000 })
    .toBe('SUCCESS');
  const detail = await admin<{ data: { hosts: string } }>(token, 'GET', `/iterminal/run/${run.data.runId}`);
  expect(detail.data.hosts).toContain(marker);

  // 命令审计上报到服务端（来源：定时任务）
  await expect
    .poll(async () => (await admin<{ rows: { command: string; source: string }[] }>(token, 'GET', `/iterminal/audit/list?command=${encodeURIComponent(marker)}`)).rows.map((r) => r.source), {
      timeout: 30_000,
    })
    .toContain('SCHEDULE');

  // 后台吊销这台设备：客户端立即提示重新登录
  const revoke = await admin<{ code: number }>(token, 'PUT', `/iterminal/device/${deviceId}/revoke`);
  expect(revoke.code).toBe(200);
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'revoked', { timeout: 15_000 });

  await admin(token, 'DELETE', `/iterminal/task/${taskId}`);
  await admin(token, 'DELETE', `/iterminal/llm/provider/${providerId}`);
  await admin(token, 'DELETE', `/iterminal/asset/host/${teamHostId}`);
  await app.close();
});
