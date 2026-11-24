// 知识库冒烟测试：上传 Markdown / GBK 文本 / HTML / PDF / Word，解析切块、关键词 + 向量混合检索、角色可见、删除。
// 在本机 18093 端口模拟 OpenAI 兼容的 embeddings 接口（按字符哈希生成向量，内容相近的向量也相近）。
// 用法：node test/kb-smoke.mjs http://127.0.0.1:8080   （需要关闭验证码，同 client-smoke.mjs）
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { crc32, deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');
const EMB_PORT = 18093;
const DIM = 64;
let step = 0;
const ok = (name) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${name}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 模拟向量接口
let embedCalls = 0;
const vector = (text) => {
  const v = new Array(DIM).fill(0);
  for (const ch of text.toLowerCase()) v[(ch.codePointAt(0) * 2654435761) % DIM] += 1;
  const n = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
};
const emb = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.url !== '/v1/embeddings' || req.headers.authorization !== 'Bearer sk-embed') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"bad key"}}');
    }
    embedCalls++;
    const body = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: body.input.map((t, i) => ({ index: i, embedding: vector(t) })), model: body.model }));
  });
});
await new Promise((r) => emb.listen(EMB_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------- 测试文件
const md = `# Nginx 运维手册

## 502 Bad Gateway 排查

出现 502 Bad Gateway 时，先检查上游服务是否存活：\`systemctl status app\`，再看 nginx 的 error.log 里有没有 upstream prematurely closed。
常见原因：上游进程崩溃、端口不对、proxy_read_timeout 太短。

## 证书续期

证书由 certbot 自动续期，续期失败时手动执行 certbot renew --dry-run 查看原因。
`;
const gbkText = Buffer.from([0xd7, 0xa2, 0xd2, 0xe2, 0xca, 0xc2, 0xcf, 0xee, 0xa3, 0xba, 0x52, 0x65, 0x64, 0x69, 0x73, 0x20, 0xc4, 0xda, 0xb4, 0xe6]); // 注意事项：Redis 内存（GBK）
const html = `<html><head><title>x</title><style>.a{}</style></head><body><h1>MySQL 慢查询</h1><p>打开 slow_query_log，用 pt-query-digest 分析慢日志。</p><script>alert(1)</script></body></html>`;
// 手写一个最小的 PDF（一页，一行英文）
function pdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
// 手写一个最小的 docx（zip：[Content_Types].xml、_rels/.rels、word/document.xml）
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
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = zip([
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
  ['word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>磁盘告警处理</w:t></w:r></w:p><w:p><w:r><w:t>磁盘使用率超过 90% 时，先用 du -sh /var/log/* 找大文件，清理归档日志。</w:t></w:r></w:p></w:body></w:document>`],
]);

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
const device = async (username, password) => {
  const l = await api('POST', '/api/v1/auth/login', { body: { username, password, deviceId: `kb-dev-${randomUUID()}`, deviceName: 'kb-mac', os: 'mac', arch: 'arm64', clientVersion: '0.2.0' } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  return l.json.data.accessToken;
};

console.log(`iTerminal 知识库冒烟测试：${BASE}`);
const admin = (await api('POST', '/login', { body: { username: 'admin', password: 'admin123' } })).json.token;
assert.ok(admin, '管理后台登录失败（验证码需要关闭）');
const tag = String(Date.now()).slice(-6);
// 中途失败也要清理：按创建顺序倒着删
const undo = [];
const cleanup = async () => {
  for (const f of undo.reverse()) await f().catch(() => {});
  undo.length = 0;
};
process.on('uncaughtException', async (e) => {
  console.error(e);
  await cleanup();
  process.exit(1);
});

// ---------------------------------------------------------------- 向量模型配置
let r = await api('POST', '/iterminal/llm/provider', { token: admin, body: { providerName: `向量-${tag}`, providerType: 'OPENAI_COMPAT', baseUrl: `http://127.0.0.1:${EMB_PORT}/v1`, apiKey: 'sk-embed', models: JSON.stringify([{ id: 'mock-embed' }]) } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const providerId = (await api('GET', `/iterminal/llm/provider/list?providerName=${encodeURIComponent(`向量-${tag}`)}`, { token: admin })).json.rows[0].providerId;
undo.push(() => api('DELETE', `/iterminal/llm/provider/${providerId}`, { token: admin }));
undo.push(() => api('PUT', '/iterminal/kb/config', { token: admin, body: { embedProviderId: '', embedModel: '' } }));
r = await api('PUT', '/iterminal/kb/config', { token: admin, body: { embedProviderId: providerId, embedModel: 'mock-embed' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
r = await api('POST', '/iterminal/kb/config/test', { token: admin });
assert.equal(r.json.data.dimensions, DIM);
ok('向量模型：选团队模型里 OpenAI 兼容的提供商，测试返回向量维度');

// ---------------------------------------------------------------- 知识库和文档
const collection = async (name, roleKeys = '') => {
  await api('POST', '/iterminal/kb/collection', { token: admin, body: { collectionName: name, description: '测试', roleKeys } });
  const c = (await api('GET', '/iterminal/kb/collection/list', { token: admin })).json.data.find((x) => x.collection_name === name);
  undo.push(() => api('DELETE', `/iterminal/kb/collection/${c.collection_id}`, { token: admin }));
  return c;
};
const ops = await collection(`运维手册-${tag}`);
const secret = await collection(`机密-${tag}`, 'itm_approver');
const form = new FormData();
form.append('collectionId', String(ops.collection_id));
form.append('files', new Blob([md]), 'nginx.md');
form.append('files', new Blob([gbkText]), 'redis.txt');
form.append('files', new Blob([html]), 'mysql.html');
form.append('files', new Blob([pdf('Kafka consumer lag troubleshooting guide')]), 'kafka.pdf');
form.append('files', new Blob([docx]), 'disk.docx');
r = await api('POST', '/iterminal/kb/document/upload', { token: admin, form });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
assert.equal(r.json.data.length, 5);
const bad = new FormData();
bad.append('collectionId', String(ops.collection_id));
bad.append('files', new Blob(['x']), 'a.exe');
r = await api('POST', '/iterminal/kb/document/upload', { token: admin, form: bad });
assert.match(r.json.msg, /不支持的文件类型/);
r = await api('POST', '/iterminal/kb/document/text', { token: admin, body: { collectionId: secret.collection_id, title: '核心数据库密码轮换流程', content: '# 核心库\n\n每季度轮换一次 root 密码，先在从库演练。' } });
assert.equal(r.json.code, 200);
let docs;
for (let i = 0; i < 60; i++) {
  docs = (await api('GET', `/iterminal/kb/document/list?collectionId=${ops.collection_id}`, { token: admin })).json.data;
  if (docs.every((d) => d.status === 'INDEXED' || d.status === 'FAILED')) break;
  await sleep(500);
}
const byName = (n) => docs.find((d) => d.file_name === n);
for (const n of ['nginx.md', 'redis.txt', 'mysql.html', 'kafka.pdf', 'disk.docx']) assert.equal(byName(n).status, 'INDEXED', `${n}：${byName(n).error}`);
assert.equal(byName('nginx.md').chunk_count, 2); // 两个二级标题
assert.equal(byName('nginx.md').embedded, '1');
ok('上传 Markdown、GBK 文本、HTML、PDF、Word：都解析成功，按章节切块并生成向量；不支持的类型拒绝');

// ---------------------------------------------------------------- 检索
const client = await device('admin', 'admin123');
r = await api('POST', '/api/v1/kb/search', { token: client, body: { query: 'nginx 502 Bad Gateway 怎么排查', topK: 3 } });
assert.equal(r.status, 200, JSON.stringify(r.json));
let hits = r.json.data;
assert.ok(hits.length > 0);
assert.equal(hits[0].title, 'nginx');
assert.equal(hits[0].section, 'Nginx 运维手册 / 502 Bad Gateway 排查');
assert.match(hits[0].content, /upstream prematurely closed/);
assert.equal(hits[0].source, `运维手册-${tag}`);
assert.ok(hits[0].score > 0 && hits[0].score <= 1);
const s2 = await api('POST', '/api/v1/kb/search', { token: client, body: { query: 'Redis 内存注意事项' } });
assert.ok(s2.json.data.some((h) => h.title === 'redis' && h.content.includes('注意事项')), JSON.stringify(s2.json.data));
const s3 = await api('POST', '/api/v1/kb/search', { token: client, body: { query: 'Kafka consumer lag' } });
assert.equal(s3.json.data[0].title, 'kafka');
const s4 = await api('POST', '/api/v1/kb/search', { token: client, body: { query: '磁盘使用率 90%' } });
assert.equal(s4.json.data[0].title, 'disk');
assert.equal(s4.json.data[0].section, '磁盘告警处理');
const s5 = await api('POST', '/api/v1/kb/search', { token: client, body: { query: '慢查询 pt-query-digest' } });
assert.equal(s5.json.data[0].title, 'mysql');
assert.doesNotMatch(s5.json.data[0].content, /alert\(1\)/);
ok('混合检索：中文 / 英文问题都找到对应文档和章节，HTML 去掉了脚本，返回出处和归一化得分');

// 只用关键词（去掉向量模型配置）
const calls = embedCalls;
r = await api('PUT', '/iterminal/kb/config', { token: admin, body: { embedProviderId: providerId, embedModel: '' } });
assert.match(r.json.msg, /填写向量模型/);
r = await api('PUT', '/iterminal/kb/config', { token: admin, body: { embedProviderId: '', embedModel: '' } });
assert.equal(r.json.code, 200);
assert.equal((await api('GET', '/iterminal/kb/config', { token: admin })).json.data.embedModel, '');
hits = (await api('POST', '/api/v1/kb/search', { token: client, body: { query: '证书续期 certbot' } })).json.data;
assert.equal(hits[0].section, 'Nginx 运维手册 / 证书续期');
assert.equal(embedCalls, calls);
ok('清空向量模型配置后只用关键词检索，结果仍然正确；提供商和模型必须一起填写');

// ---------------------------------------------------------------- 角色可见
const uname = `kb${tag}`;
r = await api('POST', '/system/user', { token: admin, body: { userName: uname, nickName: '知识库测试', password: 'Test@123456', deptId: 103, roleIds: [2], status: '0' } });
assert.equal(r.json.code, 200, JSON.stringify(r.json));
const userId = (await api('GET', `/system/user/list?userName=${uname}`, { token: admin })).json.rows[0].userId;
undo.push(() => api('DELETE', `/system/user/${userId}`, { token: admin }));
const u = await device(uname, 'Test@123456');
const cols = (await api('GET', '/api/v1/kb/collections', { token: u })).json.data.map((c) => c.name);
assert.ok(cols.includes(`运维手册-${tag}`) && !cols.includes(`机密-${tag}`));
assert.equal((await api('POST', '/api/v1/kb/search', { token: u, body: { query: '核心库 root 密码轮换' } })).json.data.length, 0);
assert.ok((await api('POST', '/api/v1/kb/search', { token: client, body: { query: '核心库 root 密码轮换' } })).json.data.length > 0);
assert.equal((await api('POST', '/api/v1/kb/search', { token: admin, body: { query: 'x' } })).status, 403);
ok('角色可见：限定了角色的知识库，其他用户检索不到；管理后台的令牌不能调用客户端接口');

// 删除文档后检索不到
await api('DELETE', `/iterminal/kb/document/${byName('kafka.pdf').document_id}`, { token: admin });
hits = (await api('POST', '/api/v1/kb/search', { token: client, body: { query: 'Kafka consumer lag' } })).json.data;
assert.ok(!hits.some((h) => h.title === 'kafka'));
ok('删除文档后检索不到');

// ---------------------------------------------------------------- 清理
await cleanup();
emb.close();
console.log(`全部通过（${step} 项）`);
process.exit(0);
