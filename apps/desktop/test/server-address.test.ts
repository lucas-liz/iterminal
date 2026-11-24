import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SERVER_URL, LEGACY_SERVER_URLS, USER_ERROR_PREFIX } from '@itm/protocol';
import { redactServers, setServerSource } from '../src/main/util/redact-server';
import { toIpcError, UserError } from '../src/main/util/errors';
import { normalizeServerUrl } from '../src/main/services/server/account-session';
import { ProfileStore } from '../src/main/services/profile/profile-store';
import { diag } from '../src/main/services/diag/diag-log';
import { FeedbackService } from '../src/main/services/diag/feedback';

/** 界面上不显示服务端地址：仓库默认地址为空（由本地 .env 打包注入），错误提示和诊断信息里的地址换成「服务端」，旧默认地址的档案迁移 */
const SAMPLE_DEFAULT = 'http://198.51.100.10:51115/prod-api';
const SAMPLE_LEGACY = 'http://198.51.100.10:51115';

afterEach(() => setServerSource(() => []));

describe('服务端地址', () => {
  it('仓库内不硬编码默认后台地址；带前缀的地址规范化后不变', () => {
    expect(DEFAULT_SERVER_URL).toBe('');
    expect(LEGACY_SERVER_URLS).toEqual([]);
    expect(normalizeServerUrl(SAMPLE_DEFAULT)).toBe(SAMPLE_DEFAULT);
    expect(normalizeServerUrl(`${SAMPLE_DEFAULT}/`)).toBe(SAMPLE_DEFAULT);
  });

  it('错误提示里的服务端地址换成「服务端」：完整地址、WebSocket、主机:端口、域名；其他地址不动', () => {
    setServerSource(() => [SAMPLE_DEFAULT, SAMPLE_LEGACY, 'https://ops.example.com', null, undefined]);
    expect(redactServers('连不上服务端 http://198.51.100.10:51115/prod-api（ECONNREFUSED）')).toBe('连不上服务端（ECONNREFUSED）');
    expect(redactServers('Cannot download "http://198.51.100.10:51115/prod-api/api/v1/releases/stable/mac/arm64/latest-mac.yml", status 404')).toBe(
      'Cannot download "服务端", status 404',
    );
    expect(redactServers('connect ECONNREFUSED 198.51.100.10:51115')).toBe('connect ECONNREFUSED 服务端');
    expect(redactServers('ws://198.51.100.10:51115/prod-api/ws/client?ticket=abc 断开')).toBe('服务端 断开');
    expect(redactServers('getaddrinfo ENOTFOUND ops.example.com')).toBe('getaddrinfo ENOTFOUND 服务端');
    expect(redactServers('请求 https://ops.example.com/api/v1/me 超时；ops.example.com:443 不通')).toBe('请求 服务端 超时；服务端 不通');
    // 同一台机器上的 SSH（端口不同）、其他主机、子域名不受影响
    expect(redactServers('连接 198.51.100.10:22 失败')).toBe('连接 198.51.100.10:22 失败');
    expect(redactServers('连接 198.51.100.10:511150 失败')).toBe('连接 198.51.100.10:511150 失败');
    expect(redactServers('api.ops.example.com 和 10.0.0.1:51115')).toBe('api.ops.example.com 和 10.0.0.1:51115');
    // 没有登记地址时原样返回
    setServerSource(() => []);
    expect(redactServers('connect ECONNREFUSED 198.51.100.10:51115')).toBe('connect ECONNREFUSED 198.51.100.10:51115');
  });

  it('IPC 返回给界面的错误统一去掉服务端地址', () => {
    setServerSource(() => [SAMPLE_DEFAULT]);
    expect(toIpcError(new UserError('连不上服务端 http://198.51.100.10:51115/prod-api（连接超时）')).message).toBe(`${USER_ERROR_PREFIX}连不上服务端（连接超时）`);
    const e = toIpcError(new TypeError('fetch failed: connect ECONNREFUSED 198.51.100.10:51115'));
    expect(e.message).toBe('fetch failed: connect ECONNREFUSED 服务端');
    expect(e.name).toBe('TypeError');
    const plain = new Error('没有地址');
    expect(toIpcError(plain)).toBe(plain);
  });

  it('问题反馈：预览和发送的诊断信息里没有服务端地址（不隐去 IP 时也没有），也不告诉界面提交到哪里', async () => {
    setServerSource(() => [SAMPLE_DEFAULT]);
    diag.error('net', 'POST /api/v1/me 失败：connect ECONNREFUSED 198.51.100.10:51115', { url: 'http://198.51.100.10:51115/prod-api/api/v1/me' });
    const sent: string[] = [];
    const fb = new FeedbackService({
      diag,
      version: '1.0.0',
      profile: () => ({ kind: 'account', serverUrl: SAMPLE_DEFAULT, email: null }),
      link: () => null,
      anonymousServer: () => SAMPLE_DEFAULT,
      profileEnv: () => ({}),
      appEnv: () => ({}),
      capture: async () => ({ png: Buffer.from('png'), jpeg: () => Buffer.from('jpg') }),
      fetchImpl: (async (url: string, init: { body: FormData }) => {
        sent.push(url, String(init.body.get('meta')), await (init.body.get('diagnosticsMd') as Blob).text());
        return new Response(JSON.stringify({ code: 0, data: { id: 7 } }), { status: 200 });
      }) as never,
    });
    for (const maskIps of [true, false]) {
      const p = fb.preview(maskIps);
      expect(p.target).toEqual({ anonymous: true });
      expect(p.env['应用']['服务端']).toBe('默认');
      const text = JSON.stringify(p);
      expect(text).not.toContain('198.51.100.10');
      expect(text).not.toContain('prod-api');
      expect(p.markdown).toContain('connect ECONNREFUSED 服务端');
    }
    expect(await fb.submit({ category: 'BUG', title: 't', description: 'd', contact: '', images: [], includeDiagnostics: true, maskIps: false })).toEqual({ id: 7 });
    // 发送的地址是默认地址（带 /prod-api），发送的内容里没有地址
    expect(sent[0]).toBe(`${SAMPLE_DEFAULT}/api/v1/public/feedback`);
    expect(sent.slice(1).join('\n')).not.toContain('198.51.100.10');

    // 未配置服务端地址时给出友好提示而不崩溃
    const fbNoServer = new FeedbackService({
      diag,
      version: '1.0.0',
      profile: () => ({ kind: 'local', serverUrl: null, email: null }),
      link: () => null,
      anonymousServer: () => null,
      profileEnv: () => ({}),
      appEnv: () => ({}),
      capture: async () => ({ png: Buffer.from('png'), jpeg: () => Buffer.from('jpg') }),
    });
    await expect(fbNoServer.submit({ category: 'BUG', title: 't', description: 'd', contact: '', images: [], includeDiagnostics: false, maskIps: false })).rejects.toThrow('未配置服务端地址');
  });

  it('用旧默认地址（没有 /prod-api）登录过的账号档案换成新地址，重新登录时仍然用原来的档案目录', () => {
    const root = mkdtempSync(join(tmpdir(), 'itm-srv-'));
    try {
      const oldId = 'u_1_abcdef12';
      writeFileSync(
        join(root, 'profiles.json'),
        JSON.stringify({
          current: oldId,
          profiles: [
            { id: 'local', kind: 'local', createdAt: 1 },
            { id: oldId, kind: 'account', userId: '1', username: 'admin', displayName: '管理员', serverUrl: SAMPLE_LEGACY, createdAt: 2 },
            { id: 'u_1_99999999', kind: 'account', userId: '1', username: 'admin', displayName: '管理员', serverUrl: 'https://ops.example.com', createdAt: 3 },
          ],
        }),
      );
      const store = new ProfileStore(root, Date.now, { defaultUrl: SAMPLE_DEFAULT, legacyUrls: [SAMPLE_LEGACY] });
      expect(store.current()).toMatchObject({ id: oldId, serverUrl: SAMPLE_DEFAULT });
      const again = store.ensureAccount({ userId: '1', username: 'admin', displayName: '管理员', serverUrl: SAMPLE_DEFAULT });
      expect(again.id).toBe(oldId);
      expect(store.list().filter((p) => p.kind === 'account')).toHaveLength(2);
      // 其他服务端的同一个用户 ID 仍然是另一个档案
      expect(store.get('u_1_99999999')?.serverUrl).toBe('https://ops.example.com');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
