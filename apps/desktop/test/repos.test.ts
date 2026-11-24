import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateEd25519 } from './support/keys';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostInput } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { FolderRepo } from '../src/main/services/hosts/folder-repo';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { SettingsRepo } from '../src/main/services/settings/settings-repo';
import { KeyStore, type KeyProtector } from '../src/main/services/vault/keystore';
import { open, seal } from '../src/main/services/vault/vault';
import { createRepos } from './support/repos';

/** 测试用的「钥匙串」：异或混淆即可，只验证读写流程 */
const fakeProtector: KeyProtector = {
  strength: 'weak',
  encrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
};

let dir: string;
let db: Db;
let folders: FolderRepo;
let hosts: HostRepo;
const vaultKey = randomBytes(32);

function hostInput(over: Partial<HostInput> = {}): HostInput {
  return {
    folderId: null,
    name: 'web-01',
    address: '10.0.0.1',
    port: 22,
    username: 'root',
    authMethod: 'PASSWORD',
    password: 's3cret',
    keepaliveSec: 30,
    startupScript: null,
    note: null,
    jumpHostIds: [],
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-test-'));
  db = openDatabase(join(dir, 'iterminal.db'), randomBytes(32));
  ({ folders, hosts } = createRepos(db, vaultKey));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('数据库与密钥', () => {
  it('整库加密：文件头不是明文 SQLite，换密钥打不开', () => {
    const file = join(dir, 'enc.db');
    const key = randomBytes(32);
    const d = openDatabase(file, key);
    createRepos(d, vaultKey).folders.create(null, '生产');
    d.close();
    expect(readFileSync(file).subarray(0, 16).toString('latin1')).not.toContain('SQLite format');
    expect(() => openDatabase(file, randomBytes(32))).toThrow();
    const again = openDatabase(file, key);
    expect(createRepos(again, vaultKey).folders.list().map((f) => f.name)).toEqual(['生产']);
    again.close();
  });

  it('档案密钥首次生成后可以原样读回', async () => {
    const ks = new KeyStore(dir, fakeProtector);
    await ks.unlock();
    const pdir = join(dir, 'p1');
    const first = ks.profileKeys(pdir, 'p1');
    const again = new KeyStore(dir, fakeProtector);
    await again.unlock();
    const second = again.profileKeys(pdir, 'p1');
    expect(second.dbKey.equals(first.dbKey)).toBe(true);
    expect(second.vaultKey.equals(first.vaultKey)).toBe(true);
    expect(readFileSync(join(pdir, 'keys.bin')).toString('utf8')).not.toContain(first.dbKey.toString('hex'));
    // 密钥文件绑定档案 ID：换个档案 ID 解不开
    expect(() => again.profileKeys(pdir, 'p2')).toThrow('无法解开');
  });

  it('保险库密文绑定 AAD，换记录解不开', () => {
    const sealed = seal(vaultKey, 'pw', 'credential:a');
    expect(open(vaultKey, sealed, 'credential:a')).toBe('pw');
    expect(() => open(vaultKey, sealed, 'credential:b')).toThrow();
  });
});

describe('主机分组', () => {
  it('创建多级分组，路径是物化路径', () => {
    const prod = folders.create(null, '生产');
    const order = folders.create(prod.id, '订单');
    expect(order.path).toBe(`/${prod.id}/${order.id}/`);
    expect(order.parentId).toBe(prod.id);
  });

  it('同一层级不能重名（忽略大小写），不同层级可以', () => {
    const a = folders.create(null, 'Prod');
    expect(() => folders.create(null, 'prod')).toThrow('同一层级');
    expect(() => folders.create(a.id, 'Prod')).not.toThrow();
  });

  it('最多 8 级', () => {
    let parent: string | null = null;
    for (let i = 0; i < 8; i++) {
      parent = folders.create(parent, `L${i}`).id;
    }
    expect(() => folders.create(parent, 'L8')).toThrow('8 级');
  });

  it('移动分组会改写整棵子树的路径，不能移进自己的子树', () => {
    const a = folders.create(null, 'A');
    const b = folders.create(a.id, 'B');
    const c = folders.create(b.id, 'C');
    const x = folders.create(null, 'X');
    expect(() => folders.move(a.id, c.id)).toThrow('子分组');
    folders.move(b.id, x.id);
    expect(folders.get(c.id)!.path).toBe(`/${x.id}/${b.id}/${c.id}/`);
    expect(folders.get(b.id)!.parentId).toBe(x.id);
  });

  it('删除分组（移到上级）：子分组和主机上移，同名子分组自动加序号', () => {
    const a = folders.create(null, 'A');
    folders.create(null, 'B');
    const innerB = folders.create(a.id, 'B');
    const h = hosts.create(hostInput({ folderId: a.id }));
    folders.delete(a.id, 'MOVE_TO_PARENT');
    expect(folders.get(a.id)).toBeNull();
    const moved = folders.get(innerB.id)!;
    expect(moved.parentId).toBeNull();
    expect(moved.name).toBe('B (2)');
    expect(moved.path).toBe(`/${innerB.id}/`);
    expect(hosts.get(h.id)!.folderId).toBeNull();
  });

  it('删除分组（连带删除）：子分组、主机和主机凭证一起删除', () => {
    const a = folders.create(null, 'A');
    const b = folders.create(a.id, 'B');
    const h = hosts.create(hostInput({ folderId: b.id }));
    folders.delete(a.id, 'CASCADE');
    expect(folders.list()).toEqual([]);
    expect(hosts.get(h.id)).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM credential WHERE deleted = 0').get()).toEqual({ n: 0 });
  });
});

describe('主机', () => {
  it('列表只返回是否保存了密码，不返回密码本身', () => {
    const h = hosts.create(hostInput());
    expect(h.hasPassword).toBe(true);
    expect(JSON.stringify(hosts.list())).not.toContain('s3cret');
    expect(hosts.connectInfo(h.id).auth).toMatchObject({ method: 'PASSWORD', password: 's3cret', rememberable: true });
    // 数据库里的密文也不含明文
    const row = db.prepare('SELECT secret_enc FROM credential').get() as { secret_enc: Buffer };
    expect(row.secret_enc.toString('latin1')).not.toContain('s3cret');
  });

  it('修改时 undefined 保持秘密不变，null 清除', () => {
    const h = hosts.create(hostInput());
    hosts.update(h.id, hostInput({ name: 'web-01a', password: undefined }));
    expect(hosts.connectInfo(h.id).auth.password).toBe('s3cret');
    const cleared = hosts.update(h.id, hostInput({ password: null }));
    expect(cleared.hasPassword).toBe(false);
    expect(hosts.connectInfo(h.id).auth.password).toBeUndefined();
  });

  it('切换到 ssh-agent 时丢弃已保存的密码', () => {
    const h = hosts.create(hostInput());
    const updated = hosts.update(h.id, hostInput({ authMethod: 'AGENT', password: undefined }));
    expect(updated.hasPassword).toBe(false);
    expect(hosts.connectInfo(h.id).auth.method).toBe('AGENT');
    expect(hosts.connectInfo(h.id).auth.password).toBeUndefined();
    expect(db.prepare('SELECT count(*) AS n FROM credential WHERE deleted = 0').get()).toEqual({ n: 0 });
  });

  it('私钥：格式校验、记录公钥指纹', () => {
    const { private: privateKey } = generateEd25519();
    expect(() => hosts.create(hostInput({ authMethod: 'KEY', password: undefined, privateKey: 'not a key' }))).toThrow('私钥格式');
    expect(() => hosts.create(hostInput({ authMethod: 'KEY', password: undefined, privateKey: null }))).toThrow('请提供私钥');
    const h = hosts.create(hostInput({ authMethod: 'KEY', password: undefined, privateKey }));
    expect(h.hasPrivateKey).toBe(true);
    expect(h.hasPassword).toBe(false);
    const fp = db.prepare('SELECT fingerprint FROM credential').get() as { fingerprint: string };
    expect(fp.fingerprint).toMatch(/^SHA256:/);
  });

  it('加密私钥：可以先不保存口令（连接时再问），口令错误时拒绝保存', () => {
    const { private: privateKey } = generateEd25519({ passphrase: 'pp', cipher: 'aes256-ctr', rounds: 16 });
    const base = hostInput({ authMethod: 'KEY', password: undefined, privateKey });
    expect(hosts.create(base).hasPrivateKey).toBe(true);
    expect(() => hosts.create({ ...base, passphrase: 'wrong' })).toThrow('口令不正确');
    const ok = hosts.create({ ...base, passphrase: 'pp' });
    expect(hosts.connectInfo(ok.id).auth.passphrase).toBe('pp');
  });

  it('参数校验', () => {
    expect(() => hosts.create(hostInput({ address: ' ' }))).toThrow('地址');
    expect(() => hosts.create(hostInput({ port: 70000 }))).toThrow('端口');
    expect(() => hosts.create(hostInput({ username: '' }))).toThrow('用户名');
    expect(() => hosts.create(hostInput({ folderId: 'nope' }))).toThrow('分组不存在');
    expect(hosts.create(hostInput({ name: '  ' })).name).toBe('10.0.0.1');
  });

  it('复制主机时凭证独立复制', () => {
    const h = hosts.create(hostInput());
    const copy = hosts.duplicate(h.id);
    expect(copy.name).toBe('web-01 (副本)');
    expect(hosts.connectInfo(copy.id).auth.password).toBe('s3cret');
    hosts.delete([h.id]);
    expect(hosts.connectInfo(copy.id).auth.password).toBe('s3cret');
  });

  it('连接时勾选「记住密码」：交互式认证改为密码认证', () => {
    const h = hosts.create(hostInput({ authMethod: 'INTERACTIVE', password: undefined }));
    hosts.remember(h.id, 'password', 'typed');
    const after = hosts.require(h.id);
    expect(after.authMethod).toBe('PASSWORD');
    expect(hosts.connectInfo(h.id).auth.password).toBe('typed');
  });

  it('主机指纹记录与更新', () => {
    expect(hosts.knownFingerprint('10.0.0.1', 22, 'ssh-ed25519')).toBeNull();
    hosts.saveFingerprint('10.0.0.1', 22, 'ssh-ed25519', 'SHA256:a');
    hosts.saveFingerprint('10.0.0.1', 22, 'ssh-ed25519', 'SHA256:b');
    expect(hosts.knownFingerprint('10.0.0.1', 22, 'ssh-ed25519')).toBe('SHA256:b');
  });
});

describe('跳板机', () => {
  it('保存跳板链并按顺序返回，复制主机时一起复制', () => {
    const j1 = hosts.create(hostInput({ name: 'j1' }));
    const j2 = hosts.create(hostInput({ name: 'j2' }));
    const t = hosts.create(hostInput({ name: 't', jumpHostIds: [j1.id, j2.id] }));
    expect(t.jumpHostIds).toEqual([j1.id, j2.id]);
    expect(hosts.list().find((h) => h.id === t.id)!.jumpHostIds).toEqual([j1.id, j2.id]);
    expect(hosts.duplicate(t.id).jumpHostIds).toEqual([j1.id, j2.id]);
    expect(hosts.update(t.id, hostInput({ name: 't', jumpHostIds: [] })).jumpHostIds).toEqual([]);
  });

  it('不能用自己、不能重复、不能形成循环、最多 5 跳', () => {
    const a = hosts.create(hostInput({ name: 'a' }));
    const b = hosts.create(hostInput({ name: 'b', jumpHostIds: [a.id] }));
    expect(() => hosts.update(a.id, hostInput({ name: 'a', jumpHostIds: [a.id] }))).toThrow('自己');
    expect(() => hosts.update(b.id, hostInput({ name: 'b', jumpHostIds: [a.id, a.id] }))).toThrow('重复');
    // a 经过 b，而 b 的第一跳是 a → 循环
    expect(() => hosts.update(a.id, hostInput({ name: 'a', jumpHostIds: [b.id] }))).toThrow('循环');
    const many = Array.from({ length: 6 }, (_, i) => hosts.create(hostInput({ name: `m${i}` })).id);
    expect(() => hosts.create(hostInput({ jumpHostIds: many }))).toThrow('最多');
    expect(() => hosts.create(hostInput({ jumpHostIds: ['nope'] }))).toThrow('不存在');
  });

  it('被用作跳板的主机不能删除（包括连带删除分组）', () => {
    const f = folders.create(null, '跳板');
    const j = hosts.create(hostInput({ name: 'bastion', folderId: f.id }));
    hosts.create(hostInput({ name: 'app', jumpHostIds: [j.id] }));
    expect(() => hosts.delete([j.id])).toThrow('「bastion」是「app」的跳板机');
    expect(() => folders.delete(f.id, 'CASCADE')).toThrow('跳板机');
    expect(hosts.get(j.id)).not.toBeNull();
  });

  it('测试连接的临时目标：修改已有主机时沿用已保存的密码', () => {
    const h = hosts.create(hostInput());
    const t = hosts.testTarget(h.id, hostInput({ address: '10.0.0.9', password: undefined }));
    expect(t.host.address).toBe('10.0.0.9');
    expect(t.auth.password).toBe('s3cret');
    expect(hosts.get(h.id)!.address).toBe('10.0.0.1'); // 没有保存
  });
});

describe('设置', () => {
  it('默认值、合法值写入、非法值拒绝', () => {
    const settings = new SettingsRepo(db);
    expect(settings.getAll()['terminal.fontSize']).toBe(14);
    settings.set('terminal.fontSize', 16);
    settings.set('ui.theme', 'light');
    expect(settings.getAll()).toMatchObject({ 'terminal.fontSize': 16, 'ui.theme': 'light' });
    expect(() => settings.set('terminal.fontSize', 100)).toThrow('不合法');
  });
});
