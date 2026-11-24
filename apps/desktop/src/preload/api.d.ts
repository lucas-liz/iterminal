import type { IpcArg, IpcChannel, IpcEventName, IpcEvents, IpcResult } from '@itm/protocol';

/** preload 暴露给渲染进程的 API（类型声明） */
export interface ItmBridge {
  platform: string;
  invoke<C extends IpcChannel>(channel: C, arg?: IpcArg<C>): Promise<Awaited<IpcResult<C>>>;
  on<E extends IpcEventName>(event: E, cb: (payload: IpcEvents[E]) => void): () => void;
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    itm: ItmBridge;
  }
}
