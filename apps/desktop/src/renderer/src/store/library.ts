import { create } from 'zustand';
import { snippetVars, type LibraryGroup, type Note, type Snippet } from '@itm/protocol';
import { invoke } from '../api';
import { activePane, useTabs, type Tab } from './tabs';
import { useApp } from './app';
import { useAgent } from './agent';

interface LibraryState {
  snippetGroups: LibraryGroup[];
  snippets: Snippet[];
  noteGroups: LibraryGroup[];
  notes: Note[];
  /** 正在发送的快捷命令（有变量或要选择目标时弹出填写框） */
  running: { snippet: Snippet; broadcast: boolean; execute: boolean } | null;
  /** 笔记页当前打开的笔记 */
  selectedNoteId: string | null;
  /** 笔记在编辑页之外被改了（Agent 修改、撤回）：编辑区按这个版本号重新载入 */
  noteRev: Record<string, number>;
  bumpNote(id: string): void;
  reloadSnippets(): Promise<void>;
  reloadNotes(): Promise<void>;
  /**
   * 发送快捷命令：没有变量、发到当前终端时直接发送；有变量或者要广播时弹出填写框（SnippetRunner）。
   * execute = true 时末尾追加回车（直接执行），否则只放进输入行。
   */
  run(snippet: Snippet, opts?: { broadcast?: boolean; execute?: boolean }): void;
  closeRunner(): void;
  selectNote(id: string | null): void;
  /** 打开笔记页并选中这篇笔记 */
  openNote(id: string): void;
  /** 终端选中内容、AI 回答「存为笔记」：新建一篇未分组的笔记 */
  saveAsNote(title: string, content: string): Promise<Note>;
}

export const useLibrary = create<LibraryState>((set) => ({
  snippetGroups: [],
  snippets: [],
  noteGroups: [],
  notes: [],
  running: null,
  selectedNoteId: null,
  noteRev: {},
  bumpNote(id) {
    set((s) => ({ noteRev: { ...s.noteRev, [id]: (s.noteRev[id] ?? 0) + 1 } }));
  },
  async reloadSnippets() {
    const lib = await invoke('snippet.list');
    set({ snippetGroups: lib.groups, snippets: lib.snippets });
  },
  async reloadNotes() {
    const lib = await invoke('note.list');
    set({ noteGroups: lib.groups, notes: lib.notes });
  },
  run(snippet, opts) {
    const broadcast = !!opts?.broadcast;
    const execute = opts?.execute ?? true;
    const target = currentTerminal();
    if (!broadcast && snippetVars(snippet.content).length === 0 && target) {
      sendToTerminals([target.id], snippet.content, execute);
      // 从指令集页发送时切到终端页，看得到执行结果
      if (useApp.getState().page !== 'workspace') useApp.getState().setPage('workspace');
      return;
    }
    set({ running: { snippet, broadcast, execute } });
  },
  closeRunner() {
    set({ running: null });
  },
  selectNote(id) {
    set({ selectedNoteId: id });
  },
  openNote(id) {
    set({ selectedNoteId: id });
    useApp.getState().setPage('notes');
  },
  async saveAsNote(title, content) {
    const note = await invoke('note.save', { id: null, input: { groupId: null, title: title.slice(0, 120), content } });
    await useLibrary.getState().reloadNotes();
    return note;
  },
}));

// Agent 新建 / 修改了笔记或 Skill：重新加载
window.itm.on('library.changed', (e) => {
  if (e.kind === 'note') {
    void useLibrary
      .getState()
      .reloadNotes()
      .then(() => useLibrary.getState().bumpNote(e.id));
  } else {
    void useAgent.getState().loadSkills();
  }
});

/** 已连接的终端（不含 SFTP） */
export function readyTerminals(tabs: Tab[] = useTabs.getState().tabs): Tab[] {
  return tabs.filter((t) => t.kind !== 'sftp' && t.status === 'ready' && t.sessionId);
}

/** 当前获得焦点的已连接终端 */
export function currentTerminal(): Tab | undefined {
  const s = useTabs.getState();
  const pane = activePane(s);
  return pane && pane.kind !== 'sftp' && pane.status === 'ready' && pane.sessionId ? pane : undefined;
}

/** 把命令写到这些终端；多行命令逐行回车，execute 时最后一行也回车 */
export function sendToTerminals(tabIds: string[], content: string, execute: boolean): number {
  const text = content.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const data = text.replace(/\n/g, '\r') + (execute ? '\r' : '');
  let n = 0;
  for (const t of useTabs.getState().tabs) {
    if (tabIds.includes(t.id) && t.sessionId && t.status === 'ready') {
      void invoke('session.write', { sessionId: t.sessionId, data });
      n++;
    }
  }
  return n;
}
