import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第十轮：@ 引用不在文字里留下 @名称；终端页 AI 面板的引用行不滚动、最右边 ··· 查看全部 / 添加引用；
 * + 里的「引用终端最近 N 行」（默认开启、200 行）。
 */
let root: string;
let ssh: TestSshServer;
let llm: LlmMock;

const LONG_HOSTS = ['ref-host-long-name-01', 'ref-host-long-name-02', 'ref-host-long-name-03', 'ref-host-long-name-04', 'ref-host-long-name-05'];

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

async function prepare(page: Page): Promise<void> {
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
  await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  for (const name of ['web10', ...LONG_HOSTS]) {
    await call(page, 'host.create', {
      folderId: null, name, address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
    });
  }
}

/** 最后一次请求里最后一条用户消息 */
const lastUserMessage = (): string => {
  const body = llm.requests.at(-1)!.body as { messages: { role: string }[] };
  return JSON.stringify(body.messages.filter((m) => m.role === 'user').at(-1));
};

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui10-'));
  mkdirSync(join(root, 'remote'), { recursive: true });
  ssh = await startTestSshServer({ root: join(root, 'remote'), sftpRealPaths: true });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('终端页 AI：@ 引用不留文字；引用行不滚动、··· 查看全部和添加引用；+ 里引用终端最近 N 行', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web10');
  await typeLine(page, 'xterm-tab-1', 'marker-before-ask');
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  await expect(side).toBeVisible();
  const input = side.getByTestId('agent-input');

  // @ 主机：加到引用行；第十二轮起输入框里留下 @名称
  await input.click();
  await input.pressSequentially('看看 ');
  for (const name of LONG_HOSTS) {
    await input.pressSequentially(`@${name}`);
    await expect(page.getByTestId('mention-item').first()).toContainText(name);
    await input.press('Enter');
    await expect(page.getByTestId('mention-popup')).toHaveCount(0);
  }
  await expect(input).toHaveValue(`看看 ${LONG_HOSTS.map((n) => `@${n} `).join('')}`);
  await input.fill('看看 ');

  // 第十二轮：引用行一行显示全部，放不下时左右滑动（不显示滚动条）；最右边的 ··· 显示引用个数
  const bar = side.locator('.agent-refs-bar');
  await expect(bar).toHaveCSS('overflow-x', 'auto');
  const more = side.getByTestId('refs-more');
  await expect(more).toBeVisible();
  await expect(side.getByTestId('refs-count')).toHaveText(String(1 + LONG_HOSTS.length));
  // 第三十三轮起引用的主机多于 3 台时合成一个「N 台主机」标签（可以批量清理），引用行不再横向溢出
  await expect(bar).toContainText(`${1 + LONG_HOSTS.length} 台主机`);
  const box = await bar.boundingBox();
  const moreBox = await more.boundingBox();
  expect(moreBox!.x).toBeGreaterThanOrEqual(box!.x + box!.width - 1);
  await shot(page, 'ui10-01-refs-bar');

  // ··· 里是全部引用（可以去掉）和添加引用
  await more.click();
  const panel = page.getByTestId('refs-more-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.refs-more-chips')).toContainText(`${1 + LONG_HOSTS.length} 台主机`);
  await expect(panel.getByTestId('refs-panel')).toBeVisible();
  await page.waitForTimeout(300);
  await shot(page, 'ui10-02-refs-more');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  // 「N 台主机」点开是全部引用的主机，可以逐个去掉
  await bar.getByTestId('ref-chip-hosts').click();
  const hostsPanel = page.getByTestId('host-refs-panel');
  for (const name of ['web10', ...LONG_HOSTS]) await expect(hostsPanel).toContainText(name);
  await hostsPanel.getByTestId('host-refs-row').filter({ hasText: LONG_HOSTS[4] }).getByTestId('host-refs-x').click();
  await expect(hostsPanel).not.toContainText(LONG_HOSTS[4]);
  await page.keyboard.press('Escape');

  // + 里：引用终端最近 N 行，默认开启、200 行
  await side.getByTestId('refs-expand').click();
  const term = page.getByTestId('composer-term-ctx');
  await expect(term).toBeVisible();
  await expect(page.getByTestId('composer-term-switch')).toHaveAttribute('aria-checked', 'true');
  await expect(term.locator('.composer-term-lines input')).toHaveValue('200');
  await page.waitForTimeout(300);
  await shot(page, 'ui10-03-plus-terminal-lines');
  await page.keyboard.press('Escape');

  // 开启：发送时带上终端最近输出
  llm.enqueue({ text: '回答一' });
  await input.fill('终端里刚才输出了什么');
  await input.press('Enter');
  await expect(side.getByText('回答一')).toBeVisible();
  expect(lastUserMessage()).toContain('最近输出');
  expect(lastUserMessage()).toContain('marker-before-ask');

  // 关闭后不带终端输出（设置会记住）
  await side.getByTestId('refs-expand').click();
  await page.getByTestId('composer-term-switch').click();
  await expect(page.getByTestId('composer-term-switch')).toHaveAttribute('aria-checked', 'false');
  await expect(term.locator('.composer-term-lines input')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await call<Record<string, unknown>>(page, 'setting.getAll'))['ai.terminalContext']).toEqual({ enabled: false, lines: 200 });
  await typeLine(page, 'xterm-tab-1', 'marker-while-off');
  llm.enqueue({ text: '回答二' });
  await input.fill('现在呢');
  await input.press('Enter');
  await expect(side.getByText('回答二')).toBeVisible();
  expect(lastUserMessage()).not.toContain('最近输出');
  expect(lastUserMessage()).not.toContain('marker-while-off');

  // 重新开启并改成 50 行
  await side.getByTestId('refs-expand').click();
  await page.getByTestId('composer-term-switch').click();
  const lines = term.locator('.composer-term-lines input');
  await lines.fill('50');
  await lines.press('Tab');
  await expect.poll(async () => (await call<Record<string, unknown>>(page, 'setting.getAll'))['ai.terminalContext']).toEqual({ enabled: true, lines: 50 });
  await page.keyboard.press('Escape');
  llm.enqueue({ text: '回答三' });
  await input.fill('再看看');
  await input.press('Enter');
  await expect(side.getByText('回答三')).toBeVisible();
  // 关闭期间的新输出在重新开启后带上
  expect(lastUserMessage()).toContain('marker-while-off');
  await app.close();
});
