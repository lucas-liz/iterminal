import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 第三十三轮：历史命令读 shell 自己的历史（分页 100 条、下滑加载、输入提示优先），
 * 文件面板右键执行 .sh（检查执行权限、到目录下执行 / 直接执行），引用的主机多了以后批量清理。
 */
let root: string;
let remote: string;
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

const host = (name: string, port: number): Record<string, unknown> => ({ folderId: null, name, address: '127.0.0.1', port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });

async function prepare(page: Page): Promise<void> {
  // AI 面板要有模型才显示输入框和引用行（这里不会真的请求模型）
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', { id: null, input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', enabled: true, models: [{ id: 'mock', contextWindow: 64000, maxOutput: 2048 }] } });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock' } });
  }
  const names = (await call<{ name: string }[]>(page, 'host.list')).map((h) => h.name);
  if (!names.includes('web33')) await call(page, 'host.create', host('web33', ssh.port));
  // 引用用的主机（不连接）
  for (const n of ['app-a', 'app-b', 'app-c', 'app-d', 'app-e']) if (!names.includes(n)) await call(page, 'host.create', host(n, 1));
}

async function connect(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId(`connect-${name}`).click();
  const dot = page.getByTestId(`tab-${name}`).locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui33-'));
  remote = realpathSync(join(root));
  remote = join(remote, 'remote');
  mkdirSync(join(remote, 'scripts'), { recursive: true });
  // shell 历史：250 条 + 两条 git（最近的在文件末尾）
  const lines = Array.from({ length: 250 }, (_, i) => `echo line-${i}`);
  writeFileSync(join(remote, '.bash_history'), [...lines, 'git status', 'git log --oneline'].join('\n') + '\n');
  writeFileSync(join(remote, 'scripts', 'deploy.sh'), '#!/bin/sh\necho deploy\n');
  writeFileSync(join(remote, 'scripts', 'noexec.sh'), 'echo hi\n');
  chmodSync(join(remote, 'scripts', 'deploy.sh'), 0o755);
  chmodSync(join(remote, 'scripts', 'noexec.sh'), 0o644);
  ssh = await startTestSshServer({ root: remote, sftpRealPaths: true });
});

test.afterAll(async () => {
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('历史命令：读 ~/.bash_history，每页 100 条下滑加载；输入时 shell 历史排在提示的最前面', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web33');
  await page.getByTestId('tab-history').click();
  const panel = page.getByTestId('history-panel');
  const rows = panel.getByTestId('history-row');
  await expect(rows).toHaveCount(100, { timeout: 10_000 });
  await expect(rows.first()).toContainText('git log --oneline');
  await expect(rows.first()).toContainText('shell 历史');
  await expect(panel.getByTestId('history-more')).toContainText('已显示 100 / 252 条');
  await shot(page, 'ui33-01-history');
  // 下滑到底部加载下一页
  await panel.getByTestId('history-list').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(rows).toHaveCount(200);
  await panel.getByTestId('history-list').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(rows).toHaveCount(252);
  await expect(panel.getByTestId('history-more')).toHaveCount(0);
  await expect(rows.last()).toContainText('echo line-0');
  await panel.getByTestId('history-search').fill('line-24');
  await expect(rows).toHaveCount(11);
  await page.keyboard.press('Escape');
  await page.getByTestId('tab-history').click();
  await expect(panel).toBeHidden();

  // 输入提示：git 开头的命令，系统推荐（带说明）在前，shell 历史在后（最近的在前）；和系统推荐相同的历史不重复列出
  await page.locator('[data-testid^="xterm-"]').first().locator('.xterm').click();
  await page.keyboard.type('git ', { delay: 20 });
  const sug = page.getByTestId('term-suggest-row');
  const hist = page.locator('[data-testid="term-suggest-row"][data-source="history"]');
  await expect(hist.first()).toContainText('git log --oneline', { timeout: 10_000 });
  await expect(sug.first()).toHaveAttribute('data-source', 'library');
  await expect(sug.first()).toContainText('git status');
  await expect(sug.first()).toContainText('—');
  await expect(hist.filter({ hasText: 'git status' })).toHaveCount(0);
  await shot(page, 'ui33-02-suggest');
  await page.keyboard.press('Escape');
  await app.close();
});

test('文件面板右键执行 .sh：有执行权限时直接执行；没有时提示，可以先 chmod 再到目录下执行', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web33');
  await page.getByTestId('right-files').click();
  await page.getByTestId('file-panel-path-edit').click();
  const pathInput = page.getByTestId('file-panel-path');
  const dir = join(remote, 'scripts');
  await pathInput.fill(dir);
  await pathInput.press('Enter');
  await expect(page.getByTestId('panel-file-deploy.sh')).toBeVisible({ timeout: 10_000 });

  // 有执行权限
  await page.getByTestId('panel-file-deploy.sh').click({ button: 'right' });
  await page.locator('.fp-menu').getByText('执行…').click();
  const dialog = page.locator('.ant-modal').filter({ has: page.getByTestId('sh-exec-dialog') });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('code').first()).toHaveText(`cd ${dir} && ./deploy.sh`);
  await expect(dialog.getByTestId('sh-exec-noperm')).toHaveCount(0);
  await dialog.getByTestId('sh-exec-direct').click();
  await expect.poll(() => ssh.lines.includes(join(dir, 'deploy.sh'))).toBe(true);
  await expect(dialog).toBeHidden();

  // 没有执行权限
  await page.getByTestId('panel-file-noexec.sh').click({ button: 'right' });
  await page.locator('.fp-menu').getByText('执行…').click();
  await expect(dialog.getByTestId('sh-exec-noperm')).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('code').first()).toHaveText(`cd ${dir} && chmod u+x ./noexec.sh && ./noexec.sh`);
  await shot(page, 'ui33-03-sh-noperm');
  await dialog.getByText('用 bash 执行（不修改权限）').click();
  await expect(dialog.locator('code').nth(1)).toHaveText(`bash ${join(dir, 'noexec.sh')}`);
  await dialog.getByText('先添加执行权限再执行（chmod u+x）').click();
  await dialog.getByTestId('sh-exec-indir').click();
  await expect.poll(() => ssh.lines.includes(`cd ${dir} && chmod u+x ./noexec.sh && ./noexec.sh`)).toBe(true);
  // 不是 .sh 的文件没有「执行」
  writeFileSync(join(dir, 'notes.txt'), 'x');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  await page.getByTestId('file-panel-path-edit').click();
  await pathInput.fill(remote);
  await pathInput.press('Enter');
  await page.getByTestId('file-panel-path-edit').click();
  await pathInput.fill(dir);
  await pathInput.press('Enter');
  await page.getByTestId('panel-file-notes.txt').click({ button: 'right' });
  await expect(page.locator('.fp-menu').getByText('编辑')).toBeVisible();
  await expect(page.locator('.fp-menu').getByText('执行…')).toHaveCount(0);

  // 在终端进入当前目录：右键文件 → 进入文件面板当前所在的目录
  const cdItem = page.locator('.fp-menu').getByTestId('fp-cd-item');
  await expect(cdItem).toContainText('在终端进入当前目录');
  await expect(cdItem).toContainText(dir);
  await cdItem.click();
  await expect.poll(() => ssh.lines.filter((l) => l === `cd ${dir}`).length).toBe(1);
  // 右键文件夹：也是当前目录，菜单里提示不是所选的文件夹
  await page.getByTestId('panel-file-sub').click({ button: 'right' });
  await expect(cdItem).toContainText(dir);
  await expect(cdItem).toContainText('不是所选的文件夹');
  await shot(page, 'ui33-04-cd-menu');
  await page.keyboard.press('Escape');
  await expect(cdItem).toBeHidden();
  // 路径框最后的终端图标：鼠标放上去有说明，点一下进入
  await page.getByTestId('fp-cd-here').hover();
  await expect(page.locator('.ant-tooltip').filter({ hasText: '在终端中进入此目录' }).last()).toContainText(`cd ${dir}`);
  await shot(page, 'ui33-05-cd-button');
  await page.getByTestId('fp-cd-here').click();
  await expect.poll(() => ssh.lines.filter((l) => l === `cd ${dir}`).length).toBe(2);
  await app.close();
});

test('引用的主机多了合成「N 台主机」：多选移除、只留当前终端；添加引用里可以只看已选、全选、清空', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web33');
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  await side.getByTestId('refs-more').click();
  await page.getByTestId('refs-cat-host').click();
  const bulk = page.getByTestId('refs-bulk');
  await expect(bulk).toContainText('已选 0');
  await bulk.getByTestId('refs-select-all').click();
  // 所有 SSH 主机都选上了（web33 已经作为终端引用，主机里也勾上）
  await expect(bulk).toContainText('已选 6');
  await bulk.getByTestId('refs-only-selected').click();
  await expect(page.getByTestId('refs-panel').locator('.refs-row')).toHaveCount(6);
  await page.keyboard.press('Escape');

  const chip = side.getByTestId('ref-chip-hosts');
  await expect(chip).toContainText('6 台主机');
  await chip.click();
  const hp = page.getByTestId('host-refs-panel');
  await expect(hp.getByTestId('host-refs-row')).toHaveCount(6);
  // Shift 点击选一段
  await hp.getByTestId('host-refs-row').nth(1).click();
  await hp.getByTestId('host-refs-row').nth(3).click({ modifiers: ['Shift'] });
  await expect(hp).toContainText('已选 3');
  await shot(page, 'ui33-04-host-refs');
  await hp.getByTestId('host-refs-remove').click();
  // 剩 3 个时不再合成，直接显示 3 个标签
  await expect(side.getByTestId('ref-chip-hosts')).toHaveCount(0);
  await expect(side.locator('.agent-refs-bar .ref-chip')).toHaveCount(3);

  // 再加回来，然后「只留当前」
  await side.getByTestId('refs-more').click();
  await page.getByTestId('refs-cat-host').click();
  await page.getByTestId('refs-bulk').getByTestId('refs-select-all').click();
  await page.keyboard.press('Escape');
  await expect(chip).toContainText('6 台主机');
  await chip.click();
  await page.getByTestId('host-refs-panel').getByTestId('host-refs-keep').click();
  await expect(side.getByTestId('ref-chip-hosts')).toHaveCount(0);
  await expect(side.locator('.agent-refs-bar .ref-chip')).toHaveCount(1);
  await expect(side.locator('.agent-refs-bar .ref-chip')).toContainText('web33');

  // 添加引用里「清空」
  await side.getByTestId('refs-more').click();
  await page.getByTestId('refs-cat-host').click();
  await page.getByTestId('refs-bulk').getByTestId('refs-select-all').click();
  await expect(page.getByTestId('refs-bulk')).toContainText('已选 6');
  await page.getByTestId('refs-bulk').getByTestId('refs-clear').click();
  await expect(page.getByTestId('refs-bulk')).toContainText('已选 0');
  await app.close();
});
