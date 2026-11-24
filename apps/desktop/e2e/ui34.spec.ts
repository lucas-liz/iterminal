import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startTestSshServer, type TestSshServer } from '../test/support/ssh-server';

let root: string;
let remote: string;
let ssh: TestSshServer;

test.describe.configure({ mode: 'serial' });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> =>
  page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(join(__dirname, '..', 'test-results', 'shots'), { recursive: true });
  await page.waitForTimeout(260);
  await page.screenshot({ path: join(__dirname, '..', 'test-results', 'shots', `${name}.png`) });
}

interface DomRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}
interface DomEl {
  className: string;
  innerText?: string;
  getBoundingClientRect(): DomRect;
  querySelectorAll(sel: string): Iterable<DomEl>;
}
interface DomGlobal {
  innerWidth: number;
  document: { querySelector(sel: string): DomEl | null; querySelectorAll(sel: string): Iterable<DomEl> };
  getComputedStyle(el: DomEl): { display: string; visibility: string };
}

/**
 * 通用 DOM 几何自检器：
 * 1) 检出顶部栏任意子控件溢出顶栏下边缘或与下方内容卡片重叠；
 * 2) 检出任何文本节点容器被挤压成极窄竖排（width < 68px 且 height > 85px）；
 * 3) 检出设置页纵向 block 行意外撑出大块空白（text 高度 > 120px）。
 */
async function auditLayout(page: Page, label: string): Promise<string[]> {
  return page.evaluate((lbl) => {
    const g = globalThis as unknown as DomGlobal;
    const issues: string[] = [];
    const vw = g.innerWidth;
    const topbar = g.document.querySelector('.app-topbar');
    const frame = g.document.querySelector('.shell-frame');
    if (topbar && frame) {
      const tb = topbar.getBoundingClientRect();
      const fr = frame.getBoundingClientRect();
      const controls = topbar.querySelectorAll('button, .ant-segmented, .ant-segmented-item, .ws-top-tab, .topbar-settings-tabs');
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.bottom > tb.bottom + 1) {
          issues.push(`[${lbl}] topbar child overflows bottom (${r.bottom.toFixed(1)} > ${tb.bottom.toFixed(1)}): ${el.className}`);
        }
        if (r.top < tb.top - 1) {
          issues.push(`[${lbl}] topbar child overflows top (${r.top.toFixed(1)} < ${tb.top.toFixed(1)}): ${el.className}`);
        }
        if (r.right > vw + 2) {
          issues.push(`[${lbl}] topbar child overflows right (${r.right.toFixed(1)} > ${vw}): ${el.className}`);
        }
        if (r.bottom > fr.top + 1) {
          issues.push(`[${lbl}] topbar child overlaps frame (${r.bottom.toFixed(1)} > ${fr.top.toFixed(1)}): ${el.className}`);
        }
      }
    }

    const textEls = g.document.querySelectorAll(
      '.setting-row-text, .setting-row-desc, .setting-row-label, .empty-recent-row, .empty-recent-meta, .empty-recent-time, .account-text, .ant-list-item-meta-description, .ant-list-item-meta-title',
    );
    for (const el of textEls) {
      const style = g.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      const txt = (el.innerText || '').trim();
      if (txt.length >= 4 && r.width > 0 && r.width < 68 && r.height > 85) {
        issues.push(`[${lbl}] vertically squished text (w=${r.width.toFixed(0)}, h=${r.height.toFixed(0)}): "${txt.slice(0, 24)}" in .${el.className}`);
      }
    }

    for (const el of g.document.querySelectorAll('.setting-row.block > .setting-row-text')) {
      const r = el.getBoundingClientRect();
      if (r.height > 120) {
        issues.push(`[${lbl}] setting-row.block text abnormally tall (h=${r.height.toFixed(0)}): "${(el.innerText || '').trim().slice(0, 24)}"`);
      }
    }

    return issues;
  }, label);
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui34-'));
  remote = join(realpathSync(root), 'remote');
  mkdirSync(remote, { recursive: true });
  ssh = await startTestSshServer({ root: remote, sftpRealPaths: true });
});

test.afterAll(async () => {
  await ssh?.close();
  rmSync(root, { recursive: true, force: true });
});

test('第三十四轮全应用深度排版与几何自检', async () => {
  const { app, page } = await launch();
  const allIssues: string[] = [];
  const check = async (label: string, shotName?: string): Promise<void> => {
    await page.waitForTimeout(240);
    const issues = await auditLayout(page, label);
    allIssues.push(...issues);
    if (shotName) await shot(page, shotName);
  };

  try {
    await call(page, 'setting.set', { key: 'ui.theme', value: 'light' });
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: {
        name: 'mock',
        type: 'OPENAI_COMPAT',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'k',
        enabled: true,
        models: [{ id: 'mock', contextWindow: 64000, maxOutput: 2048 }],
      },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock' } });

    const hostNames = ['app_env_10.91', 'storage_svc_10.63', '203.0.113.10(2222)', 'dev_env_20.110', 'biz_prod_10.20.0.41'];
    for (const name of hostNames) {
      await call(page, 'host.create', {
        folderId: null,
        name,
        address: '127.0.0.1',
        port: ssh.port,
        username: 'tester',
        authMethod: 'PASSWORD',
        password: 'pw',
        keepaliveSec: 0,
        startupScript: null,
        note: `节点 ${name}`,
        jumpHostIds: [],
      });
    }
    await call(page, 'snippet.save', {
      id: null,
      input: { groupId: null, name: '查看磁盘占用', content: 'df -h', description: '检查各分区使用率', tags: ['运维'] },
    });
    await call(page, 'note.save', {
      id: null,
      input: { groupId: null, title: 'Nginx 排查手册', content: '# 排查步骤\n\n1. `nginx -t`\n2. `tail -f /var/log/nginx/error.log`' },
    });

    await page.reload();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 860));
    await page.waitForTimeout(350);

    // 连接 3 台主机以便生成「最近连接」记录，同时测试多标签 + 右侧面板全部 3 个子视图 + 分屏
    const connectHost = async (name: string) => {
      await page.getByTestId('nav-hosts').click();
      await page.getByTestId(`connect-${name}`).click();
      const dot = page.getByTestId(`tab-${name}`).locator('.status-dot');
      const trust = page.getByRole('button', { name: '信任并连接' });
      await Promise.race([trust.click({ timeout: 5000 }).catch(() => undefined), expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 })]);
      await expect(dot).toHaveCSS('background-color', 'rgb(82, 196, 26)', { timeout: 15_000 });
    };

    await connectHost('app_env_10.91');
    await connectHost('storage_svc_10.63');
    await connectHost('203.0.113.10(2222)');

    // 校验 1：终端页连接态 - 右侧「文件」面板 + 顶栏严格对齐 + 多标签下激活标签和「+」均完整可见
    const verifyTabsVisible = async (tag: string, singleTab = false) => {
      const scrollBox = await page.locator('.topbar-tabs-scroll').boundingBox();
      const addBox = await page.getByTestId('tab-new').boundingBox();
      const toolsBox = await page.locator('.topbar-ws-tools').boundingBox();
      const activeBox = await page.locator('.ws-top-tab.active').boundingBox();
      expect(scrollBox && addBox && toolsBox && activeBox, `${tag} tab strip boxes exist`).toBeTruthy();
      expect(addBox!.x + addBox!.width, `${tag} + button must stay left of tools`).toBeLessThanOrEqual(toolsBox!.x + 2);
      expect(activeBox!.x, `${tag} active tab left visible`).toBeGreaterThanOrEqual(scrollBox!.x - 2);
      expect(activeBox!.x + activeBox!.width, `${tag} active tab right visible`).toBeLessThanOrEqual(scrollBox!.x + scrollBox!.width + 2);
      if (singleTab) {
        expect(Math.abs(addBox!.x - (activeBox!.x + activeBox!.width)), `${tag} + sits right after last tab`).toBeLessThanOrEqual(14);
      }
    };
    const verifySeam = async (tag: string) => {
      const broadcastBox = await page.getByTestId('broadcast').boundingBox();
      const rightPanelBox = await page.getByTestId('right-panel').boundingBox();
      const topRightBox = await page.getByTestId('topbar-ws-right').boundingBox();
      const rightHeadBox = await page.getByTestId('right-panel-head').boundingBox();
      const edgeBox = await page.getByTestId('right-edge-toggle').boundingBox();
      expect(broadcastBox && rightPanelBox && topRightBox && rightHeadBox && edgeBox, `${tag} boxes exist`).toBeTruthy();
      expect(Math.abs(topRightBox!.x - rightPanelBox!.x), `${tag} topRight aligns with rightPanel`).toBeLessThanOrEqual(4);
      expect(Math.abs(rightPanelBox!.x - (broadcastBox!.x + broadcastBox!.width)), `${tag} broadcast aligns with terminal right`).toBeLessThanOrEqual(16);
      expect(Math.abs(edgeBox!.x + edgeBox!.width / 2 - rightPanelBox!.x), `${tag} edgeToggle centered on seam`).toBeLessThanOrEqual(2);
      // 关键校验：右侧面板顶部切换条底边距离右侧面板顶边至少 5px 呼吸间距，且内部选中胶囊与外框上下均匀贴合（±1px）
      expect(rightPanelBox!.y - (rightHeadBox!.y + rightHeadBox!.height), `${tag} rightHead clearance above rightPanel`).toBeGreaterThanOrEqual(5);
      const segOuter = await page.locator('.right-panel-head-inline .right-tabs').boundingBox();
      const segSel = await page.locator('.right-panel-head-inline .right-tabs .ant-segmented-item-selected').boundingBox();
      expect(segOuter && segSel, `${tag} segmented boxes exist`).toBeTruthy();
      const topGap = segSel!.y - segOuter!.y;
      const bottomGap = segOuter!.y + segOuter!.height - (segSel!.y + segSel!.height);
      expect(Math.abs(topGap - bottomGap), `${tag} segmented vertical padding must be symmetric (top=${topGap}, bottom=${bottomGap})`).toBeLessThanOrEqual(1.5);
      expect(topGap, `${tag} segmented track padding ~3px`).toBeGreaterThanOrEqual(2);
      const statusAi = await page.locator('.workspace-pane-slot:not(.hidden) [data-testid="statusbar-ai"]').first().boundingBox();
      expect(statusAi && Math.abs(statusAi.width - statusAi.height) <= 1 && statusAi.width <= 26, `${tag} statusbar-ai is compact icon button`).toBeTruthy();
    };
    await verifySeam('ws-files-1380');
    await verifyTabsVisible('ws-files-1380');
    await check('ws-files-1380', 'audit-02-ws-files');

    // 校验 2：右侧「监控」面板
    await page.getByTestId('right-monitor').click();
    await check('ws-monitor-1380', 'audit-03-ws-monitor');

    // 校验 3：右侧「AI」面板
    await page.getByTestId('right-ai').click();
    await check('ws-ai-1380', 'audit-04-ws-ai');

    // 切回文件面板并测试左右分屏
    await page.getByTestId('right-files').click();
    await page.getByTestId('split-h').click();
    await page.waitForTimeout(350);
    await check('ws-split-h', 'audit-05-ws-split');

    // 测试收起右侧面板 -> 展开右侧面板
    await page.getByTestId('right-edge-toggle').click();
    await page.waitForTimeout(300);
    await expect(page.getByTestId('right-expand')).toBeVisible();
    await check('ws-right-collapsed', 'audit-06-ws-right-collapsed');
    await page.getByTestId('right-expand').click();
    await page.waitForTimeout(300);

    // 打开 SFTP 标签页
    await page.getByTestId('open-sftp-from-tab').click();
    await page.waitForTimeout(350);
    await verifyTabsVisible('ws-sftp-tab');
    await check('ws-sftp-tab', 'audit-07-ws-sftp');

    // 关闭所有标签，测试「未连接终端时的最近连接」页面（用户图 1 修复验证！）
    while ((await page.locator('.ws-top-tab-close').count()) > 0) {
      await page.locator('.ws-top-tab-close').first().click();
      await page.waitForTimeout(120);
    }
    await expect(page.getByTestId('empty-recent-card')).toBeVisible();
    const recentCardBox = await page.getByTestId('empty-recent-card').boundingBox();
    expect(recentCardBox!.width, 'recent connections card must be wide, not collapsed').toBeGreaterThanOrEqual(480);
    const recentRowBtnBox = await page.locator('.empty-recent-ops .ant-btn').first().boundingBox();
    expect(recentRowBtnBox!.height, 'recent row button should stay compact ~28px').toBeLessThanOrEqual(30);
    await check('empty-with-recent-1380', 'audit-01-empty-with-recent');

    // 窄窗口 1024px 下的空白终端 + 最近连接
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720));
    await check('empty-with-recent-1024', 'audit-01b-empty-recent-narrow');

    // 恢复 1380px 检查主机页 + 笔记编辑器 + 审计 + 定时任务 + 数据库 + 监控 + 指令集
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 860));
    await page.getByTestId('nav-hosts').click();
    await check('hosts-1380', 'audit-08-hosts');

    // 笔记页（选中一篇笔记检查编辑器与预览排版）
    await page.getByTestId('nav-notes').click();
    await page.getByText('Nginx 排查手册').first().click();
    await check('notes-preview', 'audit-09-notes-editor');

    // 审计页
    await page.getByTestId('nav-audit').click();
    await check('audit-cmd', 'audit-10-audit');

    // 批量执行页（第三十五轮替代定时任务）
    await page.getByTestId('nav-batch').click();
    await check('batch', 'audit-11-batch');
    await page.getByTestId('batch-tab-upload').click();
    await check('batch-upload', 'audit-11b-batch-upload');
    await page.getByTestId('batch-tab-exec').click();

    // 监控页
    await page.getByTestId('rail-more').hover();
    await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-monitor').click();
    await check('monitor', 'audit-12-monitor');

    // 数据库页
    await page.getByTestId('rail-more').hover();
    await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-databases').click();
    await check('databases', 'audit-13-databases');

    // 指令集页
    await page.getByTestId('rail-more').hover();
    await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-snippets').click();
    await check('snippets', 'audit-13b-snippets');

    // AI 模式检查（左侧第一个图标切换为 AI 且隐藏主机）
    await page.getByTestId('mode-ai').click();
    await expect(page.getByTestId('nav-ai')).toBeVisible();
    await expect(page.getByTestId('nav-hosts')).toHaveCount(0);
    await check('ai-mode', 'audit-13c-ai-mode');
    await page.getByTestId('mode-terminal').click();

    // 遍查设置页全部 9 个分组（1024px 窄窗口下，确保没有任何一行文字竖排或空白异常，且分组副标题保持可见）
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1024, 720));
    await page.getByTestId('avatar-trigger').click();
    await page.getByTestId('nav-settings').click();
    const groups = ['account', 'general', 'terminal', 'security', 'models', 'agent', 'ext', 'storage', 'about'] as const;
    for (const g of groups) {
      await page.getByTestId(`settings-nav-${g}`).click();
      await expect(page.locator('.topbar-page-sub.keep')).toBeVisible();
      await check(`settings-${g}-1024`, g === 'general' || g === 'terminal' || g === 'account' ? `audit-14-settings-${g}` : undefined);
    }

    // 深色模式抽检：空白终端最近连接 + 连接后终端三栏对齐 + 单标签下「+」紧跟标签后
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1380, 860));
    await call(page, 'setting.set', { key: 'ui.theme', value: 'dark' });
    await page.reload();
    await page.waitForTimeout(400);
    await check('dark-empty-recent', 'audit-15-dark-empty-recent');
    await connectHost('app_env_10.91');
    await verifySeam('dark-ws-1380');
    await verifyTabsVisible('dark-ws-1380', true);
    await check('dark-ws-connected', 'audit-16-dark-ws-connected');

    expect(allIssues, `Layout audit found issues:\n${allIssues.join('\n')}`).toEqual([]);
  } finally {
    await app.close();
  }
});
