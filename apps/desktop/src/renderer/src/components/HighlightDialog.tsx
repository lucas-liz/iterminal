import { useMemo, useState } from 'react';
import { App, Button, Checkbox, ColorPicker, Empty, Input, Modal, Popconfirm, Switch, Tabs, Tooltip, Typography } from 'antd';
import {
  CalendarOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  FileTextOutlined,
  GlobalOutlined,
  HighlightOutlined,
  LinkOutlined,
  MailOutlined,
  NumberOutlined,
  PlusOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { create } from 'zustand';
import { checkHighlightPattern, HIGHLIGHT_COLORS, HIGHLIGHT_PRESETS, RAINBOW_COLORS, type HighlightIcon, type HighlightRule, type HighlightSettings } from '@itm/protocol';
import { errorMessage } from '../api';
import { useApp } from '../store/app';
import { compileHighlight, Highlighter } from '../util/highlight';

export const useHighlightDialog = create<{ open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

const ICON: Record<HighlightIcon, React.ReactNode> = {
  link: <LinkOutlined />,
  globe: <GlobalOutlined />,
  mail: <MailOutlined />,
  calendar: <CalendarOutlined />,
  clock: <ClockCircleOutlined />,
  hash: <NumberOutlined />,
  alert: <ExclamationCircleOutlined />,
  file: <FileTextOutlined />,
  table: <TableOutlined />,
};

const SAMPLE = 'ERROR 2026-10-15 09:30:12 connect 10.0.8.91:22 failed, see https://example.com/doc (retry [1/3]) /var/log/app.log 512MB';

/** 预览：用同一个高亮引擎处理，再把颜色转换成 span */
function Preview({ text, settings }: { text: string; settings: HighlightSettings }): React.JSX.Element {
  const parts = useMemo(() => {
    const hl = new Highlighter();
    hl.configure(compileHighlight({ ...settings, enabled: true }));
    const out = hl.process(text);
    const list: { text: string; color?: string }[] = [];
    let pos = 0;
    for (const m of out.matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m([\s\S]*?)\x1b\[39m/g)) {
      if (m.index > pos) list.push({ text: out.slice(pos, m.index) });
      list.push({ text: m[4], color: `rgb(${m[1]}, ${m[2]}, ${m[3]})` });
      pos = m.index + m[0].length;
    }
    if (pos < out.length) list.push({ text: out.slice(pos) });
    return list;
  }, [text, settings]);
  return (
    <div className="hl-preview mono" data-testid="hl-preview">
      {parts.map((p, i) => (
        <span key={i} style={p.color ? { color: p.color } : undefined}>
          {p.text}
        </span>
      ))}
    </div>
  );
}

/**
 * 终端高亮设置（参考 iShell）：预设规则逐条开关、彩虹括号；自定义规则（名称、颜色、正则）。改动立即生效。
 */
export function HighlightDialog(): React.JSX.Element {
  const open = useHighlightDialog((s) => s.open);
  const hide = useHighlightDialog((s) => s.hide);
  const settings = useApp((s) => s.settings['terminal.highlight']);
  const { message } = App.useApp();
  const [tab, setTab] = useState('presets');

  const save = (next: HighlightSettings): void => {
    useApp
      .getState()
      .updateSetting('terminal.highlight', next)
      .catch((e) => message.error(errorMessage(e)));
  };
  const presetOn = (id: string, def: boolean): boolean => settings.presets[id] ?? def;
  const enabledCount = HIGHLIGHT_PRESETS.filter((p) => presetOn(p.id, p.defaultOn)).length + settings.custom.filter((r) => r.enabled).length + (settings.rainbow ? 1 : 0);

  return (
    <Modal
      open={open}
      onCancel={hide}
      width={680}
      centered
      destroyOnHidden
      className="hl-modal"
      title={
        <span className="hl-title">
          <HighlightOutlined />
          高亮设置
          <span className="hl-badge" data-testid="hl-count">
            {settings.enabled ? `${enabledCount} 已启用` : '已关闭'}
          </span>
          <Tooltip title={settings.enabled ? '关闭所有高亮' : '打开高亮'}>
            <Switch size="small" checked={settings.enabled} onChange={(v) => save({ ...settings, enabled: v })} style={{ marginLeft: 'auto', marginRight: 36 }} data-testid="hl-master" />
          </Tooltip>
        </span>
      }
      footer={
        <div className="hl-footer">
          <Typography.Text type="secondary">高亮规则应用于终端输出；程序自己上色的文字和全屏程序（vim、top）不受影响</Typography.Text>
          <Button type="primary" onClick={hide} data-testid="hl-done">
            完成
          </Button>
        </div>
      }
      styles={{ body: { padding: 0 } }}
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        centered
        className="hl-tabs"
        items={[
          {
            key: 'presets',
            label: (
              <span>
                预设规则 <Typography.Text type="secondary">({HIGHLIGHT_PRESETS.length})</Typography.Text>
              </span>
            ),
            children: (
              <div className={`hl-list ${settings.enabled ? '' : 'off'}`}>
                {HIGHLIGHT_PRESETS.map((p) => (
                  <div key={p.id} className="hl-row" data-testid={`hl-preset-${p.id}`}>
                    <span className="hl-dot" style={{ background: p.color }} />
                    <span className="hl-icon">{ICON[p.icon]}</span>
                    <div className="hl-main">
                      <div className="hl-name">{p.name}</div>
                      <div className="hl-pattern mono" title={p.pattern}>
                        {p.pattern}
                      </div>
                    </div>
                    <Switch size="small" checked={presetOn(p.id, p.defaultOn)} onChange={(v) => save({ ...settings, presets: { ...settings.presets, [p.id]: v } })} />
                  </div>
                ))}
                <div className="hl-row hl-rainbow" data-testid="hl-rainbow">
                  <span className="hl-rainbow-dots">
                    {RAINBOW_COLORS.map((c) => (
                      <i key={c} style={{ background: c }} />
                    ))}
                  </span>
                  <div className="hl-main">
                    <div className="hl-name">彩虹括号</div>
                    <div className="hl-pattern">对嵌套的括号 ( ) [ ] {'{ }'} 按层级着色</div>
                  </div>
                  <Switch size="small" checked={settings.rainbow} onChange={(v) => save({ ...settings, rainbow: v })} data-testid="hl-rainbow-switch" />
                </div>
              </div>
            ),
          },
          {
            key: 'custom',
            label: (
              <span>
                自定义 {settings.custom.length > 0 && <Typography.Text type="secondary">({settings.custom.length})</Typography.Text>}
              </span>
            ),
            children: <CustomRules settings={settings} save={save} />,
          },
        ]}
      />
      <div className="hl-preview-wrap">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          效果预览
        </Typography.Text>
        <Preview text={SAMPLE} settings={settings} />
      </div>
    </Modal>
  );
}

function CustomRules({ settings, save }: { settings: HighlightSettings; save(s: HighlightSettings): void }): React.JSX.Element {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [color, setColor] = useState(HIGHLIGHT_COLORS[0]);
  const [ignoreCase, setIgnoreCase] = useState(true);
  const [test, setTest] = useState('');
  const error = pattern ? checkHighlightPattern(pattern, ignoreCase) : null;

  const add = (): void => {
    if (error || !pattern.trim()) return;
    const rule: HighlightRule = { id: `c${Date.now().toString(36)}`, name: name.trim() || pattern.slice(0, 24), pattern, color, ignoreCase, enabled: true };
    save({ ...settings, custom: [...settings.custom, rule] });
    setName('');
    setPattern('');
  };
  const update = (id: string, patch: Partial<HighlightRule>): void => save({ ...settings, custom: settings.custom.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

  const draft = useMemo<HighlightSettings>(
    () => ({ enabled: true, presets: Object.fromEntries(HIGHLIGHT_PRESETS.map((p) => [p.id, false])), rainbow: false, custom: !error && pattern ? [{ id: 'draft', name, pattern, color, ignoreCase, enabled: true }] : [] }),
    [error, pattern, name, color, ignoreCase],
  );

  return (
    <div className="hl-custom">
      <div className="hl-add">
        <div className="hl-add-title">添加新规则</div>
        <div className="hl-add-top">
          <Input placeholder="规则名称，例如：订单号" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="hl-name" />
          <div className="hl-colors" role="radiogroup" aria-label="颜色">
            {HIGHLIGHT_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={c === color} className={`hl-swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />
            ))}
            <ColorPicker size="small" value={color} disabledAlpha onChangeComplete={(c) => setColor(c.toHexString())} />
          </div>
        </div>
        <Input.TextArea
          placeholder="正则表达式，例如：error|failed|warning"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          autoSize={{ minRows: 2, maxRows: 4 }}
          className="mono"
          status={error ? 'error' : undefined}
          data-testid="hl-pattern"
        />
        {error && (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {error}
          </Typography.Text>
        )}
        <div className="hl-add-row">
          <Checkbox checked={ignoreCase} onChange={(e) => setIgnoreCase(e.target.checked)}>
            忽略大小写
          </Checkbox>
          <Input size="small" placeholder="输入一段文字测试匹配效果" value={test} onChange={(e) => setTest(e.target.value)} style={{ flex: 1 }} />
        </div>
        {test && <Preview text={test} settings={draft} />}
        <Button type="primary" block icon={<PlusOutlined />} disabled={!pattern.trim() || !!error} onClick={add} data-testid="hl-add">
          添加
        </Button>
      </div>
      {settings.custom.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无自定义规则，在上方添加" />
      ) : (
        <div className="hl-list">
          {settings.custom.map((r) => (
            <div key={r.id} className="hl-row" data-testid="hl-custom-row">
              <span className="hl-dot" style={{ background: r.color }} />
              <div className="hl-main">
                <div className="hl-name">{r.name}</div>
                <div className="hl-pattern mono" title={r.pattern}>
                  {r.pattern}
                  {r.ignoreCase && <span className="hl-flag">忽略大小写</span>}
                </div>
              </div>
              <Popconfirm title={`删除规则「${r.name}」？`} okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => save({ ...settings, custom: settings.custom.filter((x) => x.id !== r.id) })}>
                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除规则" />
              </Popconfirm>
              <Switch size="small" checked={r.enabled} onChange={(v) => update(r.id, { enabled: v })} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
