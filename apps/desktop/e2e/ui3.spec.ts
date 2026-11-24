import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第三轮：AI 模式只有对话、回答内的图标、整个对话存为笔记 / 导出、标签行工具区和右键菜单、历史命令、
 * 命令提示、终端搜索、终端设置分类和监控配置、MCP 工具多选、手动创建 Skill、没有 SFTP 时走 SSH 命令通道。
 */
let root: string;
let ssh: TestSshServer;
let bare: TestSshServer;
let llm: LlmMock;

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

async function addHost(page: Page, name: string, port: number): Promise<void> {
  await call(page, 'host.create', {
    folderId: null, name, address: '127.0.0.1', port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
    fileTransfer: { mode: 'AUTO', ftpPort: 1 },
  });
}

async function connect(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId(`connect-${name}`).click();
  const trust = page.getByRole('button', { name: '信任并连接' });
  if (await trust.isVisible({ timeout: 3000 }).catch(() => false)) await trust.click();
  await expect(page.getByTestId(`tab-${name}`).locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
}

async function typeLine(page: Page, text: string, enter = true): Promise<void> {
  await page.getByTestId('xterm-tab-1').locator('.xterm').click();
  await page.keyboard.type(text, { delay: 15 });
  if (enter) await page.keyboard.press('Enter');
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui3-'));
  mkdirSync(join(root, 'remote'));
  mkdirSync(join(root, 'bare'));
  writeFileSync(join(root, 'bare', 'over-ssh.txt'), 'served over ssh exec');
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  // 没有 SFTP 子系统，也没有 FTP：文件面板通过 SSH 命令通道
  bare = await startTestSshServer({ root: join(root, 'bare'), noSftp: true, gnuStat: true });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await bare?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('AI 模式只有对话；回答里的图标；整个对话存为笔记（AI 汇总）和导出 Markdown', async () => {
  const { app, page } = await launch();
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
  await page.reload();

  // 切到 AI 模式：左侧图标栏第一个是 AI 对话、不显示主机，旁边是对话历史（第三十四轮）
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await expect(page.getByTestId('nav-hosts')).toHaveCount(0);
  await expect(page.getByTestId('nav-ai')).toHaveClass(/active/);

  const ai = page.getByTestId('agent-page-panel');
  llm.enqueue({ text: '磁盘使用率 42%，不需要处理。' });
  await ai.getByTestId('agent-input').fill('磁盘满了吗？');
  await ai.getByTestId('agent-input').press('Enter');
  await expect(ai.getByText('磁盘使用率 42%，不需要处理。')).toBeVisible();

  // 复制、存为笔记在回答框里，只显示图标，悬停显示说明
  const card = ai.locator('.answer-card').last();
  await expect(card.getByTestId('answer-copy')).toBeVisible();
  await expect(card.getByTestId('answer-save-note')).toBeVisible();
  await card.getByTestId('answer-copy').hover();
  await expect(page.locator('.ant-tooltip').filter({ hasText: '复制' }).last()).toBeVisible();
  await shot(page, 'ui3-01-ai-mode');

  // 导出整个对话为 Markdown
  const out = join(root, 'conv.md');
  await app.evaluate(({ dialog }, p2) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p2 })) as typeof dialog.showSaveDialog;
  }, out);
  await ai.getByTestId('conv-export').click();
  await expect(page.locator('.ant-message')).toContainText('已导出到');
  const md = readFileSync(out, 'utf8');
  expect(md).toContain('磁盘满了吗？');
  expect(md).toContain('磁盘使用率 42%');

  // 存为笔记：默认勾选「使用 AI 进行汇总」
  await ai.getByTestId('conv-save-note').click();
  await expect(page.getByTestId('conv-note-ai')).toBeChecked();
  await page.getByTestId('conv-note-title').fill('磁盘巡检记录');
  await shot(page, 'ui3-02-conv-note');
  llm.enqueue({ text: '磁盘使用率 42%，结论：不需要处理。' });
  await page.locator('.ant-modal').filter({ hasText: '使用 AI 进行汇总' }).getByRole('button', { name: /保\s*存|确\s*定/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已存为笔记（AI 汇总）');
  const lib = await call<{ notes: { title: string; content: string }[] }>(page, 'note.list');
  const note = lib.notes.find((n) => n.title === '磁盘巡检记录');
  expect(note?.content).toContain('结论：不需要处理');
  // 汇总请求里带着对话内容，不带思考过程
  expect(JSON.stringify(llm.requests.at(-1)?.body)).toContain('磁盘满了吗');

  await page.getByTestId('mode-terminal').click();
  await expect(page.getByTestId('nav-hosts')).toBeVisible();
  await app.close();
});

test('标签行工具区、右键菜单、历史命令、命令提示（中文说明）、终端搜索', async () => {
  const { app, page } = await launch();
  await addHost(page, 'web', ssh.port);
  await page.reload();
  await connect(page, 'web');

  // 工具区固定在标签行最右边，只有图标
  const tools = page.locator('.tab-tools');
  for (const id of ['open-sftp-from-tab', 'open-forwards', 'split-h', 'split-v', 'tab-history', 'tab-quick']) await expect(tools.getByTestId(id)).toBeVisible();
  await tools.getByTestId('split-v').hover();
  await expect(page.locator('.ant-tooltip').filter({ hasText: '上下分屏' }).last()).toBeVisible();

  // 历史命令（这台主机）
  await typeLine(page, 'echo hello-itm');
  await expect.poll(() => ssh.lines.includes('echo hello-itm')).toBe(true);
  await tools.getByTestId('tab-history').click();
  await expect(page.getByTestId('history-row').filter({ hasText: 'echo hello-itm' })).toBeVisible();
  await shot(page, 'ui3-03-history');
  await page.getByTestId('history-row').filter({ hasText: 'echo hello-itm' }).getByTestId('history-run').click();
  await expect.poll(() => ssh.lines.filter((l) => l === 'echo hello-itm').length).toBe(2);
  await page.keyboard.press('Escape');

  // 命令提示：内置命令带中文说明，↑↓ 选择、Esc 关闭、回车补全（不执行），再按回车执行
  await typeLine(page, 'docker p', false);
  const rows = page.getByTestId('term-suggest-row');
  await expect(rows.first()).toContainText('docker ps');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.includes('docker ps')).toBe(true);
  // 按键跟踪不可靠（Tab 补全、方向键、Ctrl+W 删词）之后，从屏幕上读回当前输入继续提示
  await typeLine(page, 'dock', false);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  await page.keyboard.type('psx', { delay: 15 });
  await page.waitForTimeout(300);
  await page.keyboard.press('Backspace');
  await expect(rows.first()).toContainText('docker ps', { timeout: 3000 });
  await page.keyboard.press('Control+W');
  await expect(rows.first()).toContainText('docker ps', { timeout: 3000 });
  await expect(rows.first()).toHaveAttribute('data-source', 'library');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.type('im', { delay: 15 });
  await expect(rows.first()).toContainText('docker images', { timeout: 3000 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.includes('docker images')).toBe(true);
  // 停顿不到 1 秒就回车：照常执行，不会被提示框拿去补全
  await typeLine(page, 'ls -l', false);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.includes('ls -l')).toBe(true);
  await typeLine(page, 'docker p', false);
  await expect(rows.filter({ hasText: 'docker ps' }).first()).toContainText('—');
  await shot(page, 'ui3-04-suggest');
  // 提示框开着时继续输入：列表马上缩小，不等停顿
  await page.keyboard.type('s -', { delay: 15 });
  await expect(rows).toHaveCount(1, { timeout: 500 });
  await expect(rows.first()).toContainText('docker ps -a');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  await page.keyboard.press('Control+U');

  // 搜索：⌘F / Ctrl+Shift+F
  await page.getByTestId('xterm-tab-1').locator('.xterm').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+Shift+f');
  await expect(page.getByTestId('term-search')).toBeVisible();
  await page.getByTestId('term-search-input').fill('hello-itm');
  await expect(page.getByTestId('term-search-count')).toHaveText(/^\d+\/\d+$/);
  await page.getByTestId('term-search-input').fill('nothing-here-xyz');
  await expect(page.getByTestId('term-search-count')).toHaveText('无结果');
  await shot(page, 'ui3-05-search');
  await page.getByTestId('term-search-input').press('Escape');
  await expect(page.getByTestId('term-search')).toHaveCount(0);

  // 标签右键：重命名、克隆、关闭其他
  await page.getByTestId('tab-web').click({ button: 'right' });
  const menu = page.locator('.tab-context-menu');
  for (const t of ['复制 IP', '重命名', '编辑主机', '克隆会话', '分屏', '重新连接', '关闭右侧', '关闭其他', '关闭所有']) await expect(menu).toContainText(t);
  await shot(page, 'ui3-06-tab-menu');
  await menu.getByText('重命名').click();
  await page.getByTestId('tab-rename-input').fill('生产 web');
  await page.getByTestId('tab-rename-input').press('Enter');
  const renamed = page.getByTestId('tab-生产 web');
  await expect(renamed).toContainText('生产 web');
  await renamed.click({ button: 'right' });
  await page.locator('.tab-context-menu').last().getByText('克隆会话').click();
  await expect(renamed).toHaveCount(2);
  await renamed.first().click({ button: 'right' });
  await page.locator('.tab-context-menu').last().getByText('关闭其他').click();
  await expect(renamed).toHaveCount(1);
  await renamed.click();

  // 关掉命令提示后，回到灰色的行内补全
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-terminal').click();
  await page.getByTestId('term-cat-smart').click();
  await page.getByTestId('suggest-switch').click();
  await page.getByTestId('nav-workspace').click();
  await typeLine(page, 'echo hel', false);
  await expect(page.locator('.ghost-text')).toHaveText('lo-itm');
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  // Tab 不接受灰色补全（交给 shell），→ 才接受
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('echo hel');
  await typeLine(page, 'echo hel', false);
  await expect(page.locator('.ghost-text')).toHaveText('lo-itm');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('echo hello-itm');
  await app.close();
});

test('终端设置分类、监控配置、MCP 开放的工具、手动创建 Skill', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-terminal').click();
  for (const c of ['display', 'connect', 'smart', 'monitor']) await expect(page.getByTestId(`term-cat-${c}`)).toBeVisible();
  await page.getByTestId('term-cat-monitor').click();
  await shot(page, 'ui3-07-monitor-config');
  await page.getByTestId('monitor-mounts').fill('/ /data');
  await page.getByTestId('monitor-mounts').press('Enter');
  await page.getByTestId('monitor-enabled').click();
  await expect
    .poll(async () => (await call<Record<string, { enabled: boolean; mounts: string }>>(page, 'setting.getAll'))['monitor.config'])
    .toMatchObject({ enabled: false, mounts: '/ /data' });
  await page.getByTestId('term-cat-smart').click();
  await shot(page, 'ui3-08-smart');

  // MCP：勾选开放给其他 Agent 的工具（带说明）
  await page.getByTestId('settings-nav-ext').click();
  await page.getByTestId('settings-tab-mcp').click();
  const tool = page.getByTestId('mcp-tool-ssh_exec');
  await expect(tool).toContainText('执行命令');
  await tool.click();
  await expect
    .poll(async () => (await call<Record<string, string[]>>(page, 'setting.getAll'))['mcp.server.tools'])
    .toEqual(['list_hosts', 'get_metrics', 'sftp_read', 'sftp_write', 'run_skill', 'note_list', 'note_read', 'note_save', 'skill_list', 'skill_read', 'skill_save', 'kb_search']);
  await shot(page, 'ui3-09-mcp-tools');

  // 手动创建 Skill
  await page.getByTestId('settings-nav-ext').click();
  await page.getByTestId('skill-new').click();
  await page.getByTestId('skill-name').fill('nginx-reload');
  await page.getByTestId('skill-title').fill('重载 Nginx');
  await page.getByTestId('skill-desc').fill('检查配置语法后重载 Nginx');
  await shot(page, 'ui3-10-skill-editor');
  // 切到源码：表单生成的 SKILL.md
  await page.locator('.skill-editor').getByRole('tab', { name: /源码/ }).click();
  await expect(page.getByTestId('skill-source')).toHaveValue(/name: nginx-reload[\s\S]*description: 检查配置语法后重载 Nginx/);
  await page.locator('.skill-editor').getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已创建 Skill「重载 Nginx」');
  await expect(page.getByTestId('skill-run-nginx-reload')).toBeVisible();
  const skills = await call<{ id: string; description: string }[]>(page, 'skill.list');
  expect(skills.find((s) => s.id === 'nginx-reload')?.description).toBe('检查配置语法后重载 Nginx');
  // 重名时提示
  await page.getByTestId('skill-new').click();
  await page.getByTestId('skill-name').fill('nginx-reload');
  await page.getByTestId('skill-desc').fill('x');
  await page.locator('.skill-editor').getByRole('button', { name: /保\s*存/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已经有名为「nginx-reload」的 Skill');
  await page.keyboard.press('Escape');
  await app.close();
});

test('服务器没有 SFTP 也没有 FTP：文件面板通过 SSH 命令通道', async () => {
  const { app, page } = await launch();
  await addHost(page, 'bare', bare.port);
  await page.reload();
  await connect(page, 'bare');
  await page.getByTestId('right-files').click();
  await expect(page.getByTestId('file-proto')).toHaveText('SSH', { timeout: 15_000 });
  await expect(page.getByTestId('panel-file-over-ssh.txt')).toBeVisible();
  await shot(page, 'ui3-11-ssh-files');
  await app.close();
});
