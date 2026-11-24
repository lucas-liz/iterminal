import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Badge, Button, Checkbox, Empty, Input, Popconfirm, Popover, Space, Tooltip, Typography } from 'antd';
import {
  BorderHorizontalOutlined,
  BorderVerticleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  EnterOutlined,
  FolderOpenOutlined,
  MenuFoldOutlined,
  ReloadOutlined,
  SearchOutlined,
  SwapOutlined,
  ThunderboltOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Host } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { openHost } from '../../actions';
import { useApp } from '../../store/app';
import { useForwards, runningCount } from '../../store/forwards';
import { currentTerminal, sendToTerminals, useLibrary } from '../../store/library';
import { leaves, useTabs, type Tab } from '../../store/tabs';
import { useWorkspaceUi } from '../../store/workspace';

/** 图标按钮：只显示图标，悬停显示说明 */
function Tool({ title, icon, onClick, active, testId, disabled, children }: { title: string; icon: React.ReactNode; onClick?: () => void; active?: boolean; testId?: string; disabled?: boolean; children?: React.ReactNode }): React.JSX.Element {
  return (
    <Tooltip title={title} placement="bottom">
      <Button size="small" type="text" className={`tab-tool ${active ? 'on' : ''}`} icon={icon} onClick={onClick} data-testid={testId} disabled={disabled} aria-label={title}>
        {children}
      </Button>
    </Tooltip>
  );
}

/** 快捷指令：点一下发送到当前终端并执行（带变量的指令打开填写框） */
function QuickCommands(): React.JSX.Element {
  const snippets = useLibrary((s) => s.snippets);
  const groups = useLibrary((s) => s.snippetGroups);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return snippets.filter((s) => !k || s.name.toLowerCase().includes(k) || s.content.toLowerCase().includes(k)).slice(0, 200);
  }, [snippets, q]);
  const groupName = (id: string | null): string => groups.find((g) => g.id === id)?.name ?? '未分组';
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      overlayClassName="tab-pop"
      content={
        <div className="tab-pop-body" data-testid="quick-commands">
          <div className="tab-pop-head">
            <Typography.Text strong>快捷指令</Typography.Text>
            <Button size="small" type="link" onClick={() => (setOpen(false), useApp.getState().setPage('snippets'))}>
              管理
            </Button>
          </div>
          <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索名称或命令" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="tab-pop-list">
            {list.map((s) => (
              <div
                key={s.id}
                className="tab-pop-row"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setOpen(false);
                  useLibrary.getState().run(s);
                }}
                onKeyDown={(e) => e.key === 'Enter' && (setOpen(false), useLibrary.getState().run(s))}
                data-testid={`quick-${s.name}`}
              >
                <div className="tab-pop-main">
                  <div className="tab-pop-title">{s.name}</div>
                  <div className="tab-pop-sub mono">{s.content.split('\n')[0]}</div>
                </div>
                <span className="tab-pop-tag">{groupName(s.groupId)}</span>
              </div>
            ))}
            {!list.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={snippets.length ? '没有匹配的指令' : '还没有快捷指令，在「指令集」里添加'} />}
          </div>
        </div>
      }
    >
      <Button size="small" type="text" className={`tab-tool tab-tool-text ${open ? 'on' : ''}`} icon={<ThunderboltOutlined />} data-testid="tab-quick">
        快捷指令
      </Button>
    </Popover>
  );
}

/** 历史命令每次加载的条数（滚动到底部再加载下一页） */
const HISTORY_PAGE = 100;

type HistoryItem = { command: string; source: 'shell' | 'app'; count?: number; lastUsed?: number };

/**
 * 这台主机的历史命令：shell 自己的历史（~/.bash_history、~/.zsh_history，和 history 命令看到的一样）加上 iTerminal 的记录，最近的在前；
 * 每页 100 条，滚动到底部自动加载下一页。点一下填到终端（不执行），回车图标直接执行；iTerminal 的记录可以删除单条或清空（不改 shell 的历史文件）
 */
function HistoryCommands({ hostId, hostName }: { hostId: string | null; hostName: string }): React.JSX.Element {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [shell, setShell] = useState<{ files: string[]; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  /** offset = 0 时替换列表（重新搜索 / 刷新），否则追加下一页 */
  const load = (offset: number, refresh = false): void => {
    const my = ++seq.current;
    setLoading(true);
    invoke('history.list', { hostId, q, offset, limit: HISTORY_PAGE, refresh })
      .then((r) => {
        if (my !== seq.current) return;
        setItems((cur) => (offset === 0 ? r.items : [...cur, ...r.items]));
        setTotal(r.total);
        setShell(r.shell);
        if (offset === 0) listRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => my === seq.current && message.error(errorMessage(e)))
      .finally(() => my === seq.current && setLoading(false));
  };
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(0), q ? 200 : 0);
    return () => clearTimeout(t);
  }, [open, q, hostId]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget;
    if (!loading && items.length < total && el.scrollTop + el.clientHeight >= el.scrollHeight - 48) load(items.length);
  };
  const send = (command: string, execute: boolean): void => {
    const t = currentTerminal();
    if (!t) return void message.warning('当前没有已连接的终端');
    sendToTerminals([t.id], command, execute);
    setOpen(false);
  };
  const hasApp = items.some((h) => h.source === 'app' || h.count);
  const from = shell?.files.length ? shell.files.map((f) => f.replace(/^.*[\\/]/, '')).join('、') : null;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      overlayClassName="tab-pop"
      content={
        <div className="tab-pop-body" data-testid="history-panel">
          <div className="tab-pop-head">
            <Typography.Text strong>历史命令</Typography.Text>
            <Typography.Text type="secondary" className="tab-pop-host">
              {hostName}
              {total > 0 && ` · ${total} 条`}
            </Typography.Text>
            <Tooltip title={from ? `重新读取 ${from}` : '重新读取 shell 历史'}>
              <Button size="small" type="text" icon={<ReloadOutlined spin={loading} />} onClick={() => load(0, true)} aria-label="刷新" data-testid="history-refresh" />
            </Tooltip>
            {hasApp && (
              <Popconfirm
                title={`清空 iTerminal 在「${hostName}」记录的命令？`}
                description="不会修改服务器上的 shell 历史文件"
                okText="清空"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => invoke('history.clear', { hostId }).then(() => load(0))}
              >
                <Button size="small" type="link" danger style={{ marginLeft: 0 }}>
                  清空记录
                </Button>
              </Popconfirm>
            )}
          </div>
          <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索历史命令" value={q} onChange={(e) => setQ(e.target.value)} data-testid="history-search" />
          <div className="tab-pop-list" ref={listRef} onScroll={onScroll} data-testid="history-list">
            {items.map((h) => (
              <div key={h.command} className="tab-pop-row" role="button" tabIndex={0} onClick={() => send(h.command, false)} onKeyDown={(e) => e.key === 'Enter' && send(h.command, true)} data-testid="history-row">
                <div className="tab-pop-main">
                  <div className="tab-pop-title mono">{h.command}</div>
                  <div className="tab-pop-sub">
                    {h.lastUsed ? `${dayjs(h.lastUsed).format('MM-DD HH:mm')} · ${h.count} 次` : 'shell 历史'}
                  </div>
                </div>
                <Tooltip title="直接执行">
                  <Button size="small" type="text" icon={<EnterOutlined />} onClick={(e) => (e.stopPropagation(), send(h.command, true))} aria-label="直接执行" data-testid="history-run" />
                </Tooltip>
                {h.source === 'app' && (
                  <Tooltip title="删除这条记录">
                    <Button
                      size="small"
                      type="text"
                      icon={<DeleteOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        void invoke('history.delete', { hostId, command: h.command }).then(() => {
                          setItems((cur) => cur.filter((x) => x.command !== h.command));
                          setTotal((n) => Math.max(0, n - 1));
                        });
                      }}
                      aria-label="删除这条"
                    />
                  </Tooltip>
                )}
              </div>
            ))}
            {items.length > 0 && items.length < total && (
              <div className="tab-pop-more" data-testid="history-more">
                {loading ? '加载中…' : `已显示 ${items.length} / ${total} 条，继续下滑加载`}
              </div>
            )}
            {!items.length && !loading && (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? '没有匹配的命令' : shell?.error ? `没有读到 shell 历史（${shell.error}），在终端里执行过的命令会记录在这里` : '这台主机还没有历史命令'} />
            )}
          </div>
          <Typography.Text type="secondary" className="tab-pop-foot">
            点击填入终端，<EnterOutlined /> 直接执行{from ? ` · 来自 ${from} 和 iTerminal 的记录` : ''}
          </Typography.Text>
        </div>
      }
    >
      <span>
        <Tool title="历史命令（这台主机）" icon={<ClockCircleOutlined />} active={open} testId="tab-history" />
      </span>
    </Popover>
  );
}

/** 广播输入：勾选的会话同时收到输入 */
export function BroadcastButton(): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs);
  const broadcast = useTabs((s) => s.broadcast);
  const activeId = useTabs((s) => s.activeId);
  const layouts = useTabs((s) => s.layouts);
  const terminals = tabs.filter((t) => t.kind !== 'sftp');
  const defaults = (): string[] => {
    const inTab = activeId && layouts[activeId] ? leaves(layouts[activeId]) : [];
    return inTab.length > 1 ? inTab : terminals.filter((t) => t.status === 'ready').map((t) => t.id);
  };
  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      title="广播输入"
      content={
        <Space direction="vertical" style={{ width: 260 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            在勾选的任意一个会话里输入，都会同时发送到所有勾选的会话。
          </Typography.Text>
          <Checkbox.Group
            value={broadcast.targets}
            onChange={(v) => useTabs.getState().setBroadcast(broadcast.on, v as string[])}
            options={terminals.map((t) => ({ value: t.id, label: `${t.title}${t.status === 'ready' ? '' : '（未连接）'}`, disabled: t.status !== 'ready' }))}
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
          />
          <Space>
            <Button
              size="small"
              type={broadcast.on ? 'default' : 'primary'}
              danger={broadcast.on}
              onClick={() => useTabs.getState().setBroadcast(!broadcast.on, broadcast.on ? broadcast.targets : broadcast.targets.length ? broadcast.targets : defaults())}
              data-testid="broadcast-toggle"
            >
              {broadcast.on ? '停止广播' : '开始广播'}
            </Button>
            <Button size="small" onClick={() => useTabs.getState().setBroadcast(broadcast.on, defaults())}>
              默认选择
            </Button>
          </Space>
        </Space>
      }
    >
      <span>
        <Tooltip title={broadcast.on ? `广播中（${broadcast.targets.length} 个会话）` : '广播输入'} placement="bottom">
          <Button size="small" type="text" className={`tab-tool ${broadcast.on ? 'on danger' : ''}`} icon={<WifiOutlined />} data-testid="broadcast" aria-label="广播输入">
            {broadcast.on ? `广播中（${broadcast.targets.length}）` : undefined}
          </Button>
        </Tooltip>
      </span>
    </Popover>
  );
}

/**
 * 终端标签行右侧固定的工具区（参考 iShell）：快捷指令、历史命令、SFTP、端口转发、左右 / 上下分屏、广播输入。
 * 只显示图标，悬停显示说明；和当前获得焦点的终端相关的按钮跟着它变化。
 */
export function TabTools({ pane, host, onSplit }: { pane: Tab | undefined; host: Host | undefined; onSplit(dir: 'h' | 'v'): void }): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs);
  // 没有已连接的终端时右侧面板不显示，也就不需要「展开」按钮
  const tabsConnected = tabs.some((t) => t.kind !== 'sftp' && t.status === 'ready');
  const collapsed = useWorkspaceUi((s) => !s.rightOpen) && tabsConnected;
  const forwardCount = useForwards((s) => (host ? runningCount(s, host.id) : 0));
  const terminal = pane && pane.kind !== 'sftp';
  return (
    <div className="tab-tools no-drag">
      <QuickCommands />
      {terminal && <HistoryCommands hostId={pane.hostId ?? null} hostName={pane.kind === 'local' ? '本机' : (host?.name ?? pane.title)} />}
      <span className="tab-tools-sep" />
      {pane?.kind === 'ssh' && host && <Tool title="SFTP 文件传输（新标签）" icon={<FolderOpenOutlined />} onClick={() => openHost(host, 'sftp')} testId="open-sftp-from-tab" />}
      {pane?.kind === 'ssh' && host && (
        <Badge count={forwardCount} size="small" offset={[-4, 4]}>
          <Tool title={forwardCount ? `端口转发（${forwardCount} 条运行中）` : '端口转发'} icon={<SwapOutlined />} onClick={() => useForwards.getState().open(host.id)} testId="open-forwards" />
        </Badge>
      )}
      {terminal && <Tool title="左右分屏" icon={<BorderHorizontalOutlined />} onClick={() => onSplit('h')} testId="split-h" />}
      {terminal && <Tool title="上下分屏" icon={<BorderVerticleOutlined />} onClick={() => onSplit('v')} testId="split-v" />}
      {tabs.some((t) => t.kind !== 'sftp') && <BroadcastButton />}
      {collapsed && <Tool title="展开右侧面板（文件 / 命令 / 监控 / AI）" icon={<MenuFoldOutlined />} onClick={() => useWorkspaceUi.getState().openRight()} testId="right-expand" />}
    </div>
  );
}

