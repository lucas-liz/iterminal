import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { generateEd25519 } from './support/keys';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostInput, IpcEventName, IpcEvents, PromptAnswer, PromptRequest, TransferState } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { createRepos } from './support/repos';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SessionManager } from '../src/main/services/connection/session-manager';
import { SftpService } from '../src/main/services/sftp/sftp-service';
import { TransferService } from '../src/main/services/sftp/transfer-service';
import { MonitorService } from '../src/main/services/monitor/monitor-service';
import { spawn } from 'node:child_process';
import type { MetricsSnapshot } from '@itm/protocol';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

const OWNER = 7;
type Responder = (req: PromptRequest) => PromptAnswer;
const acceptHostKey: Responder = () => ({ kind: 'hostKey', accept: true });

let dir: string;
let remoteRoot: string;
let localRoot: string;
let db: Db;
let hosts: HostRepo;
let broker: PromptBroker;
let pool: SshPool;
let sessions: SessionManager;
let sftp: SftpService;
let transfers: TransferService;
let server: TestSshServer;
let events: { event: IpcEventName; payload: unknown }[];
let responders: Responder[];
let prompts: PromptRequest[];

function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
  expect(owner).toBe(OWNER);
  events.push({ event, payload });
  if (event === 'prompt.request') {
    const req = payload as PromptRequest;
    prompts.push(req);
    const responder = responders.shift() ?? acceptHostKey;
    setTimeout(() => broker.answer(owner, req.promptId, responder(req)), 1);
  }
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) {
      return v;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('等待超时');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function output(sessionId: string): string {
  return events
    .filter((e) => e.event === 'session.data' && (e.payload as { sessionId: string }).sessionId === sessionId)
    .map((e) => (e.payload as { data: string }).data)
    .join('');
}

function statusOf(sessionId: string): { status: string; message?: string } | undefined {
  return events
    .filter((e) => e.event === 'session.status' && (e.payload as { sessionId: string }).sessionId === sessionId)
    .map((e) => e.payload as { status: string; message?: string })
    .at(-1);
}

function addHost(over: Partial<HostInput> = {}): string {
  return hosts.create({
    folderId: null,
    name: 'test',
    address: '127.0.0.1',
    port: server.port,
    username: 'tester',
    authMethod: 'PASSWORD',
    password: 'pw',
    keepaliveSec: 0,
    startupScript: null,
    note: null,
    jumpHostIds: [],
    ...over,
  }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-conn-'));
  remoteRoot = join(dir, 'remote');
  localRoot = join(dir, 'local');
  mkdirSync(remoteRoot);
  mkdirSync(localRoot);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ hosts } = createRepos(db, randomBytes(32)));
  events = [];
  responders = [];
  prompts = [];
  broker = new PromptBroker(emit);
  pool = new SshPool(hosts, broker, 5000);
  sessions = new SessionManager(pool, hosts, emit, (file, args, o) => pty.spawn(file, args, { name: 'xterm-256color', ...o }));
  sftp = new SftpService(pool);
  transfers = new TransferService(sftp, emit);
  server = await startTestSshServer({ root: remoteRoot });
});

afterEach(async () => {
  pool.closeAll();
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('主机指纹', () => {
  it('首次连接询问指纹，接受后记住，再次连接不再询问', async () => {
    const id = addHost();
    const c1 = await pool.acquire(id, OWNER);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ kind: 'hostKey', keyType: 'ssh-ed25519', previousFingerprint: null });
    pool.release(c1);
    const c2 = await pool.acquire(id, OWNER);
    expect(prompts).toHaveLength(1);
    pool.release(c2);
  });

  it('指纹变化时带上旧指纹告警，拒绝则中止连接', async () => {
    const id = addHost();
    hosts.saveFingerprint('127.0.0.1', server.port, 'ssh-ed25519', 'SHA256:old');
    responders.push(() => ({ kind: 'hostKey', accept: false }));
    await expect(pool.acquire(id, OWNER)).rejects.toThrow('已拒绝「test」的主机指纹');
    expect(prompts[0]).toMatchObject({ kind: 'hostKey', previousFingerprint: 'SHA256:old' });
  });
});

describe('认证', () => {
  it('交互式认证：询问密码，勾选记住后改为保存密码', async () => {
    const id = addHost({ authMethod: 'INTERACTIVE', password: undefined });
    responders.push(acceptHostKey, () => ({ kind: 'password', value: 'pw', remember: true }));
    const c = await pool.acquire(id, OWNER);
    pool.release(c);
    expect(prompts.map((p) => p.kind)).toEqual(['hostKey', 'password']);
    expect(hosts.require(id)).toMatchObject({ authMethod: 'PASSWORD', hasPassword: true });
  });

  it('保存的密码错误时提示重新输入', async () => {
    const id = addHost({ password: 'wrong' });
    responders.push(acceptHostKey, () => ({ kind: 'password', value: 'pw', remember: false }));
    const c = await pool.acquire(id, OWNER);
    pool.release(c);
    expect(prompts[1]).toMatchObject({ kind: 'password', message: '认证失败，请重新输入密码' });
    expect(hosts.connectInfo(id).auth.password).toBe('wrong'); // 没勾选记住，不覆盖
  });

  it('取消密码输入则连接失败', async () => {
    const id = addHost({ authMethod: 'INTERACTIVE', password: undefined });
    responders.push(acceptHostKey, () => ({ kind: 'password', value: null, remember: false }));
    await expect(pool.acquire(id, OWNER)).rejects.toThrow('已取消连接');
  });

  it('私钥认证（加密私钥连接时询问口令）', async () => {
    const keys = generateEd25519({ passphrase: 'pp', cipher: 'aes256-ctr', rounds: 16 });
    await server.close();
    server = await startTestSshServer({ root: remoteRoot, authorizedPublicKey: keys.public });
    const id = addHost({ authMethod: 'KEY', password: undefined, privateKey: keys.private });
    responders.push(() => ({ kind: 'password', value: 'pp', remember: true }), acceptHostKey);
    const c = await pool.acquire(id, OWNER);
    pool.release(c);
    expect(prompts[0]).toMatchObject({ kind: 'password', forPassphrase: true });
    expect(hosts.connectInfo(id).auth.passphrase).toBe('pp');
  });

  it('连接失败给出中文原因', async () => {
    const id = addHost({ port: 1 });
    await expect(pool.acquire(id, OWNER)).rejects.toThrow('连接被拒绝');
  });
});

describe('跳板机', () => {
  it('经两级跳板连接目标：每一跳各自确认指纹，第一跳复用连接池', async () => {
    const jump1 = await startTestSshServer({ root: remoteRoot, allowForward: true });
    const jump2 = await startTestSshServer({ root: remoteRoot, allowForward: true });
    try {
      const j1 = addHost({ name: 'j1', port: jump1.port });
      const j2 = addHost({ name: 'j2', port: jump2.port });
      const target = addHost({ name: 'target', jumpHostIds: [j1, j2] });
      const sid = sessions.openSsh(OWNER, target, 80, 24);
      await waitFor(() => output(sid).includes('welcome'));
      expect(prompts.filter((p) => p.kind === 'hostKey').map((p) => (p as { hostName: string }).hostName)).toEqual(['j1', 'j2', 'target']);
      expect(jump1.forwards).toEqual([`127.0.0.1:${jump2.port}`]);
      expect(jump2.forwards).toEqual([`127.0.0.1:${server.port}`]);
      expect(server.connections).toBe(1);

      // 同时打开跳板机自己的终端：复用已经建立的第一跳连接
      const sj = sessions.openSsh(OWNER, j1, 80, 24);
      await waitFor(() => output(sj).includes('welcome'));
      expect(jump1.connections).toBe(1);

      // 关掉目标会话后，专用的中间跳断开
      sessions.close(OWNER, sid);
      await waitFor(() => statusOf(sid)?.status === 'closed');
    } finally {
      await jump1.close();
      await jump2.close();
    }
  });

  it('目标重启后跳板通道只收到 EOF、没有 close：旧会话报断开，新连接不复用死连接', async () => {
    const jump = await startTestSshServer({ root: remoteRoot, allowForward: true, stallForwardClose: true });
    try {
      const j = addHost({ name: '堡垒机', port: jump.port });
      const target = addHost({ name: 'target', jumpHostIds: [j] });
      const s1 = sessions.openSsh(OWNER, target, 80, 24);
      await waitFor(() => output(s1).includes('welcome'));
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown): void => void unhandled.push(e);
      process.on('unhandledRejection', onUnhandled);
      try {
        jump.dropForwards();
        // 旧会话：底层连接已经不可用，要报断开而不是一直挂着
        await waitFor(() => statusOf(s1)?.status === 'error' || statusOf(s1)?.status === 'closed');
        // 新会话：建立新连接（不复用死连接），能正常进入终端
        const s2 = sessions.openSsh(OWNER, target, 80, 24);
        await waitFor(() => output(s2).includes('welcome'));
        expect(server.connections).toBe(2);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    } finally {
      await jump.close();
    }
  });

  it('连接池里的连接已不可写时 acquire 重新建立连接', async () => {
    const id = addHost();
    const c1 = await pool.acquire(id, OWNER);
    // 模拟底层 socket 已经结束但还没发出 close（ssh2 此时调用 shell / exec 会抛 Not connected）
    (c1.client as unknown as { _sock: { end(): void } })._sock.end();
    const c2 = await pool.acquire(id, OWNER);
    expect(c2).not.toBe(c1);
    expect(server.connections).toBe(2);
    pool.release(c2);
    pool.release(c1);
  });

  it('跳板机无法转发时给出是哪一跳出了问题', async () => {
    const jump = await startTestSshServer({ root: remoteRoot, allowForward: false });
    try {
      const j = addHost({ name: '堡垒机', port: jump.port });
      const target = addHost({ name: 'target', jumpHostIds: [j] });
      await expect(pool.acquire(target, OWNER)).rejects.toThrow('跳板机「堡垒机」无法连接到');
    } finally {
      await jump.close();
    }
  });

  it('测试连接：返回耗时、系统信息和经过的跳板，且不进入连接池', async () => {
    const jump = await startTestSshServer({ root: remoteRoot, allowForward: true });
    try {
      const j = addHost({ name: '堡垒机', port: jump.port });
      const input = {
        folderId: null, name: '新主机', address: '127.0.0.1', port: server.port, username: 'tester',
        authMethod: 'PASSWORD' as const, password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [j],
      };
      const r = await pool.test(hosts.testTarget(null, input), OWNER);
      expect(r.via).toEqual(['堡垒机']);
      expect(r.latencyMs).toBeGreaterThanOrEqual(0);
      // 密码错误：直接报认证失败，不弹窗
      const before = prompts.length;
      await expect(pool.test(hosts.testTarget(null, { ...input, password: 'bad' }), OWNER)).rejects.toThrow('认证失败');
      expect(prompts.length).toBe(before);
    } finally {
      await jump.close();
    }
  });
});

describe('终端会话', () => {
  it('SSH：收到欢迎语、输入回显、调整窗口大小、关闭', async () => {
    const id = addHost();
    const sid = sessions.openSsh(OWNER, id, 100, 30);
    await waitFor(() => statusOf(sid)?.status === 'ready');
    await waitFor(() => output(sid).includes('welcome to test server'));
    sessions.write(OWNER, sid, 'hello\r');
    await waitFor(() => output(sid).includes('echo:hello'));
    sessions.resize(OWNER, sid, 120, 40);
    await new Promise((r) => setTimeout(r, 50));
    sessions.write(OWNER, sid, 'size\r');
    await waitFor(() => output(sid).includes('120x40'));
    expect(hosts.require(id).lastConnectedAt).not.toBeNull();
    sessions.close(OWNER, sid);
    await waitFor(() => statusOf(sid)?.status === 'closed');
  });

  it('同一台主机的多个终端复用一条 SSH 连接', async () => {
    const id = addHost();
    const a = sessions.openSsh(OWNER, id, 80, 24);
    const b = sessions.openSsh(OWNER, id, 80, 24);
    await waitFor(() => output(a).includes('welcome') && output(b).includes('welcome'));
    expect(server.connections).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  it('远端退出后状态为已断开', async () => {
    const id = addHost();
    const sid = sessions.openSsh(OWNER, id, 80, 24);
    await waitFor(() => output(sid).includes('welcome'));
    sessions.write(OWNER, sid, 'exit\r');
    const st = await waitFor(() => statusOf(sid)?.status === 'closed' && statusOf(sid));
    expect(st.message).toBe('连接已断开');
  });

  it('其他窗口不能操作不属于自己的会话', async () => {
    const id = addHost();
    const sid = sessions.openSsh(OWNER, id, 80, 24);
    await waitFor(() => output(sid).includes('welcome'));
    sessions.write(OWNER + 1, sid, 'hijack\r');
    sessions.write(OWNER, sid, 'mine\r');
    await waitFor(() => output(sid).includes('echo:mine'));
    expect(output(sid)).not.toContain('hijack');
  });

  it('本地 Shell（node-pty）', async () => {
    const shell = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    try {
      const sid = sessions.openLocal(OWNER, 80, 24);
      sessions.write(OWNER, sid, 'echo itm-$((40+2))\r');
      await waitFor(() => output(sid).includes('itm-42'));
      sessions.close(OWNER, sid);
      await waitFor(() => statusOf(sid)?.status === 'closed');
    } finally {
      process.env.SHELL = shell;
    }
  });
});

describe('监控', () => {
  /** 模拟远端：先报告两个 shell 的目录，0.3 秒后第二个 shell 切换了目录 */
  const cannedScript = (pids: [number, number]) => `
block() {
  echo '@@BEGIN'
  echo '@host web-01 5.15.0'
  echo '@stat'; echo "cpu  $1 0 0 1000 0 0 0 0"
  echo '@cores 2'
  echo '@mem'; echo 'MemTotal: 2048 kB'; echo 'MemAvailable: 1024 kB'
  echo '@load 0.50 0.40 0.30'
  echo '@uptime 3600.00 7000.00'
  echo '@shells'; echo "${pids[0]} pts/0 /root"; echo "${pids[1]} pts/1 $2"
  echo '@@END'
}
block 100 /tmp
sleep 0.3
block 150 /var/log
sleep 30
`;

  it('推送快照，并把每个终端会话对应到远端 shell、跟随目录变化', async () => {
    const monitor = new MonitorService(pool, emit, sessions, Date.now, cannedScript([4001, 4002]));
    const id = addHost();
    const a = sessions.openSsh(OWNER, id, 80, 24);
    const b = sessions.openSsh(OWNER, id, 80, 24);
    await waitFor(() => output(a).includes('welcome') && output(b).includes('welcome'));
    monitor.subscribe(OWNER, id);
    const cwdOf = (sid: string) =>
      events
        .filter((e) => e.event === 'session.cwd' && (e.payload as { sessionId: string }).sessionId === sid)
        .map((e) => (e.payload as { cwd: string }).cwd);
    await waitFor(() => cwdOf(b).includes('/var/log'));
    expect(cwdOf(a)).toEqual(['/root']);
    expect(cwdOf(b)).toEqual(['/tmp', '/var/log']);
    const snaps = events.filter((e) => e.event === 'monitor.update').map((e) => e.payload as MetricsSnapshot);
    const last = snaps.at(-1)!;
    expect(last.state).toBe('ok');
    if (last.state === 'ok') {
      expect(last.cpu?.usage).toBeGreaterThan(0);
      expect(last.hostname).toBe('web-01');
    }
    expect(monitor.latest(id)).toEqual(last);
    // 采集复用终端的连接，没有新建 TCP 连接
    expect(server.connections).toBe(1);
    monitor.unsubscribe(OWNER, id);
    expect(monitor.latest(id)).toBeNull();
  });

  it('真实采集脚本：非 Linux 主机报告不支持', async () => {
    const monitor = new MonitorService(pool, emit, sessions);
    const id = addHost();
    monitor.subscribe(OWNER, id);
    const snap = await waitFor(() => monitor.latest(id));
    if (process.platform === 'linux') {
      expect(snap.state).toBe('ok');
    } else {
      expect(snap).toMatchObject({ state: 'unsupported' });
      expect((snap as { message: string }).message).toContain('只支持 Linux');
    }
    monitor.stopAll();
  });

  it('结束远端进程；失败时带上远端的错误信息', async () => {
    const monitor = new MonitorService(pool, emit, sessions);
    const id = addHost();
    const child = spawn('sleep', ['30']);
    const exited = new Promise((r) => child.on('exit', r));
    await monitor.kill(OWNER, id, child.pid!, 'TERM');
    await exited;
    await expect(monitor.kill(OWNER, id, 99999999, 'TERM')).rejects.toThrow('结束进程失败');
    await expect(monitor.kill(OWNER, id, 1, 'KILL')).rejects.toThrow('进程号不合法');
  });
});

describe('SFTP', () => {
  function transferStates(): TransferState[] {
    return events.filter((e) => e.event === 'transfer.progress').map((e) => e.payload as TransferState);
  }
  function finalState(id: string): TransferState | undefined {
    return transferStates()
      .filter((s) => s.transferId === id)
      .at(-1);
  }

  it('浏览、新建目录、重命名、递归删除', async () => {
    mkdirSync(join(remoteRoot, 'etc'));
    writeFileSync(join(remoteRoot, 'etc', 'hosts'), '127.0.0.1 localhost\n');
    const id = addHost();
    const { sftpId, home } = await sftp.open(OWNER, id);
    expect(home).toBe('/');
    await sftp.mkdir(OWNER, sftpId, '/data');
    const list = await sftp.list(OWNER, sftpId, '/');
    expect(list.map((e) => [e.name, e.type])).toEqual([
      ['data', 'dir'],
      ['etc', 'dir'],
    ]);
    const etc = await sftp.list(OWNER, sftpId, '/etc');
    expect(etc[0]).toMatchObject({ name: 'hosts', type: 'file', size: 20, path: '/etc/hosts' });
    expect(etc[0].perms).toMatch(/^-rw/);

    await sftp.rename(OWNER, sftpId, '/etc/hosts', '/etc/hosts.bak');
    await expect(sftp.rename(OWNER, sftpId, '/etc/hosts.bak', '/etc')).rejects.toThrow('目标已存在');
    await sftp.delete(OWNER, sftpId, ['/etc']);
    expect(existsSync(join(remoteRoot, 'etc'))).toBe(false);
    await expect(sftp.delete(OWNER, sftpId, ['/'])).rejects.toThrow('根目录');
    await expect(sftp.list(OWNER, sftpId, 'relative')).rejects.toThrow('绝对路径');
    sftp.close(OWNER, sftpId);
  });

  it('上传和下载目录（递归），进度到 100%', async () => {
    const src = join(localRoot, 'site');
    mkdirSync(join(src, 'css'), { recursive: true });
    writeFileSync(join(src, 'index.html'), '<h1>hi</h1>');
    const big = randomBytes(300 * 1024);
    writeFileSync(join(src, 'css', 'app.bin'), big);

    const id = addHost();
    const { sftpId } = await sftp.open(OWNER, id);
    const [up] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: src, remotePath: '/site' }]);
    const upDone = await waitFor(() => finalState(up)?.status === 'done' && finalState(up));
    expect(upDone.transferred).toBe(upDone.total);
    expect(upDone.total).toBe(big.length + 11);
    expect(readFileSync(join(remoteRoot, 'site', 'css', 'app.bin')).equals(big)).toBe(true);

    const [down] = transfers.start(OWNER, sftpId, 'download', [{ localPath: join(localRoot, 'copy'), remotePath: '/site' }]);
    await waitFor(() => finalState(down)?.status === 'done');
    expect(readFileSync(join(localRoot, 'copy', 'index.html'), 'utf8')).toBe('<h1>hi</h1>');
    expect(readFileSync(join(localRoot, 'copy', 'css', 'app.bin')).equals(big)).toBe(true);
  });

  it('取消上传：状态为已取消，远端半截文件被清理，之后还能继续传输', async () => {
    await server.close();
    server = await startTestSshServer({ root: remoteRoot, writeDelayMs: 20 });
    writeFileSync(join(localRoot, 'big.bin'), randomBytes(8 * 1024 * 1024));
    writeFileSync(join(localRoot, 'small.txt'), 'ok');
    const id = addHost();
    const { sftpId } = await sftp.open(OWNER, id);
    const [t] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'big.bin'), remotePath: '/big.bin' }]);
    await waitFor(() => (finalState(t)?.transferred ?? 0) > 0);
    transfers.cancel(OWNER, t);
    await waitFor(() => finalState(t)?.status === 'canceled');
    await waitFor(() => !existsSync(join(remoteRoot, 'big.bin')));

    const [t2] = transfers.start(OWNER, sftpId, 'upload', [{ localPath: join(localRoot, 'small.txt'), remotePath: '/small.txt' }]);
    await waitFor(() => finalState(t2)?.status === 'done', 10_000);
    expect(readFileSync(join(remoteRoot, 'small.txt'), 'utf8')).toBe('ok');
  });

  it('远端不存在的文件：传输失败并给出原因', async () => {
    const id = addHost();
    const { sftpId } = await sftp.open(OWNER, id);
    const [t] = transfers.start(OWNER, sftpId, 'download', [{ localPath: join(localRoot, 'x'), remotePath: '/nope' }]);
    const st = await waitFor(() => finalState(t)?.status === 'error' && finalState(t));
    expect(st.message).toBe('文件或目录不存在');
  });
});

describe('连接日志与进度（文档一 6.15.2 / 6.15.3）', () => {
  it('测试连接返回逐步的日志：TCP → 握手 → 指纹 → 认证 → 系统信息', async () => {
    const { ConnTrace } = await import('../src/main/services/connection/conn-trace');
    const id = addHost();
    const trace = new ConnTrace();
    const r = await pool.test(hosts.connectInfo(id), OWNER, trace);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    const lines = trace.entries.map((e) => `${e.step}|${e.level}|${e.tag}|${e.text}`);
    expect(lines[0]).toMatch(/^connect\|info\|连接\|连接到 127\.0\.0\.1:\d+/);
    expect(lines.some((l) => /^connect\|success\|TCP\|Socket 连接成功/.test(l))).toBe(true);
    expect(lines.some((l) => /指纹\|首次连接，等待确认主机指纹：ssh-ed25519 SHA256:/.test(l))).toBe(true);
    expect(lines.some((l) => /^auth\|info\|认证\|尝试密码认证（用户 tester）/.test(l))).toBe(true);
    expect(lines.some((l) => /^auth\|success\|认证\|认证成功/.test(l))).toBe(true);
    expect(trace.steps).toEqual({ connect: 'done', auth: 'done', channel: 'done', ready: 'done' });
  });

  it('连接被拒绝时按设置自动重试，日志里有每次尝试', async () => {
    const { ConnTrace } = await import('../src/main/services/connection/conn-trace');
    const retrying = new SshPool(hosts, broker, 5000, () => undefined, () => ({ timeoutMs: 2000, retries: 2 }));
    const id = addHost({ port: 1 });
    const trace = new ConnTrace();
    const started = Date.now();
    await expect(retrying.acquire(id, OWNER, [], trace)).rejects.toThrow('连接被拒绝');
    expect(Date.now() - started).toBeGreaterThanOrEqual(1100); // 400ms + 800ms
    const tcp = trace.entries.filter((e) => e.tag === 'TCP').map((e) => e.text);
    expect(tcp).toEqual([expect.stringContaining('尝试 1/3'), expect.stringContaining('尝试 2/3'), expect.stringContaining('尝试 3/3')]);
    expect(trace.entries.filter((e) => e.tag === '重试').map((e) => e.text)).toEqual([expect.stringContaining('400ms 后重试（2/3）'), expect.stringContaining('800ms 后重试（3/3）')]);
    expect(trace.steps.connect).toBe('error');
    retrying.closeAll();
  });

  it('端口不是 SSH 服务：握手超时，可以重试', async () => {
    const net = await import('node:net');
    const silent = net.createServer(() => undefined); // 接受连接但什么都不说
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const port = (silent.address() as { port: number }).port;
    const { ConnTrace } = await import('../src/main/services/connection/conn-trace');
    const p = new SshPool(hosts, broker, 5000, () => undefined, () => ({ timeoutMs: 300, retries: 1 }));
    const trace = new ConnTrace();
    await expect(p.acquire(addHost({ port }), OWNER, [], trace)).rejects.toThrow(/SSH 握手超时.*请确认端口运行的是 SSH 服务/);
    expect(trace.entries.filter((e) => e.tag === 'TCP' && e.level === 'success')).toHaveLength(2);
    expect(trace.entries.some((e) => e.tag === '重试')).toBe(true);
    p.closeAll();
    silent.close();
  });

  it('打开终端时推送进度事件；连接中关闭标签就是取消连接', async () => {
    const id = addHost();
    const sid = sessions.openSsh(OWNER, id, 80, 24);
    await waitFor(() => statusOf(sid)?.status === 'ready');
    const progress = events.filter((e) => e.event === 'session.progress').map((e) => e.payload as IpcEvents['session.progress']);
    expect(progress.at(-1)).toMatchObject({ state: 'ready', steps: { connect: 'done', auth: 'done', channel: 'done', ready: 'done' } });
    const texts = progress.flatMap((p) => p.entries.map((e) => e.text));
    expect(texts).toContain('终端通道已打开');
    expect(texts).toContain('连接就绪');
    sessions.close(OWNER, sid);

    // 握手阶段等待指纹确认时取消
    const silentNet = await import('node:net');
    const silent = silentNet.createServer(() => undefined);
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const id2 = addHost({ name: 'slow', port: (silent.address() as { port: number }).port });
    const sid2 = sessions.openSsh(OWNER, id2, 80, 24);
    await waitFor(() => events.some((e) => e.event === 'session.progress' && (e.payload as { sessionId: string }).sessionId === sid2));
    sessions.close(OWNER, sid2);
    await waitFor(() => statusOf(sid2)?.status === 'closed');
    const last = events.filter((e) => e.event === 'session.progress' && (e.payload as { sessionId: string }).sessionId === sid2).at(-1)!.payload as IpcEvents['session.progress'];
    expect(last.state).toBe('cancelled');
    expect(statusOf(sid2)?.message).toBe('已取消连接');
    silent.close();
  });
});

describe('会话录像（文档一 6.12）', () => {
  it('SSH 会话就绪后开始录像，输出和窗口变化写进录像，结束时收尾', async () => {
    const { RecordingStore } = await import('../src/main/services/audit/recording-store');
    const store = new RecordingStore(db, dir, randomBytes(32));
    sessions.recorderFactory = (meta) => store.start(meta);
    const id = addHost();
    const sid = sessions.openSsh(OWNER, id, 80, 24);
    await waitFor(() => statusOf(sid)?.status === 'ready');
    await waitFor(() => output(sid).includes('welcome'));
    sessions.resize(OWNER, sid, 100, 30);
    sessions.write(OWNER, sid, 'echo recorded-line\r');
    await waitFor(() => output(sid).includes('recorded-line'));
    sessions.close(OWNER, sid);
    await waitFor(() => statusOf(sid)?.status === 'closed');
    const [rec] = store.list().items;
    expect(rec).toMatchObject({ sessionId: sid, kind: 'ssh', hostName: 'test', cols: 80, rows: 24 });
    expect(rec.endedAt).not.toBeNull();
    const data = store.read(rec.id);
    const text = data.events.filter((e) => e[1] === 'o').map((e) => e[2]).join('');
    expect(text).toContain('welcome');
    expect(text).toContain('recorded-line');
    expect(data.events.some((e) => e[1] === 'r' && e[2] === '100x30')).toBe(true);
  });
});
