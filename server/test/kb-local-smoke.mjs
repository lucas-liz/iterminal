// 知识库本地向量模型冒烟测试：用真实的本地向量服务（Ollama + bge-m3，OpenAI 兼容接口）生成向量，
// 验证「本地向量服务」配置（地址补全、表单测试、保存后自动重建向量）和纯语义检索（问法和原文没有相同的词也能找到）。
// 用法：node test/kb-local-smoke.mjs http://127.0.0.1:8080 [http://127.0.0.1:11434] [bge-m3]
//   第二个参数是本地向量服务地址（默认 Ollama 的 http://127.0.0.1:11434，自动补 /v1），第三个是模型（默认 bge-m3）
//   需要关闭验证码（同 client-smoke.mjs）；测试结束后恢复原来的向量模型配置
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const LOCAL = (process.argv[3] ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.argv[4] ?? 'bge-m3';
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

console.log(`iTerminal 知识库本地向量模型测试：${BASE}，向量服务 ${LOCAL}（${MODEL}）`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');
const l = await api('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'admin123', deviceId: `kb-local-${randomUUID()}`, deviceName: 'kb-mac', os: 'mac', arch: 'arm64', clientVersion: '1.0.0' } });
assert.equal(l.status, 200, JSON.stringify(l.json));
const client = l.json.data.accessToken;
const tag = String(Date.now()).slice(-6);

// 中途失败也要清理：恢复原来的配置、删除测试知识库
const before = (await api('GET', '/iterminal/kb/config', { token: admin })).json.data;
const undo = [() => api('PUT', '/iterminal/kb/config', { token: admin, body: { source: before.source, embedProviderId: before.embedProviderId, embedUrl: before.embedUrl, embedModel: before.embedModel } })];
const cleanup = async () => {
  for (const f of undo.reverse()) await f().catch(() => {});
  undo.length = 0;
};
process.on('uncaughtException', async (e) => {
  console.error(e);
  await cleanup();
  process.exit(1);
});

// ---------------------------------------------------------------- 配置
let r = await api('POST', '/iterminal/kb/config/test', { token: admin, body: { source: 'LOCAL', embedUrl: LOCAL, embedModel: MODEL } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
assert.ok(r.json.data.dimensions >= 256, `维度 ${r.json.data.dimensions}`);
assert.match(r.json.data.url, /\/v1$/);
ok(`表单测试（不用先保存）：地址只写到端口时补上 /v1，${MODEL} 返回 ${r.json.data.dimensions} 维向量，耗时 ${r.json.data.elapsedMs} ms`);

r = await api('POST', '/iterminal/kb/config/test', { token: admin, body: { source: 'LOCAL', embedUrl: 'ftp://127.0.0.1:11434', embedModel: MODEL } });
assert.match(r.json.msg, /http:\/\/ 或 https:\/\//);
r = await api('PUT', '/iterminal/kb/config', { token: admin, body: { source: 'LOCAL', embedUrl: LOCAL, embedModel: '' } });
assert.match(r.json.msg, /地址和模型/);
r = await api('POST', '/iterminal/kb/config/test', { token: admin, body: { source: 'LOCAL', embedUrl: 'http://127.0.0.1:1/v1', embedModel: MODEL } });
assert.match(r.json.msg, /调用向量接口失败/);
ok('地址不是 http(s)、没填模型、服务连不上时给出明确的提示');

// ---------------------------------------------------------------- 文档：问法和原文刻意不用相同的词
const col = `本地向量-${tag}`;
await api('POST', '/iterminal/kb/collection', { token: admin, body: { collectionName: col, description: '本地向量测试' } });
const c = (await api('GET', '/iterminal/kb/collection/list', { token: admin })).json.data.find((x) => x.collection_name === col);
undo.push(() => api('DELETE', `/iterminal/kb/collection/${c.collection_id}`, { token: admin }));
const docs = [
  ['网关故障手册', '# 网关故障手册\n\n## 502 Bad Gateway\n\nNginx 返回 502 时，先确认 upstream 后端进程是否存活，再看 error.log 里的 upstream prematurely closed connection。'],
  ['存储运维', '# 存储运维\n\n## 磁盘清理\n\ndf -h 显示根分区使用率超过 90% 时，用 du -sh /var/log/* 找出大文件，压缩或删除过期的归档日志。'],
  ['数据库手册', '# 数据库手册\n\n## 主从延迟\n\nSeconds_Behind_Master 持续增大时，检查从库 IO 线程和 SQL 线程状态，确认大事务和网络带宽。'],
];
// 先在「不使用」下写入：只有关键词索引，没有向量
await api('PUT', '/iterminal/kb/config', { token: admin, body: { source: 'NONE' } });
for (const [title, content] of docs) {
  r = await api('POST', '/iterminal/kb/document/text', { token: admin, body: { collectionId: c.collection_id, title, content } });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
}
const waitDocs = async (want) => {
  for (let i = 0; i < 120; i++) {
    const list = (await api('GET', `/iterminal/kb/document/list?collectionId=${c.collection_id}`, { token: admin })).json.data;
    if (list.length === docs.length && list.every(want)) return list;
    await sleep(500);
  }
  throw new Error('等待索引超时');
};
await waitDocs((d) => d.status === 'INDEXED' && d.embedded === '0');

// 切到本地向量服务：配置变了，自动让已有文档重新生成向量（不用勾选）
r = await api('PUT', '/iterminal/kb/config', { token: admin, body: { source: 'LOCAL', embedUrl: `${LOCAL}/`, embedModel: MODEL } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
assert.equal(r.json.data.changed, true);
assert.ok(r.json.data.reindexed >= docs.length);
const cfg = (await api('GET', '/iterminal/kb/config', { token: admin })).json.data;
assert.equal(cfg.source, 'LOCAL');
assert.equal(cfg.embedUrl, `${LOCAL}/v1`);
assert.equal(cfg.embedProviderId, '');
await waitDocs((d) => d.status === 'INDEXED' && d.embedded === '1');
// 再保存一次同样的配置：没有变化，不重建
r = await api('PUT', '/iterminal/kb/config', { token: admin, body: { source: 'LOCAL', embedUrl: `${LOCAL}/v1`, embedModel: MODEL } });
assert.equal(r.json.data.changed, false);
assert.equal(r.json.data.reindexed, 0);
ok('切到本地向量服务后自动给已有文档重新生成向量；配置没变时不重建');

// ---------------------------------------------------------------- 语义检索（客户端接口，Agent 的 kb_search / 引用知识库走这里）
const search = async (query) => (await api('POST', '/api/v1/kb/search', { token: client, body: { query, collectionIds: [c.collection_id], topK: 3 } })).json.data;
for (const [query, title] of [
  ['网站打不开，反向代理报网关错误', '网关故障手册'],
  ['服务器硬盘空间快用完了怎么办', '存储运维'],
  ['备库同步落后很多', '数据库手册'],
  ['website returns bad gateway error', '网关故障手册'],
]) {
  const hits = await search(query);
  assert.ok(hits.length > 0, `「${query}」没有结果`);
  assert.equal(hits[0].title, title, `「${query}」排第一的是 ${hits[0].title}`);
}
ok('纯语义检索：中文换个说法、英文提问都能找到对应的文档（问法和原文没有相同的关键词）');

// ---------------------------------------------------------------- 清理
await cleanup();
console.log(`全部通过（${step} 项）`);
process.exit(0);
