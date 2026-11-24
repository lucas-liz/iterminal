/**
 * 快捷命令与笔记（文档一 6.14）：个人的本机离线数据，分组都是单层的；删除分组时组内条目移到「未分组」。
 */

export interface LibraryGroup {
  id: string;
  name: string;
  sort: number;
  /** 组内条目数 */
  count: number;
}

export interface Snippet {
  id: string;
  /** null = 未分组 */
  groupId: string | null;
  name: string;
  /** 命令内容，支持 {{变量}} 和 {{变量:默认值}}，发送前弹出填写框 */
  content: string;
  description: string | null;
  tags: string[];
  sort: number;
  updatedAt: number;
}

export interface SnippetInput {
  groupId: string | null;
  name: string;
  content: string;
  description?: string | null;
  tags?: string[];
}

export type NoteFormat = 'MARKDOWN' | 'TEXT';

export interface Note {
  id: string;
  groupId: string | null;
  title: string;
  content: string;
  format: NoteFormat;
  pinned: boolean;
  sort: number;
  updatedAt: number;
  /** 有可以撤回的上一个版本 */
  hasPrev?: boolean;
  /** 上一个版本保存的时间 */
  prevAt?: number | null;
}

export interface NoteInput {
  groupId: string | null;
  title: string;
  content: string;
  format?: NoteFormat;
  pinned?: boolean;
  /**
   * 保存前把当前内容记为「上一个版本」（只保留一个）。编辑页每次打开后的第一次保存、Agent 的每次修改都会带上；
   * 编辑过程中的自动保存不带，避免上一个版本只比现在早几秒。
   */
  snapshot?: boolean;
}

export interface SnippetLibrary {
  groups: LibraryGroup[];
  snippets: Snippet[];
}

export interface NoteLibrary {
  groups: LibraryGroup[];
  notes: Note[];
}

/** 命令里的变量：{{name}} 或 {{name:默认值}}（同名变量只填一次） */
export interface SnippetVar {
  name: string;
  defaultValue: string;
}

const VAR_RE = /\{\{\s*([^{}:]+?)\s*(?::([^{}]*))?\}\}/g;

export function snippetVars(content: string): SnippetVar[] {
  const out: SnippetVar[] = [];
  for (const m of content.matchAll(VAR_RE)) {
    const name = m[1].trim();
    if (!out.some((v) => v.name === name)) out.push({ name, defaultValue: (m[2] ?? '').trim() });
  }
  return out;
}

/** 用填写的值替换变量；没填的用默认值 */
export function fillSnippet(content: string, values: Record<string, string>): string {
  return content.replace(VAR_RE, (_all, name: string, def?: string) => {
    const v = values[name.trim()];
    return v !== undefined && v !== '' ? v : (def ?? '').trim();
  });
}
