import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../test/support/mock-server';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 团队主机（文档二 5.2）：登录后同步到「团队主机」分组，只读；用服务端下发的密码直接连接；服务端删除后同步时本机也删除。
 */
let root: string;
let mock: MockServer;
let ssh: TestSshServer;

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
type HostRow = { id: string; name: string; folderId: string | null; team?: { allowReveal: boolean } | null };

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-assets-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  mock = await startMockServer();
});

test.afterAll(async () => {
  await mock?.close();
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('团队主机：登录后同步到「团队主机」分组、只读，用下发的密码连接；服务端删除后同步删除', async () => {
  const teamHost = { id: 101, folderId: 10, name: 'team-web', protocol: 'SSH', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', privateKey: null, passphrase: null, allowReveal: false, note: '团队共享的测试机', version: 1 };
  mock.setTeamAssets({ folders: [{ id: 10, parentId: null, name: '生产环境' }], hosts: [teamHost] });
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(mock.user.username);
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });

  await expect.poll(async () => (await call<HostRow[]>(page, 'host.list')).find((h) => h.name === 'team-web')?.team, { timeout: 10_000 }).toEqual({ allowReveal: false });
  const folders = await call<{ id: string; name: string; parentId: string | null; team?: boolean }[]>(page, 'folder.list');
  const rootFolder = folders.find((f) => f.name === '团队主机')!;
  const prod = folders.find((f) => f.name === '生产环境')!;
  expect(rootFolder.team).toBe(true);
  expect(prod.parentId).toBe(rootFolder.id);
  const h = (await call<HostRow[]>(page, 'host.list')).find((x) => x.name === 'team-web')!;
  expect(h.folderId).toBe(prod.id);

  // 只读：不能改、不能删、不能在团队分组里建主机或改分组
  await expect(call(page, 'host.update', { id: h.id, input: { folderId: prod.id, name: 'x', address: '1.1.1.1', port: 22, username: 'u', authMethod: 'PASSWORD', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [] } })).rejects.toThrow('团队主机由管理员');
  await expect(call(page, 'host.delete', { ids: [h.id] })).rejects.toThrow('团队主机由管理员');
  await expect(call(page, 'folder.rename', { id: prod.id, name: '改名' })).rejects.toThrow('团队主机分组');
  await expect(call(page, 'host.create', { folderId: prod.id, name: 'mine', address: '1.1.1.1', port: 22, username: 'u', authMethod: 'PASSWORD', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [] })).rejects.toThrow('不能放入个人主机');

  // 主机页：团队标签；编辑框只读
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('team-host-team-web')).toBeVisible();
  await page.getByTestId('more-team-web').click();
  await page.getByRole('menuitem', { name: '查看' }).click();
  await expect(page.getByTestId('team-host-readonly')).toContainText('没有允许查看密码');
  await expect(page.getByTestId('host-save')).toHaveCount(0);
  await page.locator('.ant-modal-footer').getByRole('button', { name: '关闭' }).click();

  // 用服务端下发的密码连接
  await page.getByTestId('connect-team-web').click();
  const dot = page.getByTestId('tab-team-web').locator('.status-dot');
  await Promise.race([page.getByRole('button', { name: '信任并连接' }).click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });

  // 服务端删除后：点「同步团队主机」本机也删除，根分组一起删掉
  mock.setTeamAssets({ folders: [], hosts: [] });
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('team-sync').click();
  await expect.poll(async () => (await call<HostRow[]>(page, 'host.list')).some((x) => x.name === 'team-web'), { timeout: 10_000 }).toBe(false);
  expect((await call<{ name: string }[]>(page, 'folder.list')).some((f) => f.name === '团队主机')).toBe(false);
  await app.close();
});
