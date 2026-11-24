import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { probeResponder, startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第二十五轮（文档一 6.39）：AI 模型设置改成 NewMax 式的双栏（启用的模型 / 详情），添加模型按分类挑选，
 * 从服务商拉取模型列表、模型设置弹窗（能力、思考档位、检测模型能力），联网搜索独立配置，图片识别 Fallback。
 */
let root: string;
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
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'shots', `${name}.png`) });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui25-'));
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('添加模型：分类卡片 → 拉取模型列表 → 模型设置（检测能力）→ 测试连接并激活', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  // 还没有模型服务：右边直接是添加列表，推荐服务在前
  await expect(page.getByTestId('vendor-catalog')).toBeVisible();
  await expect(page.getByTestId('vendor-deepseek')).toBeVisible();
  await shot(page, 'ui25-01-catalog');
  await page.getByTestId('vendor-tabs').getByText('海外平台').click();
  await expect(page.getByText('访问海外模型需要代理')).toBeVisible();
  await page.getByTestId('vendor-tabs').getByText('本地模型').click();
  await expect(page.getByTestId('vendor-custom')).toBeVisible();
  await page.getByTestId('vendor-tabs').getByText('推荐服务').click();
  await page.getByTestId('vendor-deepseek').click();

  // 配置 DeepSeek：地址指向模拟接口，从服务商拉取模型列表
  await expect(page.getByTestId('provider-url')).toHaveValue('https://api.deepseek.com');
  await expect(page.getByTestId('vendor-key-link')).toHaveAttribute('href', /platform\.deepseek\.com/);
  await page.getByTestId('provider-url').fill(llm.url);
  await page.getByTestId('provider-key').fill('ds-key');
  await page.getByTestId('fetch-models').click();
  await expect(page.locator('.fetch-model-row')).toHaveCount(4);
  await page.locator('.fetch-model-row').filter({ hasText: 'deepseek-flash' }).locator('input').check();
  await page.locator('.fetch-model-row').filter({ hasText: 'mock-vision' }).locator('input').check();
  await shot(page, 'ui25-02-import');
  await page.getByTestId('fetch-models-ok').click();
  await expect(page.getByTestId('model-id')).toHaveCount(2);
  // 已知模型自动带上能力（DeepSeek V4.1 Flash：图片 + 思考），第一个是主模型
  await expect(page.getByTestId('model-row').first()).toContainText('主模型');
  await expect(page.getByTestId('model-row').first()).toContainText('图');
  await expect(page.getByTestId('model-row').first()).toContainText('思');

  // 模型设置弹窗：检测模型能力（模拟接口按能力回答）
  llm.respond(probeResponder({ images: true, tools: true, thinking: 'optional', efforts: ['low', 'medium', 'high'] }));
  await page.getByTestId('model-advanced').nth(1).click();
  await expect(page.getByTestId('model-context')).toHaveValue('256K');
  await page.getByTestId('model-probe').click();
  await expect(page.getByTestId('probe-summary')).toContainText('✓图 ✓工具 ✓思考', { timeout: 15_000 });
  await expect(page.getByTestId('cap-images')).toHaveAttribute('data-on', '1');
  await expect(page.getByTestId('level-off')).toHaveAttribute('data-on', '1');
  await expect(page.getByTestId('level-medium')).toHaveAttribute('data-on', '1');
  await expect(page.getByTestId('level-max')).toHaveAttribute('data-on', '0');
  await shot(page, 'ui25-03-model-dialog');
  // 手动改一下，再恢复检测结果
  await page.getByTestId('level-max').click();
  await expect(page.getByTestId('model-probe-restore')).toBeVisible();
  await page.getByTestId('model-probe-restore').click();
  await expect(page.getByTestId('level-max')).toHaveAttribute('data-on', '0');
  await page.getByTestId('model-dialog-ok').click();

  // 测试连接并激活：保存后成为默认
  await page.getByTestId('provider-activate').click();
  const item = page.locator('.provider-item').filter({ hasText: 'DeepSeek' });
  await expect(item).toContainText('默认');
  await expect(item).toContainText('deepseek-flash');
  const saved = (await call<{ vendor: string; models: { id: string; probe?: { tools: boolean }; efforts?: string[] }[] }[]>(page, 'ai.providers.list')).find((p) => p.vendor === 'deepseek')!;
  expect(saved.models.map((m) => m.id)).toEqual(['deepseek-flash', 'mock-vision']);
  expect(saved.models[1]).toMatchObject({ probe: { tools: true }, efforts: ['low', 'medium', 'high'] });
  await shot(page, 'ui25-04-provider');
  llm.respond(null);
  await app.close();
});

test('联网搜索：独立配置（自己的 Key、DeepSeek 格式），默认关闭；图片识别 Fallback 只列能看图的模型', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('models-nav-web').click();
  // 没登录：服务端默认不可用
  await expect(page.getByTestId('setting-web-status')).toContainText('需要登录');
  await expect(page.getByTestId('setting-web-default')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('setting-web-source').getByText('自己配置').click();
  await page.getByTestId('setting-web-base').fill(llm.url);
  await page.getByTestId('setting-web-base').blur();
  await expect(page.getByTestId('setting-web-status')).toContainText('API Key');
  await page.getByTestId('setting-web-key').fill('web-key');
  await page.getByTestId('setting-web-key-save').click();
  await expect(page.getByTestId('setting-web-status')).toContainText('当前可以联网搜索：DeepSeek');
  await page.getByTestId('setting-web-test').click();
  await expect(page.getByTestId('setting-web-test-result')).toContainText('2 条结果');
  expect(llm.web.requests.at(-1)!.headers.authorization).toBe('Bearer web-key');
  await shot(page, 'ui25-05-web-search');

  await page.getByTestId('models-nav-vision').click();
  await page.getByTestId('setting-vision-enabled').click();
  await page.getByTestId('setting-vision-model').click();
  const options = page.locator('.ant-select-item-option');
  await expect(options).toHaveCount(2);
  await options.filter({ hasText: 'mock-vision' }).click();
  await shot(page, 'ui25-06-vision');
  expect((await call<{ 'ai.visionFallback': { enabled: boolean; model: { modelId: string } } }>(page, 'setting.getAll'))['ai.visionFallback']).toMatchObject({ enabled: true, model: { modelId: 'mock-vision' } });

  // 对话里的联网开关：可以打开，默认关闭
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('agent-new').click();
  await expect(page.getByTestId('web-switch')).toBeEnabled();
  await expect(page.getByTestId('web-toggle')).toHaveAttribute('data-on', '0');
  await app.close();
});
