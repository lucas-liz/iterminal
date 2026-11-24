import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostInput } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { SnippetRepo } from '../src/main/services/library/snippet-repo';
import { NoteRepo } from '../src/main/services/library/note-repo';
import { PortForwardRepo } from '../src/main/services/hosts/port-forward-repo';
import { DatasetStore } from '../src/main/services/sync/dataset-store';
import { SyncService } from '../src/main/services/sync/sync-service';
import { pack, readHeader, unpack, SHARE_AAD } from '../src/main/services/sync/itmbak';
import { sanitizeDataset } from '../src/main/services/sync/sanitize';
import {
  createCdk,
  formatShareCode,
  generateShareCode,
  normalizeShareCode,
  resetWithRecovery,
  rewrapCdk,
  sealEntity,
  openEntity,
  shareKeys,
  unwrapCdk,
  unwrapCdkWithRecovery,
} from '../src/main/services/sync/e2e-crypto';
import { createRepos } from './support/repos';
import { generateEd25519 } from './support/keys';

let root: string;
let now = 1_700_000_000_000;
const opened: Db[] = [];

function profile(name: string) {
  const dir = join(root, name);
  const vaultKey = randomBytes(32);
  const db = openDatabase(join(root, `${name}.db`), randomBytes(32));
  opened.push(db);
  const clock = () => now;
  const repos = createRepos(db, vaultKey, clock);
  const snippets = new SnippetRepo(db, clock);
  const notes = new NoteRepo(db, clock);
  const forwards = new PortForwardRepo(db);
  const store = new DatasetStore(db, vaultKey, { credentials: repos.credentials, tags: repos.tags }, clock);
  const sync = new SyncService({ db, store, settings: repos.settings, vaultKey, dir, clientVersion: '0.4.0', now: () => (now += 1000) });
  return { db, dir, vaultKey, ...repos, snippets, notes, forwards, store, sync };
}

const hostInput = (o: Partial<HostInput> & { name: string; address: string }): HostInput => ({
  folderId: null, port: 22, username: 'root', authMethod: 'PASSWORD', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [], ...o,
});

/** 一份「什么都有」的数据：多级分组、跳板、标签、收藏、端口转发、主机密码、共享密钥凭证、TOTP、命令和笔记 */
function seed(p: ReturnType<typeof profile>) {
  const key = generateEd25519();
  const prod = p.folders.create(null, '生产');
  const order = p.folders.create(prod.id, '订单');
  const shared = p.credentials.save(null, { type: 'SSH_KEY', name: '部署密钥', username: 'deploy', secret: key.private, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
  const otp = p.credentials.save(null, { type: 'PASSWORD', name: '堡垒机', username: 'ops', secret: 'bastion-pw', otpSeed: 'JBSWY3DPEHPK3PXP', aiAccess: 'DENY', rotateDays: null, expiresAt: null, note: null });
  p.folders.update(order.id, { defaultCredentialId: shared.id, defaultJumpHostId: null, agentPolicy: 'READONLY', aiNote: '订单系统', defaultSkills: ['disk-check'], production: true });
  const jump = p.hosts.create(hostInput({ name: 'jump', address: '10.0.0.9', folderId: prod.id, authMethod: 'CREDENTIAL', credentialId: otp.id }));
  const web = p.hosts.create(
    hostInput({
      name: 'order-01', address: '10.0.1.1', folderId: order.id, password: 's3cret', jumpHostIds: [jump.id], tags: ['prod', 'web'], favorite: true,
      env: { LANG: 'C' }, proxy: { type: 'SOCKS5', host: '127.0.0.1', port: 1080, username: 'px' }, proxyPassword: 'proxy-pw', note: '本地备注',
    }),
  );
  const db = p.hosts.create(hostInput({ name: 'db-01', address: '10.0.1.2', folderId: order.id, authMethod: 'CREDENTIAL', credentialId: shared.id }));
  p.forwards.save(null, web.id, { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 15432, targetAddr: '10.0.1.2', targetPort: 5432, autoStart: true });
  const ops = p.snippets.groups.save(null, '运维');
  p.snippets.save(null, { groupId: ops, name: '看磁盘', content: 'df -h', tags: ['disk'] });
  p.snippets.save(null, { groupId: null, name: '负载', content: 'uptime' });
  const ng = p.notes.groups.save(null, '值班');
  p.notes.save(null, { groupId: ng, title: '交接', content: '# 交接\n- 检查磁盘' });
  return { prod, order, shared, otp, jump, web, db, key };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'itm-sync-'));
});

afterEach(() => {
  opened.splice(0).forEach((d) => d.close());
  rmSync(root, { recursive: true, force: true });
});

describe('本地导出 / 导入（.itmbak）', () => {
  it('全部分组导出后导入到另一个档案：分组层级、跳板、标签、收藏、端口转发、密码和私钥都还原', async () => {
    const a = profile('a');
    const s = seed(a);
    const file = join(root, 'all.itmbak');
    const info = await a.sync.export(['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], file, 'export-pass');
    expect(info.counts).toEqual({ hosts: 3, hostGroups: 2, snippets: 2, snippetGroups: 1, notes: 1, noteGroups: 1, skills: 0, credentials: 2 });
    expect(a.sync.stats().lastBackupAt).toBe(info.createdAt);
    // header 是明文，body 是密文：文件里找不到密码
    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from('s3cret'))).toBe(false);
    expect(raw.includes(Buffer.from('order-01'))).toBe(false);
    expect(a.sync.inspect(file)).toMatchObject({ kind: 'export', formatVersion: 2, groups: ['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'] });

    const b = profile('b');
    const preview = await b.sync.import(file, 'export-pass', ['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], 'merge', true);
    expect(preview).toMatchObject({ applied: false, mode: 'merge', unresolvedRefs: [] });
    expect(preview.perType.hosts).toEqual({ added: 3, kept: 0, filled: 0 });
    expect(b.hosts.list()).toEqual([]);

    const done = await b.sync.import(file, 'export-pass', ['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], 'merge', false);
    expect(done.applied).toBe(true);
    expect(b.store.counts()).toEqual(info.counts);
    // 自己的备份：id 不变
    const web = b.hosts.require(s.web.id);
    expect(web).toMatchObject({ name: 'order-01', folderId: s.order.id, jumpHostIds: [s.jump.id], tags: ['prod', 'web'], favorite: true, env: { LANG: 'C' }, hasPassword: true });
    const ci = b.hosts.connectInfo(s.web.id);
    expect(ci.auth.password).toBe('s3cret');
    expect(ci.proxy?.password).toBe('proxy-pw');
    expect(b.hosts.connectInfo(s.db.id).auth).toMatchObject({ method: 'KEY', privateKey: s.key.private, username: a.hosts.connectInfo(s.db.id).auth.username });
    expect(b.hosts.connectInfo(s.jump.id).auth).toMatchObject({ password: 'bastion-pw', otpSeed: 'JBSWY3DPEHPK3PXP' });
    expect(b.folders.require(s.order.id)).toMatchObject({ parentId: s.prod.id, path: `/${s.prod.id}/${s.order.id}/`, defaultCredentialId: s.shared.id, aiNote: '订单系统', production: true });
    expect(b.credentials.require(s.shared.id)).toMatchObject({ fingerprint: a.credentials.require(s.shared.id).fingerprint, hasSecret: true });
    expect(b.forwards.list(s.web.id)).toMatchObject([{ bindPort: 15432, targetPort: 5432, autoStart: true }]);
    expect(b.snippets.list().map((x) => x.name).sort()).toEqual(['看磁盘', '负载']);
    expect(b.notes.list()[0]).toMatchObject({ title: '交接', content: '# 交接\n- 检查磁盘' });

    // 再导入一次：全部识别为同一条，什么都不新增
    const again = await b.sync.import(file, 'export-pass', ['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], 'merge', true);
    expect(Object.values(again.perType).every((x) => (x as { added: number }).added === 0)).toBe(true);
  });

  it('导出密码错误、header 被改动、不是备份文件时给出明确的错误', async () => {
    const a = profile('a');
    seed(a);
    const file = join(root, 'x.itmbak');
    await expect(a.sync.export(['HOSTS'], file, 'short')).rejects.toThrow('导出密码至少 8 位');
    await a.sync.export(['HOSTS'], file, 'export-pass');
    await expect(a.sync.import(file, 'wrong-pass', ['HOSTS'], 'merge', true)).rejects.toThrow('导出密码不正确');
    // 把 header 里的分组改掉：AAD 不一致，解密失败
    const raw = readFileSync(file);
    const nl = raw.indexOf(0x0a);
    const header = JSON.parse(raw.subarray(0, nl).toString()) as { groups: string[] };
    header.groups = ['HOSTS', 'CREDENTIALS'];
    writeFileSync(file, Buffer.concat([Buffer.from(JSON.stringify(header)), raw.subarray(nl)]));
    await expect(a.sync.import(file, 'export-pass', ['HOSTS'], 'merge', true)).rejects.toThrow('导出密码不正确，或者文件已损坏');
    writeFileSync(file, 'hello\nworld');
    expect(() => a.sync.inspect(file)).toThrow('不是 iTerminal 备份文件');
    expect(() => a.sync.inspect(join(root, 'missing.itmbak'))).toThrow('找不到这个文件');
  });

  it('不含凭证分组时，文件里没有任何密码和私钥；导入后主机需要重新选择凭证', async () => {
    const a = profile('a');
    const s = seed(a);
    const file = join(root, 'hosts.itmbak');
    await a.sync.export(['HOSTS', 'SNIPPETS'], file, 'export-pass');
    const header = readHeader(readFileSync(file)).header;
    expect(header.counts.credentials).toBe(0);
    const b = profile('b');
    const r = await b.sync.import(file, 'export-pass', ['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], 'merge', false);
    expect(r.groups).toEqual(['HOSTS', 'SNIPPETS']);
    expect(r.unresolvedRefs.map((x) => `${x.name}.${x.field}`).sort()).toEqual(['db-01.credentialId', 'jump.credentialId', '订单.defaultCredentialId']);
    expect(b.hosts.require(s.web.id)).toMatchObject({ hasPassword: false, proxy: { hasPassword: false } });
    expect(b.hosts.require(s.db.id).credentialId).toBeNull();
    expect(b.notes.list()).toEqual([]);
  });

  it('合并到已有数据：同一台主机保留本地的地址和配置，只补空；写入前自动备份，可以撤回', async () => {
    const a = profile('a');
    seed(a);
    const file = join(root, 'a.itmbak');
    await a.sync.export(['HOSTS', 'SNIPPETS'], file, 'export-pass');

    const b = profile('b');
    const folder = b.folders.ensurePath(['生产', '订单']);
    const mine = b.hosts.create(hostInput({ name: 'ORDER-01', address: '192.168.1.1', folderId: folder, tags: ['mine'] }));
    b.snippets.save(null, { groupId: null, name: '我的负载', content: '  uptime\n' });
    const r = await b.sync.import(file, 'export-pass', ['HOSTS', 'SNIPPETS'], 'merge', false);
    expect(r.perType.hosts).toEqual({ added: 2, kept: 0, filled: 1 });
    // 「生产」没有可补的字段，「订单」补上 AI 说明、默认 Skill 等（默认凭证没导出，不补）
    expect(r.perType.hostGroups).toEqual({ added: 0, kept: 1, filled: 1 });
    expect(r.perType.snippets).toEqual({ added: 1, kept: 1, filled: 0 });
    const h = b.hosts.require(mine.id);
    expect(h).toMatchObject({ name: 'ORDER-01', address: '192.168.1.1', note: '本地备注', tags: ['mine', 'prod', 'web'] });
    expect(b.hosts.list()).toHaveLength(3);
    expect(b.folders.list()).toHaveLength(2);
    expect(b.forwards.list(mine.id)).toHaveLength(1);
    expect(r.autoBackup).toMatch(/^auto-.*\.itmbak$/);

    const list = b.sync.autoList();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: r.autoBackup, groups: ['HOSTS', 'SNIPPETS'], reason: '导入 a.itmbak 之前' });
    expect(list[0].counts).toMatchObject({ hosts: 1, snippets: 1 });
    const undo = b.sync.autoRestore(r.autoBackup!, true);
    expect(undo.perType.hosts).toEqual({ added: 0, updated: 1, removed: 2, unchanged: 0 });
    b.sync.autoRestore(r.autoBackup!, false);
    expect(b.hosts.list().map((x) => x.name)).toEqual(['ORDER-01']);
    expect(b.hosts.require(mine.id)).toMatchObject({ note: null, tags: ['mine'] });
    expect(b.forwards.list(mine.id)).toEqual([]);
    expect(b.snippets.list().map((x) => x.name)).toEqual(['我的负载']);
    // 撤回本身也先做了一份备份
    expect(b.sync.autoList()).toHaveLength(2);
  });

  it('覆盖本地：选中分组以文件为准，本地多出的条目删除；没选凭证时保留本机主机的密码', async () => {
    const a = profile('a');
    const s = seed(a);
    const file = join(root, 'a.itmbak');
    await a.sync.export(['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], file, 'export-pass');
    const b = profile('b');
    await b.sync.import(file, 'export-pass', ['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], 'merge', false);

    // b 上改动：web 改地址、多一台主机、多一条命令
    b.hosts.update(s.web.id, { ...hostInput({ name: 'order-01', address: '10.9.9.9', folderId: s.order.id }), jumpHostIds: [s.jump.id] });
    b.hosts.create(hostInput({ name: 'extra', address: '1.2.3.4' }));
    b.snippets.save(null, { groupId: null, name: '多出来的', content: 'id' });
    const hostsOnly = join(root, 'hosts-only.itmbak');
    await a.sync.export(['HOSTS', 'SNIPPETS'], hostsOnly, 'export-pass');
    const dry = await b.sync.import(hostsOnly, 'export-pass', ['HOSTS', 'SNIPPETS'], 'replace', true);
    expect(dry.mode).toBe('replace');
    expect(dry.perType.hosts).toEqual({ added: 0, updated: 1, removed: 1, unchanged: 2 });
    expect(dry.perType.snippets).toEqual({ added: 0, updated: 0, removed: 1, unchanged: 2 });
    await b.sync.import(hostsOnly, 'export-pass', ['HOSTS', 'SNIPPETS'], 'replace', false);
    expect(b.hosts.list().map((h) => h.name).sort()).toEqual(['db-01', 'jump', 'order-01']);
    expect(b.hosts.require(s.web.id).address).toBe('10.0.1.1');
    // 文件里没有密码（没选凭证），本机原来的密码保留
    expect(b.hosts.connectInfo(s.web.id).auth.password).toBe('s3cret');
    expect(b.snippets.list()).toHaveLength(2);
    expect(b.notes.list()).toHaveLength(1);
  });

  it('删除过的条目从自己的备份恢复时沿用原 id（墓碑复活）', async () => {
    const a = profile('a');
    const s = seed(a);
    const file = join(root, 'a.itmbak');
    await a.sync.export(['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'], file, 'export-pass');
    a.hosts.delete([s.db.id]);
    a.notes.delete(a.notes.list().map((n) => n.id));
    const r = await a.sync.import(file, 'export-pass', ['HOSTS', 'NOTES'], 'merge', false);
    expect(r.perType.hosts.added).toBe(1);
    expect(a.hosts.require(s.db.id)).toMatchObject({ name: 'db-01', credentialId: s.shared.id });
    expect(a.notes.list()).toHaveLength(1);
  });

  it('自动备份只保留最近 5 份', async () => {
    const a = profile('a');
    seed(a);
    const file = join(root, 'a.itmbak');
    await a.sync.export(['SNIPPETS'], file, 'export-pass');
    for (let i = 0; i < 7; i++) await a.sync.import(file, 'export-pass', ['SNIPPETS'], 'merge', false);
    expect(readdirSync(join(a.dir, 'backups')).filter((f) => f.endsWith('.itmbak'))).toHaveLength(5);
    expect(() => a.sync.autoRestore('../../etc/passwd', true)).toThrow('自动备份不存在');
    // 其他档案的自动备份解不开
    const b = profile('b');
    const name = a.sync.autoList()[0].name;
    expect(b.sync.autoList()).toEqual([]);
    writeFileSync(join(b.dir, 'backups', name), readFileSync(join(a.dir, 'backups', name)));
    expect(() => b.sync.autoRestore(name, true)).toThrow('自动备份无法解密');
  });
});

describe('备份包格式与校验', () => {
  it('分享包用 itmshare:v1 作为 AAD，其余用 header 原文', () => {
    const key = randomBytes(32);
    const counts = { hosts: 0, hostGroups: 0, snippets: 0, snippetGroups: 0, notes: 0, noteGroups: 0, skills: 0, credentials: 0 };
    const base = { createdAt: 1, deviceName: 'd', platform: 'macos', clientVersion: '1', groups: ['NOTES' as const], counts };
    const share = pack({ ...base, kind: 'share', enc: { alg: 'AES-256-GCM', key: 'share' } }, { notes: [] }, key);
    expect(unpack(share, key).body).toEqual({ notes: [] });
    expect(SHARE_AAD).toBe('itmshare:v1');
    expect(() => unpack(share, randomBytes(32))).toThrow('密码不正确');
    const future = Buffer.from(JSON.stringify({ format: 'itmbak', formatVersion: 3, kind: 'export' }) + '\n' + 'x'.repeat(40));
    expect(() => readHeader(future)).toThrow('请先升级客户端');
  });

  it('来自别人的数据逐字段校验：不合法的条目丢弃，分组的环被断开', () => {
    const d = sanitizeDataset(
      {
        hosts: [
          { id: 'h1', name: 'ok', protocol: 'SSH', address: 'a', port: 99999, tags: ['x', 1, 'x'], authMethod: 'EVIL' },
          { id: 'h2', name: '', protocol: 'SSH' },
          { id: 'h1', name: 'dup', protocol: 'SSH' },
          { id: '../x', name: 'bad id', protocol: 'SSH' },
          { id: 'h3', name: 'rdp', protocol: 'RDP' },
        ],
        hostGroups: [
          { id: 'f1', name: 'a/b', parentId: 'f2' },
          { id: 'f2', name: 'b', parentId: 'f1' },
        ],
        notes: [{ id: 'n1', title: 't' }],
      },
      ['HOSTS'],
    );
    expect(d.hosts).toHaveLength(1);
    expect(d.hosts[0]).toMatchObject({ port: 22, tags: ['x'], authMethod: 'PASSWORD' });
    expect(d.hostGroups.find((f) => f.id === 'f1')!.name).toBe('a／b');
    expect(d.hostGroups.some((f) => f.parentId === null)).toBe(true);
    expect(d.notes).toEqual([]);
  });
});

describe('端到端加密：分享码与 CDK', () => {
  it('分享码：25 位 Crockford Base32，规范化后派生的 lookupToken / shareKey 稳定且互不相同', () => {
    const code = generateShareCode();
    expect(code).toMatch(/^ITM-([0-9A-HJKMNP-TV-Z]{5}-){4}[0-9A-HJKMNP-TV-Z]{5}$/);
    const raw = normalizeShareCode(code)!;
    expect(formatShareCode(raw)).toBe(code);
    // 粘贴时的空格、小写、O / I / L 都能识别
    const messy = ` itm ${raw.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')} `;
    expect(normalizeShareCode(messy)).toBe(raw);
    expect(normalizeShareCode('ITM-UUUUU-UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull();
    expect(normalizeShareCode('ITM-12345')).toBeNull();
    const k1 = shareKeys(code);
    const k2 = shareKeys(messy);
    expect(k1.lookupToken).toBe(k2.lookupToken);
    expect(k1.shareKey.equals(k2.shareKey)).toBe(true);
    expect(Buffer.from(k1.lookupToken, 'base64url').equals(k1.shareKey)).toBe(false);
    expect(shareKeys(generateShareCode()).lookupToken).not.toBe(k1.lookupToken);
    expect(() => shareKeys('nope')).toThrow('分享码格式不正确');
  });

  it('CDK：同步密码包装 / 恢复码包装 / 改密码 / 用恢复码重置', async () => {
    await expect(createCdk('short')).rejects.toThrow('同步密码至少 10 位');
    const { cdk, wrapped, recoveryCode } = await createCdk('sync-password-1');
    expect(recoveryCode.split(' ')).toHaveLength(24);
    expect((await unwrapCdk(wrapped, 'sync-password-1')).equals(cdk)).toBe(true);
    await expect(unwrapCdk(wrapped, 'sync-password-2')).rejects.toThrow('同步密码不正确');
    expect(unwrapCdkWithRecovery(wrapped, recoveryCode.toUpperCase()).equals(cdk)).toBe(true);
    expect(() => unwrapCdkWithRecovery(wrapped, 'abandon '.repeat(24))).toThrow('恢复码不正确');

    const re = await rewrapCdk(cdk, 'sync-password-2', wrapped.keyVersion);
    expect((await unwrapCdk({ ...re, keyVersion: 1 }, 'sync-password-2')).equals(cdk)).toBe(true);

    const reset = await resetWithRecovery(wrapped, recoveryCode, 'sync-password-3');
    expect(reset.cdk.equals(cdk)).toBe(true);
    expect(reset.recoveryCode).not.toBe(recoveryCode);
    expect((await unwrapCdk(reset.wrapped, 'sync-password-3')).equals(cdk)).toBe(true);
    // 旧恢复码随之失效
    expect(() => unwrapCdkWithRecovery(reset.wrapped, recoveryCode)).toThrow('恢复码不正确');

    // 实体密文绑定 {实体类型}:{clientId}，不能在记录之间调换
    const sealed = sealEntity(cdk, 'CREDENTIAL', 'c1', { secret: 'x' });
    expect(openEntity(cdk, 'CREDENTIAL', 'c1', sealed)).toEqual({ secret: 'x' });
    expect(() => openEntity(cdk, 'CREDENTIAL', 'c2', sealed)).toThrow();
  });
});
