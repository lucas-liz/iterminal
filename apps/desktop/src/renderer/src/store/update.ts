import { create } from 'zustand';
import type { UpdateChannel, UpdateState } from '@itm/protocol';
import { invoke } from '../api';

interface UpdateStore {
  state: UpdateState | null;
  load(): Promise<void>;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): Promise<void>;
  /** 手动下载安装包（自动安装不了时的兜底） */
  saveInstaller(): Promise<void>;
  configure(p: { channel?: UpdateChannel; autoCheck?: boolean }): Promise<void>;
}

/** 自动更新的状态（文档一 11.5），主进程通过 update.state 事件推送变化 */
export const useUpdate = create<UpdateStore>((set) => ({
  state: null,
  async load() {
    set({ state: await invoke('update.state') });
  },
  async check() {
    set({ state: await invoke('update.check') });
  },
  async download() {
    set({ state: await invoke('update.download') });
  },
  async install() {
    await invoke('update.install');
  },
  async saveInstaller() {
    set({ state: await invoke('update.saveInstaller') });
  },
  async configure(p) {
    set({ state: await invoke('update.configure', p) });
  },
}));

window.itm.on('update.state', (state) => useUpdate.setState({ state }));
