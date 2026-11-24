import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第二十八轮：主机记忆策略（验证过的自动记录、不确定的 10 秒跳过）、外部告警接入 → 告警记录 → AI 自动排查、定时任务和监控的告警设置。
 */
let root: string;
let ssh: TestSshServer;
let llm: LlmMock;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
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

async function prepare(page: Page): Promise<void> {
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
  await call(page, 'host.create', { folderId: null, name: 'web28', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: '订单服务', jumpHostIds: [] });
  await page.reload();
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui28-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote'), fakeLinuxMonitor: { cwd: join(root, 'remote') } });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('主机记忆：验证过的直接记录；不确定的显示倒计时，10 秒没有确认就跳过', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web28').click();
  await page.getByRole('button', { name: '信任并连接' }).click({ timeout: 8000 }).catch(() => undefined);
  await expect(page.getByTestId('tab-web28').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  llm.enqueue(
    { toolCalls: [{ id: 'm1', name: 'memory_propose', input: { host: 't1', memory: 'nginx 配置在 /etc/nginx/conf.d', certainty: 'confirmed' } }] },
    { toolCalls: [{ id: 'm2', name: 'memory_propose', input: { host: 't1', memory: '可能每晚 2 点有备份', certainty: 'uncertain' } }] },
    { text: '看完了' },
  );
  await side.getByTestId('agent-input').fill('看看 nginx');
  await side.getByTestId('agent-send').click();
  await expect(side.getByTestId('memory-auto')).toBeVisible({ timeout: 15_000 });
  await expect(side.getByTestId('step-countdown')).toBeVisible();
  await shot(page, 'ui28-01-memory-countdown');
  await expect(side.getByText('看完了')).toBeVisible({ timeout: 15_000 });
  await expect(side).toContainText('10 秒内没有确认');
  await shot(page, 'ui28-02-memory-skipped');
  await app.close();
});

// 第三十五轮去掉了定时任务和监控告警
test.skip('告警设置：监控的告警阈值里有邮件通知；定时任务可以选告警条件和邮件通知', async () => {
  const { app, page } = await launch();
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-monitor').click();
  await page.getByTestId('mon-alert-settings').click();
  await expect(page.getByTestId('mon-alert-email')).toBeVisible();
  await shot(page, 'ui28-06-monitor-alert-settings');
  await page.keyboard.press('Escape');
  await page.getByTestId('nav-schedule').click();
  await page.getByTestId('schedule-new').click();
  await expect(page.getByTestId('task-alert')).toContainText('失败或结论异常时告警');
  await expect(page.getByTestId('task-alert-email')).toBeChecked();
  await page.getByTestId('task-alert').scrollIntoViewIfNeeded();
  await shot(page, 'ui28-07-task-alert');
  await app.close();
});
