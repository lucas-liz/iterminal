import { Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { BulbFilled, BulbOutlined, CheckOutlined, DownOutlined, PictureOutlined } from '@ant-design/icons';
import { EFFORT_LABEL, effortFor, thinkingControlOf, type AiProvider, type Effort, type ModelRef, type ThinkingChoice } from '@itm/protocol';
import { effectiveThinking, modelConfig } from '../../store/agent';
import { thinkingKey } from '../../util/agent-view';

const FIVE: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SEP = '\u0000';

/** 服务商的小圆标：名称首字 + 按名称固定的颜色（没有厂商图标时用） */
export function ProviderGlyph({ name }: { name: string }): React.JSX.Element {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className="provider-glyph" style={{ background: `hsl(${h} 62% 52%)` }} aria-hidden>
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

/**
 * 输入框底栏的模型选择（第二十六轮，参考 NewMax）：一个按钮显示「模型名 思考强度」，
 * 点开是级联菜单——服务商 → 模型；下面「思考强度」→ 自动 / 关闭 / 各档位。替代原来的模型下拉框和深度思考开关。
 */
export function ModelPicker({
  providers,
  model,
  choice,
  onModel,
  onThinking,
  compact,
}: {
  providers: AiProvider[];
  model: ModelRef | null;
  choice: ThinkingChoice | undefined;
  onModel(m: ModelRef): void;
  /** null = 自动（跟随模型默认） */
  onThinking(c: ThinkingChoice | null): void;
  /** 终端页右侧的窄面板：模型名更短 */
  compact?: boolean;
}): React.JSX.Element {
  const enabled = providers.filter((p) => p.enabled && p.models.length > 0);
  const cfg = modelConfig(providers, model);
  const provider = providers.find((p) => p.id === model?.providerId) ?? null;
  const eff = effectiveThinking(choice, cfg);
  const toggleOnly = !!cfg && thinkingControlOf(cfg, provider?.thinkingStyle ?? null) === 'toggle';
  const efforts: readonly Effort[] = cfg?.efforts?.length ? cfg.efforts : /claude/i.test(cfg?.id ?? '') ? FIVE : ['low', 'medium', 'high'];
  const key = thinkingKey(choice);
  // 显示的档位和实际发送的一致（DeepSeek：中 → 高）
  const shownEffort = eff.enabled && eff.effort ? effortFor(eff.effort, { id: cfg?.id ?? '', efforts }) : null;
  // 「自动」（没在对话里选过）显示实际生效的档位：默认关闭（第三十一轮），按钮上就是「关闭」
  const thinkingLabel = eff.locked === 'off' ? null : !eff.enabled ? '关闭' : toggleOnly || !shownEffort ? (key === 'auto' ? '自动' : '思考') : EFFORT_LABEL[shownEffort];

  const levels: { key: string; label: string }[] =
    eff.locked === 'off'
      ? []
      : [
          { key: 'auto', label: '自动' },
          ...(eff.locked === 'on' ? [] : [{ key: 'off', label: '关闭' }]),
          ...(toggleOnly ? [{ key: 'on', label: '开启' }] : efforts.map((e) => ({ key: e, label: EFFORT_LABEL[e] }))),
        ];
  const check = (on: boolean): React.ReactNode => <CheckOutlined className={`mp-check ${on ? '' : 'off'}`} />;

  const items: MenuProps['items'] = [
    ...enabled.map((p) => ({
      key: `p:${p.id}`,
      popupClassName: 'model-picker-sub',
      label: (
        <span className="mp-row" data-testid="model-provider">
          {check(p.id === model?.providerId)}
          <span className="mp-name">{p.name}</span>
        </span>
      ),
      children: p.models.map((m) => ({
        key: `m:${p.id}${SEP}${m.id}`,
        label: (
          <span className="mp-row" data-testid="model-item" data-model={m.id}>
            {check(p.id === model?.providerId && m.id === model?.modelId)}
            <span className="mp-name">{m.displayName || m.id}</span>
            {m.reasoning && m.reasoning !== 'none' && <BulbOutlined className="mp-cap" title="支持深度思考" />}
            {m.supportsImages && <PictureOutlined className="mp-cap" title="支持图片" />}
          </span>
        ),
      })),
    })),
    { type: 'divider' as const },
    {
      key: 'thinking',
      disabled: eff.locked === 'off',
      popupClassName: 'model-picker-sub',
      label: (
        <span className="mp-row" data-testid="thinking-menu">
          <BulbOutlined className="mp-lead" />
          <span className="mp-name">思考强度</span>
          <span className="mp-extra">{eff.locked === 'off' ? '不支持' : thinkingLabel}</span>
        </span>
      ),
      children: levels.map((l) => ({
        key: `t:${l.key}`,
        label: (
          <span className="mp-row" data-testid="thinking-level" data-level={l.key}>
            {check(l.key === key || (l.key === 'on' && key !== 'auto' && key !== 'off'))}
            <span className="mp-name">{l.label}</span>
          </span>
        ),
      })),
    },
  ];

  const onClick: MenuProps['onClick'] = ({ key: k }) => {
    if (k.startsWith('m:')) {
      const [providerId, modelId] = k.slice(2).split(SEP);
      onModel({ providerId, modelId });
    } else if (k.startsWith('t:')) {
      const level = k.slice(2);
      if (level === 'auto') onThinking(null);
      else if (level === 'off') onThinking({ enabled: false, effort: choice?.effort ?? null });
      else if (level === 'on') onThinking({ enabled: true, effort: null });
      else onThinking({ enabled: true, effort: level as Effort });
    }
  };

  const name = cfg ? cfg.displayName || cfg.id : '选择模型';
  return (
    <Dropdown trigger={['click']} placement="topRight" menu={{ items, onClick, selectable: false, triggerSubMenuAction: 'hover' }} overlayClassName="model-picker-menu">
        <button
          type="button"
          className={`model-picker ${compact ? 'compact' : ''} ${eff.enabled ? 'thinking-on' : ''}`}
          data-testid="agent-model"
          data-thinking-on={eff.enabled ? '1' : '0'}
          data-thinking={key}
        >
          {provider && <ProviderGlyph name={provider.name} />}
          <span className="model-picker-name">{name}</span>
          {/* 窄面板里放不下文字：思考开着时只显示一个灯泡，档位在悬停提示和菜单里 */}
          {thinkingLabel && (compact ? eff.enabled && <BulbFilled className="model-picker-thinking" /> : <span className="model-picker-thinking">{thinkingLabel}</span>)}
          <DownOutlined className="model-picker-caret" />
        </button>
    </Dropdown>
  );
}
