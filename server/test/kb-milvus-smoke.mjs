// 知识库 Milvus + 多格式冒烟测试（第三十三轮）：上传 Word 97-2003（.doc）、Excel（.xlsx）、CSV、YAML，切到 Milvus 向量存储，
// 已有向量自动同步、新文档直接写入、检索走 Milvus、删除文档同步删除、Milvus 挂掉时退回 MySQL 里的向量。
// 本机 18094 模拟 embeddings 接口，18095 模拟 Milvus RESTful v2（内存里按余弦相似度检索）。
// 用法：node test/kb-milvus-smoke.mjs http://127.0.0.1:8080   （需要关闭验证码，同 client-smoke.mjs）
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { crc32, deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const EMB_PORT = 18094;
const MILVUS_PORT = 18095;
const DIM = 64;
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 模拟向量接口
const vector = (text) => {
  const v = new Array(DIM).fill(0);
  for (const ch of text.toLowerCase()) v[(ch.codePointAt(0) * 2654435761) % DIM] += 1;
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
};
const readBody = (req) => new Promise((r) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => r(raw));
});
const emb = createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: vector(t) })), model: body.model }));
});
await new Promise((r) => emb.listen(EMB_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------- 模拟 Milvus
/** 集合名 → { dim, rows: Map<chunk_id, {collection_id, document_id, vector}> } */
const milvus = new Map();
const calls = [];
const match = (filter) => {
  let m = /^(document_id|collection_id) == (\d+)$/.exec(filter);
  if (m) return (r) => r[m[1]] === Number(m[2]);
  m = /^collection_id in \[([\d,]*)\]$/.exec(filter);
  if (m) {
    const ids = new Set(m[1].split(',').filter(Boolean).map(Number));
    return (r) => ids.has(r.collection_id);
  }
  throw new Error(`不认识的 filter：${filter}`);
};
const cos = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b) || 1);
const mv = createServer(async (req, res) => {
  const path = req.url.replace('/v2/vectordb', '');
  const b = JSON.parse((await readBody(req)) || '{}');
  calls.push({ path, auth: req.headers.authorization, db: b.dbName });
  const reply = (data, code = 0, message) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(code ? { code, message } : { code: 0, data }));
  };
  if (req.headers.authorization !== 'Bearer root:Milvus') return reply(null, 1800, 'auth failed');
  const c = milvus.get(b.collectionName);
  try {
    switch (path) {
      case '/collections/list':
        return reply([...milvus.keys()]);
      case '/collections/has':
        return reply({ has: !!c });
      case '/collections/create':
        milvus.set(b.collectionName, { dim: Number(b.schema.fields.find((f) => f.fieldName === 'vector').elementTypeParams.dim), rows: new Map() });
        return reply({});
      case '/collections/load':
        return reply({});
      case '/collections/get_stats':
        return reply({ rowCount: c.rows.size });
      case '/entities/upsert':
        for (const r of b.data) {
          assert.equal(r.vector.length, c.dim);
          c.rows.set(r.chunk_id, r);
        }
        return reply({ upsertCount: b.data.length });
      case '/entities/delete': {
        const f = match(b.filter);
        for (const [k, r] of c.rows) if (f(r)) c.rows.delete(k);
        return reply({});
      }
      case '/entities/search': {
        const f = match(b.filter);
        const q = b.data[0];
        const hits = [...c.rows.values()].filter(f).map((r) => ({ chunk_id: r.chunk_id, distance: cos(q, r.vector) })).sort((x, y) => y.distance - x.distance).slice(0, b.limit);
        return reply(hits);
      }
      default:
        return reply(null, 404, `unknown ${path}`);
    }
  } catch (e) {
    return reply(null, 1100, String(e.message));
  }
});
await new Promise((r) => mv.listen(MILVUS_PORT, '127.0.0.1', r));
const rowsOf = (pred = () => true) => [...milvus.values()].reduce((n, c) => n + [...c.rows.values()].filter(pred).length, 0);

// ---------------------------------------------------------------- 测试文件
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26);
    local.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
// 最小的 xlsx：一个工作表，内联字符串
const cell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
const sheetRows = [
  ['主机', 'IP', '用途'],
  ['web01', '10.0.0.1', '对外网关 Nginx'],
  ['db01', '10.0.0.2', '订单库主库 MySQL'],
];
const xlsx = zip([
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="服务器清单" sheetId="1" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
  ['xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => cell(`${'ABC'[j]}${i + 1}`, v)).join('')}</row>`).join('')}</sheetData></worksheet>`],
]);
const doc = readFileSync(new URL('../ruoyi-iterminal/src/test/resources/kb/sample.doc', import.meta.url));
const csv = '告警,处理\nKafka 消费积压,"先看 consumer lag，再扩分区"\n磁盘满,清理 /var/log 归档\n';
const yaml = 'redis:\n  maxmemory: 4gb\n  maxmemory-policy: allkeys-lru\n';

async function api(method, path, { token, body, form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
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

console.log(`iTerminal 知识库 Milvus 冒烟测试：${BASE}`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');
const tag = String(Date.now()).slice(-6);
const undo = [];
const cleanup = async () => {
  for (const f of undo.reverse()) await f().catch(() => {});
  undo.length = 0;
};
let failed = false;
try {
  // ---------------------------------------------------------------- 向量模型 + 知识库 + 多格式文档（MySQL 存向量）
  let r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: `向量-${tag}`, providerType: 'OPENAI_COMPAT', baseUrl: `http://127.0.0.1:${EMB_PORT}/v1`, apiKey: 'sk-embed', models: JSON.stringify([{ id: 'mock-embed' }]) } });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
  const providerId = (await api('GET', `/iterminal/llm/provider/list?providerName=${encodeURIComponent(`向量-${tag}`)}`, { token: admin })).json.rows[0].providerId;
  undo.push(() => api('DELETE', `/iterminal/llm/provider/${providerId}`, { token: admin }));
  undo.push(() => api('PUT', '/iterminal/kb/config', { token: admin, body: { embedProviderId: '', embedModel: '' } }));
  undo.push(() => api('PUT', '/iterminal/kb/config/store', { token: admin, body: { store: 'MYSQL' } }));
  r = await api('PUT', '/iterminal/kb/config', { token: admin, body: { embedProviderId: providerId, embedModel: 'mock-embed' } });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));

  await api('POST', '/iterminal/kb/collection', { token: admin, body: { collectionName: `资产-${tag}`, description: '测试' } });
  const col = (await api('GET', '/iterminal/kb/collection/list', { token: admin })).json.data.find((x) => x.collection_name === `资产-${tag}`);
  undo.push(() => api('DELETE', `/iterminal/kb/collection/${col.collection_id}`, { token: admin }));
  const form = new FormData();
  form.append('collectionId', String(col.collection_id));
  form.append('files', new Blob([doc]), '部署手册.doc');
  form.append('files', new Blob([xlsx]), 'servers.xlsx');
  form.append('files', new Blob([csv]), 'alerts.csv');
  form.append('files', new Blob([yaml]), 'redis.yaml');
  r = await api('POST', '/iterminal/kb/document/upload', { token: admin, form });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
  const waitIndexed = async () => {
    let docs;
    for (let i = 0; i < 60; i++) {
      docs = (await api('GET', `/iterminal/kb/document/list?collectionId=${col.collection_id}`, { token: admin })).json.data;
      if (docs.every((d) => d.status === 'INDEXED' || d.status === 'FAILED')) return docs;
      await sleep(500);
    }
    throw new Error('索引超时');
  };
  let docs = await waitIndexed();
  for (const d of docs) {
    assert.equal(d.status, 'INDEXED', `${d.file_name}：${d.error}`);
    assert.equal(d.embedded, '1', d.file_name);
    assert.equal(d.error ?? '', '', d.file_name);
  }
  const client = (await api('POST', '/api/v1/auth/login', { body: { username: 'admin', password: 'admin123', deviceId: `kbm-${randomUUID()}`, deviceName: 'kbm', os: 'mac', arch: 'arm64', clientVersion: '0.2.0' } })).json.data.accessToken;
  const search = async (query) => {
    const res = await api('POST', '/api/v1/kb/search', { token: client, body: { query, collectionIds: [col.collection_id], topK: 3 } });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    return res.json.data;
  };
  let hits = await search('web01 网关 IP 是多少');
  assert.equal(hits[0].title, 'servers');
  assert.match(hits[0].content, /主机: web01；IP: 10\.0\.0\.1；用途: 对外网关 Nginx/);
  assert.equal(hits[0].section, '服务器清单');
  hits = await search('执行 deploy.sh 前要做什么');
  assert.equal(hits[0].title, '部署手册');
  assert.match(hits[0].content, /先备份数据库/);
  hits = await search('Kafka 消费积压怎么处理');
  assert.match(hits[0].content, /处理: 先看 consumer lag，再扩分区/);
  assert.equal(milvus.size, 0);
  ok('Word .doc、Excel .xlsx（表头: 值）、CSV、YAML 都解析成功并生成向量；默认 MySQL 存储时检索正常');

  // ---------------------------------------------------------------- 切到 Milvus
  r = await api('POST', '/iterminal/kb/config/store/test', { token: admin, body: { milvusUrl: `127.0.0.1:${MILVUS_PORT}`, milvusToken: 'wrong' } });
  assert.match(r.json.msg, /1800/);
  r = await api('POST', '/iterminal/kb/config/store/test', { token: admin, body: { milvusUrl: `127.0.0.1:${MILVUS_PORT}`, milvusToken: 'root:Milvus', milvusDb: 'itm' } });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
  r = await api('PUT', '/iterminal/kb/config/store', { token: admin, body: { store: 'MILVUS', milvusUrl: `127.0.0.1:${MILVUS_PORT}`, milvusToken: 'root:Milvus', milvusDb: 'itm' } });
  assert.equal(r.json.code, 200, JSON.stringify(r.json));
  assert.equal(r.json.data.syncing, true);
  let cfg;
  for (let i = 0; i < 40; i++) {
    cfg = (await api('GET', '/iterminal/kb/config', { token: admin })).json.data;
    if (!cfg.milvusSync.running) break;
    await sleep(300);
  }
  assert.equal(cfg.vectorStore, 'MILVUS');
  assert.equal(cfg.milvusUrl, `http://127.0.0.1:${MILVUS_PORT}`);
  assert.equal(cfg.milvusTokenSet, true);
  assert.ok(!JSON.stringify(cfg).includes('root:Milvus'), '配置接口不能返回 Milvus 的认证信息');
  assert.ok(!cfg.milvusSync.error, cfg.milvusSync.error);
  assert.ok(cfg.milvusSync.done >= docs.length);
  const chunks = docs.reduce((n, d) => n + d.chunk_count, 0);
  assert.equal(rowsOf((x) => x.collection_id === col.collection_id), chunks);
  assert.deepEqual([...milvus.keys()], [`itm_kb_chunks_d${DIM}`]);
  assert.ok(calls.filter((c) => c.auth === 'Bearer root:Milvus').every((c) => c.db === 'itm'));
  ok('切到 Milvus：先测试连接（认证错误时报错），保存后自动把 MySQL 里已有的向量同步过去；配置接口不返回认证信息');

  const before = calls.filter((c) => c.path === '/entities/search').length;
  hits = await search('db01 订单库主库');
  assert.equal(hits[0].title, 'servers');
  assert.equal(calls.filter((c) => c.path === '/entities/search').length, before + 1);
  ok('检索走 Milvus（按知识库过滤），结果和之前一致');

  r = await api('POST', '/iterminal/kb/document/text', { token: admin, body: { collectionId: col.collection_id, title: '证书续期', content: '# 证书\n\ncertbot renew --dry-run 检查续期。' } });
  docs = await waitIndexed();
  const certDoc = docs.find((d) => d.title === '证书续期');
  assert.equal(certDoc.status, 'INDEXED', certDoc.error);
  assert.equal(certDoc.error ?? '', '');
  assert.equal(rowsOf((x) => x.document_id === certDoc.document_id), certDoc.chunk_count);
  hits = await search('certbot 续期');
  assert.equal(hits[0].title, '证书续期');
  await api('DELETE', `/iterminal/kb/document/${certDoc.document_id}`, { token: admin });
  assert.equal(rowsOf((x) => x.document_id === certDoc.document_id), 0);
  ok('Milvus 存储时新文档直接写入 Milvus，删除文档同时删除 Milvus 里的向量');

  // ---------------------------------------------------------------- Milvus 挂掉：退回 MySQL
  await new Promise((r2) => mv.close(r2));
  mv.closeAllConnections?.();
  hits = await search('web01 网关');
  assert.equal(hits[0].title, 'servers');
  ok('Milvus 不可用时检索自动改用 MySQL 里的向量');

  r = await api('PUT', '/iterminal/kb/config/store', { token: admin, body: { store: 'MYSQL' } });
  assert.equal(r.json.code, 200);
  cfg = (await api('GET', '/iterminal/kb/config', { token: admin })).json.data;
  assert.equal(cfg.vectorStore, 'MYSQL');
  ok('切回 MySQL 立即生效');
  console.log(`全部通过（${step} 项）`);
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await cleanup();
  emb.close();
  mv.close();
  process.exit(failed ? 1 : 0);
}
