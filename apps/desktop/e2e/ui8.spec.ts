import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第八轮：编辑框不残留上次的内容、排序列不变色、AI 对话模式的布局（顶部入口、右侧上下文）、
 * 切换模式不重复发送、新终端用新对话、代码块 / 自己的消息可以复制、笔记撤回和 Agent 笔记工具、快捷键、存储位置、打包下载。
 */
let root: string;
let downloads: string;
let ssh: TestSshServer;
let llm: LlmMock;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ app: a }, dir) => a.setPath('downloads', dir), downloads);
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);
const clipboard = (app: ElectronApplication): Promise<string> => app.evaluate(({ clipboard: c }) => c.readText());

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(join(__dirname, '..', 'test-results', 'shots'), { recursive: true });
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'shots', `${name}.png`) });
}

async function typeLine(page: Page, testId: string, text: string): Promise<void> {
  await page.getByTestId(testId).locator('.xterm').click();
  await page.keyboard.type(text, { delay: 15 });
  await page.keyboard.press('Enter');
}

async function connect(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId(`connect-${name}`).click();
  const dot = page.getByTestId(`tab-${name}`).locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
}

/** 模型服务和一台主机（单独运行某个用例时也有） */
async function prepare(page: Page): Promise<void> {
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
    await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  }
  if (!(await call<{ name: string }[]>(page, 'host.list')).some((h) => h.name === 'web8')) {
    await call(page, 'host.create', {
      folderId: null, name: 'web8', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
    });
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui8-'));
  downloads = join(root, 'downloads');
  mkdirSync(downloads);
  mkdirSync(join(root, 'remote', 'pack-me', 'sub'), { recursive: true });
  writeFileSync(join(root, 'remote', 'pack-me', 'a.txt'), 'hello');
  writeFileSync(join(root, 'remote', 'pack-me', 'sub', 'b.txt'), 'world');
  ssh = await startTestSshServer({ root: join(root, 'remote'), sftpRealPaths: true });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('编辑框每次打开都是这一条的内容（指令集、凭证）；主机列表排序后那一列不变色', async () => {
  const { app, page } = await launch();
  await call(page, 'snippet.save', { id: null, input: { groupId: null, name: 'snip-a', content: 'echo a' } });
  await call(page, 'snippet.save', { id: null, input: { groupId: null, name: 'snip-b', content: 'echo b' } });
  await page.reload();
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-snippets').click();
  await page.getByTestId('snippet-row-snip-a').dblclick();
  await expect(page.getByTestId('snippet-name')).toHaveValue('snip-a');
  await page.getByRole('button', { name: /取\s*消/ }).click();
  await page.getByTestId('snippet-row-snip-b').dblclick();
  // 第一次打开就是 B（之前要点第二次）
  expect(await page.getByTestId('snippet-name').inputValue()).toBe('snip-b');
  expect(await page.getByTestId('snippet-content').inputValue()).toBe('echo b');
  await page.getByRole('button', { name: /取\s*消/ }).click();
  await page.getByTestId('snippet-new').click();
  expect(await page.getByTestId('snippet-name').inputValue()).toBe('');
  expect(await page.getByTestId('snippet-content').inputValue()).toBe('');
  await page.getByRole('button', { name: /取\s*消/ }).click();

  // 凭证：先编辑一个，再新建
  await call(page, 'credential.save', { id: null, input: { type: 'PASSWORD', name: 'cred-a', username: 'alice', secret: 'x', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null } });
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByRole('button', { name: '凭证管理' }).click();
  await page.getByTestId('credential-more-cred-a').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  expect(await page.getByTestId('credential-name').inputValue()).toBe('cred-a');
  await page.getByRole('button', { name: /取\s*消/ }).last().click();
  await page.getByTestId('new-credential').click();
  await page.getByRole('menuitem').first().click();
  expect(await page.getByTestId('credential-name').inputValue()).toBe('');
  expect(await page.getByTestId('credential-username').inputValue()).toBe('');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // 主机列表：按名称排序后，排序列的单元格仍然是透明背景
  await prepare(page);
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.locator('.ant-table-column-sorters').first().click();
  await expect(page.locator('td.ant-table-column-sort').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await app.close();
});

test('AI 对话模式：顶部入口、右侧上下文；代码块和自己的消息可以复制；切换模式不重复发送；第一个终端用新对话', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  // 从主机页切到 AI 对话，再切回终端模式：回到主机页（不是固定跳到「终端」）
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('mode-terminal').click();
  await expect(page.getByTestId('nav-hosts')).toHaveClass(/active/);
  await expect(page.getByTestId('mode-terminal')).toHaveClass(/on/);
  await page.getByTestId('mode-ai').click();
  // 第三十四轮：AI 模式左侧图标栏第一个是 AI 对话，不显示主机；笔记、运维审计、批量执行、设置打开后仍然是 AI 模式
  await expect(page.getByTestId('nav-ai')).toBeVisible();
  await expect(page.getByTestId('nav-hosts')).toHaveCount(0);
  await page.getByTestId('nav-notes').click();
  await expect(page.getByTestId('nav-notes')).toHaveClass(/active/);
  await expect(page.getByTestId('mode-ai')).toHaveClass(/on/);
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await expect(page.getByTestId('settings-nav-general')).toBeVisible();
  await page.getByTestId('nav-batch').click();
  await expect(page.getByTestId('batch-exec-compose')).toBeVisible();
  await expect(page.getByTestId('mode-ai')).toHaveClass(/on/);
  await page.getByTestId('nav-ai').click();
  await page.getByTestId('ai-page-new').click();
  const panel = page.getByTestId('agent-page-panel');
  await expect(panel).toBeVisible();

  // 新对话：图标和标题在中间，没有说明文字
  await expect(panel.getByTestId('agent-hello')).toHaveText('iTerminal 运维助手');
  // 输入框：没有单独的图片 / 文件工具行，左下角的 + 里可以添加文件和引用
  await expect(panel.getByTestId('image-add')).toHaveCount(0);
  await panel.getByTestId('refs-expand').click();
  await expect(page.getByTestId('composer-add-file')).toBeVisible();
  await expect(page.getByTestId('refs-panel')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'ui8-08-composer-plus');
  await page.keyboard.press('Escape');
  // 引用在右侧的上下文面板（只展示）；第十二轮起输入框上方也有引用行
  await expect(panel.getByTestId('agent-context')).toBeVisible();
  await expect(panel.getByTestId('ctx-empty')).toBeVisible();
  await expect(panel.locator('.agent-refs-bar')).toHaveCount(1);
  await panel.getByTestId('agent-ctx-toggle').click();
  await expect(panel.getByTestId('agent-context')).toHaveCount(0);
  await panel.getByTestId('agent-ctx-toggle').click();
  await expect(panel.getByTestId('agent-context')).toBeVisible();

  // 代码块复制、自己的消息复制
  llm.enqueue({ text: '可以这样看：\n\n```sh\ndf -h /var\n```\n' });
  await panel.getByTestId('agent-input').fill('旧问题：磁盘');
  await panel.getByTestId('agent-input').press('Enter');
  await expect(panel.getByTestId('code-block')).toContainText('df -h /var');
  await expect(panel.getByTestId('code-block')).toContainText('shell');
  await panel.getByTestId('code-copy').click();
  await expect.poll(() => clipboard(app)).toBe('df -h /var');
  await panel.getByTestId('agent-user-msg').hover();
  await panel.getByTestId('user-msg-copy').click();
  await expect.poll(() => clipboard(app)).toBe('旧问题：磁盘');
  await shot(page, 'ui8-01-ai-mode');

  // 回到终端模式，连接第一个终端：右侧 AI 是新对话
  await page.getByTestId('mode-terminal').click();
  await connect(page, 'web8');
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  await expect(side).toBeVisible();
  await expect(side.getByTestId('agent-user-msg')).toHaveCount(0);
  // 终端页右侧的 AI 面板也是圆角输入框，左下角 +
  await expect(side.locator('.composer-bar').getByTestId('refs-expand')).toBeVisible();
  await expect(side.getByTestId('image-add')).toHaveCount(0);
  // 新对话：中间只有图标和标题
  await expect(side.getByTestId('agent-hello')).toHaveText('iTerminal 运维助手');
  await shot(page, 'ui8-09-side-composer');

  // 终端里 # 提问：发送一次；之后来回切换模式不会重新发送
  llm.enqueue({ text: '回答一' });
  await typeLine(page, 'xterm-tab-1', '#你好');
  await expect(side.getByText('回答一')).toBeVisible();
  const sent = llm.requests.length;
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('mode-ai').click();
    await expect(page.getByTestId('agent-page-panel')).toBeVisible();
    await page.getByTestId('mode-terminal').click();
    await expect(side).toBeVisible();
  }
  await page.waitForTimeout(1000);
  expect(llm.requests.length).toBe(sent);
  const [latest] = await call<{ id: string }[]>(page, 'agent.list');
  const view = await call<{ messages: { role: string; text: string }[] }>(page, 'agent.get', { id: latest.id });
  expect(view.messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['你好']);

  // 已经有终端时再开一个：沿用当前对话（先把鼠标移开，模式切换的提示会挡住导航）
  await page.mouse.move(900, 600);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('open-local').click();
  await expect(side.getByText('回答一')).toBeVisible();
  await app.close();
});

test('笔记：Agent 新建 / 修改笔记，笔记页刷新并可以撤回上一个版本', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('ai-page-new').click();
  const panel = page.getByTestId('agent-page-panel');
  llm.enqueue(
    { toolCalls: [{ id: 'n1', name: 'note_save', input: { title: '发布手册', content: '# 发布\n1. 打包', explanation: '记录发布步骤' } }] },
    { toolCalls: [{ id: 'n2', name: 'note_save', input: { note: '发布手册', content: '# 发布\n1. 打包\n2. 灰度', explanation: '补充灰度' } }] },
    { text: '已经记好了' },
  );
  await panel.getByTestId('agent-input').fill('把发布步骤记成笔记');
  await panel.getByTestId('agent-input').press('Enter');
  await expect(panel.getByText('已经记好了')).toBeVisible();
  await expect(panel.getByTestId('step-diff').last()).toContainText('+2. 灰度');

  // AI 模式里打开笔记页：能看到 Agent 改过的内容，撤回到修改前
  await page.getByTestId('nav-notes').click();
  await page.getByTestId('note-item-发布手册').click();
  await expect(page.locator('.note-preview')).toContainText('灰度');
  await page.getByTestId('note-revert').click();
  await page.getByRole('button', { name: '撤回', exact: true }).last().click();
  await expect(page.locator('.note-preview')).not.toContainText('灰度');
  await expect(page.locator('.note-preview')).toContainText('打包');
  // 再撤回一次回到修改后
  await page.getByTestId('note-revert').click();
  await page.getByRole('button', { name: '撤回', exact: true }).last().click();
  await expect(page.locator('.note-preview')).toContainText('灰度');
  await shot(page, 'ui8-02-notes');
  await app.close();
});

test('快捷键：修改「切换终端 / AI 对话」后用新的组合键切换，可以恢复默认', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();
  await page.getByTestId('settings-tab-shortcuts').click();
  await page.getByTestId('shortcut-edit-toggleMode').click();
  await expect(page.getByTestId('shortcut-recording')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+K');
  await expect(page.getByTestId('shortcut-value-toggleMode')).toHaveText(process.platform === 'darwin' ? '⌘⇧K' : 'Ctrl+Shift+K');
  await shot(page, 'ui8-03-shortcuts');
  await page.getByTestId('nav-hosts').click();
  // 旧的组合键不再生效，新的生效
  await page.keyboard.press('ControlOrMeta+Shift+A');
  await expect(page.getByTestId('ai-page')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+K');
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+K');
  await expect(page.getByTestId('ai-page')).toHaveCount(0);
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();
  await page.getByTestId('settings-tab-shortcuts').click();
  await page.getByTestId('shortcut-default-toggleMode').click();
  await expect(page.getByTestId('shortcut-value-toggleMode')).toHaveText(process.platform === 'darwin' ? '⌘⇧A' : 'Ctrl+Shift+A');
  await app.close();
});

test('存储位置：显示占用空间；笔记保存为 Markdown 文件；录像目录可以更换', async () => {
  const { app, page } = await launch();
  await call(page, 'note.save', { id: null, input: { groupId: null, title: '值班表', content: '周一：张三' } });
  const notesDir = join(root, 'my-notes');
  const r = await call<{ exported: number }>(page, 'storage.setNotesDir', { dir: notesDir });
  expect(r.exported).toBeGreaterThanOrEqual(1);
  expect(readFileSync(join(notesDir, '值班表.md'), 'utf8')).toBe('周一：张三\n');
  const recDir = join(root, 'my-recordings');
  await call(page, 'storage.setRecordingsDir', { dir: recDir, move: true });
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-storage').click();
  await expect(page.getByTestId('storage-usage')).toBeVisible();
  await expect(page.getByTestId('storage-notes-dir')).toHaveText(notesDir);
  await expect(page.getByTestId('storage-rec-dir')).toHaveText(recDir);
  await expect(page.getByTestId('storage-data-dir')).toHaveText(join(root, 'userData'));
  await shot(page, 'ui8-04-storage');
  // 在笔记页修改后文件跟着变
  await page.getByTestId('nav-notes').click();
  await page.getByTestId('note-item-值班表').click();
  await page.locator('.note-preview').dblclick();
  await page.getByTestId('note-content').fill('周一：李四');
  await expect.poll(() => readFileSync(join(notesDir, '值班表.md'), 'utf8'), { timeout: 5000 }).toBe('周一：李四\n');
  await call(page, 'storage.setNotesDir', { dir: '' });
  await call(page, 'storage.setRecordingsDir', { dir: '', move: true });
  await app.close();
});

test('文件管理：目录可以直接下载，也可以在服务器上压缩后打包下载（临时压缩包会删除）', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web8');
  // 右侧文件面板：进到测试目录（测试服务器的 SFTP 根目录是本机的 /），目录的右键菜单（第十六轮：下载 / 下载到… / 打包下载（tar.gz））
  await page.getByTestId('right-files').click();
  await page.getByTestId('file-panel-path-edit').click();
  await page.getByTestId('file-panel-path').fill(join(root, 'remote'));
  await page.getByTestId('file-panel-path').press('Enter');
  const dirRow = page.getByTestId('panel-file-pack-me');
  await expect(dirRow).toBeVisible();
  // 菜单项的名称前面带着图标名（「download 下载」），「下载」只匹配结尾，不和「下载到…」「打包下载（tar.gz）」混淆
  const downloadItem = page.getByRole('menuitem', { name: /(^|\s)下载$/ });
  const openMenu = async (): Promise<void> => {
    await dirRow.click({ button: 'right' });
    await expect(downloadItem).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '下载到…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '打包下载（tar.gz）' })).toBeVisible();
  };

  // 打包下载：在服务器上压成 /tmp/itm-archive-XXXX/pack-me.tar.gz，下载到「下载」目录，下载完删除这个临时目录
  const archives = (): string[] => readdirSync('/tmp').filter((n) => n.startsWith('itm-archive-'));
  const before = new Set(archives());
  const created = new Set<string>();
  const watcher = watch('/tmp', (_e, f) => f?.startsWith('itm-archive-') && !before.has(f) && created.add(f));
  const local = join(downloads, 'pack-me.tar.gz');
  try {
    await openMenu();
    await page.getByRole('menuitem', { name: '打包下载（tar.gz）' }).click();
    // 下载前二次确认
    await expect(page.locator('.ant-modal-confirm-title')).toHaveText('打包下载「pack-me」？');
    await page.getByTestId('fp-download-ok').click();
    await expect.poll(() => existsSync(local) && archives().every((n) => before.has(n)), { timeout: 15_000 }).toBe(true);
  } finally {
    watcher.close();
  }
  expect(created.size).toBeGreaterThan(0);
  for (const d of created) expect(existsSync(join('/tmp', d))).toBe(false);
  const listing = execFileSync('tar', ['-tzf', local], { encoding: 'utf8' });
  expect(listing).toContain('pack-me/a.txt');
  expect(listing).toContain('pack-me/sub/b.txt');

  // 整个目录直接下载
  await openMenu();
  await downloadItem.click();
  await expect(page.locator('.ant-modal-confirm-content')).toContainText('会连同里面的内容一起下载');
  await page.getByTestId('fp-download-ok').click();
  await expect.poll(() => (existsSync(join(downloads, 'pack-me', 'sub', 'b.txt')) ? readFileSync(join(downloads, 'pack-me', 'sub', 'b.txt'), 'utf8') : ''), { timeout: 15_000 }).toBe('world');
  expect(readdirSync(join(downloads, 'pack-me')).sort()).toEqual(['a.txt', 'sub']);
  await app.close();
});

test('次级侧栏可以收起（第三十四轮：顶部栏左侧按钮）：主机、AI 会话列表都生效，记在本机，快捷键也可以；新建终端在标签行', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('sider-collapse').click();
  await expect(page.locator('.collapsible-sider.is-collapsed')).toHaveCount(1);
  await expect(page.getByTestId('sider-expand')).toBeVisible();
  await shot(page, 'ui8-05-collapsed-hosts');
  // 终端页没有次级侧栏：按钮不可用；没有标签时顶部栏有「本地终端」，有标签后用 + 新建
  await page.getByTestId('nav-workspace').click();
  await expect(page.getByTestId('sider-expand')).toBeDisabled();
  await page.getByTestId('topbar-local-shell').click();
  await expect(page.getByTestId('tab-本地终端')).toBeVisible();
  await page.getByTestId('tab-new').click();
  await page.getByRole('menuitem', { name: '连接主机…' }).click();
  await expect(page.getByRole('dialog', { name: '连接主机' })).toBeVisible();
  await page.keyboard.press('Escape');

  // AI 对话模式：会话列表同样收起
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await expect(page.locator('.collapsible-sider.is-collapsed')).toHaveCount(1);
  await page.mouse.move(900, 600);
  await shot(page, 'ui8-06-collapsed-ai');
  // 重启后保持收起；展开后恢复
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await expect(page.locator('.collapsible-sider.is-collapsed')).toHaveCount(1);
  await page.getByTestId('sider-expand').click();
  await expect(page.locator('.collapsible-sider.is-collapsed')).toHaveCount(0);
  // 快捷键也可以收起 / 展开
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+Shift+B');
  await expect(page.locator('.collapsible-sider.is-collapsed')).toHaveCount(1);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+B' : 'Control+Shift+B');
  await expect(page.locator('.collapsible-sider.is-collapsed')).toHaveCount(0);
  await app.close();
});

test('AI 对话：删除前二次确认；可以多选删除', async () => {
  const { app, page } = await launch();
  await prepare(page);
  const model = (await call<{ 'ai.defaultModel': unknown }>(page, 'setting.getAll'))['ai.defaultModel'];
  for (let i = 0; i < 4; i++) await call(page, 'agent.create', { model });
  await page.reload();
  await page.getByTestId('mode-ai').click();
  const items = page.getByTestId('ai-conv-item');
  const total = await items.count();
  expect(total).toBeGreaterThanOrEqual(4);

  // 单个删除：先确认，取消就不删
  await items.first().hover();
  await items.first().getByTestId('ai-conv-del').click();
  await expect(page.locator('.ant-modal-confirm-title').filter({ hasText: /删除对话「/ })).toBeVisible();
  await page.getByRole('button', { name: /取\s*消/ }).click();
  await expect(items).toHaveCount(total);
  await items.first().hover();
  await items.first().getByTestId('ai-conv-del').click();
  await page.getByTestId('ai-conv-del-ok').click();
  await expect(items).toHaveCount(total - 1);

  // 多选：选两个，确认后删除
  await page.getByTestId('ai-conv-select').click();
  await expect(page.getByTestId('ai-conv-select-bar')).toBeVisible();
  await expect(page.getByTestId('ai-conv-del-selected')).toBeDisabled();
  await items.nth(0).click();
  await items.nth(1).getByTestId('ai-conv-check').click();
  await expect(page.getByTestId('ai-conv-select-bar')).toContainText('已选 2');
  await page.mouse.move(900, 600);
  await page.waitForTimeout(400);
  await shot(page, 'ui8-07-conv-multi-delete');
  await page.getByTestId('ai-conv-del-selected').click();
  await expect(page.locator('.ant-modal-confirm-title').filter({ hasText: '删除选中的 2 个对话？' })).toBeVisible();
  await page.getByTestId('ai-conv-del-ok').click();
  await expect(items).toHaveCount(total - 3);
  await expect(page.getByTestId('ai-conv-select-bar')).toHaveCount(0);
  // 全选
  await page.getByTestId('ai-conv-select').click();
  await page.getByTestId('ai-conv-select-all').click();
  await expect(page.getByTestId('ai-conv-select-bar')).toContainText(`已选 ${total - 3}`);
  await page.getByTestId('ai-conv-select-cancel').click();
  await expect(items).toHaveCount(total - 3);
  await app.close();
});
