import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 第二十六轮（文档一 6.40）：参考 NewMax 的界面——圆角卡片外框、选中的终端标签和终端连成一体、
 * 模型 / 思考强度的级联菜单、对话左侧的定位条、AI 反问的选项卡片、设置合并成 9 个分组、运维审计和录像 AI 汇总。
 */
let root: string;
let llm: LlmMock;
let ssh: TestSshServer;

test.describe.configure({ mode: 'serial' });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  // 上一个用例停在中途时剩下的剧本不留给下一个用例
  llm?.clear();
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

/** 级联菜单：悬停父项直到子菜单里的目标出现（子菜单是悬停延迟展开的，单次 hover 在机器忙时可能没展开） */
async function hoverUntil(parent: ReturnType<Page['getByTestId']>, target: ReturnType<Page['getByTestId']>): Promise<void> {
  await expect(async () => {
    await parent.hover();
    await expect(target.first()).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
}

async function prepare(page: Page): Promise<void> {
  if ((await call<unknown[]>(page, 'ai.providers.list')).length) return;
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: {
      name: 'Effort 模型',
      type: 'OPENAI_COMPAT',
      baseUrl: llm.url,
      apiKey: 'k',
      enabled: true,
      thinkingStyle: 'openai-effort',
      models: [
        { id: 'mock-effort', contextWindow: 64000, maxOutput: 4096, reasoning: 'optional', efforts: ['low', 'medium', 'high'] },
        { id: 'mock-plain', contextWindow: 64000, maxOutput: 4096 },
      ],
    },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-effort' } });
  await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  await call(page, 'setting.set', { key: 'ui.theme', value: 'light' });
  await call(page, 'host.create', { folderId: null, name: 'web26', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });
  await page.reload();
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui26-'));
  mkdirSync(join(root, 'sftp'), { recursive: true });
  llm = await startLlmMock();
  ssh = await startTestSshServer({ root: join(root, 'sftp'), username: 'tester', password: 'pw' });
});

test.afterAll(async () => {
  await llm?.close();
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('外框和标签：页面是圆角卡片；标签在顶部栏（第三十四轮），终端窗格和状态栏之间没有缝', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web26').click();
  const dot = page.getByTestId('tab-web26').locator('.status-dot');
  await Promise.race([page.getByRole('button', { name: '信任并连接' }).click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  await expect(page.locator('main.shell-frame')).toHaveCSS('border-top-left-radius', /^\d+(\.\d+)?px$/);
  // 等连接进度小窗消失再量
  await expect(page.locator('.conn-overlay')).toHaveCount(0, { timeout: 10_000 });
  // 选中的标签在顶部栏里
  await expect(page.locator('.app-topbar .ws-top-tab.active')).toHaveAttribute('data-testid', 'tab-web26');
  // 状态栏下面不能再透出一条终端底色（窗格以前有 1px 透明边框）
  const gap = await page.evaluate(() => {
    const w = globalThis as unknown as { document: { querySelector(s: string): { getBoundingClientRect(): { bottom: number } } } };
    const bar = w.document.querySelector('.workspace-pane-slot:not(.hidden) .terminal-statusbar').getBoundingClientRect().bottom;
    const pane = w.document.querySelector('.workspace-pane-slot:not(.hidden) .pane').getBoundingClientRect().bottom;
    return pane - bar;
  });
  expect(gap).toBeLessThan(0.5);
  await shot(page, 'ui26-01-workspace');
  await app.close();
});

test('模型选择：服务商 → 模型、思考强度 → 档位，一个按钮显示「模型 档位」；发送时带上选的档位', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('mode-ai').click();
  const ai = page.getByTestId('agent-page-panel');
  await ai.getByTestId('agent-new').click();
  const picker = ai.getByTestId('agent-model');
  await expect(picker).toContainText('mock-effort');
  // 第三十一轮：默认关闭思考，「自动」时按钮显示实际生效的「关闭」
  await expect(picker).toContainText('关闭');

  await picker.click();
  await hoverUntil(page.getByTestId('thinking-menu'), page.getByTestId('thinking-level'));
  await expect(page.getByTestId('thinking-level')).toHaveText(['自动', '关闭', '低', '中', '高']);
  await shot(page, 'ui26-02-thinking-menu');
  await page.getByTestId('thinking-level').filter({ hasText: '高' }).click();
  await expect(picker).toContainText('高');
  await expect(picker).toHaveAttribute('data-thinking', 'high');

  llm.enqueue({ text: '高强度回答' });
  const n = llm.requests.length;
  await ai.getByTestId('agent-input').fill('测试思考强度');
  await ai.getByTestId('agent-send').click();
  await expect(ai.getByText('高强度回答')).toBeVisible({ timeout: 15_000 });
  expect(llm.requests[n].body).toMatchObject({ model: 'mock-effort', reasoning_effort: 'high' });
  // 回答上方显示服务商 / 模型
  await expect(ai.getByTestId('agent-msg-model').last()).toContainText('Effort 模型 / mock-effort');

  // 关闭思考
  await picker.click();
  await hoverUntil(page.getByTestId('thinking-menu'), page.getByTestId('thinking-level').filter({ hasText: '关闭' }));
  await page.getByTestId('thinking-level').filter({ hasText: '关闭' }).click();
  await expect(picker).toContainText('关闭');
  llm.enqueue({ text: '不思考的回答' });
  await ai.getByTestId('agent-input').fill('再来');
  await ai.getByTestId('agent-send').click();
  await expect(ai.getByText('不思考的回答')).toBeVisible({ timeout: 15_000 });
  expect(llm.requests.at(-1)!.body).toMatchObject({ reasoning_effort: 'none' });

  // 换成不支持思考的模型：思考强度置灰，按钮上不显示档位
  await picker.click();
  // 悬停服务商、点子菜单里的模型；子菜单偶尔在鼠标移过去时收起，整段重试
  await expect(async () => {
    if (!(await page.getByTestId('model-provider').first().isVisible())) await picker.click();
    await hoverUntil(page.getByTestId('model-provider').first(), page.getByTestId('model-item').filter({ hasText: 'mock-plain' }));
    await page.getByTestId('model-item').filter({ hasText: 'mock-plain' }).click({ timeout: 2000 });
  }).toPass({ timeout: 20_000 });
  await expect(picker).toContainText('mock-plain');
  await expect(picker.locator('.model-picker-thinking')).toHaveCount(0);
  await app.close();
});

test('定位条：每个提问一条横线，悬停显示问题和回答摘要，点击滚到那个提问', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('mode-ai').click();
  const ai = page.getByTestId('agent-page-panel');
  await ai.getByTestId('agent-new').click();
  await expect(ai.getByTestId('conv-rail')).toHaveCount(0);
  const long = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行说明`).join('\n\n');
  for (const q of ['第一个问题：磁盘', '第二个问题：内存', '第三个问题：网络']) {
    llm.enqueue({ text: `关于${q.slice(6)}的回答。\n\n${long}` });
    await ai.getByTestId('agent-input').fill(q);
    await ai.getByTestId('agent-send').click();
    await expect(ai.getByTestId('agent-user-msg').filter({ hasText: q })).toBeVisible();
    await expect(ai.getByText(`关于${q.slice(6)}的回答`)).toBeVisible({ timeout: 15_000 });
  }
  const ticks = ai.getByTestId('conv-rail-tick');
  await expect(ticks).toHaveCount(3);
  await expect(ticks.nth(2)).toHaveClass(/active/);
  // 悬停第一条（列表刚滚完时定位条会重新居中，悬停没对准就再来一次）
  await expect(async () => {
    await ticks.nth(0).hover();
    await expect(ai.getByTestId('conv-rail-card')).toContainText('第一个问题：磁盘', { timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  await expect(ai.getByTestId('conv-rail-card')).toContainText('关于磁盘的回答');
  await shot(page, 'ui26-03-rail');
  await ticks.nth(0).click();
  await expect(ai.getByTestId('agent-user-msg').filter({ hasText: '第一个问题' })).toBeInViewport();
  await expect(ticks.nth(0)).toHaveClass(/active/);
  await app.close();
});

test('AI 反问：选项带说明和推荐，点一下或按数字键回答；多选勾好后提交；也可以自己输入', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('mode-ai').click();
  const ai = page.getByTestId('agent-page-panel');
  await ai.getByTestId('agent-new').click();

  // 单选：推荐的排第一，按 2 选第二个
  llm.enqueue(
    {
      toolCalls: [
        {
          id: 'q1',
          name: 'ask_user',
          input: {
            question: '配置检查通过，接下来怎么做？',
            options: [{ label: 'restart', description: '完全重启，会断开连接' }, { label: 'reload', description: '平滑加载新配置' }, '先不处理'],
            recommended: 1,
          },
        },
      ],
    },
    { text: '已按你的选择 reload 之外的方案处理' },
  );
  const n = llm.requests.length;
  await ai.getByTestId('agent-input').fill('处理 nginx');
  await ai.getByTestId('agent-send').click();
  const opts = ai.getByTestId('ask-option');
  await expect(opts).toHaveCount(3, { timeout: 15_000 });
  await expect(opts.nth(0)).toContainText('reload');
  await expect(opts.nth(0)).toContainText('推荐');
  await expect(opts.nth(0)).toContainText('平滑加载新配置');
  await expect(opts.nth(1)).toContainText('restart');
  await shot(page, 'ui26-04-ask');
  await page.locator('body').click({ position: { x: 5, y: 600 } });
  await page.keyboard.press('2');
  await expect(ai.getByTestId('ask-answer')).toHaveText('restart');
  await expect(ai.getByText('已按你的选择')).toBeVisible({ timeout: 15_000 });
  const toolMsg = JSON.stringify(llm.requests.at(-1)!.body.messages);
  expect(toolMsg).toContain('用户回答：restart');
  // 工具说明里要求给出选项
  const askTool = (llm.requests[n].body.tools as { function: { name: string; description: string; parameters: { properties: Record<string, unknown> } } }[]).find((t) => t.function.name === 'ask_user')!;
  expect(askTool.function.description).toContain('选项');
  expect(Object.keys(askTool.function.parameters.properties)).toEqual(expect.arrayContaining(['options', 'recommended', 'multi_select']));

  // 多选：勾两个再加一句自己的话
  llm.enqueue({ toolCalls: [{ id: 'q2', name: 'ask_user', input: { question: '要处理哪些主机？', options: ['web-01', 'web-02', 'db-01'], multi_select: true } }] }, { text: '好的，处理这些主机' });
  await ai.getByTestId('agent-input').fill('批量处理');
  await ai.getByTestId('agent-send').click();
  const opts2 = ai.locator('.step-card.question.waiting').getByTestId('ask-option');
  await expect(opts2).toHaveCount(3, { timeout: 15_000 });
  await expect(ai.locator('.step-card.question.waiting')).toContainText('可多选');
  await opts2.nth(0).click();
  await opts2.nth(2).click();
  await expect(opts2.nth(0)).toHaveClass(/on/);
  await ai.locator('.step-card.question.waiting').getByTestId('ask-input').fill('先别动生产');
  await ai.locator('.step-card.question.waiting').getByTestId('ask-submit').click();
  await expect(ai.getByTestId('ask-answer').last()).toHaveText('web-01、db-01、先别动生产');
  await expect(ai.getByText('好的，处理这些主机')).toBeVisible({ timeout: 15_000 });
  await app.close();
});

test('设置：9 个分组、页内标签切换；长说明收进「?」；Guest 的账户卡片有登录', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await expect(page.locator('.settings-nav-item')).toHaveCount(9);
  await expect(page.locator('.settings-nav-group')).toHaveText(['账户与偏好', 'AI 与服务', '系统信息']);

  await page.getByTestId('settings-nav-agent').click();
  await expect(page.locator('.topbar-page-sub.keep')).toHaveText('Agent 与安全');
  await expect(page.getByTestId('settings-tab-agent')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('settings-tab-cmdsec').click();
  await expect(page.getByTestId('settings-tab-cmdsec')).toHaveAttribute('aria-selected', 'true');
  // 长说明不直接显示，悬停「?」查看
  await page.getByTestId('settings-tab-agent').click();
  const row = page.locator('.setting-row').filter({ hasText: '只读命令自动执行' });
  await expect(row.locator('.setting-row-desc')).toHaveCount(0);
  await row.locator('.setting-row-help').hover();
  await expect(page.locator('.setting-help-tip')).toContainText('关闭后');
  await shot(page, 'ui26-05-settings-agent');

  // 搜索仍然能直接打开合并后的页面
  await page.getByTestId('settings-search').fill('MCP');
  await page.getByTestId('settings-search-item').first().click();
  await expect(page.locator('.topbar-page-sub.keep')).toHaveText('扩展');
  await expect(page.getByTestId('settings-tab-mcp')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('settings-search').fill('');
  await expect(page.getByTestId('settings-nav-ext')).toHaveClass(/active/);
  await page.getByTestId('settings-nav-account').click();
  await expect(page.getByTestId('settings-account')).toContainText('本地模式（Guest，未登录）');
  await expect(page.getByTestId('settings-login')).toBeVisible();
  await shot(page, 'ui26-06-settings-account');
  await app.close();
});

test('运维审计：导航和页面改名；录像列表「回放」后面有「AI 汇总」，直接打开汇总为笔记', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web26').click();
  await expect(page.getByTestId('tab-web26').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  await page.waitForTimeout(800);
  await page.getByTestId('tab-web26').locator('.ws-top-tab-close').click();

  await expect(page.getByTestId('nav-audit')).toHaveAttribute('aria-label', '运维审计');
  await page.getByTestId('nav-audit').click();
  await expect(page.locator('.topbar-page-name')).toHaveText('运维审计');
  await page.getByTestId('audit-tab-conn').click();
  const recs = page.getByTestId('recording-table');
  await expect(recs).toContainText('web26');
  const btn = recs.getByTestId('recording-summarize').first();
  await expect(btn).toBeEnabled();
  await shot(page, 'ui26-07-audit');
  await btn.click();
  await expect(page.getByTestId('rec-note-dialog')).toBeVisible();
  await expect(page.getByTestId('rec-note-title')).toHaveValue(/^web26 · /);
  llm.enqueue({ text: '会话里只登录了一下，没有执行命令。' });
  await page.getByTestId('rec-note-ok').click();
  await expect(page.getByTestId('rec-note-dialog')).toHaveCount(0, { timeout: 15_000 });
  expect((await call<{ notes: { title: string }[] }>(page, 'note.list')).notes.some((x) => x.title.startsWith('web26 · '))).toBe(true);
  await app.close();
});
