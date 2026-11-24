import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { TeamAssetSync, TEAM_ROOT_NAME, type TeamAssets } from '../src/main/services/server/team-assets';
import { createRepos } from './support/repos';

let dir: string;
let db: Db;
let repos: ReturnType<typeof createRepos>;
let sync: TeamAssetSync;

const host = (id: number, over: Partial<TeamAssets['hosts'][number]> = {}): TeamAssets['hosts'][number] => ({
  id,
  folderId: null,
  name: `team-${id}`,
  protocol: 'SSH',
  address: `10.0.0.${id}`,
  port: 22,
  username: 'root',
  authMethod: 'PASSWORD',
  password: `pw-${id}`,
  privateKey: null,
  passphrase: null,
  allowReveal: false,
  note: null,
  version: 1,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-team-assets-'));
  db = openDatabase(join(dir, 'test.db'), randomBytes(32));
  repos = createRepos(db, randomBytes(32));
  sync = new TeamAssetSync({ db, hosts: repos.hosts, folders: repos.folders });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const teamHosts = () => repos.hosts.list().filter((h) => h.team);
const folderOf = (name: string) => repos.folders.list().find((f) => f.name === name);

describe('团队主机同步', () => {
  it('建「团队主机」根分组和子分组，主机带凭证、只读标记；版本没变时不重复写入', () => {
    const data: TeamAssets = {
      folders: [
        { id: 10, parentId: null, name: '生产' },
        { id: 11, parentId: 10, name: '数据库' },
      ],
      hosts: [host(1, { folderId: 11, allowReveal: true }), host(2)],
    };
    expect(sync.apply(data)).toEqual({ added: 2, updated: 0, removed: 0 });
    const root = folderOf(TEAM_ROOT_NAME)!;
    expect(root.team).toBe(true);
    const prod = folderOf('生产')!;
    const dbf = folderOf('数据库')!;
    expect(prod.parentId).toBe(root.id);
    expect(dbf.parentId).toBe(prod.id);
    const [h1, h2] = [teamHosts().find((h) => h.name === 'team-1')!, teamHosts().find((h) => h.name === 'team-2')!];
    expect(h1.folderId).toBe(dbf.id);
    expect(h1.team).toEqual({ allowReveal: true });
    expect(h2.folderId).toBe(root.id);
    expect(h2.team).toEqual({ allowReveal: false });
    expect(h1.hasPassword).toBe(true);
    // 版本没变：跳过
    expect(sync.apply(data)).toEqual({ added: 0, updated: 0, removed: 0 });
    // 改了版本：更新地址
    expect(sync.apply({ ...data, hosts: [host(1, { folderId: 11, version: 2, address: '10.9.9.9', allowReveal: true }), host(2)] })).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(repos.hosts.get(h1.id)!.address).toBe('10.9.9.9');
  });

  it('只读：团队主机不能改、不能删、不能把个人主机放进团队分组；没允许时不能查看密码', () => {
    sync.apply({ folders: [], hosts: [host(1)] });
    const h = teamHosts()[0];
    const root = folderOf(TEAM_ROOT_NAME)!;
    expect(() => sync.assertEditableHosts([h.id])).toThrow('团队主机由管理员');
    expect(() => sync.assertPersonalTarget(root.id)).toThrow('不能放入个人主机');
    expect(() => sync.assertEditableFolder(root.id)).toThrow('团队主机分组');
    const personal = repos.hosts.create({ folderId: null, name: 'mine', address: '1.1.1.1', port: 22, username: 'u', authMethod: 'PASSWORD', password: 'x', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [] });
    expect(() => sync.assertEditableHosts([personal.id])).not.toThrow();
    expect(() => sync.assertPersonalTarget(null)).not.toThrow();
    const cred = db.prepare<[string], { credential_id: string }>('SELECT credential_id FROM host WHERE id = ?').get(h.id)!;
    expect(() => sync.assertRevealable(cred.credential_id)).toThrow('没有允许查看');
  });

  it('服务端删除的主机和分组本机也删除；个人主机用团队主机当跳板时先去掉跳板；没有团队主机时删掉根分组', () => {
    sync.apply({ folders: [{ id: 10, parentId: null, name: '生产' }], hosts: [host(1, { folderId: 10 }), host(2)] });
    const jump = teamHosts().find((h) => h.name === 'team-1')!;
    const personal = repos.hosts.create({ folderId: null, name: 'via-jump', address: '1.1.1.1', port: 22, username: 'u', authMethod: 'PASSWORD', password: 'x', keepaliveSec: 30, startupScript: null, note: null, jumpHostIds: [jump.id] });
    expect(sync.apply({ folders: [], hosts: [host(2)] })).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(teamHosts().map((h) => h.name)).toEqual(['team-2']);
    expect(folderOf('生产')).toBeUndefined();
    expect(repos.hosts.get(personal.id)!.jumpHostIds).toEqual([]);
    // 同一台主机再次下发：墓碑不影响重新创建
    expect(sync.apply({ folders: [], hosts: [host(1), host(2)] }).added).toBe(1);
    expect(sync.apply({ folders: [], hosts: [] }).removed).toBe(2);
    expect(folderOf(TEAM_ROOT_NAME)).toBeUndefined();
    expect(repos.hosts.get(personal.id)).not.toBeNull();
  });
});
