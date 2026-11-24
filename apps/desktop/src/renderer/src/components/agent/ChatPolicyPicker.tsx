import { useState } from 'react';
import { Popover, Tooltip } from 'antd';
import { CheckOutlined, DownOutlined, MessageOutlined, RobotOutlined } from '@ant-design/icons';
import { CHAT_POLICY_OPTIONS, chatAgentPolicy, type AgentMode, type ChatPolicy } from '@itm/protocol';
import { AgentPolicyMenu } from '../AgentPolicyMenu';

const FOLLOW = CHAT_POLICY_OPTIONS[0];

const MODES: { value: AgentMode; label: string; desc: string; icon: React.ReactNode }[] = [
  { value: 'agent', label: 'Agent', desc: '可以在引用的主机上执行命令，按下面的权限请你批准', icon: <RobotOutlined /> },
  { value: 'ask', label: 'Ask', desc: '只回答和给建议，不执行命令', icon: <MessageOutlined /> },
];

/**
 * 输入框底栏的「模式 + 权限」（第二十六轮：Agent / Ask 和这个对话的 Agent 权限合成一个按钮）。
 * 按钮显示「Agent · 跟随分组」或「Ask」，颜色跟着权限走（只读灰、自动蓝、完全允许红）；
 * 点开先选模式，选 Agent 时下面接着选权限（菜单和设置、分组、主机里的一样，AgentPolicyMenu）。
 * 权限只对当前对话生效，重启后回到跟随分组。
 */
export function ChatPolicyPicker({ mode, onMode, value, onChange }: { mode: AgentMode; onMode(m: AgentMode): void; value: ChatPolicy; onChange(p: ChatPolicy): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const cur = CHAT_POLICY_OPTIONS.find((o) => o.value === value.mode) ?? FOLLOW;
  const agent = mode === 'agent';
  const tip = agent
    ? `Agent 权限：${cur.label}——${cur.description}${value.mode === 'AUTO' ? (value.confirmHighRisk ? '（高危命令需要二次确认）' : '（高危命令也直接执行）') : ''}`
    : 'Ask：只回答和给建议，不执行命令';
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      arrow={false}
      overlayClassName="refs-popover chat-policy-popover"
      content={
        <div className="chat-policy" data-testid="chat-policy-panel">
          <div className="chat-policy-head">模式</div>
          {MODES.map((m) => (
            <div
              key={m.value}
              role="radio"
              aria-checked={mode === m.value}
              className={`chat-policy-item ${mode === m.value ? 'on' : ''}`}
              onClick={() => {
                onMode(m.value);
                // 选 Ask 就关掉；选 Agent 留着接着选权限
                if (m.value === 'ask') setOpen(false);
              }}
              data-testid={`agent-mode-${m.value}`}
            >
              <span className="chat-policy-check">{mode === m.value ? <CheckOutlined /> : null}</span>
              <span className="chat-policy-text">
                <span className="chat-policy-label">
                  {m.icon} {m.label}
                </span>
                <span className="chat-policy-desc">{m.desc}</span>
              </span>
            </div>
          ))}
          {agent ? (
            <>
              <div className="chat-policy-head chat-policy-sep">这个对话里 Agent 的权限</div>
              <AgentPolicyMenu
                value={chatAgentPolicy(value) ?? ''}
                inherit={FOLLOW}
                testId="chat-policy"
                onChange={(v, close) => {
                  onChange(v === '' ? { ...value, mode: 'FOLLOW' } : v === 'AUTO_ALL' ? { mode: 'AUTO', confirmHighRisk: false } : v === 'AUTO' ? { mode: 'AUTO', confirmHighRisk: true } : { ...value, mode: v as ChatPolicy['mode'] });
                  if (close) setOpen(false);
                }}
              />
              <div className="chat-policy-foot">黑名单、夜间窗口、生产环境分组等限制照常生效；团队主机只能收紧。重启后回到「跟随分组」。</div>
            </>
          ) : (
            <div className="chat-policy-foot">Ask 模式不执行命令，权限不起作用。</div>
          )}
        </div>
      }
    >
      <Tooltip title={tip} placement="top" open={open ? false : undefined}>
        <button
          type="button"
          className={`chat-policy-btn mode-btn ${agent && value.mode !== 'FOLLOW' ? 'set' : ''} mode-${agent ? value.mode : 'ASK'}`}
          data-testid="agent-mode"
          data-mode={mode}
          aria-label={tip}
        >
          {agent ? <RobotOutlined className="mode-btn-icon" /> : <MessageOutlined className="mode-btn-icon" />}
          <span className="mode-btn-name">{agent ? 'Agent' : 'Ask'}</span>
          {agent && (
            <span className="mode-btn-policy" data-testid="chat-policy">
              <span className="mode-btn-dot">·</span>
              {cur.label}
            </span>
          )}
          <DownOutlined className="chat-policy-arrow" />
        </button>
      </Tooltip>
    </Popover>
  );
}
