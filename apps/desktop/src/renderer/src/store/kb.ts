import { create } from 'zustand';
import type { KbCollectionInfo } from '@itm/protocol';
import { invoke } from '../api';

/** 账号能检索的团队知识库（AI 引用知识库时选择）；本地模式为空 */
interface KbState {
  list: KbCollectionInfo[];
  loaded: boolean;
  load(): Promise<void>;
}

export const useKb = create<KbState>((set) => ({
  list: [],
  loaded: false,
  async load() {
    set({ list: await invoke('kb.collections'), loaded: true });
  },
}));

/** 引用标签上的名字：'*' 是全部知识库 */
export function kbName(list: KbCollectionInfo[], id: string): string {
  return id === '*' ? '全部知识库' : (list.find((c) => c.id === id)?.name ?? '知识库');
}
