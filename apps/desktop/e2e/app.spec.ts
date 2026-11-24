import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 端到端：启动打包后的应用（out/），使用隔离的数据目录；连接进程内的测试 SSH 服务器。
 * 运行前需要 electron-vite build（pnpm e2e 会自动构建）。
 */

let root: string;
let userData: string;
let remoteRoot: string;
let localDir: string;
let server: TestSshServer;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: userData, ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  // ITM_E2E_EXECUTABLE 指向打包产物时，验证安装包本身（asar、原生模块解包、文件权限）
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
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-'));
  userData = join(root, 'userData');
  remoteRoot = join(root, 'remote');
  localDir = join(root, 'local');
  mkdirSync(remoteRoot);
  mkdirSync(localDir);
  mkdirSync(join(remoteRoot, 'var-log'));
  writeFileSync(join(remoteRoot, 'readme.txt'), 'hello from server');
  writeFileSync(join(localDir, 'deploy.sh'), '#!/bin/sh\necho deploy\n');
  server = await startTestSshServer({ root: remoteRoot });
});

test.afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

test('默认本地模式：建分组、建主机、SSH、SFTP、本地终端，重启后数据仍在', async () => {
  let { app, page } = await launch();

  // 1. 直接进入主界面，本地模式，不要求登录
  // 第十二轮：没有登录显示 Guest（离线使用）
  // 第三十四轮：账号在左下角头像菜单里；默认打开终端页，主机页在左侧图标栏
  await page.getByTestId('avatar-trigger').click();
  await expect(page.getByTestId('local-mode')).toContainText('Guest');
  await expect(page.getByTestId('local-mode')).toContainText('离线使用');
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByText('还没有主机，先添加一台吧')).toBeVisible();
  await shot(page, '01-first-launch');

  // 2. 新建分组「生产」
  await page.getByTestId('new-folder').click();
  await page.getByTestId('folder-name-input').fill('生产');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('folder-生产')).toBeVisible();

  // 3. 在分组里新建主机（选中分组后新建，默认落在该分组）
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('测试服务器');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(server.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  await shot(page, '02-host-editor');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('connect-测试服务器')).toBeVisible();
  await expect(page.getByTestId('folder-生产')).toContainText('1');
  await shot(page, '03-hosts');

  // 4. 连接：首次连接确认指纹
  await page.getByTestId('connect-测试服务器').click();
  await expect(page.getByText('确认主机指纹')).toBeVisible();
  await expect(page.getByText(/^SHA256:/)).toBeVisible();
  await page.waitForTimeout(400); // 等弹窗动画结束再截图
  await shot(page, '04-hostkey');
  await page.getByRole('button', { name: '信任并连接' }).click();
  await expect.poll(() => server.connections).toBe(1);

  // 终端输入送达服务器
  await page.getByTestId('terminal-测试服务器').locator('.xterm').click();
  await page.keyboard.type('hello-e2e');
  await page.keyboard.press('Enter');
  await expect.poll(() => server.lines).toContain('hello-e2e');
  await page.waitForTimeout(300);
  await shot(page, '05-terminal');

  // 5. 从终端标签打开 SFTP：复用同一条连接
  await page.getByTestId('open-sftp-from-tab').click();
  const remotePane = page.getByTestId('pane-remote');
  await expect(remotePane.getByTestId('panel-file-readme.txt')).toBeVisible();
  expect(server.connections).toBe(1);

  // 本地窗格定位到测试目录，选中文件上传
  const localPath = page.getByTestId('path-local');
  await localPath.fill(localDir);
  await localPath.press('Enter');
  await page.getByTestId('file-local-deploy.sh').click();
  await page.getByTestId('transfer-local').click();
  await expect(page.getByTestId('transfer-deploy.sh')).toHaveAttribute('data-status', 'done');
  await expect(remotePane.getByTestId('panel-file-deploy.sh')).toBeVisible();
  expect(readFileSync(join(remoteRoot, 'deploy.sh'), 'utf8')).toContain('echo deploy');

  // 远端文件下载到本地（第二十六轮起远端窗格和右侧文件面板一样：选中后点「下载」，下载到左边的本地目录）
  await remotePane.getByTestId('panel-file-readme.txt').click();
  await remotePane.getByTestId('file-panel-download').click();
  await expect(page.getByTestId('transfer-readme.txt')).toHaveAttribute('data-status', 'done');
  expect(readFileSync(join(localDir, 'readme.txt'), 'utf8')).toBe('hello from server');
  await shot(page, '06-sftp');

  // 6. 本地终端（node-pty）：写一个文件证明命令执行了
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('open-local').click();
  await page.getByTestId('terminal-本地终端').locator('.xterm').click();
  const marker = join(root, 'local-shell-ok');
  await page.keyboard.type(`echo itm > '${marker}'`);
  await page.keyboard.press('Enter');
  await expect.poll(() => existsSync(marker), { timeout: 15_000 }).toBe(true);
  await shot(page, '07-local-shell');

  // 7. 设置页：浅色主题
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-account').click();
  await expect(page.getByTestId('settings-account')).toContainText('本地模式（Guest，未登录）');
  await page.getByTestId('settings-nav-general').click();
  await page.getByText('浅色', { exact: true }).click();
  await page.waitForTimeout(600);
  await shot(page, '08-settings-light');

  await app.close();

  // 8. 重启：数据仍在（加密库 + 本地密钥文件），主题设置保留，指纹已记住
  ({ app, page } = await launch());
  // 第三十四轮起默认打开终端页
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('connect-测试服务器')).toBeVisible();
  await expect(page.getByTestId('folder-生产')).toBeVisible();
  await shot(page, '09-after-restart');
  await page.getByTestId('connect-测试服务器').click();
  await expect.poll(() => server.connections).toBe(2);
  await expect(page.getByText('确认主机指纹')).toHaveCount(0);

  // 数据库文件（含 WAL）是加密的：看不到明文的主机名和密码
  const dbFile = join(userData, 'profiles', 'local', 'iterminal.db');
  const db = readFileSync(dbFile);
  expect(db.subarray(0, 16).toString('latin1')).not.toContain('SQLite format');
  for (const f of [dbFile, `${dbFile}-wal`].filter((x) => existsSync(x))) {
    const bytes = readFileSync(f);
    expect(bytes.includes(Buffer.from('测试服务器'))).toBe(false);
    expect(bytes.includes(Buffer.from('127.0.0.1'))).toBe(false);
  }

  await app.close();
});
