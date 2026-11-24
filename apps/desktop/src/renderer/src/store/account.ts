import { create } from 'zustand';
import type { AccountState } from '@itm/protocol';
import { invoke } from '../api';

/** 登录框的预填内容；reason 是打开登录框的原因（例如登录已过期） */
export interface LoginPrefill {
  username?: string;
  reason?: string;
}

interface AccountStore {
  state: AccountState | null;
  /** 不为 null 时显示登录框 */
  login: LoginPrefill | null;
  load(): Promise<void>;
  openLogin(p?: LoginPrefill): void;
  closeLogin(): void;
}

/** 账号状态（文档一 2.3）：本地模式 / 已登录 / 登录已过期 / 设备被吊销，主进程用事件推送变化 */
export const useAccount = create<AccountStore>((set) => ({
  state: null,
  login: null,
  async load() {
    set({ state: await invoke('account.state') });
  },
  openLogin(p = {}) {
    set({ login: p });
  },
  closeLogin() {
    set({ login: null });
  },
}));

window.itm.on('account.state', (state) => useAccount.setState({ state }));
