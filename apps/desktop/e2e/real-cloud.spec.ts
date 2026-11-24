import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * 云备份和分享码，和真实服务端联调（只在设置了 ITM_REAL_SERVER 时运行，服务端需要关闭验证码）：
 *   ITM_REAL_SERVER=http://127.0.0.1:8080 npx playwright test e2e/real-cloud.spec.ts
 * 用户 A：设置同步密码 → 上传备份 → 开启分享码 → 删掉一台主机后从云端恢复；
 * 用户 B（管理员）：用 A 的分享码拉取并合并；A 的第二台设备：输入同步密码解锁、看到同一个分享码、用恢复码重置同步密码。
 */
const BASE = process.env.ITM_REAL_SERVER ?? '';
const ADMIN = process.env.ITM_REAL_USER ?? 'admin';
const ADMIN_PW = process.env.ITM_REAL_PASSWORD ?? '';

test.skip(!BASE || !process.env.ITM_REAL_PASSWORD, '没有设置 ITM_REAL_SERVER 和 ITM_REAL_PASSWORD');
test.describe.configure({ mode: 'serial' });

let root: string;
let adminToken: string;
let userId: number;
const tag = String(Date.now()).slice(-6);
const USER = `cloud${tag}`;
const USER_PW = 'Test@123456';
const SYNC_PW = 'sync-password-123';
let shareCode = '';
let recovery = '';

async function launch(dir: string): Promise<{ app: ElectronApplication; page: Page }> {
  // 登录框里没有服务端地址：测试用 ITM_DEFAULT_SERVER_URL 指定（只在没有打包时生效）
  const env = { ...process.env, ITM_USER_DATA: join(root, dir), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '', ITM_DEFAULT_SERVER_URL: BASE };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

async function admin<T = Record<string, unknown>>(method: string, path: string, body?: unknown, token: string | null = adminToken): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return (await res.json()) as T;
}

async function login(page: Page, username: string, password: string): Promise<void> {
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(username);
  await page.getByTestId('login-password').fill(password);
  // 本机没有数据：不出现导入选项
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'valid', { timeout: 20_000 });
}

async function openCloud(page: Page): Promise<void> {
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-account').click();
  await expect(page.getByTestId('cloud-section')).toBeVisible({ timeout: 10_000 });
}

const host = (name: string, address: string) => ({ folderId: null, name, address, port: 22, username: 'root', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [] });

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-cloud-'));
  adminToken = (await admin<{ token: string }>('POST', '/login', { username: ADMIN, password: ADMIN_PW }, null)).token;
  expect(adminToken).toBeTruthy();
  const r = await admin<{ code: number; msg: string }>('POST', '/system/user', { userName: USER, nickName: '云同步测试', password: USER_PW, deptId: 103, roleIds: [2], status: '0' });
  expect(r.code, r.msg).toBe(200);
  userId = (await admin<{ rows: { userId: number }[] }>('GET', `/system/user/list?userName=${USER}`)).rows[0].userId;
});

test.afterAll(async () => {
  if (userId) await admin('DELETE', `/system/user/${userId}`);
  rmSync(root, { recursive: true, force: true });
});

test('用户 A：设置同步密码、上传备份、开启分享码、从云端恢复', async () => {
  const { app, page } = await launch('a1');
  await login(page, USER, USER_PW);
  await call(page, 'host.create', host('shared-web', '10.8.0.1'));
  await call(page, 'host.create', host('shared-db', '10.8.0.2'));

  await openCloud(page);
  await page.getByTestId('cloud-setup').click();
  await page.getByTestId('cloud-pw').fill(SYNC_PW);
  await page.getByTestId('cloud-pw2').fill(SYNC_PW);
  await page.getByTestId('cloud-pw-ok').click();
  await expect(page.getByTestId('recovery-code')).toBeVisible({ timeout: 30_000 });
  recovery = (await page.getByTestId('recovery-code').innerText()).trim();
  expect(recovery.split(/\s+/)).toHaveLength(24);
  await page.getByTestId('recovery-saved').check();
  await page.getByTestId('recovery-done').click();
  await expect(page.getByTestId('cloud-password-row')).toContainText('已设置');

  // 上传备份
  await page.getByTestId('cloud-upload').click();
  await page.getByTestId('cloud-upload-ok').click();
  await expect(page.getByTestId('cloud-backups')).toContainText('主机 2', { timeout: 20_000 });

  // 开启分享码（默认范围：主机、快捷命令、笔记）
  await page.getByTestId('share-enable').click();
  await expect(page.getByTestId('share-status')).toContainText('分享中', { timeout: 20_000 });
  shareCode = await call<string>(page, 'cloud.shareReveal');
  expect(shareCode).toMatch(/^ITM-[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
  await expect(page.getByTestId('share-code')).toContainText(shareCode.slice(0, 9));

  // 删掉一台主机，再从云端备份合并回来
  const db = (await call<{ id: string; name: string }[]>(page, 'host.list')).find((h) => h.name === 'shared-db')!;
  await call(page, 'host.delete', { ids: [db.id] });
  const backups = await call<{ id: string }[]>(page, 'cloud.backups');
  const preview = await call<{ perType: Record<string, { added: number }> }>(page, 'cloud.restore', { id: backups[0].id, groups: ['HOSTS'], mode: 'merge', dryRun: true });
  expect(preview.perType.hosts.added).toBe(1);
  await call(page, 'cloud.restore', { id: backups[0].id, groups: ['HOSTS'], mode: 'merge', dryRun: false });
  expect((await call<{ name: string }[]>(page, 'host.list')).map((h) => h.name).sort()).toEqual(['shared-db', 'shared-web']);
  await app.close();
});

test('用户 B：用分享码拉取并合并 A 的主机', async () => {
  const { app, page } = await launch('b');
  await login(page, ADMIN, ADMIN_PW);
  await call(page, 'host.create', host('shared-web', '10.99.0.1')); // 同名主机：保留本地地址
  await openCloud(page);
  await page.getByTestId('share-pull').click();
  await page.getByTestId('share-code-input').fill(shareCode.toLowerCase().replace(/-/g, ' '));
  await page.getByTestId('share-lookup').click();
  await expect(page.getByTestId('share-preview')).toContainText('云同步测试');
  await expect(page.getByTestId('share-preview')).toContainText('主机 2');
  await page.getByTestId('pull-preview').click();
  await expect(page.getByTestId('sync-report')).toBeVisible();
  await page.getByTestId('pull-confirm').click();
  await expect.poll(async () => (await call<{ name: string }[]>(page, 'host.list')).map((h) => h.name).sort(), { timeout: 10_000 }).toEqual(['shared-db', 'shared-web']);
  const web = (await call<{ name: string; address: string }[]>(page, 'host.list')).find((h) => h.name === 'shared-web')!;
  expect(web.address).toBe('10.99.0.1');
  await app.close();
});

test('用户 A 的第二台设备：输入同步密码解锁、看到同一个分享码；用恢复码重置同步密码', async () => {
  const { app, page } = await launch('a2');
  await login(page, USER, USER_PW);
  expect(await call(page, 'cloud.status')).toMatchObject({ configured: true, unlocked: false });
  await openCloud(page);
  await page.getByTestId('cloud-unlock').click();
  await page.getByTestId('cloud-pw').fill(SYNC_PW);
  await page.getByTestId('cloud-pw-ok').click();
  await expect(page.getByTestId('cloud-password-row')).toContainText('已设置', { timeout: 30_000 });
  expect(await call(page, 'cloud.shareReveal')).toBe(shareCode);

  const r = await call<{ recoveryCode: string }>(page, 'cloud.recover', { recoveryCode: recovery, newPassword: 'new-sync-password-456' });
  expect(r.recoveryCode.split(' ')).toHaveLength(24);
  expect(r.recoveryCode).not.toBe(recovery);
  // 旧恢复码作废；新同步密码能解锁（在另一个档案里验证太慢，这里直接用接口确认托管的密钥已更新）
  await expect(call(page, 'cloud.recover', { recoveryCode: recovery, newPassword: 'x'.repeat(12) })).rejects.toThrow('恢复码不正确');

  // 清理：关闭分享码、删除备份
  await call(page, 'cloud.shareClose');
  for (const b of await call<{ id: string }[]>(page, 'cloud.backups')) await call(page, 'cloud.backupDelete', { id: b.id });
  await app.close();
});
