// 云备份和个人分享码冒烟测试：密钥托管（ETag 乐观锁、改密码、轮换）、备份上传 / 下载 / 置顶 / 保留份数、分享码开启 / 拉取 / 暂停 / 收窄 / 重置 / 关闭。
// 服务端只保存密文，这里用随机字节代替客户端加密好的包。
// 用法：node test/cloud-smoke.mjs http://127.0.0.1:8080   （需要关闭验证码，同 client-smoke.mjs）
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);

async function api(method, path, { token, body, headers = {}, form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: res.status, json, buf, etag: res.headers.get('etag') };
}
const b64 = (n) => randomBytes(n).toString('base64');
const pkg = (meta, data) => {
  const f = new FormData();
  f.append('meta', JSON.stringify({ ...meta, sha256: createHash('sha256').update(data).digest('hex') }));
  f.append('file', new Blob([data]), 'x.itmbak');
  return f;
};
const setConfig = async (admin, key, value) => {
  const cfg = (await api('GET', `/system/config/list?configKey=${key}`, { token: admin })).json.rows[0];
  await api('PUT', '/system/config', { token: admin, body: { ...cfg, configValue: value } });
};
const device = async (username, password) => {
  const l = await api('POST', '/api/v1/auth/login', { body: { username, password, deviceId: `cloud-dev-${randomUUID()}`, deviceName: 'cloud-mac', os: 'mac', arch: 'arm64', clientVersion: '0.2.0' } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  return l.json.data.accessToken;
};

console.log(`iTerminal 云备份和分享码冒烟测试：${BASE}`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');
const tag = String(Date.now()).slice(-6);
// 分享者：新建一个用户（每次测试都是干净的状态）
const uname = `cld${tag}`;
let r = await api('POST', '/system/user', { token: admin, body: { userName: uname, nickName: '分享者', password: 'Test@123456', deptId: 103, roleIds: [2], status: '0' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const ownerId = (await api('GET', `/system/user/list?userName=${uname}`, { token: admin })).json.rows[0].userId;
const A = await device(uname, 'Test@123456');
const B = await device('admin', 'admin123');

// ---------------------------------------------------------------- 密钥托管
r = await api('GET', '/api/v1/sync/e2e-key', { token: A });
assert.equal(r.json.data, null);
const kdf = { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: b64(16) };
r = await api('PUT', '/api/v1/sync/e2e-key', { token: A, body: { wrappedCdk: b64(60), recoveryWrappedCdk: b64(60), kdf, keyVersion: 2 } });
assert.equal(r.status, 400);
r = await api('PUT', '/api/v1/sync/e2e-key', { token: A, body: { wrappedCdk: b64(60), recoveryWrappedCdk: b64(60), kdf, keyVersion: 1 } });
assert.equal(r.status, 200, JSON.stringify(r.json));
let etag = r.etag;
assert.ok(etag);
r = await api('PUT', '/api/v1/sync/e2e-key', { token: A, body: { wrappedCdk: b64(60), kdf, keyVersion: 1 } });
assert.equal(r.status, 412); // 没带 If-Match
const recovery = (await api('GET', '/api/v1/sync/e2e-key', { token: A })).json.data.recoveryWrappedCdk;
r = await api('PUT', '/api/v1/sync/e2e-key', { token: A, headers: { 'if-match': etag }, body: { wrappedCdk: b64(60), kdf, keyVersion: 1 } });
assert.equal(r.status, 200);
assert.equal(r.json.data.recoveryWrappedCdk, recovery); // 改同步密码：恢复码不变
assert.notEqual(r.etag, etag);
r = await api('PUT', '/api/v1/sync/e2e-key', { token: A, headers: { 'if-match': etag }, body: { wrappedCdk: b64(60), kdf, keyVersion: 1 } });
assert.equal(r.status, 412); // 旧 ETag
etag = (await api('GET', '/api/v1/sync/e2e-key', { token: A })).etag;
r = await api('PUT', '/api/v1/sync/e2e-key', { token: A, headers: { 'if-match': etag }, body: { wrappedCdk: b64(60), kdf, keyVersion: 2 } });
assert.equal(r.status, 400); // 轮换必须带新恢复码
r = await api('PUT', '/api/v1/sync/e2e-key', { token: A, headers: { 'if-match': etag }, body: { wrappedCdk: b64(60), recoveryWrappedCdk: b64(60), kdf, keyVersion: 2 } });
assert.equal(r.status, 200);
assert.equal(r.json.data.keyVersion, 2);
ok('密钥托管：首次设置、ETag 乐观锁、改同步密码（恢复码不变）、轮换（必须带新恢复码）');

// ---------------------------------------------------------------- 云备份
const meta = { formatVersion: 2, deviceName: 'cloud-mac', platform: 'macos', clientVersion: '0.2.0', groups: ['HOSTS', 'NOTES'], counts: { hosts: 3, hostGroups: 1, notes: 2 } };
const data1 = randomBytes(2048);
r = await api('POST', '/api/v1/backups', { token: A, form: pkg({ ...meta, keyVersion: 1 }, data1) });
assert.equal(r.status, 409); // 旧密钥版本
r = await api('POST', '/api/v1/backups', { token: A, form: pkg({ ...meta, keyVersion: 2, counts: { snippets: 1 } }, data1) });
assert.equal(r.status, 400); // 条数的键不属于所含分组
r = await api('POST', '/api/v1/backups', { token: A, form: pkg({ ...meta, keyVersion: 2, remark: '第一份' }, data1) });
assert.equal(r.status, 200, JSON.stringify(r.json));
const b1 = r.json.data;
assert.deepEqual(b1.groups, ['HOSTS', 'NOTES']);
assert.equal(b1.size, 2048);
r = await api('GET', `/api/v1/backups/${b1.id}/content`, { token: A });
assert.ok(r.buf.equals(data1));
assert.equal((await api('GET', `/api/v1/backups/${b1.id}/content`, { token: B })).status, 404); // 只有本人能下载
r = await api('PATCH', `/api/v1/backups/${b1.id}`, { token: A, body: { pinned: true, remark: '置顶的' } });
assert.equal(r.json.data.pinned, true);
await setConfig(admin, 'itm.backup.keepCount', '2');
for (let i = 0; i < 3; i++) await api('POST', '/api/v1/backups', { token: A, form: pkg({ ...meta, keyVersion: 2 }, randomBytes(100 + i)) });
let list = (await api('GET', '/api/v1/backups', { token: A })).json.data;
assert.equal(list.length, 3); // 置顶 1 + 最近 2
assert.equal(list[0].id, b1.id);
await setConfig(admin, 'itm.backup.keepCount', '20');
await setConfig(admin, 'itm.sync.allowCredentialSync', 'false');
r = await api('POST', '/api/v1/backups', { token: A, form: pkg({ ...meta, keyVersion: 2, groups: ['CREDENTIALS'], counts: { credentials: 1 } }, data1) });
assert.equal(r.status, 403);
await setConfig(admin, 'itm.sync.allowCredentialSync', 'true');
r = await api('DELETE', `/api/v1/backups/${list[1].id}`, { token: A });
assert.equal(r.status, 200);
assert.equal((await api('GET', '/api/v1/backups', { token: A })).json.data.length, 2);
ok('云备份：密钥版本和条数校验、只有本人能下载、置顶、保留最近 N 份（置顶不算）、禁止凭证上云、删除');

// ---------------------------------------------------------------- 分享码
const token1 = randomBytes(32).toString('base64url');
r = await api('PUT', '/api/v1/shares/me', { token: A, body: { lookupToken: token1, codeE2e: b64(60), e2eKeyVersion: 2, dataGroups: ['HOSTS', 'NOTES'] } });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.data.content, null);
r = await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token1 } });
assert.equal(r.status, 404);
assert.match(r.json.message, /还没有上传/);
const share = randomBytes(4096);
const smeta = { formatVersion: 2, deviceName: 'cloud-mac', platform: 'macos', clientVersion: '0.2.0', groups: ['HOSTS'], counts: { hosts: 3, hostGroups: 1 } };
r = await api('PUT', '/api/v1/shares/me/content', { token: A, form: pkg({ ...smeta, lookupToken: token1, groups: ['SNIPPETS'], counts: {} }, share) });
assert.equal(r.status, 400); // 范围之外
r = await api('PUT', '/api/v1/shares/me/content', { token: A, form: pkg({ ...smeta, lookupToken: randomBytes(32).toString('base64url') }, share) });
assert.equal(r.status, 412); // 不是当前分享码
r = await api('PUT', '/api/v1/shares/me/content', { token: A, form: pkg({ ...smeta, lookupToken: token1 }, share) });
assert.equal(r.status, 200, JSON.stringify(r.json));
r = await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token1 } });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.data.ownerUsername, uname);
assert.equal(r.json.data.ownerDisplayName, '分享者');
assert.deepEqual(r.json.data.groups, ['HOSTS']);
r = await api('POST', '/api/v1/shares:download', { token: B, body: { lookupToken: token1 } });
assert.ok(r.buf.equals(share));
assert.equal((await api('GET', '/api/v1/shares/me', { token: A })).json.data.pullCount, 1);
assert.equal((await api('POST', '/api/v1/shares:lookup', { token: A, body: { lookupToken: token1 } })).status, 400); // 自己的
assert.equal((await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: randomBytes(32).toString('base64url') } })).json.message, '分享码无效或已失效');
ok('分享码：开启、上传分享包（范围和分享码校验）、预览、下载、拉取次数；自己的码不能拉；错误的码统一提示失效');

r = await api('PATCH', '/api/v1/shares/me', { token: A, body: { enabled: false } });
assert.equal((await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token1 } })).json.message, '分享码无效或已失效');
await api('PATCH', '/api/v1/shares/me', { token: A, body: { enabled: true } });
assert.equal((await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token1 } })).status, 200);
// 收窄范围：分享包包含了范围之外的分组 → 立即清空
r = await api('PATCH', '/api/v1/shares/me', { token: A, body: { dataGroups: ['NOTES'] } });
assert.equal(r.json.data.content, null);
assert.match((await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token1 } })).json.message, /还没有上传/);
// 重置：旧码立即失效
const token2 = randomBytes(32).toString('base64url');
r = await api('PUT', '/api/v1/shares/me', { token: A, body: { lookupToken: token2, codeE2e: b64(60), e2eKeyVersion: 2, dataGroups: ['HOSTS'] } });
assert.equal(r.json.data.pullCount, 0);
await api('PUT', '/api/v1/shares/me/content', { token: A, form: pkg({ ...smeta, lookupToken: token2 }, share) });
assert.equal((await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token1 } })).status, 404);
assert.equal((await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token2 } })).status, 200);
ok('暂停后拉不到，恢复后可以；收窄范围立即清空分享包；重置后旧码失效、拉取次数清零');

// 管理后台：只看元数据；强制关闭
r = await api('GET', '/iterminal/cloud/share/list', { token: admin });
assert.ok(r.json.data.some((s) => s.user_name === uname && !('code_e2e' in s) && !('lookup_hash' in s)));
r = await api('GET', `/iterminal/cloud/backup/list?userName=${uname}`, { token: admin });
assert.ok(r.json.data.length >= 2 && !('file_path' in r.json.data[0]));
await api('DELETE', `/iterminal/cloud/share/${ownerId}`, { token: admin });
assert.equal((await api('POST', '/api/v1/shares:lookup', { token: B, body: { lookupToken: token2 } })).status, 404);
assert.equal((await api('GET', '/api/v1/shares/me', { token: A })).json.data, null);
ok('管理后台：只看元数据（看不到分享码和文件路径）；强制关闭分享码');

// ---------------------------------------------------------------- 清理
for (const b of (await api('GET', '/api/v1/backups', { token: A })).json.data) await api('DELETE', `/api/v1/backups/${b.id}`, { token: A });
await api('DELETE', `/system/user/${ownerId}`, { token: admin });
console.log(`全部通过（${step} 项）`);
process.exit(0);
