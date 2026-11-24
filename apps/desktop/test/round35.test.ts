import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_POLICY_CHOICES, agentPolicyLabel, NAV_OPTIONAL, type BatchJob, type HostInput, type IpcEventName, type IpcEvents, type PromptAnswer, type PromptRequest } from '@itm/protocol';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SftpService } from '../src/main/services/sftp/sftp-service';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { RecordingStore } from '../src/main/services/audit/recording-store';
import { BatchService, finalStatus, resolveRemotePath, scriptCommand } from '../src/main/services/batch/batch-service';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
const OWNER = 3;
let dir: string;
let remoteRoot: string;
let db: Db;
let hosts: HostRepo;
let broker: PromptBroker;
let pool: SshPool;
let sftp: SftpService;
let audit: AuditRepo;
let ssh: TestSshServer;
let approval: ApprovalEngine;
let jobs: BatchJob[];
let batch: BatchService;

function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
  if (event !== 'prompt.request') return;
  const req = payload as PromptRequest;
  const answer: PromptAnswer = req.kind === 'hostKey' ? { kind: 'hostKey', accept: true } : { kind: 'password', value: 'pw', remember: false };
  setTimeout(() => broker.answer(owner, req.promptId, answer), 1);
}
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 15));
  }
}
const done = (id: string): BatchJob | undefined => jobs.filter((j) => j.id === id && j.status !== 'running').at(-1);

function addHost(name: string, extra: Partial<HostInput> = {}): string {
  return hosts.create({
    folderId: null,
    name,
    address: '127.0.0.1',
    port: ssh.port,
    username: 'tester',
    authMethod: 'PASSWORD',
    password: 'pw',
    keepaliveSec: 0,
    startupScript: null,
    note: null,
    jumpHostIds: [],
    ...extra,
  }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-r35-'));
  remoteRoot = join(dir, 'remote');
  mkdirSync(remoteRoot);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ hosts } = createRepos(db, randomBytes(32)));
  broker = new PromptBroker(emit);
  pool = new SshPool(hosts, broker, 5000);
  sftp = new SftpService(pool, { hosts, prompts: broker });
  audit = new AuditRepo(db);
  approval ??= await createApprovalEngine(wasm);
  ssh = await startTestSshServer({ root: remoteRoot, username: 'tester', password: 'pw', sftpRealPaths: true });
  jobs = [];
  batch = new BatchService({ db, hosts, pool, sftp, approval, policy: () => DEFAULT_POLICY, audit, emit: (j) => jobs.push(j), owner: () => OWNER });
});

afterEach(async () => {
  batch.stopAll();
  pool.closeAll();
  await ssh.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('第三十五轮：Agent 权限三档改名、导航', () => {
  it('三档：只读 / 自动 / 完全允许（内部取值不变）；旧的 READONLY 叫「严格只读」', () => {
    expect(AGENT_POLICY_CHOICES.map((c) => [c.value, c.label])).toEqual([
      ['APPROVE', '只读'],
      ['AI_REVIEW', '自动'],
      ['AUTO', '完全允许'],
    ]);
    expect(agentPolicyLabel('READONLY')).toBe('严格只读');
    expect(NAV_OPTIONAL).toContain('batch');
    expect(NAV_OPTIONAL).not.toContain('schedule' as never);
  });
});

describe('第三十五轮：批量执行', () => {
  it('纯函数：路径变量、脚本包装、任务状态', () => {
    expect(resolveRemotePath('${home}/app/${username}', { username: 'root', home: '/root' })).toBe('/root/app/root');
    expect(resolveRemotePath('upload/', { username: 'u', home: '/home/u' })).toBe('/home/u/upload');
    expect(resolveRemotePath('~/x', { username: 'u', home: '/home/u' })).toBe('/home/u/x');
    expect(resolveRemotePath('/opt/a/', { username: 'u', home: '/home/u' })).toBe('/opt/a');
    const s = scriptCommand('echo hi\nexit 3', 'abc-123');
    expect(s).toContain("<<'ITM_BATCH_EOF_abc123'");
    expect(s).toContain('rm -f');
    const h = (status: 'success' | 'failed') => ({ hostId: '', hostName: '', address: '', username: null, status, exitCode: null, output: '', error: null, startedAt: null, endedAt: null });
    expect(finalStatus([h('success'), h('success')], false)).toBe('success');
    expect(finalStatus([h('success'), h('failed')], false)).toBe('partial');
    expect(finalStatus([h('failed')], false)).toBe('failed');
    expect(finalStatus([h('success'), h('failed')], true)).toBe('cancelled');
  });

  it('在多台主机上执行命令：每台主机的输出、退出码；写命令审计；记录可以查询、删除', async () => {
    const a = addHost('web-a');
    const b = addHost('web-b');
    const job = await batch.exec({ hostIds: [a, b], command: 'echo hello-batch; echo err-line 1>&2', description: '巡检', timeoutSec: 30 });
    expect(job.status).toBe('running');
    expect(job.hostCount).toBe(2);
    const end = await waitFor(() => done(job.id));
    expect(end.status).toBe('success');
    expect(end.hosts!.map((h) => h.status)).toEqual(['success', 'success']);
    expect(end.hosts![0].output).toContain('hello-batch');
    expect(end.hosts![0].output).toContain('err-line');
    expect(end.hosts![0].username).toBe('tester');

    const cmds = audit.list({ kind: 'COMMAND' }).items;
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toMatchObject({ source: 'USER', command: 'echo hello-batch; echo err-line 1>&2', exitCode: 0, account: 'tester' });
    expect(cmds[0].detail).toMatchObject({ batchId: job.id, description: '巡检' });
    expect(audit.list({ kind: 'COMMAND', hostId: b }).items).toHaveLength(1);
    expect(audit.list({ kind: 'COMMAND', command: 'hello-batch' }).total).toBe(2);
    expect(audit.list({ kind: 'COMMAND', command: 'nope' }).total).toBe(0);

    const list = batch.list({ kind: 'exec' });
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ description: '巡检', status: 'success', counts: { success: 2, failed: 0 } });
    expect(batch.list({ kind: 'upload' }).total).toBe(0);
    expect(batch.list({ kind: 'exec', q: '巡检' }).total).toBe(1);
    const detail = batch.get(job.id);
    expect(detail.hosts!.map((h) => h.hostName)).toEqual(['web-a', 'web-b']);
    batch.delete([job.id]);
    expect(batch.list({ kind: 'exec' }).total).toBe(0);
  });

  it('部分失败、超时、脚本执行；黑名单命中的主机不执行', async () => {
    const a = addHost('ok-host');
    const denied = addHost('deny-host', { cmdDenylist: ['^exit 4'] } as Partial<HostInput>);
    const failed = await batch.exec({ hostIds: [a, denied], command: 'exit 4' });
    const f = await waitFor(() => done(failed.id));
    expect(f.status).toBe('failed');
    expect(f.hosts!.find((h) => h.hostName === 'ok-host')).toMatchObject({ status: 'failed', exitCode: 4 });
    expect(f.hosts!.find((h) => h.hostName === 'deny-host')).toMatchObject({ status: 'denied' });
    const check = await batch.check([a, denied], 'exit 4');
    expect(check.denied.map((d) => d.hostName)).toEqual(['deny-host']);

    const slow = await batch.exec({ hostIds: [a], command: 'sleep 5', timeoutSec: 1 });
    const t = await waitFor(() => done(slow.id));
    expect(t.hosts![0].status).toBe('timeout');

    const script = await batch.exec({ hostIds: [a], command: 'f() { echo "in-func $1"; }\nf 42\nexit 0', script: true });
    const s = await waitFor(() => done(script.id));
    expect(s.hosts![0]).toMatchObject({ status: 'success' });
    expect(s.hosts![0].output).toContain('in-func 42');

    await expect(batch.exec({ hostIds: [], command: 'ls' })).rejects.toThrow('请选择主机');
    await expect(batch.exec({ hostIds: [a], command: '  ' })).rejects.toThrow('请输入');
  });

  it('取消：执行中的主机停止，任务标记为已取消', async () => {
    const a = addHost('slow-host');
    const job = await batch.exec({ hostIds: [a], command: 'sleep 20' });
    await waitFor(() => jobs.some((j) => j.id === job.id && j.hosts?.[0].status === 'running'));
    batch.cancel(job.id);
    const end = await waitFor(() => done(job.id));
    expect(end.status).toBe('cancelled');
    expect(end.hosts![0].status).toBe('cancelled');
  });

  it('批量上传：文件和文件夹（保留目录结构）上传到 ${home} 下的目录，目录不存在时创建', async () => {
    const local = join(dir, 'local');
    mkdirSync(join(local, 'conf', 'sub'), { recursive: true });
    writeFileSync(join(local, 'app.jar'), randomBytes(200 * 1024));
    writeFileSync(join(local, 'conf', 'a.yml'), 'a: 1');
    writeFileSync(join(local, 'conf', 'sub', 'b.yml'), 'b: 2');
    const a = addHost('up-a');
    const items = await batch.inspectLocal([join(local, 'app.jar'), join(local, 'conf')]);
    expect(items.map((i) => [i.name, i.dir, i.files])).toEqual([
      ['app.jar', false, 1],
      ['conf', true, 2],
    ]);
    // 测试服务器的 SFTP 用真实路径（realpath('.') 是 /，${home} 的替换在上面的纯函数里测）
    const job = await batch.upload({ hostIds: [a], localPaths: [join(local, 'app.jar'), join(local, 'conf')], remotePath: `${remoteRoot}/deploy/\${username}`, description: '发版' });
    expect(job.fileCount).toBe(3);
    const end = await waitFor(() => done(job.id));
    expect(end.hosts![0].error ?? '').toBe('');
    expect(end.status).toBe('success');
    const target = join(end.hosts![0].output.split('\n')[0].replace('目标目录：', ''));
    expect(target.endsWith('/deploy/tester')).toBe(true);
    expect(readFileSync(join(target, 'conf', 'sub', 'b.yml'), 'utf8')).toBe('b: 2');
    expect(existsSync(join(target, 'app.jar'))).toBe(true);
    expect(batch.list({ kind: 'upload' }).items[0]).toMatchObject({ remotePath: `${remoteRoot}/deploy/\${username}`, fileCount: 3, status: 'success' });
    expect(audit.list({ kind: 'EVENT' }).items[0]).toMatchObject({ eventType: 'BATCH_UPLOAD' });
    await expect(batch.upload({ hostIds: [a], localPaths: [], remotePath: '/tmp' })).rejects.toThrow('请选择要上传的文件');
  });

  it('重启后还在执行的任务标记为失败', async () => {
    const a = addHost('h');
    db.prepare("INSERT INTO batch_job (id, kind, description, host_count, status, created_at) VALUES ('j1', 'exec', '', 1, 'running', 1)").run();
    db.prepare("INSERT INTO batch_job_host (job_id, host_id, host_name, status) VALUES ('j1', ?, 'h', 'running')").run(a);
    const again = new BatchService({ db, hosts, pool, sftp, approval, policy: () => DEFAULT_POLICY, audit, emit: () => undefined, owner: () => OWNER });
    const j = again.get('j1');
    expect(j.status).toBe('failed');
    expect(j.hosts![0]).toMatchObject({ status: 'failed', error: '应用退出，执行中断' });
  });
});

describe('第三十五轮：运维审计', () => {
  it('连接日志记下登录用户名，可以按主机 / 用户名筛选；命令记录关联到录像', () => {
    const store = new RecordingStore(db, dir, randomBytes(32));
    const r = store.start({ sessionId: 'sess-1', kind: 'ssh', hostId: 'h1', hostName: 'web-01', username: 'deploy', cols: 80, rows: 24 });
    r.output('hello');
    r.end();
    store.start({ sessionId: 'sess-2', kind: 'ssh', hostId: 'h2', hostName: 'db-01', username: 'root', cols: 80, rows: 24 }).end();
    expect(store.list({}).items.map((i) => i.username).sort()).toEqual(['deploy', 'root']);
    expect(store.list({ hostId: 'h1' }).items.map((i) => i.hostName)).toEqual(['web-01']);
    expect(store.list({ username: 'roo' }).items.map((i) => i.hostName)).toEqual(['db-01']);
    audit.command({ source: 'USER', hostId: 'h1', hostName: 'web-01', sessionId: 'sess-1', command: 'uptime', exitCode: 0 });
    const e = audit.list({ kind: 'COMMAND' }).items[0];
    expect(e.account).toBe('deploy');
    expect(e.recordingId).toBe(r.id);
  });
});
