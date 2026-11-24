import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connect as tcpConnect, createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';
import { startTestTelnetServer, type TestTelnetServer } from '../test/support/telnet-server';

/**
 * M3：快捷命令与笔记、Telnet / 串口、端口转发、SFTP 增强、监控、Skill、MCP、导出导入。
 */
let root: string;
let server: TestSshServer;
let llm: LlmMock;
let telnet: TestTelnetServer;

async function launch(userData = 'userData'): Promise<{ app: ElectronApplication; page: Page }> {
  // ITM_SERIAL_MOCK：两个会回显的模拟串口 /dev/ITM-MOCK0、/dev/ITM-MOCK1
  const env = { ...process.env, ITM_USER_DATA: join(root, userData), ITM_INSECURE_KEYSTORE: '1', ITM_SERIAL_MOCK: '1', ELECTRON_RENDERER_URL: '' };
  const packaged = process.env.ITM_E2E_EXECUTABLE;
  const app = packaged
    ? await electron.launch({ executablePath: packaged, args: [], env })
    : await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'screens', `${name}.png`) });
}

async function typeLine(page: Page, testId: string, text: string, enter = true): Promise<void> {
  await page.getByTestId(testId).locator('.xterm').click();
  await page.keyboard.type(text, { delay: 15 });
  if (enter) await page.keyboard.press('Enter');
}

/** 设置 AI 模型、添加并连接一台 SSH 主机 */
async function prepare(page: Page): Promise<void> {
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-models').click();
  await page.getByTestId('add-provider').click();
  await page.getByTestId('vendor-tabs').getByText('海外平台').click();
  await page.getByTestId('vendor-anthropic').click();
  // 新建服务商时不预先填模型：从官方模型里全部添加
  await page.getByTestId('preset-models').click();
  await page.getByRole('menuitem', { name: '全部添加' }).click();
  await page.getByTestId('provider-name').fill('Claude');
  await page.getByTestId('provider-url').fill(llm.url);
  await page.getByTestId('provider-key').fill('test-key');
  await page.getByTestId('provider-save').click();
  await expect(page.locator('.provider-item').filter({ hasText: 'Claude' })).toBeVisible();

  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('web');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(server.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByTestId('connect-web').click();
  await page.getByRole('button', { name: '信任并连接' }).click();
  await expect(page.getByTestId('tab-web').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-m3-'));
  mkdirSync(join(root, 'remote'));
  server = await startTestSshServer({ root: join(root, 'remote'), allowForward: true, fakeLinuxMonitor: { cwd: '/' } });
  llm = await startLlmMock();
  telnet = await startTestTelnetServer();
});

test.afterAll(async () => {
  await server?.close();
  await llm?.close();
  await telnet?.close();
  rmSync(root, { recursive: true, force: true });
});

test('快捷命令与笔记', async () => {
  const { app, page } = await launch();
  await prepare(page);

  // 1. 指令集：新建分组和带变量的命令，发送前填写变量
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-snippets').click();
  await page.getByTestId('snippet-group-new-group').click();
  await page.getByTestId('snippet-group-group-name').fill('运维');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('snippet-group-运维')).toBeVisible();

  await page.getByTestId('snippet-new').click();
  await page.getByTestId('snippet-name').fill('看日志');
  await page.getByTestId('snippet-content').fill('tail -n {{lines:20}} {{file}}');
  await expect(page.getByText('lines（默认 20）')).toBeVisible();
  await page.getByTestId('snippet-save').click();
  await expect(page.getByTestId('snippet-row-看日志')).toBeVisible();
  await expect(page.getByTestId('snippet-group-运维')).toContainText('1');

  await page.getByTestId('snippet-send-看日志').click();
  await page.getByTestId('snippet-var-file').fill('/var/log/app.log');
  await expect(page.getByTestId('snippet-preview')).toHaveText('tail -n 20 /var/log/app.log');
  await shot(page, 'm3-01-snippet-run');
  await page.getByTestId('snippet-run-ok').click();
  await expect.poll(() => server.lines.includes('tail -n 20 /var/log/app.log')).toBe(true);

  // 2. 没有变量的命令直接发送；标签行的「快捷指令」也能发送（第十二轮去掉了终端右侧的「命令」面板）
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-snippets').click();
  await page.getByTestId('snippet-group-all').click();
  await page.getByTestId('snippet-new').click();
  await page.getByTestId('snippet-name').fill('打招呼');
  await page.getByTestId('snippet-content').fill('echo snippet-direct');
  await page.getByTestId('snippet-save').click();
  await page.getByTestId('snippet-send-打招呼').click();
  await expect.poll(() => server.lines.filter((l) => l === 'echo snippet-direct').length).toBe(1);
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await page.getByTestId('tab-quick').click();
  await page.getByTestId('quick-打招呼').click();
  await expect.poll(() => server.lines.filter((l) => l === 'echo snippet-direct').length).toBe(2);
  await shot(page, 'm3-02-snippet-panel');

  // 3. 快捷命令也是命令提示的候选
  await typeLine(page, 'xterm-tab-1', 'echo snip', false);
  await expect(page.getByTestId('term-suggest-row').filter({ hasText: 'echo snippet-direct' }).first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('term-suggest')).toHaveCount(0);
  await page.keyboard.press('Control+U');

  // 4. 终端右键：当前屏幕存为笔记 → 打开笔记页查看
  const screen = page.getByTestId('xterm-tab-1').locator('.xterm-screen');
  const box = (await screen.boundingBox())!;
  await page.keyboard.down('Control');
  await page.mouse.click(box.x + 300, box.y + 300, { button: 'right' });
  await page.keyboard.up('Control');
  await page.getByRole('menuitem', { name: '当前屏幕存为笔记' }).click();
  await page.getByRole('button', { name: '查看' }).click();
  await expect(page.getByTestId('note-editor')).toBeVisible();
  await expect(page.getByTestId('note-title')).toHaveValue(/^web · /);
  await expect(page.locator('.note-preview')).toContainText('welcome to test server');

  // 5. 新建笔记、编辑后自动保存、置顶
  await page.getByTestId('note-new').click();
  await page.getByTestId('note-title').fill('磁盘排障');
  await page.getByTestId('note-content').fill('先看 df -h，再看 du -sh /var/log/*');
  await expect(page.getByTestId('note-item-磁盘排障')).toContainText('先看 df -h');
  await page.getByTestId('note-pin').click();
  await expect(page.locator('.note-item').first()).toContainText('磁盘排障');
  await shot(page, 'm3-03-notes');

  // 6. 笔记引用到 AI：发给模型的上下文里带着笔记正文；AI 回答可以存为笔记
  await page.getByRole('button', { name: '引用到 AI' }).click();
  await expect(page.getByTestId('agent-refs')).toContainText('磁盘排障');
  llm.enqueue({ text: '按笔记的步骤排查即可。' });
  await page.getByTestId('agent-input').fill('磁盘怎么排查');
  await page.getByTestId('agent-send').click();
  await expect(page.getByText('按笔记的步骤排查即可。')).toBeVisible();
  expect(JSON.stringify(llm.requests.at(-1)?.body)).toContain('先看 df -h，再看 du -sh');
  await page.getByTestId('answer-save-note').last().click();
  await page.getByRole('button', { name: '查看' }).click();
  await expect(page.getByTestId('note-title')).toHaveValue('磁盘怎么排查');
  await expect(page.locator('.note-item')).toHaveCount(3);
  await app.close();
});

/** 让主进程的保存 / 打开文件对话框直接返回指定路径（原生对话框没法自动操作） */
async function stubDialogs(app: ElectronApplication, save: string | null, open: string | null): Promise<void> {
  await app.evaluate(
    ({ dialog }, p) => {
      dialog.showSaveDialog = (async () => ({ canceled: !p.save, filePath: p.save ?? undefined })) as typeof dialog.showSaveDialog;
      dialog.showOpenDialog = (async () => ({ canceled: !p.open, filePaths: p.open ? [p.open] : [] })) as typeof dialog.showOpenDialog;
    },
    { save, open },
  );
}

/** 等日志文件里出现某段文字 */
async function logContains(path: string, text: string): Promise<void> {
  await expect.poll(() => (existsSync(path) ? readFileSync(path, 'utf8') : ''), { timeout: 10_000 }).toContain(text);
}

test('Telnet 与串口', async () => {
  const { app, page } = await launch();

  // 1. Telnet：自动登录、发送命令、状态栏显示连接信息
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-protocol').getByText('Telnet').click();
  await page.getByTestId('host-name').fill('router');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(telnet.port));
  await page.getByTestId('host-username').fill('admin');
  await page.getByTestId('host-password').fill('pw');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByTestId('connect-router').click();
  await expect.poll(() => telnet.logins).toEqual([{ username: 'admin', password: 'pw' }]);
  await expect(page.getByTestId('tab-router').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');
  await expect(page.locator('.statusbar-note')).toContainText(`Telnet · 127.0.0.1:${telnet.port}`);
  await expect.poll(() => telnet.termTypes).toEqual(['xterm-256color']);
  await typeLine(page, 'xterm-tab-1', 'show running-config');
  await expect.poll(() => telnet.lines).toContain('show running-config');

  // 2. 录制日志：右键开始录制，输出写进文件，状态条显示「录制日志中」
  const telnetLog = join(root, 'router.log');
  await stubDialogs(app, telnetLog, null);
  const box = (await page.getByTestId('xterm-tab-1').locator('.xterm-screen').boundingBox())!;
  await page.keyboard.down('Control');
  await page.mouse.click(box.x + 300, box.y + 300, { button: 'right' });
  await page.keyboard.up('Control');
  await page.getByRole('menuitem', { name: '录制日志到文件…' }).click();
  await expect(page.getByTestId('log-badge')).toBeVisible();
  await typeLine(page, 'xterm-tab-1', 'show version');
  await logContains(telnetLog, 'echo:show version');
  await shot(page, 'm3-04-telnet');
  await page.getByTestId('log-badge').getByRole('button', { name: '停止' }).click();
  await expect(page.getByTestId('log-badge')).toHaveCount(0);

  // 3. 串口：模拟串口会回显；回车按 CR 发送；HEX 显示；时间戳；DTR；发送十六进制
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-protocol').getByText('串口').click();
  await page.getByTestId('host-name').fill('board');
  await page.getByTestId('host-address').locator('input').fill('/dev/ITM-MOCK0');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByTestId('connect-board').click();
  await expect(page.getByTestId('tab-board').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');
  await expect(page.getByTestId('serial-bar')).toBeVisible();
  await expect(page.locator('.statusbar-note').last()).toContainText('串口 · /dev/ITM-MOCK0 · 115200 8N1');
  const serialLog = join(root, 'board.log');
  await stubDialogs(app, serialLog, null);
  const sbox = (await page.getByTestId('xterm-tab-2').locator('.xterm-screen').boundingBox())!;
  await page.keyboard.down('Control');
  await page.mouse.click(sbox.x + 300, sbox.y + 300, { button: 'right' });
  await page.keyboard.up('Control');
  await page.getByRole('menuitem', { name: '录制日志到文件…' }).click();
  await typeLine(page, 'xterm-tab-2', 'AT+GMR');
  await logContains(serialLog, 'AT+GMR');
  await page.getByTestId('serial-hex').click();
  await page.getByTestId('serial-hex-input').locator('input').fill('AA 55 01');
  await page.getByTestId('serial-hex-input').locator('input').press('Enter');
  await logContains(serialLog, 'AA 55 01 ');
  await page.getByTestId('serial-hex').click();
  await page.getByTestId('serial-timestamp').click();
  await typeLine(page, 'xterm-tab-2', 'ping');
  await expect.poll(() => readFileSync(serialLog, 'utf8')).toMatch(/\[\d\d:\d\d:\d\d\.\d{3}\] ping/);
  await page.getByTestId('serial-dtr').click();
  await expect(page.getByTestId('serial-dtr')).toHaveAttribute('aria-checked', 'false');

  // 4. XMODEM 发送：设备没有开始接收时显示进度，可以取消
  const fw = join(root, 'fw.bin');
  writeFileSync(fw, Buffer.alloc(4096, 7));
  await stubDialogs(app, null, fw);
  await page.getByRole('button', { name: '发送文件' }).hover();
  await page.getByRole('menuitem', { name: 'XMODEM 发送…' }).click();
  await expect(page.getByTestId('serial-transfer')).toContainText('XMODEM fw.bin');
  await shot(page, 'm3-05-serial');
  await page.getByTestId('serial-transfer').getByRole('button').click();
  await expect(page.getByText('已取消')).toBeVisible();
  await expect(page.getByTestId('serial-transfer')).toHaveCount(0);
  await app.close();
});

/** 找一个空闲的本机端口 */
async function freePort(): Promise<number> {
  const srv = createTcpServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  await new Promise((r) => srv.close(r));
  return port;
}

test('端口转发', async () => {
  const echo = createTcpServer((s) => s.on('data', (d) => s.write(`echo:${d.toString()}`)));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  const echoPort = (echo.address() as { port: number }).port;
  const { app, page } = await launch();

  // 打开 web 的终端（第一个用例已经添加过这台主机）
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web').click();
  await expect(page.getByTestId('tab-web').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');

  // 添加本地转发：本机空闲端口 → 经过 web → echo 服务器
  const port = await freePort();
  await page.getByTestId('open-forwards').click();
  await page.getByTestId('pf-add').click();
  await page.getByTestId('pf-bind-port').fill(String(port));
  await page.getByTestId('pf-target-addr').fill('127.0.0.1');
  await page.getByTestId('pf-target-port').fill(String(echoPort));
  await page.getByTestId('pf-save').click();
  await page.getByTestId(`pf-toggle-${port}`).click();
  await expect(page.getByTestId(`pf-running-${port}`)).toBeVisible();

  const reply = await new Promise<string>((resolve, reject) => {
    const s = tcpConnect(port, '127.0.0.1', () => s.write('through-tunnel'));
    s.once('data', (d) => {
      resolve(d.toString());
      s.destroy();
    });
    s.once('error', reject);
  });
  expect(reply).toBe('echo:through-tunnel');
  await shot(page, 'm3-06-port-forward');
  // 刚点过的按钮的提示框还开着时，第一次 Esc 先关提示框：先把鼠标移开，等提示框消失
  await page.mouse.move(0, 0);
  await expect(page.locator('.ant-tooltip:not(.ant-tooltip-hidden)')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('statusbar-forwards')).toContainText('1');
  // 标签行的端口转发图标上显示运行中的数量
  await expect(page.locator('.tab-tools .ant-badge').filter({ has: page.getByTestId('open-forwards') })).toContainText('1');

  // 停止后端口不再监听
  await page.getByTestId('statusbar-forwards').click();
  await page.getByTestId(`pf-toggle-${port}`).click();
  await expect(page.getByTestId(`pf-running-${port}`)).toHaveCount(0);
  await expect
    .poll(
      () =>
        new Promise<boolean>((resolve) => {
          const s = tcpConnect(port, '127.0.0.1');
          s.once('connect', () => {
            s.destroy();
            resolve(true);
          });
          s.once('error', () => resolve(false));
        }),
    )
    .toBe(false);
  await app.close();
  echo.close();
});

test('SFTP 增强：冲突策略、内置编辑器、外部编辑自动回传', async () => {
  const localDir = join(root, 'local-sftp');
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(localDir, 'a.txt'), 'new content');
  writeFileSync(join(root, 'remote', 'a.txt'), 'old');
  writeFileSync(join(root, 'remote', 'app.conf'), 'port=80\n');
  const { app, page } = await launch();
  // 「用默认程序打开」改成记下路径（测试里不真的打开编辑器）
  await app.evaluate(({ shell }) => {
    (globalThis as { __itmOpened?: string }).__itmOpened = '';
    shell.openPath = async (p: string) => {
      (globalThis as { __itmOpened?: string }).__itmOpened = p;
      return '';
    };
  });

  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web').click();
  await expect(page.getByTestId('tab-web').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');
  await page.getByTestId('open-sftp-from-tab').click();
  const remotePane = page.getByTestId('pane-remote');
  await expect(remotePane.getByTestId('panel-file-a.txt')).toBeVisible();
  const localPath = page.getByTestId('path-local');
  await localPath.fill(localDir);
  await localPath.press('Enter');

  // 1. 同名文件：保留两者 → 远端多一个 a (1).txt，原文件不变
  await page.getByTestId('file-local-a.txt').click();
  await page.getByTestId('transfer-local').click();
  await expect(page.getByTestId('conflict-dialog')).toBeVisible();
  await page.getByTestId('conflict-rename').click();
  await page.getByRole('button', { name: '继续' }).click();
  await expect.poll(() => (existsSync(join(root, 'remote', 'a (1).txt')) ? readFileSync(join(root, 'remote', 'a (1).txt'), 'utf8') : '')).toBe('new content');
  expect(readFileSync(join(root, 'remote', 'a.txt'), 'utf8')).toBe('old');

  // 2. 跳过：显示「跳过 1 个」
  await page.getByTestId('transfer-local').click();
  await page.getByTestId('conflict-skip').click();
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByTestId('transfer-detail-a.txt').last()).toContainText('跳过 1 个');
  expect(readFileSync(join(root, 'remote', 'a.txt'), 'utf8')).toBe('old');

  // 3. 内置编辑器：直接修改远端文件
  // 远端窗格和右侧文件面板一样：右键菜单里编辑
  await remotePane.getByTestId('panel-file-app.conf').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await expect(page.getByTestId('remote-editor')).toHaveValue('port=80\n');
  await page.getByTestId('remote-editor').fill('port=8080\n');
  await page.waitForTimeout(400);
  await shot(page, 'm3-07-remote-editor');
  await page.getByTestId('editor-save').click();
  await expect.poll(() => readFileSync(join(root, 'remote', 'app.conf'), 'utf8')).toBe('port=8080\n');
  await page.getByTestId('editor-close').click();

  // 4. 用默认程序编辑：保存临时文件后自动回传；结束编辑删除临时文件
  await remotePane.getByTestId('panel-file-app.conf').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '用本地程序打开' }).click();
  await expect(page.getByTestId('edit-app.conf')).toBeVisible();
  const tmpFile = await app.evaluate(() => (globalThis as { __itmOpened?: string }).__itmOpened ?? '');
  expect(readFileSync(tmpFile, 'utf8')).toBe('port=8080\n');
  writeFileSync(tmpFile, 'port=9000\n');
  await expect(page.getByTestId('edit-app.conf')).toHaveAttribute('data-state', 'uploaded');
  expect(readFileSync(join(root, 'remote', 'app.conf'), 'utf8')).toBe('port=9000\n');
  await shot(page, 'm3-08-external-edit');
  await page.getByTestId('edit-app.conf').getByTestId('edit-stop').click();
  await expect(page.getByTestId('edit-app.conf')).toHaveCount(0);
  await expect.poll(() => existsSync(tmpFile)).toBe(false);
  await app.close();
});

test('监控看板：实时卡片、固定主机、历史与写满预测', async () => {
  const { app, page } = await launch();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-web').click();
  await expect(page.getByTestId('tab-web').locator('.status-dot')).toHaveCSS('background-color', 'rgb(82, 196, 26)');

  // 1. 打开了终端的 SSH 主机自动出现在看板上，显示实时 CPU
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-monitor').click();
  await expect(page.getByTestId('mon-card-web')).toBeVisible();
  await expect(page.getByTestId('mon-cpu-web')).toHaveText(/\d+\.\d%/);
  await shot(page, 'm3-09-monitor');

  // 2. 设为常驻（第二十七轮：在「添加常驻主机」里勾选）：关掉终端后仍然显示；取消常驻后消失
  await expect(page.getByTestId('mon-section-session')).toContainText('web');
  await page.getByTestId('mon-add').click();
  await page.getByTestId('resident-search').fill('web');
  await page.getByTestId('resident-table').locator('.ant-table-row').filter({ hasText: 'web' }).first().click();
  await page.getByTestId('resident-save').click();
  await expect(page.getByTestId('mon-section-resident').getByTestId('mon-card-web')).toBeVisible();
  await page.getByTestId('nav-workspace').click();
  await page.getByTestId('tab-web').locator('.ws-top-tab-close').click();
  await expect(page.getByTestId('tab-web')).toHaveCount(0);
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-monitor').click();
  await expect(page.getByTestId('mon-card-web')).toBeVisible();
  await expect(page.getByTestId('mon-cpu-web')).toHaveText(/\d+\.\d%/);

  // 3. 详情里有最近 7 天的历史（当前这一小时的采样）
  await page.getByTestId('mon-card-web').click();
  await expect(page.getByTestId('monitor-detail')).toBeVisible();
  await expect(page.getByTestId('monitor-history')).toBeVisible();
  await expect(page.getByTestId('chart-cpu-mem')).toBeVisible();
  await page.getByTestId('chart-cpu-mem').locator('svg').hover();
  await expect(page.getByTestId('chart-cpu-mem-tooltip')).toContainText('CPU');
  await shot(page, 'm3-10-monitor-history');
  await page.keyboard.press('Escape');

  await page.getByTestId('mon-pin-web').click();
  await expect(page.getByTestId('mon-card-web')).toHaveCount(0);
  await app.close();
});

test('Skill：对多台主机并行运行，写操作批量审批', async () => {
  // 准备一个并行、写操作需要审批的 Skill（本地档案的 Skill 目录）
  const skillDir = join(root, 'userData', 'profiles', 'local', 'skills', 'mark-hosts');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: mark-hosts\ntitle: 打部署标记\ndescription: 在每台主机上创建部署标记文件\nmode: parallel\nconcurrency: 2\nrisk: write-needs-approval\nallowed-tools: [ssh_exec]\nparams:\n  - { name: tag, type: string, default: v1 }\n---\n在 /tmp 下创建 deploy-{{tag}} 标记文件。\n',
  );
  // 子 Agent：先执行一条 touch，拿到结果后给结论；汇总请求返回固定文字
  llm.respond((body) => {
    if (JSON.stringify(body.system ?? '').includes('汇总')) return { text: '两台主机都已打上标记。' };
    const msgs = JSON.stringify(body.messages);
    const name = /只处理 h1（([^）]+)）/.exec(msgs)?.[1];
    if (!name) return undefined;
    if (msgs.includes('tool_result')) return { text: `${name} 标记完成` };
    return { toolCalls: [{ id: `t-${name}`, name: 'run_command', input: { host: 'h1', command: `touch /tmp/deploy-v2-${name}` } }] };
  });
  const { app, page } = await launch();

  // 再加一台主机（同一个测试服务器）
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('web2');
  await page.getByTestId('host-address').fill('127.0.0.1');
  await page.getByTestId('host-port').fill(String(server.port));
  await page.getByTestId('host-username').fill('tester');
  await page.getByTestId('host-password').fill('pw');
  await page.getByRole('button', { name: '保存' }).click();

  // 从主机菜单打开「运行 Skill」，再加上 web2，改参数
  await page.getByTestId('more-web').click();
  await page.getByRole('menuitem', { name: '运行 Skill…' }).click();
  await page.getByTestId('skill-run-skill').click();
  await page.locator('.ant-select-item-option').filter({ hasText: '打部署标记' }).click();
  await page.getByTestId('skill-run-hosts').click();
  await page.locator('.ant-select-item-option').filter({ hasText: 'web2' }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('skill-param-tag').fill('v2');
  await expect(page.getByTestId('skill-run-preview')).toContainText('将在 2 台主机上运行');
  await shot(page, 'm3-11-skill-dialog');
  await page.getByTestId('skill-run-ok').click();

  // AI 面板里显示运行卡片；两台主机的写操作合并成一张批量审批卡片
  await expect(page.getByTestId('skill-run')).toBeVisible();
  const batch = page.getByTestId('step-batch');
  await expect(batch.getByTestId('batch-command')).toHaveCount(2);
  await expect(batch.locator('input[type=checkbox]')).toHaveCount(2);
  for (const cb of await batch.locator('input[type=checkbox]').all()) await expect(cb).toBeChecked();
  await page.waitForTimeout(400);
  await shot(page, 'm3-12-skill-batch');
  await page.getByTestId('approve').click();
  await page.getByTestId('approve-confirm').click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByTestId('skill-run')).toHaveAttribute('data-status', 'done', { timeout: 20_000 });
  await expect(page.getByTestId('skill-run-summary')).toContainText('两台主机都已打上标记。');
  await expect(page.getByTestId('skill-host-web')).toHaveAttribute('data-status', 'done');
  await expect(page.getByTestId('skill-host-web2')).toHaveAttribute('data-status', 'done');
  expect(server.execs.filter((e) => e.startsWith('touch /tmp/deploy-v2-')).sort()).toEqual(['touch /tmp/deploy-v2-web', 'touch /tmp/deploy-v2-web2']);
  await expect(page.getByTestId('agent-send')).not.toHaveClass(/ant-btn-dangerous/);
  await shot(page, 'm3-13-skill-done');
  llm.respond(null);
  await app.close();
});

test('MCP：本机服务给外部 Agent 用；外部 MCP Server 给自己的 Agent 用', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { app, page } = await launch();

  // 1. 开启本机 MCP 服务（随机一个空闲端口），复制令牌
  const port = await freePort();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-ext').click();
  await page.getByTestId('settings-tab-mcp').click();
  await page.getByTestId('mcp-host-port').fill(String(port));
  await page.getByTestId('mcp-host-port').press('Enter');
  await expect(page.getByTestId('mcp-host-url')).toHaveText(`http://127.0.0.1:${port}/mcp`);
  await page.getByTestId('mcp-host-enabled').click();
  await expect(page.getByTestId('mcp-host-enabled')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.setting-row').filter({ hasText: '启用' }).first()).toContainText('运行中');
  await page.locator('.setting-row').filter({ hasText: '令牌' }).getByRole('button').first().click();
  const token = (await page.locator('.setting-row').filter({ hasText: '令牌' }).locator('code').innerText()).trim();
  expect(token).toMatch(/^itm_/);
  await shot(page, 'm3-14-mcp-settings');

  // 2. 外部 Agent：列主机；不弹审批，写操作按设置里勾选的权限（第十三轮，6.27.5）
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const list = await client.callTool({ name: 'list_hosts', arguments: {} });
  expect(JSON.stringify(list.content)).toContain('web');
  // 默认没有开放写操作：直接拒绝，告诉外部 Agent 去勾选
  const denied = await client.callTool({ name: 'ssh_exec', arguments: { host: 'web', command: 'touch /tmp/from-claude-code' } });
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain('允许写操作');
  expect(server.execs).not.toContain('touch /tmp/from-claude-code');
  await page.getByTestId('mcp-allow-write').click();
  await expect
    .poll(() => page.evaluate(async () => ((await (globalThis as unknown as { itm: { invoke: (c: string) => Promise<Record<string, unknown>> } }).itm.invoke('setting.getAll'))['mcp.server.allowWrite'])))
    .toBe(true);
  const res = await client.callTool({ name: 'ssh_exec', arguments: { host: 'web', command: 'touch /tmp/from-claude-code' } });
  expect(res.isError).toBeFalsy();
  expect(server.execs).toContain('touch /tmp/from-claude-code');
  await shot(page, 'm3-15-mcp-approval');
  await client.close();

  // 3. 外部 MCP Server（stdio）：添加、测试连接，在 AI 面板里引用后 Agent 调用它的工具
  await page.getByTestId('mode-terminal').click();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-ext').click();
  await page.getByTestId('settings-tab-mcp').click();
  await page.getByTestId('mcp-add').click();
  await page.getByTestId('mcp-name').fill('tools');
  await page.getByTestId('mcp-command').fill(process.execPath);
  await page.getByTestId('mcp-args').fill(join(__dirname, '..', 'test', 'support', 'mcp-test-server.mjs'));
  await page.getByTestId('mcp-save').click();
  await page.getByTestId('mcp-test-tools').click();
  await expect(page.getByTestId('mcp-tools-tools')).toContainText('4 个工具');

  llm.respond(null);
  llm.enqueue({ toolCalls: [{ id: 'mc1', name: 'mcp_call', input: { server: 'tools', tool: 'echo', arguments: { text: 'via-mcp' } } }] }, { text: 'MCP 工具返回了 echo:via-mcp' });
  // 没有连接终端时右侧面板不显示：在 AI 对话模式里用
  await page.getByTestId('mode-ai').click();
  await page.getByTestId('agent-new').click();
  await page.getByTestId('refs-expand').click();
  await page.getByTestId('refs-cat-mcp').click();
  await page.getByTestId('ref-mcp-tools').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('agent-input').fill('用 MCP 工具 echo 一下');
  await page.getByTestId('agent-send').click();
  // 新加的 MCP Server 默认「需批准」：先批准这次调用
  const mcpStep = page.getByTestId('agent-step').filter({ hasText: 'echo' });
  await expect(mcpStep).toHaveAttribute('data-status', 'approval');
  await shot(page, 'm3-16-mcp-call');
  await mcpStep.getByTestId('approve').click();
  await mcpStep.getByTestId('approve-confirm').click({ timeout: 3000 }).catch(() => undefined);
  await expect(page.getByText('MCP 工具返回了 echo:via-mcp')).toBeVisible();
  await expect(mcpStep).toHaveAttribute('data-status', 'done');
  expect(JSON.stringify(llm.requests.find((r) => JSON.stringify(r.body.messages).includes('用 MCP 工具 echo'))?.body.messages)).toContain('tools/echo');
  await app.close();
});

test('云同步：导出加密文件，导入到另一台电脑（合并预览），自动备份可以撤回', async () => {
  // 1. 在前面用例留下的数据上导出（主机、命令、笔记、凭证全选）
  let { app, page } = await launch();
  const file = join(root, 'export.itmbak');
  await stubDialogs(app, file, null);
  // 包含凭证时要验证身份；这台电脑可能有 Touch ID，测试里直接通过
  await app.evaluate(({ systemPreferences }) => {
    systemPreferences.promptTouchID = (async () => undefined) as typeof systemPreferences.promptTouchID;
  });
  // 单独运行这个用例时也有数据：加一台带密码的主机
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('new-host').click();
  await page.getByTestId('host-name').fill('sync-host');
  await page.getByTestId('host-address').fill('10.1.2.3');
  await page.getByTestId('host-username').fill('sync-user');
  await page.getByTestId('host-password').fill('sync-pw');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('connect-sync-host')).toBeVisible();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-account').click();
  // 等统计加载完（加载中显示「—」）
  await expect(page.getByTestId('sync-stat-hosts').locator('.sync-stat-value')).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId('sync-stat-snippets').locator('.sync-stat-value')).toHaveText(/^\d+$/);
  const hosts = await page.getByTestId('sync-stat-hosts').locator('.sync-stat-value').innerText();
  const snippets = await page.getByTestId('sync-stat-snippets').locator('.sync-stat-value').innerText();
  await expect(page.getByTestId('sync-last-backup')).toHaveText('—');
  await shot(page, 'm3-17-sync-page');
  await page.getByTestId('sync-export').click();
  await page.getByTestId('export-password').fill('export-pass');
  await page.getByTestId('export-password2').fill('export-pass-x');
  await expect(page.getByTestId('export-confirm')).toBeDisabled();
  await page.getByTestId('export-password2').fill('export-pass');
  await page.waitForTimeout(400); // 等弹窗动画结束再截图
  await shot(page, 'm3-18-sync-export');
  await page.getByTestId('export-confirm').click();
  await expect(page.getByText(/^已导出：主机/)).toBeVisible();
  await expect(page.getByTestId('sync-last-backup')).not.toHaveText('—');
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file).includes(Buffer.from('sync-user'))).toBe(false);
  await app.close();

  // 2. 另一台电脑（新的档案）：导入 → 预览合并 → 确认
  ({ app, page } = await launch('userData-other'));
  await stubDialogs(app, null, file);
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-account').click();
  await expect(page.getByTestId('sync-stat-hosts').locator('.sync-stat-value')).toHaveText('0');
  await page.getByTestId('sync-import').click();
  await expect(page.getByTestId('import-file-info')).toContainText(`主机 ${hosts}`);
  await page.getByTestId('import-password').fill('wrong-pass');
  await page.getByTestId('import-preview').click();
  await expect(page.getByText('导出密码不正确，或者文件已损坏')).toBeVisible();
  await page.getByTestId('import-password').fill('export-pass');
  await page.getByTestId('import-preview').click();
  const report = page.getByTestId('sync-report');
  await expect(report.getByRole('row', { name: /^主机 / })).toContainText(hosts);
  await shot(page, 'm3-19-sync-import-preview');
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/^导入完成/)).toBeVisible();
  await expect(page.getByTestId('sync-stat-hosts').locator('.sync-stat-value')).toHaveText(hosts);
  await expect(page.getByTestId('sync-stat-snippets').locator('.sync-stat-value')).toHaveText(snippets);
  await expect(page.getByTestId('auto-backup-row')).toHaveCount(1);
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('connect-sync-host')).toBeVisible();

  // 3. 撤回：回到导入前（空的）
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('auto-restore').click();
  await expect(page.getByTestId('sync-report')).toBeVisible();
  await page.waitForTimeout(400);
  await shot(page, 'm3-20-sync-undo');
  await page.getByTestId('auto-restore-ok').click();
  await expect(page.getByText('已撤回')).toBeVisible();
  await expect(page.getByTestId('sync-stat-hosts').locator('.sync-stat-value')).toHaveText('0');
  await expect(page.getByTestId('auto-backup-row')).toHaveCount(2);
  await page.getByTestId('nav-hosts').click();
  await expect(page.getByTestId('connect-sync-host')).toHaveCount(0);
  await app.close();
});
