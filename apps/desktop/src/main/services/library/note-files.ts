import { existsSync, mkdirSync, readFileSync, rmdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { NoteRepo } from './note-repo';

const INDEX = '.iterminal-notes.json';

/** 文件名里不能用的字符换掉，避免目录穿越和隐藏文件 */
function safeName(s: string): string {
  const t = s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
    .slice(0, 100);
  return t || '无标题';
}

/**
 * 笔记保存为 Markdown 文件（设置 → 存储位置）：笔记仍然以本机加密数据库为准，
 * 指定目录后每次新建、修改、撤回、移动、删除都同步到 {目录}/{分组}/{标题}.md。
 * 目录里的 .iterminal-notes.json 记录笔记 ID → 文件，改标题时删掉旧文件。
 */
export class NoteFileMirror {
  constructor(
    private readonly notes: NoteRepo,
    private readonly dirOf: () => string,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  private readIndex(dir: string): Record<string, string> {
    try {
      const v = JSON.parse(readFileSync(join(dir, INDEX), 'utf8')) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, string>) : {};
    } catch {
      return {};
    }
  }

  private writeIndex(dir: string, index: Record<string, string>): void {
    writeFileSync(join(dir, INDEX), JSON.stringify(index, null, 2));
  }

  /** 删除文件；所在的分组目录空了也删掉 */
  private remove(dir: string, rel: string): void {
    const abs = join(dir, rel);
    if (!abs.startsWith(dir + sep)) return;
    try {
      if (existsSync(abs)) unlinkSync(abs);
      const parent = dirname(abs);
      if (parent !== dir && existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
    } catch {
      // 文件被占用等：下次同步再处理
    }
  }

  /** 同步这些笔记（已删除的删掉文件） */
  sync(ids: string[], dir = this.dirOf()): void {
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const index = this.readIndex(dir);
      const groups = new Map(this.notes.groups.list().map((g) => [g.id, g.name]));
      const used = new Set(Object.entries(index).filter(([id]) => !ids.includes(id)).map(([, f]) => f.toLowerCase()));
      for (const id of ids) {
        const note = this.notes.get(id);
        const old = index[id];
        if (!note) {
          if (old) this.remove(dir, old);
          delete index[id];
          continue;
        }
        const folder = note.groupId ? safeName(groups.get(note.groupId) ?? '') : '';
        const base = safeName(note.title);
        let rel = join(folder, `${base}.md`);
        for (let i = 2; used.has(rel.toLowerCase()); i++) rel = join(folder, `${base} (${i}).md`);
        used.add(rel.toLowerCase());
        if (old && old !== rel) this.remove(dir, old);
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), note.content.endsWith('\n') || !note.content ? note.content : `${note.content}\n`);
        index[id] = relative(dir, join(dir, rel));
      }
      this.writeIndex(dir, index);
    } catch (e) {
      this.log(`笔记同步到文件失败：${(e as Error).message}`);
    }
  }

  /** 设置目录后导出全部笔记 */
  exportAll(dir: string): number {
    const ids = this.notes.list().map((n) => n.id);
    // 之前记录过、但已经不存在的笔记一并清理
    const stale = Object.keys(this.readIndex(dir)).filter((id) => !ids.includes(id));
    this.sync([...ids, ...stale], dir);
    return ids.length;
  }
}
