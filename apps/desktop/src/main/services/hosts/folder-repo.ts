import { randomUUID } from 'node:crypto';
import { AGENT_POLICIES as POLICIES, type AgentPolicy, type Folder, type FolderDeleteStrategy, type FolderSettingsInput } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';

/** 文件夹最多 8 级（文档一 6.5 / 文档二 5.2） */
export const MAX_FOLDER_DEPTH = 8;
/** 排序值间隔，拖拽插入时取相邻两项的中间值 */
const SORT_STEP = 1024;
const MAX_NAME_LEN = 64;

interface FolderRow {
  scope: string | null;
  id: string;
  parent_id: string | null;
  name: string;
  path: string;
  sort: number;
  default_credential_id: string | null;
  default_jump_host_id: string | null;
  agent_policy: AgentPolicy | null;
  ai_note: string | null;
  default_skills: string | null;
  production: number;
  updated_at: number;
}

const COLUMNS =
  'id, parent_id, name, path, sort, default_credential_id, default_jump_host_id, agent_policy, ai_note, default_skills, production, updated_at, scope';

export function folderDepth(path: string): number {
  return path.split('/').filter(Boolean).length;
}

/** 文件夹设置里引用的凭证 / 跳板机的校验（由 HostRepo / CredentialRepo 提供，避免循环依赖） */
export interface FolderRefChecks {
  /** 连带删除主机前的检查（例如主机仍被其他主机用作跳板时拒绝）；folderPath 是正在删除的分组子树 */
  beforeDeleteHosts(hostIds: string[], folderPath: string): void;
  /** 删除主机时清理它们的专属凭证 */
  deleteHostCredentials(hostIds: string[]): void;
  requireSharedCredential(id: string): void;
  requireHost(id: string): void;
}

const noChecks: FolderRefChecks = {
  beforeDeleteHosts: () => undefined,
  deleteHostCredentials: () => undefined,
  requireSharedCredential: () => undefined,
  requireHost: () => undefined,
};

/**
 * 主机分组（多级文件夹）。删除只打墓碑（deleted = 1），以便参与云同步。
 */
export class FolderRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly checks: FolderRefChecks = noChecks,
  ) {}

  list(): Folder[] {
    return this.db
      .prepare<[], FolderRow>(`SELECT ${COLUMNS} FROM folder WHERE deleted = 0 ORDER BY sort, name COLLATE NOCASE`)
      .all()
      .map(toFolder);
  }

  get(id: string): Folder | null {
    const row = this.db.prepare<[string], FolderRow>(`SELECT ${COLUMNS} FROM folder WHERE id = ? AND deleted = 0`).get(id);
    return row ? toFolder(row) : null;
  }

  require(id: string): Folder {
    const f = this.get(id);
    if (!f) {
      throw new UserError('分组不存在或已被删除');
    }
    return f;
  }

  /** 从所在分组到顶层（从近到远），用于继承解析 */
  chain(folderId: string | null): Folder[] {
    if (!folderId) return [];
    const f = this.get(folderId);
    if (!f) return [];
    const ids = f.path.split('/').filter(Boolean);
    const rows = this.db
      .prepare<string[], FolderRow>(`SELECT ${COLUMNS} FROM folder WHERE deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids);
    const byId = new Map(rows.map((r) => [r.id, toFolder(r)]));
    return ids
      .reverse()
      .map((id) => byId.get(id))
      .filter((x): x is Folder => !!x);
  }

  create(parentId: string | null, name: string): Folder {
    const n = validName(name);
    const parent = parentId ? this.require(parentId) : null;
    if (parent && folderDepth(parent.path) >= MAX_FOLDER_DEPTH) {
      throw new UserError(`分组最多 ${MAX_FOLDER_DEPTH} 级`);
    }
    this.ensureUniqueName(parentId, n, null);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO folder (id, parent_id, name, path, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, parentId, n, (parent?.path ?? '/') + id + '/', this.nextSort(parentId), this.now());
    return this.require(id);
  }

  /** 按名称路径找到分组，没有就逐级新建（导入、分享码合并时使用）。调用方负责事务。 */
  ensurePath(names: string[], under: string | null = null): string | null {
    let parentId = under;
    for (const raw of names) {
      const name = validName(raw.replace(/\//g, '／'));
      const existing = this.db
        .prepare<[string | null, string], { id: string }>('SELECT id FROM folder WHERE parent_id IS ? AND lower(name) = lower(?) AND deleted = 0')
        .get(parentId, name);
      parentId = existing ? existing.id : this.create(parentId, name).id;
    }
    return parentId;
  }

  rename(id: string, name: string): Folder {
    const f = this.require(id);
    const n = validName(name);
    this.ensureUniqueName(f.parentId, n, id);
    this.db.prepare('UPDATE folder SET name = ?, updated_at = ? WHERE id = ?').run(n, this.now(), id);
    return this.require(id);
  }

  /** 文件夹设置（文档一 6.5 继承规则里的字段） */
  update(id: string, s: FolderSettingsInput): Folder {
    this.require(id);
    const defaultCredentialId = s.defaultCredentialId || null;
    if (defaultCredentialId) this.checks.requireSharedCredential(defaultCredentialId);
    const defaultJumpHostId = s.defaultJumpHostId || null;
    if (defaultJumpHostId) this.checks.requireHost(defaultJumpHostId);
    const agentPolicy = s.agentPolicy || null;
    if (agentPolicy && !POLICIES.includes(agentPolicy)) throw new UserError('Agent 权限不合法');
    const aiNote = (s.aiNote ?? '').trim() || null;
    if (aiNote && aiNote.length > 4000) throw new UserError('分组说明不能超过 4000 个字符');
    const skills = Array.isArray(s.defaultSkills) ? [...new Set(s.defaultSkills.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))] : [];
    if (skills.length > 30) throw new UserError('默认 Skill 最多 30 个');
    this.db
      .prepare(
        `UPDATE folder SET default_credential_id = ?, default_jump_host_id = ?, agent_policy = ?, ai_note = ?, default_skills = ?, production = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(defaultCredentialId, defaultJumpHostId, agentPolicy, aiNote, skills.length ? JSON.stringify(skills) : null, s.production ? 1 : 0, this.now(), id);
    return this.require(id);
  }

  /**
   * 移到新的父分组下；beforeId 是同级里要排在它前面的分组（为空放在末尾）。不能移到自己的子树里。
   */
  move(id: string, parentId: string | null, beforeId?: string | null): void {
    const f = this.require(id);
    const parent = parentId ? this.require(parentId) : null;
    if (parent && parent.path.startsWith(f.path)) {
      throw new UserError('不能把分组移到它自己或它的子分组下');
    }
    if (f.parentId !== parentId) {
      const deepest = Math.max(...this.subtreePaths(f.path).map(folderDepth));
      const newDepth = (parent ? folderDepth(parent.path) : 0) + 1;
      if (deepest - folderDepth(f.path) + newDepth > MAX_FOLDER_DEPTH) {
        throw new UserError(`移动后分组会超过 ${MAX_FOLDER_DEPTH} 级`);
      }
      this.ensureUniqueName(parentId, f.name, id);
    }
    this.db.transaction(() => {
      if (f.parentId !== parentId) this.reparent(f, parent, f.name);
      if (beforeId !== undefined) this.placeBefore(id, parentId, beforeId);
    })();
  }

  /**
   * 删除分组：
   * - MOVE_TO_PARENT：子分组和主机移到上一级（同名子分组自动加序号），再删除该分组；
   * - CASCADE：连同子分组、其中的主机和主机专属凭证一起删除。
   */
  delete(id: string, strategy: FolderDeleteStrategy): void {
    const f = this.require(id);
    const now = this.now();
    this.db.transaction(() => {
      if (strategy === 'MOVE_TO_PARENT') {
        const parent = f.parentId ? this.require(f.parentId) : null;
        const children = this.db
          .prepare<[string], FolderRow>(`SELECT ${COLUMNS} FROM folder WHERE parent_id = ? AND deleted = 0 ORDER BY sort`)
          .all(id)
          .map(toFolder);
        for (const child of children) {
          this.reparent(child, parent, this.availableName(f.parentId, child.name, child.id));
        }
        this.db
          .prepare('UPDATE host SET folder_id = ?, updated_at = ? WHERE folder_id = ? AND deleted = 0')
          .run(f.parentId, now, id);
        this.db.prepare('UPDATE folder SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id);
      } else {
        const like = f.path + '%';
        const hostIds = this.db
          .prepare<[string], { id: string }>(
            'SELECT id FROM host WHERE deleted = 0 AND folder_id IN (SELECT id FROM folder WHERE path LIKE ?)',
          )
          .all(like)
          .map((r) => r.id);
        this.checks.beforeDeleteHosts(hostIds, f.path);
        const dropJumps = this.db.prepare('DELETE FROM host_jump WHERE host_id = ?');
        hostIds.forEach((hid) => dropJumps.run(hid));
        this.checks.deleteHostCredentials(hostIds);
        const clearJump = this.db.prepare('UPDATE folder SET default_jump_host_id = NULL, updated_at = ? WHERE default_jump_host_id = ?');
        hostIds.forEach((hid) => clearJump.run(now, hid));
        this.db
          .prepare('UPDATE host SET deleted = 1, updated_at = ? WHERE deleted = 0 AND folder_id IN (SELECT id FROM folder WHERE path LIKE ?)')
          .run(now, like);
        this.db.prepare('UPDATE folder SET deleted = 1, updated_at = ? WHERE deleted = 0 AND path LIKE ?').run(now, like);
      }
    })();
  }

  /** 改父级并批量改写整棵子树的物化路径（调用方负责事务和校验）。 */
  private reparent(f: Folder, parent: Folder | null, name: string): void {
    const newPath = (parent?.path ?? '/') + f.id + '/';
    // 路径由 UUID 和 / 组成，没有 LIKE 通配符
    this.db
      .prepare('UPDATE folder SET path = ? || substr(path, ?) WHERE path LIKE ?')
      .run(newPath, f.path.length + 1, f.path + '%');
    this.db
      .prepare('UPDATE folder SET parent_id = ?, name = ?, sort = ?, updated_at = ? WHERE id = ?')
      .run(parent?.id ?? null, name, this.nextSort(parent?.id ?? null), this.now(), f.id);
  }

  /** 排到 beforeId 前面（取相邻两项的中间值；没有空间时同级整体重排） */
  private placeBefore(id: string, parentId: string | null, beforeId: string | null): void {
    const siblings = this.db
      .prepare<[string | null], { id: string; sort: number }>('SELECT id, sort FROM folder WHERE parent_id IS ? AND deleted = 0 ORDER BY sort, name COLLATE NOCASE')
      .all(parentId)
      .filter((s) => s.id !== id);
    const idx = beforeId ? siblings.findIndex((s) => s.id === beforeId) : -1;
    const at = idx < 0 ? siblings.length : idx;
    const prev = at > 0 ? siblings[at - 1].sort : 0;
    const next = at < siblings.length ? siblings[at].sort : prev + 2 * SORT_STEP;
    const set = this.db.prepare('UPDATE folder SET sort = ?, updated_at = ? WHERE id = ?');
    if (next - prev >= 2) {
      set.run(Math.floor((prev + next) / 2), this.now(), id);
      return;
    }
    const ordered = [...siblings.slice(0, at).map((s) => s.id), id, ...siblings.slice(at).map((s) => s.id)];
    ordered.forEach((fid, i) => set.run((i + 1) * SORT_STEP, this.now(), fid));
  }

  private subtreePaths(path: string): string[] {
    return this.db
      .prepare<[string], { path: string }>('SELECT path FROM folder WHERE deleted = 0 AND path LIKE ?')
      .all(path + '%')
      .map((r) => r.path);
  }

  private nextSort(parentId: string | null): number {
    const row = this.db
      .prepare<[string | null], { m: number | null }>('SELECT max(sort) AS m FROM folder WHERE parent_id IS ? AND deleted = 0')
      .get(parentId);
    return (row?.m ?? 0) + SORT_STEP;
  }

  private hasName(parentId: string | null, name: string, exceptId: string | null): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM folder WHERE parent_id IS ? AND lower(name) = lower(?) AND id IS NOT ? AND deleted = 0')
      .get(parentId, name, exceptId);
  }

  private ensureUniqueName(parentId: string | null, name: string, exceptId: string | null): void {
    if (this.hasName(parentId, name, exceptId)) {
      throw new UserError(`同一层级下已经有名为「${name}」的分组`);
    }
  }

  /** 名称冲突时追加序号：「生产」→「生产 (2)」 */
  private availableName(parentId: string | null, name: string, exceptId: string): string {
    let candidate = name;
    for (let i = 2; this.hasName(parentId, candidate, exceptId); i++) {
      candidate = `${name} (${i})`;
    }
    return candidate;
  }
}

function validName(name: string): string {
  const n = (name ?? '').trim();
  if (!n) {
    throw new UserError('分组名称不能为空');
  }
  if (n.length > MAX_NAME_LEN) {
    throw new UserError(`分组名称不能超过 ${MAX_NAME_LEN} 个字符`);
  }
  if (n.includes('/')) {
    throw new UserError('分组名称不能包含 /');
  }
  return n;
}

function toFolder(r: FolderRow): Folder {
  let defaultSkills: string[] = [];
  try {
    defaultSkills = r.default_skills ? (JSON.parse(r.default_skills) as string[]) : [];
  } catch {
    defaultSkills = [];
  }
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    path: r.path,
    sort: r.sort,
    defaultCredentialId: r.default_credential_id,
    defaultJumpHostId: r.default_jump_host_id,
    agentPolicy: r.agent_policy,
    aiNote: r.ai_note,
    defaultSkills,
    production: !!r.production,
    team: r.scope === 'TEAM',
    updatedAt: r.updated_at,
  };
}
