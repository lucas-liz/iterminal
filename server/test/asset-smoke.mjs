// 团队主机冒烟测试：分组树、主机凭证加密、按角色可见（继承分组）、客户端同步接口。
// 用法：node test/asset-smoke.mjs http://127.0.0.1:8080   （需要关闭验证码，同 client-smoke.mjs）
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);

console.log(`iTerminal 团队主机冒烟测试：${BASE}`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');
const tag = String(Date.now()).slice(-6);

// ---------------------------------------------------------------- 分组
const folder = async (f) => {
  const r = await api('POST', '/iterminal/asset/folder', { token: admin, body: f });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
  return flat((await api('GET', '/iterminal/asset/folder/tree', { token: admin })).json.data).find((n) => n.folderName === f.folderName);
};
const prod = await folder({ folderName: `生产-${tag}`, roleKeys: 'itm_approver' });
const db = await folder({ folderName: `数据库-${tag}`, parentId: prod.folderId });
const test = await folder({ folderName: `测试-${tag}` });
const tree = (await api('GET', '/iterminal/asset/folder/tree', { token: admin })).json.data;
assert.ok(tree.find((n) => n.folderId === prod.folderId).children.some((c) => c.folderId === db.folderId));
let r = await api('PUT', '/iterminal/asset/folder', { token: admin, body: { ...prod, parentId: db.folderId, children: undefined } });
assert.match(r.json.msg, /不能移到自己或自己的下级/);
ok('分组树：多级分组；不能把分组移到自己的下级');

// ---------------------------------------------------------------- 主机
const host = async (h) => {
  const res = await api('POST', '/iterminal/asset/host', { token: admin, body: h });
  assert.equal(res.json.code, 200, JSON.stringify(res.json));
  return (await api('GET', `/iterminal/asset/host/list?hostName=${encodeURIComponent(h.hostName)}`, { token: admin })).json.rows[0];
};
const pw = `P@ss-${randomUUID()}`;
const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n';
const dbHost = await host({ folderId: db.folderId, hostName: `db-01-${tag}`, address: '10.0.1.10', port: 22, username: 'root', authMethod: 'PASSWORD', password: pw, note: '主库，谨慎操作' });
const webHost = await host({ folderId: test.folderId, hostName: `web-01-${tag}`, address: '10.0.2.10', username: 'deploy', authMethod: 'KEY', privateKey: key, passphrase: 'kp', allowReveal: '1' });
const special = await host({ folderId: test.folderId, hostName: `vip-${tag}`, address: '10.0.2.99', username: 'root', password: 'x', roleKeys: 'itm_approver' });
assert.equal(dbHost.password, '******');
assert.equal(dbHost.passwordEnc, undefined);
assert.equal(webHost.privateKey, '******');
r = await api('POST', '/iterminal/asset/host', { token: admin, body: { hostName: 'x', address: 'bad host!', port: 22 } });
assert.match(r.json.msg, /地址不正确/);
r = await api('POST', '/iterminal/asset/host', { token: admin, body: { hostName: 'x', address: '1.2.3.4', authMethod: 'KEY', privateKey: 'not a key' } });
assert.match(r.json.msg, /私钥格式不正确/);
r = await api('DELETE', `/iterminal/asset/folder/${test.folderId}`, { token: admin });
assert.match(r.json.msg, /还有下级分组或主机/);
ok('主机：密码 / 私钥加密保存，列表显示 ******；地址、私钥格式不对时提示；非空分组不能删除');

// 修改：密码保持 ****** 不变；版本号加 1
r = await api('PUT', '/iterminal/asset/host', { token: admin, body: { ...dbHost, address: '10.0.1.11' } });
assert.equal(r.json.code, 200);
const dbHost2 = (await api('GET', `/iterminal/asset/host/${dbHost.hostId}`, { token: admin })).json.data;
assert.equal(dbHost2.version, dbHost.version + 1);

// ---------------------------------------------------------------- 客户端同步
const device = async (username, password) => {
  const l = await api('POST', '/api/v1/auth/login', { body: { username, password, deviceId: `asset-dev-${randomUUID()}`, deviceName: 'asset-mac', os: 'mac', arch: 'arm64', clientVersion: '0.2.0' } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  return l.json.data;
};
const a = await device('admin', 'admin123');
let assets = (await api('GET', '/api/v1/team/assets', { token: a.accessToken })).json.data;
const mine = (names) => assets.hosts.filter((h) => names.some((n) => h.name.startsWith(n)) && h.name.endsWith(tag));
assert.equal(mine(['db-01', 'web-01', 'vip']).length, 3); // 管理员看全部
const d = assets.hosts.find((h) => h.id === dbHost.hostId);
assert.equal(d.password, pw);
assert.equal(d.address, '10.0.1.11');
assert.equal(d.allowReveal, false);
assert.equal(d.folderId, db.folderId);
const w = assets.hosts.find((h) => h.id === webHost.hostId);
assert.equal(w.privateKey, key);
assert.equal(w.passphrase, 'kp');
assert.equal(w.allowReveal, true);
assert.ok(assets.folders.some((f) => f.id === prod.folderId) && assets.folders.some((f) => f.id === db.folderId && f.parentId === prod.folderId));
assert.equal((await api('GET', '/api/v1/team/assets', { token: admin })).status, 403);
ok('客户端同步：解密后下发凭证、分组层级、是否允许查看密码；管理后台的令牌不能调用');

// 普通用户（角色 common）：看不到「生产」分组继承来的、和单独限定了角色的主机
const uname = `ast${tag}`;
r = await api('POST', '/system/user', { token: admin, body: { userName: uname, nickName: '资产测试', password: 'Test@123456', deptId: 103, roleIds: [2], status: '0' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const userId = (await api('GET', `/system/user/list?userName=${uname}`, { token: admin })).json.rows[0].userId;
const u = await device(uname, 'Test@123456');
assets = (await api('GET', '/api/v1/team/assets', { token: u.accessToken })).json.data;
const names = assets.hosts.map((h) => h.name);
assert.ok(names.includes(`web-01-${tag}`));
assert.ok(!names.includes(`db-01-${tag}`), '生产分组的角色限制被子分组继承');
assert.ok(!names.includes(`vip-${tag}`), '主机单独限定了角色');
assert.ok(!assets.folders.some((f) => f.id === prod.folderId));
ok('按角色可见：子分组继承上级分组的角色，主机可以单独限定角色；用不到的分组不下发');

// 停用的主机不下发
await api('PUT', '/iterminal/asset/host', { token: admin, body: { ...webHost, status: '1' } });
assets = (await api('GET', '/api/v1/team/assets', { token: u.accessToken })).json.data;
assert.ok(!assets.hosts.some((h) => h.id === webHost.hostId));
ok('停用的主机不再下发（客户端下次同步时删除）');

// ---------------------------------------------------------------- 清理
await api('DELETE', `/system/user/${userId}`, { token: admin });
await api('DELETE', `/iterminal/asset/host/${[dbHost, webHost, special].map((h) => h.hostId).join(',')}`, { token: admin });
for (const f of [db, prod, test]) await api('DELETE', `/iterminal/asset/folder/${f.folderId}`, { token: admin });
console.log(`全部通过（${step} 项）`);
process.exit(0);
