import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('文件传输：服务器没有 SFTP 时改用 FTP', () => {
  it('自动模式：SSH 能连上但没有 SFTP 子系统 → 用同样的用户名密码连 FTP（先试 TLS，不支持时用明文）', async () => {
    ssh = await startTestSshServer({ root: remoteRoot, noSftp: true });
    const hostId = addHost(ssh.port, { mode: 'AUTO', ftpPort: ftp.port });
    writeFileSync(join(remoteRoot, 'readme.txt'), 'hello ftp');
    mkdirSync(join(remoteRoot, 'logs'));
    const r = await files.open(OWNER, hostId);
    expect(r).toMatchObject({ protocol: 'ftp', home: '/' });
    expect(r.notice).toContain('已自动改用 FTP（明文传输）');
    expect(ftp.commands).toContain('AUTH TLS');
    expect(ftp.commands).toContain('USER tester');

    const list = await files.list(OWNER, r.sftpId, '/');
    expect(list.map((e) => [e.name, e.type])).toEqual([
      ['logs', 'dir'],
      ['readme.txt', 'file'],
    ]);
    expect(list.find((e) => e.name === 'readme.txt')).toMatchObject({ size: 9, perms: '-rwxr-xr-x' });

    // 新建目录、改名、删除（递归）
    await files.mkdir(OWNER, r.sftpId, '/logs/2026');
    writeFileSync(join(remoteRoot, 'logs', '2026', 'a.log'), 'x');
    await files.rename(OWNER, r.sftpId, '/readme.txt', '/README.md');
    expect(existsSync(join(remoteRoot, 'README.md'))).toBe(true);
    await expect(files.rename(OWNER, r.sftpId, '/README.md', '/logs')).rejects.toThrow('目标已存在');
    await files.delete(OWNER, r.sftpId, ['/logs']);
    expect(existsSync(join(remoteRoot, 'logs'))).toBe(false);
    files.close(OWNER, r.sftpId);
  });

  it('上传、下载、断点续传、冲突改名都走 FTP；在线编辑也能读写', async () => {
    ssh = await startTestSshServer({ root: remoteRoot, noSftp: true });
    const hostId = addHost(ssh.port, { mode: 'AUTO', ftpPort: ftp.port });
    const { sftpId } = await files.open(OWNER, hostId);
    const transfers = new TransferService(files, emit, { rateLimit: () => 0, concurrency: () => 3 });
    const data = randomBytes(300 * 1024);
    writeFileSync(join(localRoot, 'big.bin'), data);
    const [u] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'big.bin'), remotePath: '/big.bin' }]);
    // 等到结束（排队 / 传输中都不算）
    const up = await waitFor(() => ['done', 'error', 'canceled'].includes(final(u)?.status ?? '') && final(u));
    expect(up.status, up.message ?? '').toBe('done');
    expect(readFileSync(join(remoteRoot, 'big.bin')).equals(data)).toBe(true);

    // 下载续传：本地已有前 100KB（REST）
    writeFileSync(join(localRoot, 'down.bin'), data.subarray(0, 100 * 1024));
    const [d] = transfers.start(OWNER, sftpId, 'download', [{ localPath: join(localRoot, 'down.bin'), remotePath: '/big.bin', conflict: 'resume' }]);
    await waitFor(() => final(d)?.status === 'done');
    expect(readFileSync(join(localRoot, 'down.bin')).equals(data)).toBe(true);
    expect(ftp.commands).toContain(`REST ${100 * 1024}`);

    // 上传续传：远端已有前 50KB（APPE）
    writeFileSync(join(remoteRoot, 'part.bin'), data.subarray(0, 50 * 1024));
    const [p] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'big.bin'), remotePath: '/part.bin', conflict: 'resume' }]);
    await waitFor(() => final(p)?.status === 'done');
    expect(readFileSync(join(remoteRoot, 'part.bin')).equals(data)).toBe(true);
    expect(ftp.commands.some((c) => c.startsWith('APPE '))).toBe(true);

    // 冲突改名
    writeFileSync(join(localRoot, 'a.txt'), 'new');
    writeFileSync(join(remoteRoot, 'a.txt'), 'old');
    const [rn] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'a.txt'), remotePath: '/a.txt', conflict: 'rename' }]);
    await waitFor(() => final(rn)?.status === 'done');
    expect(readFileSync(join(remoteRoot, 'a (1).txt'), 'utf8')).toBe('new');
    expect(readFileSync(join(remoteRoot, 'a.txt'), 'utf8')).toBe('old');

    const edits = new RemoteEditService(files, emit, () => undefined, join(dir, 'edit-tmp'));
    writeFileSync(join(remoteRoot, 'app.conf'), 'port=80\n');
    const txt = await edits.readText(OWNER, sftpId, '/app.conf');
    expect(txt.content).toBe('port=80\n');
    expect((await edits.writeText(OWNER, sftpId, '/app.conf', 'port=8080\n', null)).ok).toBe(true);
    expect(readFileSync(join(remoteRoot, 'app.conf'), 'utf8')).toBe('port=8080\n');
  });

  it('指定 FTP：不连 SSH；主机用密钥认证时询问 FTP 密码；密码错误给出中文原因', async () => {
    // 没有 SSH 服务器：端口随便填，只连 FTP
    const keyHost = addHost(1, { mode: 'FTP', ftpPort: ftp.port }, { authMethod: 'PASSWORD', password: undefined });
    const r = await files.open(OWNER, keyHost);
    expect(r.protocol).toBe('ftp');
    expect(r.notice).toBeUndefined();
    expect(ftp.commands).not.toContain('AUTH TLS');
    const asked = events.filter((e) => e.event === 'prompt.request').map((e) => e.payload as PromptRequest);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'password', username: 'tester' });

    typedPassword = 'wrong';
    await expect(files.open(OWNER, keyHost)).rejects.toThrow('FTP 登录失败：用户名或密码不正确');
    typedPassword = null;
    await expect(files.open(OWNER, keyHost)).rejects.toThrow('已取消');
  });

  it('只用 SFTP 时不改用 FTP；经跳板机的主机不支持 FTP', async () => {
    ssh = await startTestSshServer({ root: remoteRoot, noSftp: true });
    const sftpOnly = addHost(ssh.port, { mode: 'SFTP', ftpPort: ftp.port });
    await expect(files.open(OWNER, sftpOnly)).rejects.toThrow('可以在主机设置里把文件传输方式改成');
    expect(ftp.commands).toHaveLength(0);
    const jump = addHost(ssh.port, null);
    const viaJump = addHost(ssh.port, { mode: 'FTP', ftpPort: ftp.port }, { jumpHostIds: [jump] });
    await expect(files.open(OWNER, viaJump)).rejects.toThrow('经跳板机或代理连接的主机不支持 FTP');
    // 自动、默认端口时不保存配置
    expect(hosts.get(jump)?.fileTransfer).toBeNull();
    expect(hosts.get(sftpOnly)?.fileTransfer).toEqual({ mode: 'SFTP', ftpPort: ftp.port });
  });
});
