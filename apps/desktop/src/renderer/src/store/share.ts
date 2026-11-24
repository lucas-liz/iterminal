import { create } from 'zustand';
import type { ShareSelection } from '@itm/protocol';
import { useAccount } from './account';

interface ShareStore {
  /** 不为 null 时显示分享对话框 */
  selection: ShareSelection | null;
  open(selection: ShareSelection): void;
  close(): void;
}

/**
 * 单项分享（第十三轮，文档一 6.27.4）：主机列表、分组、指令集、笔记的「分享」都打开同一个对话框。
 * 分享码在服务端中转（端到端加密），需要登录；本地模式打开登录框。
 */
export const useShare = create<ShareStore>((set) => ({
  selection: null,
  open(selection) {
    const st = useAccount.getState().state;
    if (!st || st.status === 'none') {
      useAccount.getState().openLogin({ reason: '分享需要登录 iTerminal 服务端（分享内容端到端加密，服务端只转发密文）' });
      return;
    }
    set({ selection });
  },
  close() {
    set({ selection: null });
  },
}));

/** 从分享码导入（第二十六轮）：主机页、笔记页的「导入 → 从分享码导入」打开同一个对话框，only 只列出这一类 */
export type SharePullScope = 'hosts' | 'notes' | null;
interface SharePullStore {
  open: boolean;
  only: SharePullScope;
  show(only?: SharePullScope): void;
  close(): void;
}
export const useSharePull = create<SharePullStore>((set) => ({
  open: false,
  only: null,
  show(only = null) {
    const st = useAccount.getState().state;
    if (!st || st.status !== 'valid') {
      useAccount.getState().openLogin({ reason: '从分享码导入需要登录 iTerminal 服务端（分享内容端到端加密，服务端只转发密文）' });
      return;
    }
    set({ open: true, only });
  },
  close() {
    set({ open: false, only: null });
  },
}));
