import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startTestFtpServer, type TestFtpServer } from '../test/support/ftp-server';

/**
 * 第二轮界面优化：模式切换、主机多选操作条、凭证管理小窗、字体下拉、终端高亮设置、没有 SFTP 时改用 FTP。
 */
let root: string;
let ssh: TestSshServer;
let ftp: TestFtpServer;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const packaged = process.env.ITM_E2E_EXECUTABLE;
  const app = packaged ? await electron.launch({ executablePath: packaged, args: [], env }) : await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'screens', `${name}.png`) });
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui2-'));
  mkdirSync(join(root, 'remote'));
  writeFileSync(join(root, 'remote', 'from-ftp.txt'), 'served over ftp');
  // 这台服务器没有 SFTP 子系统，但开了 FTP
  ssh = await startTestSshServer({ root: join(root, 'remote'), noSftp: true });
  ftp = await startTestFtpServer({ root: join(root, 'remote'), user: 'tester', password: 'pw' });
});

test.afterAll(async () => {
  await ssh?.close();
  await ftp?.close();
  rmSync(root, { recursive: true, force: true });
});

test('模式切换、主机多选操作条、凭证管理小窗、字体下拉、高亮设置', async () => {
  const { app, page } = await launch();
  // 准备几台主机（直接调用接口）
  for (const name of ['alpha-01', 'beta-02', 'gamma-03']) {
    await page.evaluate(
      (n) =>
        (globalThis as unknown as Itm).itm.invoke('host.create', {
          folderId: null, name: n, address: '10.9.0.1', port: 22, username: 'root', authMethod: 'PASSWORD', password: 'x', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [], tags: ['开发', '测试', '生产'],
        }),
      name,
    );
  }
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByText('alpha-01')).toBeVisible();

  // 多选：底部浮出操作条
  const rows = page.locator('.host-table .ant-table-row');
  await rows.nth(0).locator('.ant-checkbox-input').check();
  await rows.nth(1).locator('.ant-checkbox-input').check();
  const bar = page.getByTestId('selection-bar');
  await expect(bar).toContainText('已选择 2 台主机');
  // 标签最多显示两个，其余收成 +N
  await expect(rows.nth(0)).toContainText('+1');
  await shot(page, 'ui2-01-hosts-selection');
  await bar.getByTestId('batch-move').click();
  await expect(page.locator('.ant-modal').filter({ hasText: '移动' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await bar.getByTestId('batch-clear').click();
  await expect(bar).toBeHidden();

  // 凭证管理：主机页左下角的小窗
  await page.getByTestId('open-vault').click();
  await expect(page.locator('.vault-modal')).toContainText('凭证管理');
  await expect(page.getByTestId('new-credential')).toBeVisible();
  await shot(page, 'ui2-02-vault-modal');
  await page.locator('.vault-modal .ant-modal-close').click();
  await expect(page.locator('.vault-modal')).toBeHidden();
  await expect(page.getByTestId('nav-vault')).toHaveCount(0);

  // 模式切换：应用名后面的两个图标
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await page.getByTestId('mode-terminal').click();
  await expect(page.getByTestId('mode-terminal')).toHaveAttribute('aria-selected', 'true');

  // 字体：下拉选择（每个字体用自己预览），也可以输入其他字体
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('ui-font').click();
  await page.locator('.ant-select-item-option').filter({ hasText: '跟随系统' }).first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('settings-nav-terminal').click();
  await page.getByTestId('terminal-font').click();
  await page.keyboard.type('Courier New');
  await page.locator('.ant-select-item-option').filter({ hasText: 'Courier New' }).first().click();
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as Itm).itm.invoke('setting.getAll').then((s) => (s as Record<string, string>)['terminal.fontFamily']))).toContain('"Courier New"');

  // 终端高亮设置
  await page.getByTestId('highlight-open').click();
  const dlg = page.locator('.hl-modal');
  await expect(dlg).toContainText('预设规则');
  await expect(page.getByTestId('hl-count')).toContainText('已启用');
  const before = await page.getByTestId('hl-count').textContent();
  await page.getByTestId('hl-preset-number').locator('.ant-switch').click();
  await expect(page.getByTestId('hl-count')).not.toHaveText(before ?? '');
  // 预览里错误关键字和 IP 已上色
  await expect(page.getByTestId('hl-preview').locator('span[style*="color"]').filter({ hasText: 'ERROR' })).toHaveCount(1);
  await shot(page, 'ui2-03-highlight-presets');
  await dlg.getByRole('tab', { name: /自定义/ }).click();
  await page.getByTestId('hl-name').fill('订单号');
  await page.getByTestId('hl-pattern').fill('a*');
  await expect(dlg).toContainText('这个正则会匹配空字符串');
  await page.getByTestId('hl-pattern').fill('ORD-\\d+');
  await page.getByTestId('hl-add').click();
  await expect(page.getByTestId('hl-custom-row')).toContainText('订单号');
  await shot(page, 'ui2-04-highlight-custom');
  await page.getByTestId('hl-done').click();
  const hl = (await page.evaluate(() => (globalThis as unknown as Itm).itm.invoke('setting.getAll'))) as Record<string, { custom: { name: string }[]; presets: Record<string, boolean> }>;
  expect(hl['terminal.highlight'].custom.map((r) => r.name)).toEqual(['订单号']);
  expect(hl['terminal.highlight'].presets.number).toBe(true);
  await app.close();
});

test('服务器没有 SFTP：文件面板自动改用 FTP', async () => {
  const { app, page } = await launch();
  await page.evaluate(
    ({ port, ftpPort }) =>
      (globalThis as unknown as Itm).itm.invoke('host.create', {
        folderId: null, name: 'ftp-only', address: '127.0.0.1', port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
        fileTransfer: { mode: 'AUTO', ftpPort },
      }),
    { port: ssh.port, ftpPort: ftp.port },
  );
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-ftp-only').click();
  const trust = page.getByRole('button', { name: '信任并连接' });
  if (await trust.isVisible({ timeout: 3000 }).catch(() => false)) await trust.click();
  await page.getByTestId('right-files').click();
  await expect(page.getByTestId('file-proto')).toHaveText('FTP', { timeout: 15_000 });
  await expect(page.locator('.ant-message')).toContainText('已自动改用 FTP');
  await expect(page.getByTestId('panel-file-from-ftp.txt')).toBeVisible();
  await shot(page, 'ui2-05-ftp-fallback');
  await app.close();
});
