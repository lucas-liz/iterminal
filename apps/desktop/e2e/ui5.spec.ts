import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第五轮：上下文环、输入框里的发送按钮、排队发送、主题色滚动条、ssh 命令导入 / 生成端口转发、浅色配色、应用图标、
 * 没有已连接终端时不显示右侧面板、边缘的展开 / 收起按钮。
 */
let root: string;
let ssh: TestSshServer;
let llm: LlmMock;

const CMD =
  'ssh -p 2222 -L 8848:10.20.0.39:8848 -L 8089:10.20.0.39:8089 -L 18083:10.20.1.4:18083 -L 15005:10.20.0.42:15005 -L 15003:10.20.0.42:15003 ' +
  '-L 14008:10.20.0.42:14008 -L 15008:10.20.0.42:15008 -L 17005:10.20.0.42:17005 -L 13000:10.20.0.42:13000 -L 19999:10.20.0.42:19999 ' +
  '-L 9999:10.20.0.42:9999 -L 16379:10.20.0.39:6379 -L 15601:10.20.0.39:15601 -L 5601:10.20.0.39:5601 root@10.10.0.90';

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
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

/** 连接主机：第一次连接时确认指纹，等到终端连上 */
async function connect(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId(`connect-${name}`).click();
  const dot = page.getByTestId(`tab-${name}`).locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 }).catch(async (e) => {
    await shot(page, `ui5-debug-connect-${name}`);
    throw e;
  });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui5-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('应用图标、浅色配色、主题色滚动条；没有已连接终端时不显示右侧面板，边缘按钮展开 / 收起', async () => {
  const { app, page } = await launch();
  // 第三十四轮起左上角没有应用名和图标（改为常驻图标栏）；应用图标在 设置 → 关于（CSP 下也能加载）
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-about').click();
  const logo = page.getByTestId('about-hero').getByTestId('app-logo');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
  // 滚动条颜色跟随主题（蓝色调）
  expect(await page.locator('.settings-nav').evaluate((el) => (globalThis as unknown as { getComputedStyle(e: unknown): { getPropertyValue(k: string): string } }).getComputedStyle(el).getPropertyValue('scrollbar-color'))).toContain('rgba(10, 132, 255');

  // 没有终端：没有右侧面板
  await call(page, 'host.create', {
    folderId: null, name: 'web-r', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
  });
  await page.reload();
  await page.getByTestId('nav-workspace').click();
  await expect(page.getByTestId('right-panel')).toHaveCount(0);
  await expect(page.getByTestId('right-edge-toggle')).toHaveCount(0);

  // 连接后出现右侧面板和边缘按钮
  await connect(page, 'web-r');
  await expect(page.getByTestId('right-panel')).toBeVisible();
  const edge = page.getByTestId('right-edge-toggle');
  await expect(edge).toBeVisible();
  await shot(page, 'ui5-01-right-panel-edge');
  await edge.click();
  await expect(page.getByTestId('right-expand')).toBeVisible();
  await expect(edge).toHaveClass(/closed/);
  await edge.click();
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await expect(edge).toHaveClass(/open/);

  // 浅色界面：参考 Claude 的近白色
  await call(page, 'setting.set', { key: 'ui.theme', value: 'light' });
  await page.reload();
  // 第二十六轮起窗口底色是外框色，页面在圆角卡片里
  await expect(page.locator('main.shell-frame')).toHaveCSS('background-color', 'rgb(252, 251, 250)');
  await page.getByTestId('nav-hosts').click();
  await shot(page, 'ui5-02-light');
  await call(page, 'setting.set', { key: 'ui.theme', value: 'dark' });
  await app.close();
});

test('AI 输入框：百分比在圆环中间，发送按钮在输入框里；回答没结束时排队发送（最多 5 条，可以删除）', async () => {
  const { app, page } = await launch();
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
  await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  // 单独运行时也有主机
  if (!(await call<{ name: string }[]>(page, 'host.list')).some((h) => h.name === 'web-r')) {
    await call(page, 'host.create', {
      folderId: null, name: 'web-r', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
    });
  }
  await page.reload();
  await connect(page, 'web-r');
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await page.getByTestId('right-ai').click();
  const panel = page.getByTestId('agent-panel');
  await panel.getByTestId('agent-new').click();
  await expect(panel.locator('.agent-input-box').getByTestId('agent-send')).toBeVisible();
  await expect(panel.getByTestId('context-ring').getByTestId('context-pct')).toContainText('%');

  // 第一条：写操作等批准，回答一直没结束
  llm.enqueue({ toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 't1', command: 'touch queue-flag', explanation: '创建标记' } }] }, { text: '第一条完成。' }, { text: '第二条的回答。' });
  const input = panel.getByTestId('agent-input');
  await input.fill('第一条：建个标记文件');
  await input.press('Enter');
  await expect(panel.getByTestId('approve')).toBeVisible();
  await expect(panel.getByTestId('agent-stop')).toBeVisible();

  // 回答没结束：Enter 放进排队；最多 5 条
  for (const t of ['第二条：看看负载', '第三条：不要了', '四', '五', '六']) {
    await input.fill(t);
    await input.press('Enter');
  }
  await expect(panel.getByTestId('queue-item')).toHaveCount(5);
  await input.fill('第七条');
  await input.press('Enter');
  await expect(page.locator('.ant-message')).toContainText('排队最多 5 条');
  await expect(panel.getByTestId('queue-item')).toHaveCount(5);
  await shot(page, 'ui5-03-queue');
  // 删掉后面 4 条，只留「第二条」
  for (let i = 0; i < 4; i++) await panel.getByTestId('queue-item').last().getByTestId('queue-remove').click();
  await expect(panel.getByTestId('queue-item')).toHaveCount(1);
  await expect(panel.getByTestId('queue-item')).toContainText('第二条：看看负载');
  await input.fill('');

  // 批准后第一条结束，排队的自动发送
  await panel.getByTestId('approve').click();
  await panel.getByTestId('approve-confirm').click({ timeout: 3000 }).catch(() => undefined);
  await expect(panel.getByText('第一条完成。')).toBeVisible();
  await expect(panel.getByText('第二条的回答。')).toBeVisible();
  await expect(panel.getByTestId('agent-queue')).toHaveCount(0);
  const sent = llm.requests.map((r) => JSON.stringify(r.body));
  expect(sent.some((b) => b.includes('第二条：看看负载'))).toBe(true);
  expect(sent.some((b) => b.includes('第三条：不要了'))).toBe(false);
  // 成功只用图标表示
  await expect(panel.getByTestId('step-icon').first()).toHaveAttribute('data-status', 'done');
  await expect(panel.getByTestId('step-status')).toHaveCount(0);
  await shot(page, 'ui5-04-after-queue');
  await app.close();
});

test('端口转发：从 ssh 命令导入（没有这台主机时新建），再生成同样的 ssh 命令', async () => {
  const { app, page } = await launch();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('import-hosts').click();
  await page.getByRole('menuitem', { name: /从文件导入/ }).click();
  await page.getByTestId('import-ssh-forward').click();
  await page.getByTestId('pf-import-text').fill(CMD);
  await expect(page.getByTestId('pf-import-host')).toContainText('没有找到 root@10.10.0.90:2222');
  await expect(page.getByTestId('pf-import-table').locator('.ant-table-row')).toHaveCount(14);
  await page.getByTestId('pf-import-name').fill('跳板 8.90');
  await shot(page, 'ui5-05-forward-import');
  await page.getByTestId('pf-import-ok').click();
  await expect(page.locator('.ant-message')).toContainText('导入了 14 条端口转发');
  // 导入后打开这台主机的端口转发管理
  const modal = page.locator('.ant-modal').filter({ hasText: '端口转发 · 跳板 8.90' });
  await expect(modal.locator('.ant-table-row')).toHaveCount(14);
  const host = (await call<{ name: string; address: string; port: number; username: string; authMethod: string }[]>(page, 'host.list')).find((h) => h.name === '跳板 8.90');
  expect(host).toMatchObject({ address: '10.10.0.90', port: 2222, username: 'root', authMethod: 'INTERACTIVE' });

  // 再导入一次：都已存在
  await modal.getByTestId('pf-import').click();
  await page.getByTestId('pf-import-text').fill(CMD);
  await expect(page.getByTestId('pf-import-host')).toContainText('导入到当前主机');
  await expect(page.getByTestId('pf-import-table')).toContainText('已存在');
  await expect(page.getByTestId('pf-import-ok')).toBeDisabled();
  await page.locator('.ant-modal').filter({ hasText: '从 ssh 命令导入端口转发' }).getByRole('button', { name: /取\s*消/ }).click();

  // 生成 ssh 命令：和导入的一样
  await modal.getByTestId('pf-export').click();
  await expect(page.getByTestId('pf-command')).toHaveText(CMD);
  await shot(page, 'ui5-06-forward-command');
  await app.close();
});
