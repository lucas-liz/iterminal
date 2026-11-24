import { Button, Dropdown, Tooltip } from 'antd';
import { CloudServerOutlined, CodeOutlined, PlusOutlined } from '@ant-design/icons';
import { isMac } from '../api';
import { openLocalShell } from '../actions';
import { useAgent } from '../store/agent';
import { useApp } from '../store/app';
import { useWorkspaceUi } from '../store/workspace';
import { useShortcutLabel } from '../util/shortcuts';
import { AppLogo } from './AppLogo';
import { ModeSwitch } from './ModeSwitch';

/** 侧栏图标：左边一栏的窗口（收起 / 展开侧栏） */
function SiderIcon(): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="sider-icon">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6 3v10" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * 侧栏标题行的图标：平时显示应用图标，鼠标移上去变成「收起侧栏」按钮（参考 Claude / ChatGPT），不占额外的宽度。
 */
export function BrandToggle(): React.JSX.Element {
  const key = useShortcutLabel('toggleSider');
  return (
    <Tooltip title={key ? `收起侧栏（${key}）` : '收起侧栏'} placement="bottom">
      <button type="button" className="brand-toggle no-drag" onClick={() => useApp.getState().toggleSider()} aria-label="收起侧栏" data-testid="sider-collapse">
        <span className="brand-toggle-logo">
          <AppLogo size={20} />
        </span>
        <span className="brand-toggle-icon">
          <SiderIcon />
        </span>
      </button>
    </Tooltip>
  );
}

/**
 * 侧栏收起后左上角的小工具条（终端模式和 AI 对话模式都有）：展开侧栏、模式切换、新增。
 * 新增：终端模式是新建终端（本地终端 / 连接主机），AI 对话模式是新对话。
 */
export function SiderMiniBar(): React.JSX.Element {
  const page = useApp((s) => s.page);
  const key = useShortcutLabel('toggleSider');
  const ai = page === 'ai';
  const newChat = (): void => {
    useApp.getState().setAiView('chat');
    void useAgent.getState().newConversation();
  };
  return (
    <div className={`sider-mini drag ${isMac ? 'mac' : ''}`} data-testid="sider-mini">
      <Tooltip title={key ? `展开侧栏（${key}）` : '展开侧栏'} placement="bottom">
        <Button size="small" type="text" className="sider-mini-btn no-drag" icon={<SiderIcon />} onClick={() => useApp.getState().toggleSider()} aria-label="展开侧栏" data-testid="sider-expand" />
      </Tooltip>
      <ModeSwitch />
      {ai ? (
        <Tooltip title="新对话" placement="bottom">
          <Button size="small" type="text" className="sider-mini-btn no-drag" icon={<PlusOutlined />} onClick={newChat} aria-label="新对话" data-testid="sider-mini-new" />
        </Tooltip>
      ) : (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'local', label: '本地终端', icon: <CodeOutlined /> },
              { key: 'host', label: '连接主机…', icon: <CloudServerOutlined /> },
            ],
            onClick: ({ key: k }) => (k === 'local' ? openLocalShell() : useWorkspaceUi.getState().requestConnect()),
          }}
        >
          <Tooltip title="新建终端" placement="bottom">
            <Button size="small" type="text" className="sider-mini-btn no-drag" icon={<PlusOutlined />} aria-label="新建终端" data-testid="sider-mini-new" />
          </Tooltip>
        </Dropdown>
      )}
    </div>
  );
}
