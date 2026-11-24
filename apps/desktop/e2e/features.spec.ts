import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 端到端：跳板机与测试连接、终端底部监控与详情、跟随目录的右侧文件面板、AI 模型配置与 Agent（审批、按主机展示）。
 */
let root: string;
let remoteRoot: string;
let downloads: string;
let jump: TestSshServer;
let target: TestSshServer;
let llm: LlmMock;

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: userData, ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
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

async function addHost(page: Page, h: { name: string; port: number; jump?: string }): Promise<void> {
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill(h.name);
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(h.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  if (h.jump) {
    await page.getByTestId('host-jumps').click();
    await page.locator('.ant-select-item-option').filter({ hasText: h.jump }).click();
    await page.keyboard.press('Escape');
  }
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e2-'));
  // 引用面板里勾选的 Skill（本地档案的 Skill 目录）
  mkdirSync(join(root, 'userData', 'profiles', 'local', 'skills', 'host-health-check'), { recursive: true });
  writeFileSync(
    join(root, 'userData', 'profiles', 'local', 'skills', 'host-health-check', 'SKILL.md'),
    '---\nname: host-health-check\ntitle: 主机健康巡检\ndescription: 检查负载、内存和磁盘\n---\n1. uptime\n2. df -hP\n',
  );
  remoteRoot = join(root, 'remote');
  downloads = join(root, 'downloads');
  mkdirSync(join(remoteRoot, 'root', 'app'), { recursive: true });
  mkdirSync(downloads);
  writeFileSync(join(remoteRoot, 'root', 'app', 'app.log'), '2026-09-30 10:00:00 INFO started\n2026-09-30 10:05:00 INFO healthy\n');
  writeFileSync(join(remoteRoot, 'root', 'app', 'release.tar.gz'), Buffer.alloc(2048));
  jump = await startTestSshServer({ root: remoteRoot, allowForward: true });
  target = await startTestSshServer({ root: remoteRoot, fakeLinuxMonitor: { cwd: '/root/app' } });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await jump?.close();
  await target?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('跳板机、监控、文件面板、AI 模型与 Agent', async () => {
  const { app, page } = await launch(join(root, 'userData'));
  // 下载保存到临时目录，不写用户真实的「下载」文件夹
  await app.evaluate(({ app: a }, dir) => a.setPath('downloads', dir), downloads);

  // ---------------------------------------------------------------- 跳板机 + 测试连接
  await addHost(page, { name: '堡垒机', port: jump.port });
  await page.getByTestId('host-save').click();
  await expect(page.getByTestId('connect-堡垒机')).toBeVisible();

  await addHost(page, { name: '应用服务器', port: target.port, jump: '堡垒机' });
  await page.getByTestId('host-test').click();
  // 测试连接时每一跳各自确认指纹
  for (const name of ['堡垒机', '应用服务器']) {
    // 测试连接的日志框里也有「等待确认主机指纹」，按对话框标题找
    const prompt = page.locator('.ant-modal').filter({ has: page.locator('.ant-modal-title', { hasText: /^确认主机指纹$/ }) });
    await expect(prompt.filter({ hasText: name })).toBeVisible();
    await page.getByRole('button', { name: '信任并连接' }).click();
  }
  await expect(page.getByTestId('host-test-result')).toContainText('测试成功');
  await expect(page.getByTestId('host-test-result')).toContainText('经 堡垒机');
  // 测试时自动打开的日志框
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('host-test-log')).toHaveCount(0);
  await shot(page, '10-jump-test');
  await page.getByTestId('host-save').click();
  await expect(page.getByTestId('connect-应用服务器')).toBeVisible();
  await expect(page.getByText('跳板 1')).toBeVisible();

  // 连接：指纹在测试时已确认，不再询问；流量经过堡垒机
  await page.getByTestId('connect-应用服务器').click();
  await expect.poll(() => jump.forwards).toContain(`127.0.0.1:${target.port}`);
  await expect(page.getByText('确认主机指纹')).toHaveCount(0);

  // ---------------------------------------------------------------- 底部监控
  await expect(page.getByTestId('monitor-cpu')).toContainText(/\d+(\.\d)?%/, { timeout: 15_000 });
  await expect(page.getByTestId('monitor-bar')).toContainText('↓');
  await expect(page.getByTestId('monitor-mem')).toContainText('内存');
  await expect(page.getByTestId('monitor-disk')).toContainText('磁盘');
  await shot(page, '11-terminal-monitor-files');

  // 点击底部的某一段：右侧面板切到「监控」并打开对应分类
  await page.getByTestId('monitor-cpu').click();
  const detail = page.getByTestId('monitor-detail');
  await expect(detail).toHaveAttribute('data-tab', 'cpu');
  await expect(page.getByTestId('proc-ranking-cpu')).toContainText('mysqld');
  await expect(page.getByTestId('proc-ranking-cpu')).toContainText('/opt/app/app.jar');
  await expect(page.getByTestId('cpu-cores').locator('.mx-core')).toHaveCount(4, { timeout: 10_000 });
  await expect(detail).toContainText('Intel(R) Xeon(R) Gold 6248R');
  await shot(page, '12a-monitor-cpu');

  await page.getByTestId('mx-tab-overview').click();
  await expect(detail).toContainText('/boot');
  await expect(page.getByTestId('mx-ov-net')).toContainText('10.10.0.1');
  await expect(page.getByTestId('mx-host')).toContainText('Ubuntu 22.04.4 LTS');
  await shot(page, '12-monitor-detail');

  await page.getByTestId('mx-tab-gpu').click();
  await expect(page.getByTestId('gpu-card')).toContainText('Cirrus Logic GD 5446');
  await expect(page.getByTestId('gpu-card')).toContainText('N/A');
  await shot(page, '12b-monitor-gpu');

  await page.getByTestId('monitor-mem').click();
  await expect(detail).toHaveAttribute('data-tab', 'mem');
  await expect(page.getByTestId('mem-available')).toContainText('GB');
  await expect(page.getByTestId('proc-ranking-mem')).toContainText('1.6 GB');
  await shot(page, '12c-monitor-mem');

  await page.getByTestId('monitor-disk').click();
  await expect(page.getByTestId('disk-card')).toHaveCount(2);
  await page.getByTestId('bigfiles-scan').click();
  await expect(page.getByTestId('bigfile-row').first()).toContainText('/var/log/app/huge.log');
  await expect(page.getByTestId('bigfile-row').first()).toContainText('2.0 GB');
  expect(target.execs.some((c) => c.includes('@@ITM-DETAIL bigfiles') && c.includes("find '/home' '/var' '/opt' -xdev -type f -size +102400k"))).toBe(true);
  await shot(page, '12d-monitor-disk');

  await page.getByTestId('monitor-net').click();
  await expect(page.getByTestId('net-sockets')).toContainText('507');
  await expect(page.getByTestId('listen-ports')).toContainText(':3306');
  await expect(page.getByTestId('listen-ports')).toContainText('mysqld');
  await shot(page, '12e-monitor-net');
  await page.getByTestId('right-files').click();

  // ---------------------------------------------------------------- 右侧文件面板：跟随终端目录、下载
  await expect(page.getByTestId('file-panel-path')).toHaveValue('/root/app');
  await expect(page.getByTestId('panel-file-app.log')).toBeVisible();
  // 第十六轮：双击文件是打开，下载用工具栏的「下载选中」
  await page.getByTestId('panel-file-app.log').click();
  await page.getByTestId('file-panel-download').click();
  await page.getByTestId('fp-download-ok').click();
  await expect.poll(() => readdirSync(downloads)).toContain('app.log');
  // 再下载一次不覆盖，自动改名
  await page.getByTestId('file-panel-download').click();
  await page.getByTestId('fp-download-ok').click();
  await expect.poll(() => readdirSync(downloads).sort()).toEqual(['app (1).log', 'app.log']);

  // ---------------------------------------------------------------- AI 模型配置
  await page.getByTestId('right-ai').click();
  await expect(page.getByTestId('goto-ai-settings')).toBeVisible();
  await page.getByTestId('goto-ai-settings').click();
  await page.getByTestId('add-provider').click();
  await page.getByTestId('vendor-tabs').getByText('海外平台').click();
  await page.getByTestId('vendor-anthropic').click();
  // 新建服务商时不预先填模型：从官方模型里全部添加
  await page.getByTestId('preset-models').click();
  await page.getByRole('menuitem', { name: '全部添加' }).click();
  await page.getByTestId('provider-name').fill('Claude');
  await page.getByTestId('provider-url').fill(llm.url);
  await page.getByTestId('provider-key').fill('test-key');
  await expect(page.getByTestId('model-id').first()).toHaveAttribute('data-value', 'claude-fable-5-1');
  llm.enqueue({ text: '连接成功' });
  await page.getByTestId('provider-test').click();
  await expect(page.getByTestId('provider-test-result')).toContainText('连接成功');
  await shot(page, '13-ai-provider');
  await page.getByTestId('provider-save').click();
  await expect(page.locator('.provider-item').filter({ hasText: 'Claude' })).toBeVisible();
  expect(llm.requests[0].headers['x-api-key']).toBe('test-key');

  // ---------------------------------------------------------------- Agent
  await page.getByTestId('nav-workspace').click();
  await page.getByTestId('right-ai').click();
  await expect(page.getByTestId('agent-panel')).toBeVisible();
  // 默认引用已连接的终端
  await expect(page.getByTestId('agent-refs')).toContainText('应用服务器');

  llm.enqueue(
    {
      thinking: '先看应用目录里有什么',
      text: '我先看一下应用目录。',
      toolCalls: [{ id: 'toolu_1', name: 'run_command', input: { host: 't1', command: 'ls root/app', explanation: '列出应用目录，确认发布包和日志都在' } }],
    },
    {
      text: '日志正常。需要创建重启标记文件：',
      toolCalls: [{ id: 'toolu_2', name: 'run_command', input: { host: 't1', command: 'touch root/app/restarted.flag', explanation: '创建重启标记文件，部署脚本看到它会在下次巡检时重启应用' } }],
    },
    // 写操作会先请模型复核一次风险（默认开启，只能升级）
    { text: '{"level":"L1","reason":"只是创建一个标记文件"}' },
    { text: '已完成：**应用运行正常**，并创建了重启标记。' },
  );
  await page.getByTestId('agent-input').fill('检查一下应用服务器');
  await page.getByTestId('agent-input').press('Enter');

  // 只读命令自动执行，结果里标明是哪台主机执行的
  const first = page.getByTestId('agent-step').first();
  await expect(first).toHaveAttribute('data-status', 'done');
  await expect(first.getByTestId('host-badge-t1')).toContainText('应用服务器');
  await expect(first).toContainText('release.tar.gz');
  // 执行卡片头部：风险标签 + 命令作用说明
  await expect(first.getByTestId('step-banner')).toContainText('安全');
  await expect(first.getByTestId('step-explanation')).toHaveText('— 列出应用目录，确认发布包和日志都在');
  await expect(first.getByTestId('step-icon')).toHaveAttribute('data-status', 'done');
  await expect(first.getByTestId('step-status')).toHaveCount(0);

  // 写操作等待批准
  const approve = page.getByTestId('approve');
  await expect(approve).toBeVisible();
  await expect(page.getByTestId('agent-step').nth(1).getByTestId('step-banner')).toContainText('需注意');
  await expect(page.getByTestId('agent-step').nth(1).getByTestId('step-explanation')).toContainText('创建重启标记文件');
  await shot(page, '14-agent-approval');
  await approve.click();
  // 需注意 / 高危的命令再确认一次（第十五轮）
  await page.getByTestId('approve-confirm').click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByText('应用运行正常')).toBeVisible();
  expect(existsSync(join(remoteRoot, 'root', 'app', 'restarted.flag'))).toBe(true);
  await expect(page.getByTestId('agent-step').nth(1)).toHaveAttribute('data-status', 'done');

  // 上下文占用环：按类别展示
  await page.getByTestId('context-ring').click();
  await expect(page.getByTestId('context-breakdown')).toContainText('终端主机');
  await shot(page, '15-agent-context');
  await page.keyboard.press('Escape');

  // 展开引用：分类查看
  await page.getByTestId('refs-expand').click();
  const refsPanel = page.getByTestId('refs-panel');
  await expect(refsPanel).toContainText('知识库');
  // 按类别切换：终端里列出已连接的终端，Skill 里可以勾选
  expect(await refsPanel.locator('.refs-row.on').count()).toBeGreaterThan(0);
  await refsPanel.getByTestId('refs-cat-skill').click();
  await expect(refsPanel).toContainText('主机健康巡检');
  await refsPanel.locator('.refs-row').filter({ hasText: '主机健康巡检' }).click();
  await expect(page.getByTestId('agent-refs')).toContainText('主机健康巡检');
  await expect(refsPanel.getByTestId('refs-cat-skill')).toContainText('1');
  await shot(page, '16-agent-refs');
  // 再点一次取消，不影响后面的对话
  await refsPanel.locator('.refs-row').filter({ hasText: '主机健康巡检' }).click();
  await page.keyboard.press('Escape');

  // 复核请求用的是单独的提示词
  expect(llm.requests.some((r) => String((r.body as { system?: string }).system).includes('命令安全审查器'))).toBe(true);
  // 发给模型的历史只追加：第三次请求以第二次请求的消息为前缀（只看 Agent 的请求）
  const agentRequests = llm.requests
    .slice(1)
    .map((r) => r.body as { system: string; messages: unknown[] })
    .filter((b) => b.system.includes('运维助手'));
  expect(agentRequests).toHaveLength(3);
  expect(JSON.stringify(agentRequests[2].messages.slice(0, agentRequests[1].messages.length))).toBe(JSON.stringify(agentRequests[1].messages));

  await app.close();
});
