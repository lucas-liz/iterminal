import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第三十一轮：终端标签拖动换位置、⌘W 关闭当前标签、思考默认关闭、上传前重新检查同名、
 * Agent 同一轮里的只读命令并行执行、一轮结束后执行结果收起成「执行结果 展开（N 行）」。
 */
let root: string;
let ssh: TestSshServer;
let llm: LlmMock;

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

async function prepare(page: Page): Promise<void> {
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048, reasoning: 'optional', efforts: ['low', 'medium', 'high'] }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
    // AI 复核会多调用一次模型，占掉剧本里的回答
    await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  }
  if (!(await call<{ name: string }[]>(page, 'host.list')).some((h) => h.name === 'web31')) {
    await call(page, 'host.create', { folderId: null, name: 'web31', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });
  }
}

async function connect(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId(`connect-${name}`).click();
  const dot = page.getByTestId(`tab-${name}`).locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
}

/** 标签栏里标签的顺序（标签 ID） */
const tabKeys = (page: Page): Promise<string[]> => page.locator('.topbar-tabs-scroll .ws-top-tab').evaluateAll((els) => els.map((e) => e.getAttribute('data-tab-id') ?? ''));
/** 标签栏里标签的顺序（标题） */
const tabOrder = (page: Page): Promise<string[]> => page.locator('.topbar-tabs-scroll .ws-top-tab[data-testid^="tab-"]').evaluateAll((els) => els.map((e) => (e.getAttribute('data-testid') ?? '').slice(4)));

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui31-'));
  mkdirSync(join(root, 'remote', 'up'), { recursive: true });
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('标签拖动换位置；菜单「关闭标签页」（⌘W）关闭当前标签', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web31');
  // 再开两个本地终端
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('tab-new').click();
    await page.locator('.ant-dropdown:not(.ant-dropdown-hidden) .ant-dropdown-menu-item').filter({ hasText: '本地终端' }).click();
  }
  const tabs = page.locator('.topbar-tabs-scroll .ws-top-tab');
  await expect(tabs).toHaveCount(3);
  const keys = await tabKeys(page);
  expect(await tabOrder(page)).toEqual(['web31', '本地终端', '本地终端']);

  // 像手一样拖（第三十二轮）：按下、分几步移动、松手；松手的位置不一定正好在某个标签上
  const box = async (i: number) => (await tabs.nth(i).boundingBox())!;
  const marks = page.locator('.ws-top-tab.tab-drop-before, .ws-top-tab.tab-drop-after');
  const press = async (i: number): Promise<void> => {
    const b = await box(i);
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2, { steps: 3 });
    await page.waitForTimeout(100);
  };
  // Chromium 在上一个 dragover 还没处理完时会丢掉新的：移动后原地再轻轻动两下，让停下的位置一定收到 dragover
  const moveTo = async (x: number, y: number): Promise<void> => {
    await page.mouse.move(x, y, { steps: 8 });
    for (const dx of [1, 0]) {
      await page.waitForTimeout(80);
      await page.mouse.move(x + dx, y);
    }
    await page.waitForTimeout(80);
  };
  // 1) 第一个标签拖到最后一个标签右边的空白处松手：放到最后
  let last = await box(2);
  await press(0);
  await moveTo(last.x + last.width + 10, last.y + last.height / 2);
  await expect(tabs.nth(2)).toHaveClass(/tab-drop-after/);
  await shot(page, 'ui31-00-tab-drop-mark');
  await page.mouse.up();
  await expect.poll(() => tabKeys(page)).toEqual([keys[1], keys[2], keys[0]]);
  await shot(page, 'ui31-01-tab-dragged');
  // 2) 再拖回最前面，松手时手往下偏到了终端上方：仍然放到最前
  const first = await box(0);
  await press(2);
  await moveTo(first.x + 6, first.y + first.height + 20);
  await expect(tabs.nth(0)).toHaveClass(/tab-drop-before/);
  await page.mouse.up();
  await expect.poll(() => tabKeys(page)).toEqual(keys);
  // 3) 往右拖到相邻标签的左半边：位置不会变，不显示竖线；过了它的中线才显示，松手就换过去
  const second = await box(1);
  await press(0);
  await moveTo(second.x + second.width * 0.3, second.y + second.height / 2);
  await expect(marks).toHaveCount(0);
  await moveTo(second.x + second.width * 0.75, second.y + second.height / 2);
  await expect(tabs.nth(1)).toHaveClass(/tab-drop-after/);
  await page.mouse.up();
  await expect.poll(() => tabKeys(page)).toEqual([keys[1], keys[0], keys[2]]);
  // 4) 拖出标签栏（到终端中间）：竖线消失，松手不变
  last = await box(2);
  await press(0);
  await moveTo(last.x + last.width + 10, last.y + last.height / 2);
  await expect(marks).toHaveCount(1);
  await moveTo(last.x, last.y + 260);
  await expect(marks).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await tabKeys(page)).toEqual([keys[1], keys[0], keys[2]]);
  // 换回原来的顺序，下面按原顺序检查
  await press(1);
  const head = await box(0);
  await moveTo(head.x + 4, head.y + head.height / 2);
  await page.mouse.up();
  await expect.poll(() => tabKeys(page)).toEqual(keys);

  // ⌘W：关闭当前标签（菜单项，accelerator 在 macOS 是 Cmd+W，其他系统 Ctrl+Shift+W）；窗口还在
  await page.locator(`.ws-top-tab[data-tab-id="${keys[1]}"]`).click();
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('close-tab')?.click());
  await expect(tabs).toHaveCount(2);
  expect(await tabKeys(page)).toEqual([keys[0], keys[2]]);
  const accel = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('close-tab')?.accelerator);
  expect(accel).toBe(process.platform === 'darwin' ? 'Cmd+W' : 'Ctrl+Shift+W');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await app.close();
});

test('上传：同名判断按远端当前的目录，不按面板里没刷新的旧列表', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web31');
  await page.getByTestId('right-files').click();
  await page.getByTestId('file-panel-path-edit').click();
  const pathInput = page.getByTestId('file-panel-path');
  await pathInput.fill('/up');
  await pathInput.press('Enter');
  await expect(page.getByTestId('file-panel-path')).toHaveValue('/up');
  // 面板列出空目录之后，远端（像在终端里那样）新建了同名文件：上传时要提示同名
  const local = join(root, 'a.txt');
  writeFileSync(local, 'new');
  await page.waitForTimeout(500);
  writeFileSync(join(root, 'remote', 'up', 'a.txt'), 'old');
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as unknown as typeof dialog.showOpenDialog;
  }, local);
  await page.getByTestId('file-panel-upload').click();
  // 弹窗的 testid 在 .ant-modal-root 上（本身没有尺寸），看里面的按钮和文件名
  await expect(page.getByTestId('upload-conflict-ok')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('upload-conflict-a.txt')).toBeVisible();
  await shot(page, 'ui31-02-upload-conflict');
  await page.locator('.ant-modal').filter({ has: page.getByTestId('upload-conflict-ok') }).getByRole('button', { name: '取消' }).click();
  await app.close();
});

test('思考默认关闭；Agent 同一轮的只读命令并行执行；一轮结束后执行结果收起', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web31');
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  await side.getByTestId('agent-new').click().catch(() => undefined);
  await expect(side.getByTestId('agent-model')).toHaveAttribute('data-thinking-on', '0');
  await expect(side.getByTestId('agent-model')).toHaveAttribute('data-thinking', 'auto');

  // 两条各要 2 秒的只读命令：并行执行，总共不到 4 秒
  llm.enqueue(
    {
      toolCalls: [
        { id: 'p1', name: 'run_command', input: { host: 't1', command: 'sleep 2; echo alpha-out', explanation: '第一项检查' } },
        { id: 'p2', name: 'run_command', input: { host: 't1', command: 'sleep 2; echo beta-out', explanation: '第二项检查' } },
      ],
    },
    { text: '两项检查都完成了。' },
  );
  const t0 = Date.now();
  await side.getByTestId('agent-input').fill('检查两项');
  await side.getByTestId('agent-input').press('Enter');
  // 执行过程中：和原来一样显示输出
  const steps = side.getByTestId('agent-step');
  await expect(steps).toHaveCount(2, { timeout: 10_000 });
  await expect(side.getByText('两项检查都完成了。')).toBeVisible({ timeout: 15_000 });
  expect(Date.now() - t0).toBeLessThan(3900);
  const body = JSON.stringify(llm.requests.at(-1)!.body);
  expect(body.indexOf('alpha-out')).toBeLessThan(body.indexOf('beta-out'));

  // 一轮结束：执行结果收起，只显示「执行结果 展开（N 行）」；点开才看到输出
  const first = steps.nth(0);
  await expect(first.getByTestId('step-output')).toHaveAttribute('data-folded', '1');
  await expect(first.getByTestId('step-output-toggle')).toHaveText(/展开（\d+ 行）/);
  await expect(first.locator('.step-output pre')).toHaveCount(0);
  await shot(page, 'ui31-03-folded');
  await first.getByTestId('step-output-toggle').click();
  await expect(first.locator('.step-output pre')).toContainText('alpha-out');
  await expect(first.getByTestId('step-output-toggle')).toHaveText('收起');
  await shot(page, 'ui31-04-expanded');
  await app.close();
});
