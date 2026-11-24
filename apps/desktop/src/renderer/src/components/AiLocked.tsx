import { Button } from 'antd';
import { LockOutlined, LoginOutlined } from '@ant-design/icons';
import { promptLogin } from '../util/ai-access';

/**
 * 本地模式（Guest）不能使用 AI（第十二轮）：AI 面板、AI 对话页、AI 设置的位置显示这张卡片，点「登录」打开登录框。
 */
export function AiLocked({ title = '登录后使用 AI', compact = false }: { title?: string; compact?: boolean }): React.JSX.Element {
  return (
    <div className={`ai-locked ${compact ? 'compact' : ''}`} data-testid="ai-locked">
      <span className="ai-locked-icon">
        <LockOutlined />
      </span>
      <div className="ai-locked-title">{title}</div>
      <div className="ai-locked-desc">当前是离线使用（Guest）。AI 对话、Skill、AI 补全和 AI 相关的设置只对登录用户开放，登录 iTerminal 账号后即可使用。</div>
      <Button type="primary" icon={<LoginOutlined />} onClick={() => promptLogin()} data-testid="ai-locked-login">
        登录
      </Button>
    </div>
  );
}
