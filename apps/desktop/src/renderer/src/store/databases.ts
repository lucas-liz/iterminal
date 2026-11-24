import { create } from 'zustand';
import type { DbAsset } from '@itm/protocol';
import { invoke } from '../api';

/** 数据库资产（第十七轮，文档一 6.31.2）：数据库页、AI 引用共用 */
interface DbState {
  list: DbAsset[];
  loaded: boolean;
  load(): Promise<void>;
}

export const useDatabases = create<DbState>((set) => ({
  list: [],
  loaded: false,
  async load() {
    set({ list: await invoke('db.list'), loaded: true });
  },
}));

export const DB_TYPE_LABEL: Record<DbAsset['type'], string> = { MYSQL: 'MySQL', POSTGRES: 'PostgreSQL', SQLITE: 'SQLite' };

/** 列表和引用里显示的地址：user@host:port/db 或 SQLite 文件名 */
export function dbWhere(a: DbAsset): string {
  if (a.type === 'SQLITE') return a.filePath ?? '';
  return `${a.username ? `${a.username}@` : ''}${a.host}:${a.port}${a.database ? `/${a.database}` : ''}`;
}
