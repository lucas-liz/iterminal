import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第二十七轮：监控（常驻 / 随终端、需要注意、筛选、添加常驻）、定时任务 AI 任务（试运行生成方案 → 执行 → 报告、回放、筛选）、数据库两步式新建。
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

async function addHost(page: Page, name: string, port = ssh.port, note: string | null = null): Promise<string> {
  const h = await call<{ id: string }>(page, 'host.create', {
    folderId: null, name, address: '127.0.0.1', port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note, jumpHostIds: [],
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

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui27-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote'), fakeLinuxMonitor: { cwd: join(root, 'remote') } });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('监控：常驻和随终端分开显示，标出连不上的主机，按名称 / IP / 备注筛选，批量添加常驻', async () => {
  const { app, page } = await launch();
  await addHost(page, 'web-a', ssh.port, '订单服务');
  await addHost(page, 'db-b', ssh.port, '主库');
  await addHost(page, 'gone-c', 1, '已下线的机器');
  await page.reload();

  // 打开 db-b 的终端：出现在「随终端」
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-db-b').click();
  await trustIfAsked(page);
  await expect(page.getByTestId('tab-db-b').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-monitor').click();
  await expect(page.getByTestId('mon-section-session').getByTestId('mon-card-db-b')).toBeVisible();
  await expect(page.getByTestId('mon-section-resident')).toContainText('还没有常驻主机');

  // 添加常驻：搜索、勾选两台
  await page.getByTestId('mon-add').click();
  await page.getByTestId('resident-search').fill('订单');
  await expect(page.getByTestId('resident-table').locator('.ant-table-row')).toHaveCount(1);
  await page.getByTestId('resident-table').locator('.ant-table-row').first().click();
  await page.getByTestId('resident-search').fill('');
  await page.getByTestId('resident-table').locator('.ant-table-row').filter({ hasText: 'gone-c' }).click();
  await shot(page, 'ui27-01-resident-picker');
  await page.getByTestId('resident-save').click();

  const resident = page.getByTestId('mon-section-resident');
  await expect(resident.getByTestId('mon-card-web-a')).toBeVisible();
  await expect(resident.getByTestId('mon-card-gone-c')).toBeVisible();
  await expect(page.getByTestId('mon-cpu-web-a')).toHaveText(/\d+\.\d%/, { timeout: 20_000 });
  await expect(resident.getByTestId('mon-card-gone-c')).toHaveAttribute('data-level', 'offline', { timeout: 20_000 });
  await expect(page.getByTestId('mon-card-web-a')).toContainText('加入常驻');
  await shot(page, 'ui27-02-monitor');

  // 筛选：按备注搜索；只看连不上的
  await page.getByTestId('mon-search').fill('主库');
  await expect(page.locator('.mon-card')).toHaveCount(1);
  await page.getByTestId('mon-search').fill('');
  await page.locator('.mon-sum.lv-offline').click();
  await expect(page.locator('.mon-card')).toHaveCount(1);
  await expect(page.locator('.mon-card').first()).toHaveAttribute('data-testid', 'mon-card-gone-c');
  await page.locator('.mon-sum.lv-offline').click();

  // 第三十五轮去掉了告警设置：顶部栏没有告警入口
  await expect(page.getByTestId('mon-alert-settings')).toHaveCount(0);

  // 随终端的卡片设为常驻；常驻的取消
  await page.getByTestId('mon-pin-db-b').click();
  await expect(resident.getByTestId('mon-card-db-b')).toBeVisible();
  await page.getByTestId('mon-pin-gone-c').click();
  await expect(page.getByTestId('mon-card-gone-c')).toHaveCount(0);
  const ids = await call<string[]>(page, 'setting.getAll').then((s) => (s as unknown as Record<string, string[]>)['monitor.dashboardHosts']);
  expect(ids).toHaveLength(2);
  await app.close();
});

// 第三十五轮去掉了定时任务和监控告警
test.skip('定时任务：AI 试运行生成执行方案，按方案执行后 AI 写报告，可以看每条命令的结果、回放和按结论筛选', async () => {
  const { app, page } = await launch();
  await addModel(page);
  await page.reload();
  await page.getByTestId('nav-schedule').click();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('task-type').getByText('AI 任务').click();
  await page.getByTestId('task-name').fill('服务巡检');
  await page.getByTestId('task-hosts').click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'web-a' }).click();
  await page.getByTestId('task-name').click();
  await page.getByTestId('task-prompt').fill('检查服务进程和磁盘，磁盘快满时提醒');
  await expect(page.getByTestId('plan-fields')).toContainText('还没有执行方案');

  // 试运行：AI 用只读命令看一遍，最后给出方案
  llm.enqueue(
    { toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 'h1', command: 'echo svc-ok', explanation: '看看服务' } }] },
    { text: '服务正常，磁盘充足。\n```json\n{"steps":[{"host":"*","command":"echo svc-ok","purpose":"服务状态"},{"host":"*","command":"df -h / | tail -1","purpose":"磁盘"}],"report":"磁盘超过 85% 算需要注意"}\n```' },
  );
  // 第二十九轮：在后台生成（先保存任务），生成好后自动设置并填进编辑框
  await page.getByTestId('plan-generate').click();
  await trustIfAsked(page);
  await expect(page.getByTestId('plan-step')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.getByTestId('plan-report')).toHaveValue('磁盘超过 85% 算需要注意');
  await page.getByTestId('plan-trial-report').getByText('AI 生成方案时的检查报告').click();
  await expect(page.getByTestId('plan-trial-report')).toContainText('服务正常');
  await expect(page.getByTestId('plan-risk').first()).toHaveText('只读');
  await shot(page, 'ui27-04-plan-editor');
  await page.getByTestId('task-save').click();

  const row = page.getByTestId('schedule-row-服务巡检');
  await expect(row).toContainText('方案 2 条命令');
  // 执行：报告由 AI 写
  llm.respond((body) => (JSON.stringify(body).includes('巡检报告助手') ? { text: '结论：需要注意\n## 概览\n服务正常，但根分区使用率偏高。\n## 需要处理\n- 清理 /var/log' } : undefined));
  await row.getByTestId('schedule-run').click();
  await expect(row.getByTestId('schedule-last-status')).toHaveText('成功', { timeout: 20_000 });
  await row.getByTestId('schedule-history').click();
  const run = page.getByTestId('task-table').locator('.ant-table-row').first();
  await expect(run.getByTestId('run-level')).toHaveText('需要注意');
  await run.click();
  await expect(page.getByTestId('run-report')).toContainText('根分区使用率偏高');
  await expect(page.getByTestId('task-host').first()).toContainText('服务状态');
  await expect(page.getByTestId('run-replay')).toBeVisible();
  await shot(page, 'ui27-05-run-report');
  await page.getByTestId('run-replay').click();
  await expect(page.locator('.ant-modal').filter({ hasText: 'echo svc-ok' }).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, 'ui27-06-run-replay');
  await page.keyboard.press('Escape');

  // 按结论筛选
  await page.getByTestId('run-status-filter').click();
  await page.locator('.ant-select-item-option').filter({ hasText: '有问题' }).click();
  await expect(page.getByTestId('task-table').locator('.ant-table-row')).toHaveCount(1);
  await page.getByTestId('run-status-filter').click();
  await page.locator('.ant-select-item-option').filter({ hasText: /^失败$/ }).click();
  await expect(page.getByTestId('task-table')).toContainText('没有符合条件的执行记录');
  await page.getByRole('tab', { name: '任务' }).click();
  await expect(page.getByTestId('schedule-overview')).toContainText('最近 7 天有问题');
  await shot(page, 'ui27-07-schedule-list');
  await app.close();
});

test('数据库：先选数据库（带图标，Redis 等即将支持），再填连接信息', async () => {
  const { app, page } = await launch();
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-databases').click();
  const mgr = page.getByText('连接管理');
  if (await mgr.isVisible().catch(() => false)) await mgr.click();
  await page.getByTestId('db-new').click();
  await expect(page.getByTestId('db-picker')).toBeVisible();
  await expect(page.getByTestId('db-product-tdengine')).toBeDisabled();
  await shot(page, 'ui27-08-db-picker');
  await page.getByTestId('db-product-tidb').click();
  await expect(page.getByTestId('db-port')).toHaveValue('4000');
  await expect(page.getByTestId('db-type')).toHaveAttribute('data-flavor', 'tidb');
  await shot(page, 'ui27-09-db-form');
  await app.close();
});
