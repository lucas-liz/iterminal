import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';
import { startMockServer, type MockServer } from '../test/support/mock-server';

/**
 * 第十二轮：主机列表（单击 / Shift 选中、右键菜单、延迟和备注、导出敏感信息）、测试连接的日志框和结果、端口转发批量操作、
 * 终端右侧面板（去掉命令、文件多选下载）、添加到快捷指令（终端右键 + AI 生成）、录像回放的命令列表和 AI 汇总笔记、
 * AI 引用行（左右滑动、个数、@ 留在输入框、AI 对话模式也有）、离线使用（Guest）不能用 AI、账号卡片、外观设置（主题卡片、背景媒体）。
 */
let root: string;
let downloads: string;
let ssh: TestSshServer;
let llm: LlmMock;
let mock: MockServer;

test.describe.configure({ mode: 'serial' });

async function launch(opts: { localAi?: boolean; userData?: string } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = {
    ...process.env,
    ITM_USER_DATA: opts.userData ?? join(root, 'userData'),
    ITM_INSECURE_KEYSTORE: '1',
    ELECTRON_RENDERER_URL: '',
    ITM_ALLOW_LOCAL_AI: opts.localAi === false ? '0' : '1',
    // 登录框里没有服务端地址：测试用 ITM_DEFAULT_SERVER_URL 指定（只在没有打包时生效）
    ...(mock ? { ITM_DEFAULT_SERVER_URL: mock.url } : {}),
  };
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

/** 让主进程的打开 / 保存对话框直接返回指定路径 */
async function stubDialogs(app: ElectronApplication, p: { open?: string; save?: string }): Promise<void> {
  await app.evaluate(({ dialog }, x) => {
    dialog.showSaveDialog = (async () => ({ canceled: !x.save, filePath: x.save ?? undefined })) as typeof dialog.showSaveDialog;
    dialog.showOpenDialog = (async () => ({ canceled: !x.open, filePaths: x.open ? [x.open] : [] })) as typeof dialog.showOpenDialog;
  }, p);
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

const hostBase = { folderId: null, address: '127.0.0.1', username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, jumpHostIds: [] };

async function prepare(page: Page): Promise<Record<string, string>> {
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
    await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  }
  const existing = await call<{ id: string; name: string }[]>(page, 'host.list');
  const ids: Record<string, string> = Object.fromEntries(existing.map((h) => [h.name, h.id]));
  const add = async (name: string, extra: Record<string, unknown>): Promise<void> => {
    if (ids[name]) return;
    const h = await call<{ id: string }>(page, 'host.create', { ...hostBase, name, port: ssh.port, note: null, ...extra });
    ids[name] = h.id;
  };
  await add('web12', { note: '订单服务主库，业务高峰 9:00-11:00 不要重启' });
  await add('db12', {});
  await add('dead12', { port: 1 });
  await add('jump12', { jumpHostIds: [ids.web12] });
  return ids;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui12-'));
  downloads = join(root, 'downloads');
  mkdirSync(downloads);
  mkdirSync(join(root, 'remote'), { recursive: true });
  for (const n of ['a1.txt', 'a2.txt', 'a3.txt', 'b4.txt']) writeFileSync(join(root, 'remote', n), `content of ${n}\n`);
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
  mock = await startMockServer();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  await mock?.close();
  rmSync(root, { recursive: true, force: true });
});

test('主机列表：延迟和备注列、单击 / Shift 选中、右键菜单；导出可以选安全导出或包含密码', async () => {
  const { app, page } = await launch();
  const ids = await prepare(page);
  await page.reload();
  await page.getByTestId('nav-hosts').click();

  // 延迟：直连的测 TCP，连不上显示「不通」，经跳板机的不直接测
  await expect(page.getByTestId('latency-web12')).toContainText('ms', { timeout: 10_000 });
  await expect(page.getByTestId('latency-dead12')).toContainText('不通');
  await expect(page.getByTestId('latency-jump12')).toHaveText('—');
  await expect(page.getByTestId('host-note-web12')).toHaveText('订单服务主库，业务高峰 9:00-11:00 不要重启');

  // 单击行（不是按钮）选中，再点一次取消；Shift + 单击选中一段
  const row = (name: string) => page.locator(`tr[data-row-key="${ids[name]}"]`);
  await row('web12').locator('.host-addr-text').click();
  await expect(page.getByTestId('selection-bar')).toContainText('已选择 1 台主机');
  await row('web12').locator('.host-addr-text').click();
  await expect(page.getByTestId('selection-bar')).toHaveCount(0);
  const order = await page.locator('tr.host-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-row-key')));
  const first = order[0]!;
  const third = order[2]!;
  await page.locator(`tr[data-row-key="${first}"] .host-addr-text`).click();
  await page.locator(`tr[data-row-key="${third}"] .host-addr-text`).click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('selection-bar')).toContainText('已选择 3 台主机');
  // 前面的复选框也可以
  await expect(page.locator(`tr[data-row-key="${first}"] .ant-checkbox-checked`)).toHaveCount(1);
  await shot(page, 'ui12-01-hosts-selected');

  // 右键已选中的行：批量菜单
  await page.locator(`tr[data-row-key="${first}"]`).click({ button: 'right' });
  const menu = page.locator('.host-ctx-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('连接选中的 3 台');
  await page.waitForTimeout(300);
  await shot(page, 'ui12-02-hosts-context-batch');
  await page.keyboard.press('Escape');
  await page.getByTestId('batch-clear').click();
  // 右键没选中的行：这台主机的菜单
  await row('db12').click({ button: 'right' });
  await expect(menu).toContainText('连接终端');
  await expect(menu).toContainText('复制地址');
  await page.waitForTimeout(300);
  await shot(page, 'ui12-03-hosts-context-single');
  await menu.getByText('编辑').click();
  await expect(page.getByTestId('host-form')).toBeVisible();
  await page.locator('.ant-modal').filter({ has: page.getByTestId('host-form') }).getByRole('button', { name: '取消' }).click();
  await expect(page.getByTestId('host-form')).toHaveCount(0);

  // 导出：安全导出不含密码；包含敏感信息时带上密码
  const safe = join(root, 'safe.json');
  const secret = join(root, 'secret.json');
  await stubDialogs(app, { save: safe });
  await page.getByTestId('export-hosts-open').click();
  await expect(page.getByTestId('export-dialog')).toBeVisible();
  await page.getByTestId('export-format').getByText('JSON').click();
  await shot(page, 'ui12-04-export-dialog');
  await page.getByTestId('export-ok').click();
  await expect.poll(() => existsSync(safe)).toBe(true);
  expect(readFileSync(safe, 'utf8')).not.toContain('"password"');
  await stubDialogs(app, { save: secret });
  await page.getByTestId('export-hosts-open').click();
  await page.getByTestId('export-format').getByText('JSON').click();
  await page.getByTestId('export-mode-secrets').click();
  await expect(page.getByTestId('export-dialog')).toContainText('明文');
  await shot(page, 'ui12-05-export-secrets');
  await page.getByTestId('export-ok').click();
  await expect.poll(() => existsSync(secret)).toBe(true);
  const data = JSON.parse(readFileSync(secret, 'utf8')) as { containsSecrets: boolean; hosts: { name: string; password?: string; note: string | null }[] };
  expect(data.containsSecrets).toBe(true);
  expect(data.hosts.find((h) => h.name === 'web12')).toMatchObject({ password: 'pw', note: '订单服务主库，业务高峰 9:00-11:00 不要重启' });
  const audit = await call<{ items: { eventType: string }[] }>(page, 'audit.list', { kind: 'EVENT' });
  expect(audit.items.some((e) => e.eventType === 'EXPORT_HOSTS_WITH_SECRETS')).toBe(true);
  await app.close();
});

test('新建主机：备注在基本信息里；测试连接直接打开日志框，旁边显示成功 / 失败、耗时和原因，不错位', async () => {
  const { app, page } = await launch();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('new12');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(ssh.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  await expect(page.getByTestId('host-note')).toBeVisible();
  await page.getByTestId('host-note').fill('新建的测试主机');

  await page.getByTestId('host-test').click();
  const log = page.getByTestId('host-test-log');
  await expect(log).toBeVisible();
  // 第一次连接这台主机：确认主机指纹的提示在日志框上面
  const trust = page.getByRole('button', { name: '信任并连接' });
  if (await trust.isVisible({ timeout: 5000 }).catch(() => false)) {
    await shot(page, 'ui12-06a-test-trust-over-log');
    await trust.click();
  }
  await expect(page.getByTestId('host-test-log-status')).toContainText('测试成功', { timeout: 15_000 });
  await expect(log.getByTestId('conn-log')).toContainText('测试连接成功');
  await shot(page, 'ui12-06-test-log');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('host-test-result')).toContainText('测试成功');
  await expect(page.getByTestId('host-test-latency')).toContainText('ms');
  await shot(page, 'ui12-07-test-ok');

  // 失败：红色「测试失败」+ 原因 + 查看日志；文字长时省略，按钮不被挤走、不换行
  await page.getByTestId('host-password').fill('wrong-password');
  await page.getByTestId('host-test').click();
  await expect(page.getByTestId('host-test-log-status')).toContainText('测试失败', { timeout: 20_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('host-test-result')).toContainText('测试失败');
  await expect(page.getByTestId('host-test-error')).not.toBeEmpty();
  const btn = await page.getByTestId('host-test').boundingBox();
  const res = await page.getByTestId('host-test-result').boundingBox();
  const logBtn = await page.getByTestId('host-test-log-open').boundingBox();
  const save = await page.getByTestId('host-save').boundingBox();
  // 一行：垂直居中对齐；结果在测试按钮右边、查看日志在保存按钮左边
  expect(Math.abs(btn!.y + btn!.height / 2 - (res!.y + res!.height / 2))).toBeLessThan(3);
  expect(Math.abs(btn!.y + btn!.height / 2 - (logBtn!.y + logBtn!.height / 2))).toBeLessThan(3);
  expect(res!.x).toBeGreaterThan(btn!.x + btn!.width);
  expect(logBtn!.x + logBtn!.width).toBeLessThan(save!.x);
  await shot(page, 'ui12-08-test-failed');
  await page.getByTestId('host-test-log-open').click();
  await expect(page.getByTestId('host-test-log-status')).toContainText('测试失败');
  await page.keyboard.press('Escape');
  await page.getByTestId('host-password').fill('pw');
  await page.getByTestId('host-save').click();
  await expect(page.getByTestId('host-note-new12')).toHaveText('新建的测试主机');
  await app.close();
});

test('端口转发：勾选多条后批量连接、断开、删除', async () => {
  const { app, page } = await launch();
  const ids = await prepare(page);
  for (let i = 0; i < 2; i++) {
    await call(page, 'portforward.save', { id: null, hostId: ids.web12, input: { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: '127.0.0.1', targetPort: ssh.port, autoStart: false } });
  }
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('more-web12').click();
  await page.getByRole('menuitem', { name: '端口转发…' }).click();
  const modal = page.locator('.ant-modal').filter({ hasText: '端口转发 · web12' });
  await expect(modal.locator('tbody tr.ant-table-row')).toHaveCount(2);
  await modal.locator('thead .ant-checkbox-input').check();
  await expect(page.getByTestId('pf-batch')).toContainText('已选择 2 条');
  await page.getByTestId('pf-batch-start').click();
  await expect(modal.getByText('运行中')).toHaveCount(2, { timeout: 15_000 });
  await shot(page, 'ui12-09-forward-batch');
  await page.getByTestId('pf-batch-stop').click();
  await expect(modal.getByText('未启动')).toHaveCount(2, { timeout: 10_000 });
  await page.getByTestId('pf-batch-delete').click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: '删除' }).click();
  await expect(modal.locator('tbody tr.ant-table-row')).toHaveCount(0);
  await app.close();
});

test('终端：右侧只有文件 / 监控 / AI；文件多选下载；右键把选中内容加到快捷指令（AI 生成名称和描述）；AI 引用行', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web12');
  await expect(page.getByTestId('right-files')).toBeVisible();
  await expect(page.getByTestId('right-monitor')).toBeVisible();
  await expect(page.getByTestId('right-ai')).toBeVisible();
  await expect(page.getByTestId('right-snippets')).toHaveCount(0);

  // 文件：单击、Shift 单击选一段，下载按钮显示个数
  await page.getByTestId('right-files').click();
  await expect(page.getByTestId('panel-file-a1.txt')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('panel-file-a1.txt').click();
  await page.getByTestId('panel-file-a3.txt').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('file-panel-download-count')).toHaveText('下载 3');
  // ⌘ / Ctrl 单击加选
  await page.getByTestId('panel-file-b4.txt').click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(page.getByTestId('file-panel-download-count')).toHaveText('下载 4');
  await shot(page, 'ui12-10-files-multi');
  // 下载按钮上没有数字角标；下载前二次确认，取消不下载
  await expect(page.locator('.fp-toolbar .ant-badge')).toHaveCount(0);
  await page.getByTestId('file-panel-download').click();
  await expect(page.locator('.ant-modal-confirm-title')).toHaveText('下载选中的 4 项？');
  await page.locator('.ant-modal-confirm').getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(500);
  expect(readdirSync(downloads)).toEqual([]);
  await page.getByTestId('file-panel-download').click();
  await page.getByTestId('fp-download-ok').click();
  await expect.poll(() => readdirSync(downloads).sort(), { timeout: 15_000 }).toEqual(['a1.txt', 'a2.txt', 'a3.txt', 'b4.txt']);
  // ⌘ / Ctrl + A 全选（第十六轮），Esc 取消选择
  await page.getByTestId('panel-file-b4.txt').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await expect(page.getByTestId('file-panel-download-count')).toHaveText(/^下载 \d+$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('file-panel-download-count')).toHaveText('');
  // 按住鼠标拖过几行（没有选中的行拖动是框选，不是拖到本机）
  const a1 = await page.getByTestId('panel-file-a1.txt').boundingBox();
  const a2 = await page.getByTestId('panel-file-a2.txt').boundingBox();
  await page.mouse.move(a1!.x + 40, a1!.y + a1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(a2!.x + 40, a2!.y + a2!.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('file-panel-download-count')).toHaveText('下载 2');

  // 终端右键：选中内容加到快捷指令，AI 生成名称和描述，选择（新建）目录
  await typeLine(page, 'xterm-tab-1', 'systemctl status nginx');
  const xterm = page.getByTestId('xterm-tab-1');
  await xterm.click({ button: 'right', modifiers: ['Control'] });
  await page.getByRole('menuitem', { name: '全选' }).click();
  await xterm.click({ button: 'right', modifiers: ['Control'] });
  await expect(page.getByRole('menuitem', { name: '选中内容添加到快捷指令…' })).toBeEnabled();
  await page.getByRole('menuitem', { name: '选中内容添加到快捷指令…' }).click();
  const dlg = page.getByTestId('add-snippet-dialog');
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId('add-snippet-content')).toHaveValue(/systemctl status nginx/);
  await page.getByTestId('add-snippet-content').fill('systemctl status nginx');
  llm.enqueue({ text: '{"title": "查看 Nginx 服务状态", "description": "查看 nginx 是否在运行、最近的日志"}' });
  await page.getByTestId('add-snippet-ai').click();
  await expect(page.getByTestId('add-snippet-name')).toHaveValue('查看 Nginx 服务状态');
  await expect(page.getByTestId('add-snippet-desc')).toHaveValue('查看 nginx 是否在运行、最近的日志');
  await page.getByTestId('add-snippet-group').click();
  await page.getByTestId('add-snippet-new-group').fill('常用运维');
  await page.getByTestId('add-snippet-new-group').press('Enter');
  await expect(page.getByTestId('add-snippet-group')).toContainText('常用运维');
  await shot(page, 'ui12-11-add-snippet');
  await page.getByTestId('add-snippet-ok').click();
  await expect(dlg).toHaveCount(0);
  const lib = await call<{ groups: { id: string; name: string }[]; snippets: { name: string; content: string; description: string; groupId: string }[] }>(page, 'snippet.list');
  const sn = lib.snippets.find((x) => x.name === '查看 Nginx 服务状态')!;
  expect(sn).toMatchObject({ content: 'systemctl status nginx', description: '查看 nginx 是否在运行、最近的日志' });
  expect(lib.groups.find((g) => g.id === sn.groupId)?.name).toBe('常用运维');

  // AI 引用行：@ 选中后输入框里留下 @名称；一行显示全部、可以左右滑动、不显示滚动条；··· 上显示引用个数
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  const input = side.getByTestId('agent-input');
  await input.click();
  for (const name of ['db12', 'dead12', 'jump12', 'new12']) {
    await input.pressSequentially(`@${name}`);
    await expect(page.getByTestId('mention-item').first()).toContainText(name);
    await input.press('Enter');
  }
  await expect(input).toHaveValue('@db12 @dead12 @jump12 @new12 ');
  const bar = side.locator('.agent-refs-bar');
  await expect(bar).toHaveCSS('overflow-x', 'auto');
  await expect(bar).toHaveCSS('scrollbar-width', 'none');
  await expect(bar).toHaveCSS('flex-wrap', 'nowrap');
  await expect(side.getByTestId('refs-count')).toHaveText('5');
  const scroll = await bar.evaluate((el) => ({ w: el.scrollWidth, c: el.clientWidth }));
  if (scroll.w > scroll.c) {
    await bar.hover();
    await page.mouse.wheel(0, 200);
    await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  }
  await shot(page, 'ui12-12-refs-bar');

  // AI 对话模式输入框上方也有引用行
  await page.getByTestId('mode-ai').click();
  const pagePanel = page.getByTestId('agent-page-panel');
  await expect(pagePanel.getByTestId('agent-refs-bar')).toBeVisible();
  await expect(pagePanel.getByTestId('refs-count')).toHaveText('5');
  await shot(page, 'ui12-13-ai-page-refs');
  await app.close();
});

test('录像回放：右侧列出执行的命令，单击跳到那里并暂停，一键加到快捷指令；导出里可以用 AI 汇总为笔记', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'db12');
  const tid = await page.locator('[data-testid^="xterm-tab-"]').first().getAttribute('data-testid');
  await typeLine(page, tid!, 'echo step-one');
  await page.waitForTimeout(1200);
  await typeLine(page, tid!, 'df -h');
  await page.waitForTimeout(1200);
  await typeLine(page, tid!, 'tail -n 50 /var/log/app.log');
  await page.waitForTimeout(800);
  await page.getByTestId('tab-db12').locator('.ws-top-tab-close').click();

  await page.getByTestId('nav-audit').click();
  await page.getByTestId('audit-tab-conn').click();
  const recs = page.getByTestId('recording-table');
  await expect(recs).toContainText('db12');
  await recs.getByTestId('recording-play').first().click();
  await expect(page.getByTestId('rec-player')).toBeVisible();
  const cmds = page.getByTestId('rec-cmd');
  await expect(cmds).toHaveCount(3);
  await expect(cmds.nth(0)).toContainText('echo step-one');
  await expect(cmds.nth(2)).toContainText('tail -n 50 /var/log/app.log');

  // 单击第二条：跳过去并暂停
  await cmds.nth(1).click();
  await expect(cmds.nth(1)).toHaveClass(/active/);
  const t1 = await page.getByTestId('rec-time').textContent();
  await page.waitForTimeout(800);
  expect(await page.getByTestId('rec-time').textContent()).toBe(t1);
  await expect(page.getByTestId('rec-term')).toContainText('df -h');
  await shot(page, 'ui12-14-recording-commands');

  // 命令后面的 ⚡：加到快捷指令
  await cmds.nth(2).hover();
  await cmds.nth(2).getByTestId('rec-cmd-add').click();
  await expect(page.getByTestId('add-snippet-content')).toHaveValue('tail -n 50 /var/log/app.log');
  await page.getByTestId('add-snippet-ok').click();
  await expect(page.getByTestId('add-snippet-dialog')).toHaveCount(0);
  expect((await call<{ snippets: { content: string }[] }>(page, 'snippet.list')).snippets.some((s) => s.content === 'tail -n 50 /var/log/app.log')).toBe(true);

  // 导出 → AI 汇总为笔记：填标题和描述
  await page.getByTestId('rec-export').click();
  await page.getByRole('menuitem', { name: 'AI 汇总为笔记…' }).click();
  await page.getByTestId('rec-note-title').fill('db12 磁盘检查');
  await page.getByTestId('rec-note-desc').fill('排查磁盘空间告警');
  await shot(page, 'ui12-15-recording-note');
  llm.enqueue({ text: '检查了磁盘和应用日志。\n\n## 操作步骤\n```sh\ndf -h\n```' });
  await page.getByTestId('rec-note-ok').click();
  await expect(page.getByTestId('rec-note-dialog')).toHaveCount(0, { timeout: 15_000 });
  const req = JSON.stringify(llm.requests.at(-1)!.body);
  expect(req).toContain('df -h');
  expect(req).toContain('排查磁盘空间告警');
  const notes = await call<{ notes: { title: string; content: string }[] }>(page, 'note.list');
  const note = notes.notes.find((n) => n.title === 'db12 磁盘检查')!;
  expect(note.content).toContain('> 排查磁盘空间告警');
  expect(note.content).toContain('## 操作步骤');
  await app.close();
});

const setting = async <T,>(page: Page, key: string): Promise<T> => (await call<Record<string, T>>(page, 'setting.getAll'))[key];
type Css = { getComputedStyle(el: unknown): { backgroundColor: string } };
// 第二十六轮起窗口底色是外框色：页面的主题底色看圆角卡片
const bodyBg = (page: Page): Promise<string> => page.locator('main.shell-frame').evaluate((el) => (globalThis as unknown as Css).getComputedStyle(el).backgroundColor);
const termBg = (page: Page): Promise<string> => page.locator('.terminal-host').first().evaluate((el) => (globalThis as unknown as Css).getComputedStyle(el).backgroundColor);

test('主题：整个软件一起换配色，终端默认跟随；终端也可以单独设置配色', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await call(page, 'setting.set', { key: 'ui.theme', value: 'dark' });
  await page.reload();
  await connect(page, 'web12');
  // 默认：iTerminal 深色，终端跟随
  expect(await bodyBg(page)).toBe('rgb(20, 20, 21)');
  expect(await termBg(page)).toBe('rgb(22, 22, 23)');

  // 外观 → 主题：只有一个主题选择，选 Dracula 后界面和终端一起变
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();
  await expect(page.locator('.settings-body')).not.toContainText('终端主题');
  await page.getByTestId('theme-trigger').click();
  const panel = page.getByTestId('theme-panel');
  await expect(panel).toContainText('深色主题');
  await expect(panel).toContainText('浅色主题');
  for (const id of ['tokyo-night', 'dracula', 'catppuccin-mocha', 'kanagawa-wave', 'cyber-punk', 'catppuccin-latte', 'material-light', 'one-light']) await expect(page.getByTestId(`theme-card-${id}`)).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'ui12-16-theme-picker');
  await page.getByTestId('theme-card-dracula').click();
  await expect.poll(() => setting<string>(page, 'ui.themeDark')).toBe('dracula');
  await expect.poll(() => bodyBg(page)).toBe('rgb(40, 42, 54)');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('theme-trigger')).toContainText('Dracula');
  await page.waitForTimeout(300);
  await shot(page, 'ui12-16a-dracula-settings');
  await page.getByTestId('nav-workspace').click();
  await expect.poll(() => termBg(page)).toBe('rgb(40, 42, 54)');
  await shot(page, 'ui12-16b-dracula-terminal');

  // 终端单独设置：深色界面用 Gruvbox，界面仍然是 Dracula
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-terminal').click();
  await page.getByTestId('terminal-colors-mode').getByText('单独设置').click();
  await page.getByTestId('terminal-scheme-dark').click();
  await page.locator('.ant-select-item-option', { hasText: 'Gruvbox Dark' }).click();
  await expect.poll(() => setting<{ follow: boolean; dark: string }>(page, 'terminal.colors')).toMatchObject({ follow: false, dark: 'gruvbox-dark' });
  await page.waitForTimeout(300);
  await shot(page, 'ui12-16c-terminal-own-colors');
  await page.getByTestId('nav-workspace').click();
  await expect.poll(() => termBg(page)).toBe('rgb(40, 40, 40)');
  expect(await bodyBg(page)).toBe('rgb(40, 42, 54)');

  // 选浅色主题：界面切到浅色；终端单独设置时浅色界面用 MobaXterm（黑底）
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();
  await page.getByTestId('theme-trigger').click();
  await page.getByTestId('theme-card-github-light').click();
  await expect.poll(() => setting<string>(page, 'ui.theme')).toBe('light');
  await expect.poll(() => bodyBg(page)).toBe('rgb(255, 255, 255)');
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-workspace').click();
  await expect.poll(() => termBg(page)).toBe('rgb(12, 12, 12)');

  // 终端右键「终端配色…」里改回跟随：终端用 GitHub Light
  await page.getByTestId('xterm-tab-1').click({ button: 'right', modifiers: ['Control'] });
  await page.getByRole('menuitem', { name: '终端配色…' }).click();
  await page.getByTestId('scheme-follow-mode').getByText('跟随应用主题').click();
  await expect(page.getByTestId('scheme-follow')).toContainText('GitHub Light');
  await page.waitForTimeout(300);
  await shot(page, 'ui12-16d-colors-dialog-follow');
  await page.locator('.scheme-modal .ant-modal-close').click();
  await expect.poll(() => termBg(page)).toBe('rgb(255, 255, 255)');
  await shot(page, 'ui12-16e-github-light');

  // iTerminal 浅色主题：终端沿用 MobaXterm 风格
  await call(page, 'setting.set', { key: 'ui.themeLight', value: 'itm-light' });
  await page.reload();
  await expect.poll(() => bodyBg(page)).toBe('rgb(252, 251, 250)');
  await call(page, 'setting.set', { key: 'ui.theme', value: 'dark' });
  await call(page, 'setting.set', { key: 'ui.themeDark', value: 'itm-dark' });
  await app.close();
});

test('外观：背景图片、光标和字号范围、本地终端环境', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await call(page, 'setting.set', { key: 'ui.theme', value: 'dark' });
  await page.reload();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();

  // 背景图片：复制进档案目录，设置页有缩略图
  const png = join(root, 'bg.png');
  writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAEklEQVR4nGPQCDjxHxkzkC4AAK54I/GIhwVzAAAAAElFTkSuQmCC', 'base64'));
  await stubDialogs(app, { open: png });
  await page.getByTestId('bg-pick').click();
  await expect(page.getByTestId('bg-thumb')).toBeVisible();
  await expect(page.locator('.bg-media-opts')).toContainText('遮罩');
  const bg = (await call<{ 'terminal.background': { kind: string; file: string } }>(page, 'setting.getAll'))['terminal.background'];
  expect(bg.kind).toBe('image');
  expect(bg.file).toMatch(/^bg-[\w-]+\.png$/);
  await page.getByTestId('cursor-style').getByText('竖线').click();
  await page.getByTestId('font-size-min').fill('10');
  await page.getByTestId('font-size-min').blur();
  await page.getByTestId('local-env').click();
  await page.locator('.ant-select-item-option', { hasText: '干净终端' }).click();
  await shot(page, 'ui12-17-appearance');
  const all = await call<Record<string, unknown>>(page, 'setting.getAll');
  expect(all).toMatchObject({ 'terminal.cursorStyle': 'bar', 'terminal.fontSizeMin': 10, 'terminal.localEnv': 'clean' });

  // 终端：背景图垫在下面，终端透明
  await connect(page, 'web12');
  await expect(page.locator('.term-backdrop img')).toHaveAttribute('src', /^itm-media:\/\/bg\//);
  await expect.poll(() => page.locator('.term-backdrop img').evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth)).toBe(4);
  await expect(page.locator('.terminal-host').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await shot(page, 'ui12-18-terminal-backdrop');

  // 干净终端：不继承应用的环境变量
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('open-local').click();
  const localId = await page.locator('[data-testid^="xterm-tab-"]').last().getAttribute('data-testid');
  await page.waitForTimeout(1500);
  await typeLine(page, localId!, 'echo "[${ITM_INSECURE_KEYSTORE}]" > ' + join(root, 'env-check.txt'));
  await expect.poll(() => (existsSync(join(root, 'env-check.txt')) ? readFileSync(join(root, 'env-check.txt'), 'utf8').trim() : ''), { timeout: 10_000 }).toBe('[]');

  // 去掉背景
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();
  await page.getByTestId('bg-clear').click();
  await page.getByRole('button', { name: '移除' }).last().click();
  await expect(page.getByTestId('bg-thumb')).toHaveCount(0);
  await call(page, 'setting.set', { key: 'terminal.localEnv', value: 'system' });
  await app.close();
});

test('离线使用（Guest）：不能用 AI、AI 设置是灰色；登录后账号卡片显示头像、用户名、邮箱和状态；关于里没有更新源', async () => {
  const userData = join(root, 'guest-userData');
  let { app, page } = await launch({ localAi: false, userData });
  await page.getByTestId('avatar-trigger').click();
  await expect(page.getByTestId('local-mode')).toContainText('Guest');
  await shot(page, 'ui12-19-guest-card');
  await page.keyboard.press('Escape');

  // AI 对话模式：锁定提示；点登录打开登录框（没有服务端地址，界面上不显示后台地址）
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-locked')).toBeVisible();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'none');
  await shot(page, 'ui12-20-ai-locked');
  await page.getByTestId('ai-locked-login').click();
  await expect(page.getByTestId('login-server')).toHaveCount(0);
  await expect(page.getByTestId('login-dialog')).not.toContainText(/127\.0\.0\.1|http/);
  await expect(page.getByTestId('login-reason')).toContainText('登录后');
  await page.keyboard.press('Escape');
  await page.getByTestId('mode-terminal').click();

  // 设置：AI 分组显示锁和灰色
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await expect(page.getByTestId('settings-ai-locked')).toBeVisible();
  await expect(page.locator('.settings-body .ai-greyed')).toHaveCount(1);
  await shot(page, 'ui12-21-settings-ai-locked');
  // 主进程同样拒绝
  const err = await page.evaluate(() =>
    (globalThis as unknown as Itm).itm.invoke('ai.providers.save', { id: null, input: { name: 'x', type: 'OPENAI_COMPAT', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', enabled: true, models: [{ id: 'm', contextWindow: 8000, maxOutput: 1000 }] } }).then(
      () => 'ok',
      (e: Error) => e.message,
    ),
  );
  expect(err).toContain('登录后才能使用 AI');

  // 关于：没有更新源设置（未配置默认后台时 feedUrl 为 null；本地 .env 配置后为对应发布源）
  await page.getByTestId('settings-nav-about').click();
  await expect(page.getByTestId('update-feed')).toHaveCount(0);
  const feedUrl = (await call<{ feedUrl: string | null }>(page, 'update.state')).feedUrl;
  if (feedUrl) expect(feedUrl).toContain('/api/v1/releases/');

  // 登录：账号卡片显示头像、用户名、邮箱、已连接
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(mock.user.username);
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', /^(valid|expired|revoked)$/, { timeout: 15_000 });
  await page.getByTestId('avatar-trigger').click();
  await expect(page.getByTestId('account-name')).toHaveText('测试用户');
  await expect(page.getByTestId('account-email')).toHaveText('tester@example.com');
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  await expect(page.getByTestId('account-avatar').locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await shot(page, 'ui12-22-account-card');
  await page.keyboard.press('Escape');
  // 登录后可以用 AI；AI 对话模式左下角也有账号卡片
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-locked')).toHaveCount(0);
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'valid');
  await shot(page, 'ui12-23-ai-account');
  await app.close();
  ({ app, page } = await launch({ localAi: false, userData }));
  await page.getByTestId('avatar-trigger').click();
  await expect(page.getByTestId('account-email')).toHaveText('tester@example.com');
  await app.close();
});
