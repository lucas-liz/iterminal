import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第十七轮（文档一 6.31）：数据库页（新建 / 测试连接 / 保存）、在 AI 对话里引用数据库、Agent 查询结果显示为表格、
 * 写 SQL 的审批卡片（可以修改 SQL、二次确认）、不带 WHERE 的 DELETE 要输入数据库名确认。
 * 本机测试 MySQL（127.0.0.1:3308，见 /tmp/itm-dbtest/start.sh）连得上时，顺便测一下 MySQL 的测试连接。
 */
let root: string;
let llm: LlmMock;
let lite: string;

test.describe.configure({ mode: 'serial' });

const MYSQL_PORT = Number(process.env.ITM_TEST_MYSQL_PORT ?? 3308);
const reachable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '' };
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

async function prepare(page: Page): Promise<void> {
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
    await call(page, 'setting.set', { key: 'ai.llmReview', value: false });
  }
}

const sqlite = (sql: string): string => execFileSync('sqlite3', [lite, sql], { encoding: 'utf8' }).trim();

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui17-'));
  llm = await startLlmMock();
  lite = join(root, 'crm.db');
  execFileSync('sqlite3', [lite, "CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, mobile TEXT, level TEXT); INSERT INTO customer (name, mobile, level) VALUES ('甲公司', '13800138000', 'A'), ('乙公司', '13900139000', 'B'), ('丙公司', NULL, 'A');"]);
});

test.afterAll(async () => {
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('数据库页：新建 SQLite、测试连接、保存；MySQL 表单（经过 SSH 主机、引用凭证）', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-databases').click();
  await expect(page.getByTestId('db-table')).toContainText('还没有数据库');
  await shot(page, 'ui17-01-empty');

  await page.getByTestId('db-new').click();
  // 第一步选数据库（第二十七轮）：PostgreSQL → 端口 5432；更换成 MySQL → 3306；Redis 等还不能选
  await expect(page.getByTestId('db-picker')).toBeVisible();
  await expect(page.getByTestId('db-product-redis')).toBeDisabled();
  await page.getByTestId('db-product-postgres').click();
  await expect(page.getByTestId('db-port')).toHaveValue('5432');
  await page.getByTestId('db-change-type').click();
  await page.getByTestId('db-product-mysql').click();
  await expect(page.getByTestId('db-port')).toHaveValue('3306');
  await expect(page.getByTestId('db-type')).toContainText('MySQL');
  await page.getByTestId('db-name').fill('订单库');
  await page.getByTestId('db-host').fill('10.0.3.21');
  await page.getByTestId('db-username').fill('app');
  await page.getByTestId('db-production').check();
  await page.waitForTimeout(300);
  await shot(page, 'ui17-02-editor-mysql');
  await page.getByTestId('db-auth').getByText('引用凭证').click();
  await expect(page.getByTestId('db-credential')).toBeVisible();
  await page.keyboard.press('Escape');

  // SQLite：选文件、测试连接、保存
  await page.getByTestId('db-new').click();
  await page.getByTestId('db-product-sqlite').click();
  await page.getByTestId('db-name').fill('crm');
  await expect(page.getByTestId('db-host')).toHaveCount(0);
  await page.getByTestId('db-file').fill(lite);
  await page.getByTestId('db-note').fill('客户库：customer 表');
  await page.getByTestId('db-test').click();
  await expect(page.getByTestId('db-test-result')).toContainText('连接成功：SQLite 3');
  await shot(page, 'ui17-03-editor-sqlite-test');
  await page.getByTestId('db-save').click();
  await expect(page.getByTestId('db-row-crm')).toBeVisible();
  await expect(page.getByTestId('db-row-crm')).toContainText('客户库');

  // 本机测试 MySQL：测试连接（密码错误 → 中文原因；正确 → 版本）
  if (await reachable(MYSQL_PORT)) {
    await page.getByTestId('db-new').click();
    await page.getByTestId('db-product-mysql').click();
    await page.getByTestId('db-name').fill('shop');
    await page.getByTestId('db-host').fill('127.0.0.1');
    await page.getByTestId('db-port').fill(String(MYSQL_PORT));
    await page.getByTestId('db-database').fill('shop');
    await page.getByTestId('db-username').fill('itm');
    await page.getByTestId('db-password').fill('wrong');
    await page.getByTestId('db-test').click();
    await expect(page.getByTestId('db-test-result')).toContainText('用户名或密码错误');
    await page.getByTestId('db-password').fill('itm-test-pw');
    await page.getByTestId('db-test').click();
    await expect(page.getByTestId('db-test-result')).toContainText(/连接成功：\d+\.\d+/);
    await page.getByTestId('db-save').click();
    await expect(page.getByTestId('db-row-shop')).toBeVisible();
    await page.getByTestId('db-row-shop').getByTestId('db-row-test').click();
    await expect(page.locator('.ant-message')).toContainText('「shop」连接成功');
  }
  await page.waitForTimeout(400);
  await shot(page, 'ui17-04-list');
  await app.close();
});

test('问 AI：引用数据库，Agent 查询的结果是表格（原值），写 SQL 要批准（可以改 SQL），不带 WHERE 的 DELETE 要输入数据库名', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-databases').click();
  // 有数据库时默认是 SQL 工作台（第十八轮），列表在「连接管理」里
  await page.getByTestId('db-view').getByText('连接管理').click();
  await page.getByTestId('db-row-crm').getByTestId('db-ask-ai').click();
  const panel = page.getByTestId('agent-page-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('ctx-db')).toContainText('crm');
  await expect(panel.getByTestId('ref-chip-db')).toContainText('crm');

  // 只读查询：自动执行，结果显示为表格
  llm.enqueue(
    { toolCalls: [{ id: 'q1', name: 'db_query', input: { db: 'd1', sql: 'SELECT id, name, mobile, level FROM customer ORDER BY id', explanation: '列出所有客户' } }] },
    { text: '共有 3 个客户，其中 A 级 2 个。' },
  );
  await panel.getByTestId('agent-input').fill('客户有哪些？按等级统计一下');
  await panel.getByTestId('agent-input').press('Enter');
  const grid = panel.getByTestId('db-grid');
  await expect(grid).toContainText('13800138000');
  await expect(grid.locator('.db-null')).toHaveText('NULL');
  await expect(panel.getByTestId('db-result-summary')).toContainText('返回 3 行');
  await expect(panel.getByTestId('agent-assistant-msg').last()).toContainText('共有 3 个客户');
  // 发给模型的已脱敏
  const sent = JSON.stringify(llm.requests.at(-1)!.body);
  expect(sent).toContain('甲公司 | [PII]');
  expect(sent).not.toContain('13800138000');
  expect(JSON.stringify(llm.requests.at(-2)!.body)).toContain('d1：数据库 crm（SQLite');
  await panel.getByTestId('db-copy-md').click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('| id | name | mobile | level |');
  await page.waitForTimeout(300);
  await shot(page, 'ui17-05-query-result');

  // 写 SQL：审批卡片里显示 SQL（可以修改），需要二次确认
  llm.enqueue(
    { toolCalls: [{ id: 'w1', name: 'db_execute', input: { db: 'd1', sql: "UPDATE customer SET level = 'S' WHERE id = 1", explanation: '把甲公司升级为 S 级' } }] },
    { text: '已经把乙公司升级为 S 级。' },
  );
  await panel.getByTestId('agent-input').fill('把甲公司升级为 S 级');
  await panel.getByTestId('agent-input').press('Enter');
  const card = panel.locator('.step-card.waiting');
  await expect(card.getByTestId('approval-command')).toHaveValue("UPDATE customer SET level = 'S' WHERE id = 1");
  await expect(card.getByTestId('step-explanation')).toContainText('把甲公司升级为 S 级');
  await page.waitForTimeout(300);
  await shot(page, 'ui17-06-execute-approval');
  // 改成乙公司（id = 2）再执行
  await card.getByTestId('approval-command').fill("UPDATE customer SET level = 'S' WHERE id = 2");
  await card.getByTestId('approve').click();
  await card.getByTestId('approve-confirm').click();
  await expect(panel.getByTestId('db-result-summary').last()).toContainText('影响 1 行');
  expect(sqlite('SELECT group_concat(level) FROM (SELECT level FROM customer ORDER BY id)')).toBe('A,S,A');

  // 不带 WHERE 的 DELETE：高危，要输入数据库名；拒绝后数据还在
  llm.enqueue({ toolCalls: [{ id: 'd1', name: 'db_execute', input: { db: 'd1', sql: 'DELETE FROM customer', explanation: '清空客户表' } }] }, { text: '好的，不删除。' });
  await panel.getByTestId('agent-input').fill('清空客户表');
  await panel.getByTestId('agent-input').press('Enter');
  const danger = panel.locator('.step-card.waiting');
  await expect(danger).toContainText('高危');
  await expect(danger).toContainText('不带 WHERE 条件的 DELETE');
  await danger.getByTestId('approve').click();
  await expect(danger.getByTestId('approval-confirm')).toHaveAttribute('placeholder', '输入「crm」确认');
  await page.waitForTimeout(300);
  await shot(page, 'ui17-07-delete-confirm');
  await danger.getByTestId('approve-cancel').click();
  await danger.getByTestId('reject').click();
  await expect(panel.getByTestId('agent-assistant-msg').last()).toContainText('不删除');
  expect(sqlite('SELECT count(*) FROM customer')).toBe('3');
  await app.close();
});
