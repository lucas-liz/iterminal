import { useEffect } from 'react';
import { showConversation } from '../util/navigate';
import { App, Button } from 'antd';

/**
 * 需要用户注意的 AI 对话（外部 Agent 通过 MCP 请求执行写操作、运行 Skill）：右上角提示，点「查看」打开对应的对话。
 */
export function AttentionWatcher(): null {
  const { notification } = App.useApp();
  useEffect(
    () =>
      window.itm.on('agent.attention', (e) => {
        const key = `attention-${e.conversationId}`;
        notification.warning({
          key,
          message: e.title,
          description: e.text,
          duration: 0,
          actions: e.conversationId ? (
            <Button
              size="small"
              type="primary"
              data-testid="attention-open"
              onClick={() => {
                notification.destroy(key);
                void showConversation(e.conversationId);
              }}
            >
              查看
            </Button>
          ) : undefined,
        });
      }),
    [],
  );
  return null;
}
