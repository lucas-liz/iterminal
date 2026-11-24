import { randomUUID } from 'node:crypto';
import type { Snippet, SnippetInput, SnippetLibrary } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';
import { normalizeTags } from '../hosts/tag-repo';
import { GroupRepo } from './group-repo';

const MAX_NAME = 128;
const MAX_CONTENT = 64 * 1024;
const MAX_DESC = 1000;

interface Row {
  id: string;
  group_id: string | null;
  name: string;
  content: string;
  description: string | null;
  tags: string | null;
  sort: number;
  updated_at: number;
}

function toSnippet(r: Row): Snippet {
  let tags: string[] = [];
  try {
    tags = r.tags ? (JSON.parse(r.tags) as string[]) : [];
  } catch {
    // 损坏的标签当作没有
  }
  return { id: r.id, groupId: r.group_id, name: r.name, content: r.content, description: r.description, tags, sort: r.sort, updatedAt: r.updated_at };
}

/** 快捷命令（文档一 6.14） */
export class SnippetRepo {
  readonly groups: GroupRepo;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.groups = new GroupRepo(db, 'snippet_group', 'snippet', now);
  }

  library(): SnippetLibrary {
    return { groups: this.groups.list(), snippets: this.list() };
  }

  list(): Snippet[] {
    return this.db
      .prepare<[], Row>('SELECT id, group_id, name, content, description, tags, sort, updated_at FROM snippet WHERE deleted = 0 ORDER BY sort, name COLLATE NOCASE')
      .all()
      .map(toSnippet);
  }

  get(id: string): Snippet | null {
    const r = this.db.prepare<[string], Row>('SELECT id, group_id, name, content, description, tags, sort, updated_at FROM snippet WHERE id = ? AND deleted = 0').get(id);
    return r ? toSnippet(r) : null;
  }

  save(id: string | null, input: SnippetInput): Snippet {
    const name = String(input.name ?? '').trim();
    const content = String(input.content ?? '').replace(/\r\n/g, '\n');
    if (!name) throw new UserError('请填写命令名称');
    if (name.length > MAX_NAME) throw new UserError(`名称不能超过 ${MAX_NAME} 个字符`);
    if (!content.trim()) throw new UserError('请填写命令内容');
    if (content.length > MAX_CONTENT) throw new UserError('命令内容太长（最多 64KB）');
    const description = input.description ? String(input.description).trim().slice(0, MAX_DESC) || null : null;
    const tags = JSON.stringify(normalizeTags(input.tags ?? []));
    const groupId = this.groups.requireGroup(input.groupId);
    const now = this.now();
    if (id) {
      const r = this.db
        .prepare('UPDATE snippet SET group_id = ?, name = ?, content = ?, description = ?, tags = ?, updated_at = ? WHERE id = ? AND deleted = 0')
        .run(groupId, name, content, description, tags, now, id);
      if (r.changes === 0) throw new UserError('快捷命令不存在');
      return this.get(id)!;
    }
    const newId = randomUUID();
    const sort = this.db.prepare<[], { s: number | null }>('SELECT max(sort) AS s FROM snippet WHERE deleted = 0').get()!.s ?? -1;
    this.db
      .prepare('INSERT INTO snippet (id, group_id, name, content, description, tags, sort, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId, groupId, name, content, description, tags, sort + 1, now);
    return this.get(newId)!;
  }

  delete(ids: string[]): void {
    const now = this.now();
    const stmt = this.db.prepare('UPDATE snippet SET deleted = 1, updated_at = ? WHERE id = ?');
    this.db.transaction(() => ids.forEach((id) => stmt.run(now, id)))();
  }

  move(ids: string[], groupId: string | null): void {
    const gid = this.groups.requireGroup(groupId);
    const now = this.now();
    const stmt = this.db.prepare('UPDATE snippet SET group_id = ?, updated_at = ? WHERE id = ? AND deleted = 0');
    this.db.transaction(() => ids.forEach((id) => stmt.run(gid, now, id)))();
  }

  /** 行内补全的候选：单行、不带变量、以 prefix 开头的命令内容 */
  completions(prefix: string, limit = 5): string[] {
    const like = prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
    return this.db
      .prepare<[string, string], { content: string }>(
        `SELECT content FROM snippet WHERE deleted = 0 AND content LIKE ? ESCAPE '\\' AND content != ? AND instr(content, char(10)) = 0 AND instr(content, '{{') = 0
          ORDER BY updated_at DESC LIMIT ${Math.max(1, Math.min(limit, 20))}`,
      )
      .all(like, prefix)
      .map((r) => r.content);
  }
}
