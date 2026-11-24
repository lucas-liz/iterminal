import { USER_ERROR_PREFIX, type ConnProgress, type IpcArg, type IpcChannel, type IpcEvents, type IpcResult, type SerialSessionState, type SessionStatus } from '@itm/protocol';

/** 调用主进程（类型来自 @itm/protocol） */
export function invoke<C extends IpcChannel>(channel: C, ...arg: IpcArg<C> extends void ? [] : [IpcArg<C>]): Promise<Awaited<IpcResult<C>>> {
  return window.itm.invoke(channel, arg[0] as IpcArg<C>);
}

/** 把 IPC 错误转成给用户看的一句话 */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const i = raw.indexOf(USER_ERROR_PREFIX);
  if (i >= 0) {
    return raw.slice(i + USER_ERROR_PREFIX.length);
  }
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export const isMac = window.itm.platform === 'darwin';

// ------------------------------------------------------------------ 会话事件分发

interface SessionListener {
  onData(data: string): void;
  onStatus(status: SessionStatus, message?: string): void;
  /** 远端 shell 的当前目录变化 */
  onCwd?(cwd: string): void;
  /** 串口会话的显示 / 控制线 / 文件发送状态 */
  onSerial?(state: SerialSessionState): void;
  /** 连接进度（步骤 + 连接日志） */
  onProgress?(p: ConnProgress): void;
}

type Pending = { data: string[]; status: IpcEvents['session.status'][]; progress: ConnProgress[] };

const listeners = new Map<string, SessionListener>();
/** 订阅前就到达的事件先缓存（本地 Shell 可能在 invoke 返回前就有输出） */
const pending = new Map<string, Pending>();

function pendingOf(id: string): Pending {
  let p = pending.get(id);
  if (!p) {
    p = { data: [], status: [], progress: [] };
    pending.set(id, p);
    // 没人认领的缓存 30 秒后丢弃
    setTimeout(() => pending.delete(id), 30_000);
  }
  return p;
}

window.itm.on('session.data', ({ sessionId, data }) => {
  const l = listeners.get(sessionId);
  if (l) {
    l.onData(data);
  } else {
    pendingOf(sessionId).data.push(data);
  }
});

window.itm.on('session.status', (e) => {
  const l = listeners.get(e.sessionId);
  if (l) {
    l.onStatus(e.status, e.message);
  } else {
    pendingOf(e.sessionId).status.push(e);
  }
});

window.itm.on('session.progress', (e) => {
  const l = listeners.get(e.sessionId);
  if (l) l.onProgress?.(e);
  else pendingOf(e.sessionId).progress.push(e);
});

window.itm.on('session.cwd', ({ sessionId, cwd }) => listeners.get(sessionId)?.onCwd?.(cwd));

/** 串口状态：订阅前到达的保留最后一份 */
const serialStates = new Map<string, SerialSessionState>();
window.itm.on('session.serial', ({ sessionId, state }) => {
  const l = listeners.get(sessionId);
  if (l?.onSerial) l.onSerial(state);
  else serialStates.set(sessionId, state);
});

export function subscribeSession(sessionId: string, listener: SessionListener): () => void {
  listeners.set(sessionId, listener);
  const p = pending.get(sessionId);
  if (p) {
    pending.delete(sessionId);
    p.progress.forEach((x) => listener.onProgress?.(x));
    p.data.forEach((d) => listener.onData(d));
    p.status.forEach((s) => listener.onStatus(s.status, s.message));
  }
  const ser = serialStates.get(sessionId);
  if (ser) {
    serialStates.delete(sessionId);
    listener.onSerial?.(ser);
  }
  return () => {
    if (listeners.get(sessionId) === listener) {
      listeners.delete(sessionId);
    }
  };
}
