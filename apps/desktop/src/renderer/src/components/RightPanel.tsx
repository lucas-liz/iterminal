import { useEffect, useState } from 'react';
import { Button, Empty, Segmented, Tooltip } from 'antd';
import { DashboardOutlined, FolderOpenOutlined, LockOutlined, MenuFoldOutlined } from '@ant-design/icons';
import { activePane, useTabs } from '../store/tabs';
import { useApp } from '../store/app';
import { AgentPanel } from './agent/AgentPanel';
import { FilePanel } from './FilePanel';
import { useAiAllowed } from '../util/ai-access';
import { AiLocked } from './AiLocked';
import { MonitorPanel } from './monitor/MonitorPanel';
import { useWorkspaceUi, type RightMode } from '../store/workspace';
import { AiIcon } from './RailIcons';

export type { RightMode };

/**
 * 右侧面板顶部切换条（文件 / 监控 / AI + 收起按钮）：
 * 在终端页已连接时直接渲染到统一顶部栏中，与终端标签行、工具区保持同一行。
 */
export function RightPanelHeader({
  mode,
  onMode,
  onCollapse,
  compact = false,
}: {
  mode: RightMode;
  onMode(m: RightMode): void;
  onCollapse(): void;
  compact?: boolean;
}): React.JSX.Element {
  const aiAllowed = useAiAllowed();
  return (
    <div className={compact ? 'right-panel-head-inline no-drag' : 'right-panel-head'} data-testid="right-panel-head">
      <Segmented
        size={compact ? 'small' : 'middle'}
        block
        className="right-tabs"
        value={mode}
        onChange={(v) => onMode(v as RightMode)}
        options={[
          {
            label: (
              <span className="right-tab-item" data-testid="right-files">
                <FolderOpenOutlined /> 文件
              </span>
            ),
            value: 'files',
          },
          {
            label: (
              <span className="right-tab-item" data-testid="right-monitor">
                <DashboardOutlined /> 监控
              </span>
            ),
            value: 'monitor',
          },
          {
            label: (
              <Tooltip title={aiAllowed ? undefined : '登录后可用'}>
                <span data-testid="right-ai" className={`right-tab-item ${aiAllowed ? '' : 'ai-locked-tab'}`}>
                  {aiAllowed ? <AiIcon size={14} /> : <LockOutlined />} AI
                </span>
              </Tooltip>
            ),
            value: 'ai',
          },
        ]}
      />
      <Tooltip title="收起右侧面板" placement="bottom">
        <Button size="small" type="text" icon={<MenuFoldOutlined rotate={180} />} onClick={onCollapse} className="right-collapse" aria-label="收起右侧面板" />
      </Tooltip>
    </div>
  );
}

/**
 * 终端右侧面板：文件 / 监控 / AI。
 * hideHeader 为 true 时由顶部栏统一承载切换条，面板内容从顶部直接铺满。
 */
export function RightPanel({
  mode,
  onMode,
  onCollapse,
  hideHeader = false,
}: {
  mode: RightMode;
  onMode(m: RightMode): void;
  onCollapse(): void;
  hideHeader?: boolean;
}): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs);
  const page = useApp((s) => s.page);
  const activeTab = useTabs((s) => s.activeId);
  const focused = useTabs((s) => s.focused);
  // 分屏时文件面板跟随获得焦点的窗格
  const active = activePane({ tabs, activeId: activeTab, focused });
  const activeId = active?.id ?? null;
  // 文件面板为每个连接过的远端标签保留一份（切换标签时保持目录和状态）
  const [mounted, setMounted] = useState<string[]>([]);
  useEffect(() => {
    if (active && (active.kind === 'ssh' || active.kind === 'sftp') && active.status === 'ready' && !mounted.includes(active.id)) {
      setMounted((m) => [...m, active.id]);
    }
  }, [active?.id, active?.status]);
  useEffect(() => {
    setMounted((m) => m.filter((id) => tabs.some((t) => t.id === id)));
  }, [tabs.length]);

  const remote = active && (active.kind === 'ssh' || active.kind === 'sftp');
  const monitorTab = useWorkspaceUi((s) => s.monitorTab);
  const aiAllowed = useAiAllowed();
  const rightOpen = useWorkspaceUi((s) => s.rightOpen);

  return (
    <div className="right-panel" data-testid="right-panel">
      {!hideHeader && <RightPanelHeader mode={mode} onMode={onMode} onCollapse={onCollapse} />}
      <div className={mode === 'files' ? 'right-panel-body' : 'hidden'}>
        {tabs
          .filter((t) => mounted.includes(t.id))
          .map((t) => (
            <div key={t.id} className={t.id === activeId ? 'right-panel-fill' : 'hidden'}>
              <FilePanel tab={t} />
            </div>
          ))}
        {!(remote && mounted.includes(active!.id)) && (
          <div className="side-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                !active
                  ? '打开一个 SSH 终端后，这里显示远端文件'
                  : active.kind === 'local'
                    ? '本机终端的文件请使用系统文件管理器'
                    : active.kind === 'telnet' || active.kind === 'serial'
                      ? 'Telnet 和串口会话没有文件面板（串口可以用工具条上的「发送文件」）'
                      : '连接成功后显示远端文件'
              }
            />
          </div>
        )}
      </div>
      {/* 监控只在显示时挂载：进程、端口等详情是按需执行的远端命令，看不见时不再刷新 */}
      {mode === 'monitor' && rightOpen && (
        <div className="right-panel-body">
          {active?.kind === 'ssh' && active.hostId && active.status === 'ready' ? (
            <MonitorPanel hostId={active.hostId} hostName={active.title} tab={monitorTab} onTab={(t) => useWorkspaceUi.getState().setMonitorTab(t)} />
          ) : (
            <div className="side-empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={!active ? '打开一个 SSH 终端后，这里显示主机的实时监控' : active.kind === 'ssh' ? '连接成功后显示主机监控' : '只有 SSH 主机有监控'} />
            </div>
          )}
        </div>
      )}
      <div className={mode === 'ai' ? 'right-panel-body' : 'hidden'}>
        {aiAllowed ? <AgentPanel handleExternal={page !== 'ai'} /> : <AiLocked />}
      </div>
    </div>
  );
}
