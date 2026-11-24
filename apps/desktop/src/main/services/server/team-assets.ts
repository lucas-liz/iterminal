import type { AuthMethod, HostInput } from '@itm/protocol';
import type { Db } from '../db/database';
import type { HostRepo } from '../hosts/host-repo';
import type { FolderRepo } from '../hosts/folder-repo';
import { UserError } from '../../util/errors';

/** GET /api/v1/team/assets 的内容 */
export interface TeamAssets {
  folders: { id: number; parentId: number | null; name: string; sort?: number }[];
  hosts: {
    id: number;
    folderId: number | null;
    name: string;
    protocol: 'SSH' | 'TELNET';
    address: string;
    port: number;
    username: string | null;
    authMethod: 'PASSWORD' | 'KEY' | 'INTERACTIVE';
    password: string | null;
    privateKey: string | null;
    passphrase: string | null;
    allowReveal: boolean;
    note: string | null;
    version: number;
  }[];
}

/** 团队主机根分组的 srv_id */
const ROOT = -1;
export const TEAM_ROOT_NAME = '团队主机';
const AUTH: Record<string, AuthMethod> = { PASSWORD: 'PASSWORD', KEY: 'KEY', INTERACTIVE: 'INTERACTIVE' };

/**
 * 团队主机同步（文档二 5.2）：把服务端下发的分组和主机写进本机库的「团队主机」分组。
 * - 分组、主机用 srv_id 对应服务端 ID，根分组 srv_id = -1、scope = TEAM；
 * - 主机的 version 和服务端一致时跳过（不重复加密写入）；
 * - 服务端删除、停用或者不再对我可见的主机和分组，本机也删除（分组里用户自己放进去的个人主机移到上级）。
 * 团队主机和分组只读：修改入口由 assertEditable* 拦截。
 */
export class TeamAssetSync {
  constructor(
    private readonly d: {
      db: Db;
      hosts: HostRepo;
      folders: FolderRepo;
    },
  ) {}

  private folderBySrv(srvId: number): { id: string; parent_id: string | null; name: string } | null {
    return this.d.db.prepare<[number], { id: string; parent_id: string | null; name: string }>('SELECT id, parent_id, name FROM folder WHERE srv_id = ? AND deleted = 0').get(srvId) ?? null;
  }

  /** 墓碑（已删除的行）占着 srv_id 的唯一索引：重新创建前先释放 */
  private releaseTombstones(table: 'folder' | 'host', srvId: number): void {
    this.d.db.prepare(`UPDATE ${table} SET srv_id = NULL WHERE srv_id = ? AND deleted = 1`).run(srvId);
  }

  private ensureRoot(): string {
    const existing = this.folderBySrv(ROOT);
    if (existing) return existing.id;
    this.releaseTombstones('folder', ROOT);
    const f = this.d.folders.create(null, uniqueName(this.d.db, null, TEAM_ROOT_NAME));
    this.d.db.prepare("UPDATE folder SET srv_id = ?, scope = 'TEAM' WHERE id = ?").run(ROOT, f.id);
    return f.id;
  }

  /** 应用一次同步结果，返回新增 / 更新 / 删除的主机数 */
  apply(data: TeamAssets): { added: number; updated: number; removed: number } {
    const folders = Array.isArray(data?.folders) ? data.folders : [];
    const hosts = Array.isArray(data?.hosts) ? data.hosts : [];
    let added = 0;
    let updated = 0;
    let removed = 0;
    this.d.db.transaction(() => {
      const root = hosts.length ? this.ensureRoot() : (this.folderBySrv(ROOT)?.id ?? null);
      const local = new Map<number, string>();
      // 分组：先上级后下级
      const byId = new Map(folders.map((f) => [f.id, f]));
      const depth = (f: TeamAssets['folders'][number], seen = new Set<number>()): number =>
        f.parentId && byId.has(f.parentId) && !seen.has(f.id) ? 1 + depth(byId.get(f.parentId)!, seen.add(f.id)) : 0;
      if (root) {
        for (const f of [...folders].sort((a, b) => depth(a) - depth(b))) {
          const parent = f.parentId && local.has(f.parentId) ? local.get(f.parentId)! : root;
          const name = String(f.name ?? '').slice(0, 100) || '分组';
          const cur = this.folderBySrv(f.id);
          if (cur) {
            if (cur.name !== name) this.d.folders.rename(cur.id, uniqueName(this.d.db, parent, name, cur.id));
            if (cur.parent_id !== parent) this.d.folders.move(cur.id, parent);
            local.set(f.id, cur.id);
          } else {
            this.releaseTombstones('folder', f.id);
            const created = this.d.folders.create(parent, uniqueName(this.d.db, parent, name));
            this.d.db.prepare("UPDATE folder SET srv_id = ?, scope = 'TEAM' WHERE id = ?").run(f.id, created.id);
            local.set(f.id, created.id);
          }
        }
      }

      // 主机
      const keep = new Set<number>();
      for (const h of hosts) {
        if (!root || !Number.isInteger(h.id)) continue;
        keep.add(h.id);
        const cur = this.d.db.prepare<[number], { id: string; version: number; team_reveal: number | null }>('SELECT id, version, team_reveal FROM host WHERE srv_id = ? AND deleted = 0').get(h.id);
        const reveal = h.allowReveal ? 1 : 0;
        if (cur && cur.version === h.version) {
          if (cur.team_reveal !== reveal) this.d.db.prepare('UPDATE host SET team_reveal = ? WHERE id = ?').run(reveal, cur.id);
          continue;
        }
        const input: HostInput = {
          folderId: (h.folderId && local.get(h.folderId)) || root,
          name: String(h.name ?? '').slice(0, 100) || h.address,
          protocol: h.protocol === 'TELNET' ? 'TELNET' : 'SSH',
          address: h.address,
          port: h.port,
          username: h.username ?? '',
          authMethod: AUTH[h.authMethod] ?? 'PASSWORD',
          password: h.password ?? null,
          privateKey: h.authMethod === 'KEY' ? (h.privateKey ?? null) : null,
          passphrase: h.authMethod === 'KEY' ? (h.passphrase ?? null) : null,
          keepaliveSec: 30,
          startupScript: null,
          note: h.note ?? null,
          jumpHostIds: [],
        };
        try {
          const id = cur ? this.d.hosts.update(cur.id, input).id : this.createHost(h.id, input);
          this.d.db.prepare('UPDATE host SET srv_id = ?, version = ?, team_reveal = ? WHERE id = ?').run(h.id, h.version, reveal, id);
          if (cur) updated++;
          else added++;
        } catch {
          // 单台主机的数据不合法（例如私钥格式）时跳过，不影响其他主机
        }
      }

      // 服务端已经没有（或者对我不可见）的团队主机
      const stale = this.d.db.prepare<[], { id: string; srv_id: number | null }>('SELECT id, srv_id FROM host WHERE team_reveal IS NOT NULL AND deleted = 0').all().filter((r) => r.srv_id === null || !keep.has(r.srv_id));
      if (stale.length) {
        const ids = stale.map((r) => r.id);
        // 个人主机把团队主机当跳板时，先去掉这个跳板（否则不能删除）
        const marks = ids.map(() => '?').join(',');
        this.d.db.prepare(`DELETE FROM host_jump WHERE jump_host_id IN (${marks})`).run(...ids);
        this.d.db.prepare(`UPDATE folder SET default_jump_host_id = NULL WHERE default_jump_host_id IN (${marks})`).run(...ids);
        this.d.hosts.delete(ids);
        this.d.db.prepare(`UPDATE host SET srv_id = NULL WHERE id IN (${marks})`).run(...ids);
        removed = ids.length;
      }
      // 服务端已经没有的分组（深的先删）；没有团队主机时连根分组一起删
      const keepFolders = new Set(folders.map((f) => f.id));
      const staleFolders = this.d.db
        .prepare<[], { id: string; srv_id: number; path: string }>("SELECT id, srv_id, path FROM folder WHERE scope = 'TEAM' AND deleted = 0")
        .all()
        .filter((f) => (f.srv_id === ROOT ? !hosts.length : !keepFolders.has(f.srv_id)))
        .sort((a, b) => b.path.length - a.path.length);
      for (const f of staleFolders) {
        this.d.folders.delete(f.id, 'MOVE_TO_PARENT');
        this.d.db.prepare('UPDATE folder SET srv_id = NULL WHERE id = ?').run(f.id);
      }
    })();
    return { added, updated, removed };
  }

  private createHost(srvId: number, input: HostInput): string {
    this.releaseTombstones('host', srvId);
    return this.d.hosts.create(input).id;
  }

  // ---------------------------------------------------------------- 只读

  private teamHostIds(ids: string[]): string[] {
    if (!ids.length) return [];
    return this.d.db
      .prepare<string[], { id: string }>(`SELECT id FROM host WHERE team_reveal IS NOT NULL AND deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids)
      .map((r) => r.id);
  }

  isTeamFolder(id: string | null | undefined): boolean {
    if (!id) return false;
    return !!this.d.db.prepare<[string], { id: string }>("SELECT id FROM folder WHERE id = ? AND scope = 'TEAM' AND deleted = 0").get(id);
  }

  /** 修改 / 删除 / 移动 / 复制主机前检查：团队主机由管理员维护 */
  assertEditableHosts(ids: string[]): void {
    if (this.teamHostIds(ids).length) throw new UserError('团队主机由管理员在管理后台维护，不能在这里修改；需要调整请联系管理员');
  }

  /** 新建主机或移动主机到某个分组前检查：不能放进团队主机分组 */
  assertPersonalTarget(folderId: string | null | undefined): void {
    if (this.isTeamFolder(folderId)) throw new UserError('团队主机分组由管理员维护，不能放入个人主机');
  }

  /** 分组的新建 / 改名 / 移动 / 删除 / 设置前检查 */
  assertEditableFolder(id: string | null | undefined): void {
    if (this.isTeamFolder(id)) throw new UserError('团队主机分组由管理员在管理后台维护，不能在这里修改');
  }

  /** 查看凭证明文前检查：团队主机没有开启「允许查看密码」时不能查看 */
  assertRevealable(credentialId: string): void {
    const row = this.d.db
      .prepare<[string], { team_reveal: number | null }>('SELECT h.team_reveal FROM credential c JOIN host h ON h.id = c.owner_host_id WHERE c.id = ?')
      .get(credentialId);
    if (row && row.team_reveal === 0) throw new UserError('管理员没有允许查看这台团队主机的密码');
  }
}

/** 同一个上级下名字重复时加上序号（分组名唯一） */
function uniqueName(db: Db, parentId: string | null, name: string, selfId?: string): string {
  const taken = new Set(
    db
      .prepare<[string | null, string], { name: string }>('SELECT name FROM folder WHERE parent_id IS ? AND deleted = 0 AND id != ?')
      .all(parentId, selfId ?? '')
      .map((r) => r.name.toLowerCase()),
  );
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`.toLowerCase())) return `${name} (${i})`;
}
