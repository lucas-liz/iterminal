import { Tooltip } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useAiAllowed } from '../util/ai-access';
import { useAgent } from '../store/agent';
import { useApp } from '../store/app';
import { useShortcutLabel } from '../util/shortcuts';
import { AiIcon, TerminalIcon } from './RailIcons';

/**
 * 终端 / AI 对话模式切换：两个图标的胶囊开关；
 * 切换模式时同步更新最左侧导航栏的第一个图标（终端 <-> AI 对话）及是否展示主机列表。
 */
export function ModeSwitch(): React.JSX.Element {
  const mode = useApp((s) => s.mode);
  const waiting = useAgent((s) => !!s.current?.messages.some((m) => m.role === 'assistant' && m.steps.some((st) => st.status === 'approval')));
  const key = useShortcutLabel('toggleMode');
  const aiAllowed = useAiAllowed();
  return (
    <div className="mode-switch no-drag" role="tablist" aria-label="终端 / AI 对话">
      <Tooltip title={key ? `终端模式（${key} 切换）` : '终端模式'} placement="bottom">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'terminal'}
          className={mode === 'terminal' ? 'on' : ''}
          onClick={() => useApp.getState().setMode('terminal')}
          data-testid="mode-terminal"
        >
          <TerminalIcon size={14} />
        </button>
      </Tooltip>
      <Tooltip title={!aiAllowed ? 'AI 对话模式：登录后可用' : waiting ? 'AI 对话：有命令在等你批准' : key ? `AI 对话模式（${key} 切换）` : 'AI 对话模式'} placement="bottom">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'ai'}
          className={`${mode === 'ai' ? 'on' : ''} ${aiAllowed ? '' : 'locked'}`}
          onClick={() => useApp.getState().setMode('ai')}
          data-testid="mode-ai"
        >
          {aiAllowed ? <AiIcon size={14} /> : <LockOutlined />}
          {waiting && <span className="mode-dot" data-testid="nav-ai-dot" />}
        </button>
      </Tooltip>
    </div>
  );
}
