import { create } from 'zustand';
import type { Folder, Host, HostPing } from '@itm/protocol';

/** 主机编辑框：新建（可指定分组）或编辑 */
export type EditorTarget = { mode: 'create'; folderId: string | null } | { mode: 'edit'; host: Host };
import { invoke } from '../api';

/** 左侧树的特殊节点：全部主机、收藏 */
export const ALL_HOSTS = '__all__';
export const FAVORITES = '__fav__';

interface HostsState {
  folders: Folder[];
  hosts: Host[];
  loaded: boolean;
  /** 选中的分组 ID，或 ALL_HOSTS / FAVORITES */
  selected: string;
  includeSub: boolean;
  /** 按标签筛选（多选时同时满足） */
  tagFilter: string[];
  reload(): Promise<void>;
  select(key: string): void;
  setIncludeSub(v: boolean): void;
  setTagFilter(tags: string[]): void;
  /** 全局的主机编辑框（主机页、连接失败的进度卡片都可以打开） */
  editor: EditorTarget | null;
  openEditor(t: EditorTarget | null): void;
  /** 主机列表的延迟（TCP 连接耗时）：at 是测量时间；测试连接成功时也会更新 */
  latency: Record<string, HostPing & { at: number }>;
  /** 正在测量延迟的主机 */
  pinging: Record<string, true>;
  /** 测量延迟：force 为 false 时跳过 1 分钟内测过的 */
  refreshLatency(ids: string[], force?: boolean): Promise<void>;
  /** 测试连接成功：记下这次的耗时（经跳板机的主机也有了延迟） */
  setLatency(id: string, ms: number): void;
}

/** 延迟多久之后重新测量 */
const LATENCY_TTL = 60_000;

export const useHosts = create<HostsState>((set) => ({
  folders: [],
  hosts: [],
  loaded: false,
  selected: ALL_HOSTS,
  includeSub: true,
  tagFilter: [],
  editor: null,
  openEditor(t) {
    set({ editor: t });
  },
  latency: {},
  pinging: {},
  async refreshLatency(ids, force = false) {
    const now = Date.now();
    const st = useHosts.getState();
    const todo = ids.filter((id) => !st.pinging[id] && (force || !st.latency[id] || now - st.latency[id].at > LATENCY_TTL));
    if (!todo.length) return;
    set((s) => ({ pinging: { ...s.pinging, ...Object.fromEntries(todo.map((id) => [id, true as const])) } }));
    try {
      const r = await invoke('host.ping', { ids: todo });
      const at = Date.now();
      set((s) => {
        const latency = { ...s.latency };
        // 经跳板机 / 代理的主机没有直接测量：保留测试连接时记下的耗时
        for (const p of r) latency[p.id] = p.skipped && s.latency[p.id]?.ms != null ? { ...s.latency[p.id], skipped: p.skipped } : { ...p, at };
        return { latency };
      });
    } finally {
      set((s) => {
        const pinging = { ...s.pinging };
        todo.forEach((id) => delete pinging[id]);
        return { pinging };
      });
    }
  },
  setLatency(id, ms) {
    set((s) => ({ latency: { ...s.latency, [id]: { id, ms, error: null, skipped: s.latency[id]?.skipped ?? null, at: Date.now() } } }));
  },
  async reload() {
    const [folders, hosts] = await Promise.all([invoke('folder.list'), invoke('host.list')]);
    set((s) => ({
      folders,
      hosts,
      loaded: true,
      // 选中的分组被删除时回到「全部主机」
      selected: s.selected === ALL_HOSTS || s.selected === FAVORITES || folders.some((f) => f.id === s.selected) ? s.selected : ALL_HOSTS,
    }));
  },
  select(key) {
    set({ selected: key });
  },
  setIncludeSub(v) {
    set({ includeSub: v });
  },
  setTagFilter(tagFilter) {
    set({ tagFilter });
  },
}));

/** 分组的完整名称路径，例如「生产 / 订单」 */
export function folderLabel(folders: Folder[], id: string | null): string {
  if (!id) return '';
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names: string[] = [];
  for (let f = byId.get(id); f; f = f.parentId ? byId.get(f.parentId) : undefined) {
    names.unshift(f.name);
  }
  return names.join(' / ');
}

/** 选中分组下可见的主机 */
export function visibleHosts(state: Pick<HostsState, 'folders' | 'hosts' | 'selected' | 'includeSub' | 'tagFilter'>, query: string): Host[] {
  const q = query.trim().toLowerCase();
  let list = state.hosts;
  if (state.selected === FAVORITES) {
    list = list.filter((h) => h.favorite);
  } else if (state.selected !== ALL_HOSTS) {
    const folder = state.folders.find((f) => f.id === state.selected);
    if (!folder) return [];
    const ids = state.includeSub
      ? new Set(state.folders.filter((f) => f.path.startsWith(folder.path)).map((f) => f.id))
      : new Set([folder.id]);
    list = list.filter((h) => h.folderId !== null && ids.has(h.folderId));
  }
  if (state.tagFilter.length > 0) {
    const want = state.tagFilter.map((t) => t.toLowerCase());
    list = list.filter((h) => want.every((t) => h.tags.some((x) => x.toLowerCase() === t)));
  }
  if (q) {
    list = list.filter((h) =>
      [h.name, h.address, h.username, h.note ?? '', ...h.tags].some((v) => v.toLowerCase().includes(q)),
    );
  }
  return list;
}

export interface FolderOption {
  title: string;
  value: string;
  children: FolderOption[];
}

/** TreeSelect 用的分组树 */
export function folderOptions(folders: Folder[], parentId: string | null = null): FolderOption[] {
  return folders
    .filter((f) => f.parentId === parentId)
    .map((f) => ({ title: f.name, value: f.id, children: folderOptions(folders, f.id) }));
}

// 团队主机在后台同步后重新加载（主进程推送）
window.itm.on('hosts.changed', () => void useHosts.getState().reload());
