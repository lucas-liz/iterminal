import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { IPC_CHANNELS, IPC_EVENTS, type IpcChannel, type IpcEventName } from '@itm/protocol';

const channels = new Set<string>(IPC_CHANNELS);
const events = new Set<string>(IPC_EVENTS);

/**
 * 渲染进程唯一能用的桥（window.itm）。只放行 @itm/protocol 里声明的通道和事件。
 */
const api = {
  platform: process.platform,
  invoke(channel: IpcChannel, arg?: unknown): Promise<unknown> {
    if (!channels.has(channel)) {
      return Promise.reject(new Error(`未知的 IPC 通道：${channel}`));
    }
    return ipcRenderer.invoke(channel, arg);
  },
  on(event: IpcEventName, cb: (payload: unknown) => void): () => void {
    if (!events.has(event)) {
      throw new Error(`未知的事件：${event}`);
    }
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
  /** 拖入的本地文件 → 绝对路径（sandbox 下 File.path 不可用） */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

contextBridge.exposeInMainWorld('itm', api);
