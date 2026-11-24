import { useState } from 'react';
import { Checkbox, Select } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import { AGENT_POLICY_CHOICES, agentPolicyLabel, type AgentPolicy } from '@itm/protocol';

/** '' = 继承（分组 / 主机 / 数据库）或跟随（对话） */
export type AgentPolicyValue = AgentPolicy | '';

/** 继承选项：只有分组、主机、数据库、对话里有，设置里的默认权限没有 */
export interface InheritOption {
  label: string;
  description: string;
}

/**
 * 统一的 Agent 权限菜单：设置里的默认权限、分组、主机、数据库和对话输入框底栏都用它。
 * 三档：只读（灰）/ 自动（蓝，AI 审核）/ 完全允许（红；下面的「高危命令需要二次确认」默认勾选，取消 = AUTO_ALL）；
 * 分组和主机多一个继承选项。旧版本的「禁止 / 只读」只在当前值是它们时显示出来，方便看到并改掉。
 * onChange 的 close 表示选完可以关闭菜单（选「完全允许」时留着，方便勾选下面的选项）。
 */
export function AgentPolicyMenu({ value, onChange, inherit, testId }: { value: AgentPolicyValue; onChange(v: AgentPolicyValue, close: boolean): void; inherit?: InheritOption; testId: string }): React.JSX.Element {
  const auto = value === 'AUTO' || value === 'AUTO_ALL';
  const legacy = value === 'DENY' || value === 'READONLY' ? value : null;
  const item = (key: string, on: boolean, label: string, description: string, pick: () => void, extra?: React.ReactNode): React.JSX.Element => (
    <div key={key} role="menuitemradio" aria-checked={on} className={`chat-policy-item ${on ? 'on' : ''}`} onClick={pick} data-testid={`${testId}-${key}`}>
      <span className="chat-policy-check">{on && <CheckOutlined />}</span>
      <span className="chat-policy-text">
        <span className={`chat-policy-label policy-text p-${key}`}>
          <span className={`policy-dot p-${key}`} />
          {label}
        </span>
        <span className="chat-policy-desc">{description}</span>
        {extra}
      </span>
    </div>
  );
  return (
    <>
      {inherit && item('FOLLOW', value === '', inherit.label, inherit.description, () => onChange('', true))}
      {AGENT_POLICY_CHOICES.map((o) =>
        o.value === 'AUTO'
          ? item(
              o.value,
              auto,
              o.label,
              o.description,
              () => !auto && onChange('AUTO', false),
              <Checkbox
                className="chat-policy-sub"
                checked={value !== 'AUTO_ALL'}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChange(e.target.checked ? 'AUTO' : 'AUTO_ALL', false)}
                data-testid={`${testId}-confirm`}
              >
                高危命令需要二次确认（输入主机名）
              </Checkbox>,
            )
          : item(o.value, value === o.value, o.label, o.description, () => onChange(o.value, true)),
      )}
      {legacy && item(legacy, true, `${agentPolicyLabel(legacy)}（旧版本的选项）`, '现在只保留上面三档，请改成其中一个', () => undefined)}
    </>
  );
}

/**
 * 表单里的 Agent 权限（设置、分组、主机、数据库）：下拉框，展开后是和对话里一样的菜单。
 * 可以直接放在 Form.Item 里（value / onChange 由表单传入，继承为 ''）
 */
export function AgentPolicySelect({
  value,
  onChange,
  inherit,
  testId,
  style,
}: {
  value?: AgentPolicyValue | null;
  onChange?(v: AgentPolicyValue): void;
  inherit?: InheritOption;
  testId: string;
  style?: React.CSSProperties;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const v: AgentPolicyValue = value ?? '';
  const key = v === '' ? 'FOLLOW' : v;
  const label = (
    <span className={`policy-text p-${key}`}>
      <span className={`policy-dot p-${key}`} />
      {v === '' ? (inherit?.label ?? '') : agentPolicyLabel(v)}
    </span>
  );
  return (
    <Select
      open={open}
      onOpenChange={setOpen}
      value={v}
      options={[{ value: v, label }]}
      style={style}
      popupMatchSelectWidth={false}
      classNames={{ popup: { root: 'agent-policy-popup' } }}
      popupRender={() => (
        // 按下时不让下拉框失去焦点（否则点菜单里的勾选框会先关掉菜单）
        <div className="chat-policy agent-policy-menu" onMouseDown={(e) => e.preventDefault()} data-testid={`${testId}-menu`}>
          <AgentPolicyMenu
            value={v}
            inherit={inherit}
            testId={testId}
            onChange={(next, close) => {
              if (next !== v) onChange?.(next);
              if (close) setOpen(false);
            }}
          />
        </div>
      )}
      data-testid={testId}
    />
  );
}
