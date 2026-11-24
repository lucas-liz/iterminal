import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 第二十四轮（文档一 6.38）：输入框「联网」开关（没有搜索服务时置灰）、联网搜索的结果卡片、设置里的联网搜索；大图发送前缩小。
 * 第二十五轮起联网搜索是独立的工具（不再用 DeepSeek 提供商的 Key）。
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

// ---------------------------------------------------------------- 生成一张大 PNG（渐变，RGB）

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function bigPng(w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = x & 0xff;
      raw[row + 2 + x * 3] = y & 0xff;
      raw[row + 3 + x * 3] = (x + y) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** 联网搜索：自己配置 DeepSeek 格式，地址指向模拟接口 */
async function configureWeb(page: Page): Promise<void> {
  await call(page, 'setting.set', { key: 'ai.webSearch', value: { source: 'personal', format: 'deepseek', baseUrl: llm.url, searchUrl: '', fetchUrl: '', count: 8, defaultOn: false } });
  await call(page, 'web.saveKey', { apiKey: 'ds-key' });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui24-'));
  mkdirSync(join(root, 'remote'), { recursive: true });
  llm = await startLlmMock();
  ssh = await startTestSshServer({ root: join(root, 'remote') });
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('联网开关：没有配置搜索服务时置灰；配置后可以打开，搜索结果显示成卡片；设置里能看到搜索服务', async () => {
  const { app, page } = await launch();
  const mock = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: '模拟模型', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-vision', contextWindow: 64000, maxOutput: 2048, supportsImages: true }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: mock.id, modelId: 'mock-vision' } });
  await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  await page.reload();
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('agent-new').click();
  await expect(page.getByTestId('web-switch')).toBeDisabled();
  await expect(page.getByTestId('web-toggle')).toHaveAttribute('data-on', '0');

  // 第二十五轮起联网搜索和模型提供商无关：自己配置 DeepSeek 格式的搜索服务（地址指向模拟接口）
  await configureWeb(page);
  await page.reload();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('models-nav-web').click();
  await expect(page.getByTestId('setting-web-status')).toContainText('当前可以联网搜索：DeepSeek');
  await shot(page, 'ui24-01-settings-web');

  // 回到 AI 对话：打开联网，模型搜索一次再回答
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('agent-new').click();
  await expect(page.getByTestId('web-switch')).toBeEnabled();
  await page.getByTestId('web-switch').click();
  await expect(page.getByTestId('web-toggle')).toHaveAttribute('data-on', '1');
  llm.enqueue({ toolCalls: [{ id: 's1', name: 'web_search', input: { query: 'nginx 502 upstream' } }] }, { text: '按 nginx.org 的说明，先确认 upstream 是否存活。' });
  const n = llm.requests.length;
  await page.getByTestId('agent-input').fill('nginx 502 一般是什么原因？');
  await page.getByTestId('agent-send').click();
  await expect(page.getByText('先确认 upstream 是否存活')).toBeVisible({ timeout: 15_000 });
  const tools = (llm.requests[n].body.tools as { function: { name: string } }[]).map((t) => t.function.name);
  expect(tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
  expect(llm.web.requests.at(-1)).toMatchObject({ path: '/v1/tools/search', body: { query: 'nginx 502 upstream', count: 8 } });
  expect(llm.web.requests.at(-1)!.headers.authorization).toBe('Bearer ds-key');
  const card = page.getByTestId('step-web');
  await expect(card).toContainText('找到 2 条结果');
  await expect(card.getByTestId('web-result')).toHaveCount(2);
  await expect(card.getByRole('link', { name: 'Nginx 502 排查' })).toHaveAttribute('href', 'https://nginx.org/502');
  await shot(page, 'ui24-02-web-search-card');

  // 开关按会话记住：新对话默认关闭
  await page.getByTestId('agent-new').click();
  await expect(page.getByTestId('web-toggle')).toHaveAttribute('data-on', '0');
  await app.close();
});

/** 只加一张图片就发送（没有别的引用变化）：以前 refs 的 useMemo 漏了 images，图片会被丢掉 */
test('大图发送前缩小：长边 3000 的截图发出去是 2048；只加图片就发送也带上图片', async () => {
  const { app, page } = await launch();
  // 单独运行时先准备一个支持图片的模型
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: '模拟模型', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-vision', contextWindow: 64000, maxOutput: 2048, supportsImages: true }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-vision' } });
    await page.reload();
  }
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('agent-new').click();
  await page.getByTestId('image-input').setInputFiles({ name: 'big.png', mimeType: 'image/png', buffer: bigPng(3000, 2000) });
  await expect(page.locator('.agent-image')).toHaveCount(1);
  llm.enqueue({ text: '收到图片' });
  const n = llm.requests.length;
  await page.getByTestId('agent-input').fill('这张图是什么');
  await page.getByTestId('agent-send').click();
  await expect(page.getByText('收到图片')).toBeVisible({ timeout: 15_000 });
  const messages = llm.requests[n].body.messages as { role: string; content: string | { type: string; image_url?: { url: string } }[] }[];
  const parts = messages.at(-1)!.content as { type: string; image_url?: { url: string } }[];
  const url = parts.find((p) => p.type === 'image_url')!.image_url!.url;
  expect(url.startsWith('data:image/png;base64,')).toBe(true);
  const png = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2048, 1365]);
  await app.close();
});

test('终端页右侧的窄面板：联网开关在 + 菜单里，打开后引用行显示「联网」，底栏不挤出去', async () => {
  const { app, page } = await launch();
  // 前面的用例已经配置了模型和搜索服务；单独运行时补上
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const d = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: 'DeepSeek', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'ds-key', enabled: true, vendor: 'deepseek', thinkingStyle: 'thinking-type', echoReasoning: true, models: [{ id: 'deepseek-flash', contextWindow: 100000, maxOutput: 8000 }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: d.id, modelId: 'deepseek-flash' } });
  }
  await configureWeb(page);
  await call(page, 'host.create', { folderId: null, name: 'web24', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web24').click();
  const dot = page.getByTestId('tab-web24').locator('.status-dot');
  await Promise.race([page.getByRole('button', { name: '信任并连接' }).click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  await expect(side.getByTestId('agent-input')).toBeVisible();
  // 底栏没有联网按钮，发送按钮在输入框里面
  await expect(side.getByTestId('web-toggle')).toHaveCount(0);
  const box = (await side.locator('.agent-input-box.composer').boundingBox())!;
  const send = (await side.locator('.composer-bar .agent-send').last().boundingBox())!;
  expect(send.x + send.width).toBeLessThanOrEqual(box.x + box.width - 4);

  await side.getByTestId('refs-expand').click();
  await expect(page.getByTestId('composer-web')).toBeVisible();
  await page.getByTestId('composer-web-switch').click();
  await expect(page.getByTestId('composer-web-switch')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(side.getByTestId('ref-chip-web')).toBeVisible();
  await shot(page, 'ui24-03-side-web-chip');
  await side.getByTestId('ref-chip-web').locator('.ref-x').click();
  await expect(side.getByTestId('ref-chip-web')).toHaveCount(0);
  await app.close();
});

