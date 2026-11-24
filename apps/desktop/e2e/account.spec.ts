import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../test/support/mock-server';

/**
 * 账号模式（文档一 2.3 / 6.10.8、文档二 6.1）：登录、导入本地数据、团队规则下发、访问令牌自动刷新、
 * 登录过期后重新登录、设备被吊销、退出登录回到本地模式、重启后保持登录。
 */
let root: string;
let mock: MockServer;

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

const hostBase = { folderId: null, port: 22, username: 'root', authMethod: 'PASSWORD', password: 'x', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [] };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-account-'));
  mock = await startMockServer();
  mock.setPolicy({
    commandRules: [{ id: '1', name: '禁止重启', matchType: 'PREFIX', pattern: 'reboot', level: 'DENY', reason: '团队规定：禁止 AI 重启服务器', priority: 1 }],
    maskRules: [{ id: '1', name: '工号', pattern: '\\bEMP\\d{6}\\b', replacement: '[工号]', forcePrivate: false }],
    unattendedCap: 'READONLY',
    allowLlmReview: true,
    version: 'v1',
  });
});

test.afterAll(async () => {
  await mock?.close();
  rmSync(root, { recursive: true, force: true });
});

test('登录：密码错误有提示；登录后切换到账号档案、导入本地数据、连接服务端、团队规则生效', async () => {
  const { app, page } = await launch();
  await call(page, 'host.create', { ...hostBase, name: 'local-only', address: '10.1.0.1' });
  await page.reload();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'none');

  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(mock.user.username);
  await page.getByTestId('login-password').fill('wrong');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-error')).toContainText('用户不存在/密码错误');

  // 本机有 1 台主机：默认导入到账号
  await expect(page.getByTestId('login-import')).toBeVisible();
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();

  // 登录后窗口重新加载为账号档案
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', /^(valid|expired|revoked)$/, { timeout: 15_000 });
  await page.getByTestId('avatar-trigger').click();
  await expect(page.getByTestId('account-name')).toHaveText('测试用户');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  const state = await call<{ status: string; profileId: string; username: string }>(page, 'account.state');
  expect(state).toMatchObject({ status: 'valid', username: 'tester' });
  expect(state.profileId).toMatch(/^u_7_[0-9a-f]{8}$/);
  const hosts = await call<{ name: string }[]>(page, 'host.list');
  expect(hosts.map((h) => h.name)).toContain('local-only');

  // 请求带着设备标识；连上后拉取团队策略
  const deviceId = readFileSync(join(root, 'userData', 'device-id'), 'utf8').trim();
  await expect.poll(() => mock.rest.some((r) => r.path === '/api/v1/ai/policy' && r.deviceId === deviceId)).toBe(true);
  await expect.poll(async () => (await call<{ team: unknown[] }>(page, 'cmdrule.list')).team.length).toBe(1);
  const t = await call<{ level: string; segments: { source: string }[] }>(page, 'cmdrule.test', { command: 'reboot now' });
  expect(t.level).toBe('DENY');
  expect(t.segments[0].source).toBe('team');

  // 设置 → 命令安全里能看到团队规则
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-agent').click();
  await page.getByTestId('settings-tab-cmdsec').click();
  await expect(page.getByTestId('team-rules')).toContainText('团队规定：禁止 AI 重启服务器');
  await app.close();
});

test('重启后保持登录；访问令牌失效时自动用刷新令牌换新的', async () => {
  const { app, page } = await launch();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', /^(valid|expired|revoked)$/);
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  const refreshes = mock.rest.filter((r) => r.path === '/api/v1/auth/refresh').length;
  mock.expireAccess();
  mock.dropClients();
  await expect.poll(() => mock.rest.filter((r) => r.path === '/api/v1/auth/refresh').length, { timeout: 20_000 }).toBe(refreshes + 1);
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 20_000 });
  expect((await call<{ status: string }>(page, 'account.state')).status).toBe('valid');
  await app.close();
});

test('刷新令牌失效：提示登录已过期，重新输入密码后恢复', async () => {
  const { app, page } = await launch();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  mock.expireAccess();
  mock.expireRefresh();
  mock.dropClients();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'expired', { timeout: 20_000 });
  await expect(page.getByText('登录已过期').first()).toBeVisible();
  await page.getByTestId('account-expired-relogin').click();
  // 重新登录：地址和用户名已经填好，不能修改
  await expect(page.getByTestId('login-username')).toHaveValue('tester');
  await expect(page.getByTestId('login-username')).toBeDisabled();
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'valid');
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 20_000 });
  await app.close();
});

test('设备被吊销：停止连接并提示重新登录', async () => {
  const { app, page } = await launch();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  mock.send('device.revoked', { message: '管理员吊销了这台设备' }, { ack: true });
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'revoked', { timeout: 10_000 });
  // 第三十四轮：头像菜单里「重新登录」（登录框里写着原因）
  await page.getByTestId('avatar-trigger').click();
  await expect(page.getByTestId('account-relogin')).toHaveText('重新登录');
  await page.getByTestId('account-relogin').click();
  await expect(page.getByTestId('login-reason')).toContainText('吊销');
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'valid');
  await app.close();
});

test('退出登录：回到本地模式（本地数据还在），可以切回账号', async () => {
  const { app, page } = await launch();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', /^(valid|expired|revoked)$/);
  await call(page, 'host.create', { ...hostBase, name: 'account-only', address: '10.2.0.1' });
  await page.getByTestId('avatar-trigger').click();
  await page.locator('.avatar-menu-popover .avatar-menu-item').filter({ hasText: /^退出登录$/ }).click();
  // 切换档案时先广播新状态、再重新加载窗口：等加载完再操作，否则可能点在马上被重新加载的旧页面上
  let reloaded = page.waitForEvent('load');
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '退出登录' }).click();
  await reloaded;
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'none', { timeout: 15_000 });
  expect(mock.rest.some((r) => r.path === '/api/v1/auth/logout')).toBe(true);
  const local = (await call<{ name: string }[]>(page, 'host.list')).map((h) => h.name);
  expect(local).toContain('local-only');
  expect(local).not.toContain('account-only');
  // 本地模式没有团队规则
  expect((await call<{ team: unknown[] }>(page, 'cmdrule.list')).team).toHaveLength(0);

  // 切回账号：数据还在，但需要重新输入密码（头像菜单里「切换到 …」）
  await page.getByTestId('avatar-trigger').click();
  reloaded = page.waitForEvent('load');
  await page.locator('.avatar-menu-popover').getByRole('button', { name: /切换到 测试用户/ }).click();
  await reloaded;
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'expired', { timeout: 15_000 });
  expect((await call<{ name: string }[]>(page, 'host.list')).map((h) => h.name)).toContain('account-only');
  await app.close();
});
