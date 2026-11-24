import { create } from 'zustand';

/** 文件面板的列（第十六轮，参考 MobaXterm：名称、大小(KB)、时间、所有者、组、权限） */
export type ColKey = 'name' | 'size' | 'mtime' | 'owner' | 'group' | 'perms';
export interface ColDef {
  key: ColKey;
  label: string;
  /** 默认宽度（名称列默认填满剩余空间） */
  width: number;
  min: number;
  right?: boolean;
}
export const COLS: ColDef[] = [
  { key: 'name', label: '名称', width: 160, min: 80 },
  { key: 'size', label: '大小(KB)', width: 76, min: 48, right: true },
  { key: 'mtime', label: '时间', width: 92, min: 56 },
  { key: 'owner', label: '所有者', width: 68, min: 40 },
  { key: 'group', label: '组', width: 68, min: 36 },
  { key: 'perms', label: '权限', width: 88, min: 56 },
];
const COL_KEYS = COLS.map((c) => c.key);

export interface ColPrefs {
  /** 拖动调整过的宽度；名称列没有时填满剩余空间 */
  widths: Partial<Record<ColKey, number>>;
  /** 隐藏的列（名称列不能隐藏） */
  hidden: ColKey[];
}
export interface SortPref {
  key: ColKey;
  desc: boolean;
}

const COLS_KEY = 'itm.files.cols';
const SORT_KEY = 'itm.files.sort';
const HISTORY_KEY = 'itm.files.history';
/** 每台主机记住的最近目录数 */
export const HISTORY_MAX = 20;

function load<T>(key: string, fallback: T, check: (v: unknown) => T | null): T {
  try {
    if (typeof localStorage === 'undefined') return fallback;
    return check(JSON.parse(localStorage.getItem(key) ?? 'null')) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, v: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 存不下就算了
  }
}

export function sanitizeCols(v: unknown): ColPrefs | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { widths?: Record<string, unknown>; hidden?: unknown };
  const widths: Partial<Record<ColKey, number>> = {};
  for (const c of COLS) {
    const w = o.widths?.[c.key];
    if (typeof w === 'number' && Number.isFinite(w)) widths[c.key] = Math.min(1200, Math.max(c.min, Math.round(w)));
  }
  const hidden = Array.isArray(o.hidden) ? o.hidden.filter((k): k is ColKey => COL_KEYS.includes(k as ColKey) && k !== 'name') : [];
  return { widths, hidden };
}

/** 最近访问的目录：新的放最前面，去重，最多 max 个 */
export function pushHistory(list: string[], path: string, max = HISTORY_MAX): string[] {
  if (!path) return list;
  return [path, ...list.filter((p) => p !== path)].slice(0, max);
}

/** 大小按 KB 显示（MobaXterm 风格）：小于 10 KB 保留一位小数，其他取整并加千位分隔符 */
export function formatKb(bytes: number): string {
  if (!bytes || bytes <= 0) return '0';
  const kb = bytes / 1024;
  if (kb < 10) return String(Math.max(0.1, Math.round(kb * 10) / 10));
  return Math.round(kb).toLocaleString('en-US');
}

interface FilePrefsState {
  cols: ColPrefs;
  sort: SortPref;
  /** 按主机记住的最近目录 */
  history: Record<string, string[]>;
  setWidth(key: ColKey, width: number | null): void;
  /** 拖动结束时保存列宽 */
  persistCols(): void;
  toggleCol(key: ColKey): void;
  resetCols(): void;
  setSort(s: SortPref): void;
  remember(hostId: string, path: string): void;
  clearHistory(hostId: string): void;
}

export const useFilePrefs = create<FilePrefsState>((set, get) => ({
  cols: load<ColPrefs>(COLS_KEY, { widths: {}, hidden: [] }, sanitizeCols),
  sort: load<SortPref>(SORT_KEY, { key: 'name', desc: false }, (v) => {
    const s = v as SortPref | null;
    return s && COL_KEYS.includes(s.key) ? { key: s.key, desc: !!s.desc } : null;
  }),
  history: load<Record<string, string[]>>(HISTORY_KEY, {}, (v) => (v && typeof v === 'object' ? (v as Record<string, string[]>) : null)),
  setWidth(key, width) {
    const widths = { ...get().cols.widths };
    if (width === null) delete widths[key];
    else widths[key] = width;
    set({ cols: { ...get().cols, widths } });
  },
  persistCols() {
    save(COLS_KEY, get().cols);
  },
  toggleCol(key) {
    if (key === 'name') return;
    const { hidden } = get().cols;
    const cols = { ...get().cols, hidden: hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key] };
    set({ cols });
    save(COLS_KEY, cols);
  },
  resetCols() {
    const cols = { widths: {}, hidden: [] };
    set({ cols });
    save(COLS_KEY, cols);
  },
  setSort(sort) {
    set({ sort });
    save(SORT_KEY, sort);
  },
  remember(hostId, path) {
    const cur = get().history[hostId] ?? [];
    if (cur[0] === path) return;
    const history = { ...get().history, [hostId]: pushHistory(cur, path) };
    // 主机太多时去掉最早的
    const hosts = Object.keys(history);
    if (hosts.length > 200) delete history[hosts[0]];
    set({ history });
    save(HISTORY_KEY, history);
  },
  clearHistory(hostId) {
    const history = { ...get().history };
    delete history[hostId];
    set({ history });
    save(HISTORY_KEY, history);
  },
}));
