import { useAgent } from '../store/agent';
import { useApp } from '../store/app';
import { useTabs } from '../store/tabs';
import { useWorkspaceUi } from '../store/workspace';

/**
 * 打开一个 AI 对话给用户看：有已连接的终端时在终端页右侧的 AI 面板里打开；
 * 没有时右侧面板不显示（第五轮），改用整页的 AI 对话模式。
 */
export async function showConversation(id: string): Promise<void> {
  await useAgent.getState().refreshList();
  await useAgent.getState().open(id);
  const connected = useTabs.getState().tabs.some((t) => t.kind !== 'sftp' && t.status === 'ready');
  if (connected) {
    useWorkspaceUi.getState().openRight('ai');
    useApp.getState().setPage('workspace');
  } else {
    useApp.getState().setPage('ai');
  }
}
