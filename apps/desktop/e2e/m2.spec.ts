import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * M2 工作台：分屏、广播输入、# 问 AI、行内补全。
 */
let root: string;
let server: TestSshServer;
let llm: LlmMock;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
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

/** 在终端里输入一行（逐字输入，触发输入行跟踪） */
async function typeLine(page: Page, testId: string, text: string, enter = true): Promise<void> {
  await page.getByTestId(testId).locator('.xterm').click();
  await page.keyboard.type(text, { delay: 15 });
  if (enter) await page.keyboard.press('Enter');
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-m2-'));
  mkdirSync(join(root, 'remote'));
  server = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await server?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('分屏、广播输入、# 问 AI、行内补全', async () => {
  const { app, page } = await launch();

  // 准备：AI 模型和一台主机
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('add-provider').click();
  await page.getByTestId('vendor-tabs').getByText('海外平台').click();
  await page.getByTestId('vendor-anthropic').click();
  // 新建服务商时不预先填模型：从官方模型里全部添加
  await page.getByTestId('preset-models').click();
  await page.getByRole('menuitem', { name: '全部添加' }).click();
  await page.getByTestId('provider-name').fill('Claude');
  await page.getByTestId('provider-url').fill(llm.url);
  await page.getByTestId('provider-key').fill('test-key');
  await page.getByTestId('provider-save').click();
  await expect(page.locator('.provider-item').filter({ hasText: 'Claude' })).toBeVisible();

  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('web');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(server.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByTestId('connect-web').click();
  await page.getByRole('button', { name: '信任并连接' }).click();
  await expect.poll(() => server.connections).toBe(1);
  await expect(page.getByTestId('tab-web').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');

  // 1. 分屏：同一台主机再开一个窗格，复用同一条 SSH 连接
  // 标签行右侧的工具区：左右分屏
  await page.getByTestId('split-h').click();
  await expect(page.getByTestId('pane-web')).toHaveCount(2);
  await expect(page.getByTestId('tab-web')).toContainText('2');
  await page.waitForTimeout(800);
  expect(server.connections).toBe(1);
  // 两个窗格平分左侧区域（防止布局被右侧面板挤压）
  const widths = await page.getByTestId('pane-web').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
  expect(Math.min(...widths)).toBeGreaterThan(250);
  expect(Math.abs(widths[0] - widths[1])).toBeLessThan(20);
  await shot(page, 'm2-01-split');

  // 2. 广播：在一个窗格里输入，两个会话都收到
  await page.getByTestId('broadcast').click();
  await page.getByTestId('broadcast-toggle').click();
  await expect(page.getByTestId('broadcast')).toContainText('广播中（2）');
  await page.keyboard.press('Escape');
  await typeLine(page, 'xterm-tab-1', 'bcast-test');
  await expect.poll(() => server.lines.filter((l) => l === 'bcast-test').length).toBe(2);
  await page.getByTestId('broadcast').click();
  await page.getByTestId('broadcast-toggle').click();
  await page.keyboard.press('Escape');

  // 3. # 问 AI：不发送到服务器，转给 AI 面板
  llm.enqueue({ text: '磁盘使用率正常。' });
  await typeLine(page, 'xterm-tab-1', '#磁盘满了吗');
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.getByText('磁盘使用率正常。')).toBeVisible();
  expect(server.lines.some((l) => l.includes('磁盘满了吗'))).toBe(false);
  expect(JSON.stringify(llm.requests.at(-1)?.body)).toContain('磁盘满了吗');
  await shot(page, 'm2-02-hash-ask');

  // 4. 命令提示：执行过的命令再次输入前缀时弹出提示（有提示框时不再显示灰色补全），回车补全（不执行），再按回车执行
  await typeLine(page, 'xterm-tab-1', 'echo history-one');
  await expect.poll(() => server.lines.includes('echo history-one')).toBe(true);
  await typeLine(page, 'xterm-tab-1', 'echo hi', false);
  await expect(page.getByTestId('term-suggest-row').first()).toContainText('echo history-one');
  await expect(page.locator('.ghost-text')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  expect(server.lines.filter((l) => l === 'echo history-one').length).toBe(1);
  await page.keyboard.press('Enter');
  await expect.poll(() => server.lines.filter((l) => l === 'echo history-one').length).toBe(2);

  // 5. 底部状态栏的 AI 按钮：收起 / 打开 AI 面板；模型切换和上下文占用在输入框下方
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await page.getByTestId('statusbar-ai').first().click();
  await expect(page.getByTestId('right-expand')).toBeVisible();
  await page.getByTestId('statusbar-ai').first().click();
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  await expect(page.locator('.composer-bar').getByTestId('agent-model')).toBeVisible();
  await expect(page.locator('.composer-bar').getByTestId('context-ring')).toBeVisible();

  // 6. 终端右键：选中内容后可以复制，并能引用到 AI 对话框（不直接发送）
  const screen = page.getByTestId('xterm-tab-1').locator('.xterm-screen');
  const box = (await screen.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 8, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.down('Control');
  await page.mouse.click(box.x + 60, box.y + 8, { button: 'right' });
  await page.keyboard.up('Control');
  await expect(page.getByRole('menuitem', { name: /复制/ })).not.toHaveClass(/disabled/);
  await expect(page.getByRole('menuitem', { name: /让 AI 解释/ })).not.toHaveClass(/disabled/);
  const before = llm.requests.length;
  await page.getByRole('menuitem', { name: /引用选中内容到 AI 对话框/ }).click();
  await expect(page.getByTestId('agent-input')).toHaveValue(/welcome to/);
  await expect(page.getByTestId('agent-input')).toBeFocused();
  expect(llm.requests.length).toBe(before);
  await shot(page, 'm2-03-quote');
  // 引用的内容全部可见（输入框没有卷动）
  await expect.poll(() => page.getByTestId('agent-input').evaluate((e) => (e as unknown as { scrollTop: number }).scrollTop)).toBe(0);

  // 7. 关闭窗格：退回普通标签
  await page.getByTestId('pane-close-web').first().click();
  await expect(page.getByTestId('pane-web')).toHaveCount(1);
  await expect(page.getByTestId('tab-web')).not.toContainText('2');
  await app.close();
});
