import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcEventName, IpcEvents, PromptRequest, TransferState } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SftpService } from '../src/main/services/sftp/sftp-service';
import { TransferService } from '../src/main/services/sftp/transfer-service';
import { clipboardFiles, pathsFromText, type ClipboardItemLike } from '../src/main/util/clipboard-files';
import { fileKind, opensInEditor } from '../src/renderer/src/util/file-kind';
import { ownerOf, permsOf } from '../src/main/services/sftp/file-mode';
import { parseStat } from '../src/main/services/sftp/shell-remote';
import { formatKb, pushHistory, sanitizeCols } from '../src/renderer/src/store/file-prefs';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

const OWNER = 3;
let dir: string;
let remote: string;
let local: string;
let db: Db;
let hosts: HostRepo;
let broker: PromptBroker;
let pool: SshPool;
let sftp: SftpService;
let server: TestSshServer | undefined;
let events: { event: IpcEventName; payload: unknown }[];

function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
  events.push({ event, payload });
  if (event === 'prompt.request') setTimeout(() => broker.answer(owner, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true }), 1);
}
const final = (id: string): TransferState | undefined =>
  events
    .filter((e) => e.event === 'transfer.progress')
    .map((e) => e.payload as TransferState)
    .filter((s) => s.transferId === id)
    .at(-1);
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** SFTP 用真实路径（和 exec 看到的文件系统一致），测试服务器上执行的复制、权限、压缩 */
async function open(opts: { writeDelayMs?: number; noSftp?: boolean; gnuStat?: boolean } = {}): Promise<string> {
  server = await startTestSshServer({ root: remote, sftpRealPaths: true, ...opts });
  const hostId = hosts.create({
    folderId: null,
    name: 'r16',
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
  return (await sftp.open(OWNER, hostId)).sftpId;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-r16-'));
  remote = join(dir, 'remote');
  local = join(dir, 'local');
  mkdirSync(remote);
  mkdirSync(local);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ hosts } = createRepos(db, randomBytes(32)));
  events = [];
  broker = new PromptBroker(emit);
  pool = new SshPool(hosts, broker, 5000);
  sftp = new SftpService(pool);
});

afterEach(async () => {
  pool.closeAll();
  await server?.close();
  server = undefined;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('文件面板的服务器操作（第十六轮）', () => {
  it('新建文件、复制（重名自动改名）、移动、修改权限', async () => {
    const id = await open();
    mkdirSync(join(remote, 'src'));
    mkdirSync(join(remote, 'dst'));
    writeFileSync(join(remote, 'src', 'a.txt'), 'A');

    await sftp.createFile(OWNER, id, join(remote, 'src', 'new.conf'));
    expect(readFileSync(join(remote, 'src', 'new.conf'), 'utf8')).toBe('');
    await expect(sftp.createFile(OWNER, id, join(remote, 'src', 'a.txt'))).rejects.toThrow('已经有同名');

    const c1 = await sftp.copy(OWNER, id, [join(remote, 'src', 'a.txt')], join(remote, 'dst'));
    const c2 = await sftp.copy(OWNER, id, [join(remote, 'src', 'a.txt')], join(remote, 'dst'));
    expect(c1.copied[0]).toBe(join(remote, 'dst', 'a.txt'));
    expect(c2.copied[0]).toBe(join(remote, 'dst', 'a (1).txt'));
    expect(readFileSync(join(remote, 'dst', 'a (1).txt'), 'utf8')).toBe('A');
    await expect(sftp.copy(OWNER, id, [join(remote, 'src')], join(remote, 'src'))).rejects.toThrow('自己里面');

    await expect(sftp.move(OWNER, id, [join(remote, 'src', 'a.txt')], join(remote, 'dst'))).rejects.toThrow('已经有');
    const m = await sftp.move(OWNER, id, [join(remote, 'src', 'new.conf')], join(remote, 'dst'));
    expect(m.moved).toEqual([join(remote, 'dst', 'new.conf')]);
    expect(existsSync(join(remote, 'src', 'new.conf'))).toBe(false);

    await sftp.chmod(OWNER, id, [join(remote, 'dst', 'new.conf')], 0o750, false);
    expect(statSync(join(remote, 'dst', 'new.conf')).mode & 0o777).toBe(0o750);
    await sftp.chmod(OWNER, id, [join(remote, 'dst')], 0o700, true);
    expect(statSync(join(remote, 'dst', 'a.txt')).mode & 0o777).toBe(0o700);
  });

  it('压缩为 tar.gz（同名时改名），只能压缩同一个目录下的文件', async () => {
    const id = await open();
    mkdirSync(join(remote, 'app', 'logs'), { recursive: true });
    writeFileSync(join(remote, 'app', 'logs', 'x.log'), 'hello');
    writeFileSync(join(remote, 'app', 'run.sh'), 'echo');
    const r1 = await sftp.archive(OWNER, id, [join(remote, 'app', 'logs'), join(remote, 'app', 'run.sh')], 'bundle.tar.gz', 'tar.gz');
    expect(r1.path).toBe(join(remote, 'app', 'bundle.tar.gz'));
    const listing = execFileSync('tar', ['-tzf', r1.path], { encoding: 'utf8' });
    expect(listing).toContain('logs/x.log');
    expect(listing).toContain('run.sh');
    const r2 = await sftp.archive(OWNER, id, [join(remote, 'app', 'run.sh')], 'bundle', 'tar.gz');
    expect(r2.path).toBe(join(remote, 'app', 'bundle (1).tar.gz'));
    await expect(sftp.archive(OWNER, id, [join(remote, 'app', 'run.sh'), join(remote, 'app', 'logs', 'x.log')], 'x', 'tar.gz')).rejects.toThrow('同一个目录');
  });

  it('拖到本机：先下载到临时目录（目录保留结构）；超过上限时不下载', async () => {
    const id = await open();
    mkdirSync(join(remote, 'conf', 'd'), { recursive: true });
    writeFileSync(join(remote, 'conf', 'd', 'nginx.conf'), 'server {}');
    writeFileSync(join(remote, 'big.bin'), randomBytes(64 * 1024));
    const out = join(local, 'drag');
    mkdirSync(out);
    const r = await sftp.downloadForDrag(OWNER, id, [join(remote, 'conf'), join(remote, 'big.bin')], out, 1024 * 1024);
    expect(r).toEqual({ files: [join(out, 'conf'), join(out, 'big.bin')] });
    expect(readFileSync(join(out, 'conf', 'd', 'nginx.conf'), 'utf8')).toBe('server {}');
    expect(statSync(join(out, 'big.bin')).size).toBe(64 * 1024);
    const big = await sftp.downloadForDrag(OWNER, id, [join(remote, 'big.bin')], join(local, 'nope'), 1000);
    expect(big).toEqual({ tooLarge: true, total: 64 * 1024 });
    expect(existsSync(join(local, 'nope'))).toBe(false);
  });

  it('传输可以暂停，继续时从断点续传，内容完整', async () => {
    const id = await open({ writeDelayMs: 15 });
    const transfers = new TransferService(sftp, emit, { rateLimit: () => 0, concurrency: () => 3 });
    const data = randomBytes(3 * 1024 * 1024);
    writeFileSync(join(local, 'big.bin'), data);
    const [t] = transfers.start(OWNER, id, 'upload', [{ localPath: join(local, 'big.bin'), remotePath: join(remote, 'big.bin') }]);
    await waitFor(() => (final(t)?.transferred ?? 0) > 0);
    transfers.pause(OWNER, t);
    const paused = await waitFor(() => (final(t)?.status === 'paused' ? final(t) : null));
    expect(paused.transferred).toBeLessThan(data.length);
    expect(paused.localPath).toBe(join(local, 'big.bin'));
    transfers.resume(OWNER, t);
    await waitFor(() => final(t)?.status === 'done', 30_000);
    expect(readFileSync(join(remote, 'big.bin')).equals(data)).toBe(true);
    expect(final(t)?.finishedAt).toBeGreaterThan(0);
  });
});

describe('从剪贴板上传：读取访达 / 资源管理器复制的文件（第十六轮）', () => {
  it('解析 plist、file:// 地址和 Windows 的文件名', () => {
    expect(pathsFromText('<plist><array><string>/Users/a/x &amp; y.txt</string><string>/tmp/b</string></array></plist>', 'NSFilenamesPboardType')).toEqual(['/Users/a/x & y.txt', '/tmp/b']);
    expect(pathsFromText('copy\nfile:///home/u/a%20b.log\nfile:///etc/hosts', 'x-special/gnome-copied-files')).toEqual(['/home/u/a b.log', '/etc/hosts']);
    expect(pathsFromText('C:\\Users\\a\\report.xlsx\0garbage', 'FileNameW')).toEqual(['C:\\Users\\a\\report.xlsx']);
  });

  it('按平台读取剪贴板，只返回本机存在的文件', async () => {
    const f = join(dir, 'clip.txt');
    writeFileSync(f, 'x');
    const item: ClipboardItemLike = {
      types: ['text/plain', 'text/uri-list'],
      getType: async (t: string) => (t === 'text/uri-list' ? new Blob([`${pathToFileURL(f).href}\nfile:///definitely/not/here`]) : new Blob(['plain'])),
    };
    expect(await clipboardFiles({ read: async () => [item] }, 'linux')).toEqual([f]);
    expect(await clipboardFiles({ read: async () => { throw new Error('no clipboard'); } }, 'darwin')).toEqual([]);
  });
});

describe('文件类型图标和双击打开方式（第十六轮）', () => {
  const e = (name: string, type: 'file' | 'dir' | 'link' = 'file', size = 100, perms = '-rw-r--r--') => ({ name, type, size, perms });
  it('按扩展名和特殊文件名区分类型', () => {
    expect(fileKind(e('logs', 'dir'))).toBe('dir');
    expect(fileKind(e('app.jar'))).toBe('java');
    expect(fileKind(e('backup.tar.gz'))).toBe('archive');
    expect(fileKind(e('nginx.conf'))).toBe('config');
    expect(fileKind(e('Dockerfile'))).toBe('docker');
    expect(fileKind(e('app.log.2026-10-17'))).toBe('log');
    expect(fileKind(e('app.log.1.gz'))).toBe('archive');
    expect(fileKind(e('deploy.sh'))).toBe('script');
    expect(fileKind(e('photo.PNG'))).toBe('image');
    expect(fileKind(e('redis-server', 'file', 100, '-rwxr-xr-x'))).toBe('binary');
  });
  it('文本类、不超过 2MB 的用内置编辑器打开，其他用本机程序打开', () => {
    expect(opensInEditor(e('nginx.conf'))).toBe(true);
    expect(opensInEditor(e('Main.java'))).toBe(true);
    expect(opensInEditor(e('app.jar'))).toBe(false);
    expect(opensInEditor(e('photo.png'))).toBe(false);
    expect(opensInEditor(e('huge.log', 'file', 5 * 1024 * 1024))).toBe(false);
    expect(opensInEditor(e('logs', 'dir'))).toBe(false);
  });
});

describe('文件列表的所有者 / 组 / 权限列（第十六轮，参考 MobaXterm）', () => {
  it('SFTP 从 longname 取所有者和组，没有时用 uid / gid', () => {
    expect(ownerOf('-rw-r--r--    1 root     wheel        1234 Oct 17 14:03 app.log', { uid: 0, gid: 0 })).toEqual({ owner: 'root', group: 'wheel' });
    expect(ownerOf('drwxr-xr-x+   3 www-data www-data     4096 Oct 17 14:03 my dir', {})).toEqual({ owner: 'www-data', group: 'www-data' });
    expect(ownerOf('app.log', { uid: 1000, gid: 1001 })).toEqual({ owner: '1000', group: '1001' });
    expect(ownerOf(undefined, {})).toEqual({ owner: undefined, group: undefined });
  });

  it('权限显示 setuid / setgid / sticky 位', () => {
    expect(permsOf(0o040000 | 0o1777)).toBe('drwxrwxrwt');
    expect(permsOf(0o100000 | 0o4755)).toBe('-rwsr-xr-x');
    expect(permsOf(0o100000 | 0o2644)).toBe('-rw-r-Sr--');
    expect(permsOf(0o100644)).toBe('-rw-r--r--');
  });

  it('SSH 命令通道的 stat 输出带所有者和组', () => {
    expect(parseStat('81a4|12|1792234060|root|adm|./a|b.log')).toEqual({ stats: { mode: 0o100644, size: 12, mtime: 1792234060, owner: 'root', group: 'adm' }, name: './a|b.log' });
    expect(parseStat('garbage')).toBeNull();
  });

  it('列表里有所有者和组：SFTP（测试服务器只给 uid / gid）和 SSH 命令通道（用户名）', async () => {
    writeFileSync(join(remote, 'x.txt'), 'x');
    const id = await open();
    const [x] = (await sftp.list(OWNER, id, remote)).filter((e) => e.name === 'x.txt');
    expect(x.owner).toBe(String(process.getuid!()));
    expect(x.group).toBe(String(process.getgid!()));
    expect(x.perms).toBe('-rw-r--r--');
    pool.closeAll();
    await server?.close();
    const shellId = await open({ noSftp: true, gnuStat: true });
    const [y] = (await sftp.list(OWNER, shellId, remote)).filter((e) => e.name === 'x.txt');
    expect(y.owner).toBe(userInfo().username);
    expect(y.group).toBeTruthy();
  });
});

describe('大小按 KB、列宽设置、路径历史（第十六轮）', () => {
  it('大小按 KB 显示', () => {
    expect(formatKb(0)).toBe('0');
    expect(formatKb(1)).toBe('0.1');
    expect(formatKb(1536)).toBe('1.5');
    expect(formatKb(10 * 1024)).toBe('10');
    expect(formatKb(52_348_000)).toBe('51,121');
  });

  it('列设置：宽度限制在最小值以上，名称列不能隐藏，不认识的列丢掉', () => {
    expect(sanitizeCols({ widths: { name: 10, size: 120.4, bogus: 3 }, hidden: ['name', 'owner', 'bogus'] })).toEqual({ widths: { name: 80, size: 120 }, hidden: ['owner'] });
    expect(sanitizeCols(null)).toBeNull();
  });

  it('最近目录：新的在前、去重、最多 20 个', () => {
    expect(pushHistory(['/a', '/b'], '/b')).toEqual(['/b', '/a']);
    expect(pushHistory([], '')).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `/d${i}`).reduce<string[]>((l, p) => pushHistory(l, p), []);
    expect(many).toHaveLength(20);
    expect(many[0]).toBe('/d29');
  });
});
