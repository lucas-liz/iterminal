import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * README 用的截图（不是功能测试）：只在 ITM_DOC_SHOTS=1 时运行，输出到仓库根目录的 docs/images/。
 *   ITM_DOC_SHOTS=1 npx playwright test e2e/docs-screenshots.spec.ts
 * 全部是虚构的演示数据：主机都指向进程内的测试 SSH 服务器，AI 由脚本化的模拟模型回答；
 * Agent 只读取下面写进测试目录的假文件，截图里不会出现本机的真实信息。
 */
const OUT = join(__dirname, '..', '..', '..', 'docs', 'images');
let root: string;
let ssh: TestSshServer;
let llm: LlmMock;

test.skip(process.env.ITM_DOC_SHOTS !== '1', '只在生成文档截图时运行（ITM_DOC_SHOTS=1）');
test.describe.configure({ mode: 'serial' });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setSize(1440, 900);
    w.center();
  });
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  await page.mouse.move(1430, 890);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

/** 关掉所有打开的对话框（主机编辑框不响应 Esc） */
async function closeModals(page: Page): Promise<void> {
  for (let i = 0; i < 5; i++) {
    const close = page.locator('.ant-modal-wrap:visible .ant-modal-close');
    if (!(await close.count())) break;
    await close.last().click();
    await page.waitForTimeout(300);
  }
}

async function trustIfAsked(page: Page): Promise<void> {
  const trust = page.getByRole('button', { name: '信任并连接' });
  for (let i = 0; i < 4; i++) if (!(await trust.first().click({ timeout: i === 0 ? 5000 : 1500 }).then(() => true, () => false))) break;
}

/** 演示数据：两个分组（生产环境带分组说明）、几台主机（主机记忆、Agent 记忆）、一条笔记、模型 */
async function seed(page: Page): Promise<Record<string, string>> {
  await call(page, 'setting.set', { key: 'ui.theme', value: 'dark' });
  await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  const p = await call<{ id: string }>(page, 'ai.providers.save', {
    id: null,
    input: { name: '演示模型', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'demo', enabled: true, models: [{ id: 'demo-model', contextWindow: 128000, maxOutput: 4096 }] },
  });
  await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'demo-model' } });
  const prod = await call<{ id: string }>(page, 'folder.create', { parentId: null, name: '生产环境' });
  const order = await call<{ id: string }>(page, 'folder.create', { parentId: prod.id, name: '订单服务' });
  const test2 = await call<{ id: string }>(page, 'folder.create', { parentId: null, name: '测试环境' });
  await call(page, 'folder.update', {
    id: prod.id,
    settings: { defaultCredentialId: null, defaultJumpHostId: null, agentPolicy: 'APPROVE', aiNote: '生产环境：变更窗口 22:00-24:00，重启服务前先摘流量；负责人：运维值班', defaultSkills: [], production: true },
  });
  await call(page, 'folder.update', {
    id: order.id,
    settings: { defaultCredentialId: null, defaultJumpHostId: null, agentPolicy: null, aiNote: '订单服务：Java 17 + Nginx 反向代理，日志在 /data/logs/order', defaultSkills: [], production: false },
  });
  const ids: Record<string, string> = {};
  const hosts: [string, string, string, string | null][] = [
    ['web-01', order.id, '订单前端 Nginx', 'Nginx 1.24，配置在 /etc/nginx/conf.d/order.conf；access 日志按天切割'],
    ['web-02', order.id, '订单前端 Nginx（备）', null],
    ['order-api-01', order.id, '订单服务 API', 'Spring Boot 服务，systemd 单元 order-api.service，JVM 堆 4G'],
    ['db-master', prod.id, 'MySQL 8.0 主库', 'MySQL 8.0 主库，数据目录 /data/mysql，每天 02:00 全量备份'],
    ['redis-01', prod.id, 'Redis 缓存', null],
    ['test-app-01', test2.id, '测试环境应用', null],
  ];
  for (const [name, folderId, note, aiMemory] of hosts) {
    const h = await call<{ id: string }>(page, 'host.create', {
      folderId, name, address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note, jumpHostIds: [], aiMemory,
    });
    ids[name] = h.id;
  }
  for (const m of ['nginx 的 worker_processes 是 auto，upstream 指向 order-api-01:8080', '磁盘 /data 在 2026-11 用到 78%，日志清理脚本在 /opt/scripts/clean-logs.sh']) {
    await call(page, 'host.agentMemory.save', { id: null, hostId: ids['web-01'], content: m });
  }
  await call(page, 'snippet.save', { id: null, input: { groupId: null, name: '查看磁盘和内存', content: 'df -h && free -m', description: '巡检常用', tags: [] } });
  await call(page, 'setting.set', { key: 'monitor.dashboardHosts', value: [ids['web-01'], ids['order-api-01'], ids['db-master']] });
  return ids;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-docs-'));
  const remote = join(root, 'remote');
  mkdirSync(join(remote, 'logs', 'nginx'), { recursive: true });
  // Agent 读取的假文件（截图里显示的命令输出）
  writeFileSync(
    join(remote, 'logs', 'disk-usage.txt'),
    ['Filesystem      Size  Used Avail Use% Mounted on', '/dev/vda1        40G   18G   20G  48% /', '/dev/vdb1       200G  171G   29G  86% /data', 'tmpfs           3.9G     0  3.9G   0% /dev/shm', ''].join('\n'),
  );
  writeFileSync(
    join(remote, 'logs', 'nginx', 'error.log'),
    [
      '2026/11/24 09:12:03 [warn] 2190#0: *88213 an upstream response is buffered to a temporary file',
      '2026/11/24 09:14:47 [error] 2190#0: *88540 upstream timed out (110: Connection timed out) while reading response header from upstream, upstream: "http://10.0.0.21:8080/api/order/list"',
      '2026/11/24 09:14:52 [error] 2190#0: *88541 upstream timed out (110: Connection timed out) while reading response header from upstream, upstream: "http://10.0.0.21:8080/api/order/list"',
      '2026/11/24 09:15:10 [error] 2190#0: *88603 no live upstreams while connecting to upstream',
      '',
    ].join('\n'),
  );
  ssh = await startTestSshServer({ root: remote, fakeLinuxMonitor: { cwd: remote } });
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await ssh?.close();
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('README 截图', async () => {
  test.setTimeout(240_000);
  let { app, page } = await launch();
  await seed(page);
  await app.close();
  ({ app, page } = await launch());
  await page.waitForTimeout(800);

  // 1. 主机：分组树（生产环境带盾牌标记）+ 主机列表
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('folder-生产环境').click();
  await page.waitForTimeout(400);
  await shot(page, '01-hosts');

  // 2. 分组设置：Agent 权限、生产环境、分组说明（分组记忆）
  await page.getByTestId('folder-生产环境').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '分组设置…' }).click();
  await expect(page.getByTestId('folder-settings')).toBeVisible();
  await shot(page, '02-group-settings');
  await page.keyboard.press('Escape');

  // 3. 主机记忆：主机编辑里的「主机记忆」+ Agent 自己记下的记忆
  await page.getByText('web-01', { exact: true }).first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await page.getByText('AI：Agent 权限、命令黑名单、主机记忆').click();
  await page.waitForTimeout(400);
  await page.getByTestId('agent-memory-open').click();
  await expect(page.getByTestId('agent-memory-modal')).toBeVisible();
  await shot(page, '03-host-memory');
  await closeModals(page);

  // 4. 终端 + 右侧 AI：Agent 在引用的终端主机上排查，自动记录验证过的主机记忆
  await page.getByTestId('connect-web-01').click();
  await trustIfAsked(page);
  await expect(page.getByTestId('tab-web-01').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
  await page.waitForTimeout(600);
  await page.getByTestId('right-ai').click();
  const side = page.getByTestId('agent-panel');
  llm.enqueue(
    {
      text: '先看一下 Nginx 的错误日志和磁盘使用情况。',
      toolCalls: [
        { id: 'c1', name: 'run_command', input: { host: 't1', command: 'tail -n 4 logs/nginx/error.log', explanation: '查看最近的 Nginx 错误' } },
        { id: 'c2', name: 'run_command', input: { host: 't1', command: 'cat logs/disk-usage.txt', explanation: '查看磁盘使用率' } },
      ],
    },
    { toolCalls: [{ id: 'm1', name: 'memory_propose', input: { host: 't1', memory: 'upstream order-api 在 10.0.0.21:8080，超时时 Nginx 报 no live upstreams', certainty: 'confirmed' } }] },
    {
      text: [
        '## 排查结论',
        '',
        '1. **502 的原因**：上游 `order-api`（10.0.0.21:8080）读取响应超时，之后 Nginx 判定 **no live upstreams**。问题在后端服务，不在 Nginx 本身。',
        '2. **磁盘**：`/data` 已用 **86%**，暂不影响服务，建议本周清理旧日志。',
        '',
        '**建议下一步**：到 `order-api-01` 上看服务状态和 GC 日志，需要的话我可以帮你重启服务（写操作会先请你批准）。',
      ].join('\n'),
    },
  );
  await side.getByTestId('agent-input').fill('web-01 上订单页面一直 502，帮我看看是什么原因');
  await side.getByTestId('agent-input').press('Enter');
  // 生产环境分组：只读命令也要你点「执行」确认
  const done = side.getByText('排查结论');
  let shotTaken = false;
  for (let i = 0; i < 20 && !(await done.isVisible()); i++) {
    const run = side.getByTestId('approve').first();
    if (await run.isVisible()) {
      if (!shotTaken) {
        await shot(page, '05-approval');
        shotTaken = true;
      }
      await run.click();
    }
    // 生产环境的命令还要再点一次「确认执行」
    const confirm = side.getByTestId('approve-confirm').first();
    if (await confirm.isVisible()) await confirm.click();
    await page.waitForTimeout(700);
  }
  await expect(done).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await shot(page, '04-terminal-ai');

  // 6. Agent 权限：只读 / 自动 / 完全允许
  await side.getByTestId('agent-mode').click();
  await expect(page.getByTestId('chat-policy-panel')).toBeVisible();
  await shot(page, '06-agent-policy');
  await page.keyboard.press('Escape');

  // 7. AI 对话模式：整页对话 + 会话列表
  await page.getByTestId('mode-ai').click();
  await expect(page.getByTestId('ai-page')).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, '07-ai-mode');
  await page.getByTestId('mode-terminal').click();

  // 8. 批量执行命令
  await page.getByTestId('nav-batch').click();
  await page.getByTestId('batch-exec-hosts').click();
  for (const n of ['web-01', 'web-02', 'order-api-01']) await page.getByTestId('resident-table').getByText(n, { exact: true }).click();
  await page.getByTestId('resident-save').click();
  await page.getByTestId('batch-exec-desc').fill('订单服务巡检');
  await page.getByTestId('batch-editor-content').click();
  for (const [i, line] of ['echo "== $(hostname)"', 'cat logs/disk-usage.txt | grep /data', 'echo "nginx: active (running)"'].entries()) {
    if (i) await page.keyboard.press('Enter');
    await page.keyboard.type(line, { delay: 5 });
  }
  await shot(page, '08-batch-exec');
  await page.getByTestId('batch-exec-run').click();
  await page.getByTestId('batch-exec-confirm').click();
  await trustIfAsked(page);
  await expect(page.getByTestId('batch-host-list').locator('[data-status="success"]')).toHaveCount(3, { timeout: 20_000 });
  await page.getByTestId('batch-host-web-01').locator('.batch-host-head').click();
  await shot(page, '09-batch-result');
  await page.keyboard.press('Escape');

  // 9. 监控（常驻主机）
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('rail-more-menu').getByTestId('nav-monitor').click();
  await page.mouse.move(700, 500);
  await trustIfAsked(page);
  await expect(page.locator('.mon-card').first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(4000);
  await shot(page, '10-monitor');

  // 10. 运维审计：连接日志、命令记录
  await page.getByTestId('nav-workspace').click();
  await page.getByTestId('tab-web-01').locator('.ws-top-tab-close').click();
  await page.getByRole('button', { name: /关闭|断开/ }).last().click({ timeout: 2000 }).catch(() => undefined);
  await page.getByTestId('nav-audit').click();
  await expect(page.getByTestId('recording-table')).toContainText('web-01');
  await shot(page, '11-audit-connections');
  await page.getByTestId('audit-tab-cmd').click();
  await expect(page.getByTestId('audit-table-COMMAND')).toContainText('logs');
  await shot(page, '12-audit-commands');

  // 11. MCP 服务：把操作服务器的能力开放给 Claude Code / Codex / Cursor 等外部 Agent（它们拿不到凭证）
  await call(page, 'setting.set', { key: 'mcp.server.enabled', value: true });
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-ext').click();
  await page.getByTestId('settings-tab-mcp').click();
  await expect(page.getByTestId('mcp-host-url')).toContainText('/mcp');
  await page.waitForTimeout(500);
  await shot(page, '13-mcp-server');
  await app.close();
});
