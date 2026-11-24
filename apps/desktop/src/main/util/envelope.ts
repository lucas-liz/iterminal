/**
 * 服务端统一响应的错误判断：客户端接口 {code: 0, message, data}，若依的接口 {code: 200, msg, data}。
 * 若依的全局异常处理总是返回 HTTP 200（例如服务端版本旧、没有这个接口时 {code: 500, msg: "No static resource …"}），
 * 所以 HTTP 200 但 code 不是 0 / 200 时也算失败。返回给用户看的错误，没有错误时返回 null。
 */
export const OLD_SERVER = '服务端版本较旧，还不支持这个功能：请管理员升级服务端（重新部署后端并执行数据库升级脚本）';

export function envelopeError(status: number, j: unknown): string | null {
  const o = j && typeof j === 'object' ? (j as { code?: unknown; message?: unknown; msg?: unknown }) : null;
  const msg = typeof o?.message === 'string' ? o.message : typeof o?.msg === 'string' ? o.msg : null;
  const code = typeof o?.code === 'number' ? o.code : null;
  const failed = status < 200 || status >= 300 || (code !== null && code !== 0 && code !== 200);
  if (!failed) return null;
  if (msg && /No static resource|No endpoint|No handler found|接口不存在/i.test(msg)) return OLD_SERVER;
  return msg ?? (status >= 200 && status < 300 ? `服务端返回错误（${code}）` : `服务端返回 ${status}`);
}
