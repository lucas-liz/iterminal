import { create } from 'zustand';
import type { SessionStatus } from '@itm/protocol';

export type TabKind = 'ssh' | 'local' | 'sftp' | 'telnet' | 'serial';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  hostId?: string;
  status: SessionStatus;
  /** 终端会话 ID（连接后才有），Agent 引用终端时使用 */
  sessionId?: string;
  /** 远端 shell 的当前目录（右侧文件面板跟随） */
  cwd?: string;
  /** 分屏里的窗格：所属的标签（标签栏只显示没有 parentId 的标签） */
  parentId?: string;
}

/** 分屏布局树（文档一 6.1）：叶子是一个终端窗格（对应一个 Tab / 会话） */
export type LayoutNode = { type: 'leaf'; tabId: string } | { type: 'split'; dir: 'h' | 'v'; children: LayoutNode[] };

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  /** 有分屏的标签 → 布局树（没有分屏的标签不在这里） */
  layouts: Record<string, LayoutNode>;
  /** 每个标签里获得焦点的窗格 */
  focused: Record<string, string>;
  /** 广播输入：开启时，在任意一个目标会话里输入都会同时写到所有目标会话 */
  broadcast: { on: boolean; targets: string[] };
  open(tab: Omit<Tab, 'id' | 'status'>): string;
  /** 关闭标签（连同分屏里的所有窗格）；传入窗格 ID 时只关闭这个窗格 */
  close(id: string): void;
  closePane(id: string): void;
  activate(id: string): void;
  /** 拖动标签换位置：把标签 id 放到标签 target 的前面（after = true 时放到后面） */
  move(id: string, target: string, after: boolean): void;
  setStatus(id: string, status: SessionStatus): void;
  patch(id: string, patch: Partial<Pick<Tab, 'sessionId' | 'cwd' | 'title'>>): void;
  /** 在窗格旁边分出一个新窗格（dir：h 左右、v 上下） */
  split(paneId: string, dir: 'h' | 'v', tab: Omit<Tab, 'id' | 'status' | 'parentId'>): string;
  focus(paneId: string): void;
  setBroadcast(on: boolean, targets?: string[]): void;
  /** 重新连接请求（标签右键「重新连接」）：每次加一，终端据此断开旧会话再连 */
  reconnectSeq: Record<string, number>;
  requestReconnect(id: string): void;
}

let seq = 0;

/** 标签栏里还没有终端时新开了终端（AI 面板据此换成全新的对话） */
const firstTerminalListeners = new Set<() => void>();
export function onFirstTerminal(fn: () => void): () => void {
  firstTerminalListeners.add(fn);
  return () => firstTerminalListeners.delete(fn);
}

/** 根标签 ID（窗格返回它所在的标签） */
export function rootOf(tabs: Tab[], id: string): string {
  return tabs.find((t) => t.id === id)?.parentId ?? id;
}

/** 布局里的所有窗格 */
export function leaves(node: LayoutNode): string[] {
  return node.type === 'leaf' ? [node.tabId] : node.children.flatMap(leaves);
}

function insert(node: LayoutNode, target: string, dir: 'h' | 'v', newId: string): LayoutNode {
  if (node.type === 'leaf') {
    return node.tabId === target ? { type: 'split', dir, children: [node, { type: 'leaf', tabId: newId }] } : node;
  }
  const idx = node.children.findIndex((c) => c.type === 'leaf' && c.tabId === target);
  if (idx >= 0 && node.dir === dir) {
    const children = [...node.children];
    children.splice(idx + 1, 0, { type: 'leaf', tabId: newId });
    return { ...node, children };
  }
  return { ...node, children: node.children.map((c) => insert(c, target, dir, newId)) };
}

function remove(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'leaf') return node.tabId === id ? null : node;
  const children = node.children.map((c) => remove(c, id)).filter((c): c is LayoutNode => !!c);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** 标签换位置（只排根标签；分屏窗格不在标签栏里，顺序不变） */
export function moveTab(tabs: Tab[], id: string, target: string, after: boolean): Tab[] {
  if (id === target) return tabs;
  const moving = tabs.find((t) => t.id === id && !t.parentId);
  if (!moving || !tabs.some((t) => t.id === target && !t.parentId)) return tabs;
  const rest = tabs.filter((t) => t.id !== id);
  const at = rest.findIndex((t) => t.id === target) + (after ? 1 : 0);
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}

export interface TabDrop {
  /** 放在这个标签的左边（after = false）或右边 */
  id: string;
  after: boolean;
}

/**
 * 拖动标签时的放下位置（第三十二轮）：指针越过其他标签的中线才换位置，和浏览器标签一样。
 * order 是标签栏里的顺序，mids 是对应标签的水平中线；返回 null 表示放下后位置不变（不显示蓝色竖线）。
 */
export function tabDropSlot(order: string[], mids: number[], dragged: string, x: number): TabDrop | null {
  const from = order.indexOf(dragged);
  if (from < 0) return null;
  const others = order.filter((id) => id !== dragged);
  const at = mids.filter((m, i) => order[i] !== dragged && m < x).length;
  if (at === from || others.length === 0) return null;
  return at === 0 ? { id: others[0], after: false } : { id: others[at - 1], after: true };
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,
  layouts: {},
  focused: {},
  broadcast: { on: false, targets: [] },
  open(tab) {
    const id = `tab-${++seq}`;
    // 标签栏里还没有终端时新开终端：右侧 AI 用一个全新的对话（已经有终端时沿用当前对话）
    const firstTerminal = tab.kind !== 'sftp' && !get().tabs.some((t) => t.kind !== 'sftp');
    set((s) => ({ tabs: [...s.tabs, { ...tab, id, status: 'connecting' }], activeId: id }));
    if (firstTerminal) firstTerminalListeners.forEach((fn) => fn());
    return id;
  },
  close(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.parentId) {
      get().closePane(id);
      return;
    }
    // 关闭整个标签：连同分屏里的所有窗格
    set((s) => {
      const gone = new Set(s.tabs.filter((t) => t.id === id || t.parentId === id).map((t) => t.id));
      const roots = s.tabs.filter((t) => !t.parentId);
      const i = roots.findIndex((t) => t.id === id);
      const restRoots = roots.filter((t) => t.id !== id);
      const layouts = { ...s.layouts };
      const focused = { ...s.focused };
      delete layouts[id];
      delete focused[id];
      return {
        tabs: s.tabs.filter((t) => !gone.has(t.id)),
        activeId: s.activeId === id ? (restRoots[Math.min(i, restRoots.length - 1)]?.id ?? null) : s.activeId,
        layouts,
        focused,
        broadcast: { ...s.broadcast, targets: s.broadcast.targets.filter((x) => !gone.has(x)) },
      };
    });
  },
  closePane(id) {
    const s = get();
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return;
    const root = tab.parentId ?? id;
    const layout = s.layouts[root];
    if (!layout) {
      s.close(root);
      return;
    }
    const next = remove(layout, id);
    const rest = next ? leaves(next) : [];
    if (rest.length === 0) {
      s.close(root);
      return;
    }
    set((st) => {
      const layouts = { ...st.layouts };
      const focused = { ...st.focused };
      // 关掉的是根窗格：剩下的第一个窗格接替成为标签
      const newRoot = id === root ? rest[0] : root;
      delete layouts[root];
      if (rest.length > 1) layouts[newRoot] = next!;
      delete focused[root];
      focused[newRoot] = st.focused[root] && st.focused[root] !== id && rest.includes(st.focused[root]) ? st.focused[root] : rest[0];
      const tabs = st.tabs
        .filter((t) => t.id !== id)
        .map((t) => {
          if (t.id === newRoot) return { ...t, parentId: undefined };
          if (t.parentId === root) return { ...t, parentId: rest.length > 1 ? newRoot : undefined };
          return t;
        });
      return {
        tabs,
        layouts,
        focused,
        activeId: st.activeId === root ? newRoot : st.activeId,
        broadcast: { ...st.broadcast, targets: st.broadcast.targets.filter((x) => x !== id) },
      };
    });
  },
  activate(id) {
    set((s) => ({ activeId: rootOf(s.tabs, id), focused: s.tabs.find((t) => t.id === id)?.parentId ? { ...s.focused, [rootOf(s.tabs, id)]: id } : s.focused }));
  },
  move(id, target, after) {
    set((s) => ({ tabs: moveTab(s.tabs, id, target, after) }));
  },
  setStatus(id, status) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)) }));
  },
  patch(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },
  split(paneId, dir, tab) {
    const id = `tab-${++seq}`;
    const root = rootOf(get().tabs, paneId);
    set((s) => {
      const layout = s.layouts[root] ?? { type: 'leaf', tabId: root };
      return {
        tabs: [...s.tabs, { ...tab, id, status: 'connecting', parentId: root }],
        layouts: { ...s.layouts, [root]: insert(layout, paneId, dir, id) },
        focused: { ...s.focused, [root]: id },
        activeId: root,
      };
    });
    return id;
  },
  focus(paneId) {
    set((s) => ({ focused: { ...s.focused, [rootOf(s.tabs, paneId)]: paneId } }));
  },
  setBroadcast(on, targets) {
    set((s) => ({ broadcast: { on, targets: targets ?? s.broadcast.targets } }));
  },
  reconnectSeq: {},
  requestReconnect(id) {
    set((s) => ({ reconnectSeq: { ...s.reconnectSeq, [id]: (s.reconnectSeq[id] ?? 0) + 1 } }));
  },
}));

/** 当前标签里获得焦点的窗格（没有分屏时就是标签本身） */
export function activePane(state: Pick<TabsState, 'tabs' | 'activeId' | 'focused'>): Tab | undefined {
  if (!state.activeId) return undefined;
  const id = state.focused[state.activeId] ?? state.activeId;
  return state.tabs.find((t) => t.id === id) ?? state.tabs.find((t) => t.id === state.activeId);
}
