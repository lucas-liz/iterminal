import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcEventName, IpcEvents, PortForwardStatus, PromptRequest } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { PortForwardRepo } from '../src/main/services/hosts/port-forward-repo';
import { PortForwardService } from '../src/main/services/connection/port-forward';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SessionManager } from '../src/main/services/connection/session-manager';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

const OWNER = 5;
let dir: string;
let db: Db;
let hosts: HostRepo;
let repo: PortForwardRepo;
let broker: PromptBroker;
let pool: SshPool;
let svc: PortForwardService;
let server: TestSshServer;
let echo: Server;
let echoPort: number;
let statuses: PortForwardStatus[];

function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
  if (event === 'prompt.request') setTimeout(() => broker.answer(owner, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true }), 1);
  if (event === 'portforward.status') statuses.push(payload as PortForwardStatus);
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 连上去发一句话，读回 echo 服务器的应答 */
function roundTrip(port: number, text: string, before?: (s: Socket) => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    s.once('error', reject);
    s.once('connect', async () => {
      if (before) await before(s);
      s.once('data', (d) => {
        resolve(d.toString());
        s.destroy();
      });
      s.write(text);
    });
  });
}

/** SOCKS5 握手：无认证，CONNECT 域名:端口 */
async function socksConnect(s: Socket, host: string, port: number): Promise<void> {
  const read = (): Promise<Buffer> => new Promise((r) => s.once('data', r));
  s.write(Buffer.from([5, 1, 0]));
  expect([...(await read())]).toEqual([5, 0]);
  const name = Buffer.from(host);
  const req = Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([port >> 8, port & 0xff])]);
  s.write(req);
  const reply = await read();
  expect(reply[1]).toBe(0);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-pf-'));
  mkdirSync(join(dir, 'remote'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ hosts } = createRepos(db, randomBytes(32)));
  repo = new PortForwardRepo(db);
  statuses = [];
  broker = new PromptBroker(emit);
  pool = new SshPool(hosts, broker, 5000);
  svc = new PortForwardService(repo, pool, emit);
  server = await startTestSshServer({ root: join(dir, 'remote'), allowForward: true });
  echo = createServer((s) => s.on('data', (d) => s.write(`echo:${d.toString()}`)));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoPort = (echo.address() as { port: number }).port;
});

afterEach(async () => {
  svc.stopAll();
  pool.closeAll();
  await server.close();
  echo.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function addHost(): string {
  return hosts.create({
    folderId: null,
    name: 'bastion',
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
}

describe('端口转发配置', () => {
  it('校验：目标必填、端口范围、同一监听地址不能重复；动态转发没有目标', () => {
    const h = addHost();
    expect(() => repo.save(null, h, { type: 'LOCAL', bindAddr: '', bindPort: 8080, targetAddr: '', targetPort: 80, autoStart: false })).toThrow('请填写目标地址');
    expect(() => repo.save(null, h, { type: 'LOCAL', bindAddr: '', bindPort: 70000, targetAddr: 'db', targetPort: 80, autoStart: false })).toThrow('监听端口');
    const a = repo.save(null, h, { type: 'LOCAL', bindAddr: ' ', bindPort: 8080, targetAddr: 'db.internal', targetPort: 3306, autoStart: true });
    expect(a).toMatchObject({ bindAddr: '127.0.0.1', targetAddr: 'db.internal', autoStart: true });
    expect(() => repo.save(null, h, { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 8080, targetAddr: 'x', targetPort: 1, autoStart: false })).toThrow('已经有监听');
    const d = repo.save(null, h, { type: 'DYNAMIC', bindAddr: '127.0.0.1', bindPort: 1080, targetAddr: 'ignored', targetPort: 9, autoStart: false });
    expect(d).toMatchObject({ targetAddr: null, targetPort: null });
    expect(repo.list(h)).toHaveLength(2);
    repo.delete(a.id);
    expect(repo.list(null).map((f) => f.id)).toEqual([d.id]);
    // 主机删除后不再列出
    hosts.delete([h]);
    expect(repo.list(null)).toEqual([]);
  });
});

describe('端口转发', () => {
  it('本地转发（-L）：本机端口经过 SSH 到目标；统计连接数；停止后端口关闭', async () => {
    const h = addHost();
    const f = repo.save(null, h, { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: '127.0.0.1', targetPort: echoPort, autoStart: false });
    const st = await svc.start(OWNER, f.id);
    expect(st).toMatchObject({ state: 'running' });
    expect(st.boundPort).toBeGreaterThan(0);
    expect(await roundTrip(st.boundPort!, 'hello')).toBe('echo:hello');
    expect(server.forwards).toContain(`127.0.0.1:${echoPort}`);
    expect(statuses.some((s) => s.connections === 1)).toBe(true);
    svc.stop(f.id);
    expect(svc.status(f).state).toBe('stopped');
    await expect(roundTrip(st.boundPort!, 'x')).rejects.toThrow();
  });

  it('动态转发（-D）：本机 SOCKS5 代理，按域名连接目标', async () => {
    const h = addHost();
    const f = repo.save(null, h, { type: 'DYNAMIC', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: null, targetPort: null, autoStart: false });
    const st = await svc.start(OWNER, f.id);
    expect(await roundTrip(st.boundPort!, 'via-socks', (s) => socksConnect(s, 'localhost', echoPort))).toBe('echo:via-socks');
    expect(server.forwards).toContain(`localhost:${echoPort}`);
  });

  it('远程转发（-R）：主机上的端口经过本机到目标', async () => {
    const h = addHost();
    const f = repo.save(null, h, { type: 'REMOTE', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: '127.0.0.1', targetPort: echoPort, autoStart: false });
    const st = await svc.start(OWNER, f.id);
    expect(st.state).toBe('running');
    const remotePort = await waitFor(() => server.remoteForwards[0]);
    expect(st.boundPort).toBe(remotePort);
    expect(await roundTrip(remotePort, 'from-remote')).toBe('echo:from-remote');
    svc.stop(f.id);
  });

  it('本机端口被占用时报错；SSH 断开后状态变成出错', async () => {
    const h = addHost();
    const busy = createServer();
    await new Promise<void>((r) => busy.listen(0, '127.0.0.1', r));
    const port = (busy.address() as { port: number }).port;
    const f = repo.save(null, h, { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: port, targetAddr: '127.0.0.1', targetPort: echoPort, autoStart: false });
    await expect(svc.start(OWNER, f.id)).rejects.toThrow(`本机端口 ${port} 已被占用`);
    expect(svc.status(f)).toMatchObject({ state: 'error' });
    busy.close();

    const g = repo.save(null, h, { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: '127.0.0.1', targetPort: echoPort, autoStart: false });
    await svc.start(OWNER, g.id);
    pool.closeAll();
    await waitFor(() => svc.status(g).state === 'error');
    expect(svc.status(g).message).toContain('SSH 连接已断开');
  });

  it('打开主机的终端时自动启动设置了自动启动的转发', async () => {
    const h = addHost();
    const f = repo.save(null, h, { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: '127.0.0.1', targetPort: echoPort, autoStart: true });
    const off = repo.save(null, h, { type: 'DYNAMIC', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: null, targetPort: null, autoStart: false });
    const sessions = new SessionManager(pool, hosts, emit, (file, args, o) => pty.spawn(file, args, { name: 'xterm-256color', ...o }));
    sessions.onSshReady = (owner, hostId) => svc.autoStart(owner, hostId);
    const id = sessions.openSsh(OWNER, h, 80, 24);
    await waitFor(() => svc.status(f).state === 'running');
    expect(svc.status(off).state).toBe('stopped');
    expect(await roundTrip(svc.status(f).boundPort!, 'auto')).toBe('echo:auto');
    // 终端和转发共用一条 SSH 连接
    expect(server.connections).toBe(1);
    sessions.close(OWNER, id);
  });
});
