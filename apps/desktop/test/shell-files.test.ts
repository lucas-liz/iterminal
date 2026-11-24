import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileTransfer, HostInput, IpcEventName, IpcEvents, PromptAnswer, PromptRequest, TransferState } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SftpService } from '../src/main/services/sftp/sftp-service';
import { TransferService } from '../src/main/services/sftp/transfer-service';
import { RemoteEditService } from '../src/main/services/sftp/edit-service';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';
import { startTestFtpServer, type TestFtpServer } from './support/ftp-server';

const OWNER = 7;
let dir: string;
let remoteRoot: string;
let localRoot: string;
let db: Db;
let hosts: HostRepo;
let broker: PromptBroker;
let pool: SshPool;
let files: SftpService;
let ssh: TestSshServer | null;
let ftp: TestFtpServer;
let events: { event: IpcEventName; payload: unknown }[];
/** 询问密码时的回答（null = 取消） */
let typedPassword: string | null = 'pw';

function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
  events.push({ event, payload });
  if (event !== 'prompt.request') return;
  const req = payload as PromptRequest;
  const answer: PromptAnswer = req.kind === 'hostKey' ? { kind: 'hostKey', accept: true } : { kind: 'password', value: typedPassword, remember: false };
  setTimeout(() => broker.answer(owner, req.promptId, answer), 1);
}
const final = (id: string): TransferState | undefined =>
  events
    .filter((e) => e.event === 'transfer.progress')
    .map((e) => e.payload as TransferState)
    .filter((s) => s.transferId === id)
    .at(-1);
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function addHost(port: number, fileTransfer: FileTransfer | null, extra: Partial<HostInput> = {}): string {
  return hosts.create({
    folderId: null,
    name: 'ftp-box',
    address: '127.0.0.1',
    port,
    username: 'tester',
    authMethod: 'PASSWORD',
    password: 'pw',
    keepaliveSec: 0,
    startupScript: null,
    note: null,
    jumpHostIds: [],
    fileTransfer,
    ...extra,
  }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-ftp-'));
  remoteRoot = join(dir, 'remote');
  localRoot = join(dir, 'local');
  mkdirSync(remoteRoot);
  mkdirSync(localRoot);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ hosts } = createRepos(db, randomBytes(32)));
  events = [];
  typedPassword = 'pw';
  broker = new PromptBroker(emit);
  pool = new SshPool(hosts, broker, 5000);
  files = new SftpService(pool, { hosts, prompts: broker });
  ftp = await startTestFtpServer({ root: remoteRoot, user: 'tester', password: 'pw' });
  ssh = null;
});

afterEach(async () => {
  pool.closeAll();
  await ssh?.close();
  await ftp.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('文件传输：服务器没有 sftp-server 时用 SSH 命令通道', () => {
  it('自动模式：SFTP 打不开但终端能用 → 用 stat / cat 命令传文件，不再去连 FTP', async () => {
    ssh = await startTestSshServer({ root: remoteRoot, noSftp: true, gnuStat: true });
    const hostId = addHost(ssh.port, { mode: 'AUTO', ftpPort: ftp.port });
    writeFileSync(join(remoteRoot, 'readme.txt'), 'hello shell');
    writeFileSync(join(remoteRoot, "it's here.txt"), 'quoted');
    mkdirSync(join(remoteRoot, 'logs'));
    const r = await files.open(OWNER, hostId);
    expect(r.protocol).toBe('shell');
    expect(r.notice).toContain('已自动改用 SSH 命令通道');
    expect(ftp.commands).toHaveLength(0);
    expect(r.home).toBe(realpathSync(remoteRoot));

    const list = await files.list(OWNER, r.sftpId, r.home);
    expect(list.map((e) => [e.name, e.type])).toEqual([
      ['logs', 'dir'],
      ["it's here.txt", 'file'],
      ['readme.txt', 'file'],
    ]);
    expect(list.find((e) => e.name === 'readme.txt')).toMatchObject({ size: 11 });
    expect(list.find((e) => e.name === 'readme.txt')!.mtime).toBeGreaterThan(Date.now() - 600_000);

    const base = r.home;
    await files.mkdir(OWNER, r.sftpId, `${base}/logs/2026`);
    writeFileSync(join(remoteRoot, 'logs', '2026', 'a.log'), 'x');
    await files.rename(OWNER, r.sftpId, `${base}/readme.txt`, `${base}/README.md`);
    expect(existsSync(join(remoteRoot, 'README.md'))).toBe(true);
    await expect(files.rename(OWNER, r.sftpId, `${base}/README.md`, `${base}/logs`)).rejects.toThrow('目标已存在');
    await files.delete(OWNER, r.sftpId, [`${base}/logs`]);
    expect(existsSync(join(remoteRoot, 'logs'))).toBe(false);
    await expect(files.list(OWNER, r.sftpId, `${base}/nope`)).rejects.toThrow('没有这个文件或目录');
    files.close(OWNER, r.sftpId);
  });

  it('上传、下载、断点续传、冲突改名、在线编辑（保留权限）都走命令通道', async () => {
    ssh = await startTestSshServer({ root: remoteRoot, noSftp: true, gnuStat: true });
    const hostId = addHost(ssh.port, { mode: 'SHELL', ftpPort: 21 });
    const { sftpId, home, protocol } = await files.open(OWNER, hostId);
    expect(protocol).toBe('shell');
    const transfers = new TransferService(files, emit, { rateLimit: () => 0, concurrency: () => 3 });
    const data = randomBytes(300 * 1024);
    writeFileSync(join(localRoot, 'big.bin'), data);
    const [u] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'big.bin'), remotePath: `${home}/big.bin` }]);
    const up = await waitFor(() => ['done', 'error', 'canceled'].includes(final(u)?.status ?? '') && final(u));
    expect(up.status, up.message ?? '').toBe('done');
    expect(readFileSync(join(remoteRoot, 'big.bin')).equals(data)).toBe(true);

    writeFileSync(join(localRoot, 'down.bin'), data.subarray(0, 100 * 1024));
    const [d] = transfers.start(OWNER, sftpId, 'download', [{ localPath: join(localRoot, 'down.bin'), remotePath: `${home}/big.bin`, conflict: 'resume' }]);
    const dd = await waitFor(() => ['done', 'error', 'canceled'].includes(final(d)?.status ?? '') && final(d), 15_000);
    expect(dd.status, dd.message ?? '').toBe('done');
    expect(readFileSync(join(localRoot, 'down.bin')).equals(data)).toBe(true);
    expect(ssh.execs.some((c) => c.startsWith(`tail -c +${100 * 1024 + 1} `))).toBe(true);

    writeFileSync(join(remoteRoot, 'part.bin'), data.subarray(0, 50 * 1024));
    const [p] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'big.bin'), remotePath: `${home}/part.bin`, conflict: 'resume' }]);
    await waitFor(() => final(p)?.status === 'done');
    expect(readFileSync(join(remoteRoot, 'part.bin')).equals(data)).toBe(true);
    expect(ssh.execs.some((c) => c.startsWith('cat >> '))).toBe(true);

    writeFileSync(join(localRoot, 'a.txt'), 'new');
    writeFileSync(join(remoteRoot, 'a.txt'), 'old');
    const [rn] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'a.txt'), remotePath: `${home}/a.txt`, conflict: 'rename' }]);
    await waitFor(() => final(rn)?.status === 'done');
    expect(readFileSync(join(remoteRoot, 'a (1).txt'), 'utf8')).toBe('new');

    const edits = new RemoteEditService(files, emit, () => undefined, join(dir, 'edit-tmp'));
    writeFileSync(join(remoteRoot, 'run.sh'), 'echo 1\n', { mode: 0o750 });
    const txt = await edits.readText(OWNER, sftpId, `${home}/run.sh`);
    expect(txt.content).toBe('echo 1\n');
    expect((await edits.writeText(OWNER, sftpId, `${home}/run.sh`, 'echo 2\n', txt.mtime)).ok).toBe(true);
    expect(readFileSync(join(remoteRoot, 'run.sh'), 'utf8')).toBe('echo 2\n');
    expect(statSync(join(remoteRoot, 'run.sh')).mode & 0o777).toBe(0o750);
  });

  it('只用 SSH 命令时远端不支持（没有 stat -c）给出原因', async () => {
    ssh = await startTestSshServer({ root: remoteRoot, noSftp: true, gnuStat: process.platform !== 'darwin' ? true : false });
    if (process.platform !== 'darwin') return; // Linux 上自带 GNU stat，这个场景只在 macOS 的测试服务器上能模拟
    const hostId = addHost(ssh.port, { mode: 'SHELL', ftpPort: 21 });
    await expect(files.open(OWNER, hostId)).rejects.toThrow('服务器不支持 SSH 命令通道传输文件');
  });
});
