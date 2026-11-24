import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

/**
 * 主机编辑框每次打开都是干净的（新建不带上一台主机的数据、编辑不串数据）；终端 Ctrl / ⌘ + 滚轮缩放。
 */
let root: string;
let ssh: TestSshServer;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);
type HostRow = { id: string; name: string; address: string; note: string | null; proxy: unknown; jumpHostIds: string[]; tags: string[] };

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui6-'));
  mkdirSync(join(root, 'remote'));
  ssh = await startTestSshServer({ root: join(root, 'remote') });
});

test.afterAll(async () => {
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('主机编辑框：新建时是空的，编辑另一台主机时不串数据', async () => {
  const { app, page } = await launch();
  const base = { folderId: null, port: 22, username: 'root', authMethod: 'PASSWORD', password: 'x', keepaliveSec: 30, startupScript: null, jumpHostIds: [] };
  const jump = await call<HostRow>(page, 'host.create', { ...base, name: 'jump-1', address: '10.0.0.1', note: null });
  await call(page, 'host.create', {
    ...base, name: 'host-a', address: '10.0.0.2', note: 'A 的备注', jumpHostIds: [jump.id], tags: ['生产'],
    proxy: { type: 'SOCKS5', host: '10.0.0.9', port: 1080, username: null },
  });
  await call(page, 'host.create', { ...base, name: 'host-b', address: '10.0.0.3', note: null });
  await page.reload();
  await page.getByTestId('nav-hosts').click();

  // 先编辑 A，再取消
  await page.getByTestId('more-host-a').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await expect(page.getByTestId('host-name')).toHaveValue('host-a');
  await page.getByRole('button', { name: /取\s*消/ }).click();

  // 新建：所有字段都是空的 / 默认值
  await page.getByTestId('new-host').click();
  await expect(page.getByTestId('host-name')).toHaveValue('');
  await expect(page.getByTestId('host-address')).toHaveValue('');
  await page.getByTestId('host-name').fill('host-new');
  await page.getByTestId('host-address').fill('10.0.0.4');
  await page.getByTestId('host-password').fill('pw');
  await page.getByTestId('host-save').click();
  await expect(page.getByText('host-new')).toBeVisible();
  const created = (await call<HostRow[]>(page, 'host.list')).find((h) => h.name === 'host-new')!;
  expect(created).toMatchObject({ address: '10.0.0.4', note: null, proxy: null, jumpHostIds: [], tags: [] });

  // 编辑 A 之后编辑 B：B 的数据不被 A 的值覆盖
  await page.getByTestId('more-host-a').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await expect(page.getByTestId('host-name')).toHaveValue('host-a');
  await page.getByRole('button', { name: /取\s*消/ }).click();
  await page.getByTestId('more-host-b').click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await expect(page.getByTestId('host-name')).toHaveValue('host-b');
  await expect(page.getByTestId('host-address')).toHaveValue('10.0.0.3');
  await page.getByTestId('host-save').click();
  const b = (await call<HostRow[]>(page, 'host.list')).find((h) => h.name === 'host-b')!;
  expect(b).toMatchObject({ address: '10.0.0.3', note: null, proxy: null, jumpHostIds: [], tags: [] });
  // A 自己没有被改
  const a = (await call<HostRow[]>(page, 'host.list')).find((h) => h.name === 'host-a')!;
  expect(a).toMatchObject({ note: 'A 的备注', jumpHostIds: [jump.id], tags: ['生产'] });
  await app.close();
});

test('终端：Ctrl / ⌘ + 滚轮缩放字号，右键可以还原', async () => {
  const { app, page } = await launch();
  await call(page, 'host.create', {
    folderId: null, name: 'zoom-host', address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
  });
  await page.reload();
  await page.getByTestId('nav-hosts').click();
  await page.getByTestId('connect-zoom-host').click();
  const dot = page.getByTestId('tab-zoom-host').locator('.status-dot');
  const trust = page.getByRole('button', { name: '信任并连接' });
  await Promise.race([trust.click({ timeout: 8000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
  await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });

  const term = page.locator('.terminal-host').first();
  // 终端渲染出来之后再滚动（连接刚建立时滚轮监听可能还没挂上）
  await expect(term.locator('.xterm-screen')).toBeVisible();
  await page.waitForTimeout(300);
  const box = (await term.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const tip = page.getByTestId('term-zoom-tip');
  // 一格一格滚：到了目标字号再滚下一格（自动化偶尔丢一个滚轮事件，没到时补一格，不会多滚）
  const zoomTo = async (target: number, deltaY: number): Promise<void> => {
    await expect(async () => {
      const now = (await tip.isVisible()) ? Number(/字号 (\d+)/.exec(await tip.innerText())?.[1]) : NaN;
      if (now !== target) {
        await page.keyboard.down(mod);
        await page.mouse.wheel(0, deltaY);
        await page.keyboard.up(mod);
      }
      await expect(tip).toContainText(`字号 ${target}`, { timeout: 1000 });
    }).toPass({ timeout: 10_000 });
  };
  // 默认 14 → 16 → 15
  await zoomTo(15, -100);
  await zoomTo(16, -100);
  await zoomTo(15, 100);
  // 右键（默认右键粘贴，Ctrl + 右键打开菜单）：还原默认字号
  await page.keyboard.down('Control');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.keyboard.up('Control');
  // 子菜单悬停后才展开；右键菜单的弹出动画没停时悬停可能落空，展开前反复悬停
  await expect(async () => {
    await page.getByRole('menuitem', { name: /字号 15/ }).hover();
    await expect(page.getByRole('menuitem', { name: '还原默认字号' })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page.getByRole('menuitem', { name: '还原默认字号' }).click();
  await expect(page.getByTestId('term-zoom-tip')).toContainText('字号 14');
  // 全局设置没有被改
  expect((await call<Record<string, number>>(page, 'setting.getAll'))['terminal.fontSize']).toBe(14);
  await app.close();
});
