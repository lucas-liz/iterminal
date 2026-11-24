import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startMockServer, type MockServer } from '../test/support/mock-server';

/**
 * 第二十二轮：设置搜索、笔记从 Markdown 文件导入、Skill 分享、左侧导航可以隐藏页面（默认隐藏数据库、监控、定时任务、审批）。
 */
let root: string;
let mock: MockServer;

test.describe.configure({ mode: 'serial' });

async function launch(opts: { navAll?: boolean; userData?: string } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = {
    ...process.env,
    ITM_USER_DATA: opts.userData ?? join(root, 'userData'),
    ITM_INSECURE_KEYSTORE: '1',
    ELECTRON_RENDERER_URL: '',
    ITM_DEFAULT_SERVER_URL: mock.url,
    // 默认值：不让测试环境把导航全部显示出来
    ITM_NAV_ALL: opts.navAll ? '1' : '0',
  };
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

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui22-'));
  mock = await startMockServer();
});

test.afterAll(async () => {
  await mock?.close();
  rmSync(root, { recursive: true, force: true });
});

test('左侧导航（第三十四、三十五轮）：终端、主机、笔记、运维审计、批量执行常驻；数据库、指令集、监控在 ··· 里，可以在 设置 → 外观 里隐藏', async () => {
  const { app, page } = await launch();
  for (const k of ['workspace', 'hosts', 'notes', 'audit', 'batch']) await expect(page.getByTestId(`nav-${k}`)).toBeVisible();
  await expect(page.getByTestId('nav-schedule')).toHaveCount(0);
  await page.getByTestId('rail-more').hover();
  for (const k of ['databases', 'snippets', 'monitor']) await expect(page.getByTestId(`nav-${k}`)).toBeVisible();

  await page.mouse.move(900, 500);
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-general').click();
  const box = page.getByTestId('nav-visible');
  for (const name of ['主机', '终端', '笔记', '运维审计', '批量执行', '设置']) await expect(box.getByRole('checkbox', { name })).toBeDisabled();
  await box.getByRole('checkbox', { name: '数据库' }).uncheck();
  await expect(box.getByRole('checkbox', { name: '数据库' })).not.toBeChecked();
  await expect.poll(async () => (await call<Record<string, unknown>>(page, 'setting.getAll'))['ui.navHidden']).toEqual(['databases']);
  await page.waitForTimeout(400);
  await shot(page, 'ui22-01-nav-settings');
  await page.getByTestId('rail-more').hover();
  await expect(page.getByTestId('nav-databases')).toHaveCount(0);
  await expect(page.getByTestId('nav-monitor')).toBeVisible();
  // 重启后仍然生效
  await page.reload();
  await page.getByTestId('rail-more').hover();
  await expect(page.getByTestId('nav-monitor')).toBeVisible();
  await expect(page.getByTestId('nav-databases')).toHaveCount(0);
  await call(page, 'setting.set', { key: 'ui.navHidden', value: [] });
  await app.close();
});

test('设置搜索：按名称 / 说明 / 关键词搜，点结果打开对应页面（终端设置切到对应分类），滚动到那一行并闪一下', async () => {
  const { app, page } = await launch();
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  const search = page.getByTestId('settings-search');
  await search.fill('右键');
  const results = page.getByTestId('settings-search-item');
  await expect(results.first()).toContainText('右键粘贴');
  await expect(results.first()).toContainText('终端 › 基础与显示');
  await expect(page.getByTestId('settings-nav-general')).toHaveCount(0);
  await shot(page, 'ui22-02-settings-search');
  await results.first().click();
  const row = page.locator('.setting-row').filter({ hasText: '右键粘贴' });
  await expect(row).toHaveClass(/settings-search-hit/);
  await expect(row).toBeInViewport();
  await shot(page, 'ui22-03-settings-search-hit');

  // 多个词都要命中；回车打开第一个；终端设置切到「搜索与智能」
  await search.fill('超时 数据库');
  await expect(results).toHaveCount(1);
  await search.press('Enter');
  await expect(page.locator('.setting-row').filter({ hasText: '查询超时' })).toHaveClass(/settings-search-hit/);
  await search.fill('命令库');
  await results.first().click();
  await expect(page.getByTestId('term-cat-smart')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.setting-row').filter({ hasText: '显示命令库' })).toHaveClass(/settings-search-hit/);
  await search.fill('找不到的东西xyz');
  await expect(page.getByTestId('settings-search-results')).toContainText('没有找到相关设置');
  // 清空后回到分类列表
  await search.fill('');
  await expect(page.getByTestId('settings-nav-general')).toBeVisible();
  await app.close();
});

test('笔记：选择 Markdown / 文本文件导入（可以多选），标题取开头的一级标题或文件名；不支持的文件跳过', async () => {
  const { app, page } = await launch();
  const src = join(root, 'md');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'deploy.md'), '# 发布流程\n\n1. 打包\n2. 上传');
  writeFileSync(join(src, '值班交接.md'), '- 检查磁盘\n- 看告警');
  writeFileSync(join(src, 'logo.png'), 'x');
  const files = ['deploy.md', '值班交接.md', 'logo.png'].map((f) => join(src, f));
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog;
  }, files);
  await page.getByTestId('nav-notes').click();
  // 第二十六轮起「导入」是菜单：Markdown / Word / 从分享码导入
  await page.getByTestId('note-import').click();
  await page.getByRole('menuitem', { name: /导入 Markdown/ }).click();
  await expect(page.locator('.ant-message')).toContainText('已导入 2 篇笔记；跳过 1 个：logo.png（不是 Markdown / 文本 / Word 文件）');
  await expect(page.getByTestId('note-item-发布流程')).toBeVisible();
  await expect(page.getByTestId('note-item-值班交接')).toBeVisible();
  await expect(page.getByTestId('note-title')).toHaveValue('发布流程');
  await shot(page, 'ui22-04-notes-import');
  await app.close();
});

test('Skill 分享：登录后在 设置 → Skill 里点分享（或勾选多个），分享框列出要分享的 Skill', async () => {
  const userData = join(root, 'userData-share');
  const { app, page } = await launch({ userData, navAll: true });
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
  await page.getByTestId('login-username').fill(mock.user.username);
  await page.getByTestId('login-password').fill(mock.user.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', /^(valid|expired|revoked)$/, { timeout: 15_000 });
  await call(page, 'skill.save', { id: null, content: '---\nname: nginx-reload\ntitle: Nginx 平滑重载\ndescription: 检查配置后平滑重载 Nginx\n---\n\n1. nginx -t\n2. nginx -s reload\n' });
  await call(page, 'skill.save', { id: null, content: '---\nname: jvm-dump\ntitle: JVM 堆转储\ndescription: 生成堆转储\n---\n\njmap\n' });
  await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-nav-ext').click();
  await page.getByRole('button', { name: '刷新' }).click();
  await page.getByTestId('skill-share-nginx-reload').click();
  const skills = page.getByTestId('share-skills');
  await expect(skills).toContainText('Skill 1 个');
  await expect(skills).toContainText('Nginx 平滑重载');
  await page.waitForTimeout(600);
  await shot(page, 'ui22-05-skill-share');
  await page.keyboard.press('Escape');
  await expect(skills).toBeHidden();
  // 勾选两个一起分享
  await page.locator('tr').filter({ hasText: 'Nginx 平滑重载' }).getByRole('checkbox').check();
  await page.locator('tr').filter({ hasText: 'JVM 堆转储' }).getByRole('checkbox').check();
  await page.getByTestId('skill-share-picked').click();
  await expect(page.getByTestId('share-skills')).toContainText('Skill 2 个');
  await app.close();
});
