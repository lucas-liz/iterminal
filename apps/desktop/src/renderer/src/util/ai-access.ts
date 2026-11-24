import { useAccount } from '../store/account';
import { useApp } from '../store/app';

/**
 * 本地模式（Guest，无需配置后台）默认允许直接配置个人 API Key 或连接本机 Ollama 使用全部 AI 功能；
 * 仅当主进程显式下发 aiLocal === false（如 ITM_ALLOW_LOCAL_AI=0）且未登录时才拦截。
 */
export function aiAllowed(): boolean {
  const st = useAccount.getState().state;
  return (!!st && st.status !== 'none') || (useApp.getState().info?.aiLocal ?? true);
}

export function useAiAllowed(): boolean {
  const account = useAccount((s) => !!s.state && s.state.status !== 'none');
  const local = useApp((s) => s.info?.aiLocal ?? true);
  return account || local;
}

/** 本地模式下点了 AI 相关的入口：打开登录框 */
export function promptLogin(reason = '登录后才能使用 AI 功能'): void {
  useAccount.getState().openLogin({ reason });
}
