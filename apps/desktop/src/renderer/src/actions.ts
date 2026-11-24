import type { Host } from '@itm/protocol';
import { useApp } from './store/app';
import { useTabs } from './store/tabs';
import { useAgent } from './store/agent';
import { useWorkspaceUi } from './store/workspace';
import { aiAllowed, promptLogin } from './util/ai-access';

/** 打开主机的终端（SSH / Telnet / 串口，按主机协议）或 SFTP 标签页，并切到「终端」页 */
export function openHost(host: Host, kind: 'ssh' | 'sftp'): void {
  const term = host.protocol === 'TELNET' ? 'telnet' : host.protocol === 'SERIAL' ? 'serial' : 'ssh';
  useTabs.getState().open({ kind: kind === 'sftp' ? 'sftp' : term, title: kind === 'sftp' ? `SFTP · ${host.name}` : host.name, hostId: host.id });
  useApp.getState().setPage('workspace');
}

export function openLocalShell(): void {
  useTabs.getState().open({ kind: 'local', title: '本地终端' });
  useApp.getState().setPage('workspace');
}

/**
 * 在 AI 对话里引用主机（第三十轮：监控卡片、主机列表的右键菜单）。quote 有内容时同时放进输入框，由用户补充问题后再发送。
 * 有已连接的终端时到终端页右侧的 AI 面板；没有终端时右侧面板不显示，改为切到 AI 对话模式。
 */
export function referHostsInAi(hosts: Host[], quote?: string): void {
  if (!aiAllowed()) return promptLogin();
  const agent = useAgent.getState();
  hosts.forEach((h) => agent.toggleHost(h.id, true));
  if (quote?.trim()) agent.quote(quote);
  const app = useApp.getState();
  const connected = useTabs.getState().tabs.some((t) => t.kind !== 'sftp' && t.status === 'ready');
  if (app.page === 'ai' || !connected) {
    app.setPage('ai');
    app.setAiView('chat');
    return;
  }
  useWorkspaceUi.getState().focusAi();
  app.setPage('workspace');
}
