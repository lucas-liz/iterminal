import { describe, expect, it } from 'vitest';
import { Masker, entropy, looksLikeSecret, mask } from '../src/index';

describe('脱敏', () => {
  it('隐藏私钥、密码、令牌、AK 和 URL 里的密码', () => {
    const text = [
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----',
      'DB_PASSWORD=Sup3rSecret!',
      'password: hunter22',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijk',
      'aws AKIAIOSFODNN7EXAMPLE',
      'redis://admin:p4ss@10.0.0.1:6379',
      'key sk-proj-abcdefghijklmnopqrstu',
      'mysql -uroot -pRootPwd123 -h db',
      'github ghp_abcdefghijklmnopqrstuvwxyz0123',
    ].join('\n');
    const out = mask(text);
    for (const secret of ['abc\ndef', 'Sup3rSecret!', 'hunter22', 'eyJhbGciOiJIUzI1NiJ9', 'IOSFODNN7EXAMPLE', 'p4ss', 'abcdefghijklmnopqrstu', 'RootPwd123', 'ghp_abcdefghijklmnop']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[已隐藏私钥]');
    expect(out).toContain('DB_PASSWORD=****');
    expect(out).toContain('redis://admin:****@10.0.0.1');
  });

  it('普通输出、十六进制哈希、Pod 名、路径不受影响', () => {
    const text = [
      'Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 50G 14G 36G 29% /',
      'sha256:9b2a1f4c3d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8',
      'web-6d9f7c8b9d-x7k2p   1/1   Running',
      '/var/lib/docker/overlay2/3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a/merged',
    ].join('\n');
    expect(new Masker().mask(text).text).toBe(text);
  });

  it('JWT 和高熵密钥；同一个值在会话内编号不变', () => {
    const m = new Masker();
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const key = 'aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5bC7d';
    expect(looksLikeSecret(key)).toBe(true);
    expect(entropy('aaaa')).toBe(0);
    const r = m.mask(`token=${jwt}\nk1 ${key}\nk2 ${key}`);
    expect(r.text).not.toContain(key);
    expect(r.text).toContain('[SECRET_1]');
    expect(r.text.match(/\[SECRET_1]/g)).toHaveLength(2);
    expect(r.hits['高熵字符串']).toBe(2);
    // 不可还原的原文不保存在映射表里
    expect(JSON.stringify(m.snapshot())).not.toContain(key);
  });

  it('手机号、身份证号（校验码正确才算）', () => {
    const m = new Masker();
    const r = m.mask('联系人 13800138000，身份证 11010519491231002X，订单号 110105194912310021');
    expect(r.text).toBe('联系人 [PII_1]，身份证 [PII_2]，订单号 110105194912310021');
  });

  it('IP 地址（可选）：替换成 HOST_IP_n，工具参数里还原；映射可以保存后恢复', () => {
    const m = new Masker({ maskIps: true, maskPii: true });
    const r = m.mask('mysql 主库 10.12.3.21，从库 10.12.3.22；本机 127.0.0.1；掩码 255.255.255.0；再次 10.12.3.21');
    expect(r.text).toBe('mysql 主库 HOST_IP_1，从库 HOST_IP_2；本机 127.0.0.1；掩码 255.255.255.0；再次 HOST_IP_1');
    expect(m.restoreArgs({ host: 't1', command: 'ping -c 1 HOST_IP_2 && ssh HOST_IP_1', list: ['HOST_IP_1'] })).toEqual({
      host: 't1',
      command: 'ping -c 1 10.12.3.22 && ssh 10.12.3.21',
      list: ['10.12.3.21'],
    });
    const restored = new Masker({ maskIps: true, maskPii: true }, m.snapshot());
    expect(restored.mask('10.12.3.22 和 10.0.0.9').text).toBe('HOST_IP_2 和 HOST_IP_3');
    // HOST_IP_1 不会被误替换成 HOST_IP_10 的一部分
    for (let i = 0; i < 9; i++) restored.mask(`10.1.1.${i}`);
    expect(restored.restore('HOST_IP_10 HOST_IP_1')).toBe('10.1.1.6 10.12.3.21');
  });

  it('服务端规则：编号占位符、强制内网模型', () => {
    const m = new Masker({
      maskIps: false,
      maskPii: false,
      rules: [
        { id: 1, name: '工号', kind: 'REGEX', pattern: '\\bE\\d{6}\\b', replacement: '[EMP_{n}]', reversible: false, forcePrivateModel: false },
        { id: 2, name: '主库', kind: 'REGEX', pattern: '(?i)prod-master-db', replacement: '[CORE_DB]', reversible: false, forcePrivateModel: true },
        { id: 3, name: '坏规则', kind: 'REGEX', pattern: '([', replacement: 'x', reversible: false, forcePrivateModel: false },
      ],
    });
    const r = m.mask('E123456 登录 PROD-MASTER-DB，E654321 也在');
    expect(r.text).toBe('[EMP_1] 登录 [CORE_DB]，[EMP_2] 也在');
    expect(r.forcePrivate).toBe(true);
    expect(m.mask('普通内容').forcePrivate).toBe(false);
  });
});
