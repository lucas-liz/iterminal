import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Diagnostics, HostInput } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { SnippetRepo } from '../src/main/services/library/snippet-repo';
import { NoteRepo } from '../src/main/services/library/note-repo';
import { DatasetStore } from '../src/main/services/sync/dataset-store';
import { SyncService } from '../src/main/services/sync/sync-service';
import { CloudService } from '../src/main/services/sync/cloud-service';
import { pickForImport, pickForShare } from '../src/main/services/sync/share-pick';
import { DiagLog, logIpc, summarize } from '../src/main/services/diag/diag-log';
import { FeedbackService, relTime } from '../src/main/services/diag/feedback';
import { SkillStore } from '../src/main/services/ai/skills';
import { createRepos } from './support/repos';
import { generateEd25519 } from './support/keys';

let root: string;
let now = 1_700_000_000_000;
const opened: Db[] = [];

function profile(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const vaultKey = randomBytes(32);
  const db = openDatabase(join(root, `${name}.db`), randomBytes(32));
  opened.push(db);
  const clock = () => now;
  const repos = createRepos(db, vaultKey, clock);
  const snippets = new SnippetRepo(db, clock);
  const notes = new NoteRepo(db, clock);
  const store = new DatasetStore(db, vaultKey, { credentials: repos.credentials, tags: repos.tags }, clock);
  const sync = new SyncService({ db, store, settings: repos.settings, vaultKey, dir, clientVersion: '1.0.0', now: () => (now += 1000) });
  return { db, dir, vaultKey, ...repos, snippets, notes, store, sync };
}

const hostInput = (o: Partial<HostInput> & { name: string; address: string }): HostInput => ({
  folderId: null, port: 22, username: 'root', authMethod: 'PASSWORD', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [], ...o,
});

/** 生产 / 订单 两级分组、跳板机（用凭证）、带密码的主机、用共享密钥的主机、另一个分组的主机、快捷命令和笔记 */
function seed(p: ReturnType<typeof profile>) {
  const key = generateEd25519();
  const prod = p.folders.create(null, '生产');
  const order = p.folders.create(prod.id, '订单');
  const test = p.folders.create(null, '测试');
  const shared = p.credentials.save(null, { type: 'SSH_KEY', name: '部署密钥', username: 'deploy', secret: key.private, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
  const bastion = p.credentials.save(null, { type: 'PASSWORD', name: '堡垒机', username: 'ops', secret: 'bastion-pw', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
  const jump = p.hosts.create(hostInput({ name: 'jump', address: '10.0.0.9', folderId: prod.id, authMethod: 'CREDENTIAL', credentialId: bastion.id }));
  const web = p.hosts.create(hostInput({ name: 'order-01', address: '10.0.1.1', folderId: order.id, password: 's3cret', jumpHostIds: [jump.id] }));
  const db = p.hosts.create(hostInput({ name: 'db-01', address: '10.0.1.2', folderId: order.id, authMethod: 'CREDENTIAL', credentialId: shared.id }));
  const other = p.hosts.create(hostInput({ name: 'test-01', address: '10.9.0.1', folderId: test.id, password: 'test-pw' }));
  const ops = p.snippets.groups.save(null, '运维');
  const sDisk = p.snippets.save(null, { groupId: ops, name: '看磁盘', content: 'df -h' });
  const sLoad = p.snippets.save(null, { groupId: ops, name: '负载', content: 'uptime' });
  const sFree = p.snippets.save(null, { groupId: null, name: '内存', content: 'free -m' });
  const ng = p.notes.groups.save(null, '值班');
  const nHand = p.notes.save(null, { groupId: ng, title: '交接', content: '# 交接\n- 检查磁盘' });
  const nOther = p.notes.save(null, { groupId: null, title: '杂记', content: '随便写写' });
  return { prod, order, test, shared, bastion, jump, web, db, other, ops, sDisk, sLoad, sFree, ng, nHand, nOther, key };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'itm-r13-'));
});

afterEach(() => {
  opened.splice(0).forEach((d) => d.close());
  rmSync(root, { recursive: true, force: true });
});

describe('单项分享：分享方挑选内容（第十三轮）', () => {
  it('单台主机：自动带上跳板机（递归）、分组路径和引用的凭证；连同凭证时带主机自己的密码', () => {
    const a = profile('a');
    const s = seed(a);
    const all = a.store.load(['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], true);
    const r = pickForShare(all, { hostIds: [s.web.id] }, { includeCredentials: true, teamFolderIds: new Set() });
    expect(r.data.hosts.map((h) => h.name).sort()).toEqual(['jump', 'order-01']);
    expect(r.data.hostGroups.map((f) => f.name).sort()).toEqual(['生产', '订单']);
    expect(r.data.credentials.map((c) => c.name)).toEqual(['堡垒机']);
    expect(r.data.hosts.find((h) => h.name === 'order-01')?.password).toBe('s3cret');
    expect(r.groups).toEqual(['HOSTS', 'CREDENTIALS']);
    expect(r.preview.hosts.find((h) => h.name === 'jump')).toMatchObject({ jump: true, credentialName: '堡垒机' });
    expect(r.preview.hosts.find((h) => h.name === 'order-01')).toMatchObject({ jump: false, hasSecret: true, folderPath: '生产 / 订单' });
    expect(r.preview.title).toBe('主机 order-01');
    expect(r.preview.hasSecrets).toBe(true);
  });

  it('不带凭证：去掉密码 / 私钥和凭证，分组里只剩主机和分组', () => {
    const a = profile('a');
    const s = seed(a);
    const r = pickForShare(a.store.load(['HOSTS', 'CREDENTIALS'], true), { hostIds: [s.web.id, s.db.id] }, { includeCredentials: false, teamFolderIds: new Set() });
    expect(r.groups).toEqual(['HOSTS']);
    expect(r.data.credentials).toEqual([]);
    expect(r.data.hosts.every((h) => !h.password && !h.privateKey)).toBe(true);
    expect(r.preview.title).toBe('db-01 等 2 台主机');
  });

  it('整个分组（含子分组）；快捷命令和笔记按条目或整个分组；团队主机跳过', () => {
    const a = profile('a');
    const s = seed(a);
    const all = a.store.load(['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], true);
    const r = pickForShare(all, { folderIds: [s.prod.id], snippetGroupIds: [s.ops], noteIds: [s.nOther.id] }, { includeCredentials: true, teamFolderIds: new Set() });
    expect(r.data.hosts.map((h) => h.name).sort()).toEqual(['db-01', 'jump', 'order-01']);
    expect(r.data.credentials.map((c) => c.name).sort()).toEqual(['堡垒机', '部署密钥']);
    expect(r.data.snippets.map((x) => x.name).sort()).toEqual(['看磁盘', '负载']);
    expect(r.data.snippetGroups.map((g) => g.name)).toEqual(['运维']);
    expect(r.data.notes.map((n) => n.title)).toEqual(['杂记']);
    expect(r.data.noteGroups).toEqual([]);
    expect(r.groups).toEqual(['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS']);
    // 团队分组里的主机不能分享
    const team = pickForShare(all, { hostIds: [s.other.id, s.web.id] }, { includeCredentials: true, teamFolderIds: new Set([s.test.id]) });
    expect(team.preview.skippedTeam).toBe(1);
    expect(team.data.hosts.map((h) => h.name)).not.toContain('test-01');
  });
});

describe('拉取分享码：勾选内容后合并（第十三轮）', () => {
  it('默认带分组：同名路径的分组直接使用；勾掉的条目不导入；不带凭证时不写密码', () => {
    const a = profile('a');
    const s = seed(a);
    const pkg = a.sync.shareData({ folderIds: [s.prod.id], snippetIds: [s.sDisk.id, s.sFree.id] }, true);
    const b = profile('b');
    // b 本地已经有「生产」分组（同名）
    const bProd = b.folders.create(null, '生产');
    const data = b.sync.parseIncoming(pkg.body, pkg.groups);
    const pick1 = pickForImport(data, { hostIds: data.hosts.filter((h) => h.name !== 'db-01').map((h) => h.id), credentialIds: data.credentials.map((c) => c.id), snippetIds: data.snippets.map((x) => x.id), noteIds: [], withGroups: true, withCredentials: true });
    const preview = b.sync.importDataset(pick1.data, pick1.groups, 'merge', true, 'test', 'user:alice');
    expect(preview.perType.hosts.added).toBe(2);
    expect(preview.perType.hostGroups).toEqual({ added: 1, kept: 1, filled: 0 });
    const done = b.sync.importDataset(pick1.data, pick1.groups, 'merge', false, 'test', 'user:alice');
    expect(done.applied).toBe(true);
    const order = b.folders.list().find((f) => f.name === '订单')!;
    expect(order.parentId).toBe(bProd.id);
    expect(b.folders.list().filter((f) => f.name === '生产')).toHaveLength(1);
    const web = b.hosts.list().find((h) => h.name === 'order-01')!;
    expect(web.folderId).toBe(order.id);
    expect(b.hosts.connectInfo(web.id).auth.password).toBe('s3cret');
    expect(b.hosts.list().map((h) => h.name)).not.toContain('db-01');
    expect(b.snippets.library().snippets.map((x) => x.name).sort()).toEqual(['内存', '看磁盘']);
    expect(b.snippets.library().groups.map((g) => g.name)).toEqual(['运维']);

    // 不带分组、不带凭证：主机放在未分组，不写密码
    const c = profile('c');
    const data2 = c.sync.parseIncoming(pkg.body, pkg.groups);
    const pick2 = pickForImport(data2, { hostIds: data2.hosts.filter((h) => h.name === 'order-01').map((h) => h.id), credentialIds: [], snippetIds: [], noteIds: [], withGroups: false, withCredentials: false });
    expect(pick2.groups).toEqual(['HOSTS']);
    c.sync.importDataset(pick2.data, pick2.groups, 'merge', false, 'test', 'user:alice');
    const h2 = c.hosts.list();
    expect(h2.map((h) => [h.name, h.folderId])).toEqual([['order-01', null]]);
    expect(c.folders.list()).toEqual([]);
    expect(h2[0].hasPassword).toBe(false);
  });

  it('CloudService：创建单项分享 → 拉取方列出内容 → 勾选后合并；分享码保存在本机，可以再次复制；撤销', async () => {
    const a = profile('a');
    const s = seed(a);
    const uploads: { meta: Record<string, unknown>; file: Buffer }[] = [];
    const json = (data: unknown, status = 200): Response => new Response(JSON.stringify({ code: 0, message: 'ok', data }), { status, headers: { 'content-type': 'application/json' } });
    let revoked = false;
    const server = {
      rawRequest: async (method: string, path: string, init: { body?: unknown } = {}): Promise<Response> => {
        if (path === '/api/v1/sync/e2e-key') return json(null);
        if (method === 'POST' && path === '/api/v1/share-links') {
          const form = init.body as FormData;
          const meta = JSON.parse(String(form.get('meta'))) as Record<string, unknown>;
          const file = Buffer.from(await (form.get('file') as Blob).arrayBuffer());
          uploads.push({ meta, file });
          return json({ id: 101, title: meta.title, groups: meta.groups, counts: meta.counts, expiresAt: meta.expiresAt, maxPulls: meta.maxPulls, pullCount: 0, lastPulledAt: null, expired: false, exhausted: false, size: file.length, createdAt: now });
        }
        if (method === 'GET' && path === '/api/v1/share-links') return json(revoked ? [] : [{ id: 101, title: uploads[0].meta.title, groups: uploads[0].meta.groups, counts: {}, expiresAt: null, maxPulls: 0, pullCount: 1, lastPulledAt: null, expired: false, exhausted: false, size: 1, createdAt: now }]);
        if (method === 'DELETE' && path === '/api/v1/share-links/101') {
          revoked = true;
          return json(null);
        }
        if (path === '/api/v1/shares:lookup') {
          const tok = JSON.parse(String(init.body)).lookupToken;
          if (tok !== uploads[0].meta.lookupToken) return json(null, 404);
          return json({ kind: 'LINK', title: uploads[0].meta.title, ownerUsername: 'alice', ownerDisplayName: 'Alice', groups: uploads[0].meta.groups, counts: uploads[0].meta.counts, size: uploads[0].file.length, updatedAt: now, deviceName: 'x', platform: 'macos', clientVersion: '1.0.0' });
        }
        if (path === '/api/v1/shares:download') return new Response(new Uint8Array(uploads[0].file), { status: 200 });
        return json(null, 404);
      },
    };
    const cloudA = new CloudService({ link: server as never, sync: a.sync, dir: a.dir, vaultKey: a.vaultKey, clientVersion: '1.0.0', now: () => now });
    const prev = cloudA.sharePreview({ hostIds: [s.web.id] });
    expect(prev.hosts.map((h) => h.name).sort()).toEqual(['jump', 'order-01']);
    const created = await cloudA.createLink({ hostIds: [s.web.id], noteIds: [s.nHand.id] }, { title: '', includeCredentials: true, expiresDays: 7, maxPulls: 3 });
    expect(created.code).toMatch(/^ITM(-[0-9A-Z]{5}){5}$/);
    expect(uploads[0].meta).toMatchObject({ title: '主机 order-01、笔记 交接', maxPulls: 3, groups: ['HOSTS', 'NOTES', 'CREDENTIALS'] });
    expect(uploads[0].meta.expiresAt).toBe(now + 7 * 86_400_000);
    // 上传的是密文：找不到主机名和密码
    expect(uploads[0].file.includes(Buffer.from('order-01'))).toBe(false);
    expect(uploads[0].file.includes(Buffer.from('s3cret'))).toBe(false);
    expect(existsSync(join(a.dir, 'share-links.bin'))).toBe(true);
    expect(await cloudA.revealLink('101')).toBe(created.code);
    expect((await cloudA.links())[0]).toMatchObject({ id: '101', codeAvailable: true });

    const b = profile('b');
    const cloudB = new CloudService({ link: server as never, sync: b.sync, dir: b.dir, vaultKey: b.vaultKey, clientVersion: '1.0.0', now: () => now });
    const content = await cloudB.shareOpen(created.code);
    expect(content.preview).toMatchObject({ kind: 'LINK', ownerUsername: 'alice' });
    expect(content.hosts.map((h) => h.name).sort()).toEqual(['jump', 'order-01']);
    expect(content.notes.map((n) => n.title)).toEqual(['交接']);
    expect(content.hasSecrets).toBe(true);
    // 只要 order-01 和笔记，不要跳板机
    const pick = { hostIds: content.hosts.filter((h) => h.name === 'order-01').map((h) => h.id), credentialIds: [], snippetIds: [], noteIds: content.notes.map((n) => n.id), withGroups: true, withCredentials: true };
    const dry = cloudB.shareImport(created.code, pick, true);
    expect(dry.applied).toBe(false);
    expect(dry.unresolvedRefs.map((r) => r.field)).toContain('jumpHostIds');
    cloudB.shareImport(created.code, pick, false);
    expect(b.hosts.list().map((h) => h.name)).toEqual(['order-01']);
    expect(b.notes.list().map((n) => n.title)).toEqual(['交接']);
    // 合并后明文已经清除
    expect(() => cloudB.shareImport(created.code, pick, true)).toThrow(/过期/);

    await cloudA.revokeLink('101');
    expect(await cloudA.links()).toEqual([]);
    await expect(cloudA.revealLink('101')).rejects.toThrow(/不存在/);
  });
});

describe('诊断日志和问题反馈（第十三轮）', () => {
  it('summarize 去掉像秘密的字段、截断长文本；日志写入前脱敏；超过 2MB 轮转', () => {
    expect(summarize({ hostId: 'h1', password: 'p', input: { name: 'web', privateKey: 'k', port: 22 }, token: 't', key: 'ui.theme' })).toEqual({ hostId: 'h1', input: { name: 'web', port: 22 }, key: 'ui.theme' });
    expect(summarize('x'.repeat(300))).toMatch(/…\(300\)$/);
    const dir = join(root, 'logs');
    const log = new DiagLog();
    log.init(dir);
    log.info('app', '连接 password=hunter2 Bearer abcdefghijklmnopqrstuvwxyz0123456789');
    log.flush();
    const text = readFileSync(join(dir, 'main.log'), 'utf8');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(log.entries()[0]).toMatchObject({ level: 'info', cat: 'app', src: 'main' });
    // 轮转：写满 2MB 之后旧文件改名为 main.old.log
    const big = 'y'.repeat(1500);
    for (let i = 0; i < 1600; i++) log.info('net', big);
    log.flush();
    expect(existsSync(join(dir, 'main.old.log'))).toBe(true);
    expect(statSync(join(dir, 'main.log')).size).toBeLessThan(2 * 1024 * 1024);
    // 内存里只保留最近 1000 条
    expect(log.entries()).toHaveLength(1000);
    const tail = log.tail(10_000);
    expect(tail.length).toBeLessThanOrEqual(10_000);
    expect(tail.split('\n')[0].startsWith('{')).toBe(true);
  });

  it('界面交来的轨迹按白名单校验；IPC 失败带错误和堆栈', () => {
    const log = new DiagLog();
    log.push([{ t: Date.now(), level: 'error', cat: 'error', msg: '界面异常' }, { level: 'nope', cat: 'ipc', msg: 'x' }, 'bad']);
    expect(log.entries().map((e) => [e.level, e.cat, e.src])).toEqual([
      ['error', 'error', 'renderer'],
      ['info', 'ui', 'renderer'],
    ]);
    expect(log.errors().map((e) => e.msg)).toEqual(['界面异常']);
  });

  it('logIpc：高频通道不记，失败记错误；FeedbackService 生成诊断包和 Markdown，IP 一致替换，匿名提交带图片和诊断包', async () => {
    const { diag } = await import('../src/main/services/diag/diag-log');
    logIpc('session.write', { data: 'ls' }, 1);
    logIpc('host.test', { id: 'h1', password: 'x' }, 120, new Error('认证失败'), true);
    const failed = diag.entries().filter((e) => e.msg === 'host.test 失败').at(-1)!;
    expect(failed).toMatchObject({ level: 'warn', cat: 'ipc', data: { ms: 120, arg: { id: 'h1' }, error: '认证失败' } });
    expect(diag.entries().some((e) => e.msg.startsWith('session.write'))).toBe(false);
    diag.error('error', '连接 10.0.1.1 失败', { host: '10.0.1.1' });

    const sent: { url: string; form: FormData }[] = [];
    const fb = new FeedbackService({
      diag,
      version: '1.0.0',
      profile: () => ({ kind: 'local', serverUrl: null, email: null }),
      link: () => null,
      anonymousServer: () => 'http://itm.example.com:51115',
      profileEnv: () => ({ 数据: { 主机: 3 } }),
      appEnv: () => ({ 运行时: { Electron: '39' } }),
      capture: async () => ({ png: Buffer.from('png'), jpeg: () => Buffer.from('jpg') }),
      fetchImpl: (async (url: string, init: { body: FormData }) => {
        sent.push({ url, form: init.body });
        return new Response(JSON.stringify({ code: 0, data: { id: 1001 } }), { status: 200 });
      }) as never,
      now: () => now,
    });
    const p = fb.preview(true);
    expect(p.target).toEqual({ anonymous: true });
    expect(p.env['数据']).toEqual({ 主机: 3 });
    expect(p.env['应用']['版本']).toBe('1.0.0');
    expect(p.markdown).toContain('## 环境');
    expect(p.markdown).toContain('## 最近的错误');
    expect(p.markdown).toContain('## 操作轨迹');
    expect(p.markdown).toContain('## 日志尾部');
    expect(p.markdown).not.toContain('10.0.1.1');
    expect(p.markdown).toContain('HOST_IP_1');
    expect(fb.preview(false).markdown).toContain('10.0.1.1');

    const img = { name: 'a.png', type: 'image/png', data: Buffer.from('fake-png').toString('base64'), size: 8 };
    await expect(fb.submit({ category: 'BUG', title: '', description: 'x', contact: '', images: [], includeDiagnostics: true, maskIps: true })).rejects.toThrow(/标题/);
    await expect(fb.submit({ category: 'BUG', title: 't', description: 'd', contact: '', images: [{ ...img, type: 'image/bmp' }], includeDiagnostics: true, maskIps: true })).rejects.toThrow(/PNG/);
    const r = await fb.submit({ category: 'BUG', title: '连不上', description: '点了连接没反应', contact: 'a@b.c', images: [img], includeDiagnostics: true, maskIps: true });
    expect(r).toEqual({ id: 1001 });
    expect(sent[0].url).toBe('http://itm.example.com:51115/api/v1/public/feedback');
    const meta = JSON.parse(String(sent[0].form.get('meta')));
    expect(meta).toMatchObject({ category: 'BUG', title: '连不上', contact: 'a@b.c', clientVersion: '1.0.0' });
    expect(sent[0].form.getAll('images')).toHaveLength(1);
    const d = JSON.parse(await (sent[0].form.get('diagnostics') as Blob).text()) as Diagnostics;
    expect(d).toMatchObject({ format: 'itm-diag', version: 1 });
    expect(d.breadcrumbs.length).toBeGreaterThan(0);
    const md = await (sent[0].form.get('diagnosticsMd') as Blob).text();
    expect(md).toContain('## 问题描述');
    expect(md).toContain('点了连接没反应');
    // 不附带诊断信息：只带版本和系统
    await fb.submit({ category: 'SUGGESTION', title: 't', description: 'd', contact: '', images: [], includeDiagnostics: false, maskIps: true });
    expect(sent[1].form.get('diagnostics')).toBeNull();
    expect(Object.keys(JSON.parse(String(sent[1].form.get('meta'))).env)).toEqual(['应用', '系统']);
    expect(relTime(now - 95_000, now)).toBe('-1m35s');
    expect((await fb.capture(1)).type).toBe('image/png');
  });
});

/** 0.x / 1.0 第一次打开时写入的示例（原样） */
const SAMPLE_V1 = `---
name: host-health-check
title: 主机健康巡检
description: 检查 CPU、内存、磁盘、负载和关键服务，给出评分和处理建议；可以对整个分组并行执行
version: 1.0.0
allowed-tools: [ssh_exec, get_metrics]
risk: readonly
triggers: [巡检, 健康检查, health]
mode: parallel
concurrency: 6
on-error: continue
output: summary
params:
  - { name: disk_threshold, type: number, default: 80, description: 磁盘使用率超过多少算异常 }
---
# 主机健康巡检

## 步骤
1. 用 uptime、free -m、df -hP 查看负载、内存和磁盘；
2. 用 ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu | head 找出占用最高的进程；
3. 用 journalctl -p err -n 50 --no-pager 查看最近的错误日志；
4. 只做只读检查，不修改任何配置。

## 输出
给出 0-100 的评分，列出磁盘超过 {{disk_threshold}}% 的挂载点、异常进程和错误日志，每条附上依据和建议。
`;

describe('去掉内置 Skill（第二十三轮）', () => {
  const sha = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n').trimEnd()).digest('hex');
  const put = (dir: string, name: string, content: string): void => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), content);
  };
  const md = (name: string, desc: string): string => `---\nname: ${name}\ndescription: ${desc}\n---\n正文\n`;

  it('以前写入、没改过的内置 Skill 删掉；改过的和用户自己同名的留下；记录文件删掉', () => {
    const dir = join(root, 'skills');
    put(dir, 'linux-perf-60s', md('linux-perf-60s', '内置版本'));
    put(dir, 'disk-space-troubleshoot', `${md('disk-space-troubleshoot', '内置版本')}我加的一行\n`);
    put(dir, 'ssl-cert-check', md('ssl-cert-check', '我自己的'));
    put(dir, 'mine', md('mine', '我自己的'));
    writeFileSync(
      join(dir, '.builtin.json'),
      JSON.stringify({
        'linux-perf-60s': { version: '1.0.0', hash: sha(md('linux-perf-60s', '内置版本')) },
        'disk-space-troubleshoot': { version: '1.0.0', hash: sha(md('disk-space-troubleshoot', '内置版本')) },
        // 写入时已经有用户自己的同名 Skill
        'ssl-cert-check': { version: '1.0.0', hash: '' },
        // 用户删掉了
        'k8s-pod-troubleshoot': { version: '1.0.0', hash: sha(md('k8s-pod-troubleshoot', '内置版本')) },
      }),
    );
    const store = new SkillStore(dir);
    expect(store.list().map((s) => s.id)).toEqual(['disk-space-troubleshoot', 'mine', 'ssl-cert-check']);
    expect(store.read('disk-space-troubleshoot')).toContain('我加的一行');
    expect(existsSync(join(dir, '.builtin.json'))).toBe(false);
    // 再打开不会再删（同名的新 Skill 是用户自己的）
    put(dir, 'linux-perf-60s', md('linux-perf-60s', '内置版本'));
    expect(new SkillStore(dir).get('linux-perf-60s')).not.toBeNull();
  });

  it('旧版示例：没改过的删掉，改过的留下；新的 Skill 目录不写入任何 Skill', () => {
    const dir = join(root, 'legacy');
    put(dir, 'host-health-check', SAMPLE_V1);
    expect(new SkillStore(dir).list()).toEqual([]);
    put(dir, 'host-health-check', `${SAMPLE_V1}\n我改过\n`);
    expect(new SkillStore(dir).list().map((s) => s.id)).toEqual(['host-health-check']);

    const fresh = join(root, 'fresh');
    expect(new SkillStore(fresh).list()).toEqual([]);
    expect(readdirSync(fresh)).toEqual([]);
  });
});
