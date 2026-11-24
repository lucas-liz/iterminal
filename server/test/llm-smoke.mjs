// 大模型代理冒烟测试：在本机模拟 OpenAI 兼容和 Anthropic 的上游，验证服务端换 Key 转发（含流式）、用量统计、限流、角色权限。
// 用法：node test/llm-smoke.mjs http://127.0.0.1:8080   （需要关闭验证码，同 client-smoke.mjs）
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const UP_PORT = 18092;
const UP = `http://127.0.0.1:${UP_PORT}`;
const KEY = { openai: `sk-up-${randomUUID()}`, anthropic: `sk-ant-${randomUUID()}` };
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);

// ---------------------------------------------------------------- 模拟上游
const seen = [];
const upstream = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, path: req.url, headers: req.headers, body });
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url.startsWith('/openai/')) {
      if (req.headers.authorization !== `Bearer ${KEY.openai}`) return json(401, { error: { message: 'bad key' } });
      if (req.method === 'GET' && req.url === '/openai/models') return json(200, { data: [{ id: 'qwen-max' }, { id: 'qwen-plus' }] });
      if (req.url === '/openai/chat/completions') {
        if (!body.stream) return json(200, { choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { prompt_tokens: 11, completion_tokens: 2 } });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const parts = ['你', '好', '，', '我是团队模型'];
        let i = 0;
        const timer = setInterval(() => {
          if (i < parts.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
            return;
          }
          clearInterval(timer);
          if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } })}\n\n`);
          res.end('data: [DONE]\n\n');
        }, 30);
        return;
      }
    }
    if (req.url.startsWith('/anthropic/')) {
      if (req.headers['x-api-key'] !== KEY.anthropic) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
      if (req.url === '/anthropic/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('message_start', { message: { id: 'm1', usage: { input_tokens: 50, output_tokens: 1 } } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'pong' } });
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
        ev('message_stop', {});
        return res.end();
      }
    }
    json(404, { error: { message: 'not found' } });
  });
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

async function api(method, path, { token, body, headers = {}, raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}
const setConfig = async (admin, key, value) => {
  const cfg = (await api('GET', `/system/config/list?configKey=${key}`, { token: admin })).json.rows[0];
  const r = await api('PUT', '/system/config', { token: admin, body: { ...cfg, configValue: value } });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
};

console.log(`iTerminal 大模型代理冒烟测试：${BASE}`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');
const tag = Date.now();
const models = JSON.stringify([{ id: 'qwen-max', displayName: '通义千问 Max', contextWindow: 32000, maxOutput: 8192, supportsImages: false }]);

// ---------------------------------------------------------------- 管理后台：提供商
let r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: `千问-${tag}`, providerType: 'OPENAI_COMPAT', baseUrl: `${UP}/openai/`, apiKey: KEY.openai, models, thinkingStyle: 'qwen' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: `Claude-${tag}`, providerType: 'ANTHROPIC', baseUrl: `${UP}/anthropic`, apiKey: KEY.anthropic, models: JSON.stringify([{ id: 'claude-sonnet-5-5', contextWindow: 200000, maxOutput: 64000 }]), thinkingStyle: 'anthropic' } });
assert.equal(r.json.code, 200);
r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: `受限-${tag}`, providerType: 'OPENAI', baseUrl: `${UP}/openai`, apiKey: KEY.openai, models, roleKeys: 'itm_approver' } });
assert.equal(r.json.code, 200);
const list = (await api('GET', `/iterminal/llm/provider/list?providerName=${tag}`, { token: admin })).json.rows;
const qwen = list.find((p) => p.providerName.startsWith('千问'));
const claude = list.find((p) => p.providerName.startsWith('Claude'));
const limited = list.find((p) => p.providerName.startsWith('受限'));
assert.equal(qwen.apiKey, '******');
assert.equal(qwen.apiKeyEnc, undefined);
assert.equal(qwen.baseUrl, `${UP}/openai`);
r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: 'x', providerType: 'OPENAI', baseUrl: 'ftp://x', models } });
assert.match(r.json.msg, /接口地址/);
r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: 'x', providerType: 'OPENAI', baseUrl: 'https://x', models: '[]' } });
assert.match(r.json.msg, /至少添加一个模型/);
ok('新建团队模型：Key 加密保存、列表显示 ******；地址和模型列表不对时提示');

r = await api('POST', '/iterminal/llm/provider/test', { token: admin, body: { ...qwen } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
assert.equal(r.json.data.reply, 'pong');
r = await api('POST', '/iterminal/llm/provider/fetchModels', { token: admin, body: { ...qwen } });
assert.deepEqual(r.json.data, ['qwen-max', 'qwen-plus']);
r = await api('POST', '/iterminal/llm/provider/test', { token: admin, body: { ...qwen, apiKey: 'sk-wrong' } });
assert.equal(r.json.code, 500);
assert.match(r.json.msg, /HTTP 401/);
ok('测试连接、拉取模型列表（Key 为 ****** 时用已保存的；填错 Key 时提示 401）');

// ---------------------------------------------------------------- 客户端
const deviceId = `llm-dev-${randomUUID()}`;
const login = await api('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'admin123', deviceId, deviceName: 'llm-mac', os: 'mac', arch: 'arm64', clientVersion: '0.2.0' } });
const client = login.json.data.accessToken;
r = await api('GET', '/api/v1/ai/models', { token: client });
const mine = r.json.data.filter((p) => p.name.endsWith(String(tag)));
assert.equal(mine.length, 3); // 管理员能用所有模型
const m = mine.find((p) => p.id === String(qwen.providerId));
assert.equal(m.type, 'OPENAI_COMPAT');
assert.equal(m.thinkingStyle, 'qwen');
assert.equal(m.models[0].displayName, '通义千问 Max');
assert.ok(!JSON.stringify(r.json).includes(KEY.openai));
assert.equal((await api('GET', '/api/v1/ai/models', { token: admin })).status, 403);
r = await api('GET', '/api/v1/ai/policy', { token: client });
assert.equal(r.json.data.allowPersonalProvider, true);
ok('客户端拉取团队模型：不含 Key；管理后台的令牌不能用；AI 策略里带「允许个人模型」');

// 流式对话（OpenAI SDK 的写法：Authorization: Bearer 登录令牌，带 stream_options）
const before = seen.length;
let res = await api('POST', `/api/v1/llm/proxy/${qwen.providerId}/chat/completions`, {
  token: client,
  raw: true,
  body: { model: 'qwen-max', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: '你好' }] },
});
assert.equal(res.status, 200);
assert.match(res.headers.get('content-type'), /text\/event-stream/);
const sse = await res.text();
const text = sse.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '').join('');
assert.equal(text, '你好，我是团队模型');
const up = seen[before];
assert.equal(up.path, '/openai/chat/completions');
assert.equal(up.headers.authorization, `Bearer ${KEY.openai}`);
assert.ok(!JSON.stringify(up.headers).includes(client), '登录令牌不能转发给上游');
ok('OpenAI 兼容：流式原样转发，上游收到的是真实 Key、收不到登录令牌');

// Anthropic SDK 的写法：x-api-key 放登录令牌
res = await api('POST', `/api/v1/llm/proxy/${claude.providerId}/v1/messages`, {
  raw: true,
  headers: { 'x-api-key': client, 'anthropic-version': '2023-06-01' },
  body: { model: 'claude-sonnet-5-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'ping' }] },
});
assert.equal(res.status, 200);
assert.match(await res.text(), /"text":"pong"/);
const upA = seen.at(-1);
assert.equal(upA.headers['x-api-key'], KEY.anthropic);
assert.equal(upA.headers['anthropic-version'], '2023-06-01');
ok('Anthropic：x-api-key 里的登录令牌被换成真实 Key，anthropic-version 透传');

// 不允许的接口、没有令牌
assert.equal((await api('POST', `/api/v1/llm/proxy/${qwen.providerId}/files`, { token: client, body: {} })).status, 404);
assert.equal((await api('POST', `/api/v1/llm/proxy/${qwen.providerId}/chat/completions`, { body: {} })).status, 401);
r = await api('POST', `/api/v1/llm/proxy/999999/chat/completions`, { token: client, body: { model: 'x' } });
assert.equal(r.status, 404);
assert.match(r.json.error.message, /不存在或已停用/);
ok('只转发对话 / 模型列表等接口；没有令牌 401；提供商不存在时按 OpenAI 格式返回错误');

// ---------------------------------------------------------------- 用量
await new Promise((r2) => setTimeout(r2, 300));
r = await api('GET', `/iterminal/llm/usage/list?providerId=${qwen.providerId}`, { token: admin });
const u = r.json.rows[0];
assert.equal(u.inputTokens, 120);
assert.equal(u.outputTokens, 30);
assert.equal(u.estimated, '0');
assert.equal(u.model, 'qwen-max');
r = await api('GET', `/iterminal/llm/usage/list?providerId=${claude.providerId}`, { token: admin });
assert.equal(r.json.rows[0].inputTokens, 50);
assert.equal(r.json.rows[0].outputTokens, 7);
r = await api('GET', `/iterminal/llm/usage/summary?userName=admin`, { token: admin });
assert.ok(r.json.rows.some((x) => x.providerName === qwen.providerName && Number(x.inputTokens) >= 120));
ok('用量：从流式响应里读出 token（OpenAI 的 usage、Anthropic 的 message_start / message_delta），按用户和模型汇总');

// ---------------------------------------------------------------- 限流
await setConfig(admin, 'itm.llm.rpm', '1');
await new Promise((r2) => setTimeout(r2, 61_000 - (Date.now() % 60_000) + 200)); // 等到下一分钟
const call = () => api('POST', `/api/v1/llm/proxy/${qwen.providerId}/chat/completions`, { token: client, body: { model: 'qwen-max', messages: [{ role: 'user', content: 'hi' }] } });
assert.equal((await call()).status, 200);
r = await call();
assert.equal(r.status, 429);
assert.match(r.json.error.message, /每分钟最多 1 次/);
await setConfig(admin, 'itm.llm.rpm', '30');
await setConfig(admin, 'itm.llm.dailyTokenLimit', '100');
await new Promise((r2) => setTimeout(r2, 61_000 - (Date.now() % 60_000) + 200));
r = await call();
assert.equal(r.status, 429);
assert.match(r.json.error.message, /额度已经用完/);
await setConfig(admin, 'itm.llm.dailyTokenLimit', '0');
ok('限流：每分钟请求数、每天 token 额度超出时返回 429 和原因');

// ---------------------------------------------------------------- 角色权限
const uname = `llm${String(tag).slice(-6)}`;
r = await api('POST', '/system/user', { token: admin, body: { userName: uname, nickName: '模型测试', password: 'Test@123456', deptId: 103, roleIds: [2], status: '0' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const userId = (await api('GET', `/system/user/list?userName=${uname}`, { token: admin })).json.rows[0].userId;
const l2 = await api('POST', '/api/v1/auth/login', { body: { username: uname, password: 'Test@123456', deviceId: `llm-dev2-${randomUUID()}`, deviceName: 'llm-mac-2', os: 'mac', arch: 'arm64', clientVersion: '0.2.0' } });
assert.equal(l2.status, 200, JSON.stringify(l2.json));
const c2 = l2.json.data.accessToken;
const names = (await api('GET', '/api/v1/ai/models', { token: c2 })).json.data.map((p) => p.id);
assert.ok(names.includes(String(qwen.providerId)));
assert.ok(!names.includes(String(limited.providerId)));
r = await api('POST', `/api/v1/llm/proxy/${limited.providerId}/chat/completions`, { token: c2, body: { model: 'qwen-max', messages: [] } });
assert.equal(r.status, 403);
ok('角色权限：限定了角色的团队模型，其他角色的用户看不到也调不了');

// ---------------------------------------------------------------- 清理
await api('DELETE', `/system/user/${userId}`, { token: admin });
await api('DELETE', `/iterminal/llm/provider/${[qwen, claude, limited].map((p) => p.providerId).join(',')}`, { token: admin });
await api('PUT', `/iterminal/device/${deviceId}/revoke`, { token: admin });
upstream.close();
console.log(`全部通过（${step} 项）`);
process.exit(0);
