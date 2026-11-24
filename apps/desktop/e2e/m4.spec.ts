import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * M4：会话录像与审计、自动更新、服务端连接（任务执行器、远程审批、审计上报）。
 */
let root: string;
let server: TestSshServer;

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const e = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '', ...env };
  const packaged = process.env.ITM_E2E_EXECUTABLE;
  const app = packaged ? await electron.launch({ executablePath: packaged, args: [], env: e }) : await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env: e });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'screens', `${name}.png`) });
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-m4-'));
  mkdirSync(join(root, 'remote'));
  server = await startTestSshServer({ root: join(root, 'remote') });
});

test.afterAll(async () => {
  await server?.close();
  rmSync(root, { recursive: true, force: true });
});

test('审计：手动命令进审计，SSH 会话自动录像并可以回放', async () => {
  const { app, page } = await launch();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('rec-host');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(server.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  await page.getByTestId('host-save').click();
  await page.getByTestId('connect-rec-host').click();
  await page.getByRole('button', { name: '信任并连接' }).click();
  await expect(page.getByTestId('tab-rec-host').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');
  await page.getByTestId('terminal-rec-host').locator('.xterm').click();
  await page.keyboard.type('echo audit-me-please', { delay: 10 });
  await page.keyboard.press('Enter');
  // 终端用 WebGL 渲染，DOM 里没有文字：等一下让输出写进录像
  await page.waitForTimeout(800);
  await page.getByTestId('tab-rec-host').locator('.ws-top-tab-close').click();

  await page.getByTestId('nav-audit').click();
  await page.getByTestId('audit-tab-cmd').click();
  const cmds = page.getByTestId('audit-table-COMMAND');
  await expect(cmds).toContainText('echo audit-me-please');
  // 第三十五轮：「用户」一列手动执行显示当前账号（本地模式为「本机」）
  await expect(cmds).toContainText('本机');
  await expect(cmds).toContainText('rec-host');
  await shot(page, 'm4-01-audit-commands');

  await page.getByTestId('audit-tab-conn').click();
  const recs = page.getByTestId('recording-table');
  await expect(recs).toContainText('rec-host');
  await recs.getByTestId('recording-play').first().click();
  await expect(page.getByTestId('rec-player')).toBeVisible();
  await expect(page.getByTestId('rec-term')).toContainText('audit-me-please', { timeout: 15_000 });
  await shot(page, 'm4-02-recording-player');
  await app.close();
});

/** 模拟后端发布服务：GET /api/v1/releases/{channel}/{os}/{arch}/latest*.yml */
async function startReleaseServer(spec: { version: string; minimum?: string; notes?: string; staging?: number }) {
  const { createServer } = await import('node:http');
  const requests: string[] = [];
  const srv = createServer((req, res) => {
    requests.push(req.url ?? '');
    // electron-updater 会带上 ?noCache=… 防止缓存
    const path = (req.url ?? '').split('?')[0];
    if (/\/api\/v1\/releases\/(stable|beta)\/\w+\/\w+\/latest(-mac|-linux)?\.yml$/.test(path)) {
      const channel = /\/releases\/(\w+)\//.exec(req.url ?? '')![1];
      res.writeHead(200, { 'content-type': 'text/yaml' });
      res.end(
        [
          `version: ${channel === 'beta' ? `${spec.version}-beta.1` : spec.version}`,
          'files:',
          '  - url: iTerminal-update.zip',
          '    sha512: AAAA',
          '    size: 1048576',
          'path: iTerminal-update.zip',
          'sha512: AAAA',
          "releaseDate: '2026-10-15T00:00:00.000Z'",
          `releaseNotes: ${spec.notes ?? '修复若干问题'}`,
          ...(spec.minimum ? [`minimumSupportedVersion: ${spec.minimum}`] : []),
          ...(spec.staging !== undefined ? [`stagingPercentage: ${spec.staging}`] : []),
          '',
        ].join('\n'),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, requests, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

test('自动更新：检查新版本、切换渠道、低于最低版本时强制升级', async () => {
  const spec: { version: string; minimum: string; notes: string; staging?: number } = { version: '9.9.0', minimum: '0.0.1', notes: '新增命令安全配置' };
  const rel = await startReleaseServer(spec);
  const env = { ITM_UPDATE_SERVER: rel.url, ITM_UPDATE_FORCE_DEV: '1', ITM_UPDATE_CHECK_DELAY_MS: '600000' };
  let { app, page } = await launch(env);
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-about').click();
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-status')).toContainText('发现新版本 9.9.0');
  await expect(page.getByTestId('update-notes')).toContainText('新增命令安全配置');
  await expect(page.getByTestId('update-download')).toBeVisible();
  expect(rel.requests.some((u) => /\/api\/v1\/releases\/stable\/(mac|linux|win)\/\w+\/latest/.test(u))).toBe(true);
  await shot(page, 'm4-03-update-available');

  // 切到测试版渠道
  await page.getByTestId('update-channel').getByText('测试版').click();
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-status')).toContainText('发现新版本 9.9.0-beta.1');
  expect(rel.requests.some((u) => u.includes('/releases/beta/'))).toBe(true);
  await page.getByTestId('update-channel').getByText('正式版').click();

  // 灰度（文档一 11.5）：服务端在 yml 里写 stagingPercentage，electron-updater 按设备 ID 的哈希决定这台设备是否更新
  spec.staging = 0;
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-status')).toContainText('已经是最新版本');
  spec.staging = 100;
  await page.getByTestId('update-check').click();
  await expect(page.getByTestId('update-status')).toContainText('发现新版本 9.9.0');
  await app.close();
  await rel.close();

  // 服务端要求的最低版本高于当前版本：启动检查后弹出不能关闭的升级窗口
  const forced = await startReleaseServer({ version: '9.9.0', minimum: '9.0.0' });
  ({ app, page } = await launch({ ...env, ITM_UPDATE_SERVER: forced.url, ITM_UPDATE_CHECK_DELAY_MS: '500' }));
  await expect(page.getByTestId('update-forced-download')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.ant-modal').filter({ hasText: '需要升级' })).toContainText('低于最低支持版本 9.0.0');
  await shot(page, 'm4-04-update-forced');
  await app.close();
  await forced.close();
});

test('服务端：远程审批（审批人侧）、定时任务派发到本机执行并回报，定时任务页可以看到', async () => {
  const { startMockServer } = await import('../test/support/mock-server');
  const mock = await startMockServer();
  const { app, page } = await launch({ ITM_SERVER_URL: mock.url, ITM_SERVER_TOKEN: mock.token });
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1', { timeout: 15_000 });
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-online', '1');
  await mock.waitFor((m) => m.type === 'hello');

  // 审批人侧：服务端推来审批请求 → 侧栏「审批」显示数量 → 应用内提醒 → 批准
  mock.send(
    'approval.request',
    {
      approvalId: 'ap-e2e-1',
      runId: 'run-other',
      taskName: '夜间清理',
      host: 'db-01',
      command: 'rm -rf /data/tmp/*',
      risk: 'L1',
      reasons: ['删除文件'],
      explanation: '清理临时目录，释放磁盘空间',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    { ack: true },
  );
  // 第三十四轮：审批在 ··· 更多菜单里，数字在菜单项上
  await page.getByTestId('rail-more').hover();
  await expect(page.getByTestId('nav-approvals-count')).toHaveText('1');
  await page.mouse.move(900, 500);
  await page.getByTestId('approval-notify-open').click();
  const card = page.getByTestId('approval-card');
  await expect(card).toContainText('夜间清理');
  await expect(card).toContainText('db-01');
  await expect(card.getByTestId('approval-command')).toHaveText('rm -rf /data/tmp/*');
  await expect(card.getByTestId('approval-explanation')).toContainText('清理临时目录');
  await expect(card.getByTestId('approval-left')).toContainText('剩余');
  await shot(page, 'm4-05-remote-approval');
  await card.getByTestId('approval-comment').fill('确认过了');
  await card.getByTestId('approval-approve').click();
  const decided = await mock.waitFor((m) => m.type === 'approval.decide');
  expect(decided.payload).toMatchObject({ approvalId: 'ap-e2e-1', decision: 'APPROVED', comment: '确认过了' });
  await expect(page.getByTestId('approval-card')).toHaveCount(0);
  await page.getByTestId('rail-more').hover();
  await expect(page.getByTestId('nav-approvals-count')).toHaveCount(0);
  await page.mouse.move(900, 500);

  // 别人已经处理的审批：收到 approval.result 后自动移除
  mock.send('approval.request', { approvalId: 'ap-e2e-2', runId: 'run-other', host: 'db-02', command: 'systemctl restart nginx', risk: 'L2', reasons: [], expiresAt: Date.now() + 60_000 }, { ack: true });
  await expect(page.getByTestId('approval-card')).toHaveCount(1);
  mock.send('approval.result', { approvalId: 'ap-e2e-2', runId: 'run-other', decision: 'REJECTED', by: 'someone' }, { ack: true });
  await expect(page.getByTestId('approval-card')).toHaveCount(0);

  // 执行器侧：派发到本机的命令任务（只读上限，写操作走远程审批，模拟服务端自动批准）
  // 渲染进程里的 window.itm（preload 暴露的桥）
  const hosts = (await page.evaluate(() => (globalThis as unknown as { itm: { invoke(c: string): Promise<unknown> } }).itm.invoke('host.list'))) as { id: string; name: string }[];
  let host = hosts.find((h) => h.name === 'rec-host');
  if (!host) {
    host = (await page.evaluate(
      (port) =>
        (globalThis as unknown as { itm: { invoke(c: string, a: unknown): Promise<unknown> } }).itm.invoke('host.create', {
          folderId: null, name: 'task-host', address: '127.0.0.1', port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
        }),
      server.port,
    )) as { id: string; name: string };
  }
  mock.autoDecide('APPROVED');
  mock.send('task.dispatch', { runId: 'run-e2e-1', taskId: 'task-1', taskName: 'E2E 巡检', type: 'COMMAND', command: 'touch e2e-task-flag', hosts: [host.id, 'srv-missing'], permissionCap: 'READONLY', timeoutMin: 5 }, { ack: true });
  // 第一次连接这台主机：可能要确认主机指纹
  const trust = page.getByRole('button', { name: '信任并连接' });
  const result = mock.waitFor((m) => m.type === 'task.result' && m.payload?.runId === 'run-e2e-1', 30_000);
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), result]);
  const r = await result;
  const rh = r.payload!.hosts as { hostId: string; status: string }[];
  expect(rh.find((h) => h.hostId === host!.id)?.status).toBe('SUCCESS');
  expect(rh.find((h) => h.hostId === 'srv-missing')?.status).toBe('SKIPPED');
  expect(r.payload!.status).toBe('PARTIAL');
  expect(mock.rest.some((x) => x.path === '/api/v1/sched/runs/run-e2e-1/approvals')).toBe(true);
  expect(server.execs).toContain('touch e2e-task-flag');

  // 第三十五轮去掉了客户端的「定时任务」页：服务端派发的执行照常回报（上面已经验证），执行记录在服务端管理后台查看

  // 审计上报：命令记录批量上报到服务端
  await expect.poll(() => mock.rest.some((x) => x.path === '/api/v1/audit/commands:batch'), { timeout: 15_000 }).toBe(true);
  await app.close();
  await mock.close();
});
