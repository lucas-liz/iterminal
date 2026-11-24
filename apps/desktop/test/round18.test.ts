/**
 * 第十八轮（文档一 6.32）：SQL 工作台（分级 / 确认、同一连接依次执行、停止、库表树、导出全部、AI 的表结构上下文）、
 * 定时 SQL 报表（报表内容和脱敏、钉钉 / 企业微信 / 飞书 / Webhook 的发送和签名、定时任务的 SQL 类型、Agent 创建）。
 *
 * MySQL / PostgreSQL 用本机测试库（127.0.0.1:3308 / 5433，见 /tmp/itm-dbtest/start.sh），连不上时这些用例跳过。
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStep, DbAssetInput, LocalTaskInput, ReportWebhook, TaskRunView } from '@itm/protocol';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { Masker } from '@itm/masking';
import type { ToolCall } from '@itm/agent-core';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { createRepos } from './support/repos';
import { DbAssetRepo } from '../src/main/services/database/db-asset-repo';
import { DbService } from '../src/main/services/database/db-service';
import { SqlWorkbench } from '../src/main/services/database/workbench';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { LocalScheduler } from '../src/main/services/schedule/scheduler';
import { buildReport, normalizeReport, sendWebhook, testMessage } from '../src/main/services/schedule/sql-report';
import { ToolGateway } from '../src/main/services/ai/tool-gateway';
import type { SettingsRepo } from '../src/main/services/settings/settings-repo';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import type { CredentialRepo } from '../src/main/services/vault/credential-repo';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const OWNER = 9;
const MYSQL_PORT = Number(process.env.ITM_TEST_MYSQL_PORT ?? 3308);
const PG_PORT = Number(process.env.ITM_TEST_PG_PORT ?? 5433);
function reachable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}
const hasMysql = await reachable(MYSQL_PORT);
const hasPg = await reachable(PG_PORT);

const input = (over: Partial<DbAssetInput> = {}): DbAssetInput => ({
  name: 'shop',
  type: 'MYSQL',
  host: '127.0.0.1',
  port: MYSQL_PORT,
  database: 'shop',
  username: 'itm',
  password: 'itm-test-pw',
  credentialId: null,
  ssl: 'OFF',
  viaHostId: null,
  filePath: null,
  agentPolicy: null,
  production: false,
  sqlDenylist: [],
  note: null,
  ...over,
});

let dir: string;
let db: Db;
let repo: DbAssetRepo;
let settings: SettingsRepo;
let hosts: HostRepo;
let credentials: CredentialRepo;
let pool: SshPool;
let service: DbService;
let audit: AuditRepo;
let asks: { system: string; text: string }[];
let wb: SqlWorkbench;
let lite: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-r18-'));
  const vaultKey = randomBytes(32);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ settings, hosts, credentials } = createRepos(db, vaultKey));
  repo = new DbAssetRepo(db, vaultKey);
  pool = new SshPool(hosts, new PromptBroker(() => undefined), 5000);
  service = new DbService({ repo, credentials, hosts, pool });
  audit = new AuditRepo(db);
  asks = [];
  wb = new SqlWorkbench({
    databases: service,
    repo,
    audit,
    settings,
    ask: async (system, text) => {
      asks.push({ system, text });
      return '```sql\nSELECT 1\n```\n说明';
    },
    masker: () => new Masker({ maskIps: false, maskPii: true }),
  });
  lite = join(dir, 'app.db');
  const raw = new Database(lite);
  raw.exec(
    "CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, phone TEXT, amount REAL, status TEXT); CREATE TABLE refund_log (id INTEGER PRIMARY KEY, order_id INTEGER, reason TEXT);" +
      "INSERT INTO orders (customer, phone, amount, status) VALUES ('甲', '13800138000', 10.5, 'paid'), ('乙', '13900139000', 20, 'pending'), ('丙', NULL, 30, 'pending');",
  );
  raw.close();
});

afterEach(() => {
  pool.closeAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const liteAsset = (over: Partial<DbAssetInput> = {}) => repo.save(null, input({ name: 'lite', type: 'SQLITE', filePath: lite, ...over }));

describe('SQL 工作台：分级和确认（文档一 6.32.1）', () => {
  it('只读直接执行；写操作要确认；高危或生产环境要输入数据库名；USE / SET 是会话设置；事务控制不能执行', () => {
    const a = repo.save(null, input());
    expect(wb.plan(a.id, 'SELECT 1; SHOW TABLES')).toMatchObject({ confirm: 'none', error: null, items: [{ kind: 'read' }, { kind: 'read' }] });
    expect(wb.plan(a.id, "USE shop; SET NAMES utf8mb4; UPDATE t SET a = 1 WHERE id = 2")).toMatchObject({ confirm: 'click', items: [{ kind: 'session' }, { kind: 'session' }, { kind: 'write' }] });
    expect(wb.plan(a.id, 'SELECT 1; DELETE FROM t')).toMatchObject({ confirm: 'type', items: [{ kind: 'read' }, { kind: 'danger' }] });
    expect(wb.plan(a.id, 'BEGIN; SELECT 1').error).toContain('不需要 BEGIN / COMMIT / ROLLBACK');
    expect(wb.plan(a.id, '  ').error).toBe('没有可以执行的 SQL');
    const prod = repo.save(null, input({ name: 'prod', production: true }));
    expect(wb.plan(prod.id, 'SELECT 1').confirm).toBe('none');
    expect(wb.plan(prod.id, 'UPDATE t SET a = 1 WHERE id = 2').confirm).toBe('type');
  });

  it('SQLite：没有确认不执行；确认后依次执行、出错停下；结果、影响行数和审计', async () => {
    const a = liteAsset();
    await expect(wb.exec(OWNER, { id: a.id, runId: 'r1', sql: "UPDATE orders SET status = 'done' WHERE id = 1" })).rejects.toThrow('需要确认');
    await expect(wb.exec(OWNER, { id: a.id, runId: 'r1', sql: 'DELETE FROM refund_log', confirmed: true })).rejects.toThrow('需要输入数据库名称「lite」');
    const r = await wb.exec(OWNER, { id: a.id, runId: 'r1', confirmed: true, sql: "SELECT count(*) AS n FROM orders; UPDATE orders SET status = 'done' WHERE id = 1; SELECT nope FROM orders; SELECT 1" });
    expect(r.items).toHaveLength(3);
    expect(r.items[0]).toMatchObject({ ok: true, columns: ['n'], rows: [['3']] });
    expect(r.items[1]).toMatchObject({ ok: true, affected: 1 });
    expect(r.items[2].ok).toBe(false);
    expect(r.items[2].error).toMatch(/no such column/);
    const log = audit.list({ kind: 'COMMAND', limit: 10 }).items;
    expect(log.map((e) => [e.source, e.hostName, e.risk, e.decision, e.exitCode])).toEqual(
      expect.arrayContaining([
        ['USER', '数据库 · lite', 'L0', 'AUTO', 0],
        ['USER', '数据库 · lite', 'L1', 'APPROVED', 0],
        ['USER', '数据库 · lite', 'L0', 'AUTO', 1],
      ]),
    );
  });

  it('SQLite：库表树、列、表结构、导出全部（CSV 带 BOM）', async () => {
    const a = liteAsset();
    const t = await wb.objects(OWNER, a.id, {});
    expect(t).toMatchObject({ kind: 'tables', items: [{ name: 'orders', type: 'TABLE' }, { name: 'refund_log' }] });
    const cols = await wb.columns(OWNER, a.id, {}, ['orders']);
    expect(cols.map((c) => `${c.name}:${c.key ?? ''}`)).toEqual(['id:PRI', 'customer:', 'phone:', 'amount:', 'status:']);
    expect(await wb.describe(OWNER, a.id, {}, 'orders')).toContain('CREATE TABLE orders');
    const path = join(dir, 'out.csv');
    expect(await wb.exportQuery(OWNER, { id: a.id, sql: 'SELECT customer, amount FROM orders ORDER BY id', path })).toEqual({ rows: 3, truncated: false });
    expect(readFileSync(path, 'utf8')).toBe('﻿customer,amount\r\n甲,10.5\r\n乙,20\r\n丙,30\r\n');
    await expect(wb.exportQuery(OWNER, { id: a.id, sql: 'SELECT 1; SELECT 2', path })).rejects.toThrow('只支持一条只读查询');
  });

  it('AI：表结构上下文（SQL 里引用的表、问题里的词匹配的表、小库全部）、执行计划、脱敏', async () => {
    const a = liteAsset();
    await wb.ai(OWNER, { id: a.id, action: 'nl2sql', question: '统计每个状态的订单数，手机号 13800138000 的客户' });
    expect(asks[0].system).toContain('SQLite 数据库专家');
    expect(asks[0].text).toContain('orders(id INTEGER PK, customer TEXT, phone TEXT, amount REAL, status TEXT)');
    expect(asks[0].text).toContain('refund_log(');
    expect(asks[0].text).not.toContain('13800138000');
    await wb.ai(OWNER, { id: a.id, action: 'optimize', sql: "SELECT * FROM orders WHERE status = 'paid'" });
    expect(asks[1].text).toContain('执行计划（EXPLAIN）');
    expect(asks[1].system).toContain('CREATE INDEX');
    await wb.ai(OWNER, { id: a.id, action: 'diagnose', sql: 'SELECT nope FROM orders', error: 'no such column: nope' });
    expect(asks[2].text).toContain('数据库返回的错误：\nno such column: nope');
    await expect(wb.ai(OWNER, { id: a.id, action: 'explain', sql: '' })).rejects.toThrow('请先在编辑器里写好');
  });
});

describe.skipIf(!hasMysql)('SQL 工作台：MySQL', () => {
  it('同一次执行共用一个连接（USE 对后面的语句有效）；停止立即生效；库表树和列', async () => {
    const a = repo.save(null, input({ name: 'nodb', database: '' }));
    const r = await wb.exec(OWNER, { id: a.id, runId: 'm1', sql: 'USE shop; SELECT count(*) FROM t_user' });
    expect(r.items.map((x) => x.ok)).toEqual([true, true]);
    expect(r.items[1].rows).toEqual([['3']]);
    const dbs = await wb.objects(OWNER, a.id, {});
    expect(dbs.kind).toBe('databases');
    expect(dbs.items.map((x) => x.name)).toContain('shop');
    const tables = await wb.objects(OWNER, a.id, { database: 'shop' });
    expect(tables).toMatchObject({ kind: 'tables', current: 'shop' });
    expect(tables.items.find((x) => x.name === 't_order')).toMatchObject({ type: 'BASE TABLE', comment: '订单' });
    const cols = await wb.columns(OWNER, a.id, { database: 'shop' }, ['t_order', 't_user']);
    expect(cols.find((c) => c.table === 't_order' && c.name === 'id')).toMatchObject({ key: 'PRI', type: 'bigint' });
    expect(cols.find((c) => c.table === 't_user' && c.name === 'name')).toMatchObject({ comment: '姓名', nullable: false });
    const started = Date.now();
    // SLEEP 会长时间占用连接，按写操作要确认
    const p = wb.exec(OWNER, { id: a.id, runId: 'slow', sql: 'SELECT SLEEP(5); SELECT 2', confirmed: true });
    setTimeout(() => wb.cancel('slow'), 300);
    const s = await p;
    expect(s.stopped).toBe(true);
    expect(s.items).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe.skipIf(!hasPg)('SQL 工作台：PostgreSQL', () => {
  it('库 → schema → 表；schema 参数', async () => {
    const a = repo.save(null, input({ name: 'pg', type: 'POSTGRES', port: PG_PORT }));
    expect((await wb.objects(OWNER, a.id, {})).items.map((x) => x.name)).toContain('shop');
    const schemas = await wb.objects(OWNER, a.id, { database: 'shop' });
    expect(schemas).toMatchObject({ kind: 'schemas' });
    expect(schemas.items.map((x) => x.name)).toEqual(['public', 'sales']);
    const t = await wb.objects(OWNER, a.id, { database: 'shop', schema: 'sales' });
    expect(t.items.map((x) => x.name)).toEqual(['region']);
    const cols = await wb.columns(OWNER, a.id, { database: 'shop', schema: 'public' }, ['orders']);
    expect(cols.find((c) => c.name === 'id')?.key).toBe('PRI');
    const r = await wb.exec(OWNER, { id: a.id, runId: 'p1', database: 'shop', schema: 'sales', sql: 'SELECT name FROM region ORDER BY code' });
    expect(r.items[0].rows).toEqual([['华东'], ['华北']]);
  });
});

// ---------------------------------------------------------------- 报表和机器人

interface Hit {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}
let hook: Server;
let hookUrl: string;
let hits: Hit[];
let reply: (h: Hit) => { status: number; body: string };

beforeAll(async () => {
  hits = [];
  reply = () => ({ status: 200, body: '{"errcode":0,"code":0}' });
  hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const h = { url: req.url ?? '', headers: req.headers, body };
      hits.push(h);
      const r = reply(h);
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(r.body);
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', () => resolve()));
  hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
  return () => new Promise<void>((resolve) => hook.close(() => resolve()));
});

beforeEach(() => {
  hits = [];
  reply = () => ({ status: 200, body: '{"errcode":0,"code":0}' });
});

describe('报表内容和机器人（文档一 6.32.3）', () => {
  const report = normalizeReport({ maxRows: 2, maskColumns: true });
  const msg = buildReport({
    task: { name: '待支付订单', command: 'SELECT …' },
    dbName: 'crm',
    database: 'main',
    columns: ['customer', 'phone', 'note'],
    rows: [['甲', '13800138000', 'a|b\nc'], ['乙', null, 'x'], ['丙', '1', 'y']],
    truncated: false,
    report,
    summary: '有 3 笔待支付',
    at: Date.UTC(2026, 9, 19, 1, 0, 0),
  });

  it('Markdown 表格、逐行文本、按列名脱敏、只列出前 N 行', () => {
    expect(msg.title).toBe('【SQL 报表】待支付订单');
    expect(msg.markdown).toContain('- 结果：共 3 行，只列出前 2 行');
    expect(msg.markdown).toContain('**AI 总结**：有 3 笔待支付');
    expect(msg.markdown).toContain('| customer | phone | note |');
    expect(msg.markdown).toContain('| 甲 | [PII] | a\\|b c |');
    expect(msg.markdown).toContain('| 乙 | NULL | x |');
    expect(msg.markdown).not.toContain('丙');
    expect(msg.markdown).toContain('这些列已脱敏：phone');
    expect(msg.text).toContain('1. customer：甲，phone：[PII]，note：a\\|b c');
    expect(msg.data).toMatchObject({ rowCount: 3, truncated: true, rows: [['甲', '[PII]', 'a|b\nc'], ['乙', null, 'x']] });
    expect(() => normalizeReport({ maxRows: 0 })).toThrow('1–200');
    expect(() => normalizeReport({ webhooks: [{ kind: 'DINGTALK', url: 'file:///etc/passwd', secret: null, name: null }] })).toThrow('http / https');
  });

  it('钉钉：Markdown + 加签；返回 errcode 不为 0 时报错', async () => {
    const w: ReportWebhook = { kind: 'DINGTALK', url: `${hookUrl}/robot/send?access_token=abc`, secret: 'SECxyz', name: '运维群' };
    await sendWebhook(w, msg, { now: () => 1_700_000_000_000 });
    const h = hits[0];
    const u = new URL(h.url, hookUrl);
    expect(u.searchParams.get('access_token')).toBe('abc');
    expect(u.searchParams.get('timestamp')).toBe('1700000000000');
    expect(u.searchParams.get('sign')).toBe(createHmac('sha256', 'SECxyz').update('1700000000000\nSECxyz').digest('base64'));
    expect(JSON.parse(h.body)).toMatchObject({ msgtype: 'markdown', markdown: { title: '【SQL 报表】待支付订单' } });
    reply = () => ({ status: 200, body: '{"errcode":310000,"errmsg":"sign not match"}' });
    await expect(sendWebhook(w, msg)).rejects.toThrow('钉钉返回错误 310000：sign not match');
  });

  it('企业微信用逐行文本；飞书带签名；通用 Webhook 带 HMAC 签名和结构化内容；HTTP 错误', async () => {
    await sendWebhook({ kind: 'WECOM', url: `${hookUrl}/cgi-bin/webhook/send?key=k`, secret: null, name: null }, msg);
    expect(JSON.parse(hits[0].body)).toMatchObject({ msgtype: 'markdown', markdown: { content: expect.stringContaining('1. customer：甲') } });
    await sendWebhook({ kind: 'FEISHU', url: `${hookUrl}/open-apis/bot/v2/hook/x`, secret: 'fs', name: null }, msg, { now: () => 1_700_000_000_000 });
    const fs = JSON.parse(hits[1].body) as { timestamp: string; sign: string; msg_type: string };
    expect(fs).toMatchObject({ timestamp: '1700000000', msg_type: 'text' });
    expect(fs.sign).toBe(createHmac('sha256', '1700000000\nfs').update('').digest('base64'));
    await sendWebhook({ kind: 'WEBHOOK', url: `${hookUrl}/hook`, secret: 'k1', name: null }, msg);
    const wh = hits[2];
    expect(wh.headers['x-itm-signature']).toBe(`sha256=${createHmac('sha256', 'k1').update(wh.body).digest('hex')}`);
    expect(JSON.parse(wh.body)).toMatchObject({ task: '待支付订单', rowCount: 3, columns: ['customer', 'phone', 'note'] });
    reply = () => ({ status: 500, body: 'boom' });
    await expect(sendWebhook({ kind: 'WEBHOOK', url: `${hookUrl}/hook`, secret: null, name: null }, testMessage(Date.now()))).rejects.toThrow('HTTP 500：boom');
    reply = () => ({ status: 200, body: '{"code":19021,"msg":"sign match fail"}' });
    await expect(sendWebhook({ kind: 'FEISHU', url: `${hookUrl}/f`, secret: 'x', name: null }, msg)).rejects.toThrow('飞书返回错误 19021');
  });
});

// ---------------------------------------------------------------- 定时任务的 SQL 类型

const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
let approval: ApprovalEngine;
beforeAll(async () => {
  approval = await createApprovalEngine(wasm);
});

describe('定时 SQL 报表（LocalScheduler）', () => {
  let scheduler: LocalScheduler;
  let runs: TaskRunView[];
  let notices: string[];
  const sqlTask = (dbId: string, over: Partial<LocalTaskInput> = {}): LocalTaskInput => ({
    name: '待支付订单',
    enabled: true,
    type: 'SQL',
    command: "SELECT customer, phone, amount FROM orders WHERE status = 'pending' ORDER BY id",
    prompt: null,
    hostIds: [],
    schedule: { kind: 'daily', time: '09:00' },
    aiAssist: false,
    goal: null,
    aiPolicy: 'READONLY',
    timeoutMin: 5,
    notifyOnFailure: true,
    dbId,
    database: null,
    report: { when: 'ROWS', maxRows: 20, aiSummary: true, maskColumns: true, systemNotify: true, webhooks: [{ kind: 'WEBHOOK', url: `${hookUrl}/hook`, secret: null, name: '告警' }] },
    ...over,
  });

  beforeEach(() => {
    runs = [];
    notices = [];
    scheduler = new LocalScheduler({
      db, hosts, pool, approval, audit,
      policy: () => DEFAULT_POLICY,
      agent: { runUnattended: async () => { throw new Error('不应该调用 Agent'); } } as never,
      owner: () => OWNER,
      emitRun: (r) => runs.push(r),
      emitTasks: () => undefined,
      emitApprovals: () => undefined,
      notify: (title) => notices.push(title),
      databases: service,
      ask: async (_s, text) => {
        asks.push({ system: _s, text });
        return '有 2 笔订单待支付，金额合计 50。';
      },
      masker: () => new Masker({ maskIps: false, maskPii: true }),
    });
  });
  afterEach(() => scheduler.stop());

  const lastRun = async (taskId: string): Promise<TaskRunView> => {
    const start = Date.now();
    for (;;) {
      const r = runs.filter((x) => x.taskId === taskId).at(-1);
      if (r && r.status !== 'RUNNING') return r;
      if (Date.now() - start > 8000) throw new Error('等待超时');
      await new Promise((res) => setTimeout(res, 20));
    }
  };

  it('只能保存只读 SQL；保存和读取报表设置；立即执行：查询、AI 总结（脱敏）、系统通知、Webhook', async () => {
    const a = liteAsset();
    expect(() => scheduler.save(null, sqlTask(a.id, { command: "UPDATE orders SET status = 'x' WHERE id = 1" }))).toThrow('只能执行一条只读 SQL');
    expect(() => scheduler.save(null, sqlTask('nope'))).toThrow('请选择数据库');
    const t = scheduler.save(null, sqlTask(a.id));
    expect(scheduler.get(t.id)).toMatchObject({ type: 'SQL', dbId: a.id, hostIds: [], report: { when: 'ROWS', webhooks: [{ name: '告警' }] } });
    scheduler.runNow(t.id);
    const run = await lastRun(t.id);
    expect(run).toMatchObject({ type: 'SQL', status: 'SUCCESS', hosts: [{ hostName: '数据库 · lite', status: 'SUCCESS' }] });
    expect(run.hosts[0].output).toContain('| 乙 | [PII] | 20 |');
    expect(run.hosts[0].output).toContain('发送：✓ 系统通知、告警');
    expect(notices).toContain('【SQL 报表】待支付订单');
    expect(JSON.parse(hits[0].body)).toMatchObject({ rowCount: 2, summary: '有 2 笔订单待支付，金额合计 50。' });
    expect(asks.at(-1)!.text).toContain('乙 | [PII]');
    expect(asks.at(-1)!.text).not.toContain('13900139000');
  });

  it('有结果时才发：查不到不发送；Webhook 失败时这次执行算失败并发系统通知', async () => {
    const a = liteAsset();
    const empty = scheduler.save(null, sqlTask(a.id, { name: '空', command: "SELECT * FROM orders WHERE status = 'never'" }));
    scheduler.runNow(empty.id);
    const r1 = await lastRun(empty.id);
    expect(r1).toMatchObject({ status: 'SUCCESS', summary: '没有结果，未发送' });
    expect(hits).toHaveLength(0);
    reply = () => ({ status: 502, body: 'bad gateway' });
    const t = scheduler.save(null, sqlTask(a.id, { name: '失败', report: { ...normalizeReport({}), when: 'ALWAYS', webhooks: [{ kind: 'WEBHOOK', url: `${hookUrl}/x`, secret: null, name: null }] } }));
    scheduler.runNow(t.id);
    const r2 = await lastRun(t.id);
    expect(r2.status).toBe('FAILED');
    expect(r2.hosts[0].output).toContain('✗ Webhook（HTTP 502');
    expect(notices.some((n) => n.includes('定时任务「失败」失败'))).toBe(true);
  });

  it('Agent 用 schedule_task 创建 SQL 报表：要批准；数据库的 Agent 权限是禁止时不能创建', async () => {
    const a = liteAsset();
    const denied = liteAsset({ name: 'deny', agentPolicy: 'DENY' });
    const waits: AgentStep[] = [];
    const gw = new ToolGateway({
      hosts, credentials, settings, audit, approval, pool,
      sessions: {} as never, monitor: {} as never, skills: {} as never, runtime: {} as never,
      emit: () => undefined, policy: () => DEFAULT_POLICY, runLocal: async () => { throw new Error('x'); },
      databases: service,
      schedule: {
        validate: (i) => scheduler.validate(i),
        check: (c, h, by) => scheduler.check(c, h, by),
        save: (id, i, by) => scheduler.save(id, i, by),
        list: () => scheduler.list(),
      },
    });
    const call = (args: Record<string, unknown>): ToolCall => ({ id: `c${Math.random()}`, name: 'schedule_task', args });
    const ctx = {
      conversationId: 'c', owner: OWNER, mode: 'agent' as const, targets: {}, databases: { d1: a.id, d2: denied.id },
      masker: new Masker({ maskIps: false, maskPii: true }), signal: new AbortController().signal, reviewModel: null,
      ui: { add: () => undefined, update: () => undefined, wait: async (s: AgentStep) => (waits.push({ ...s }), { decision: 'approve' as const }) },
    };
    const ok = await gw.execute(call({ name: '每日订单', db: 'd1', sql: 'SELECT status, count(*) FROM orders GROUP BY status', schedule: { kind: 'daily', time: '09:00' }, report_when: 'always', explanation: '日报' }), ctx);
    expect(ok.isError).toBe(false);
    expect(waits[0].command).toContain('创建 SQL 报表「每日订单」');
    expect(scheduler.list().find((t) => t.name === '每日订单')).toMatchObject({ type: 'SQL', createdBy: 'AGENT', report: { when: 'ALWAYS', webhooks: [] } });
    const bad = await gw.execute(call({ name: 'x', db: 'd2', sql: 'SELECT 1', schedule: { kind: 'daily', time: '09:00' }, explanation: 'x' }), ctx);
    expect(bad.content).toContain('Agent 权限是禁止');
    const write = await gw.execute(call({ name: 'y', db: 'd1', sql: 'DELETE FROM orders', schedule: { kind: 'daily', time: '09:00' }, explanation: 'x' }), ctx);
    expect(write.content).toContain('只能执行一条只读 SQL');
  });
});
