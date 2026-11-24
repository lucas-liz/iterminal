import { create } from 'zustand';
import type { DbColumnInfo, DbObjectList, SqlExecItem } from '@itm/protocol';
import { invoke } from '../api';

/** 编辑器标签（保存在本机，重启后还在；文档一 6.32.1） */
export interface SqlTab {
  id: string;
  title: string;
  dbId: string | null;
  database: string | null;
  schema: string | null;
  sql: string;
}

/** 标签的运行状态（不保存） */
export interface SqlRuntime {
  running: boolean;
  runId: string | null;
  results: SqlExecItem[];
  /** 结果区当前的标签：r0、r1… 或 messages */
  view: string;
  stopped: boolean;
  /** 执行前就失败（分级拒绝、连不上） */
  error: string | null;
  /** 新开的标签打开后自动执行一次（双击表） */
  autoRun?: boolean;
}

const KEY = 'itm.sql.tabs';
const MAX_TABS = 20;
const EMPTY_RUNTIME: SqlRuntime = { running: false, runId: null, results: [], view: 'messages', stopped: false, error: null };

function load(): { tabs: SqlTab[]; active: string | null } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { tabs?: SqlTab[]; active?: string | null };
    const tabs = Array.isArray(v.tabs) ? v.tabs.filter((t) => t && typeof t.id === 'string').slice(0, MAX_TABS) : [];
    return { tabs, active: tabs.some((t) => t.id === v.active) ? (v.active ?? null) : (tabs[0]?.id ?? null) };
  } catch {
    return { tabs: [], active: null };
  }
}

interface State {
  tabs: SqlTab[];
  active: string | null;
  runtime: Record<string, SqlRuntime>;
  /** 库表树和补全的缓存：`${dbId}|${database}|${schema}` → 这一层；`${dbId}|${database}|${schema}` → 列 */
  objects: Record<string, DbObjectList>;
  columns: Record<string, DbColumnInfo[]>;
  addTab(p: Partial<SqlTab>): string;
  closeTab(id: string): void;
  setActive(id: string): void;
  update(id: string, patch: Partial<SqlTab>): void;
  setRuntime(id: string, patch: Partial<SqlRuntime>): void;
  loadObjects(dbId: string, database: string | null, schema: string | null, refresh?: boolean): Promise<DbObjectList>;
  loadColumns(dbId: string, database: string | null, schema: string | null, tables: string[]): Promise<DbColumnInfo[]>;
  forget(dbId: string): void;
}

export const objKey = (dbId: string, database: string | null, schema: string | null): string => `${dbId}|${database ?? ''}|${schema ?? ''}`;

export const useSqlWorkbench = create<State>((set, get) => ({
  ...load(),
  runtime: {},
  objects: {},
  columns: {},
  addTab(p) {
    const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const n = get().tabs.length + 1;
    const tab: SqlTab = { id, title: p.title ?? `查询 ${n}`, dbId: p.dbId ?? null, database: p.database ?? null, schema: p.schema ?? null, sql: p.sql ?? '' };
    set((s) => ({ tabs: [...s.tabs, tab].slice(-MAX_TABS), active: id }));
    return id;
  },
  closeTab(id) {
    const r = get().runtime[id];
    if (r?.running && r.runId) void invoke('db.cancel', { runId: r.runId }).catch(() => undefined);
    set((s) => {
      const i = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      const runtime = { ...s.runtime };
      delete runtime[id];
      return { tabs, runtime, active: s.active === id ? (tabs[Math.min(i, tabs.length - 1)]?.id ?? null) : s.active };
    });
  },
  setActive(id) {
    set({ active: id });
  },
  update(id, patch) {
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) }));
  },
  setRuntime(id, patch) {
    set((s) => ({ runtime: { ...s.runtime, [id]: { ...(s.runtime[id] ?? EMPTY_RUNTIME), ...patch } } }));
  },
  async loadObjects(dbId, database, schema, refresh) {
    const key = objKey(dbId, database, schema);
    const hit = get().objects[key];
    if (hit && !refresh) return hit;
    const list = await invoke('db.objects', { id: dbId, database, schema });
    set((s) => ({ objects: { ...s.objects, [key]: list } }));
    return list;
  },
  async loadColumns(dbId, database, schema, tables) {
    const key = objKey(dbId, database, schema);
    const have = get().columns[key] ?? [];
    const need = tables.filter((t) => !have.some((c) => c.table === t));
    if (!need.length) return have.filter((c) => tables.includes(c.table));
    const cols = await invoke('db.columns', { id: dbId, database, schema, tables: need });
    const merged = [...have.filter((c) => !need.includes(c.table)), ...cols];
    set((s) => ({ columns: { ...s.columns, [key]: merged } }));
    return merged.filter((c) => tables.includes(c.table));
  },
  forget(dbId) {
    set((s) => ({
      objects: Object.fromEntries(Object.entries(s.objects).filter(([k]) => !k.startsWith(`${dbId}|`))),
      columns: Object.fromEntries(Object.entries(s.columns).filter(([k]) => !k.startsWith(`${dbId}|`))),
    }));
  },
}));

export const runtimeOf = (s: State, id: string): SqlRuntime => s.runtime[id] ?? EMPTY_RUNTIME;

// 标签和 SQL 存到本机（防抖）
let timer: ReturnType<typeof setTimeout> | null = null;
useSqlWorkbench.subscribe((s, prev) => {
  if (s.tabs === prev.tabs && s.active === prev.active) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => localStorage.setItem(KEY, JSON.stringify({ tabs: s.tabs, active: s.active })), 300);
});
