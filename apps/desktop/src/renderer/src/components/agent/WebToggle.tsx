import { Button, Tooltip } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { effectiveWeb, useAgentStore } from '../../store/agent';
import { useApp } from '../../store/app';

/**
 * 输入框底部的「联网」开关（第二十四轮，文档一 6.38）：按会话记住；打开后 Agent 可以用 web_search / web_fetch 搜索和读取公开网页。
 * 搜索服务不能用（服务端没配置、自己没填 Key）时置灰，提示去哪里配置。
 */
export function WebToggle({ conversationId, compact }: { conversationId: string | null; compact?: boolean }): React.JSX.Element {
  const useA = useAgentStore();
  // 订阅开关、状态和设置：变化时重新计算
  useA((s) => (conversationId ? s.web[conversationId] : undefined));
  useA((s) => s.webStatus);
  useApp((s) => s.settings['ai.webSearch']);
  const setWeb = useA((s) => s.setWeb);
  const w = effectiveWeb(conversationId, useA);
  const tip = !w.available
    ? w.reason
    : w.on
      ? `联网已打开：AI 可以搜索和读取公开网页（用「${w.label}」搜索，按次计费；查询词会先脱敏）。点击关闭`
      : `联网已关闭（点击打开，用「${w.label}」搜索）`;
  return (
    <div className={`thinking-toggle web-toggle ${w.on ? 'on' : ''}`} data-testid="web-toggle" data-on={w.on ? '1' : '0'}>
      <Tooltip title={tip}>
        <Button
          size="small"
          type="text"
          icon={<GlobalOutlined />}
          disabled={!w.available || !conversationId}
          onClick={() => conversationId && setWeb(conversationId, !w.on)}
          data-testid="web-switch"
          aria-label="联网"
        >
          {compact ? null : '联网'}
        </Button>
      </Tooltip>
    </div>
  );
}
