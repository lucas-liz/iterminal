import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ServerConfigStore } from '../src/main/services/server/server-config';

/** 隐藏的服务端地址设置：管理员密码（只存哈希）、令牌、保存 / 恢复默认、测试连接 */
let dir: string;
let http: Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-srvcfg-'));
  // 模拟几种服务端：iTerminal（空令牌返回 400 JSON）、不是 iTerminal 的网页、没有这个接口
  http = createServer((req, res) => {
    if (req.url === '/prod-api/api/v1/auth/refresh') {
      res.writeHead(400, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ code: 400, message: '缺少刷新令牌', data: null }));
    }
    if (req.url === '/html/api/v1/auth/refresh') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end('<!doctype html><title>admin</title>');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  port = (http.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => http.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const salt = randomBytes(16).toString('hex');
const admin = { salt, hash: scryptSync('test-admin-pw', Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex') };

describe('隐藏的服务端地址设置', () => {
  it('管理员密码按哈希校验；连续输错 5 次锁定 5 分钟；令牌 10 分钟有效', () => {
    let now = 1_000_000;
    const s = new ServerConfigStore({ file: join(dir, 'a.json'), presetUrl: () => null, admin, now: () => now });
    expect(() => s.unlock('')).toThrow('密码错误');
    for (let i = 0; i < 3; i++) expect(() => s.unlock('wrong')).toThrow('密码错误');
    expect(() => s.unlock('wrong')).toThrow('错误次数太多');
    // 锁定期间正确的密码也不行
    expect(() => s.unlock('test-admin-pw')).toThrow('错误次数太多');
    now += 5 * 60_000;
    const { token } = s.unlock('test-admin-pw');
    expect(s.get(token)).toEqual({ custom: null, source: 'default' });
    expect(() => s.get('nope')).toThrow('管理员验证已过期');
    now += 10 * 60_000;
    expect(() => s.get(token)).toThrow('管理员验证已过期');
  });

  it('保存（规范化、文件权限 0600）、恢复默认；企业预置时说明来源；地址不合法时报错', () => {
    const file = join(dir, 'b.json');
    let preset: string | null = null;
    const s = new ServerConfigStore({ file, presetUrl: () => preset, testPassword: 'e2e' });
    const { token } = s.unlock('e2e');
    expect(s.set(token, ' http://10.0.0.5:8080/prod-api/ ')).toEqual({ custom: 'http://10.0.0.5:8080/prod-api', source: 'custom' });
    expect(s.custom()).toBe('http://10.0.0.5:8080/prod-api');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ serverUrl: 'http://10.0.0.5:8080/prod-api' });
    expect(() => s.set(token, 'ftp://x')).toThrow('只支持 http');
    preset = 'https://ops.example.com';
    expect(s.set(token, '')).toEqual({ custom: null, source: 'preset' });
    preset = null;
    expect(s.set(token, null)).toEqual({ custom: null, source: 'default' });
    expect(s.custom()).toBeNull();
  });

  it('测试连接：iTerminal 服务端算成功；网页、404、连不上都说明原因', async () => {
    const s = new ServerConfigStore({ file: join(dir, 'c.json'), presetUrl: () => null, testPassword: 'e2e' });
    const { token } = s.unlock('e2e');
    const ok = await s.test(token, `http://127.0.0.1:${port}/prod-api`);
    expect(ok).toMatchObject({ ok: true });
    expect(ok.message).toContain('连接成功');
    expect(await s.test(token, `http://127.0.0.1:${port}/html`)).toMatchObject({ ok: false, message: expect.stringContaining('不是 iTerminal 服务端') });
    expect(await s.test(token, `http://127.0.0.1:${port}`)).toMatchObject({ ok: false, message: expect.stringContaining('路径前缀') });
    expect(await s.test(token, 'http://127.0.0.1:1')).toMatchObject({ ok: false, message: expect.stringContaining('连不上') });
    await expect(s.test('bad', `http://127.0.0.1:${port}/prod-api`)).rejects.toThrow('管理员验证已过期');
  });
});
