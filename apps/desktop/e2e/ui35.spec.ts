import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 第三十五轮：去掉定时任务和监控告警；新增「批量执行」（批量执行命令 / 批量上传文件）；
 * 「审计&回放」改为「运维审计」（连接日志带登录账号和起止时间、命令记录）；Agent 权限三档改名为 只读 / 自动 / 完全允许。
 */
let root: string;
let ssh: TestSshServer;

test.describe.configure({ mode: 'serial' });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(join(__dirname, '..', 'test-results', 'shots'), { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'shots', `${name}.png`) });
}

async function prepare(page: Page): Promise<void> {
  const names = (await call<{ name: string }[]>(page, 'host.list')).map((h) => h.name);
  for (const name of ['web35-a', 'web35-b']) {
    if (names.includes(name)) continue;
    await call(page, 'host.create', { folderId: null, name, address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });
  }
}

/** 第一次连接测试服务器时信任主机密钥 */
async function trustIfAsked(page: Page): Promise<void> {
  // 批量执行同时连多台主机时，每台没信任过的主机都会问一次
  const trust = page.getByRole('button', { name: '信任并连接' });
  for (let i = 0; i < 4; i++) {
    const clicked = await trust.first().click({ timeout: i === 0 ? 5000 : 2000 }).then(() => true, () => false);
    if (!clicked) break;
  }
}

/** 在主机选择框里按名称勾选 */
async function pickHosts(page: Page, testId: string, names: string[]): Promise<void> {
  await page.getByTestId(testId).click();
  for (const n of names) await page.getByTestId('resident-table').getByText(n, { exact: true }).click();
  await page.getByTestId('resident-save').click();
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui35-'));
  mkdirSync(join(root, 'remote'), { recursive: true });
  ssh = await startTestSshServer({ root: join(root, 'remote') });
});

test.afterAll(async () => {
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('导航：批量执行替代定时任务；监控没有告警入口', async () => {
  const { app, page } = await launch();
  await expect(page.getByTestId('nav-batch')).toBeVisible();
  await expect(page.getByTestId('nav-schedule')).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.mouse.move(600, 400);
  await page.getByTestId('nav-audit').hover();
  await expect(page.locator('.ant-tooltip').filter({ hasText: '运维审计' })).toBeVisible();
  await page.mouse.move(600, 400);
  await expect(async () => {
    await page.getByTestId('rail-more').hover();
    await expect(page.getByTestId('rail-more-menu')).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId('rail-more-menu').getByTestId('nav-monitor').click();
  await expect(page.getByTestId('mon-section-resident')).toBeVisible();
  await expect(page.getByTestId('mon-alert-settings')).toHaveCount(0);
  await expect(page.getByTestId('mon-view-alerts')).toHaveCount(0);
  await expect(page.getByText('告警记录')).toHaveCount(0);
  await app.close();
});

test('批量执行命令：选主机、从模板选命令、执行后每台主机的输出；执行历史、执行记录和详情；命令记入运维审计', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await call(page, 'snippet.save', { id: null, input: { groupId: null, name: '看看主机名', content: 'echo batch-from-template', description: null, tags: [] } });
  await page.reload();
  // 第一次连接先信任主机密钥（批量执行在后台连接时也会问）
  await page.getByTestId('nav-batch').click();
  await expect(page.getByTestId('batch-exec-compose')).toBeVisible();
  await expect(page.getByTestId('batch-exec-history')).toContainText('无执行记录');

  // 没选主机：提示
  await page.getByTestId('batch-exec-run').click();
  await expect(page.getByText('请选择执行主机')).toBeVisible();
  await pickHosts(page, 'batch-exec-hosts', ['web35-a', 'web35-b']);
  await expect(page.getByTestId('batch-exec-hosts')).toHaveText('已选 2 台主机');
  await expect(page.getByText('请选择执行主机')).toHaveCount(0);
  await page.getByTestId('batch-exec-desc').fill('E2E 巡检');

  // 从模板中选择（指令集）
  await page.getByTestId('batch-from-template').click();
  await page.getByTestId('batch-snippet-table').getByText('看看主机名').click();
  await expect(page.getByTestId('batch-editor-content')).toContainText('echo batch-from-template');
  await page.getByTestId('batch-editor-content').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  // 直接敲带引号的命令（第三十五轮修正：Shell 高亮遇到引号时出错，引号后面的内容会丢）
  await page.keyboard.press('Enter');
  await page.keyboard.type('echo "second-line $(echo ok)"', { delay: 5 });
  await expect(page.getByTestId('batch-editor-content')).toContainText('echo "second-line $(echo ok)"');
  await shot(page, 'ui35-01-batch-exec');

  await page.getByTestId('batch-exec-run').click();
  await page.getByTestId('batch-exec-confirm').click();
  await trustIfAsked(page);
  const drawer = page.getByTestId('batch-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('batch-host-web35-a')).toHaveAttribute('data-status', 'success', { timeout: 20_000 });
  await expect(drawer.getByTestId('batch-host-web35-b')).toHaveAttribute('data-status', 'success', { timeout: 20_000 });
  await drawer.getByTestId('batch-host-web35-a').locator('.batch-host-head').click();
  await expect(drawer.getByTestId('batch-host-output').first()).toContainText('batch-from-template');
  await expect(drawer.getByTestId('batch-host-output').first()).toContainText('second-line ok');
  await shot(page, 'ui35-02-batch-result');
  await page.keyboard.press('Escape');

  // 执行历史（右侧最近 15 条）
  await expect(page.getByTestId('batch-history-item')).toHaveCount(1);
  await expect(page.getByTestId('batch-history-item').first()).toContainText('E2E 巡检');

  // 执行记录列表 → 详情
  await page.getByTestId('batch-show-list').click();
  const list = page.getByTestId('batch-list-exec');
  await expect(list).toContainText('E2E 巡检');
  await expect(list).toContainText('成功');
  await list.getByTestId('batch-job-detail').first().click();
  await expect(page.getByTestId('batch-drawer')).toBeVisible();
  await expect(page.getByTestId('batch-host-list').locator('[data-status="success"]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await page.getByTestId('batch-show-compose').click();

  // 运维审计 → 命令记录：用户（本机）、账号、命令
  await page.getByTestId('nav-audit').click();
  await page.getByTestId('audit-tab-cmd').click();
  const cmd = page.getByTestId('audit-table-COMMAND');
  await expect(cmd).toContainText('echo batch-from-template');
  await expect(cmd).toContainText('tester');
  await expect(cmd).toContainText('web35-a');
  await shot(page, 'ui35-03-audit-commands');
  await app.close();
});

test('批量上传文件：选择文件和文件夹，上传到每台主机的目录（不存在时创建）', async () => {
  const { app, page } = await launch();
  await prepare(page);
  const local = join(root, 'local-up');
  mkdirSync(join(local, 'conf'), { recursive: true });
  writeFileSync(join(local, 'app.txt'), 'hello upload');
  writeFileSync(join(local, 'conf', 'a.yml'), 'a: 1');
  await page.getByTestId('nav-batch').click();
  await page.getByTestId('batch-tab-upload').click();
  await expect(page.getByTestId('batch-upload-compose')).toBeVisible();
  await expect(page.getByText('请先点击上方按钮选择文件')).toBeVisible();

  // 必填项
  await page.getByTestId('batch-upload-start').click();
  await expect(page.getByText('请输入上传路径')).toBeVisible();
  await expect(page.getByText('请选择上传主机')).toBeVisible();

  await page.getByTestId('batch-upload-path').fill('/deploy35');
  await pickHosts(page, 'batch-upload-hosts', ['web35-a', 'web35-b']);
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as unknown as typeof dialog.showOpenDialog;
  }, join(local, 'app.txt'));
  await page.getByTestId('batch-pick-files').click();
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as unknown as typeof dialog.showOpenDialog;
  }, join(local, 'conf'));
  await page.getByTestId('batch-pick-folder').click();
  await expect(page.getByTestId('batch-file-list').locator('.batch-file-row')).toHaveCount(2);
  await shot(page, 'ui35-04-batch-upload');

  await page.getByTestId('batch-upload-start').click();
  await page.getByTestId('batch-upload-confirm').click();
  await expect(page.getByTestId('batch-upload-detail')).toBeVisible({ timeout: 20_000 });
  // 测试服务器的 SFTP 把 / 映射到 remote 目录
  await expect.poll(() => existsSync(join(root, 'remote', 'deploy35', 'conf', 'a.yml')), { timeout: 20_000 }).toBe(true);
  expect(readFileSync(join(root, 'remote', 'deploy35', 'app.txt'), 'utf8')).toBe('hello upload');
  await expect(page.locator('.batch-steps .ant-steps-item-finish')).toHaveCount(3, { timeout: 20_000 });
  await page.getByTestId('batch-upload-detail').click();
  await expect(page.getByTestId('batch-host-list').locator('[data-status="success"]')).toHaveCount(2);
  await shot(page, 'ui35-05-batch-upload-done');
  await page.keyboard.press('Escape');

  await page.getByTestId('batch-show-list').click();
  await expect(page.getByTestId('batch-list-upload')).toContainText('/deploy35');
  await app.close();
});

test('运维审计：连接日志有登录账号、开始和结束时间，可以回放；顶部切换连接日志 / 命令记录，没有安全事件', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web35-a').click();
  await trustIfAsked(page);
  const dot = page.getByTestId('tab-web35-a').locator('.status-dot');
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await page.getByTestId('tab-web35-a').locator('.ws-top-tab-close').click();
  await page.getByRole('button', { name: /关闭|断开/ }).last().click({ timeout: 3000 }).catch(() => undefined);

  await page.getByTestId('nav-audit').click();
  await expect(page.getByTestId('audit-tabs')).toBeVisible();
  await expect(page.getByText('安全事件')).toHaveCount(0);
  const conn = page.getByTestId('recording-table');
  const row = conn.locator('.ant-table-row').filter({ hasText: 'web35-a' }).first();
  await expect(row).toContainText('tester');
  await expect(row).toContainText('SSH');
  await expect(row).toContainText('完成', { timeout: 10_000 });
  await expect(row).toContainText('从：');
  await expect(row).toContainText('至：');
  await shot(page, 'ui35-06-connection-log');
  // 按登录账号筛选
  await page.getByTestId('conn-filter-user').fill('nobody');
  await page.getByTestId('conn-search').click();
  await expect(conn.locator('.ant-table-row')).toHaveCount(0);
  await page.getByTestId('conn-filter-user').fill('tester');
  await page.getByTestId('conn-search').click();
  await expect(conn.locator('.ant-table-row').first()).toContainText('web35-a');
  // 回放
  await row.getByTestId('recording-play').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await app.close();
});

test('系统「减少动态效果」时浮层照常显示在窗口里：提示、···、头像菜单、+、右键菜单（Windows 关闭动画时 1.2.0 内测包的问题）', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  /** 浮层在窗口里（不是在屏幕外的初始位置） */
  const onScreen = async (sel: string): Promise<void> => {
    await expect
      .poll(() =>
        page.locator(sel).evaluateAll((els) =>
          els.some((e) => {
            const r = (e as unknown as { getBoundingClientRect(): { left: number; top: number; width: number; height: number } }).getBoundingClientRect();
            const g = globalThis as unknown as { innerWidth: number; innerHeight: number };
            return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.left < g.innerWidth && r.top < g.innerHeight;
          }),
        ),
      )
      .toBe(true);
  };
  await page.mouse.move(600, 400);
  await page.getByTestId('nav-audit').hover();
  await onScreen('.ant-tooltip:not(.ant-tooltip-hidden)');
  await page.getByTestId('rail-more').hover();
  await onScreen('.rail-more-popover:not(.ant-popover-hidden)');
  await page.mouse.move(600, 400);
  await page.getByTestId('avatar-trigger').click();
  await onScreen('.avatar-menu-popover:not(.ant-popover-hidden)');
  await page.keyboard.press('Escape');
  // 主机列表右键菜单
  await page.getByTestId('nav-hosts').click();
  await page.getByText('web35-a', { exact: true }).first().click({ button: 'right' });
  await onScreen('.ant-dropdown:not(.ant-dropdown-hidden)');
  await page.keyboard.press('Escape');
  // 终端标签栏的 +
  await page.getByTestId('nav-workspace').click();
  await page.getByTestId('topbar-local-shell').click();
  await page.getByTestId('tab-new').click();
  await onScreen('.ant-dropdown:not(.ant-dropdown-hidden)');
  await shot(page, 'ui35-07-reduced-motion-popups');
  await app.close();
});
