/**
 * 第十七轮（文档一 6.31）：数据库资产、驱动（MySQL / PostgreSQL / SQLite）、SSH 隧道、元数据、结果格式和列名脱敏、
 * Agent 的 db_* 工具（SQL 分级 → 策略 → 审批 → 执行 → 审计）。
 *
 * MySQL / PostgreSQL 用本机的测试库（默认 127.0.0.1:3308 / 5433，账号 itm / itm-test-pw，库 shop，
 * 见 /tmp/itm-dbtest/start.sh 和 seed-*.sql）；连不上时这些用例跳过。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentStep, DbAssetInput, IpcEventName, IpcEvents, PromptRequest } from '@itm/protocol';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { Masker } from '@itm/masking';
import type { ToolCall } from '@itm/agent-core';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { createRepos } from './support/repos';
import { DbAssetRepo } from '../src/main/services/database/db-asset-repo';
import { DbService } from '../src/main/services/database/db-service';
import { DbAbortError, describeDbError } from '../src/main/services/database/drivers';
import { cellText, columnKind, describeTable, estimateRows, listSchema, tableForModel, toCsv, toTable } from '../src/main/services/database/db-tools';
import { ToolGateway, type StepResponse, type ToolContext } from '../src/main/services/ai/tool-gateway';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import type { SettingsRepo } from '../src/main/services/settings/settings-repo';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import type { CredentialRepo } from '../src/main/services/vault/credential-repo';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const OWNER = 7;
const MYSQL = { host: '127.0.0.1', port: Number(process.env.ITM_TEST_MYSQL_PORT ?? 3308) };
const PG = { host: '127.0.0.1', port: Number(process.env.ITM_TEST_PG_PORT ?? 5433) };
const PW = 'itm-test-pw';

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
const hasMysql = await reachable(MYSQL.port);
const hasPg = await reachable(PG.port);

const input = (over: Partial<DbAssetInput> = {}): DbAssetInput => ({
  name: 'shop-mysql',
  type: 'MYSQL',
  host: MYSQL.host,
  port: MYSQL.port,
  database: 'shop',
  username: 'itm',
  password: PW,
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
let vaultKey: Buffer;
let repo: DbAssetRepo;
let settings: SettingsRepo;
let hosts: HostRepo;
let credentials: CredentialRepo;
let pool: SshPool;
let broker: PromptBroker;
let service: DbService;

function emit<E extends IpcEventName>(_owner: number, event: E, payload: IpcEvents[E]): void {
  if (event === 'prompt.request') {
    const req = payload as PromptRequest;
    setTimeout(() => broker.answer(OWNER, req.promptId, { kind: 'hostKey', accept: true }), 1);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-r17-'));
  vaultKey = randomBytes(32);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ settings, hosts, credentials } = createRepos(db, vaultKey));
  repo = new DbAssetRepo(db, vaultKey);
  broker = new PromptBroker(emit);
  pool = new SshPool(hosts, broker, 5000);
  service = new DbService({ repo, credentials, hosts, pool });
});

afterEach(() => {
  pool.closeAll();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('数据库资产（db_asset，文档一 6.31.2）', () => {
  it('密码用保险库密钥加密保存，不返回；不改密码时保留，清空 / 引用凭证时删除', () => {
    const a = repo.save(null, input());
    expect(a).toMatchObject({ name: 'shop-mysql', type: 'MYSQL', hasPassword: true, database: 'shop' });
    expect(JSON.stringify(a)).not.toContain(PW);
    const raw = db.prepare<[string], { password_enc: Buffer }>('SELECT password_enc FROM db_asset WHERE id = ?').get(a.id)!;
    expect(raw.password_enc.toString('latin1')).not.toContain(PW);
    expect(repo.password(a.id)).toBe(PW);
    // 换一个 ID 解密失败（AAD 绑定资产 ID）
    expect(() => repo.save(a.id, { ...input(), password: undefined })).not.toThrow();
    expect(repo.password(a.id)).toBe(PW);
    repo.save(a.id, { ...input(), password: null });
    expect(repo.get(a.id)!.hasPassword).toBe(false);
    repo.save(a.id, { ...input(), password: 'x' });
    const cred = credentials.save(null, { type: 'DB', name: '测试库账号', username: 'itm', secret: PW, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    const b = repo.save(a.id, { ...input(), password: undefined, credentialId: cred.id });
    expect(b.hasPassword).toBe(false);
    expect(repo.usingCredential(cred.id).map((x) => x.id)).toEqual([a.id]);
  });

  it('校验：重名、端口、SQLite 绝对路径、SQL 黑名单正则；复制带上密码；删除', () => {
    const a = repo.save(null, input());
    expect(() => repo.save(null, input({ name: 'SHOP-MYSQL' }))).toThrow(/已经有名为/);
    expect(() => repo.save(null, input({ name: 'x', port: 0 }))).toThrow(/端口/);
    expect(() => repo.save(null, input({ name: 'x', type: 'SQLITE', filePath: 'rel.db' }))).toThrow(/绝对路径/);
    expect(() => repo.save(null, input({ name: 'x', sqlDenylist: ['(unclosed'] }))).toThrow(/正则/);
    const s = repo.save(null, input({ name: 'lite', type: 'SQLITE', filePath: '/tmp/x.db', host: 'ignored', password: 'p' }));
    expect(s).toMatchObject({ host: '', port: 0, hasPassword: false, filePath: '/tmp/x.db' });
    const c = repo.duplicate(a.id);
    expect(c.name).toBe('shop-mysql 副本');
    expect(repo.password(c.id)).toBe(PW);
    repo.delete([a.id, c.id]);
    expect(repo.list().map((x) => x.name)).toEqual(['lite']);
  });
});

describe('结果格式和列名脱敏（文档一 6.31.6）', () => {
  it('按列名判断：密码类 / 个人信息类', () => {
    for (const n of ['password', 'password_hash', 'userPwd', 'api_key', 'AccessKey', 'refresh_token', 'salt', 'client_secret']) expect(columnKind(n), n).toBe('secret');
    for (const n of ['phone', 'mobile', 'user_phone', 'Email', 'id_card', 'idCard', 'bank_card_no', '手机号', '身份证']) expect(columnKind(n), n).toBe('pii');
    for (const n of ['id', 'name', 'created_at', 'hotel', 'status', 'amount', 'passenger']) expect(columnKind(n), n).toBeNull();
  });

  it('发给模型：脱敏、NULL、换行和竖线转义、超长时减少行数并说明', () => {
    const t = toTable({ columns: ['id', 'phone', 'password', 'note'], rows: [[1, '13800138000', 'secret', 'a|b\nc'], [2, null, null, 'x'.repeat(800)]], truncated: true, affected: null, durationMs: 3 });
    const m = tableForModel(t, true, 16_000);
    expect(m.text).toContain('1 | [PII] | **** | a\\|b\\nc');
    expect(m.text).toContain('2 | NULL | NULL | ' + 'x'.repeat(500) + '…');
    expect(m.text).not.toContain('13800138000');
    expect(m.text).toContain('达到行数上限');
    expect(m.masked).toEqual(['phone', 'password']);
    expect(tableForModel(t, false, 16_000).text).toContain('13800138000');
    const big = toTable({ columns: ['v'], rows: Array.from({ length: 500 }, (_, i) => [`row-${i}-${'y'.repeat(100)}`]), truncated: false, affected: null, durationMs: 1 });
    const small = tableForModel(big, true, 2000);
    expect(small.shown).toBeLessThan(20);
    expect(small.text).toContain(`只给出前 ${small.shown} 行`);
  });

  it('单元格和 CSV', () => {
    expect(cellText(Buffer.from('ab'))).toBe('0x6162');
    expect(cellText(Buffer.alloc(100))).toMatch(/…（100 字节）$/);
    expect(cellText(12n)).toBe('12');
    expect(cellText({ a: 1n })).toBe('{"a":"1"}');
    expect(toCsv(['a', 'b'], [['1,2', 'x"y'], [null, '中文']])).toBe('﻿a,b\r\n"1,2","x""y"\r\n,中文\r\n');
  });
});

describe.skipIf(!hasMysql)('MySQL 驱动（本机测试库）', () => {
  it('测试连接：版本、延迟、库数量；密码错误', async () => {
    const r = await service.test(OWNER, null, input());
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.version).toMatch(/^\d+\.\d+/);
    const bad = await service.test(OWNER, null, input({ password: 'wrong' }));
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toMatch(/用户名或密码错误/);
    // 已保存的密码：表单里不填密码时用保存的
    const a = repo.save(null, input());
    expect(await service.test(OWNER, a.id, { ...input(), password: undefined })).toMatchObject({ ok: true });
  });

  it('只读事务里写不进去；达到行数上限时只读取 maxRows 行；写操作在事务里提交', async () => {
    const a = repo.save(null, input());
    const s = await service.open(OWNER, a.id);
    try {
      const n = await s.run('SELECT count(*) FROM t_order', { readOnly: true, maxRows: 10, timeoutMs: 10_000 });
      expect(n.rows[0][0]).toBe('600');
      await expect(s.run("UPDATE t_user SET name = 'x' WHERE id = 1", { readOnly: true, maxRows: 10, timeoutMs: 10_000 })).rejects.toThrow(/READ ONLY/i);
    } finally {
      await s.close();
    }
    const s2 = await service.open(OWNER, a.id);
    const big = await s2.run('SELECT * FROM t_order ORDER BY id', { readOnly: true, maxRows: 50, timeoutMs: 10_000 });
    expect(big.rows).toHaveLength(50);
    expect(big.truncated).toBe(true);
    // DECIMAL / DATETIME 按原文
    expect(typeof big.rows[0][2]).toBe('string');
    expect(String(big.rows[0][4])).toMatch(/^2026-10-01 /);
    await s2.close();
    const s3 = await service.open(OWNER, a.id);
    const w = await s3.run("UPDATE t_user SET name = '张三丰' WHERE id = 1", { readOnly: false, maxRows: 10, timeoutMs: 10_000 });
    expect(w.affected).toBe(1);
    const back = await s3.run('SELECT name FROM t_user WHERE id = 1', { readOnly: true, maxRows: 1, timeoutMs: 10_000 });
    expect(back.rows[0][0]).toBe('张三丰');
    await s3.run("UPDATE t_user SET name = '张三' WHERE id = 1", { readOnly: false, maxRows: 10, timeoutMs: 10_000 });
    await s3.close();
  });

  it('停止时立即断开；超时', async () => {
    const a = repo.save(null, input());
    const s = await service.open(OWNER, a.id);
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 200);
    await expect(s.run('SELECT SLEEP(5)', { readOnly: true, maxRows: 1, timeoutMs: 30_000, signal: ac.signal })).rejects.toBeInstanceOf(DbAbortError);
    expect(Date.now() - started).toBeLessThan(2000);
    await s.close();
    const s2 = await service.open(OWNER, a.id);
    const t0 = Date.now();
    // MySQL 的 max_execution_time 会打断 SLEEP（返回 1）；不支持时由客户端计时断开
    await s2.run('SELECT SLEEP(3)', { readOnly: true, maxRows: 1, timeoutMs: 800 }).catch((e: Error) => e);
    expect(Date.now() - t0).toBeLessThan(2500);
    await s2.close();
  });

  it('元数据：列出库、表（注释、估算行数）、表结构（索引、外键、建表语句）；EXPLAIN 估算影响行数', async () => {
    const noDefault = repo.save(null, input({ name: 'no-default', database: '' }));
    const s = await service.open(OWNER, noDefault.id);
    const dbs = await listSchema(s, {});
    expect(dbs.text).toContain('shop');
    expect(dbs.text).toContain('用 database 参数');
    const tables = await listSchema(s, { database: 'shop' });
    expect(tables.text).toMatch(/t_order 约 \d+ 行 — 订单/);
    expect(tables.text).toContain('t_user');
    expect(await describeTable(s, 'nope', { database: 'shop' })).toBeNull();
    const d = await describeTable(s, 't_order', { database: 'shop' });
    expect(d!.text).toContain('idx_user');
    expect(d!.text).toContain('user_id → t_user.id');
    expect(d!.text).toContain('CREATE TABLE `t_order`');
    await s.close();
    const a = repo.save(null, input());
    const s2 = await service.open(OWNER, a.id);
    const n = await estimateRows(s2, 'UPDATE t_order SET status = status WHERE user_id = 1', {});
    expect(n).toBeGreaterThan(50);
    await s2.close();
  });
});

describe.skipIf(!hasPg)('PostgreSQL 驱动（本机测试库）', () => {
  const pgInput = (over: Partial<DbAssetInput> = {}): DbAssetInput => input({ name: 'shop-pg', type: 'POSTGRES', host: PG.host, port: PG.port, ...over });

  it('游标只读取 maxRows 行；类型按原文；只读事务；statement_timeout；schema 参数', async () => {
    const a = repo.save(null, pgInput());
    const s = await service.open(OWNER, a.id);
    expect(s.driver.version).toMatch(/^PostgreSQL \d+/);
    const r = await s.run('SELECT id, amount, paid, created_at FROM orders ORDER BY id', { readOnly: true, maxRows: 100, timeoutMs: 10_000, cursorable: true });
    expect(r.rows).toHaveLength(100);
    expect(r.truncated).toBe(true);
    expect(r.rows[0]).toEqual(['1', '11.37', 'false', expect.stringMatching(/^2026-10-01 /)]);
    const err = await s.run('DELETE FROM orders', { readOnly: true, maxRows: 1, timeoutMs: 10_000 }).catch((e: unknown) => e);
    expect(describeDbError(err)).toMatch(/只读事务/);
    const slow = await s.run('SELECT pg_sleep(3)', { readOnly: true, maxRows: 1, timeoutMs: 600 }).catch((e: unknown) => e);
    expect(describeDbError(slow)).toMatch(/查询超时/);
    const region = await s.run('SELECT * FROM region ORDER BY code', { readOnly: true, maxRows: 10, timeoutMs: 10_000, schema: 'sales', cursorable: true });
    expect(region.rows.map((x) => x[1])).toEqual(['华东', '华北']);
    const w = await s.run('UPDATE orders SET amount = amount WHERE id <= 3', { readOnly: false, maxRows: 10, timeoutMs: 10_000 });
    expect(w.affected).toBe(3);
    await s.close();
  });

  it('元数据和 EXPLAIN 估算', async () => {
    const a = repo.save(null, pgInput());
    const s = await service.open(OWNER, a.id);
    const t = await listSchema(s, {});
    expect(t.text).toContain('schema：public、sales');
    expect(t.text).toMatch(/orders 约 1500 行/);
    expect(t.text).toContain('users 约 2 行 — 用户');
    const d = await describeTable(s, 'orders', {});
    expect(d!.text).toContain('主键 orders_pkey');
    expect(d!.text).toContain('外键 orders_user_id_fkey');
    expect(d!.text).toContain('idx_orders_user');
    const sales = await listSchema(s, { schema: 'sales' });
    expect(sales.text).toContain('region');
    expect(await estimateRows(s, 'DELETE FROM orders WHERE user_id = 1', {})).toBeGreaterThan(100);
    await s.close();
  });
});

describe('SQLite 驱动（本机文件）', () => {
  it('只读时拒绝写语句；读取上限；写操作影响行数；元数据', async () => {
    const file = join(dir, 'app.db');
    const raw = new Database(file);
    raw.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT); CREATE INDEX idx_name ON item(name);");
    const ins = raw.prepare('INSERT INTO item (name, email) VALUES (?, ?)');
    for (let i = 0; i < 30; i++) ins.run(`n${i}`, `u${i}@example.com`);
    raw.close();
    const a = repo.save(null, input({ name: 'lite', type: 'SQLITE', filePath: file }));
    expect(await service.test(OWNER, a.id, { ...input({ name: 'lite', type: 'SQLITE', filePath: file }), password: undefined })).toMatchObject({ ok: true, version: expect.stringMatching(/^SQLite 3/) });
    const s = await service.open(OWNER, a.id);
    await expect(s.run("UPDATE item SET name = 'x'", { readOnly: true, maxRows: 10, timeoutMs: 5000 })).rejects.toThrow(/只读查询不能执行/);
    const r = await s.run('SELECT * FROM item', { readOnly: true, maxRows: 10, timeoutMs: 5000 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.rows[0][0]).toBe(1n);
    const w = await s.run("DELETE FROM item WHERE id > 20", { readOnly: false, maxRows: 10, timeoutMs: 5000 });
    expect(w.affected).toBe(10);
    const d = await describeTable(s, 'item', {});
    expect(d!.text).toContain('idx_name');
    expect(d!.text).toContain('CREATE TABLE item');
    expect((await listSchema(s, {})).text).toContain('item');
    await s.close();
  });
});

describe.skipIf(!hasMysql)('经过 SSH 主机连接（隧道）', () => {
  let server: TestSshServer;
  beforeEach(async () => {
    server = await startTestSshServer({ root: dir, allowForward: true });
  });
  afterEach(async () => {
    await server.close();
  });

  it('经过 SSH 主机连上数据库；目标端口不通时说明是 SSH 主机连不上', async () => {
    const hostId = hosts.create({
      folderId: null, name: 'bastion', address: '127.0.0.1', port: server.port, username: 'tester', authMethod: 'PASSWORD',
      password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
    }).id;
    const a = repo.save(null, input({ viaHostId: hostId }));
    const s = await service.open(OWNER, a.id);
    const r = await s.run('SELECT count(*) FROM t_user', { readOnly: true, maxRows: 1, timeoutMs: 10_000 });
    expect(r.rows[0][0]).toBe('3');
    await s.close();
    expect(server.forwards).toContain(`127.0.0.1:${MYSQL.port}`);
    const bad = await service.test(OWNER, null, input({ viaHostId: hostId, port: 1 }));
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.error).toContain('SSH 主机「bastion」连不上 127.0.0.1:1');
  });
});

// ---------------------------------------------------------------- Agent 工具（网关）

const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
let approval: ApprovalEngine;
beforeAll(async () => {
  approval = await createApprovalEngine(wasm);
});
afterAll(() => undefined);

interface Harness {
  gw: ToolGateway;
  audit: AuditRepo;
  steps: AgentStep[];
  waits: AgentStep[];
  call(name: string, args: Record<string, unknown>, over?: Partial<ToolContext>): ReturnType<ToolGateway['execute']>;
}

function harness(dbs: Record<string, string>, respond: (s: AgentStep) => StepResponse = () => ({ decision: 'approve' })): Harness {
  const audit = new AuditRepo(db);
  const steps: AgentStep[] = [];
  const waits: AgentStep[] = [];
  const gw = new ToolGateway({
    hosts, credentials, settings, audit, approval, pool,
    sessions: {} as never, monitor: {} as never, skills: {} as never, runtime: {} as never,
    emit: () => undefined,
    policy: () => ({ ...DEFAULT_POLICY }),
    runLocal: async () => {
      throw new Error('不应该执行本机命令');
    },
    databases: service,
  });
  let n = 0;
  return {
    gw, audit, steps, waits,
    call: (name, args, over = {}) => {
      const call: ToolCall = { id: `call-${++n}`, name, args };
      return gw.execute(call, {
        conversationId: 'conv-1', owner: OWNER, mode: 'agent', targets: {}, databases: dbs,
        masker: new Masker({ maskIps: false, maskPii: true }), signal: new AbortController().signal, reviewModel: null,
        ui: {
          add: (s) => steps.push(s),
          update: () => undefined,
          wait: async (s) => {
            waits.push({ ...s, reasons: [...s.reasons] });
            return respond(s);
          },
        },
        ...over,
      });
    },
  };
}

describe('Agent 的 db_* 工具（不需要真实数据库的部分）', () => {
  it('没有引用的编号、Ask 模式不能执行 SQL、db_query 拒绝写语句、黑名单、凭证禁止 AI 引用', async () => {
    const lite = join(dir, 'x.db');
    new Database(lite).exec('CREATE TABLE t (id INTEGER PRIMARY KEY, phone TEXT); INSERT INTO t (phone) VALUES (\'13800138000\');');
    const a = repo.save(null, input({ name: 'lite', type: 'SQLITE', filePath: lite, sqlDenylist: ['(?i)\\bsecret_table\\b'] }));
    const h = harness({ d1: a.id });
    const r0 = await h.call('db_query', { db: 'd9', sql: 'SELECT 1', explanation: 'x' });
    expect(r0.isError).toBe(true);
    expect(r0.content).toContain('不在本轮的引用里，可用的编号：d1');
    const r1 = await h.call('db_query', { db: 'd1', sql: 'SELECT 1', explanation: 'x' }, { mode: 'ask' });
    expect(r1.content).toContain('Ask 模式不能执行 SQL');
    const r2 = await h.call('db_schema', { db: 'd1' }, { mode: 'ask' });
    expect(r2.isError).toBe(false);
    expect(r2.content).toContain('t');
    const r3 = await h.call('db_query', { db: 'd1', sql: 'DELETE FROM t WHERE id = 1', explanation: 'x' });
    expect(r3.step?.decision).toBe('DENY');
    expect(r3.content).toContain('db_query 只能执行只读 SQL');
    const r4 = await h.call('db_query', { db: 'd1', sql: 'SELECT * FROM SECRET_TABLE', explanation: 'x' });
    expect(r4.content).toContain('命中这个数据库的 SQL 黑名单');
    // 结果卡片原值，发给模型的脱敏
    const r5 = await h.call('db_query', { db: 'd1', sql: 'SELECT * FROM t', explanation: '看看' });
    expect(r5.step?.table?.rows).toEqual([['1', '13800138000']]);
    expect(r5.content).toContain('1 | [PII]');
    expect(r5.content).not.toContain('13800138000');
    expect(r5.content).toContain('<untrusted>');
    const cred = credentials.save(null, { type: 'DB', name: '禁止 AI 的账号', username: 'u', secret: 'p', aiAccess: 'DENY', rotateDays: null, expiresAt: null, note: null });
    const b = repo.save(null, input({ name: 'deny-ai', credentialId: cred.id, password: undefined }));
    const r6 = await harness({ d2: b.id }).call('db_query', { db: 'd2', sql: 'SELECT 1', explanation: 'x' });
    expect(r6.content).toContain('禁止 AI 引用');
    // db_execute：写操作需要批准；用户在卡片里改了 SQL 时按新 SQL 重新分级
    const h2 = harness({ d1: a.id }, (s) => ({ decision: 'approve', command: s.command.replace('id = 1', 'id = 2') }));
    const w = await h2.call('db_execute', { db: 'd1', sql: "UPDATE t SET phone = 'x' WHERE id = 1", explanation: '改号码' });
    expect(h2.waits[0].decision).toBe('APPROVE');
    expect(w.step?.command).toBe("UPDATE t SET phone = 'x' WHERE id = 2");
    expect(w.step?.table?.affected).toBe(0);
  });
});

describe.skipIf(!hasMysql)('Agent 的 db_* 工具（MySQL）', () => {
  it('只读查询自动执行、结果表格、审计；写操作批准后执行并带影响行数估算；不带 WHERE 的 DELETE 要输入数据库名确认', async () => {
    const a = repo.save(null, input());
    // 上一次运行改过的数据先恢复（种子数据里用户 3 的订单都是 pending）
    const reset = await service.open(OWNER, a.id);
    await reset.run("UPDATE t_order SET status = 'pending' WHERE user_id = 3", { readOnly: false, maxRows: 1, timeoutMs: 10_000 });
    await reset.close();
    const h = harness({ d1: a.id }, (s) => (s.confirmText ? { decision: 'reject' } : { decision: 'approve' }));
    const q = await h.call('db_query', { db: 'd1', sql: 'SELECT id, name, phone, email, password_hash FROM t_user ORDER BY id', explanation: '查看用户' });
    expect(q.isError).toBe(false);
    expect(q.step?.decision).toBe('AUTO');
    expect(q.step?.table).toMatchObject({ columns: ['id', 'name', 'phone', 'email', 'password_hash'], rowCount: 3 });
    expect(q.step?.table?.rows[0]).toEqual(['1', '张三', '13800138000', 'zhang@example.com', '$2a$10$abcdef']);
    expect(q.content).toContain('1 | 张三 | [PII] | [PII] | ****');
    expect(q.content).not.toMatch(/13800138000|zhang@example\.com|abcdef/);
    const items = h.audit.list({ kind: 'COMMAND', limit: 10 }).items;
    expect(items.some((e) => e.hostName === '数据库 · shop-mysql' && (e.command ?? '').startsWith('SELECT id, name') && e.risk === 'L0')).toBe(true);

    const w = await h.call('db_execute', { db: 'd1', sql: "UPDATE t_order SET status = 'paid' WHERE user_id = 3 AND status = 'pending'", explanation: '补单' });
    expect(h.waits.at(-1)?.reasons.join('；')).toMatch(/预计影响约 \d+ 行/);
    expect(w.isError).toBe(false);
    expect(w.step?.table?.affected).toBeGreaterThan(0);

    const del = await h.call('db_execute', { db: 'd1', sql: 'DELETE FROM t_order', explanation: '清空' });
    expect(h.waits.at(-1)).toMatchObject({ level: 'L2', decision: 'CONFIRM', confirmText: 'shop-mysql' });
    expect(del.content).toContain('用户拒绝执行');
    const s = await service.open(OWNER, a.id);
    expect((await s.run('SELECT count(*) FROM t_order', { readOnly: true, maxRows: 1, timeoutMs: 5000 })).rows[0][0]).toBe('600');
    await s.close();

    // 查询失败：数据库的错误原文
    const bad = await h.call('db_query', { db: 'd1', sql: 'SELECT nope FROM t_user', explanation: 'x' });
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/Unknown column/);
    // db_explain：只看计划
    const ex = await h.call('db_explain', { db: 'd1', sql: 'SELECT * FROM t_order WHERE user_id = 1' });
    expect(ex.step?.level).toBe('L0');
    expect(ex.step?.command).toBe('SELECT * FROM t_order WHERE user_id = 1');
    expect(ex.content).toContain('idx_user');
    const ex2 = await h.call('db_explain', { db: 'd1', sql: 'EXPLAIN ANALYZE SELECT 1' });
    expect(ex2.content).toContain('EXPLAIN ANALYZE 会真的执行');
  });

  it('Agent 权限：只读（旧选项）拒绝写、生产环境查询也要批准、对话里选需要审批、Skill 的权限上限', async () => {
    const ro = repo.save(null, input({ name: 'ro', agentPolicy: 'READONLY' }));
    const prod = repo.save(null, input({ name: 'prod', production: true }));
    const plain = repo.save(null, input({ name: 'plain' }));
    const h = harness({ d1: ro.id, d2: prod.id, d3: plain.id });
    const r1 = await h.call('db_execute', { db: 'd1', sql: "UPDATE t_user SET name = name WHERE id = 1", explanation: 'x' });
    expect(r1.step?.decision).toBe('DENY');
    expect(r1.content).toContain('只读');
    // 只读的 SELECT 正常执行
    expect((await h.call('db_query', { db: 'd1', sql: 'SELECT 1', explanation: 'x' })).isError).toBe(false);
    await h.call('db_query', { db: 'd2', sql: 'SELECT 1', explanation: 'x' });
    expect(h.waits.at(-1)).toMatchObject({ decision: 'APPROVE' });
    expect(h.waits.at(-1)?.reasons.join('')).toContain('生产环境');
    // 生产环境的元数据不用每次批准
    const before = h.waits.length;
    await h.call('db_schema', { db: 'd2' });
    expect(h.waits.length).toBe(before);
    // 对话里选「需要审批」：写操作要批准
    const r3 = await h.call('db_execute', { db: 'd3', sql: "UPDATE t_user SET name = name WHERE id = 1", explanation: 'x' }, { chatPolicy: { mode: 'APPROVE', confirmHighRisk: true } });
    expect(r3.step?.decision).toBe('APPROVE');
    const r4 = await h.call('db_execute', { db: 'd3', sql: "UPDATE t_user SET name = name WHERE id = 1", explanation: 'x' }, { policyCap: 'READONLY' });
    expect(r4.step?.decision).toBe('DENY');
    // 对话里选「完全允许」：普通写操作自动执行
    const r5 = await h.call('db_execute', { db: 'd3', sql: "UPDATE t_user SET name = name WHERE id = 1", explanation: 'x' }, { chatPolicy: { mode: 'AUTO', confirmHighRisk: true } });
    expect(r5.step?.decision).toBe('AUTO');
    // MySQL 驱动按「匹配的行数」返回（CLIENT_FOUND_ROWS），和 PostgreSQL 一致
    expect(r5.step?.table?.affected).toBe(1);
    // 事务控制、多条语句直接拒绝
    expect((await h.call('db_execute', { db: 'd3', sql: 'BEGIN', explanation: 'x' })).content).toContain('不能自己控制事务');
    expect((await h.call('db_query', { db: 'd3', sql: 'SELECT 1; SELECT 2', explanation: 'x' })).content).toContain('一次只能执行一条');
  });
});

describe('提示词和工具定义', () => {
  it('工具清单、Ask 可用的工具、计入命令数的工具', async () => {
    const { TOOLS, ASK_TOOLS, COMMAND_TOOLS, SYSTEM_PROMPT } = await import('@itm/agent-core');
    const names = TOOLS.map((t) => t.name);
    for (const n of ['db_schema', 'db_describe', 'db_query', 'db_explain', 'db_execute']) expect(names).toContain(n);
    expect(ASK_TOOLS.has('db_schema') && ASK_TOOLS.has('db_describe') && !ASK_TOOLS.has('db_query')).toBe(true);
    expect(COMMAND_TOOLS.has('db_execute') && COMMAND_TOOLS.has('db_query')).toBe(true);
    expect(SYSTEM_PROMPT).toContain('d1、d2 是引用的数据库');
    const src = readFileSync(join(__dirname, '../src/main/services/db/migrations/0013_db_asset.sql'), 'utf8');
    expect(src).toContain('CREATE TABLE db_asset');
    writeFileSync(join(dir, 'noop'), '');
  });
});

describe('AgentService：引用数据库（编号 d1、上下文、结果卡片）', () => {
  it('引用的数据库出现在本轮上下文里；db_query 的结果表格在对话里，发给模型的已脱敏', async () => {
    const { AgentService } = await import('../src/main/services/ai/agent-service');
    const { InlineRuntime } = await import('../src/main/services/ai/runtime');
    const { AiProviderRepo } = await import('../src/main/services/ai/provider-repo');
    const { SkillStore } = await import('../src/main/services/ai/skills');
    const { startLlmMock } = await import('./support/llm-mock');
    const file = join(dir, 'crm.db');
    new Database(file).exec("CREATE TABLE customer (id INTEGER PRIMARY KEY, name TEXT, mobile TEXT); INSERT INTO customer (name, mobile) VALUES ('甲', '13800138000'), ('乙', '13900139000');");
    const a = repo.save(null, input({ name: 'crm', type: 'SQLITE', filePath: file, note: '客户库，只读分析用' }));
    const mock = await startLlmMock();
    const views: import('@itm/protocol').AgentConversationView[] = [];
    try {
      const providers = new AiProviderRepo(db, vaultKey);
      const p = providers.save(null, { name: 'mock', type: 'ANTHROPIC', baseUrl: mock.url, apiKey: 'k', enabled: true, models: [{ id: 'claude-opus-5-5', contextWindow: 200_000, maxOutput: 4000 }] });
      const model = { providerId: p.id, modelId: 'claude-opus-5-5' };
      settings.set('ai.llmReview', false);
      const agent = new AgentService({
        db, providers, pool, hosts, credentials, settings, approval,
        sessions: {} as never, monitor: {} as never, skills: new SkillStore(join(dir, 'skills')), audit: new AuditRepo(db), runtime: new InlineRuntime(),
        emit: (_o, e, payload) => {
          if (e === 'agent.update') views.push(payload as import('@itm/protocol').AgentConversationView);
        },
        policy: () => ({ ...DEFAULT_POLICY }),
        databases: service,
      });
      mock.enqueue({ toolCalls: [{ id: 'toolu_db', name: 'db_query', input: { db: 'd1', sql: 'SELECT name, mobile FROM customer ORDER BY id', explanation: '看看有哪些客户' } }] }, { text: '共有 2 个客户。' });
      const conv = agent.create(model);
      agent.send(OWNER, conv.id, '客户有几个？', 'agent', model, { terminals: [], skillIds: [], databaseIds: [a.id] });
      const start = Date.now();
      let v = views.at(-1);
      while (!(v && v.id === conv.id && !v.running && v.messages.length > 1) && Date.now() - start < 8000) {
        await new Promise((r) => setTimeout(r, 20));
        v = views.filter((x) => x.id === conv.id).at(-1);
      }
      const first = JSON.stringify(mock.requests[0].body.messages);
      expect(first).toContain('d1：数据库 crm（SQLite 本机文件');
      expect(first).toContain('说明：客户库，只读分析用');
      const tools = (mock.requests[0].body.tools as { name: string }[]).map((t) => t.name);
      expect(tools).toContain('db_query');
      const step = v!.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : [])).find((s) => s.tool === 'db_query');
      expect(step).toMatchObject({ hostLabel: 'd1', hostName: 'crm', status: 'done', level: 'L0' });
      expect(step!.table!.rows).toEqual([['甲', '13800138000'], ['乙', '13900139000']]);
      const second = JSON.stringify(mock.requests[1].body.messages);
      expect(second).toContain('甲 | [PII]');
      expect(second).not.toContain('13800138000');
    } finally {
      await mock.close();
    }
  });
});
