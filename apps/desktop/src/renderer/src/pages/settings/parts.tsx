import { createContext, useContext } from 'react';
import { Tooltip } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';

/**
 * 设置页的版式：每个模块一页（SettingsSection），页内按主题分组（SettingGroup，圆角卡片），
 * 组内每一项一行（SettingRow：左边名称和说明，右边控件），行与行之间有分隔线。
 *
 * 第二十六轮：页面标题由设置页顶部统一显示；说明文字精简——短说明直接显示在名称下面，
 * 长说明收进名称旁边的「?」，悬停查看（AI 模型页保持完整说明）。
 */
export const SettingsDescMode = createContext<'compact' | 'full'>('compact');

/** 超过这个长度的说明收进「?」 */
const SHORT_DESC = 34;

export function SettingsSection({ description, extra, children }: { title: string; description?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const mode = useContext(SettingsDescMode);
  const desc = mode === 'full' ? description : null;
  return (
    <div className="settings-section">
      {(desc || extra) && (
        <div className="settings-section-head">
          <div style={{ minWidth: 0, flex: 1 }}>{desc && <div className="settings-section-desc">{desc}</div>}</div>
          {extra && <div className="settings-section-extra">{extra}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function SettingGroup({ title, extra, children, flush }: { title?: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode; flush?: boolean }): React.JSX.Element {
  return (
    <div className="setting-group">
      {(title || extra) && (
        <div className="setting-group-head">
          <span className="setting-group-title">{title}</span>
          {extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
        </div>
      )}
      <div className={`setting-group-body ${flush ? 'flush' : ''}`}>{children}</div>
    </div>
  );
}

export function SettingRow({ label, description, children, testId, block }: { label: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; testId?: string; block?: boolean }): React.JSX.Element {
  const mode = useContext(SettingsDescMode);
  const tucked = mode === 'compact' && typeof description === 'string' && description.length > SHORT_DESC;
  return (
    <div className={`setting-row ${block ? 'block' : ''}`} data-testid={testId}>
      <div className="setting-row-text">
        <div className="setting-row-label">
          {label}
          {tucked && (
            <Tooltip title={description} placement="topLeft" overlayClassName="setting-help-tip">
              <QuestionCircleOutlined className="setting-row-help" aria-label={description} />
            </Tooltip>
          )}
        </div>
        {description && !tucked && <div className="setting-row-desc">{description}</div>}
      </div>
      {children !== undefined && <div className="setting-row-control">{children}</div>}
    </div>
  );
}
