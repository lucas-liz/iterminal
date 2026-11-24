import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcEventName, IpcEvents, PromptRequest, RemoteEditState, TransferState } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SftpService } from '../src/main/services/sftp/sftp-service';
import { RateLimiter, TransferService } from '../src/main/services/sftp/transfer-service';
import { RemoteEditService } from '../src/main/services/sftp/edit-service';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

const OWNER = 9;
let dir: string;
let remoteRoot: string;
let localRoot: string;
let db: Db;
let hosts: HostRepo;
let broker: PromptBroker;
let pool: SshPool;
let sftp: SftpService;
let server: TestSshServer;
let events: { event: IpcEventName; payload: unknown }[];
let rate = 0;

function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
  events.push({ event, payload });
  if (event === 'prompt.request') setTimeout(() => broker.answer(owner, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true }), 1);
}
const states = (): TransferState[] => events.filter((e) => e.event === 'transfer.progress').map((e) => e.payload as TransferState);
const final = (id: string): TransferState | undefined => states().filter((s) => s.transferId === id).at(-1);
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(opts: { writeDelayMs?: number } = {}): Promise<{ transfers: TransferService; sftpId: string }> {
  server = await startTestSshServer({ root: remoteRoot, ...opts });
  const hostId = hosts.create({
    folderId: null,
    name: 'files',
    address: '127.0.0.1',
    port: server.port,
    username: 'tester',
    authMethod: 'PASSWORD',
    password: 'pw',
    keepaliveSec: 0,
    startupScript: null,
    note: null,
    jumpHostIds: [],
  }).id;
  const transfers = new TransferService(sftp, emit, { rateLimit: () => rate, concurrency: () => 3 });
  const { sftpId } = await sftp.open(OWNER, hostId);
  return { transfers, sftpId };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-sftp3-'));
  remoteRoot = join(dir, 'remote');
  localRoot = join(dir, 'local');
  mkdirSync(remoteRoot);
  mkdirSync(localRoot);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ hosts } = createRepos(db, randomBytes(32)));
  events = [];
  rate = 0;
  broker = new PromptBroker(emit);
  pool = new SshPool(hosts, broker, 5000);
  sftp = new SftpService(pool);
});

afterEach(async () => {
  pool.closeAll();
  await server?.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SFTP 传输增强', () => {
  it('同一个会话最多同时进行 3 个传输，其余排队', async () => {
    const { transfers, sftpId } = await setup({ writeDelayMs: 5 });
    const items = Array.from({ length: 5 }, (_, i) => {
      writeFileSync(join(localRoot, `f${i}.bin`), randomBytes(200 * 1024));
      return { localPath: join(localRoot, `f${i}.bin`), remotePath: `/f${i}.bin` };
    });
    const ids = transfers.start(OWNER, sftpId, 'upload', items);
    let maxRunning = 0;
    await waitFor(() => {
      const running = ids.filter((id) => final(id)?.status === 'running').length;
      maxRunning = Math.max(maxRunning, running);
      return ids.every((id) => final(id)?.status === 'done');
    }, 20_000);
    expect(maxRunning).toBe(3);
    for (let i = 0; i < 5; i++) expect(readFileSync(join(remoteRoot, `f${i}.bin`)).equals(readFileSync(join(localRoot, `f${i}.bin`)))).toBe(true);
  });

  it('冲突策略：跳过、改名、覆盖', async () => {
    const { transfers, sftpId } = await setup();
    writeFileSync(join(localRoot, 'a.txt'), 'new');
    writeFileSync(join(remoteRoot, 'a.txt'), 'old');
    const [s] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'a.txt'), remotePath: '/a.txt', conflict: 'skip' }]);
    const skipped = await waitFor(() => final(s)?.status === 'done' && final(s));
    expect(skipped.skipped).toBe(1);
    expect(readFileSync(join(remoteRoot, 'a.txt'), 'utf8')).toBe('old');

    const [r1] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'a.txt'), remotePath: '/a.txt', conflict: 'rename' }]);
    await waitFor(() => final(r1)?.status === 'done');
    const [r2] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'a.txt'), remotePath: '/a.txt', conflict: 'rename' }]);
    await waitFor(() => final(r2)?.status === 'done');
    expect(readFileSync(join(remoteRoot, 'a (1).txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(remoteRoot, 'a (2).txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(remoteRoot, 'a.txt'), 'utf8')).toBe('old');

    // 下载时改名
    writeFileSync(join(localRoot, 'b.txt'), 'mine');
    writeFileSync(join(remoteRoot, 'b.txt'), 'theirs');
    const [d] = transfers.start(OWNER, sftpId, 'download', [{ localPath: join(localRoot, 'b.txt'), remotePath: '/b.txt', conflict: 'rename' }]);
    await waitFor(() => final(d)?.status === 'done');
    expect(readFileSync(join(localRoot, 'b (1).txt'), 'utf8')).toBe('theirs');
    expect(readFileSync(join(localRoot, 'b.txt'), 'utf8')).toBe('mine');

    const [o] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'a.txt'), remotePath: '/a.txt' }]);
    await waitFor(() => final(o)?.status === 'done');
    expect(readFileSync(join(remoteRoot, 'a.txt'), 'utf8')).toBe('new');
  });

  it('断点续传：上传和下载都从目标已有的大小继续；已经完整的直接跳过', async () => {
    const { transfers, sftpId } = await setup();
    const data = randomBytes(500 * 1024);
    writeFileSync(join(localRoot, 'big.bin'), data);
    // 远端已有前 200KB
    writeFileSync(join(remoteRoot, 'big.bin'), data.subarray(0, 200 * 1024));
    const [u] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'big.bin'), remotePath: '/big.bin', conflict: 'resume' }]);
    await waitFor(() => final(u)?.status === 'done');
    expect(readFileSync(join(remoteRoot, 'big.bin')).equals(data)).toBe(true);
    // 第一次进度就包含已有的 200KB
    const firstProgress = states().find((s) => s.transferId === u && s.transferred > 0)!;
    expect(firstProgress.transferred).toBeGreaterThanOrEqual(200 * 1024);

    writeFileSync(join(localRoot, 'down.bin'), data.subarray(0, 123_456));
    const [dl] = transfers.start(OWNER, sftpId, 'download', [{ localPath: join(localRoot, 'down.bin'), remotePath: '/big.bin', conflict: 'resume' }]);
    await waitFor(() => final(dl)?.status === 'done');
    expect(readFileSync(join(localRoot, 'down.bin')).equals(data)).toBe(true);

    const [again] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'big.bin'), remotePath: '/big.bin', conflict: 'resume' }]);
    const st = await waitFor(() => final(again)?.status === 'done' && final(again));
    expect(st.transferred).toBe(data.length);
  });

  it('限速：所有传输共用令牌桶', async () => {
    const { transfers, sftpId } = await setup();
    rate = 128 * 1024;
    writeFileSync(join(localRoot, 'slow.bin'), randomBytes(256 * 1024));
    const started = Date.now();
    const [t] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'slow.bin'), remotePath: '/slow.bin' }]);
    await waitFor(() => final(t)?.status === 'done', 15_000);
    // 256KB / 128KB/s ≈ 2 秒（桶里最初没有令牌）
    expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
    expect(states().some((s) => s.transferId === t && (s.speed ?? 0) > 0 && (s.speed ?? 0) < 400 * 1024)).toBe(true);
  });

  it('令牌桶：不限速时不等待；限速时按速率放行', async () => {
    let now = 0;
    const r = new RateLimiter(() => 1000, () => now);
    const p = r.take(500);
    let done = false;
    void p.then(() => (done = true));
    await new Promise((x) => setTimeout(x, 20));
    expect(done).toBe(false);
    now = 600;
    await new Promise((x) => setTimeout(x, 520));
    expect(done).toBe(true);
    await new RateLimiter(() => 0).take(10_000_000);
  });

  it('传输中断后自动重试，从已经写入的位置继续', async () => {
    const { transfers, sftpId } = await setup({ writeDelayMs: 3 });
    const data = randomBytes(2 * 1024 * 1024);
    writeFileSync(join(localRoot, 'r.bin'), data);
    const [t] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'r.bin'), remotePath: '/r.bin' }]);
    await waitFor(() => (final(t)?.transferred ?? 0) > 300 * 1024);
    // 模拟传输 channel 断开
    sftp.resetTransferChannel(OWNER, sftpId);
    const st = await waitFor(() => (final(t)?.status === 'done' || final(t)?.status === 'error') && final(t), 30_000);
    expect(st.status).toBe('done');
    expect(st.retries).toBeGreaterThanOrEqual(1);
    expect(readFileSync(join(remoteRoot, 'r.bin')).equals(data)).toBe(true);
  }, 60_000);
});

describe('在线编辑', () => {
  it('内置编辑器：读文本、写回；远端被别人改过时不写入', async () => {
    await setup();
    const { sftpId } = { sftpId: (await sftp.open(OWNER, hosts.list()[0].id)).sftpId };
    const edits = new RemoteEditService(sftp, emit, () => undefined, join(dir, 'edit-tmp'));
    writeFileSync(join(remoteRoot, 'app.conf'), 'port=80\n');
    const r = await edits.readText(OWNER, sftpId, '/app.conf');
    expect(r.content).toBe('port=80\n');
    const w = await edits.writeText(OWNER, sftpId, '/app.conf', 'port=8080\n', r.mtime);
    expect(w.ok).toBe(true);
    expect(readFileSync(join(remoteRoot, 'app.conf'), 'utf8')).toBe('port=8080\n');
    // 别人改了文件（修改时间变了）
    writeFileSync(join(remoteRoot, 'app.conf'), 'port=9090\n');
    utimesSync(join(remoteRoot, 'app.conf'), new Date(), new Date(Date.now() + 5000));
    const conflict = await edits.writeText(OWNER, sftpId, '/app.conf', 'port=1\n', w.mtime);
    expect(conflict.ok).toBe(false);
    expect(readFileSync(join(remoteRoot, 'app.conf'), 'utf8')).toBe('port=9090\n');
    expect((await edits.writeText(OWNER, sftpId, '/app.conf', 'port=1\n', null)).ok).toBe(true);
    writeFileSync(join(remoteRoot, 'bin.dat'), Buffer.from([1, 0, 2]));
    await expect(edits.readText(OWNER, sftpId, '/bin.dat')).rejects.toThrow('不是文本文件');
  });

  it('外部编辑器：保存后自动回传；远端被改过时进入冲突，可以覆盖或放弃；结束后删除临时文件', async () => {
    await setup();
    const { sftpId } = await sftp.open(OWNER, hosts.list()[0].id);
    const opened: string[] = [];
    const edits = new RemoteEditService(sftp, emit, (p) => void opened.push(p), join(dir, 'edit-tmp'));
    const editStates = (): RemoteEditState[] => events.filter((e) => e.event === 'sftp.edit').map((e) => e.payload as RemoteEditState);
    writeFileSync(join(remoteRoot, 'nginx.conf'), 'worker_processes 1;\n');
    const st = await edits.editExternal(OWNER, sftpId, '/nginx.conf');
    expect(opened).toEqual([st.localPath]);
    expect(readFileSync(st.localPath, 'utf8')).toBe('worker_processes 1;\n');

    writeFileSync(st.localPath, 'worker_processes 4;\n');
    await waitFor(() => editStates().some((e) => e.state === 'uploaded'));
    expect(readFileSync(join(remoteRoot, 'nginx.conf'), 'utf8')).toBe('worker_processes 4;\n');

    // 远端被别人改了，本机再保存 → 冲突
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(join(remoteRoot, 'nginx.conf'), 'worker_processes auto;\n# changed by ops\n');
    writeFileSync(st.localPath, 'worker_processes 8;\n');
    await waitFor(() => editStates().at(-1)?.state === 'conflict');
    expect(readFileSync(join(remoteRoot, 'nginx.conf'), 'utf8')).toContain('changed by ops');
    await edits.resolve(OWNER, st.editId, 'discard');
    expect(readFileSync(st.localPath, 'utf8')).toContain('changed by ops');

    writeFileSync(join(remoteRoot, 'nginx.conf'), 'other\n# again\n');
    writeFileSync(st.localPath, 'mine\n');
    await waitFor(() => editStates().at(-1)?.state === 'conflict');
    await edits.resolve(OWNER, st.editId, 'overwrite');
    expect(readFileSync(join(remoteRoot, 'nginx.conf'), 'utf8')).toBe('mine\n');

    // 同一个文件再次编辑只是重新打开
    const again = await edits.editExternal(OWNER, sftpId, '/nginx.conf');
    expect(again.editId).toBe(st.editId);
    expect(edits.list(OWNER, sftpId)).toHaveLength(1);
    edits.stopSftp(sftpId);
    await waitFor(() => !existsSync(st.localPath));
    expect(editStates().at(-1)?.state).toBe('stopped');
  });
});
