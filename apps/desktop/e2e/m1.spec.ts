import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * M1：主密码与锁定、凭证管理、分组设置与继承、主机导入。
 */
let root: string;
let userData: string;
let server: TestSshServer;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: userData, ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const packaged = process.env.ITM_E2E_EXECUTABLE;
  const app = packaged
    ? await electron.launch({ executablePath: packaged, args: [], env })
    : await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'screens', `${name}.png`) });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-m1-'));
  userData = join(root, 'userData');
  mkdirSync(join(root, 'remote'));
  server = await startTestSshServer({ root: join(root, 'remote'), username: 'ops', password: 'ops-pw' });
});

test.afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

test('主密码、凭证、分组继承、导入', async () => {
  let { app, page } = await launch();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'none');

  // 1. 设置主密码
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-security').click();
  await page.getByTestId('set-master').click();
  await page.getByTestId('master-new').fill('master-pass-1');
  await page.getByTestId('master-confirm').fill('master-pass-1');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('主密码已设置，下次启动需要输入')).toBeVisible();

  // 2. 新建共享密码凭证（主机页左下角的「凭证管理」小窗）
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('open-vault').click();
  await page.getByTestId('new-credential').click();
  await page.getByRole('menuitem', { name: '密码' }).click();
  await page.getByTestId('credential-name').fill('运维账号');
  await page.getByTestId('credential-username').fill('ops');
  await page.getByTestId('credential-secret').fill('ops-pw');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.ant-message').getByText('凭证已创建')).toBeVisible();
  await expect(page.getByRole('cell', { name: '运维账号' })).toBeVisible();
  await shot(page, 'm1-01-vault');
  await page.locator('.vault-modal .ant-modal-close').click();
  await expect(page.locator('.vault-modal')).toBeHidden();
  await expect(page.getByTestId('open-vault')).toContainText('1');

  // 3. 分组设置：默认凭证；主机继承
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-folder').click();
  await page.getByTestId('folder-name-input').fill('生产');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByTestId('folder-生产').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '分组设置…' }).click();
  const settings = page.getByTestId('folder-settings');
  await settings.getByText('继承上级').first().click();
  await page.getByTitle('运维账号（ops）').click();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.ant-message').getByText('分组设置已保存')).toBeVisible();

  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('app-01');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(server.port));
  await page.getByTestId('host-auth').getByText('使用凭证').click();
  await page.getByTestId('host-username').fill('');
  await expect(page.getByText('将使用分组「生产」的默认凭证：运维账号')).toBeVisible();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('connect-app-01')).toBeVisible();

  // 连接：用继承来的凭证登录，只需要确认指纹
  await page.getByTestId('connect-app-01').click();
  await page.getByRole('button', { name: '信任并连接' }).click();
  await expect.poll(() => server.connections).toBe(1);
  await page.getByTestId('terminal-app-01').locator('.xterm').click();
  await page.keyboard.type('before-lock');
  await page.keyboard.press('Enter');
  await expect.poll(() => server.lines).toContain('before-lock');
  await shot(page, 'm1-02-connected');

  // 4. 锁定 → 解锁
  await page.getByTestId('lock-now').click();
  await expect(page.getByTestId('security-locked')).toBeVisible();
  await page.getByTestId('master-password').fill('wrong-password');
  await page.getByTestId('unlock').click();
  await expect(page.getByText('主密码不正确')).toBeVisible();
  await page.getByTestId('master-password').fill('master-pass-1');
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('security-locked')).toBeHidden();
  // 锁定期间终端会话没有断开：解锁后继续输入，还是同一条连接
  await page.getByTestId('terminal-app-01').locator('.xterm').click();
  await page.keyboard.type('after-unlock');
  await page.keyboard.press('Enter');
  await expect.poll(() => server.lines).toContain('after-unlock');
  expect(server.connections).toBe(1);

  // 5. 重启：冷启动要求主密码
  await app.close();
  ({ app, page } = await launch());
  await expect(page.getByTestId('security-cold')).toBeVisible();
  await shot(page, 'm1-03-unlock');
  await page.getByTestId('master-password').fill('master-pass-1');
  await page.getByTestId('master-password').press('Enter');
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('connect-app-01')).toBeVisible();

  // 6. 查看明文需要主密码
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('open-vault').click();
  await page.getByTestId('reveal-运维账号').click();
  await page.getByTestId('reveal-password').fill('master-pass-1');
  await page.getByTestId('reveal-confirm').click();
  await expect(page.locator('.reveal-box')).toContainText('ops-pw');
  await expect(page.getByText('秒后自动隐藏')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.vault-modal .ant-modal-close').click();
  await expect(page.locator('.vault-modal')).toBeHidden();

  // 7. 导入 CSV
  const csv = join(root, 'hosts.csv');
  writeFileSync(csv, 'name,group,address,port,username,tags\nweb-01,导入/Web,10.0.0.1,22,root,web\nweb-02,导入/Web,10.0.0.2,22,root,web\n');
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('import-hosts').click();
  await page.getByRole('menuitem', { name: /从文件导入/ }).click();
  await page.getByTestId('import-source').click();
  await page.getByTitle('CSV 表格').click();
  // 文件选择框由主进程弹出，E2E 里直接调用预览接口代替
  await page.evaluate(async (path) => {
    // 渲染进程里的 window.itm（preload 暴露的桥）
    const itm = (globalThis as unknown as { itm: { invoke(c: string, a: unknown): Promise<{ token: string; items: { key: string }[] }> } }).itm;
    const p = await itm.invoke('import.preview', { source: 'CSV', path });
    await itm.invoke('import.commit', { token: p.token, keys: p.items.map((i) => i.key), targetFolderId: null, skipDuplicates: true });
  }, csv);
  await page.keyboard.press('Escape');
  // 重新加载界面（主进程里档案仍然是解锁状态，不需要再输入主密码）
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('connect-web-02')).toBeVisible();
  await page.getByTestId('tag-filter').click();
  await page.getByTitle('web', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('connect-app-01')).toBeHidden();
  await shot(page, 'm1-04-import');
  await app.close();
});
