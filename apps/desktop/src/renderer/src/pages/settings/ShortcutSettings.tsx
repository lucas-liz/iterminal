import { useEffect, useState } from 'react';
import { App, Button, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { EditOutlined, StopOutlined, UndoOutlined } from '@ant-design/icons';
import { SHORTCUTS, type ShortcutId, type ShortcutMap } from '@itm/protocol';
import { errorMessage } from '../../api';
import { useApp } from '../../store/app';
import { conflictsOf, defaultShortcut, eventCombo, formatCombo } from '../../util/shortcuts';
import { SettingGroup, SettingRow, SettingsSection } from './parts';

/** 录制组合键：按下要用的组合键；Esc 取消，Backspace / Delete 清除（不使用） */
function Recorder({ onDone, onCancel }: { onDone(combo: string): void; onCancel(): void }): React.JSX.Element {
  const [hint, setHint] = useState('请按下组合键…');
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return onCancel();
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) return onDone('');
      const combo = eventCombo(e);
      if (!combo) return;
      const fn = /^F([1-9]|1[0-9]|2[0-4])$/.test(combo);
      if (!combo.includes('+') && !fn) {
        setHint('需要加上 ⌘ / Ctrl / Alt / Shift 等修饰键');
        return;
      }
      onDone(combo);
    };
    // 捕获阶段：录制时不触发其他快捷键
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <Tag color="processing" className="shortcut-recording" data-testid="shortcut-recording">
      {hint}（Esc 取消，Backspace 清除）
    </Tag>
  );
}

/** 「设置 → 快捷键」：默认就是原来的快捷键，可以逐个修改、清除、恢复默认 */
export function ShortcutSettings(): React.JSX.Element {
  const { message } = App.useApp();
  const custom = useApp((s) => s.settings['ui.shortcuts']);
  const update = useApp((s) => s.updateSetting);
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))];

  const save = (next: ShortcutMap): void => {
    update('ui.shortcuts', next).catch((e) => message.error(errorMessage(e)));
  };
  const set = (id: ShortcutId, combo: string): void => {
    setRecording(null);
    const next = { ...custom };
    if (combo === defaultShortcut(id)) delete next[id];
    else next[id] = combo;
    save(next);
    const dup = conflictsOf(id, combo);
    if (dup.length) message.warning(`和「${dup.map((d) => SHORTCUTS.find((s) => s.id === d)!.label).join('、')}」用了同一个组合键，只有其中一个会生效`);
  };

  return (
    <SettingsSection
      title="快捷键"
      description="点「修改」后按下新的组合键。⌘ / Ctrl 写作 Mod：macOS 上是 ⌘，Windows / Linux 上是 Ctrl。"
      extra={
        <Popconfirm title="所有快捷键恢复默认？" okText="恢复" cancelText="取消" onConfirm={() => save({})}>
          <Button icon={<UndoOutlined />} disabled={!Object.keys(custom ?? {}).length} data-testid="shortcut-reset-all">
            全部恢复默认
          </Button>
        </Popconfirm>
      }
    >
      {groups.map((g) => (
        <SettingGroup key={g} title={g}>
          {SHORTCUTS.filter((s) => s.group === g).map((s) => {
            const combo = custom?.[s.id] ?? defaultShortcut(s.id);
            const changed = custom?.[s.id] !== undefined;
            const dup = conflictsOf(s.id, combo);
            return (
              <SettingRow
                key={s.id}
                label={s.label}
                description={
                  <>
                    {s.description}
                    {dup.length > 0 && <Typography.Text type="warning">{`${s.description ? '；' : ''}和「${dup.map((d) => SHORTCUTS.find((x) => x.id === d)!.label).join('、')}」冲突`}</Typography.Text>}
                  </>
                }
                testId={`shortcut-${s.id}`}
              >
                <Space size={6}>
                  {recording === s.id ? (
                    <Recorder onDone={(c) => set(s.id, c)} onCancel={() => setRecording(null)} />
                  ) : combo ? (
                    <kbd className="shortcut-kbd" data-testid={`shortcut-value-${s.id}`}>
                      {formatCombo(combo)}
                    </kbd>
                  ) : (
                    <Typography.Text type="secondary" data-testid={`shortcut-value-${s.id}`}>
                      未设置
                    </Typography.Text>
                  )}
                  <Tooltip title="修改">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setRecording(s.id)} data-testid={`shortcut-edit-${s.id}`} />
                  </Tooltip>
                  <Tooltip title="不使用">
                    <Button size="small" type="text" icon={<StopOutlined />} disabled={!combo} onClick={() => set(s.id, '')} />
                  </Tooltip>
                  <Tooltip title={`恢复默认（${formatCombo(defaultShortcut(s.id)) || '未设置'}）`}>
                    <Button size="small" type="text" icon={<UndoOutlined />} disabled={!changed} onClick={() => set(s.id, defaultShortcut(s.id))} data-testid={`shortcut-default-${s.id}`} />
                  </Tooltip>
                </Space>
              </SettingRow>
            );
          })}
        </SettingGroup>
      ))}
    </SettingsSection>
  );
}
