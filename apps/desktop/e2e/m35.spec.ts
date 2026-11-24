import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * M3.5 体验优化（文档一 6.15）：测试连接日志、连接进度小窗、模型厂商预设、深度思考、命令安全配置、输入框、双模式。
 */
let root: string;
let server: TestSshServer;
let llm: LlmMock;
/** 接受 TCP 连接但不说 SSH 协议的端口（模拟「端口不是 SSH 服务」） */
let silent: Server;
let silentPort: number;
/** 已关闭的端口（连接被拒绝） */
let closedPort: number;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const packaged = process.env.ITM_E2E_EXECUTABLE;
  const app = packaged
    ? await electron.launch({ executablePath: packaged, args: [], env })
    : await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'screens', `${name}.png`) });
}

async function fillHost(page: Page, h: { name: string; port: number }): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill(h.name);
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(h.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-m35-'));
  mkdirSync(join(root, 'remote'));
  server = await startTestSshServer({ root: join(root, 'remote') });
  llm = await startLlmMock();
  silent = createServer(() => undefined);
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  silentPort = (silent.address() as { port: number }).port;
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  closedPort = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
});

test.afterAll(async () => {
  await server?.close();
  await llm?.close();
  silent?.close();
  rmSync(root, { recursive: true, force: true });
});

test('测试连接：结果显示在按钮旁边，可以查看逐步的连接日志', async () => {
  const { app, page } = await launch();
  await fillHost(page, { name: 'web', port: server.port });
  await page.getByTestId('host-test').click();
  // 第十二轮：点测试连接直接打开日志框（指纹确认在日志框上面）
  const log = page.getByTestId('host-test-log');
  await expect(log).toBeVisible();
  await page.getByRole('button', { name: '信任并连接' }).click();
  await expect(page.getByTestId('host-test-result')).toContainText('测试成功');
  await expect(log).toContainText(`连接到 127.0.0.1:${server.port}`);
  await expect(log).toContainText('Socket 连接成功');
  await expect(log).toContainText('首次连接，等待确认主机指纹');
  await expect(log).toContainText('尝试密码认证（用户 tester）');
  await expect(log).toContainText('认证成功');
  await expect(log).toContainText('测试连接成功');
  await shot(page, 'm35-01-test-log');
  await page.keyboard.press('Escape');

  // 改了端口，之前的结果作废；连不上时同样有日志
  await page.getByTestId('host-port').fill(String(closedPort));
  await expect(page.getByTestId('host-test-result')).toHaveCount(0);
  await page.getByTestId('host-test').click();
  await expect(page.getByTestId('host-test-result')).toContainText('测试失败');
  await expect(page.getByTestId('host-test-log')).toContainText('连接被拒绝');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('host-test-log')).toHaveCount(0);
  await page.getByTestId('host-test-log-open').click();
  await expect(page.getByTestId('host-test-log')).toContainText('连接被拒绝');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('host-test-log')).toHaveCount(0);
  await page.getByTestId('host-port').fill(String(server.port));
  await page.getByTestId('host-save').click();
  await expect(page.getByTestId('connect-web')).toBeVisible();
  await app.close();
});

test('连接进度小窗：失败停留并给出原因和重试；连接中可以取消', async () => {
  const { app, page } = await launch();
  // 连接被拒绝：自动重试 1 次后失败
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-terminal').click();
  await page.getByTestId('term-cat-connect').click();
  const num = (id: string) => page.locator(`[data-testid="${id}"] input, input[data-testid="${id}"]`);
  await num('setting-connect-retries').fill('1');
  await num('setting-connect-retries').blur();
  await num('setting-connect-timeout').fill('3');
  await num('setting-connect-timeout').blur();

  await fillHost(page, { name: 'refused', port: closedPort });
  await page.getByTestId('host-save').click();
  await page.getByTestId('connect-refused').click();
  const card = page.getByTestId('conn-progress');
  await expect(card).toHaveAttribute('data-state', 'error');
  await expect(card.getByTestId('conn-step-connect')).toHaveAttribute('data-status', 'error');
  await expect(card.getByTestId('conn-log')).toContainText('尝试 1/2');
  await expect(card.getByTestId('conn-log')).toContainText('400ms 后重试（2/2）');
  await expect(card.getByTestId('conn-log')).toContainText('尝试 2/2');
  await expect(card.getByTestId('conn-error')).toContainText('连接被拒绝');
  await expect(card.getByTestId('conn-error')).toContainText('建议');
  await shot(page, 'm35-02-conn-failed');
  // 编辑主机：打开全局主机编辑框
  await card.getByTestId('conn-edit').click();
  await expect(page.getByTestId('host-form')).toBeVisible();
  await page.keyboard.press('Escape');
  await card.getByTestId('conn-close').click();
  await expect(page.getByTestId('conn-progress')).toHaveCount(0);
  await expect(page.getByTestId('reconnect')).toBeVisible();

  // 端口不说 SSH：连接过程中取消
  await fillHost(page, { name: 'silent', port: silentPort });
  await page.getByTestId('host-save').click();
  await page.getByTestId('connect-silent').click();
  const card2 = page.getByTestId('conn-progress');
  await expect(card2).toHaveAttribute('data-state', 'connecting');
  await expect(card2.getByTestId('conn-log')).toContainText('Socket 连接成功');
  await expect(card2.getByTestId('conn-step-connect')).toHaveAttribute('data-status', 'active');
  await shot(page, 'm35-03-conn-progress');
  await card2.getByTestId('conn-cancel').click();
  await expect(page.getByTestId('conn-progress')).toHaveCount(0);
  await expect(page.getByText('已取消连接').first()).toBeVisible();

  // 正常主机：连接成功后小窗自动消失
  await fillHost(page, { name: 'good', port: server.port });
  await page.getByTestId('host-save').click();
  await page.getByTestId('connect-good').click();
  // 前一个用例可能已经信任过这台测试服务器的指纹
  const trust = page.getByRole('button', { name: '信任并连接' });
  if (await trust.isVisible({ timeout: 2000 }).catch(() => false)) await trust.click();
  await expect(page.getByTestId('tab-good').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');
  await expect(page.getByTestId('conn-progress')).toHaveCount(0);
  await app.close();
});

test('模型厂商预设、获取模型列表、深度思考开关、AI 规则', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('add-provider').click();
  await shot(page, 'm35-04-vendor-picker');
  await page.getByTestId('vendor-deepseek').click();
  // 预设：默认地址、实际请求地址预览、获取 Key 的链接
  await expect(page.getByTestId('provider-url')).toHaveValue('https://api.deepseek.com');
  await expect(page.getByTestId('endpoint-preview')).toContainText('https://api.deepseek.com/chat/completions');
  await expect(page.getByTestId('vendor-key-link')).toHaveAttribute('href', /platform\.deepseek\.com/);
  // 不预先填模型：提示从接口获取或手动添加；也可以从官方模型里挑
  await expect(page.getByTestId('model-id')).toHaveCount(0);
  await expect(page.getByTestId('model-empty')).toBeVisible();
  await page.getByTestId('preset-models').click();
  await page.getByRole('menuitem', { name: '全部添加' }).click();
  await expect(page.getByTestId('model-id')).toHaveCount(2);
  await page.getByTestId('provider-url').fill(llm.url);
  await page.getByTestId('provider-key').fill('k');
  // 获取模型列表：已有的标注「已添加」，勾选新的
  await page.getByTestId('fetch-models').click();
  const list = page.getByTestId('fetch-models').last();
  await expect(page.locator('.fetch-model-row')).toHaveCount(4);
  await page.locator('.fetch-model-row').filter({ hasText: 'mock-coder' }).locator('input').check();
  await page.getByTestId('fetch-models-ok').click();
  await expect(page.getByTestId('model-id')).toHaveCount(3);
  void list;
  // 只展开最后一个模型的高级参数：第一个模型没展开的参数（支持的思考强度）也要保存下来
  await page.getByTestId('model-advanced').last().click();
  await shot(page, 'm35-05-provider-editor');
  await page.getByTestId('model-dialog-ok').click();
  await page.getByTestId('provider-save').click();
  await expect(page.locator('.provider-item').filter({ hasText: 'DeepSeek' }).first()).toBeVisible();

  // AI 规则
  await page.getByTestId('settings-nav-agent').click();
  await page.getByTestId('ai-rule-add').click();
  await page.getByTestId('ai-rule-text').fill('执行重启前先询问我');
  await page.getByTestId('ai-rule-text').blur();
  await shot(page, 'm35-06-ai-rules');

  // 对话：deepseek-flash 默认开启深度思考 → thinking.type = enabled；关闭后 disabled
  // 没有连接终端时右侧面板不显示：在 AI 对话模式里用
  await page.getByTestId('mode-ai').click();
  // 第二十六轮：模型和思考强度在同一个级联菜单里（服务商 → 模型；思考强度 → 档位）
  await page.getByTestId('agent-model').click();
  await page.getByTestId('model-provider').filter({ hasText: 'DeepSeek' }).hover();
  await page.getByTestId('model-item').filter({ hasText: /^DeepSeek V4\.1 Flash$/ }).click();
  // 第三十一轮：默认关闭思考，先在菜单里打开
  await expect(page.getByTestId('agent-model')).toHaveAttribute('data-thinking-on', '0');
  await page.getByTestId('agent-model').click();
  await page.getByTestId('thinking-menu').hover();
  await page.getByTestId('thinking-level').filter({ hasNotText: /自动|关闭/ }).first().click();
  await expect(page.getByTestId('agent-model')).toHaveAttribute('data-thinking-on', '1');
  llm.enqueue({ thinking: '想一想', text: '第一次回答' }, { text: '第二次回答' });
  await page.getByTestId('agent-input').fill('你好');
  await page.getByTestId('agent-input').press('Enter');
  await expect(page.getByText('第一次回答')).toBeVisible();
  const first = llm.requests.at(-1)!.body as { model: string; thinking?: unknown; messages: { role: string; content: string }[] };
  expect(first.model).toBe('deepseek-flash');
  expect(first.thinking).toEqual({ type: 'enabled' });
  expect(first.messages[0].content).toContain('用户规则');
  expect(first.messages[0].content).toContain('执行重启前先询问我');
  await shot(page, 'm35-07-thinking-on');
  await page.getByTestId('agent-model').click();
  await page.getByTestId('thinking-menu').hover();
  await page.getByTestId('thinking-level').filter({ hasText: '关闭' }).click();
  await expect(page.getByTestId('agent-model')).toHaveAttribute('data-thinking-on', '0');
  await page.getByTestId('agent-input').fill('再来');
  await page.getByTestId('agent-input').press('Enter');
  await expect(page.getByText('第二次回答')).toBeVisible();
  expect(llm.requests.at(-1)!.body).toMatchObject({ model: 'deepseek-flash', thinking: { type: 'disabled' } });
  await app.close();
});

test('命令安全：名单、处理策略、严格模式、命令测试', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-agent').click();
  await page.getByTestId('settings-tab-cmdsec').click();
  const run = async (cmd: string): Promise<string> => {
    const result = page.getByTestId('cmdtest-result');
    const before = (await result.count()) ? await result.getAttribute('data-seq') : null;
    await page.getByTestId('cmdtest-input').fill(cmd);
    await page.getByTestId('cmdtest-run').click();
    // 等这一次的结果（避免读到上一条命令的结果）
    await expect(page.getByTestId('cmdtest-result')).toHaveAttribute('data-command', cmd);
    await expect(page.getByTestId('cmdtest-result')).not.toHaveAttribute('data-seq', before ?? '-');
    return (await page.getByTestId('cmdtest-decision').innerText()).trim();
  };
  const addTo = async (list: string, value: string): Promise<void> => {
    await page.getByTestId(`cmdlist-${list}`).click();
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(`cmdlist-${list}`)).toContainText(value);
  };
  // 默认：未知命令需要批准、只读命令自动执行、高危输入主机名确认
  expect(await run('mytool --sync')).toBe('需要批准');
  expect(await run('df -h')).toBe('自动执行');
  expect(await run('rm -rf /data/old')).toBe('输入主机名确认');

  await addTo('WHITE', 'mytool --sync');
  await addTo('DANGER', 'systemctl restart');
  await addTo('BLACK', 'reboot');
  expect(await run('mytool --sync --verbose')).toBe('自动执行');
  expect(await run('sudo systemctl restart nginx')).toBe('输入主机名确认');
  await expect(page.getByTestId('cmdtest-result')).toContainText('危险命令：systemctl restart');
  expect(await run('reboot')).toBe('拒绝');
  // 白名单不能放宽内置高危
  await addTo('WHITE', 'rm');
  expect(await run('rm -rf /data/old')).toBe('输入主机名确认');
  await shot(page, 'm35-08-cmdsec');

  // 策略：高危单击批准、黑名单改为确认、严格模式
  await page.getByTestId('sec-l2').getByText('单击批准').click();
  await expect(page.getByTestId('cmdtest-decision')).toHaveText('需要批准');
  await page.getByTestId('sec-black').getByText('输入主机名确认').click();
  expect(await run('reboot')).toBe('输入主机名确认');
  await page.getByTestId('sec-strict').click();
  expect(await run('othertool --x')).toBe('拒绝');
  await expect(page.getByTestId('cmdtest-result')).toContainText('严格模式');

  // 重启后仍然生效
  await app.close();
  const again = await launch();
  await again.page.getByTestId('avatar-trigger').click();
  await again.page.getByTestId('nav-settings').click();
  await again.page.getByTestId('settings-nav-agent').click();
  await again.page.getByTestId('settings-tab-cmdsec').click();
  await expect(again.page.getByTestId('cmdlist-BLACK')).toContainText('reboot');
  await again.page.getByTestId('cmdtest-input').fill('mytool --sync');
  await again.page.getByTestId('cmdtest-run').click();
  await expect(again.page.getByTestId('cmdtest-decision')).toHaveText('自动执行');
  await again.app.close();
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('对话输入框：@ 引用主机、/ 命令、上传图片和文件', async () => {
  const { app, page } = await launch();
  // 一台主机 + 支持图片的 Claude
  await fillHost(page, { name: 'web-mention', port: server.port });
  await page.getByTestId('host-save').click();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('add-provider').click();
  await page.getByTestId('vendor-tabs').getByText('海外平台').click();
  await page.getByTestId('vendor-anthropic').click();
  // 新建服务商时不预先填模型：从官方模型里全部添加
  await page.getByTestId('preset-models').click();
  await page.getByRole('menuitem', { name: '全部添加' }).click();
  await page.getByTestId('provider-name').fill('Claude 图片');
  await page.getByTestId('provider-url').fill(llm.url);
  await page.getByTestId('provider-key').fill('k');
  await page.getByTestId('provider-save').click();
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('agent-new').click();
  await page.getByTestId('agent-model').click();
  await page.getByTestId('model-provider').filter({ hasText: 'Claude 图片' }).hover();
  await page.getByTestId('model-item').filter({ hasText: /^Claude Opus 5\.5/ }).first().click();

  // @ 引用：输入 @ 弹出分类列表，按名字过滤，回车引用
  const input = page.getByTestId('agent-input');
  await input.click();
  await input.pressSequentially('看看 @web-men');
  await expect(page.getByTestId('mention-popup')).toBeVisible();
  await expect(page.getByTestId('mention-item').first()).toContainText('web-mention');
  await shot(page, 'm35-09-mention');
  await input.press('Enter');
  await expect(page.getByTestId('mention-popup')).toHaveCount(0);
  // 第十二轮：引用加到引用里，输入框里留下 @名称
  await expect(input).toHaveValue('看看 @web-mention ');
  await expect(page.getByTestId('agent-refs')).toContainText('web-mention');

  // / 命令：切换到 Ask 再切回 Agent
  await input.fill('');
  await input.pressSequentially('/as');
  await expect(page.getByTestId('mention-item').first()).toContainText('/ask');
  await input.press('Enter');
  await expect(page.getByTestId('agent-mode')).toHaveAttribute('data-mode', 'ask');
  await input.pressSequentially('/agent');
  await input.press('Enter');
  await expect(page.getByTestId('agent-mode')).toHaveAttribute('data-mode', 'agent');
  await expect(input).toHaveValue('');

  // 图片和文件
  await page.getByTestId('image-input').setInputFiles({ name: 'disk.png', mimeType: 'image/png', buffer: Buffer.from(PNG_1PX, 'base64') });
  await expect(page.locator('.agent-image')).toHaveCount(1);
  const notePath = join(root, 'error.log');
  writeFileSync(notePath, 'ERROR disk full on /data\n');
  // AI 对话模式：左下角 + →「添加图片或文件」（图片和文件共用一个入口）
  await page.getByTestId('any-file-input').setInputFiles(notePath);
  await expect(page.getByTestId('agent-refs')).toContainText('error.log');
  await shot(page, 'm35-10-image-file');
  llm.respond(null);
  llm.enqueue({ text: '图片里是磁盘告警' });
  await input.fill('这张图说明了什么？');
  await input.press('Enter');
  await expect(page.getByText('图片里是磁盘告警')).toBeVisible();
  const body = llm.requests.at(-1)!.body as { messages: { role: string; content: { type: string; text?: string; source?: { media_type: string } }[] }[] };
  const last = body.messages.at(-1)!;
  expect(last.content.some((c) => c.type === 'image' && c.source?.media_type === 'image/png')).toBe(true);
  expect(JSON.stringify(last.content)).toContain('ERROR disk full on /data');
  // 图片和文件只带一次
  await expect(page.locator('.agent-image')).toHaveCount(0);
  await expect(page.getByTestId('agent-user-msg').last()).toContainText('🖼 disk.png');
  await app.close();
});

test('终端 / AI 对话双模式：整页对话、@ 主机直接执行、会话列表、快捷键切换', async () => {
  const { app, page } = await launch();
  await fillHost(page, { name: 'web-ai', port: server.port });
  await page.getByTestId('host-save').click();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('add-provider').click();
  await page.getByTestId('vendor-tabs').getByText('海外平台').click();
  await page.getByTestId('vendor-anthropic').click();
  // 新建服务商时不预先填模型：从官方模型里全部添加
  await page.getByTestId('preset-models').click();
  await page.getByRole('menuitem', { name: '全部添加' }).click();
  await page.getByTestId('provider-name').fill('Claude 整页');
  await page.getByTestId('provider-url').fill(llm.url);
  await page.getByTestId('provider-key').fill('k');
  await page.getByTestId('provider-save').click();

  // 应用名后面的模式切换：终端 / AI 对话
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await expect(page.getByTestId('mode-ai')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('ai-page-new').click();
  const panel = page.getByTestId('agent-page-panel');
  const input = panel.getByTestId('agent-input');
  await input.click();
  await input.pressSequentially('@web-ai');
  await input.press('Enter');
  await expect(panel.getByTestId('agent-refs')).toContainText('web-ai');

  // 没有打开终端：Agent 用独立的执行通道在主机上执行
  llm.respond(null);
  llm.enqueue(
    { text: '我看一下主机名。', toolCalls: [{ id: 'toolu_ai1', name: 'run_command', input: { host: 'h1', command: 'echo from-ai-page', explanation: '确认能在这台主机上执行命令' } }] },
    { text: '执行成功，主机可以正常操作。' },
  );
  await input.pressSequentially('检查一下');
  await input.press('Enter');
  // 第一次连接这台测试服务器时要确认指纹（前面的用例可能已经信任过）
  const trust = page.getByRole('button', { name: '信任并连接' });
  const answer = panel.getByText('执行成功，主机可以正常操作。');
  await trust.or(answer).first().waitFor();
  if (await trust.isVisible()) await trust.click();
  await expect(answer).toBeVisible();
  await expect(panel.getByTestId('agent-step').first()).toHaveAttribute('data-status', 'done');
  await expect(panel.getByTestId('step-explanation').first()).toContainText('确认能在这台主机上执行命令');
  expect(server.execs).toContain('echo from-ai-page');
  await shot(page, 'm35-11-ai-page');

  // 会话列表：搜索
  await expect(page.getByTestId('ai-conv-item').filter({ hasText: '检查一下' })).toBeVisible();
  // 第十二轮：@名称 留在消息里，会话标题里也有
  await expect(page.getByTestId('ai-conv-item').filter({ hasText: '@web-ai' })).toHaveCount(1);
  await page.getByTestId('ai-conv-search').fill('不存在的对话');
  await expect(page.getByTestId('ai-conv-item')).toHaveCount(0);
  await page.getByTestId('ai-conv-search').fill('');

  // 快捷键在终端和 AI 对话之间切换
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+Shift+A`);
  await expect(page.getByTestId('ai-page')).toHaveCount(0);
  await page.keyboard.press(`${mod}+Shift+A`);
  await expect(page.getByTestId('ai-page')).toBeVisible();

  // 引用的主机可以直接在终端中打开
  await panel.getByTestId('ref-open-terminal').first().click();
  await expect(page.getByTestId('tab-web-ai')).toBeVisible();
  await app.close();
});
