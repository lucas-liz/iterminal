import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';
import { startMockServer } from '../test/support/mock-server';

/**
 * 第十四轮：Windows 粘贴两次、Agent 命令没有输出时停止要立刻生效、排队消息「插入」打断当前回答、对话框里快捷调整 Agent 权限（含 AI 自动审批）。
 */
let root: string;
let ssh: TestSshServer;
let llm: LlmMock;

test.describe.configure({ mode: 'serial' });

async function launch(extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '', ...extra };
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

/** 模拟浏览器对终端输入框的原生粘贴（Windows / Linux 上 Ctrl+Shift+V 的默认行为） */
type Dom = { DataTransfer: new () => { setData(t: string, v: string): void }; ClipboardEvent: new (t: string, i: object) => unknown };
const firePaste = (page: Page, text: string): Promise<void> =>
  page.locator('.xterm-helper-textarea').first().evaluate((el, t) => {
    const g = globalThis as unknown as Dom;
    const dt = new g.DataTransfer();
    dt.setData('text/plain', t);
    (el as unknown as { dispatchEvent(e: unknown): void }).dispatchEvent(new g.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);

async function connect(page: Page, name: string): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId(`connect-${name}`).click();
  const dot = page.getByTestId(`tab-${name}`).locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
}

async function prepare(page: Page): Promise<void> {
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
    await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  }
  if (!(await call<{ name: string }[]>(page, 'host.list')).some((h) => h.name === 'web14')) {
    await call(page, 'host.create', { folderId: null, name: 'web14', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui14-'));
  mkdirSync(join(root, 'remote'), { recursive: true });
  ssh = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('粘贴快捷键只粘贴一次（Windows 的 Ctrl+Shift+V 会同时触发浏览器自己的粘贴）', async () => {
  const { app, page } = await launch();
  await prepare(page);
  // macOS 上把粘贴设成 ⌘⇧V：和 Windows 的 Ctrl+Shift+V 一样，浏览器会再做一次「粘贴并匹配样式」
  await call(page, 'setting.set', { key: 'ui.shortcuts', value: { termPaste: 'Mod+Shift+V' } });
  await page.reload();
  await connect(page, 'web14');
  await app.evaluate(({ clipboard }) => clipboard.writeText('paste-once'));
  await page.getByTestId('xterm-tab-1').locator('.xterm').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+V' : 'Control+Shift+V');
  // Windows / Linux 上 Chromium 紧接着会对输入框做一次原生粘贴（macOS 的自动化按键不会）：这里补发同样的 paste 事件模拟
  await firePaste(page, 'paste-once');
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('paste-once');
  // 右键菜单的「粘贴」同样只有一次
  await app.evaluate(({ clipboard }) => clipboard.writeText('menu-paste'));
  await page.getByTestId('xterm-tab-1').click({ button: 'right', modifiers: ['Control'] });
  await page.locator('.ant-dropdown-menu-item', { hasText: '粘贴' }).first().click();
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('menu-paste');
  // 过了一会儿用户自己再粘贴同样的内容（原生粘贴）：照常粘贴
  await page.waitForTimeout(900);
  await firePaste(page, 'menu-paste');
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await expect.poll(() => ssh.lines.at(-1)).toBe('menu-paste');
  expect(ssh.lines.filter((l) => l.includes('paste-oncepaste-once') || l.includes('menu-pastemenu-paste'))).toEqual([]);
  await call(page, 'setting.set', { key: 'ui.shortcuts', value: {} });
  await app.close();
});

const lastUserText = (): string => {
  const body = llm.requests.at(-1)!.body as { messages: { role: string; content: unknown }[] };
  return JSON.stringify(body.messages.filter((m) => m.role === 'user').at(-1));
};

test('对话框里快捷调整权限（简短名称、悬停看说明）；排队消息「立即插入」打断卡住的命令，马上发给 AI', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await connect(page, 'web14');
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  const input = side.getByTestId('agent-input');
  // 加了权限按钮后右侧窄面板的底栏不挤出去：发送按钮在输入框里面，模型名保留可读的宽度
  const fits = async (): Promise<void> => {
    const box = (await side.locator('.agent-input-box.composer').boundingBox())!;
    const send = (await side.locator('.composer-bar .agent-send').last().boundingBox())!;
    expect(send.x + send.width).toBeLessThanOrEqual(box.x + box.width - 4);
    expect((await side.getByTestId('agent-model').boundingBox())!.width).toBeGreaterThanOrEqual(64);
  };
  await fits();

  // 默认跟随分组；按钮上只有简短的名称，悬停显示完整说明
  const btn = side.getByTestId('chat-policy');
  await expect(btn).toHaveText(/跟随分组/);
  await btn.hover();
  await expect(page.locator('.ant-tooltip').filter({ hasText: 'Agent 权限：跟随分组' })).toBeVisible();
  await btn.click();
  const panel = page.getByTestId('chat-policy-panel');
  // 只有三档（和设置、分组、主机里的菜单一样）加上跟随分组
  await expect(panel.getByRole('menuitemradio')).toHaveText([/^跟随分组/, /^只读/, /^自动/, /^完全允许/]);
  await panel.getByTestId('chat-policy-AUTO').click();
  await expect(btn).toHaveText(/完全允许/);
  await expect(panel.getByTestId('chat-policy-confirm')).toBeChecked();
  await fits();
  await page.waitForTimeout(300);
  await shot(page, 'ui14-01-chat-policy');
  await page.keyboard.press('Escape');

  // 完全允许：写操作直接执行（不弹审批）；这条命令一直不结束
  llm.enqueue({ toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 't1', command: 'touch /tmp/itm-ui14-ok && sleep 30', explanation: '等待', timeout_sec: 120, idle_timeout_sec: 120 } }] });
  await input.fill('先建个文件再等 30 秒');
  await input.press('Enter');
  await expect.poll(() => ssh.execs.some((c) => c.includes('sleep 30')), { timeout: 15_000 }).toBe(true);
  await expect(page.locator('.step-card').filter({ hasText: 'sleep 30' })).toBeVisible();

  // 回答没结束：再发的消息进入排队，点「立即插入」打断（命令停止）并马上发送
  await input.fill('别等了，改为看一下 uptime');
  await input.press('Enter');
  await expect(side.getByTestId('queue-item')).toHaveCount(1);
  await page.waitForTimeout(300);
  await shot(page, 'ui14-02-queue-insert');
  llm.enqueue({ text: '好的，已经停止等待，改为检查 uptime。' });
  const t = Date.now();
  await side.getByTestId('queue-insert').click();
  await expect(side.getByTestId('agent-assistant-msg').filter({ hasText: '改为检查 uptime' })).toBeVisible({ timeout: 8000 });
  expect(Date.now() - t).toBeLessThan(5000);
  await expect(side.getByTestId('queue-item')).toHaveCount(0);
  expect(lastUserText()).toContain('别等了，改为看一下 uptime');
  // 被打断的那条命令告诉模型「用户已停止」；步骤卡片保留原来的说明，标出已停止
  expect(JSON.stringify(llm.requests.at(-1)!.body)).toContain('用户已停止');
  const stoppedCard = page.locator('.step-card').filter({ hasText: 'sleep 30' });
  await expect(stoppedCard).toContainText('等待');
  // 第三十一轮：一轮结束后执行结果收起，点「展开」才显示
  await expect(stoppedCard.getByTestId('step-output')).toHaveAttribute('data-folded', '1');
  await stoppedCard.getByTestId('step-output-toggle').click();
  await expect(stoppedCard).toContainText('用户已停止执行');
  await expect(stoppedCard).not.toContainText('判定中');
  await shot(page, 'ui14-03-after-insert');
  await app.close();
});

test('界面上任何地方都不显示后台地址：登录框没有地址、连不上时的提示、问题反馈页和诊断预览', async () => {
  // 一个没有服务在监听的端口，当作「默认服务端」（ITM_DEFAULT_SERVER_URL 只在测试里生效）
  const port = await new Promise<number>((resolve) => {
    const srv = createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
  const server = `http://127.0.0.1:${port}/prod-api`;
  const leaks = [`127.0.0.1:${port}`, 'prod-api'];
  const noLeak = async (text: string): Promise<void> => {
    for (const l of leaks) expect(text).not.toContain(l);
  };
  const { app, page } = await launch({ ITM_DEFAULT_SERVER_URL: server });

  // 登录框：只有用户名和密码
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  const dialog = page.getByTestId('login-dialog');
  await expect(dialog.getByTestId('login-username')).toBeVisible();
  await expect(dialog.getByTestId('login-server')).toHaveCount(0);
  await noLeak(await dialog.innerText());
  await dialog.getByTestId('login-username').fill('admin');
  await dialog.getByTestId('login-password').fill('wrong');
  await dialog.getByTestId('login-submit').click();
  await expect(dialog.getByTestId('login-error')).toContainText('连不上服务端');
  await noLeak(await dialog.innerText());
  await page.waitForTimeout(300);
  await shot(page, 'ui14-04-login-no-server');
  await page.keyboard.press('Escape');

  // 问题反馈：不写提交到哪里；预览的诊断信息里也没有地址
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-about').click();
  await page.getByTestId('settings-tab-feedback').click();
  await expect(page.getByTestId('feedback-submit')).toBeVisible();
  await expect(page.locator('.settings-body')).toContainText('本地模式：匿名提交');
  await noLeak(await page.locator('.settings-body').innerText());
  await shot(page, 'ui14-05-feedback-no-server');
  await page.getByTestId('feedback-preview').click();
  const md = page.getByTestId('feedback-preview-md');
  await expect(md).toContainText('环境');
  await noLeak(await md.innerText());
  await app.close();
});

test('隐藏的服务端地址设置：关于里连续点 5 次软件图标，输入管理员密码后修改地址，登录用新地址；可以恢复默认', async () => {
  const mock = await startMockServer();
  // 测试用的管理员密码（ITM_ADMIN_PASSWORD 只在没有打包时生效）；不设置 ITM_DEFAULT_SERVER_URL，登录只能靠这里设置的地址
  const { app, page } = await launch({ ITM_ADMIN_PASSWORD: 'itm-e2e-admin', ITM_USER_DATA: join(root, 'userData-admin') });
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-about').click();
  const logo = page.getByTestId('about-logo');
  const dialog = page.locator('.ant-modal').filter({ hasText: '服务端设置' });
  const pw = page.getByTestId('admin-password');
  // 点得不够、或者中间停顿太久都不会打开
  for (let i = 0; i < 4; i++) await logo.click();
  await page.waitForTimeout(1700);
  await logo.click();
  await expect(pw).toHaveCount(0);
  // 停顿后重新计数：连续 5 次打开
  await page.waitForTimeout(1700);
  for (let i = 0; i < 4; i++) await logo.click();
  await expect(pw).toHaveCount(0);
  await logo.click();
  await expect(pw).toBeVisible();

  // 管理员密码：错的提示，对的进入设置；不显示默认地址
  await dialog.getByTestId('admin-password').fill('wrong');
  await dialog.getByTestId('admin-unlock').click();
  await expect(dialog.getByTestId('admin-error')).toContainText('密码错误');
  await dialog.getByTestId('admin-password').fill('itm-e2e-admin');
  await dialog.getByTestId('admin-unlock').click();
  await expect(dialog.getByTestId('admin-source')).toHaveText('当前使用：默认地址');
  await expect(dialog.getByTestId('admin-server-url')).toHaveValue('');
  expect(await dialog.innerText()).not.toContain('prod-api');

  // 地址不对：测试连接说明原因；改成模拟服务端：连接成功，保存
  await dialog.getByTestId('admin-server-url').fill('http://127.0.0.1:1');
  await dialog.getByTestId('admin-server-test').click();
  await expect(dialog.getByTestId('admin-test-result')).toContainText('连不上');
  await dialog.getByTestId('admin-server-url').fill(mock.url);
  await dialog.getByTestId('admin-server-test').click();
  await expect(dialog.getByTestId('admin-test-result')).toContainText('连接成功');
  await page.waitForTimeout(300);
  await shot(page, 'ui14-06-admin-server');
  await dialog.getByTestId('admin-server-save').click();
  await expect(page.getByTestId('admin-server-url')).toHaveCount(0);

  // 登录框仍然没有地址，登录连到刚才设置的服务端
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await expect(page.getByTestId('login-server')).toHaveCount(0);
  await page.getByTestId('login-username').fill(mock.user.username);
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', /^(valid|expired|revoked)$/, { timeout: 15_000 });
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  expect(mock.rest.some((r) => r.path === '/api/v1/auth/login')).toBe(true);

  // 再次进入（每次都要密码）：显示是这里设置的地址，可以恢复默认
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-about').click();
  for (let i = 0; i < 5; i++) await page.getByTestId('about-logo').click();
  await dialog.getByTestId('admin-password').fill('itm-e2e-admin');
  await dialog.getByTestId('admin-password').press('Enter');
  await expect(dialog.getByTestId('admin-source')).toHaveText('当前使用：这里设置的地址');
  await expect(dialog.getByTestId('admin-server-url')).toHaveValue(mock.url);
  await dialog.getByTestId('admin-server-reset').click();
  await expect(page.getByTestId('admin-server-url')).toHaveCount(0);
  await app.close();
  await mock.close();
});
