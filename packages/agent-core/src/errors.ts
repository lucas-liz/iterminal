/**
 * 可以直接展示给用户的错误（API Key 无效、模型不存在等）。name 固定为 UserError：
 * 跨进程（utility process → 主进程）传递时按名称识别，主进程的 IPC 路由据此只展示消息本身。
 */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}
