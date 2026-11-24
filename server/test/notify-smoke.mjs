// 通知冒烟测试：在本机模拟钉钉 / 企业微信 / 飞书机器人、通用 Webhook 和 SMTP 服务器，验证服务端的通知（加签、@、重试、发送记录）。
// 服务端需要这样启动（邮件发到本机 2525 端口的模拟 SMTP）：
//   ITM_SMTP_HOST=127.0.0.1 ITM_SMTP_PORT=2525 ITM_SMTP_AUTH=false ITM_SMTP_SSL=false ITM_SMTP_FROM=itm@example.com java -jar ruoyi-admin.jar
// 用法：node test/notify-smoke.mjs http://127.0.0.1:8080   （需要关闭验证码，同 client-smoke.mjs）
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcp } from 'node:net';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const HOOK_PORT = 18091;
const SMTP_PORT = 2525;
const HOOK = `http://127.0.0.1:${HOOK_PORT}`;
const SECRET = { dingtalk: 'SEC-ding-' + randomUUID(), feishu: 'fs-' + randomUUID(), webhook: 'wh-' + randomUUID() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);

// ---------------------------------------------------------------- 模拟机器人和 Webhook
const hooks = [];
const hmac = (key, data, enc = 'base64') => createHmac('sha256', key).update(data).digest(enc);
const hookServer = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, HOOK);
    const body = raw ? JSON.parse(raw) : null;
    const rec = { path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body, raw, signOk: null };
    const reply = (status, json) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    if (url.pathname === '/dingtalk') {
      const ts = url.searchParams.get('timestamp');
      rec.signOk = url.searchParams.get('sign') === hmac(SECRET.dingtalk, `${ts}\n${SECRET.dingtalk}`) && Math.abs(Date.now() - Number(ts)) < 60_000;
      hooks.push(rec);
      return reply(200, rec.signOk ? { errcode: 0, errmsg: 'ok' } : { errcode: 310000, errmsg: 'sign not match' });
    }
    if (url.pathname === '/wecom') {
      hooks.push(rec);
      return reply(200, { errcode: 0, errmsg: 'ok' });
    }
    if (url.pathname === '/feishu') {
      rec.signOk = body?.sign === hmac(`${body?.timestamp}\n${SECRET.feishu}`, '');
      hooks.push(rec);
      return reply(200, rec.signOk ? { code: 0, msg: 'success' } : { code: 19021, msg: 'sign match fail' });
    }
    if (url.pathname === '/webhook') {
      rec.signOk = req.headers['x-itm-signature'] === `sha256=${hmac(SECRET.webhook, raw, 'hex')}`;
      hooks.push(rec);
      return reply(rec.signOk ? 200 : 401, {});
    }
    hooks.push(rec);
    reply(500, { error: 'boom' });
  });
});

// ---------------------------------------------------------------- 模拟 SMTP（只收不发）
const mails = [];
const smtp = createTcp((sock) => {
  let buf = '';
  let data = false;
  let mail = { from: '', to: [], data: '' };
  sock.write('220 mock-smtp ready\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    for (;;) {
      if (data) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mail.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        data = false;
        mails.push(mail);
        mail = { from: '', to: [], data: '' };
        sock.write('250 OK queued\r\n');
        continue;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-mock-smtp\r\n250 8BITMIME\r\n');
      else if (cmd === 'MAIL') (mail.from = line), sock.write('250 OK\r\n');
      else if (cmd === 'RCPT') mail.to.push(line), sock.write('250 OK\r\n');
      else if (cmd === 'DATA') (data = true), sock.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      else if (cmd === 'QUIT') sock.end('221 Bye\r\n');
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => undefined);
});

await new Promise((r) => hookServer.listen(HOOK_PORT, '127.0.0.1', r));
await new Promise((r) => smtp.listen(SMTP_PORT, '127.0.0.1', r));

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
const waitFor = async (fn, ms = 15_000, what = '') => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`等待超时：${what}`);
    await sleep(200);
  }
};

console.log(`iTerminal 通知冒烟测试：${BASE}`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');

// 管理后台地址：消息里带「在管理后台查看」链接
const cfg = (await api('GET', '/system/config/list?configKey=itm.admin.url', { token: admin })).json.rows[0];
await api('PUT', '/system/config', { token: admin, body: { ...cfg, configValue: 'https://ops.example.com' } });

// ---------------------------------------------------------------- 渠道
const created = [];
async function channel(c) {
  const r = await api('POST', '/iterminal/notify/channel', { token: admin, body: c });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
  const list = (await api('GET', `/iterminal/notify/channel/list?channelName=${encodeURIComponent(c.channelName)}`, { token: admin })).json.rows;
  created.push(list[0].channelId);
  return list[0];
}
const tag = Date.now();
const ding = await channel({ channelName: `钉钉-${tag}`, channelType: 'DINGTALK', webhook: `${HOOK}/dingtalk?access_token=abc`, secret: SECRET.dingtalk, mention: '13800000000', events: 'TASK_OFFLINE,APPROVAL_REQUEST' });
await channel({ channelName: `企微-${tag}`, channelType: 'WECOM', webhook: `${HOOK}/wecom?key=k1`, events: 'TASK_OFFLINE' });
await channel({ channelName: `飞书-${tag}`, channelType: 'FEISHU', webhook: `${HOOK}/feishu`, secret: SECRET.feishu, events: 'TASK_OFFLINE' });
await channel({ channelName: `邮件-${tag}`, channelType: 'EMAIL', recipients: 'ops@example.com, dev@example.com', events: 'TASK_OFFLINE' });
await channel({ channelName: `Webhook-${tag}`, channelType: 'WEBHOOK', webhook: `${HOOK}/webhook`, secret: SECRET.webhook, events: 'AUDIT_HIGH_RISK,APPROVAL_REQUEST' });
const bad = await channel({ channelName: `坏的-${tag}`, channelType: 'WEBHOOK', webhook: `${HOOK}/fail`, events: 'TASK_OFFLINE' });
assert.equal(ding.secret, '******');
let r = await api('POST', '/iterminal/notify/channel', { token: admin, body: { channelName: 'x', channelType: 'EMAIL', recipients: 'not-an-email', events: 'TASK_FAILED' } });
assert.match(r.json.msg, /邮箱格式不正确/);
r = await api('POST', '/iterminal/notify/channel', { token: admin, body: { channelName: 'x', channelType: 'DINGTALK', webhook: 'ftp://x', events: 'TASK_FAILED' } });
assert.match(r.json.msg, /Webhook 地址/);
ok('新建渠道：列表里密钥显示为 ******；邮箱、地址格式不对时提示');

// 修改时密钥保持 ******：不覆盖原来的密钥
r = await api('PUT', '/iterminal/notify/channel', { token: admin, body: { ...ding, remark: '改了备注' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
r = await api('POST', '/iterminal/notify/channel/test', { token: admin, body: { ...ding } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const t = hooks.find((h) => h.path === '/dingtalk');
assert.equal(t.signOk, true);
assert.equal(t.body.msgtype, 'markdown');
assert.match(t.body.markdown.text, /通知渠道测试/);
assert.deepEqual(t.body.at.atMobiles, ['13800000000']);
r = await api('POST', '/iterminal/notify/channel/test', { token: admin, body: { ...bad } });
assert.equal(r.json.code, 500);
assert.match(r.json.msg, /发送失败：HTTP 500/);
ok('发送测试：钉钉加签正确、@ 手机号；修改时没改的密钥保持不变；失败时返回原因');

// ---------------------------------------------------------------- 事件：设备离线（任务没派发）
const deviceId = `notify-dev-${randomUUID()}`;
const login = await api('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'admin123', deviceId, deviceName: 'notify-mac', os: 'mac', arch: 'arm64', clientVersion: '0.2.0' } });
assert.equal(login.status, 200, JSON.stringify(login.json));
const client = login.json.data.accessToken;
r = await api('POST', '/iterminal/task', { token: admin, body: { taskName: `通知测试-${tag}`, taskType: 'COMMAND', command: 'uptime', deviceId, hosts: 'web-01', cronExpression: '0 0 3 * * ?', status: '1' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const taskId = (await api('GET', `/iterminal/task/list?taskName=${encodeURIComponent(`通知测试-${tag}`)}`, { token: admin })).json.rows[0].taskId;
const before = hooks.length;
r = await api('PUT', `/iterminal/task/run/${taskId}`, { token: admin });
assert.equal(r.json.code, 601); // 设备不在线：warn
const runId = r.json.data.runId;
await waitFor(() => ['/dingtalk', '/wecom', '/feishu'].every((p) => hooks.slice(before).some((h) => h.path === p)) && mails.length > 0, 15_000, '钉钉 / 企微 / 飞书 / 邮件');
const off = hooks.slice(before);
const d = off.find((h) => h.path === '/dingtalk');
assert.equal(d.signOk, true);
assert.match(d.body.markdown.text, /设备离线/);
assert.match(d.body.markdown.text, /notify-mac（admin）/);
assert.match(d.body.markdown.text, /\[在管理后台查看\]\(https:\/\/ops\.example\.com\/iterminal\/run\?taskId=/);
const w = off.find((h) => h.path === '/wecom');
assert.equal(w.body.msgtype, 'markdown');
const f = off.find((h) => h.path === '/feishu');
assert.equal(f.signOk, true);
assert.match(f.body.content.text, /【iTerminal】定时任务没有执行/);
const mail = mails.at(-1);
assert.equal(mail.to.length, 2);
assert.match(mail.data, /Subject: =\?UTF-8\?/i);
assert.match(mail.data, /text\/html/);
ok('设备离线：钉钉（加签、Markdown、管理后台链接）、企业微信、飞书（加签）、邮件（2 个收件人、HTML）都收到');

// 失败的渠道：重试一次后记失败
await waitFor(() => hooks.slice(before).filter((h) => h.path === '/fail').length >= 2, 15_000, '失败渠道重试');
await sleep(500);
const logs = (await api('GET', `/iterminal/notify/log/list?channelId=${bad.channelId}`, { token: admin })).json.rows;
assert.ok(logs.some((l) => l.status === '1' && /重试后仍然失败/.test(l.error)), JSON.stringify(logs));
const okLogs = (await api('GET', `/iterminal/notify/log/list?channelId=${ding.channelId}&status=0`, { token: admin })).json.rows;
assert.ok(okLogs.some((l) => l.event === 'TASK_OFFLINE'));
ok('发送失败时 5 秒后重试一次，仍失败记进发送记录；成功的也有记录');

// ---------------------------------------------------------------- 事件：等待审批
const b2 = hooks.length;
r = await api('POST', `/api/v1/sched/runs/${runId}/approvals`, { token: client, body: { hostId: 'web-01', hostName: 'web-01', command: 'systemctl restart nginx', risk: 'L1', reasons: ['重启服务'], explanation: '服务无响应，尝试重启' } });
assert.equal(r.status, 200, JSON.stringify(r.json));
await waitFor(() => hooks.slice(b2).some((h) => h.path === '/dingtalk') && hooks.slice(b2).some((h) => h.path === '/webhook'), 15_000, '审批通知');
const ap = hooks.slice(b2).find((h) => h.path === '/webhook');
assert.equal(ap.signOk, true);
assert.equal(ap.headers['x-itm-event'], 'APPROVAL_REQUEST');
assert.equal(ap.body.fields['命令'], 'systemctl restart nginx');
assert.equal(ap.body.link, 'https://ops.example.com/iterminal/approval');
ok('等待审批：钉钉和 Webhook 都收到（Webhook 带 HMAC 签名、事件头、字段和链接）');

// ---------------------------------------------------------------- 事件：高危命令
const b3 = hooks.length;
const items = [
  { clientEventId: `ev-${randomUUID()}`, kind: 'COMMAND', source: 'AGENT', hostName: 'db-01', command: 'rm -rf /var/lib/mysql-old', risk: 'L2', decision: 'APPROVED', occurredAt: new Date().toISOString() },
  { clientEventId: `ev-${randomUUID()}`, kind: 'COMMAND', source: 'USER', hostName: 'db-01', command: 'ls', risk: 'L0', decision: 'AUTO', occurredAt: new Date().toISOString() },
];
r = await api('POST', '/api/v1/audit/commands:batch', { token: client, body: { items } });
assert.equal(r.status, 200);
await waitFor(() => hooks.slice(b3).some((h) => h.path === '/webhook'), 15_000, '高危命令');
const hr = hooks.slice(b3).find((h) => h.path === '/webhook');
assert.equal(hr.body.event, 'AUDIT_HIGH_RISK');
assert.match(hr.body.text, /rm -rf \/var\/lib\/mysql-old/);
assert.doesNotMatch(hr.body.text, /：ls（/);
// 重发同一批：不重复通知
const b4 = hooks.length;
await api('POST', '/api/v1/audit/commands:batch', { token: client, body: { items } });
await sleep(3000);
assert.equal(hooks.slice(b4).filter((h) => h.path === '/webhook').length, 0);
ok('高危命令：只通知高危的那条；客户端重发同一批不重复通知');

// ---------------------------------------------------------------- 清理
await api('DELETE', `/iterminal/notify/channel/${created.join(',')}`, { token: admin });
await api('DELETE', `/iterminal/task/${taskId}`, { token: admin });
await api('PUT', `/iterminal/device/${deviceId}/revoke`, { token: admin });
await api('PUT', '/system/config', { token: admin, body: { ...cfg, configValue: '' } });
hookServer.close();
smtp.close();
console.log(`全部通过（${step} 项）`);
process.exit(0);
