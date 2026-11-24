import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第四轮：定时任务（手动创建、Agent 创建、AI 任务等待批准）、终端配色、状态栏主机信息、步骤卡片、最大循环次数。
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
const num = (page: Page, id: string) => page.locator(`[data-testid="${id}"] input, input[data-testid="${id}"]`);

async function addHost(page: Page, name: string): Promise<string> {
  const h = await call<{ id: string }>(page, 'host.create', {
    folderId: null, name, address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
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

/** 第一次连接时确认主机指纹 */
async function trustIfAsked(page: Page): Promise<void> {
  const trust = page.getByRole('button', { name: '信任并连接' });
  if (await trust.isVisible({ timeout: 3000 }).catch(() => false)) await trust.click();
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui4-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

// 第三十五轮去掉了定时任务和监控告警
test.skip('定时任务：手动创建、风险检查、立即执行、执行记录、停用、删除', async () => {
  const { app, page } = await launch();
  await addHost(page, 'web-s');
  await page.reload();
  // 「定时任务」在「审计」下面（等导航渲染出来再读）
  await expect(page.getByTestId('nav-schedule')).toBeVisible();
  const nav = await page.locator('.sider-nav .nav-item').allTextContents();
  expect(nav.indexOf('定时任务')).toBe(nav.indexOf('运维审计') + 1);
  await page.getByTestId('nav-schedule').click();
  await expect(page.getByTestId('schedule-table')).toContainText('还没有定时任务');

  await page.getByTestId('schedule-new').click();
  await page.getByTestId('task-name').fill('磁盘巡检');
  await page.getByTestId('task-hosts').click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'web-s' }).click();
  await page.getByTestId('task-name').click();
  await page.getByTestId('task-command').fill('echo sched-e2e && df -h > /dev/null');
  await expect(page.getByTestId('task-checks')).toContainText('web-s：只读');
  await page.getByTestId('sched-kind').getByText('每隔').click();
  // 默认单位是小时，改成分钟
  await page.locator('.sched-row .ant-select').click();
  await page.locator('.ant-select-item-option').filter({ hasText: '分钟' }).click();
  await num(page, 'sched-every').fill('30');
  await expect(page.getByTestId('sched-preview')).toContainText('接下来');
  await page.getByTestId('task-ai-assist').check();
  await page.getByTestId('task-goal').fill('磁盘使用率低于 80%');
  await shot(page, 'ui4-01-task-editor');
  await page.getByTestId('task-save').click();
  const row = page.getByTestId('schedule-row-磁盘巡检');
  await expect(row).toContainText('每 30 分钟');
  await expect(row).toContainText('AI 协助');
  await expect(row).toContainText('还没执行');

  // 立即执行（第一次连接时确认指纹）
  await row.getByTestId('schedule-run').click();
  await trustIfAsked(page);
  await expect(row.getByTestId('schedule-last-status')).toHaveText('成功', { timeout: 20_000 });
  await shot(page, 'ui4-02-schedule-list');
  await row.getByTestId('schedule-history').click();
  const run = page.getByTestId('task-table').locator('.ant-table-row').first();
  await expect(run.getByTestId('task-status')).toHaveText('成功');
  await run.locator('.ant-table-row-expand-icon').click();
  await expect(page.getByTestId('task-host').first()).toContainText('sched-e2e');
  await shot(page, 'ui4-03-run-history');

  // 停用、删除；审计里有创建记录
  await page.getByRole('tab', { name: '任务' }).click();
  await row.getByTestId('schedule-toggle').click();
  await expect(row).toContainText('已停用');
  await row.getByTestId('schedule-delete').click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: /删\s*除/ }).click();
  await expect(row).toHaveCount(0);
  const audit = await call<{ items: { eventType: string | null; source: string; command: string | null }[] }>(page, 'audit.list', { kind: 'EVENT', limit: 50 });
  expect(audit.items.map((a) => a.eventType)).toEqual(expect.arrayContaining(['SCHEDULE_CREATE', 'SCHEDULE_DELETE']));
  await app.close();
});

// 第三十五轮去掉了定时任务和监控告警
test.skip('Agent 在对话里创建定时任务（需要批准）；AI 任务的写操作在定时任务页批准', async () => {
  const { app, page } = await launch();
  const hostId = await addHost(page, 'web-a');
  await addModel(page);
  // 模拟接口的回答按顺序取用：关闭 LLM 复核，避免复核请求取走剧本
  await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web-a').click();
  await trustIfAsked(page);
  await expect(page.getByTestId('tab-web-a').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });

  // 对话里让 Agent 创建：先出审批卡片，批准后才创建
  await page.getByTestId('right-ai').click();
  const panel = page.getByTestId('agent-panel');
  llm.enqueue(
    {
      toolCalls: [
        {
          id: 'c1',
          name: 'schedule_task',
          input: { name: '每天清理旧日志', hosts: ['t1'], schedule: { kind: 'daily', time: '03:00' }, command: 'find /tmp -name "*.old" -mtime +7 -print', explanation: '每天凌晨自动清理 7 天前的旧日志，避免磁盘写满' },
        },
      ],
    },
    { text: '定时任务已经创建好了。' },
  );
  await panel.getByTestId('agent-input').fill('每天凌晨 3 点帮我清理 7 天前的旧日志');
  await panel.getByTestId('agent-input').press('Enter');
  const step = panel.getByTestId('agent-step').first();
  await expect(step).toHaveAttribute('data-status', 'approval');
  await expect(step).toContainText('计划：每天 03:00');
  await expect(step.getByTestId('step-banner')).toContainText('需注意');
  await shot(page, 'ui4-04-agent-schedule-approval');
  await panel.getByTestId('approve').click();
  await panel.getByTestId('approve-confirm').click({ timeout: 3000 }).catch(() => undefined);
  await expect(panel.getByText('定时任务已经创建好了。')).toBeVisible();
  await expect(step.getByTestId('step-icon')).toHaveAttribute('data-status', 'done');

  await page.getByTestId('nav-schedule').click();
  const row = page.getByTestId('schedule-row-每天清理旧日志');
  await expect(row).toContainText('Agent');
  await expect(row).toContainText('每天 03:00');

  // AI 任务：写操作超出权限上限 → 定时任务页顶部出现审批卡片，左侧导航有数字
  await call(page, 'schedule.save', {
    id: null,
    input: { name: '整理标记', enabled: true, type: 'AGENT_PROMPT', command: null, prompt: '在家目录创建一个标记文件', hostIds: [hostId], schedule: { kind: 'interval', everyMin: 60 }, aiAssist: false, goal: null, aiPolicy: 'APPROVE', timeoutMin: 10, notifyOnFailure: true },
  });
  llm.enqueue({ toolCalls: [{ id: 'c2', name: 'run_command', input: { host: 'h1', command: 'touch ai-task.flag', explanation: '创建标记文件' } }] }, { text: '标记文件已创建。' });
  await page.getByTestId('schedule-row-整理标记').getByTestId('schedule-run').click();
  const card = page.getByTestId('schedule-approval');
  await expect(card).toContainText('touch ai-task.flag');
  await expect(card).toContainText('创建标记文件');
  await expect(page.getByTestId('nav-schedule-count')).toHaveText('1');
  await shot(page, 'ui4-05-schedule-approval');
  await card.getByTestId('schedule-approve').click();
  await expect(page.getByTestId('schedule-row-整理标记').getByTestId('schedule-last-status')).toHaveText('成功', { timeout: 20_000 });
  expect(existsSync(join(root, 'remote', 'ai-task.flag'))).toBe(true);
  await expect(page.getByTestId('nav-schedule-count')).toHaveCount(0);
  // 执行记录里可以打开 Agent 的处理过程
  await page.getByTestId('schedule-row-整理标记').getByTestId('schedule-history').click();
  await page.getByTestId('task-table').locator('.ant-table-row-expand-icon').first().click();
  await expect(page.getByTestId('task-hosts')).toContainText('标记文件已创建');
  await page.getByTestId('run-conversation').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await expect(page.getByTestId('agent-page-panel')).toContainText('touch ai-task.flag');
  await app.close();
});

test('终端配色（浅色界面默认 MobaXterm 风格、可以自定义）、状态栏主机信息、步骤卡片用图标表示成功失败、最大循环次数', async () => {
  const { app, page } = await launch();
  await addHost(page, 'web-c');
  await addModel(page);
  await page.reload();

  // 设置：终端配色和最大循环次数
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-terminal').click();
  // 第十二轮：终端配色默认跟随应用主题，单独设置时才有深色 / 浅色界面的选择
  await page.getByTestId('terminal-colors-mode').getByText('单独设置').click();
  await expect(page.getByTestId('terminal-scheme-dark')).toContainText('iTerminal 深色');
  await expect(page.getByTestId('terminal-scheme-light')).toContainText('MobaXterm');
  await page.getByTestId('terminal-colors-open').click();
  await page.getByTestId('scheme-dracula').click();
  await expect(page.getByTestId('scheme-preview')).toHaveCSS('background-color', 'rgb(40, 42, 54)');
  await page.getByTestId('scheme-use-dark').click();
  await page.getByTestId('scheme-copy').click();
  await expect(page.getByTestId('scheme-name')).toHaveValue('Dracula 副本');
  await expect(page.getByTestId('scheme-colors').locator('.scheme-color')).toHaveCount(20);
  await shot(page, 'ui4-06-terminal-colors');
  await page.locator('.scheme-modal .ant-modal-close').click();
  const colors = (await call<Record<string, { dark: string; custom: { name: string }[] }>>(page, 'setting.getAll'))['terminal.colors'];
  expect(colors.dark).toBe('dracula');
  expect(colors.custom.map((c) => c.name)).toEqual(['Dracula 副本']);
  await page.getByTestId('settings-nav-agent').click();
  await expect(num(page, 'ai-max-rounds')).toHaveValue('50');

  // 浅色界面：终端用 MobaXterm 配色（黑底）
  await call(page, 'setting.set', { key: 'ui.theme', value: 'light' });
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web-c').click();
  await trustIfAsked(page);
  await expect(page.locator('.terminal-host').first()).toHaveCSS('background-color', 'rgb(12, 12, 12)');

  // 状态栏：AI 后面是主机名和 IP，悬停显示详情
  const hostSeg = page.getByTestId('statusbar-host');
  await expect(hostSeg).toContainText('127.0.0.1');
  await hostSeg.hover();
  await expect(page.locator('.hostinfo-tip')).toContainText('用户：tester');
  const order = await page.locator('.terminal-statusbar').first().evaluate((el) => [...el.children].map((c) => c.getAttribute("data-testid") ?? c.className));
  expect(order.indexOf('statusbar-host')).toBeGreaterThan(order.indexOf('statusbar-ai'));
  await shot(page, 'ui4-07-light-terminal');

  // 步骤卡片：作用说明只显示一行，状态只显示成功 / 失败
  await page.getByTestId('right-ai').click();
  const panel = page.getByTestId('agent-panel');
  await panel.getByTestId('agent-new').click();
  const long = '查看根分区和数据盘的使用情况，确认是不是日志把磁盘写满了，以及哪些目录占用最多，方便下一步决定清理哪些内容并评估影响范围';
  llm.enqueue({ toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 't1', command: 'echo disk-ok', explanation: long } }] }, { toolCalls: [{ id: 'c2', name: 'run_command', input: { host: 't1', command: 'exit 2', explanation: '故意失败' } }] }, { text: '看完了。' });
  await panel.getByTestId('agent-input').fill('看看磁盘');
  await panel.getByTestId('agent-input').press('Enter');
  await expect(panel.getByText('看完了。')).toBeVisible();
  const [ok, bad] = [panel.getByTestId('agent-step').nth(0), panel.getByTestId('agent-step').nth(1)];
  // 成功 / 失败只显示图标，不再显示文字
  await expect(ok.getByTestId('step-icon')).toHaveAttribute('data-status', 'done');
  await expect(bad.getByTestId('step-icon')).toHaveAttribute('data-status', 'error');
  await expect(ok.getByTestId('step-status')).toHaveCount(0);
  const text = ok.getByTestId('step-explanation');
  await expect(text).toHaveCSS('white-space', 'nowrap');
  expect(await text.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await ok.getByTestId('step-banner').hover();
  await expect(page.locator('.ant-tooltip').filter({ hasText: '评估影响范围' }).last()).toBeVisible();
  await shot(page, 'ui4-08-step-cards');
  await app.close();
});
