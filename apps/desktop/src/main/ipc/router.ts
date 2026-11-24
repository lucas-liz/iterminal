import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, type IpcApi, type IpcArg, type IpcChannel, type IpcResult } from '@itm/protocol';
import { describeErrorCode, toIpcError, UserError } from '../util/errors';
import { logIpc } from '../services/diag/diag-log';

/** 处理函数：第二个参数是发起调用的窗口（webContents.id），会话、提示、传输都按它隔离 */
export type Handlers = {
  [C in IpcChannel]: (arg: IpcArg<C>, owner: number) => IpcResult<C> | Promise<Awaited<IpcResult<C>>>;
};

/** 返回不允许调用的原因（例如界面已锁定），允许时返回 null */
export type IpcGate = (channel: IpcChannel) => string | null;

/**
 * 注册全部 IPC 通道。只接受来自本应用页面的调用（开发服务器或打包后的 file:// 页面），
 * 其他来源（例如被注入的 iframe）一律拒绝。锁定 / 还没解锁时只放行 gate 允许的通道。
 */
export function registerIpc(handlers: Handlers, isTrustedUrl: (url: string) => boolean, gate: IpcGate = () => null): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, arg: unknown) => {
      const url = event.senderFrame?.url ?? '';
      if (!isTrustedUrl(url)) {
        throw new Error(`拒绝来自不受信任页面的调用：${channel}`);
      }
      const t0 = Date.now();
      try {
        const blocked = gate(channel);
        if (blocked) throw new UserError(blocked);
        const handler = handlers[channel] as (a: unknown, owner: number) => unknown;
        const result = await handler(arg, event.sender.id);
        // 诊断日志（第十三轮）：通道、耗时、结果
        logIpc(channel, arg, Date.now() - t0);
        return result;
      } catch (e) {
        logIpc(channel, arg, Date.now() - t0, e, e instanceof UserError || !!describeErrorCode((e as { code?: unknown })?.code));
        throw toIpcError(e);
      }
    });
  }
}

/** 编译期保证 Handlers 覆盖了 IpcApi 的每个通道 */
export type _Exhaustive = keyof IpcApi extends keyof Handlers ? true : never;
