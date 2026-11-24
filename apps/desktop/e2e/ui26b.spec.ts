import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { makeDocx } from '../test/support/docx';

/**
 * 第二十六轮（二）：SFTP 标签页的远端窗格和右侧文件面板一致、Agent / Ask 小按钮、@ 引用的知识库和 Tab、窄的 AI 面板不溢出、
 * MCP 权限滑块、笔记「导入」菜单（Word）、主机列表只留「连接」和「从分享码导入」、凭证「查看使用凭证的主机」、模型按钮没有悬停提示。
 */
let root: string;
let llm: LlmMock;
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
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'shots', `${name}.png`) });
}

async function prepare(page: Page): Promise<void> {
  if ((await call<unknown[]>(page, 'ai.providers.list')).length) return;
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: 'DeepSeek', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'deepseek-flash', contextWindow: 64000, maxOutput: 4096 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'deepseek-flash' } });
  await call(page, 'setting.set', { key: 'ui.theme', value: 'light' });
  const cred = await call<{ id: string }>(page, 'credential.save', { id: null, input: { type: 'PASSWORD', name: '运维账号', username: 'tester', secret: 'pw', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null } });
  const base = { folderId: null, address: '127.0.0.1', port: ssh.port, username: 'tester', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] };
  await call(page, 'host.create', { ...base, name: 'web26b', authMethod: 'PASSWORD', password: 'pw' });
  await call(page, 'host.create', { ...base, name: 'cred26b', authMethod: 'CREDENTIAL', credentialId: cred.id });
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
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui26b-'));
  mkdirSync(join(root, 'remote', 'logs'), { recursive: true });
  writeFileSync(join(root, 'remote', 'app.log'), 'remote log');
  mkdirSync(join(root, 'local'), { recursive: true });
  writeFileSync(join(root, 'local', 'up.txt'), 'from local');
  llm = await startLlmMock();
  ssh = await startTestSshServer({ root: join(root, 'remote'), username: 'tester', password: 'pw' });
});

test.afterAll(async () => {
  await llm?.close();
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('主机列表只有「连接」按钮（SFTP 在右键菜单）；导入菜单有「从分享码导入」（本地模式先登录）', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('connect-web26b')).toBeVisible();
  await expect(page.getByTestId('sftp-web26b')).toHaveCount(0);
  await page.getByTestId('connect-web26b').locator('xpath=ancestor::tr').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '打开 SFTP' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('import-hosts').click();
  await expect(page.getByRole('menuitem', { name: '从文件导入…' })).toBeVisible();
  await page.getByRole('menuitem', { name: '从分享码导入…' }).click();
  await expect(page.locator('.ant-modal-title').filter({ hasText: '登录 iTerminal' })).toBeVisible();
  await shot(page, 'ui26b-01-hosts');
  await app.close();
});

test('凭证管理：没有「显示主机专属凭证」开关；更多 → 查看使用凭证的主机', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('open-vault').click();
  await expect(page.getByText('显示主机专属凭证')).toHaveCount(0);
  await page.getByTestId('credential-more-运维账号').click();
  await page.getByRole('menuitem', { name: '查看使用凭证的主机' }).click();
  await expect(page.getByTestId('credential-used-by')).toContainText('cred26b');
  await expect(page.getByTestId('credential-used-by')).toContainText('直接使用');
  await shot(page, 'ui26b-02-used-by');
  await page.getByTestId('used-by-host').click();
  await expect(page.getByTestId('host-name')).toHaveValue('cred26b');
  await app.close();
});

test('SFTP 标签页：远端窗格就是右侧的文件面板（右键菜单、新建文件）；上传、下载到左边的本地目录', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await connect(page, 'web26b');
  await page.getByTestId('open-sftp-from-tab').click();
  const remote = page.getByTestId('pane-remote');
  await expect(remote.getByTestId('panel-file-app.log')).toBeVisible({ timeout: 15_000 });
  // 和右侧面板一样的工具栏，但没有「与终端目录同步」
  await expect(remote.getByTestId('fp-mkdir')).toBeVisible();
  await expect(remote.getByTestId('file-panel-follow')).toHaveCount(0);
  await remote.getByTestId('file-panel-list').click({ button: 'right', position: { x: 200, y: 200 } });
  await expect(page.locator('.ant-dropdown:not(.ant-dropdown-hidden)').getByRole('menuitem', { name: /新建文件$/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // 本地窗格定位到测试目录：上传
  await page.getByTestId('path-local').fill(join(root, 'local'));
  await page.getByTestId('path-local').press('Enter');
  await page.getByTestId('file-local-up.txt').click();
  await page.getByTestId('transfer-local').click();
  await expect(remote.getByTestId('panel-file-up.txt')).toBeVisible({ timeout: 15_000 });
  expect(readFileSync(join(root, 'remote', 'up.txt'), 'utf8')).toBe('from local');

  // 远端选中后「下载」：放到左边的本地目录
  await remote.getByTestId('panel-file-app.log').click();
  await remote.getByTestId('file-panel-download').click();
  await expect.poll(() => existsSync(join(root, 'local', 'app.log')), { timeout: 15_000 }).toBe(true);
  await expect(page.getByTestId('file-local-app.log')).toBeVisible();
  await shot(page, 'ui26b-03-sftp');
  await app.close();
});

test('AI 面板：Agent / Ask 一个小按钮；@ 弹窗有知识库，Tab 只在分类之间切换；窄面板里发送按钮不出界；模型按钮没有悬停提示', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await connect(page, 'web26b');
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  const mode = side.getByTestId('agent-mode');
  await expect(mode).toHaveAttribute('data-mode', 'agent');
  // 第二十六轮起是下拉菜单
  await mode.click();
  await page.getByTestId('agent-mode-ask').click();
  await expect(mode).toHaveAttribute('data-mode', 'ask');
  await expect(side.getByTestId('agent-input')).toHaveAttribute('placeholder', /Ask 模式/);
  await mode.click();
  await page.getByTestId('agent-mode-agent').click();
  await expect(mode).toHaveAttribute('data-mode', 'agent');
  // 合成一个按钮（第二十六轮）：选 Agent 后面板留着，下面接着是权限
  await expect(page.getByTestId('chat-policy-panel').getByRole('menuitemradio')).toHaveCount(4);
  await page.keyboard.press('Escape');

  // 模型按钮：悬停不显示提示
  await side.getByTestId('agent-model').hover();
  await page.waitForTimeout(900);
  await expect(page.locator('.ant-tooltip:visible')).toHaveCount(0);

  // @：分类里有知识库；Tab / Shift+Tab 只在分类之间切换，焦点留在输入框
  const input = side.getByTestId('agent-input');
  await input.click();
  await input.pressSequentially('@');
  await expect(page.getByTestId('mention-popup')).toBeVisible();
  await expect(page.getByTestId('mention-cat-知识库')).toBeVisible();
  const cats = ['全部', '主机', '数据库', '知识库', '分组', 'Skill', '笔记', 'MCP'];
  for (let i = 1; i <= 9; i++) {
    await input.press('Tab');
    await expect(page.getByTestId(`mention-cat-${cats[i % cats.length]}`)).toHaveAttribute('data-active', '1');
    await expect(input).toBeFocused();
  }
  await input.press('Shift+Tab');
  await expect(page.getByTestId('mention-cat-全部')).toHaveAttribute('data-active', '1');
  await page.getByTestId('mention-cat-知识库').click();
  await expect(page.getByTestId('mention-popup')).toContainText('登录后');
  await input.press('Escape');

  // 把右侧面板拖到最窄：底栏收起文字，发送按钮仍在输入框里
  const bar = page.locator('.workspace-split > .ant-splitter-bar').first();
  const b = (await bar.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + 200);
  await page.mouse.down();
  await page.mouse.move(b.x + 900, b.y + 200, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const box = (await side.locator('.agent-input-box.composer').boundingBox())!;
  const send = (await side.locator('.composer-bar .agent-send').last().boundingBox())!;
  expect(box.width).toBeLessThan(330);
  expect(send.x + send.width).toBeLessThanOrEqual(box.x + box.width - 2);
  await expect(side.locator('.composer-mode-text')).toBeHidden();
  await shot(page, 'ui26b-04-side-narrow');
  await app.close();
});

test('MCP 权限是三档滑块：允许高危指令就同时允许写操作；调回只读两项都关', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-ext').click();
  await page.getByTestId('settings-tab-mcp').click();
  const get = async (): Promise<[boolean, boolean]> => {
    const s = await call<Record<string, unknown>>(page, 'setting.getAll');
    return [!!s['mcp.server.allowWrite'], !!s['mcp.server.allowDanger']];
  };
  await page.getByTestId('mcp-allow-danger').click();
  await page.getByRole('button', { name: '允许' }).click();
  await expect.poll(get).toEqual([true, true]);
  await shot(page, 'ui26b-05-mcp');
  await page.getByTestId('mcp-allow-write').click();
  await expect.poll(get).toEqual([true, false]);
  await page.getByTestId('mcp-perm-read').click();
  await expect.poll(get).toEqual([false, false]);
  await app.close();
});

test('笔记：「导入」菜单——Markdown、Word（.docx 转成 Markdown）、从分享码导入', async () => {
  const { app, page } = await launch();
  await prepare(page);
  const docx = join(root, '发布手册.docx');
  writeFileSync(docx, await makeDocx());
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, docx);
  await page.getByTestId('nav-notes').click();
  await expect(page.getByTestId('note-import')).toHaveText('导入');
  await page.getByTestId('note-import').click();
  await expect(page.getByRole('menuitem', { name: /导入 Markdown/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '从分享码导入…' })).toBeVisible();
  await page.getByRole('menuitem', { name: /导入 Word/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已导入 1 篇笔记');
  await expect(page.getByTestId('note-item-发布手册')).toBeVisible();
  const notes = await call<{ notes: { title: string; content: string }[] }>(page, 'note.list');
  const n = notes.notes.find((x) => x.title === '发布手册')!;
  expect(n.content).toContain('先执行 **备份**');
  expect(n.content).toContain('| web-01 | 22 |');
  await shot(page, 'ui26b-06-notes-import');
  await app.close();
});
