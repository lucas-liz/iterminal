// iTerminal 服务端冒烟测试：模拟桌面客户端和管理员，走一遍客户端会用到的全部接口。
// 用法：node test/client-smoke.mjs [服务地址]（默认 http://127.0.0.1:8080）
// 需要：Node 22+（自带 fetch 和 WebSocket）；服务端已经初始化数据库，admin / admin123 可以登录，验证码已关闭（sys.account.captchaEnabled = false）。
// 会写入测试数据（设备、审计、录像、定时任务、版本），只在测试库上运行。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const WS_BASE = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);

async function api(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

/** 一条客户端长连接：收消息、自动回 ack、按类型等待 */
function connect(ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/ws/client?ticket=${ticket}`);
    const inbox = [];
    const waiters = [];
    let closed = null;
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.ack) ws.send(JSON.stringify({ type: 'ack', id: m.id }));
      inbox.push(m);
      for (const w of [...waiters]) if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    };
    ws.onclose = (e) => {
      closed = e.code;
    };
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    ws.onopen = () =>
      resolve({
        ws,
        inbox,
        closed: () => closed,
        send: (type, payload, ack = false) => ws.send(JSON.stringify({ type, id: randomUUID(), ts: new Date().toISOString(), ...(ack ? { ack: true } : {}), payload })),
        wait: (pred, ms = 8000) =>
          new Promise((res, rej) => {
            const hit = inbox.find(pred);
            if (hit) return res(hit);
            const w = { pred, resolve: res };
            waiters.push(w);
            setTimeout(() => rej(new Error('等待消息超时')), ms);
          }),
      });
  });
}

console.log(`iTerminal 服务端冒烟测试：${BASE}`);
const deviceId = randomUUID();

// ---------------------------------------------------------------- 登录
let r = await api('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'wrong-password', deviceId } });
assert.equal(r.status, 401);
assert.match(r.json.message, /密码/);
ok('密码错误返回 401 和中文原因（若依的提示，连续错误会锁定）');

r = await api('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'admin123', deviceId, deviceName: 'smoke-mac', os: 'mac', arch: 'arm64', clientVersion: '0.1.0' } });
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.code, 0);
let { accessToken, refreshToken } = r.json.data;
assert.ok(accessToken && refreshToken);
assert.equal(r.json.data.user.userName, 'admin');
ok('客户端登录：返回访问令牌、刷新令牌和用户信息');

r = await api('GET', '/api/v1/me');
assert.equal(r.status, 401);
ok('没带令牌访问 /api/v1/me 返回 HTTP 401');

r = await api('GET', '/api/v1/me', { token: accessToken });
assert.equal(r.status, 200);
assert.equal(r.json.data.deviceId, deviceId);
assert.ok(r.json.data.permissions.includes('*:*:*'));
ok('/api/v1/me 返回当前设备和权限');

r = await api('GET', '/api/v1/ai/policy', { token: accessToken });
assert.equal(r.status, 200);
assert.ok(r.json.data.commandRules.some((x) => x.pattern === '^systemctl\\s+(restart|reload)\\b'));
assert.ok(r.json.data.maskRules.length >= 2);
ok('AI 策略：命令规则和脱敏规则');

// 管理员（若依后台登录）
r = await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const admin = r.json.token;
ok('管理后台登录');

r = await api('GET', '/api/v1/me', { token: admin });
assert.equal(r.status, 403);
ok('管理后台的令牌不能调用客户端接口（403）');

// ---------------------------------------------------------------- 长连接
r = await api('GET', '/api/v1/ws/ticket', { token: accessToken });
const ticket = r.json.data.ticket;
const client = await connect(ticket);
client.send('hello', { deviceId, clientVersion: '0.1.1', capabilities: ['executor', 'approval'] });
client.send('ping', {});
await client.wait((m) => m.type === 'pong');
ok('长连接：票据握手、hello、ping / pong');

await assert.rejects(connect(ticket));
ok('票据只能用一次');

await sleep(300);
r = await api('GET', `/iterminal/device/list?deviceName=smoke-mac`, { token: admin });
const dev = r.json.rows.find((d) => d.deviceId === deviceId);
assert.equal(dev.online, '1');
assert.equal(dev.clientVersion, '0.1.1');
assert.equal(dev.refreshTokenHash, undefined);
ok('设备列表：在线、hello 更新了版本号、不返回刷新令牌摘要');

// ---------------------------------------------------------------- 审计
const ev = randomUUID();
const item = { clientEventId: ev, kind: 'COMMAND', source: 'AGENT', hostId: 'h1', hostName: 'web-01', sessionId: 's1', command: 'systemctl restart nginx', risk: 'L1', decision: 'APPROVED', exitCode: 0, detail: { tool: 'run_command' }, occurredAt: new Date().toISOString() };
r = await api('POST', '/api/v1/audit/commands:batch', { token: accessToken, body: { items: [item, { ...item, clientEventId: randomUUID(), command: 'df -h', risk: 'L0', decision: 'AUTO' }] } });
assert.equal(r.status, 200);
assert.equal(r.json.data.accepted, 2);
r = await api('POST', '/api/v1/audit/commands:batch', { token: accessToken, body: { items: [item] } });
assert.equal(r.status, 200);
r = await api('GET', `/iterminal/audit/list?deviceId=${deviceId}`, { token: admin });
assert.equal(r.json.total, 2);
assert.equal(r.json.rows[0].userName, 'admin');
ok('命令审计批量上报；重复上报同一事件不会重复入库');

const rec = randomUUID();
const header = JSON.stringify({ version: 2, width: 80, height: 24 }) + '\n';
const meta = { sessionId: 's1', kind: 'ssh', hostId: 'h1', hostName: 'web-01', cols: 80, rows: 24, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
r = await api('POST', `/api/v1/audit/sessions/${rec}/chunks`, { token: accessToken, body: { index: 0, final: false, content: header, meta } });
assert.equal(r.status, 200);
r = await api('POST', `/api/v1/audit/sessions/${rec}/chunks`, { token: accessToken, body: { index: 2, final: true, content: 'x' } });
assert.equal(r.status, 409);
r = await api('POST', `/api/v1/audit/sessions/${rec}/chunks`, { token: accessToken, body: { index: 1, final: true, content: '[0.5,"o","hello\\r\\n"]\n' } });
assert.equal(r.status, 200);
r = await api('POST', `/api/v1/audit/sessions/${rec}/chunks`, { token: accessToken, body: { index: 1, final: true, content: '[0.5,"o","hello\\r\\n"]\n' } });
assert.equal(r.status, 200);
const cast = await (await api('GET', `/iterminal/session/${rec}/cast`, { token: admin, raw: true })).text();
assert.equal(cast, header + '[0.5,"o","hello\\r\\n"]\n');
ok('会话录像分片上传：缺片返回 409，重发的分片忽略，管理后台读到完整录像');

// ---------------------------------------------------------------- 定时任务 + 远程审批
r = await api('POST', '/iterminal/task', { token: admin, body: { taskName: '冒烟测试任务', taskType: 'COMMAND', command: 'uptime', deviceId, hosts: 'web-01\nweb-02', cronExpression: '0 0 2 * * ?', permissionCap: 'READONLY', timeoutMin: 10, status: '1' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
r = await api('GET', '/iterminal/task/list?taskName=冒烟测试任务', { token: admin });
const taskId = r.json.rows[0].taskId;
r = await api('POST', '/iterminal/task', { token: admin, body: { taskName: 'x', taskType: 'COMMAND', command: 'x', deviceId, hosts: 'a', cronExpression: 'not a cron' } });
assert.equal(r.json.code, 500);
assert.match(r.json.msg, /cron/);
ok('管理后台新建定时任务；cron 写错时提示原因');

r = await api('PUT', `/iterminal/task/run/${taskId}`, { token: admin });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const dispatch = await client.wait((m) => m.type === 'task.dispatch');
assert.equal(dispatch.ack, true);
assert.equal(dispatch.payload.command, 'uptime');
assert.deepEqual(dispatch.payload.hosts.map((h) => h.name), ['web-01', 'web-02']);
const runId = dispatch.payload.runId;
ok('立即执行：设备通过长连接收到 task.dispatch（需要确认）');

client.send('task.progress', { runId, hostId: 'web-01', status: 'RUNNING', percent: 50 }, true);
r = await api('POST', `/api/v1/sched/runs/${runId}/approvals`, { token: accessToken, body: { hostId: 'web-01', command: 'systemctl restart nginx', risk: 'L1', reasons: ['写操作'], explanation: '重启 nginx' } });
assert.equal(r.status, 200, JSON.stringify(r.json));
const approvalId = r.json.data.approvalId;
const req = await client.wait((m) => m.type === 'approval.request' && m.payload.approvalId === approvalId);
assert.equal(req.payload.command, 'systemctl restart nginx');
assert.equal(req.payload.taskName, '冒烟测试任务');
ok('执行器创建远程审批；审批人的设备收到 approval.request');

r = await api('GET', '/api/v1/approvals', { token: accessToken });
assert.ok(r.json.data.some((a) => a.approvalId === approvalId));
r = await api('PUT', `/iterminal/approval/${approvalId}/decide`, { token: admin, body: { decision: 'APPROVED', comment: '可以' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const result = await client.wait((m) => m.type === 'approval.result' && m.payload.approvalId === approvalId);
assert.equal(result.payload.decision, 'APPROVED');
r = await api('PUT', `/iterminal/approval/${approvalId}/decide`, { token: admin, body: { decision: 'REJECTED' } });
assert.equal(r.json.code, 500);
ok('管理后台批准：执行器收到 approval.result；重复处理提示已处理');

client.send('task.result', { runId, status: 'PARTIAL', summary: '成功 1 台，失败 1 台', hosts: [{ hostId: 'web-01', status: 'SUCCESS', exitCode: 0 }, { hostId: 'web-02', status: 'FAILED', exitCode: 1 }] }, true);
await sleep(500);
r = await api('GET', `/iterminal/run/${runId}`, { token: admin });
assert.equal(r.json.data.status, 'PARTIAL');
assert.equal(JSON.parse(r.json.data.hosts).length, 2);
ok('客户端回报结果：执行记录变为部分成功，保存每台主机的结果');

// ---------------------------------------------------------------- 版本发布
// 每次用不同的版本号（比之前上传的都高），可以重复运行
const ver = `9.${Date.now() % 100000}.0`;
const pkg = `iTerminal-${ver}-arm64-mac.zip`;
const fd = new FormData();
fd.append('file', new Blob([Buffer.from('fake-zip-content')]), pkg);
for (const [k, v] of Object.entries({ version: ver, channel: 'stable', os: 'mac', arch: 'arm64', rolloutPercent: '30', minVersion: '0.1.0', releaseNotes: '修复了一些问题\n新增定时任务' })) fd.append(k, v);
r = await api('POST', '/iterminal/release/upload', { token: admin, body: fd });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const releaseId = r.json.data.releaseId;
const feed = await (await fetch(`${BASE}/api/v1/releases/stable/mac/arm64/latest-mac.yml`)).text();
assert.match(feed, new RegExp(`^version: ${ver.replaceAll('.', '\\.')}$`, 'm'));
assert.match(feed, /stagingPercentage: 30/);
assert.match(feed, /minimumSupportedVersion: '0\.1\.0'/);
assert.ok(feed.includes(`path: '${pkg}'`), feed);
const part = await fetch(`${BASE}/api/v1/releases/stable/mac/arm64/${pkg}`, { headers: { range: 'bytes=0-3' } });
assert.equal(part.status, 206);
assert.equal(await part.text(), 'fake');
assert.equal((await fetch(`${BASE}/api/v1/releases/stable/win/x64/latest.yml`)).status, 404);
ok('版本发布：不登录也能拉取 latest-mac.yml（灰度、最低版本），安装包支持断点续传');

// ---------------------------------------------------------------- 刷新令牌、吊销
r = await api('POST', '/api/v1/auth/refresh', { body: { deviceId, refreshToken } });
assert.equal(r.status, 200);
const rotated = r.json.data.refreshToken;
r = await api('POST', '/api/v1/auth/refresh', { body: { deviceId, refreshToken } });
assert.equal(r.status, 401);
accessToken = (await api('POST', '/api/v1/auth/refresh', { body: { deviceId, refreshToken: rotated } })).json.data.accessToken;
assert.equal((await api('GET', '/api/v1/me', { token: accessToken })).status, 200);
ok('刷新令牌每次使用后轮换，旧的不能再用');

r = await api('PUT', `/iterminal/device/${deviceId}/revoke`, { token: admin });
assert.equal(r.json.code, 200);
await client.wait((m) => m.type === 'device.revoked');
await sleep(300);
assert.ok(client.closed() !== null);
assert.equal((await api('GET', '/api/v1/me', { token: accessToken })).status, 401);
ok('吊销设备：客户端收到 device.revoked 并断开，令牌立即失效');

// 清理测试任务和测试安装包
await api('DELETE', `/iterminal/task/${taskId}`, { token: admin });
await api('DELETE', `/iterminal/release/${releaseId}`, { token: admin });
console.log(`全部通过（${step} 项）`);
process.exit(0);
