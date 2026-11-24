import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalEngine } from '@itm/approval';
import { AccountSession, accountLogin, normalizeServerUrl } from '../src/main/services/server/account-session';
import { readTeamPolicy, sanitizeTeamPolicy, teamMaskRulesOf, teamRulesOf, writeTeamPolicy } from '../src/main/services/server/team-policy';
import { startMockServer, type MockServer } from './support/mock-server';

let mock: MockServer;
let dir: string;
const vaultKey = randomBytes(32);

beforeAll(async () => {
  mock = await startMockServer();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-account-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('服务端地址', () => {
  it('补全协议、去掉末尾的 /，保留路径前缀；拒绝其他协议和带密码的地址', () => {
    expect(normalizeServerUrl(' ops.example.com/ ')).toBe('https://ops.example.com');
    expect(normalizeServerUrl('http://10.0.0.5:8080/prod-api//')).toBe('http://10.0.0.5:8080/prod-api');
    expect(() => normalizeServerUrl('')).toThrow('请填写服务端地址');
    expect(() => normalizeServerUrl('ftp://x')).toThrow('只支持');
    expect(() => normalizeServerUrl('https://u:p@x.com')).toThrow('用户名和密码');
  });
});

describe('登录会话', () => {
  const login = (password = mock.user.password) =>
    accountLogin({ serverUrl: mock.url, username: mock.user.username, password, deviceId: 'dev-1', clientVersion: '0.1.0' });

  it('登录：密码错误返回服务端的提示；连不上时说明原因', async () => {
    await expect(login('bad')).rejects.toThrow('用户不存在/密码错误');
    await expect(accountLogin({ serverUrl: 'http://127.0.0.1:1', username: 'a', password: 'b', deviceId: 'd', clientVersion: '0' })).rejects.toThrow('连不上服务端');
    const r = await login();
    expect(r.user.userName).toBe('tester');
  });

  it('令牌加密保存；同时多个 401 只刷新一次，刷新令牌轮换', async () => {
    const r = await login();
    AccountSession.write(dir, vaultKey, r);
    const dead: string[] = [];
    const s = new AccountSession({ dir, vaultKey, baseUrl: mock.url, deviceId: 'dev-1', onDead: (st) => dead.push(st) });
    expect(s.state().status).toBe('valid');
    expect(await s.token()).toBe(mock.token);
    // 换一个密钥读不出来
    expect(new AccountSession({ dir, vaultKey: randomBytes(32), baseUrl: mock.url, deviceId: 'dev-1', onDead: () => undefined }).state().status).toBe('expired');

    mock.expireAccess();
    const before = mock.rest.filter((x) => x.path === '/api/v1/auth/refresh').length;
    const results = await Promise.all([s.refresh(), s.refresh(), s.refresh()]);
    expect(results).toEqual([true, true, true]);
    expect(mock.rest.filter((x) => x.path === '/api/v1/auth/refresh').length).toBe(before + 1);
    expect(await s.token()).toBe(mock.token);
    // 新令牌已经写回文件
    const again = new AccountSession({ dir, vaultKey, baseUrl: mock.url, deviceId: 'dev-1', onDead: () => undefined });
    expect(await again.token()).toBe(mock.token);
    expect(dead).toEqual([]);
  });

  it('刷新令牌失效：会话失效、删除本机令牌、只通知一次；重新登录后恢复', async () => {
    AccountSession.write(dir, vaultKey, await login());
    const dead: string[] = [];
    const s = new AccountSession({ dir, vaultKey, baseUrl: mock.url, deviceId: 'dev-1', onDead: (st, msg) => dead.push(`${st}:${msg}`) });
    mock.expireRefresh();
    expect(await s.refresh()).toBe(false);
    expect(await s.refresh()).toBe(false);
    expect(dead).toEqual(['expired:刷新令牌无效，请重新登录']);
    expect(s.state().status).toBe('expired');
    expect(await s.token()).toBeNull();
    expect(existsSync(join(dir, 'auth.bin'))).toBe(false);

    s.resume(await login());
    expect(s.state().status).toBe('valid');
    s.revoked();
    expect(s.state()).toEqual({ status: 'revoked', message: '这台设备已被管理员吊销，请重新登录' });
  });
});

describe('团队策略', () => {
  const raw = {
    commandRules: [
      { id: '1', name: '禁止重启', matchType: 'PREFIX', pattern: 'reboot', level: 'DENY', reason: '禁止重启', priority: 1 },
      { id: '2', name: '查看日志', matchType: 'PREFIX', pattern: 'journalctl', level: 'L0', reason: '', priority: 5 },
      { id: '3', name: '坏的', matchType: 'GLOB', pattern: 'x', level: 'L1' },
    ],
    maskRules: [{ id: '1', name: '工号', pattern: '\\bEMP\\d{6}\\b', replacement: '[工号]', forcePrivate: true }],
    unattendedCap: 'APPROVE',
    allowLlmReview: false,
    version: 'abc',
  };

  it('校验并缓存（加密）；格式不对的规则丢掉', () => {
    const p = sanitizeTeamPolicy(raw)!;
    expect(p.commandRules.map((r) => r.id)).toEqual(['1', '2']);
    expect(p.unattendedCap).toBe('APPROVE');
    expect(p.allowLlmReview).toBe(false);
    expect(sanitizeTeamPolicy({ commandRules: 'x' })).toBeNull();
    writeTeamPolicy(dir, vaultKey, p);
    expect(readTeamPolicy(dir, vaultKey)?.version).toBe('abc');
    expect(readTeamPolicy(dir, randomBytes(32))).toBeNull();
    expect(teamMaskRulesOf(p)[0]).toMatchObject({ kind: 'REGEX', replacement: '[工号]', forcePrivateModel: true, reversible: false });
  });

  it('团队规则最先匹配，用户白名单不能放宽', () => {
    const engine = new ApprovalEngine();
    engine.setTeamRules(teamRulesOf(sanitizeTeamPolicy(raw)));
    engine.setUserRules([{ id: 'u:1', level: 'L0', matchType: 'PREFIX', pattern: 'reboot', priority: 0 }]);
    expect(engine.classify('reboot now').level).toBe('DENY');
    expect(engine.classify('journalctl -u nginx').level).toBe('L0');
    engine.setTeamRules([]);
    expect(engine.classify('reboot now').level).not.toBe('DENY');
  });
});
