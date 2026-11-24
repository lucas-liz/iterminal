import { USER_ERROR_PREFIX } from '@itm/protocol';
import { redactServers } from './redact-server';

/**
 * 可以直接展示给用户的业务错误（参数不合法、找不到记录、远端权限不足等）。
 * IPC 路由会把它转成带 USER_ERROR_PREFIX 的消息，渲染进程只展示冒号后面的内容。
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

export function toIpcError(e: unknown): Error {
  // 界面上不显示服务端地址
  if (e instanceof UserError) {
    return new Error(USER_ERROR_PREFIX + redactServers(e.message));
  }
  const code = (e as { code?: unknown })?.code;
  const known = describeErrorCode(code);
  if (known) {
    return new Error(USER_ERROR_PREFIX + known);
  }
  if (e instanceof Error) {
    const msg = redactServers(e.message);
    if (msg === e.message) return e;
    const out = new Error(msg);
    out.name = e.name;
    return out;
  }
  return new Error(redactServers(String(e)));
}

/** 常见的系统 / SFTP 错误码转成中文提示；不认识的返回 null。 */
export function describeErrorCode(code: unknown): string | null {
  switch (code) {
    case 'ENOENT':
    case 2: // SFTP NO_SUCH_FILE
      return '文件或目录不存在';
    case 'EACCES':
    case 'EPERM':
    case 3: // SFTP PERMISSION_DENIED
      return '没有权限';
    case 'EEXIST':
    case 11: // SFTP FILE_ALREADY_EXISTS
      return '文件已存在';
    case 'ENOTEMPTY':
      return '目录不为空';
    case 'ENOTDIR':
      return '不是目录';
    case 'ECONNREFUSED':
      return '连接被拒绝，请检查地址和端口';
    case 'ETIMEDOUT':
      return '连接超时';
    case 'ENOTFOUND':
      return '无法解析主机地址';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return '网络不可达';
    case 'ECONNRESET':
      return '连接被对方重置';
    default:
      return null;
  }
}

/** 连接阶段的错误转成用户能看懂的一句话。 */
export function describeConnectError(e: unknown): string {
  const err = e as { code?: unknown; level?: unknown; message?: string };
  const known = describeErrorCode(err?.code);
  if (known) {
    return known;
  }
  if (err?.level === 'client-authentication') {
    return '认证失败：用户名、密码或私钥不正确';
  }
  if (err?.level === 'client-timeout') {
    return '连接超时';
  }
  return err?.message || String(e);
}
