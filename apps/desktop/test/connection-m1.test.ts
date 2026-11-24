import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostInput, IpcEventName, IpcEvents, PromptAnswer, PromptRequest, RotateProgress } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { execCommand } from '../src/main/services/connection/exec';
import { KeyDeployService } from '../src/main/services/vault/key-deploy';
import { totp } from '../src/main/util/totp';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';
import { startHttpProxy, startSocks5, type TestProxy } from './support/proxy-server';
import { generateEd25519 } from './support/keys';
import { createRepos } from './support/repos';

const OWNER = 3;
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
type Responder = (req: PromptRequest) => PromptAnswer;

let dir: string;
let remoteRoot: string;
let db: Db;
let repos: ReturnType<typeof createRepos>;
let broker: PromptBroker;
let pool: SshPool;
let server: TestSshServer;
let proxies: TestProxy[];
let prompts: PromptRequest[];
let responders: Responder[];
let progress: RotateProgress[];

function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
  if (event === 'prompt.request') {
    const req = payload as PromptRequest;
    prompts.push(req);
    const r = responders.shift() ?? ((x: PromptRequest) => (x.kind === 'hostKey' ? { kind: 'hostKey', accept: true } : { kind: 'password', value: null, remember: false }));
    setTimeout(() => broker.answer(owner, req.promptId, r(req) as PromptAnswer), 1);
  }
  if (event === 'credential.rotateProgress') progress.push(payload as RotateProgress);
}

function input(over: Partial<HostInput> = {}): HostInput {
  return {
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
  };
}

async function restart(opts: Parameters<typeof startTestSshServer>[0]): Promise<void> {
  await server.close();
  server = await startTestSshServer(opts);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-m1-'));
  remoteRoot = join(dir, 'remote');
  mkdirSync(remoteRoot);
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  repos = createRepos(db, randomBytes(32));
  prompts = [];
  responders = [];
  progress = [];
  proxies = [];
  broker = new PromptBroker(emit);
  pool = new SshPool(repos.hosts, broker, 5000, (id) => repos.credentials.markUsed(id));
  server = await startTestSshServer({ root: remoteRoot });
});

afterEach(async () => {
  pool.closeAll();
  await server.close();
  for (const p of proxies) await p.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('两步验证（keyboard-interactive）', () => {
  it('凭证带 TOTP 种子：密码和验证码都自动填写，不弹窗', async () => {
    await restart({ root: remoteRoot, kbdOtp: { totp: () => totp(SEED).code } });
    const cred = repos.credentials.save(null, { type: 'PASSWORD', name: '堡垒机', username: 'tester', secret: 'pw', otpSeed: SEED, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    const id = repos.hosts.create(input({ username: '', authMethod: 'CREDENTIAL', credentialId: cred.id, password: undefined })).id;
    const c = await pool.acquire(id, OWNER);
    pool.release(c);
    expect(prompts.map((p) => p.kind)).toEqual(['hostKey']);
    expect(repos.credentials.require(cred.id).lastUsedAt).not.toBeNull();
  });

  it('没有 TOTP 种子时询问验证码（不提供记住）', async () => {
    await restart({ root: remoteRoot, kbdOtp: { totp: () => '123456' } });
    const id = repos.hosts.create(input()).id;
    responders.push(() => ({ kind: 'hostKey', accept: true }), () => ({ kind: 'password', value: '123456', remember: false }));
    const c = await pool.acquire(id, OWNER);
    pool.release(c);
    expect(prompts[1]).toMatchObject({ kind: 'password', message: 'Verification code:', otp: true, rememberable: false });
  });
});

describe('代理', () => {
  it('SOCKS5（用户名密码）和 HTTP CONNECT 代理', async () => {
    const socks = await startSocks5({ username: 'u', password: 'p' });
    const http = await startHttpProxy();
    proxies.push(socks, http);
    const viaSocks = repos.hosts.create(input({ name: 's', proxy: { type: 'SOCKS5', host: '127.0.0.1', port: socks.port, username: 'u' }, proxyPassword: 'p' })).id;
    const c1 = await pool.acquire(viaSocks, OWNER);
    expect((await execCommand(c1.client, 'echo ok', { timeoutMs: 5000 })).stdout.trim()).toBe('ok');
    pool.release(c1);
    expect(socks.targets).toEqual([`127.0.0.1:${server.port}`]);

    const viaHttp = repos.hosts.create(input({ name: 'h', proxy: { type: 'HTTP', host: '127.0.0.1', port: http.port, username: null } })).id;
    pool.release(await pool.acquire(viaHttp, OWNER));
    expect(http.targets).toEqual([`127.0.0.1:${server.port}`]);

    const bad = repos.hosts.create(input({ name: 'b', proxy: { type: 'SOCKS5', host: '127.0.0.1', port: socks.port, username: 'u' }, proxyPassword: 'wrong' })).id;
    await expect(pool.acquire(bad, OWNER)).rejects.toThrow('代理认证失败');
  });
});

describe('继承分组的凭证和跳板机', () => {
  it('主机使用分组默认凭证和默认跳板机连接', async () => {
    const target = await startTestSshServer({ root: remoteRoot, username: 'app', password: 'apw' });
    try {
      await restart({ root: remoteRoot, allowForward: true });
      const bastion = repos.hosts.create(input({ name: 'bastion' }));
      const cred = repos.credentials.save(null, { type: 'PASSWORD', name: 'app 账号', username: 'app', secret: 'apw', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
      const f = repos.folders.create(null, '内网');
      repos.folders.update(f.id, { defaultCredentialId: cred.id, defaultJumpHostId: bastion.id, agentPolicy: null, aiNote: null, defaultSkills: [], production: false });
      const id = repos.hosts.create(input({ name: 'app-01', folderId: f.id, port: target.port, username: '', authMethod: 'CREDENTIAL', credentialId: null, password: undefined })).id;
      const c = await pool.acquire(id, OWNER);
      expect((await execCommand(c.client, 'echo inner', { timeoutMs: 5000 })).stdout.trim()).toBe('inner');
      pool.release(c);
      expect(server.forwards).toEqual([`127.0.0.1:${target.port}`]);
    } finally {
      await target.close();
    }
  });
});

describe('公钥部署与轮换', () => {
  it('部署公钥（重复部署跳过），轮换后旧密钥失效、新密钥可用', async () => {
    await restart({ root: remoteRoot, authorizedKeysFromHome: true });
    const deploy = new KeyDeployService(pool, repos.hosts, repos.credentials, emit);
    const key = repos.credentials.save(null, { type: 'SSH_KEY', name: 'deploy', username: 'tester', generate: { algorithm: 'ed25519' }, aiAccess: 'REFERENCE', rotateDays: 90, expiresAt: null, note: null });
    // 先用密码登录部署公钥
    const pwHost = repos.hosts.create(input({ name: 'pw' })).id;
    // authorized_keys 已有一行没有换行结尾的旧公钥
    mkdirSync(join(remoteRoot, '.ssh'));
    writeFileSync(join(remoteRoot, '.ssh', 'authorized_keys'), generateEd25519().public);
    expect((await deploy.deploy(OWNER, key.id, [pwHost]))[0]).toMatchObject({ status: 'ok', message: '已添加公钥' });
    expect((await deploy.deploy(OWNER, key.id, [pwHost]))[0]).toMatchObject({ status: 'skipped' });
    const lines = readFileSync(join(remoteRoot, '.ssh', 'authorized_keys'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    // 改用这把密钥登录
    const keyHost = repos.hosts.create(input({ name: 'key', authMethod: 'CREDENTIAL', credentialId: key.id, password: undefined })).id;
    pool.release(await pool.acquire(keyHost, OWNER));
    pool.closeAll();
    const oldPub = key.publicKey!;
    const report = await deploy.rotate(OWNER, key.id, [keyHost]);
    expect(report.replaced).toBe(true);
    expect(report.steps[0]).toMatchObject({ deploy: 'ok', verify: 'ok', revoke: 'ok' });
    expect(progress.map((p) => `${p.stage}:${p.status}`)).toEqual(['deploy:running', 'deploy:ok', 'verify:running', 'verify:ok', 'revoke:running', 'revoke:ok']);
    const after = repos.credentials.require(key.id);
    expect(after.fingerprint).toBe(report.fingerprint);
    const content = readFileSync(join(remoteRoot, '.ssh', 'authorized_keys'), 'utf8');
    expect(content).not.toContain(oldPub.split(' ')[1]);
    expect(content).toContain(after.publicKey!.split(' ')[1]);
    // 新密钥能登录
    pool.closeAll();
    pool.release(await pool.acquire(keyHost, OWNER));
  });

  it('有主机验证失败时回滚：撤回新公钥，凭证不变', async () => {
    await restart({ root: remoteRoot, authorizedKeysFromHome: true });
    const deploy = new KeyDeployService(pool, repos.hosts, repos.credentials, emit);
    const key = repos.credentials.save(null, { type: 'SSH_KEY', name: 'k', username: 'tester', generate: { algorithm: 'ed25519' }, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    const ok = repos.hosts.create(input({ name: 'ok' })).id;
    const down = repos.hosts.create(input({ name: 'down', port: 1 })).id;
    const report = await deploy.rotate(OWNER, key.id, [ok, down]);
    expect(report.replaced).toBe(false);
    expect(report.steps.find((s) => s.hostId === down)!.deploy).toBe('error');
    expect(repos.credentials.require(key.id).fingerprint).toBe(key.fingerprint);
    const content = readFileSync(join(remoteRoot, '.ssh', 'authorized_keys'), 'utf8');
    expect(content.trim()).toBe('');
  });
});
