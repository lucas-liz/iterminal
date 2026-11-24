import { randomUUID } from 'node:crypto';
import type { Tag } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';

const MAX_TAGS_PER_HOST = 20;
const MAX_TAG_LEN = 32;

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Map<string, string>();
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const name = t.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (name.length > MAX_TAG_LEN) throw new UserError(`标签「${name.slice(0, 10)}…」超过 ${MAX_TAG_LEN} 个字符`);
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  if (seen.size > MAX_TAGS_PER_HOST) throw new UserError(`每台主机最多 ${MAX_TAGS_PER_HOST} 个标签`);
  return [...seen.values()];
}

/** 标签（文档一 6.5）：名称不区分大小写唯一；主机和标签的关联、标签本身删除时都打墓碑，便于云同步。 */
export class TagRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Tag[] {
    return this.db
      .prepare<[], { id: string; name: string; color: string | null; n: number }>(
        `SELECT t.id, t.name, t.color,
                (SELECT count(*) FROM host_tag ht JOIN host h ON h.id = ht.host_id AND h.deleted = 0
                  WHERE ht.tag_id = t.id AND ht.deleted = 0) AS n
           FROM tag t WHERE t.deleted = 0 ORDER BY t.name COLLATE NOCASE`,
      )
      .all()
      .map((r) => ({ id: r.id, name: r.name, color: r.color, hostCount: r.n }));
  }

  /** 每台主机的标签名（按名称排序） */
  tagsByHost(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    this.db
      .prepare<[], { host_id: string; name: string }>(
        `SELECT ht.host_id, t.name FROM host_tag ht JOIN tag t ON t.id = ht.tag_id AND t.deleted = 0
          WHERE ht.deleted = 0 ORDER BY t.name COLLATE NOCASE`,
      )
      .all()
      .forEach((r) => map.set(r.host_id, [...(map.get(r.host_id) ?? []), r.name]));
    return map;
  }

  /** 按名称找到标签，没有就新建；返回 id。调用方负责事务。 */
  ensure(name: string): string {
    const row = this.db.prepare<[string], { id: string }>('SELECT id FROM tag WHERE lower(name) = lower(?) AND deleted = 0').get(name);
    if (row) return row.id;
    const id = randomUUID();
    this.db.prepare('INSERT INTO tag (id, name, updated_at) VALUES (?, ?, ?)').run(id, name, this.now());
    return id;
  }

  /** 把主机的标签设置为 names（调用方负责事务） */
  setHostTags(hostId: string, names: string[]): void {
    const now = this.now();
    const wanted = new Set(names.map((n) => this.ensure(n)));
    const current = this.db
      .prepare<[string], { tag_id: string; deleted: number }>('SELECT tag_id, deleted FROM host_tag WHERE host_id = ?')
      .all(hostId);
    const upsert = this.db.prepare(
      `INSERT INTO host_tag (host_id, tag_id, deleted, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT (host_id, tag_id) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at WHERE host_tag.deleted = 1`,
    );
    const drop = this.db.prepare('UPDATE host_tag SET deleted = 1, updated_at = ? WHERE host_id = ? AND tag_id = ? AND deleted = 0');
    for (const id of wanted) upsert.run(hostId, id, now);
    for (const c of current) if (!wanted.has(c.tag_id) && !c.deleted) drop.run(now, hostId, c.tag_id);
  }

  addRemove(hostIds: string[], add: string[], remove: string[]): void {
    const addNames = normalizeTags(add);
    const removeNames = new Set(normalizeTags(remove).map((n) => n.toLowerCase()));
    const byHost = this.tagsByHost();
    this.db.transaction(() => {
      for (const hid of hostIds) {
        const cur = (byHost.get(hid) ?? []).filter((n) => !removeNames.has(n.toLowerCase()));
        this.setHostTags(hid, normalizeTags([...cur, ...addNames]));
      }
    })();
  }

  update(id: string, name: string, color: string | null): void {
    const n = normalizeTags([name])[0];
    if (!n) throw new UserError('标签名称不能为空');
    if (color !== null && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new UserError('颜色格式不正确');
    const clash = this.db.prepare<[string, string], { id: string }>('SELECT id FROM tag WHERE lower(name) = lower(?) AND id != ? AND deleted = 0').get(n, id);
    if (clash) throw new UserError(`已经有名为「${n}」的标签`);
    const r = this.db.prepare('UPDATE tag SET name = ?, color = ?, updated_at = ? WHERE id = ? AND deleted = 0').run(n, color, this.now(), id);
    if (r.changes === 0) throw new UserError('标签不存在或已被删除');
  }

  delete(id: string): void {
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare('UPDATE host_tag SET deleted = 1, updated_at = ? WHERE tag_id = ? AND deleted = 0').run(now, id);
      this.db.prepare('UPDATE tag SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id);
    })();
  }
}
