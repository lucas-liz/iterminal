import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApprovalEngine, DEFAULT_POLICY, type ApprovalEngine } from '@itm/approval';
import type { IpcEventName, IpcEvents, PromptAnswer, PromptRequest, ServerState, TaskRunView } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { createRepos } from './support/repos';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { RecordingStore } from '../src/main/services/audit/recording-store';
import { AuditUploader } from '../src/main/services/audit/audit-uploader';
import { ServerLink } from '../src/main/services/server/server-link';
import { RemoteApprovals } from '../src/main/services/server/remote-approvals';
import { TaskExecutor } from '../src/main/services/server/task-executor';
import { startMockServer, type MockServer } from './support/mock-server';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

const OWNER = 3;
const wasm = {
  bashWasm: join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-bash', 'tree-sitter-bash.wasm'),
  treeSitterWasm: join(__dirname, '..', '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
};

let mock: MockServer;
let dir: string;
let db: Db;
let link: ServerLink;
let states: ServerState[];
let engine: ApprovalEngine;
let ssh: TestSshServer;

const waitFor = async <T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const makeLink = (over: Partial<ConstructorParameters<typeof ServerLink>[0]> = {}): ServerLink =>
  new ServerLink({
    baseUrl: mock.url,
    token: async () => mock.token,
    deviceId: 'dev-1',
    clientVersion: '0.6.0',
    onState: (s) => states.push(s),
    pingMs: 200,
    ackTimeoutMs: 150,
    backoff: { firstMs: 50, maxMs: 200 },
    ...over,
  });

beforeAll(async () => {
  engine = await createApprovalEngine(wasm);
});
beforeEach(async () => {
  mock = await startMockServer();
  dir = mkdtempSync(join(tmpdir(), 'itm-srv-'));
  mkdirSync(join(dir, 'remote'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  states = [];
});
afterEach(async () => {
  link?.stop();
  await mock.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await ssh?.close();
});

describe('服务端连接（文档二第 7 章）', () => {
  it('换票连接、hello、ping；服务端的需要确认的消息回 ack 并去重', async () => {
    link = makeLink();
    const got: unknown[] = [];
    link.on('notify', (p) => void got.push(p));
    link.start();
    const hello = await mock.waitFor((m) => m.type === 'hello');
    expect(hello.payload).toEqual({ deviceId: 'dev-1', clientVersion: '0.6.0', capabilities: ['executor', 'approval'] });
    expect(link.get().status).toBe('online');
    await mock.waitFor((m) => m.type === 'ping');
    const id = mock.send('notify', { title: '你好' }, { ack: true });
    mock.send('notify', { title: '你好' }, { ack: true, id }); // 服务端重发
    await mock.waitFor((m) => m.type === 'ack' && m.id === id);
    await waitFor(() => got.length >= 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([{ title: '你好' }]);
  });

  it('自己发出的消息没收到 ack 就重发（最多 3 次）；断线后自动重连', async () => {
    link = makeLink();
    link.start();
    await mock.waitFor((m) => m.type === 'hello');
    mock.holdAcks(true);
    const id = link.send('task.result', { runId: 'r1' }, { ack: true });
    await waitFor(() => mock.received.filter((m) => m.id === id).length >= 3, 3000);
    await new Promise((r) => setTimeout(r, 400));
    expect(mock.received.filter((m) => m.id === id)).toHaveLength(3);
    mock.holdAcks(false);

    mock.dropClients();
    await waitFor(() => states.some((s) => s.status === 'offline'));
    await waitFor(() => mock.received.filter((m) => m.type === 'hello').length >= 2, 3000);
    expect(link.get().status).toBe('online');
  });

  it('令牌不对时连不上，状态是离线并有原因', async () => {
    link = makeLink({ token: async () => 'wrong' });
    link.start();
    await waitFor(() => states.find((s) => s.status === 'offline'));
    expect(link.get().lastError).toContain('401');
  });
});

describe('远程审批', () => {
  it('审批人：收到请求列入待审批，批准后发 approval.decide；过期的自动移除', async () => {
    link = makeLink();
    const lists: number[] = [];
    const notified: string[] = [];
    const ap = new RemoteApprovals(link, { emit: (l) => lists.push(l.length), notify: (a) => notified.push(a.command) });
    link.start();
    await mock.waitFor((m) => m.type === 'hello');
    mock.send('approval.request', { approvalId: 'a1', runId: 'r1', taskName: '清理日志', host: 'web-01', command: 'rm -rf /var/log/old', risk: 'L2', reasons: ['递归删除'], expiresAt: new Date(Date.now() + 60_000).toISOString() }, { ack: true });
    await waitFor(() => ap.list().length === 1);
    expect(ap.list()[0]).toMatchObject({ host: 'web-01', risk: 'L2', taskName: '清理日志' });
    expect(notified).toEqual(['rm -rf /var/log/old']);
    ap.decide('a1', 'APPROVED', '低峰期可以');
    const d = await mock.waitFor((m) => m.type === 'approval.decide');
    expect(d).toMatchObject({ ack: true, payload: { approvalId: 'a1', decision: 'APPROVED', comment: '低峰期可以' } });
    expect(ap.list()).toEqual([]);
    expect(() => ap.decide('a1', 'REJECTED')).toThrow('已经处理');
    mock.send('approval.request', { approvalId: 'a2', runId: 'r1', host: 'x', command: 'y', risk: 'L1', expiresAt: new Date(Date.now() - 1000).toISOString() });
    await new Promise((r) => setTimeout(r, 100));
    expect(ap.list()).toEqual([]);
    ap.stop();
  });

  it('执行器：创建审批并等待结果', async () => {
    link = makeLink();
    const ap = new RemoteApprovals(link, { emit: () => undefined, notify: () => undefined });
    link.start();
    await mock.waitFor((m) => m.type === 'hello');
    expect(await ap.request('run-1', { hostId: 'h1', command: 'touch a', risk: 'L1', reasons: ['写文件'] }, 5000)).toBe(true);
    expect(mock.rest.find((r) => r.path === '/api/v1/sched/runs/run-1/approvals')?.body).toMatchObject({ hostId: 'h1', command: 'touch a', risk: 'L1' });
    mock.autoDecide('REJECTED');
    expect(await ap.request('run-2', { hostId: 'h1', command: 'touch b', risk: 'L1', reasons: [] }, 5000)).toBe(false);
    mock.autoDecide(null);
    expect(await ap.request('run-3', { hostId: 'h1', command: 'touch c', risk: 'L1', reasons: [] }, 200)).toBe(false);
    ap.stop();
  });
});

describe('定时任务执行器（文档一 6.11）', () => {
  it('COMMAND：只读命令自动执行，写操作走远程审批，策略禁止的拒绝，本机没有的主机跳过；回报进度和结果', async () => {
    ssh ??= await startTestSshServer({ root: join(dir, 'remote') });
    const vaultKey = randomBytes(32);
    const repos = createRepos(db, vaultKey);
    const broker: PromptBroker = new PromptBroker(<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]) => {
      if (event === 'prompt.request') setTimeout(() => broker.answer(owner, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true } as PromptAnswer), 1);
    });
    const pool = new SshPool(repos.hosts, broker, 5000);
    const mk = (name: string, agentPolicy: 'AUTO' | 'DENY' | null = null) =>
      repos.hosts.create({ folderId: null, name, address: '127.0.0.1', port: ssh.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [], agentPolicy }).id;
    const web = mk('web');
    const locked = mk('locked', 'DENY');
    link = makeLink();
    const approvals = new RemoteApprovals(link, { emit: () => undefined, notify: () => undefined });
    const runs: TaskRunView[] = [];
    const ex = new TaskExecutor({
      db,
      link,
      approvals,
      hosts: repos.hosts,
      pool,
      approval: engine,
      policy: () => DEFAULT_POLICY,
      settings: repos.settings,
      audit: new AuditRepo(db),
      agent: { runUnattended: async () => ({ conversationId: 'c', text: '', steps: [], status: 'SUCCESS', restore: (t: string) => t }) },
      owner: () => OWNER,
      emit: (r) => runs.push(r),
    });
    link.start();
    await mock.waitFor((m) => m.type === 'hello');

    mock.send('task.dispatch', { runId: 'run-ro', taskId: 't1', taskName: '巡检', type: 'COMMAND', command: 'echo ok-from-task', hosts: [web, locked, 'srv-9999'], permissionCap: 'READONLY', timeoutMin: 5 }, { ack: true });
    const ro = await mock.waitFor((m) => m.type === 'task.result' && m.payload?.runId === 'run-ro', 15_000);
    const hosts = ro.payload!.hosts as { hostId: string; status: string; output: string; message: string | null }[];
    expect(hosts.find((h) => h.hostId === web)).toMatchObject({ status: 'SUCCESS', output: expect.stringContaining('ok-from-task') });
    expect(hosts.find((h) => h.hostId === locked)?.status).toBe('DENIED');
    expect(hosts.find((h) => h.hostId === 'srv-9999')).toMatchObject({ status: 'SKIPPED', message: '这台设备上没有这台主机' });
    expect(ro.payload!.status).toBe('PARTIAL');
    expect(mock.received.some((m) => m.type === 'task.progress' && m.payload?.runId === 'run-ro')).toBe(true);

    // 写操作：只读上限 → 远程审批，批准后执行
    mock.send('task.dispatch', { runId: 'run-w', taskId: 't2', type: 'COMMAND', command: 'touch task-flag', hosts: [web], permissionCap: 'READONLY' }, { ack: true });
    const w = await mock.waitFor((m) => m.type === 'task.result' && m.payload?.runId === 'run-w', 15_000);
    expect(w.payload, JSON.stringify(w.payload)).toMatchObject({ status: 'SUCCESS' });
    expect(mock.rest.some((r) => r.path === '/api/v1/sched/runs/run-w/approvals')).toBe(true);
    expect(ssh.execs).toContain('touch task-flag');
    // 本地记录和审计
    expect(ex.list().items.map((r) => r.runId).sort()).toEqual(['run-ro', 'run-w']);
    expect(runs.some((r) => r.runId === 'run-w' && r.hosts[0].status === 'WAITING_APPROVAL')).toBe(true);
    // 重复派发只执行一次
    mock.send('task.dispatch', { runId: 'run-w', taskId: 't2', type: 'COMMAND', command: 'touch task-flag', hosts: [web] });
    await new Promise((r) => setTimeout(r, 300));
    expect(mock.received.filter((m) => m.type === 'task.result' && m.payload?.runId === 'run-w')).toHaveLength(1);
    pool.closeAll();
    approvals.stop();
  });
});

describe('审计上报', () => {
  it('批量上报、标记已上报；失败时退避，录像分片上传', async () => {
    const audit = new AuditRepo(db);
    for (let i = 0; i < 150; i++) audit.command({ source: 'USER', hostId: null, hostName: 'web', command: `echo ${i}` });
    const recs = new RecordingStore(db, dir, randomBytes(32));
    const r = recs.start({ sessionId: 's', kind: 'ssh', hostId: null, hostName: 'web', cols: 80, rows: 24 });
    r.output('hello');
    r.end();
    link = makeLink();
    const up = new AuditUploader({ db, request: (m, p, b) => link.request(m, p, b), recordings: recs, uploadRecordings: () => true, intervalMs: 60_000 });
    mock.failAudit(1);
    expect(await up.tick()).toEqual({ commands: 0, recordings: 0 });
    expect(up.failureCount).toBe(1);
    expect(await up.tick()).toEqual({ commands: 150, recordings: 1 });
    const batches = mock.rest.filter((x) => x.path === '/api/v1/audit/commands:batch' && x.method === 'POST');
    expect(batches.map((b) => (b.body as { items: unknown[] }).items.length)).toEqual([100, 100, 50]);
    expect((batches[1].body as { items: { clientEventId: string; command: string }[] }).items[0].command).toBe('echo 0');
    const chunk = mock.rest.find((x) => x.path.includes('/audit/sessions/'))!.body as { index: number; final: boolean; content: string; meta: { hostName: string } };
    expect(chunk).toMatchObject({ index: 0, final: true, meta: { hostName: 'web' } });
    expect(chunk.content).toContain('hello');
    expect(await up.tick()).toEqual({ commands: 0, recordings: 0 });
    up.stop();
  });
});
