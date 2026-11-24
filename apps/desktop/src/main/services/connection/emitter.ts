import type { IpcEventName, IpcEvents } from '@itm/protocol';

/**
 * 向指定窗口（webContents.id）发送事件。生产环境由主进程入口用 webContents.send 实现，测试里用内存实现。
 */
export type Emit = <E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]) => void;
