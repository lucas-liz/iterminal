import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 第十八轮（文档一 6.32）：SQL 工作台（库表树、双击表查询、执行 / 执行全部、写操作确认、高危输入数据库名、格式化、消息和 AI 诊断、
 * AI 写 SQL 替换编辑器、导出全部）和定时 SQL 报表（编辑框、试运行、Webhook 测试、立即执行后的执行记录）。
 */
let root: string;
let llm: LlmMock;
let lite: string;
let hook: Server;
let hookUrl: string;
const hits: string[] = [];

test.describe.configure({ mode: 'serial' });

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

const sqlite = (sql: string): string => execFileSync('sqlite3', [lite, sql], { encoding: 'utf8' }).trim();

async function prepare(page: Page): Promise<void> {
  if (!(await call<unknown[]>(page, 'ai.providers.list')).length) {
    const p = await call<{ id: string }>(page, 'ai.providers.save', {
      id: null,
      input: { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'k', enabled: true, models: [{ id: 'mock-coder', contextWindow: 64000, maxOutput: 2048 }] },
    });
    await call(page, 'setting.set', { key: 'ai.defaultModel', value: { providerId: p.id, modelId: 'mock-coder' } });
  }
  if (!(await call<{ name: string }[]>(page, 'db.list')).some((d) => d.name === 'crm')) {
    await call(page, 'db.save', {
      id: null,
      input: { name: 'crm', type: 'SQLITE', host: '', port: 0, database: '', username: '', credentialId: null, ssl: 'OFF', viaHostId: null, filePath: lite, agentPolicy: null, production: false, sqlDenylist: [], note: null },
    });
  }
}

/** 在编辑器里输入（先清空） */
async function typeSql(page: Page, text: string): Promise<void> {
  const ed = page.locator('.sql-tab-host:visible [data-testid="sql-editor"]').first();
  await ed.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}
const visible = (page: Page, id: string) => page.locator(`.sql-tab-host:visible [data-testid="${id}"]`).first();

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-ui18-'));
  llm = await startLlmMock();
  lite = join(root, 'crm.db');
  execFileSync('sqlite3', [
    lite,
    "CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, mobile TEXT, level TEXT); CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, status TEXT);" +
      "INSERT INTO customer (name, mobile, level) VALUES ('甲公司', '13800138000', 'A'), ('乙公司', '13900139000', 'B'), ('丙公司', NULL, 'A');" +
      "INSERT INTO orders (customer_id, amount, status) VALUES (1, 100, 'paid'), (2, 50, 'pending'), (3, 70, 'pending');",
  ]);
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      hits.push(body);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"errcode":0}');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/robot/send?access_token=t`;
});

test.afterAll(async () => {
  await llm?.close();
  await new Promise<void>((r) => hook.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

test('SQL 工作台：库表树、双击表查询、执行全部、写操作确认、高危输入数据库名、消息和 AI 诊断', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await page.getByTestId('rail-more').hover();
  await page.getByTestId('nav-databases').click();
  await expect(page.getByTestId('sql-workbench')).toBeVisible();
  // 库表树：展开数据库 → 表 → 列
  await page.getByTestId('db-node-asset-crm').click();
  await page.locator('.ant-tree-treenode', { has: page.getByTestId('db-node-asset-crm') }).locator('.ant-tree-switcher').click();
  await expect(page.getByTestId('db-node-table-customer')).toBeVisible();
  // 等展开动画结束（动画进行中 antd 的树不响应点击）
  await page.waitForTimeout(500);
  await page.locator('.ant-tree-treenode', { has: page.getByTestId('db-node-table-customer') }).locator('.ant-tree-switcher').click();
  await expect(page.getByTestId('db-node-column-mobile')).toBeVisible();
  // 双击表：新标签查询前 100 行
  await page.getByTestId('db-node-table-customer').dblclick();
  const grid = page.locator('.sql-tab-host:visible [data-testid="db-grid"]').first();
  await expect(grid).toContainText('13800138000');
  await expect(grid.locator('.db-null')).toHaveCount(1);
  await page.waitForTimeout(300);
  await shot(page, 'ui18-01-workbench');

  // 执行全部：两个结果标签；写操作要确认
  await typeSql(page, "SELECT count(*) AS n FROM customer;\nUPDATE customer SET level = 'S' WHERE id = 2;\nSELECT name, level FROM customer ORDER BY id;");
  await visible(page, 'sql-run-all').click();
  await expect(page.getByTestId('sql-confirm-list')).toContainText("UPDATE customer SET level = 'S' WHERE id = 2");
  await page.waitForTimeout(200);
  await shot(page, 'ui18-02-confirm-write');
  await page.getByTestId('sql-confirm-ok').click();
  await expect(page.locator('.sql-tab-host:visible .sql-results-tabs .ant-tabs-tab')).toHaveText(['结果 1', '结果 2', '消息']);
  expect(sqlite("SELECT level FROM customer WHERE id = 2")).toBe('S');
  // 高危：不带 WHERE 的 DELETE 要输入数据库名；取消后数据还在
  await typeSql(page, 'DELETE FROM orders');
  await visible(page, 'sql-run').click();
  await expect(page.getByTestId('sql-confirm-ok')).toBeDisabled();
  await page.getByTestId('sql-confirm-input').fill('crm');
  await expect(page.getByTestId('sql-confirm-ok')).toBeEnabled();
  await page.getByRole('button', { name: '取消' }).click();
  expect(sqlite('SELECT count(*) FROM orders')).toBe('3');

  // 出错：消息里显示数据库的错误，AI 诊断在右侧的对话里给出修正的 SQL（第二十九轮），点「执行」结果显示在左边
  await typeSql(page, 'SELECT nope FROM customer');
  await visible(page, 'sql-run').click();
  await expect(visible(page, 'sql-messages')).toContainText('no such column: nope');
  llm.enqueue({ text: '列 nope 不存在，customer 表里有 name。\n\n```sql\nSELECT name FROM customer;\n```' });
  await visible(page, 'sql-diagnose').click();
  const chat = page.getByTestId('db-agent-panel');
  await expect(chat).toContainText('列 nope 不存在', { timeout: 15_000 });
  expect(JSON.stringify(llm.requests.at(-1)!.body)).toContain('customer(id INTEGER PK, name TEXT, mobile TEXT, level TEXT)');
  await page.waitForTimeout(300);
  await shot(page, 'ui18-03-ai-diagnose');
  await chat.getByTestId('code-sql-run').last().click();
  await expect(page.locator('.sql-tab-host:visible [data-testid="db-grid"]').first()).toContainText('name');

  // AI 写 SQL：在右侧对话里用自然语言描述 → 回答里的 SQL 点「执行」
  llm.enqueue({ text: '```sql\nSELECT status, count(*) FROM orders GROUP BY status;\n```\n按状态统计订单数。' });
  await visible(page, 'sql-ai-nl2sql').click();
  await chat.getByTestId('agent-input').fill('每个状态有多少订单');
  await chat.getByTestId('agent-input').press('Enter');
  await expect(chat).toContainText('按状态统计订单数', { timeout: 15_000 });
  expect(JSON.stringify(llm.requests.at(-1)!.body)).toContain('每个状态有多少订单');
  expect(JSON.stringify(llm.requests.at(-1)!.body)).toContain('SQL 工作台');
  await chat.getByTestId('code-sql-run').last().click();
  await expect(page.locator('.sql-tab-host:visible [data-testid="db-grid"]').first()).toContainText('pending');
  await shot(page, 'ui18-03b-ai-chat-sql');

  // 格式化
  await typeSql(page, 'select a,b from t where x=1');
  await visible(page, 'sql-format').click();
  await expect(page.locator('.sql-tab-host:visible .cm-content').first()).toContainText('SELECT');

  // 导出全部
  await typeSql(page, 'SELECT id, name FROM customer ORDER BY id');
  await visible(page, 'sql-run').click();
  const out = join(root, 'all.csv');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, out);
  await visible(page, 'sql-export-all').click();
  await expect.poll(() => (() => {
    try {
      return readFileSync(out, 'utf8');
    } catch {
      return '';
    }
  })()).toContain('甲公司');
  await app.close();
});

// 第三十五轮去掉了定时任务和监控告警
test.skip('定时 SQL 报表：编辑框、试运行、测试机器人、立即执行后执行记录里有报表', async () => {
  const { app, page } = await launch();
  await prepare(page);
  await page.reload();
  await page.getByTestId('nav-schedule').click();
  await page.getByTestId('schedule-new').click();
  await page.getByTestId('task-name').fill('待支付订单');
  await page.getByTestId('task-type').getByText('SQL 报表').click();
  await expect(page.getByTestId('sql-report-fields')).toBeVisible();
  await page.getByTestId('task-db').click();
  await page.locator('.ant-select-item-option', { hasText: 'crm' }).click();
  await page.getByTestId('task-sql').click();
  await page.keyboard.insertText("SELECT c.name, c.mobile, o.amount FROM orders o JOIN customer c ON c.id = o.customer_id WHERE o.status = 'pending' ORDER BY o.id");
  await page.getByTestId('task-sql-try').click();
  await expect(page.getByTestId('sql-report-fields').getByTestId('db-grid')).toContainText('乙公司');
  await page.getByTestId('task-report-when').getByText('有结果时才发').click();
  await page.getByTestId('task-webhook-add').click();
  await page.getByTestId('task-webhook-url').fill(hookUrl);
  await page.getByTestId('task-webhook-test').click();
  await expect(page.locator('.ant-message')).toContainText('测试消息已发送');
  expect(hits.at(-1)).toContain('测试消息');
  await page.waitForTimeout(300);
  await shot(page, 'ui18-04-report-editor');
  await page.getByTestId('task-save').click();
  await expect(page.getByTestId('schedule-row-待支付订单')).toContainText('SQL 报表');
  await expect(page.getByTestId('schedule-row-待支付订单')).toContainText('告警');
  await page.getByTestId('schedule-row-待支付订单').getByTestId('schedule-run').click();
  await expect.poll(() => hits.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  const sent = JSON.parse(hits.at(-1)!) as { markdown: { text: string } };
  expect(sent.markdown.text).toContain('| 乙公司 | [PII] | 50 |');
  await expect(page.getByTestId('schedule-row-待支付订单').getByTestId('schedule-last-status')).toHaveText('成功', { timeout: 10_000 });
  await app.close();
});
