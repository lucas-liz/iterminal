import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第三十轮：监控卡片右键菜单（打开终端、在 AI 中引用 / 引用当前状态）；主机列表导出主机记忆为 Markdown、AI 汇总为笔记。
 */
let root: string;
let ssh: TestSshServer;
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

async function addHost(page: Page, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const h = await call<{ id: string }>(page, 'host.create', {
    folderId: null, name, address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [], ...extra,
  });
  return h.id;
}

async function addModel(page: Page): Promise<void> {
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
}

async function trustIfAsked(page: Page): Promise<void> {
  const trust = page.getByRole('button', { name: '信任并连接' });
  if (await trust.isVisible({ timeout: 3000 }).catch(() => false)) await trust.click();
}

const menuItem = (page: Page, text: string) => page.locator('.host-ctx-menu:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').filter({ hasText: text });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui30-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote'), fakeLinuxMonitor: { cwd: join(root, 'remote') } });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('监控卡片右键：打开终端、引用当前状态到 AI 对话', async () => {
  const { app, page } = await launch();
  await addModel(page);
  const id = await addHost(page, 'web30', { note: '订单服务' });
  await call(page, 'setting.set', { key: 'monitor.dashboardHosts', value: [id] });
  await page.reload();
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-monitor').click();
  await trustIfAsked(page);
  const card = page.getByTestId('mon-card-web30');
  await expect(page.getByTestId('mon-cpu-web30')).toHaveText(/\d+\.\d%/, { timeout: 30_000 });
  await card.click({ button: 'right' });
  await expect(menuItem(page, '打开终端')).toBeVisible();
  await expect(menuItem(page, '在 AI 中引用这台主机')).toBeVisible();
  await shot(page, 'ui30-01-monitor-menu');
  await menuItem(page, '打开终端').click();
  await expect(page.getByTestId('tab-web30').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });

  // 有已连接的终端：到终端页右侧的 AI 面板，主机被引用，当前状态放进输入框
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-monitor').click();
  await card.click({ button: 'right' });
  await menuItem(page, '引用当前状态到 AI 对话').click();
  const side = page.getByTestId('agent-panel');
  await expect(side.getByTestId('agent-input')).toHaveValue(/主机「web30」（127\.0\.0\.1）当前监控状态[\s\S]*CPU \d/, { timeout: 10_000 });
  await expect(side.locator('.ref-chip').filter({ hasText: 'web30' }).first()).toBeVisible();
  await shot(page, 'ui30-02-monitor-quote');
  await app.close();
});

test('主机列表：导出主机记忆为 Markdown、AI 汇总为笔记、批量在 AI 中引用', async () => {
  const { app, page } = await launch();
  const all = await call<{ id: string; name: string }[]>(page, 'host.list');
  const web = all.find((h) => h.name === 'web30')?.id ?? (await addHost(page, 'web30'));
  const db = await addHost(page, 'db30', { aiMemory: '# MySQL 3306\n数据目录 /data/mysql' });
  await call(page, 'host.agentMemory.save', { id: null, hostId: web, content: 'nginx 只能 reload，不要 restart' });
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  const row = (name: string) => page.locator('.host-row').filter({ hasText: name }).first();

  // 导出一台主机的记忆
  const out = join(root, 'web30.md');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, out);
  await row('web30').click({ button: 'right' });
  await expect(menuItem(page, '导出主机记忆（Markdown）')).toBeVisible();
  await shot(page, 'ui30-03-host-menu');
  await menuItem(page, '导出主机记忆（Markdown）').click();
  await expect.poll(() => (existsSync(out) ? readFileSync(out, 'utf8') : '')).toContain('nginx 只能 reload，不要 restart');
  expect(readFileSync(out, 'utf8')).toContain('# web30 · 主机记忆');
  expect(readFileSync(out, 'utf8')).not.toContain('pw');

  // 选中两台：批量导出（只有一台有手工记忆、一台有 Agent 记忆，都列出）
  await row('web30').click();
  await row('db30').click();
  const outAll = join(root, 'all.md');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, outAll);
  await page.getByTestId('batch-ai').click();
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').filter({ hasText: '导出主机记忆' }).click();
  await expect.poll(() => (existsSync(outAll) ? readFileSync(outAll, 'utf8') : '')).toContain('## db30');
  expect(readFileSync(outAll, 'utf8')).toContain('> # MySQL 3306');
  expect(readFileSync(outAll, 'utf8')).toContain('## web30');

  // AI 汇总两台为笔记
  await addModel(page);
  llm.enqueue({ text: '两台主机：web30 跑 nginx，db30 是 MySQL。\n\n## web30\n\n### 运维要点\n\n- nginx 只能 reload' });
  const before = llm.requests.length;
  await row('web30').click({ button: 'right' });
  await menuItem(page, 'AI 汇总这 2 台为笔记').click();
  await expect(page.getByText('已用 AI 汇总为笔记「主机档案 · ')).toBeVisible({ timeout: 20_000 });
  const req = JSON.stringify(llm.requests.slice(before).map((r) => r.body));
  expect(req).toContain('主机：web30');
  expect(req).toContain('主机：db30');
  expect(req).toContain('nginx 只能 reload');
  expect(req).toContain('数据目录 /data/mysql');
  expect(req).not.toContain('"pw"');
  await shot(page, 'ui30-04-summary-done');
  await page.getByTestId('host-note-open').click();
  await expect(page.getByTestId('note-title')).toHaveValue(/主机档案 · /);
  await expect
    .poll(() =>
      page.evaluate(() => {
        type El = { value?: string; textContent: string | null } | null;
        const doc = (globalThis as unknown as { document: { querySelector(s: string): El } }).document;
        return doc.querySelector('[data-testid="note-content"]')?.value ?? doc.querySelector('[data-testid="note-editor"]')?.textContent ?? '';
      }),
    )
    .toContain('web30 跑 nginx');

  // 批量在 AI 中引用：没有打开的终端，切到 AI 对话模式，两台主机都在引用里
  await page.getByTestId('nav-hosts').click();
  await row('web30').click();
  await row('db30').click();
  await page.getByTestId('batch-ai').click();
  await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').filter({ hasText: '在 AI 中引用' }).click();
  const context = page.getByRole('complementary').filter({ hasText: '上下文' });
  await expect(context).toContainText('db30', { timeout: 10_000 });
  await expect(context).toContainText('web30');
  await shot(page, 'ui30-05-ai-refs');
  await app.close();
});
