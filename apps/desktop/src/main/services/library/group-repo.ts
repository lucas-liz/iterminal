import { randomUUID } from 'node:crypto';
import type { LibraryGroup } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';

const MAX_NAME = 64;

/**
 * 快捷命令 / 笔记共用的单层分组：名称不区分大小写唯一；删除分组时组内条目移到「未分组」，不连带删除。
 * 分组和条目删除都打墓碑（参与云同步）。
 */
export class GroupRepo {
  constructor(
    private readonly db: Db,
    private readonly groupTable: 'snippet_group' | 'note_group',
    private readonly itemTable: 'snippet' | 'note',
    private readonly now: () => number = Date.now,
  ) {}

  list(): LibraryGroup[] {
    return this.db
      .prepare<[], { id: string; name: string; sort: number; n: number }>(
        `SELECT g.id, g.name, g.sort, (SELECT count(*) FROM ${this.itemTable} i WHERE i.group_id = g.id AND i.deleted = 0) AS n
           FROM ${this.groupTable} g WHERE g.deleted = 0 ORDER BY g.sort, g.name COLLATE NOCASE`,
      )
      .all()
      .map((r) => ({ id: r.id, name: r.name, sort: r.sort, count: r.n }));
  }

  exists(id: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM ${this.groupTable} WHERE id = ? AND deleted = 0`).get(id);
  }

  /** 新建或改名；返回分组 id */
  save(id: string | null, rawName: string): string {
    const name = String(rawName ?? '').trim();
    if (!name) throw new UserError('请填写分组名称');
    if (name.length > MAX_NAME) throw new UserError(`分组名称不能超过 ${MAX_NAME} 个字符`);
    const dup = this.db
      .prepare<[string, string], { id: string }>(`SELECT id FROM ${this.groupTable} WHERE lower(name) = lower(?) AND deleted = 0 AND id != ?`)
      .get(name, id ?? '');
    if (dup) throw new UserError(`已经有名为「${name}」的分组`);
    const now = this.now();
    if (id) {
      const r = this.db.prepare(`UPDATE ${this.groupTable} SET name = ?, updated_at = ? WHERE id = ? AND deleted = 0`).run(name, now, id);
      if (r.changes === 0) throw new UserError('分组不存在');
      return id;
    }
    const newId = randomUUID();
    const sort = this.db.prepare<[], { s: number | null }>(`SELECT max(sort) AS s FROM ${this.groupTable} WHERE deleted = 0`).get()!.s ?? -1;
    this.db.prepare(`INSERT INTO ${this.groupTable} (id, name, sort, updated_at) VALUES (?, ?, ?, ?)`).run(newId, name, sort + 1, now);
    return newId;
  }

  /** 删除分组：组内条目移到「未分组」 */
  delete(id: string): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE ${this.itemTable} SET group_id = NULL, updated_at = ? WHERE group_id = ? AND deleted = 0`).run(now, id);
      this.db.prepare(`UPDATE ${this.groupTable} SET deleted = 1, updated_at = ? WHERE id = ?`).run(now, id);
    })();
  }

  /** 按给出的顺序重新排序 */
  reorder(ids: string[]): void {
    const now = this.now();
    const stmt = this.db.prepare(`UPDATE ${this.groupTable} SET sort = ?, updated_at = ? WHERE id = ? AND deleted = 0`);
    this.db.transaction(() => ids.forEach((id, i) => stmt.run(i, now, id)))();
  }

  /** 校验条目要放进的分组（null = 未分组） */
  requireGroup(id: string | null | undefined): string | null {
    if (!id) return null;
    if (!this.exists(id)) throw new UserError('分组不存在');
    return id;
  }
}
