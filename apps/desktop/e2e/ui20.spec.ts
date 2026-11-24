import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 第二十轮：右侧文件面板（下载按钮没有角标、下载 / 删除二次确认、列表不左右滚动），
 * 终端鼠标复制粘贴和断开后按 R 重连（第二十一轮），Agent 权限统一为三档（需要审批 / AI 自动审批 / 完全允许 + 高危命令二次确认），设置、分组、主机的菜单一样，分组和主机多一个继承选项。
 */
let root: string;
let downloads: string;
let ssh: TestSshServer;

test.describe.configure({ mode: 'serial' });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '', ITM_ALLOW_LOCAL_AI: '1' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ app: a }, dir) => a.setPath('downloads', dir), downloads);
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(join(__dirname, '..', 'test-results', 'shots'), { recursive: true });
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'shots', `${name}.png`) });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui20-'));
  downloads = join(root, 'downloads');
  mkdirSync(downloads);
  mkdirSync(join(root, 'remote'), { recursive: true });
  writeFileSync(join(root, 'remote', 'a-very-long-file-name-for-the-narrow-file-panel.log'), 'x\n');
  writeFileSync(join(root, 'remote', 'keep.txt'), 'keep\n');
  ssh = await startTestSshServer({ root: join(root, 'remote') });
});

test.afterAll(async () => {
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('Agent 权限：设置、分组、主机统一为三档菜单，分组和主机多一个继承选项', async () => {
  const { app, page } = await launch();
  const radios = (testId: string) => page.getByTestId(`${testId}-menu`).getByRole('menuitemradio');

  // 设置 → Agent 与审批：只有三档，没有继承
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-agent').click();
  const def = page.getByTestId('default-agent-policy');
  await expect(def).toContainText('只读');
  await def.click();
  await expect(radios('default-agent-policy')).toHaveText([/^只读/, /^自动/, /^完全允许/]);
  // 选「完全允许」时菜单不关，默认勾选「高危命令需要二次确认」；取消勾选 = 高危也直接执行
  await page.getByTestId('default-agent-policy-AUTO').click();
  await expect(page.getByTestId('default-agent-policy-confirm')).toBeChecked();
  await expect.poll(async () => (await call<Record<string, unknown>>(page, 'setting.getAll'))['ai.defaultAgentPolicy']).toBe('AUTO');
  await page.getByTestId('default-agent-policy-confirm').click();
  await expect(page.getByTestId('default-agent-policy-confirm')).not.toBeChecked();
  await expect.poll(async () => (await call<Record<string, unknown>>(page, 'setting.getAll'))['ai.defaultAgentPolicy']).toBe('AUTO_ALL');
  await expect(def).toContainText('完全允许（高危命令不确认）');
  await shot(page, 'ui20-01-default-policy');
  await page.getByTestId('default-agent-policy-AI_REVIEW').click();
  await expect(page.getByTestId('default-agent-policy-menu')).toBeHidden();
  await expect(def).toContainText('自动');
  await expect.poll(async () => (await call<Record<string, unknown>>(page, 'setting.getAll'))['ai.defaultAgentPolicy']).toBe('AI_REVIEW');

  // 分组设置：继承上级 + 三档
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-folder').click();
  await page.getByTestId('folder-name-input').fill('订单');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByTestId('folder-订单').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '分组设置…' }).click();
  const fp = page.getByTestId('folder-agent-policy');
  await expect(fp).toContainText('继承上级');
  await fp.click();
  await expect(radios('folder-agent-policy')).toHaveText([/^继承上级/, /^只读/, /^自动/, /^完全允许/]);
  await shot(page, 'ui20-02-folder-policy');
  await page.getByTestId('folder-agent-policy-APPROVE').click();
  await expect(fp).toContainText('只读');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.ant-message').getByText('分组设置已保存')).toBeVisible();
  await expect.poll(async () => (await call<{ name: string; agentPolicy: string | null }[]>(page, 'folder.list')).find((f) => f.name === '订单')?.agentPolicy).toBe('APPROVE');

  // 主机：继承分组 + 三档；完全允许
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('web20');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(ssh.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  await page.getByText('AI：Agent 权限、命令黑名单、主机记忆').click();
  const hp = page.getByTestId('host-agent-policy');
  await expect(hp).toContainText('继承分组');
  await hp.click();
  await expect(radios('host-agent-policy')).toHaveText([/^继承分组/, /^只读/, /^自动/, /^完全允许/]);
  await page.getByTestId('host-agent-policy-AUTO').click();
  await expect(page.getByTestId('host-agent-policy-confirm')).toBeChecked();
  await shot(page, 'ui20-03-host-policy');
  await page.keyboard.press('Escape');
  await expect(hp).toContainText('完全允许');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('connect-web20')).toBeVisible();
  const host = (await call<{ name: string; agentPolicy: string | null }[]>(page, 'host.list')).find((h) => h.name === 'web20');
  expect(host?.agentPolicy).toBe('AUTO');
  await app.close();
});

test('右侧文件面板：下载按钮没有角标、下载和删除先确认、列表不左右滚动', async () => {
  const { app, page } = await launch();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web20').click();
  const dot = page.getByTestId('tab-web20').locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  await page.getByTestId('right-files').click();
  const list = page.getByTestId('file-panel-list');
  await page.getByTestId('file-panel-path-edit').click();
  await page.getByTestId('file-panel-path').fill(join(root, 'remote'));
  await page.getByTestId('file-panel-path').press('Enter');
  await expect(page.getByTestId('panel-file-keep.txt')).toBeVisible({ timeout: 15_000 });

  // 列表不左右滚动：所有列挤在面板宽度里
  await expect(list).toHaveCSS('overflow-x', 'hidden');
  expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.getByTestId('fp-header').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // 多选后下载按钮上没有数字角标
  await page.getByTestId('panel-file-keep.txt').click();
  await page.getByTestId('panel-file-a-very-long-file-name-for-the-narrow-file-panel.log').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.locator('.fp-toolbar .ant-badge')).toHaveCount(0);
  await shot(page, 'ui20-04-file-panel');

  // 删除：先确认，取消后文件还在
  await page.getByTestId('panel-file-keep.txt').click();
  await page.getByTestId('fp-delete').click();
  await expect(page.locator('.ant-modal-confirm-title')).toHaveText('永久删除「keep.txt」？');
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '取消' }).click();
  await expect(page.getByTestId('panel-file-keep.txt')).toBeVisible();

  // 下载：先确认
  await page.getByTestId('file-panel-download').click();
  await expect(page.locator('.ant-modal-confirm-title')).toHaveText('下载「keep.txt」？');
  await page.getByTestId('fp-download-ok').click();
  await expect.poll(() => readdirSync(downloads), { timeout: 15_000 }).toContain('keep.txt');
  await app.close();
});

test('终端鼠标（MobaXterm 风格）：选中即复制、中键 / 右键粘贴、长按右键或 Ctrl + 右键打开菜单；断开后按 S 保存输出、按 R 重新连接', async () => {
  const { app, page } = await launch();
  const clip = (): Promise<string> => app.evaluate(({ clipboard }) => clipboard.readText());
  const setClip = (t: string): Promise<void> => app.evaluate(({ clipboard }, x) => clipboard.writeText(x), t);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web20').click();
  const dot = page.getByTestId('tab-web20').locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  const screen = page.getByTestId('xterm-tab-1').locator('.xterm-screen');
  const box = (await screen.boundingBox())!;
  const menuItem = page.getByRole('menuitem', { name: '全选' });

  // 选中即复制：双击第一行的 welcome
  await setClip('');
  await page.mouse.dblclick(box.x + 20, box.y + 8);
  await expect.poll(clip).toBe('welcome');

  // 右键单击粘贴（第一次会提示怎么打开菜单），不弹菜单
  await setClip('echo right-paste');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(page.locator('.ant-message')).toContainText('长按右键');
  await expect(menuItem).toHaveCount(0);
  // 粘贴要先异步读剪贴板
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('echo right-paste');

  // 中键粘贴
  await setClip('echo middle-paste');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'middle' });
  // 粘贴要先异步读剪贴板
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('echo middle-paste');

  // 长按右键打开菜单（不粘贴）
  await setClip('echo should-not-paste');
  await page.mouse.move(box.x + 200, box.y + 200);
  await page.mouse.down({ button: 'right' });
  await expect(menuItem).toBeVisible();
  await page.mouse.up({ button: 'right' });
  await shot(page, 'ui20-05-long-press-menu');
  await page.keyboard.press('Escape');
  await expect(menuItem).toBeHidden();
  // Ctrl + 右键也打开菜单
  await page.keyboard.down('Control');
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await page.keyboard.up('Control');
  await expect(menuItem).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuItem).toBeHidden();
  await page.getByTestId('xterm-tab-1').locator('.xterm').click();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  expect(ssh.lines).not.toContain('echo should-not-paste');

  // 设置 → 终端：关闭右键粘贴后右键直接打开菜单
  const toggleRightPaste = async (on: boolean): Promise<void> => {
    await page.getByTestId('avatar-trigger').click();
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-nav-terminal').click();
    const sw = page.getByTestId('mouse-right-paste');
    await expect(page.getByTestId('mouse-copy-on-select')).toBeChecked();
    await expect(page.getByTestId('mouse-middle-paste')).toBeChecked();
    if ((await sw.getAttribute('aria-checked')) !== String(on)) await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', String(on));
    if (!on) await shot(page, 'ui20-07-mouse-settings');
    await page.getByTestId('nav-workspace').click();
    await expect(screen).toBeVisible();
  };
  await toggleRightPaste(false);
  await page.mouse.click(box.x + 200, box.y + 200, { button: 'right' });
  await expect(menuItem).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menuItem).toBeHidden();
  await toggleRightPaste(true);

  // 断开：终端里提示按 R 重新连接、按 S 保存输出；横幅也有提示
  await page.getByTestId('xterm-tab-1').locator('.xterm').click();
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-banner')).toContainText('按 R 重新连接');
  await expect(dot).not.toHaveCSS('background-color', 'rgb(82, 196, 26)');
  await page.waitForTimeout(300);
  await shot(page, 'ui20-06-session-ended');
  // S：保存终端输出
  const saved = join(root, 'term-output.log');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, saved);
  await page.getByTestId('xterm-tab-1').locator('.xterm').click();
  await page.keyboard.press('s');
  await expect.poll(() => (existsSync(saved) ? readFileSync(saved, 'utf8') : '')).toContain('welcome to test server');
  expect(readFileSync(saved, 'utf8')).toContain('按 R 重新连接');
  // R：重新连接
  const before = ssh.connections;
  await page.getByTestId('xterm-tab-1').locator('.xterm').click();
  await page.keyboard.press('r');
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  expect(ssh.connections).toBe(before + 1);
  await expect(page.locator('.terminal-banner')).toHaveCount(0);
  // 连上以后 R 是普通输入
  await page.keyboard.type('echo r-ok');
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('echo r-ok');
  await app.close();
});
