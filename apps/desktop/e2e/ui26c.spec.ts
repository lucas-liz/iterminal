import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 第二十六轮（三）：表单弹窗不超过窗口、凭证「使用的主机」里打开主机编辑框在最上层、最近连接时间、终端里一行执行结果、
 * AI 会话列表（执行中转圈、悬停不抖）、Agent 记忆、分组树图标对齐、笔记 / 指令集的右键菜单。
 */
let root: string;
let llm: LlmMock;
let ssh: TestSshServer;

test.describe.configure({ mode: 'serial' });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // 上一个用例停在中途时剩下的剧本不留给下一个用例
  llm?.clear();
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 760));
  return { app, page };
}

/** e2e 的 tsconfig 没有 DOM 类型 */
type Css = { getComputedStyle(e: unknown): { overflowY: string; zIndex: string } };
type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(join(__dirname, '..', 'test-results', 'shots'), { recursive: true });
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'shots', `${name}.png`) });
}

async function prepare(page: Page): Promise<void> {
  if ((await call<unknown[]>(page, 'ai.providers.list')).length) return;
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: 'Mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 4096 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
  await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  await call(page, 'setting.set', { key: 'ui.theme', value: 'light' });
  const cred = await call<{ id: string }>(page, 'credential.save', { id: null, input: { type: 'PASSWORD', name: '共享账号', username: 'tester', secret: 'pw', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null } });
  const base = { folderId: null, address: '127.0.0.1', port: ssh.port, username: 'tester', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] };
  await call(page, 'host.create', { ...base, name: 'web26c', authMethod: 'PASSWORD', password: 'pw' });
  await call(page, 'host.create', { ...base, name: 'cred26c', authMethod: 'CREDENTIAL', credentialId: cred.id });
  await call(page, 'snippet.save', { id: null, input: { name: '看磁盘', content: 'df -h', groupId: null, description: null, tags: [] } });
  await call(page, 'note.save', { id: null, input: { title: '值班手册', content: '# 值班\n检查告警', groupId: null } });
  await page.reload();
}

async function connect(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId(`connect-${name}`).click();
  const dot = page.getByTestId(`tab-${name}`).locator('.status-dot');
  await Promise.race([page.getByRole('button', { name: '信任并连接' }).click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui26c-'));
  mkdirSync(join(root, 'remote'), { recursive: true });
  llm = await startLlmMock();
  ssh = await startTestSshServer({ root: join(root, 'remote'), username: 'tester', password: 'pw' });
});

test.afterAll(async () => {
  await llm?.close();
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('新建主机的弹窗不超过窗口高度（内容区滚动）；分组树的图标和名称对齐', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  // 分组树：图标和名称的垂直中心对齐
  const icon = (await page.locator('.folder-tree .ant-tree-iconEle').first().boundingBox())!;
  const name = (await page.getByTestId('folder-all').boundingBox())!;
  expect(Math.abs(icon.y + icon.height / 2 - (name.y + name.height / 2))).toBeLessThanOrEqual(1.5);

  await page.getByTestId('new-host').click();
  await page.locator('.ant-collapse-header').filter({ hasText: 'AI' }).click().catch(() => undefined);
  const modal = page.locator('.ant-modal-container').filter({ has: page.getByTestId('host-name') });
  await expect(modal).toBeVisible();
  const box = (await modal.boundingBox())!;
  const vh = await page.evaluate(() => (globalThis as unknown as { innerHeight: number }).innerHeight);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vh);
  const body = modal.locator('.ant-modal-body');
  expect(await body.evaluate((el) => (globalThis as unknown as Css).getComputedStyle(el).overflowY)).toBe('auto');
  await shot(page, 'ui26c-01-host-modal');
  await app.close();
});

test('凭证：查看使用凭证的主机 → 点主机，编辑框盖在列表上面；关掉编辑框回到列表', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('open-vault').click();
  await page.getByTestId('credential-more-共享账号').click();
  await page.getByRole('menuitem', { name: '查看使用凭证的主机' }).click();
  await page.getByTestId('used-by-host').click();
  await expect(page.getByTestId('host-name')).toHaveValue('cred26c');
  const z = async (sel: string): Promise<number> =>
    Number(await page.locator('.ant-modal-wrap').filter({ has: page.locator(sel) }).last().evaluate((el) => (globalThis as unknown as Css).getComputedStyle(el).zIndex));
  expect(await z('[data-testid="host-name"]')).toBeGreaterThan(await z('[data-testid="credential-used-by"]'));
  // 编辑框真的在最上层：点它的输入框不会被列表挡住
  await page.getByTestId('host-name').click();
  await shot(page, 'ui26c-02-used-by-editor');
  await page.locator('.ant-modal-wrap').filter({ has: page.getByTestId('host-name') }).getByRole('button', { name: '取消' }).click();
  await expect(page.getByTestId('host-name')).toHaveCount(0);
  await expect(page.getByTestId('credential-used-by')).toBeVisible();
  await app.close();
});

test('最近连接：开始连接就更新；Agent 执行命令后终端里只显示一行结果', async () => {
  const { app, page } = await launch();
  await prepare(page);
  const before = (await call<{ name: string; lastConnectedAt: number | null }[]>(page, 'host.list')).find((h) => h.name === 'web26c')!.lastConnectedAt ?? 0;
  await connect(page, 'web26c');
  const after = (await call<{ name: string; lastConnectedAt: number | null }[]>(page, 'host.list')).find((h) => h.name === 'web26c')!.lastConnectedAt ?? 0;
  expect(after).toBeGreaterThan(before);
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('connect-web26c').locator('xpath=ancestor::tr')).toContainText('刚刚');

  // 右侧 AI：Agent 在这个终端上执行一条只读命令
  await page.getByTestId('nav-workspace').click();
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  // 终端用 WebGL 绘制，DOM 里没有文字：直接收集推给终端的数据
  await page.evaluate(() => {
    const w = globalThis as unknown as { itm: { on(e: string, f: (p: { data: string }) => void): void }; __echo: string[] };
    w.__echo = [];
    w.itm.on('session.data', (p) => w.__echo.push(p.data));
  });
  llm.enqueue({ toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 't1', command: 'echo echo-26c', explanation: '测试' } }] }, { text: '完成' });
  await side.getByTestId('agent-input').fill('执行一下');
  await side.getByTestId('agent-send').click();
  await expect(side.getByText('完成')).toBeVisible({ timeout: 15_000 });
  const echoed = (): Promise<string> => page.evaluate(() => (globalThis as unknown as { __echo: string[] }).__echo.join('').replace(/\x1b\[[0-9;]*m/g, ''));
  await expect.poll(echoed).toContain('✦ Agent 执行：echo echo-26c');
  await expect.poll(echoed).toMatch(/✦ Agent 执行成功 · \d+\.\ds/);
  await shot(page, 'ui26c-03-echo');
  await app.close();
});

test('AI 对话模式：执行中的对话转圈；悬停列表项时标题宽度不变（不抖动）', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('mode-ai').click();
  const ai = page.getByTestId('agent-page-panel');
  await ai.getByTestId('agent-new').click();
  // 一条需要批准的写命令：对话停在等待批准，一直在执行中
  llm.enqueue({ toolCalls: [{ id: 'w1', name: 'run_command', input: { host: 'h1', command: 'touch /tmp/itm-26c', explanation: '写文件' } }] }, { text: '好了' });
  const input = ai.getByTestId('agent-input');
  await input.click();
  await input.pressSequentially('@cred26c');
  await expect(page.getByTestId('mention-item').first()).toContainText('cred26c');
  await input.press('Enter');
  await input.pressSequentially('写个文件');
  await ai.getByTestId('agent-send').click();
  await expect(page.getByTestId('ai-conv-running')).toBeVisible({ timeout: 15_000 });
  await shot(page, 'ui26c-04-running');
  await ai.getByTestId('agent-stop').click();
  await expect(page.getByTestId('ai-conv-running')).toHaveCount(0, { timeout: 15_000 });

  const item = page.getByTestId('ai-conv-item').first();
  const title = item.locator('.ai-conv-title');
  const w0 = (await title.boundingBox())!.width;
  await item.hover();
  await expect(item.getByTestId('ai-conv-del')).toHaveCSS('opacity', '1');
  expect((await title.boundingBox())!.width).toBe(w0);
  await app.close();
});

test('主机编辑框：手工的主机记忆旁边是「Agent 记忆」，可以新增、修改、删除', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('more-web26c').click();
  await page.getByRole('menuitem', { name: /^edit 编辑/ }).click();
  await expect(page.getByTestId('host-name')).toHaveValue('web26c');
  await page.locator('.ant-collapse-header').filter({ hasText: 'AI' }).click();
  await page.getByTestId('agent-memory-open').click();
  await expect(page.getByTestId('agent-memory-modal')).toContainText('还没有 Agent 记下的记忆');
  await page.getByTestId('agent-memory-add').click();
  await page.getByTestId('agent-memory-input').fill('nginx 只能 reload');
  await page.getByTestId('agent-memory-save').click();
  await expect(page.getByTestId('agent-memory-item')).toHaveCount(1);
  await page.getByTestId('agent-memory-edit').click();
  await page.getByTestId('agent-memory-input').fill('nginx 只能 reload，不要 restart');
  await page.getByTestId('agent-memory-save').click();
  await expect(page.getByTestId('agent-memory-item')).toContainText('不要 restart');
  await shot(page, 'ui26c-05-agent-memory');
  await page.locator('.ant-modal-wrap').filter({ has: page.getByTestId('agent-memory-modal') }).locator('.ant-modal-close').click();
  await expect(page.getByTestId('agent-memory-open')).toHaveText(/Agent 记忆（1）/);
  await app.close();
});

test('指令集、笔记：分组和列表都有右键菜单', async () => {
  const { app, page } = await launch();
  await prepare(page);
  const menu = page.locator('.ant-dropdown:not(.ant-dropdown-hidden)');
  // 指令集：命令右键 → 复制命令
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-snippets').click();
  await page.getByTestId('snippet-row-看磁盘').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: /编辑$/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /移动到/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /复制命令/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已复制');
  // 分组右键 → 新建命令
  await page.getByTestId('snippet-group-all').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /新建命令/ }).click();
  await expect(page.locator('.ant-modal-title').filter({ hasText: /命令/ })).toBeVisible();
  await page.locator('.ant-modal-wrap').filter({ has: page.locator('.ant-modal-title').filter({ hasText: /命令/ }) }).getByRole('button', { name: /取\s*消/ }).click();
  await expect(page.locator('.ant-modal-title').filter({ hasText: /命令/ })).toHaveCount(0);

  // 笔记：笔记右键 → 置顶；列表空白处 → 新建笔记
  await page.getByTestId('nav-notes').click();
  await page.getByTestId('note-item-值班手册').click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /置顶/ }).click();
  await expect(page.getByTestId('note-item-值班手册').locator('.anticon-pushpin')).toBeVisible();
  await page.locator('.note-list').click({ button: 'right', position: { x: 60, y: 300 } });
  await shot(page, 'ui26c-06-note-menu');
  await menu.getByRole('menuitem', { name: /新建笔记/ }).click();
  await expect(page.getByTestId('note-item-新笔记')).toBeVisible();
  // 分组的右键菜单：新建分组
  await page.getByTestId('note-group-none').click({ button: 'right' });
  await expect(menu.getByRole('menuitem', { name: /新建分组/ })).toBeVisible();
  await app.close();
});

test('AI：往上翻出现「回到底部」按钮（执行中外圈转动）；输入框下面有提示要人工审核', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await connect(page, 'web26c');
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  await expect(side.getByTestId('agent-disclaimer')).toContainText('请勿完全相信');
  // 一条要跑几秒的只读命令：执行中不再显示三个点（第二十六轮五）
  const long = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行`).join('\n\n');
  llm.enqueue({ toolCalls: [{ id: 's1', name: 'run_command', input: { host: 't1', command: 'sleep 3', explanation: '等一会' } }] }, { text: `完成。\n\n${long}` });
  await side.getByTestId('agent-input').fill('等一下');
  await side.getByTestId('agent-send').click();
  await expect(side.getByTestId('agent-stop')).toBeVisible({ timeout: 10_000 });
  await expect(side.getByTestId('agent-typing')).toHaveCount(0);
  await expect(side.getByText('第 60 行')).toBeVisible({ timeout: 20_000 });
  // 停在底部时没有按钮；往上翻出现，点一下回到底部
  await expect(side.getByTestId('agent-to-bottom')).toHaveCount(0);
  await side.locator('.agent-list').evaluate((el) => ((el as unknown as { scrollTop: number }).scrollTop = 0));
  await expect(side.getByTestId('agent-to-bottom')).toBeVisible();
  await shot(page, 'ui26c-08-to-bottom');
  await side.getByTestId('agent-to-bottom').click();
  await expect(side.getByText('第 60 行')).toBeInViewport();
  await expect(side.getByTestId('agent-to-bottom')).toHaveCount(0);
  await app.close();
});
