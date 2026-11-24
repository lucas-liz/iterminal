// 联网搜索冒烟测试（第二十五轮）：管理后台配置搜索服务（Key 加密、显示 ******）、客户端经服务端搜索 / 读取网页（Key 不下发）、
// 自定义格式（Kimi 风格的字段）、每人每天次数、团队模型代理不再转发 /v1/tools/*。
// 用法：node test/web-search-smoke.mjs http://127.0.0.1:18080   （需要关闭验证码，同 client-smoke.mjs）
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const UP_PORT = 18093;
const UP = `http://127.0.0.1:${UP_PORT}`;
const KEY = `sk-web-${randomUUID()}`;
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);

// ---------------------------------------------------------------- 模拟搜索服务：DeepSeek 格式（/ds）和 Kimi 格式（/kimi）
const seen = [];
const upstream = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ path: req.url, headers: req.headers, body });
    const json = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: 'Authentication Fails' } });
    if (req.url === '/ds/v1/tools/search') return json(200, { results: [{ title: 'Nginx 502', url: 'https://nginx.org/502', snippet: '短', summary: '长摘要', site_name: 'nginx.org', date: '2026-06-01T00:00:00Z' }] });
    if (req.url === '/ds/v1/tools/fetch') return json(200, { title: '示例', content: `# 示例\n${body.url}` });
    if (req.url === '/kimi/search') return json(200, { search_results: [{ title: 'K', url: 'https://kimi.example/a', snippet: 'k 摘要', site_name: 'kimi', date: '' }] });
    json(404, { error: { message: 'not found' } });
  });
});
await new Promise((r) => upstream.listen(UP_PORT, '127.0.0.1', r));

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
  return { status: res.status, json, text };
}

console.log(`iTerminal 联网搜索冒烟测试：${BASE}`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');
const deviceId = `web-dev-${randomUUID()}`;
const client = (await api('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'admin123', deviceId, deviceName: 'web-mac', os: 'mac', arch: 'arm64', clientVersion: '1.0.0' } })).json.data.accessToken;

// ---------------------------------------------------------------- 没配置时
let r = await api('PUT', '/iterminal/llm/web', { token: admin, body: { enabled: false, format: 'deepseek', apiKey: '', count: 8 } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
r = await api('GET', '/api/v1/ai/web', { token: client });
assert.deepEqual(r.json.data, { enabled: false });
r = await api('POST', '/api/v1/ai/web/search', { token: client, body: { query: 'x' } });
assert.equal(r.status, 404);
assert.match(r.json.message, /还没有配置联网搜索/);
ok('没配置时：客户端看到 enabled = false，搜索返回 404 + 说明');

// ---------------------------------------------------------------- DeepSeek 格式
r = await api('PUT', '/iterminal/llm/web', { token: admin, body: { enabled: true, format: 'deepseek', baseUrl: `${UP}/ds/v1/`, apiKey: KEY, count: 6, label: '公司 DeepSeek', dailyLimit: 0 } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
r = await api('GET', '/iterminal/llm/web', { token: admin });
assert.equal(r.json.data.apiKey, '******');
assert.equal(r.json.data.baseUrl, `${UP}/ds/v1`);
r = await api('PUT', '/iterminal/llm/web', { token: admin, body: { ...r.json.data } }); // ****** 表示不修改
assert.equal(r.json.code, 200);
r = await api('POST', '/iterminal/llm/web/test', { token: admin, body: { ...(await api('GET', '/iterminal/llm/web', { token: admin })).json.data } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
assert.equal(r.json.data.results[0].url, 'https://nginx.org/502');
ok('管理后台：保存后 Key 显示 ******、再次保存不丢 Key；测试搜索走根地址下的 /v1/tools/search');

r = await api('GET', '/api/v1/ai/web', { token: client });
assert.deepEqual(r.json.data, { enabled: true, format: 'deepseek', label: '公司 DeepSeek', count: 6, fetch: true });
assert.ok(!r.text.includes(KEY));
const before = seen.length;
r = await api('POST', '/api/v1/ai/web/search', { token: client, body: { query: 'nginx 502'.padEnd(200, '!'), count: 3 } });
assert.equal(r.status, 200, r.text);
assert.deepEqual(r.json.data.results[0], { title: 'Nginx 502', url: 'https://nginx.org/502', site_name: 'nginx.org', date: '2026-06-01T00:00:00Z', snippet: '短', summary: '长摘要' });
assert.equal(seen[before].path, '/ds/v1/tools/search');
assert.equal(seen[before].body.query.length, 128);
assert.equal(seen[before].body.count, 3);
assert.ok(!JSON.stringify(seen[before].headers).includes(client), '登录令牌不能发给搜索服务');
r = await api('POST', '/api/v1/ai/web/fetch', { token: client, body: { url: 'https://nginx.org/502' } });
assert.deepEqual(r.json.data, { title: '示例', content: '# 示例\nhttps://nginx.org/502' });
r = await api('POST', '/api/v1/ai/web/fetch', { token: client, body: { url: 'https://user:pw@x.example/' } });
assert.equal(r.status, 400);
assert.equal((await api('POST', '/api/v1/ai/web/search', { body: { query: 'x' } })).status, 401);
ok('客户端：不含 Key；搜索词截到 128 字、换上真实 Key 转发；读取网页；带账号密码的网址拒绝；没登录 401');

// ---------------------------------------------------------------- Key 不对、自定义格式、每人每天次数
await api('PUT', '/iterminal/llm/web', { token: admin, body: { enabled: true, format: 'deepseek', baseUrl: `${UP}/ds`, apiKey: 'sk-wrong', count: 6, dailyLimit: 0 } });
r = await api('POST', '/api/v1/ai/web/search', { token: client, body: { query: 'x' } });
assert.equal(r.status, 502);
assert.match(r.json.message, /API Key 无效/);
ok('搜索服务的 Key 不对：返回 502 + 「请联系管理员」，不会让客户端以为登录过期');

r = await api('PUT', '/iterminal/llm/web', { token: admin, body: { enabled: true, format: 'custom', searchUrl: `${UP}/kimi/search`, fetchUrl: '', apiKey: KEY, count: 4, dailyLimit: 0 } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
r = await api('GET', '/api/v1/ai/web', { token: client });
assert.deepEqual(r.json.data, { enabled: true, format: 'custom', label: '自定义搜索', count: 4, fetch: false });
r = await api('POST', '/api/v1/ai/web/search', { token: client, body: { query: 'kimi', count: 2 } });
assert.equal(r.json.data.results[0].url, 'https://kimi.example/a');
assert.deepEqual(seen.at(-1).body, { query: 'kimi', count: 2, text_query: 'kimi', limit: 2 });
r = await api('POST', '/api/v1/ai/web/fetch', { token: client, body: { url: 'https://kimi.example/a' } });
assert.equal(r.status, 400);
assert.match(r.json.message, /没有配置网页读取接口/);
// 每人每天次数（Redis 里按天计数，重复运行时前面的调用也算）：限 1 次时第二次一定超限
await api('PUT', '/iterminal/llm/web', { token: admin, body: { enabled: true, format: 'custom', searchUrl: `${UP}/kimi/search`, fetchUrl: '', apiKey: KEY, count: 4, dailyLimit: 1 } });
await api('POST', '/api/v1/ai/web/search', { token: client, body: { query: 'kimi' } });
r = await api('POST', '/api/v1/ai/web/search', { token: client, body: { query: 'kimi' } });
assert.equal(r.status, 429);
assert.match(r.json.message, /每人每天 1 次/);
ok('自定义格式（Kimi 的字段名）：同时带 query / text_query；没有读取接口时不能读网页；超过每人每天次数 429');

// ---------------------------------------------------------------- 团队模型代理不再转发 /v1/tools/*
const models = JSON.stringify([{ id: 'deepseek-flash', contextWindow: 100000, maxOutput: 8000, thinkingControl: 'effort', supportsTools: false, imageFormat: 'base64', efforts: ['minimal', 'high', 'bogus'] }]);
r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: `DS-${Date.now()}`, providerType: 'OPENAI_COMPAT', baseUrl: 'https://api.deepseek.com', apiKey: KEY, models, thinkingStyle: 'thinking-type' } });
assert.equal(r.json.code, 200);
const p = (await api('GET', '/api/v1/ai/models', { token: client })).json.data.find((x) => x.name.startsWith('DS-'));
assert.equal(p.webSearch, undefined);
assert.deepEqual(p.models[0], { id: 'deepseek-flash', contextWindow: 100000, maxOutput: 8000, supportsImages: false, efforts: ['minimal', 'high'], thinkingControl: 'effort', supportsTools: false, imageFormat: 'base64' });
r = await api('POST', `/api/v1/llm/proxy/${p.id}/v1/tools/search`, { token: client, body: { query: 'x' } });
assert.equal(r.status, 404);
await api('DELETE', `/iterminal/llm/provider/${p.id}`, { token: admin });
await api('PUT', '/iterminal/llm/web', { token: admin, body: { enabled: false, format: 'deepseek', apiKey: '', count: 8, dailyLimit: 500 } });
ok('团队模型：带上思考方式 / 工具调用 / 图片格式，不再有 webSearch；代理不再转发 /v1/tools/search');

upstream.close();
console.log('全部通过');
