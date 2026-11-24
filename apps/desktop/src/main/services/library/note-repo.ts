import { randomUUID } from 'node:crypto';
import type { Note, NoteFormat, NoteInput, NoteLibrary } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';
import { GroupRepo } from './group-repo';

const MAX_TITLE = 200;
const MAX_CONTENT = 1024 * 1024;

interface Row {
  id: string;
  group_id: string | null;
  title: string;
  content: string;
  format: string;
  pinned: number;
  sort: number;
  updated_at: number;
  prev_content: string | null;
  prev_at: number | null;
}

const toNote = (r: Row): Note => ({
  id: r.id,
  groupId: r.group_id,
  title: r.title,
  content: r.content,
  format: r.format === 'TEXT' ? 'TEXT' : 'MARKDOWN',
  pinned: !!r.pinned,
  sort: r.sort,
  updatedAt: r.updated_at,
  hasPrev: r.prev_content !== null,
  prevAt: r.prev_at,
});

const COLS = 'id, group_id, title, content, format, pinned, sort, updated_at, prev_content, prev_at';

/** 笔记（文档一 6.14）：Markdown 正文，可以置顶；Agent 可以引用笔记（发给模型前脱敏） */
export class NoteRepo {
  readonly groups: GroupRepo;
  /** 笔记内容变化（新建、修改、撤回、移动、删除）：同步到 Markdown 文件 */
  onChange: (ids: string[]) => void = () => undefined;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.groups = new GroupRepo(db, 'note_group', 'note', now);
  }

  library(): NoteLibrary {
    return { groups: this.groups.list(), notes: this.list() };
  }

  /** 置顶的在前，其余按最近修改 */
  list(): Note[] {
    return this.db.prepare<[], Row>(`SELECT ${COLS} FROM note WHERE deleted = 0 ORDER BY pinned DESC, updated_at DESC`).all().map(toNote);
  }

  get(id: string): Note | null {
    const r = this.db.prepare<[string], Row>(`SELECT ${COLS} FROM note WHERE id = ? AND deleted = 0`).get(id);
    return r ? toNote(r) : null;
  }

  save(id: string | null, input: NoteInput): Note {
    const title = String(input.title ?? '').trim() || '无标题';
    if (title.length > MAX_TITLE) throw new UserError(`标题不能超过 ${MAX_TITLE} 个字符`);
    const content = String(input.content ?? '').replace(/\r\n/g, '\n');
    if (content.length > MAX_CONTENT) throw new UserError('笔记太长（最多 1MB）');
    const format: NoteFormat = input.format === 'TEXT' ? 'TEXT' : 'MARKDOWN';
    const groupId = this.groups.requireGroup(input.groupId);
    const now = this.now();
    if (id) {
      const cur = this.get(id);
      if (!cur) throw new UserError('笔记不存在');
      const pinned = input.pinned ?? cur.pinned;
      // 内容有变化时才记录上一个版本（只保留一个）
      if (input.snapshot && (cur.title !== title || cur.content !== content)) {
        this.db.prepare('UPDATE note SET prev_title = ?, prev_content = ?, prev_at = ? WHERE id = ?').run(cur.title, cur.content, cur.updatedAt, id);
      }
      this.db
        .prepare('UPDATE note SET group_id = ?, title = ?, content = ?, format = ?, pinned = ?, updated_at = ? WHERE id = ?')
        .run(groupId, title, content, format, pinned ? 1 : 0, now, id);
      this.onChange([id]);
      return this.get(id)!;
    }
    const newId = randomUUID();
    this.db
      .prepare('INSERT INTO note (id, group_id, title, content, format, pinned, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(newId, groupId, title, content, format, input.pinned ? 1 : 0, now);
    this.onChange([newId]);
    return this.get(newId)!;
  }

  /** 撤回到上一个版本：当前内容和上一个版本互换（再撤回一次就回到撤回前） */
  revert(id: string): Note {
    const r = this.db
      .prepare<[string], { title: string; content: string; updated_at: number; prev_title: string | null; prev_content: string | null; prev_at: number | null }>(
        'SELECT title, content, updated_at, prev_title, prev_content, prev_at FROM note WHERE id = ? AND deleted = 0',
      )
      .get(id);
    if (!r) throw new UserError('笔记不存在');
    if (r.prev_content === null) throw new UserError('没有可以撤回的版本');
    this.db
      .prepare('UPDATE note SET title = ?, content = ?, prev_title = ?, prev_content = ?, prev_at = ?, updated_at = ? WHERE id = ?')
      .run(r.prev_title || '无标题', r.prev_content, r.title, r.content, r.updated_at, this.now(), id);
    this.onChange([id]);
    return this.get(id)!;
  }

  /** 按 ID 或标题查找（Agent 的 note_read / note_save 使用；标题不区分大小写，先精确后包含） */
  find(idOrTitle: string): Note | null {
    const k = idOrTitle.trim();
    if (!k) return null;
    const byId = this.get(k);
    if (byId) return byId;
    const all = this.list();
    const low = k.toLowerCase();
    return all.find((n) => n.title.toLowerCase() === low) ?? all.find((n) => n.title.toLowerCase().includes(low)) ?? null;
  }

  pin(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE note SET pinned = ?, updated_at = ? WHERE id = ? AND deleted = 0').run(pinned ? 1 : 0, this.now(), id);
  }

  delete(ids: string[]): void {
    const now = this.now();
    const stmt = this.db.prepare('UPDATE note SET deleted = 1, updated_at = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
    this.onChange(ids);
  }

  move(ids: string[], groupId: string | null): void {
    const gid = this.groups.requireGroup(groupId);
    const now = this.now();
    const stmt = this.db.prepare('UPDATE note SET group_id = ?, updated_at = ? WHERE id = ? AND deleted = 0');
    this.db.transaction(() => ids.forEach((id) => stmt.run(gid, now, id)))();
    this.onChange(ids);
  }
}
