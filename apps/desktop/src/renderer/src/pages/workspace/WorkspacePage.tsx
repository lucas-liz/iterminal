import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Dropdown, Empty, Input, List, Modal, Space, Splitter, Tooltip, Typography } from 'antd';
import {
  ApiOutlined,
  CloseOutlined,
  CloudServerOutlined,
  CodeOutlined,
  FolderOpenOutlined,
  LeftOutlined,
  PlusOutlined,
  RightOutlined,
  SearchOutlined,
  SwapOutlined,
  UsbOutlined,
  WifiOutlined,
} from '@ant-design/icons';
import type { Host, SessionStatus } from '@itm/protocol';
import { openHost, openLocalShell } from '../../actions';
import { AiIcon } from '../../components/RailIcons';
import { useHosts } from '../../store/hosts';
import { activePane, leaves, tabDropSlot, useTabs, type LayoutNode, type Tab, type TabDrop } from '../../store/tabs';
import { TabTools } from './TabTools';
import { RenameModal, TabMenu } from './TabMenu';
import { useAgent } from '../../store/agent';
import { PaneSlot, paneElement } from './panes';
import { useApp } from '../../store/app';
import { formatRelative } from '../../util/format';
import { TerminalView } from './TerminalView';
import { SftpView } from './SftpView';
import { RightPanel, RightPanelHeader } from '../../components/RightPanel';
import { TopBarSlot } from '../../components/TopBar';
import { useWorkspaceUi } from '../../store/workspace';
import { runningCount, useForwards } from '../../store/forwards';
import { MonitorBar } from '../../components/monitor/MonitorBar';
import { HostInfoSeg } from '../../components/monitor/HostInfoSeg';
import { useTerminalTheme } from '../../util/theme';

/** 右侧面板默认宽度 */
const RIGHT_WIDTH = 420;

const STATUS_COLOR: Record<SessionStatus, string> = {
  connecting: '#f5b83d',
  ready: '#52c41a',
  closed: '#8c8c8c',
  error: '#ff4d4f',
};

/** 拖动标签时 dataTransfer 里的类型（和文件拖放区分开） */
const TAB_MIME = 'application/x-itm-tab';
/** 拖动标签时，标签栏上下各多出这么多像素也算放在标签栏里（手往下偏一点不会弹回去） */
const TAB_DROP_SLACK = 36;

/** 状态栏里没有监控时显示的连接信息 */
function statusNote(t: { kind: string; hostId?: string }, hosts: Host[]): string {
  if (t.kind === 'local') return '本机终端';
  const h = hosts.find((x) => x.id === t.hostId);
  if (!h) return '';
  if (t.kind === 'telnet') return `Telnet · ${h.address}:${h.port}${h.encoding && h.encoding !== 'UTF-8' ? ` · ${h.encoding}` : ''}`;
  if (t.kind === 'serial') {
    const s = h.serial;
    return `串口 · ${h.address}${s ? ` · ${s.baudRate} ${s.dataBits}${s.parity[0].toUpperCase()}${s.stopBits} · 回车 ${s.eol}` : ''}`;
  }
  return '';
}

/** 状态栏：这台主机正在运行的端口转发，点击打开管理框 */
function ForwardBadge({ hostId }: { hostId: string }): React.JSX.Element | null {
  const n = useForwards((s) => runningCount(s, hostId));
  if (n === 0) return null;
  return (
    <Tooltip title="正在运行的端口转发">
      <button type="button" className="statusbar-forward" onClick={() => useForwards.getState().open(hostId)} data-testid="statusbar-forwards">
        <SwapOutlined /> {n}
      </button>
    </Tooltip>
  );
}

/** 终端底部状态栏最前面的 AI 图标按钮：与顶栏模式切换保持同一套星芒图标 */
function AiButton(): React.JSX.Element {
  const on = useWorkspaceUi((s) => s.rightOpen && s.rightMode === 'ai');
  return (
    <Tooltip title={on ? '收起 AI 助手' : '打开 AI 助手（默认引用已连接的终端）'} placement="topLeft">
      <button
        type="button"
        className={`statusbar-ai ${on ? 'on' : ''}`}
        onClick={() => useWorkspaceUi.getState().toggleAi()}
        data-testid="statusbar-ai"
        aria-label={on ? '收起 AI 助手' : '打开 AI 助手'}
      >
        <AiIcon size={14} />
      </button>
    </Tooltip>
  );
}

/**
 * 右侧面板边缘的展开 / 收起按钮：贴在左右两栏的真实分界线上（通过 ResizeObserver 实时测量右侧面板宽度，
 * 无论窗口缩放、最大化或拖拽分栏，位置都严丝合缝不偏移）。
 */
function EdgeToggle({ open, right }: { open: boolean; right: number }): React.JSX.Element {
  return (
    <Tooltip title={open ? '收起右侧面板' : '展开右侧面板（文件 / 监控 / AI）'} placement="left" mouseEnterDelay={0.2}>
      <button
        type="button"
        className={`edge-toggle ${open ? 'open' : 'closed'}`}
        style={{ right }}
        onClick={() => (open ? useWorkspaceUi.getState().closeRight() : useWorkspaceUi.getState().openRight())}
        data-testid="right-edge-toggle"
        aria-label={open ? '收起右侧面板' : '展开右侧面板'}
      >
        {open ? <RightOutlined /> : <LeftOutlined />}
      </button>
    </Tooltip>
  );
}

/** 分屏布局（文档一 6.1）：叶子是终端窗格，窗格的终端通过 Portal 挂在固定的容器里 */
function LayoutView({ node, rootId, visible }: { node: LayoutNode; rootId: string; visible: boolean }): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs);
  const focused = useTabs((s) => s.focused[rootId] ?? rootId);
  const broadcast = useTabs((s) => s.broadcast);
  const split = useTabs((s) => !!s.layouts[rootId]);
  const hosts = useHosts((s) => s.hosts);
  if (node.type === 'leaf') {
    const t = tabs.find((x) => x.id === node.tabId);
    if (!t) return <div />;
    return (
      <div className={`pane ${split && focused === t.id ? 'focused' : ''}`} data-testid={`pane-${t.title}`}>
        {split && (
          <div className="pane-head" onMouseDown={() => useTabs.getState().focus(t.id)}>
            <span className="status-dot" style={{ background: STATUS_COLOR[t.status] }} />
            <span className="ellipsis">{t.title}</span>
            {broadcast.on && broadcast.targets.includes(t.id) && <WifiOutlined className="broadcast-mark" title="广播中" />}
            <Tooltip title="关闭窗格">
              <CloseOutlined className="pane-x" onClick={() => useTabs.getState().closePane(t.id)} data-testid={`pane-close-${t.title}`} />
            </Tooltip>
          </div>
        )}
        <div className="terminal-with-bar">
          <PaneSlot id={t.id} />
          <div className="terminal-statusbar">
            <AiButton />
            {(t.kind === 'ssh' || t.kind === 'telnet') && t.hostId && <HostInfoSeg hostId={t.hostId} />}
            {t.kind === 'ssh' && t.hostId && <ForwardBadge hostId={t.hostId} />}
            {t.kind === 'ssh' && t.hostId ? (
              <MonitorBar hostId={t.hostId} tabId={t.id} enabled={visible && t.status === 'ready'} />
            ) : (
              <span className="statusbar-note">{statusNote(t, hosts)}</span>
            )}
          </div>
        </div>
      </div>
    );
  }
  return (
    <Splitter orientation={node.dir === 'h' ? 'horizontal' : 'vertical'} className="pane-split">
      {node.children.map((c) => (
        <Splitter.Panel key={c.type === 'leaf' ? c.tabId : leaves(c)[0]} min={120}>
          <LayoutView node={c} rootId={rootId} visible={visible} />
        </Splitter.Panel>
      ))}
    </Splitter>
  );
}

export function WorkspacePage(): React.JSX.Element {
  const tabs = useTabs((s) => s.tabs);
  const termTheme = useTerminalTheme();
  const activeId = useTabs((s) => s.activeId);
  const layouts = useTabs((s) => s.layouts);
  const focused = useTabs((s) => s.focused);
  const broadcast = useTabs((s) => s.broadcast);
  const page = useApp((s) => s.page);
  const activate = useTabs((s) => s.activate);
  const close = useTabs((s) => s.close);
  const hosts = useHosts((s) => s.hosts);
  const [picking, setPicking] = useState(false);
  const rightMode = useWorkspaceUi((s) => s.rightMode);
  const rightOpen = useWorkspaceUi((s) => s.rightOpen);
  const [sizes, setSizes] = useState<(number | undefined)[]>([undefined, RIGHT_WIDTH]);
  const lastWidth = useRef(RIGHT_WIDTH);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rightBoxRef = useRef<HTMLDivElement>(null);
  const topbarWsRef = useRef<HTMLDivElement>(null);
  const [edgeRight, setEdgeRight] = useState<number>(RIGHT_WIDTH);
  const [topRightW, setTopRightW] = useState<number>(RIGHT_WIDTH);

  const roots = tabs.filter((t) => !t.parentId);
  const pane = activePane({ tabs, activeId, focused });
  const activeHost = pane?.hostId ? hosts.find((h) => h.id === pane.hostId) : undefined;
  const connected = tabs.some((t) => t.kind !== 'sftp' && t.status === 'ready');

  // 右侧面板展开 / 收起：展开时恢复上次宽度
  useEffect(() => {
    setSizes((sz) => (rightOpen ? (sz[1] === 0 ? [undefined, lastWidth.current] : sz) : [undefined, 0]));
  }, [rightOpen]);

  // 实时观测终端与右侧面板分界线的真实屏幕坐标：
  // 1) 让 EdgeToggle 严丝合缝贴在分界线上；
  // 2) 让顶部栏右侧面板切换区与右侧面板左边缘 0px 对齐，从而保证「广播」紧贴终端黑框最右侧！
  useEffect(() => {
    if (!connected || !rightOpen) {
      setEdgeRight(0);
      setTopRightW(0);
      return;
    }
    const rightEl = rightBoxRef.current;
    const wrapEl = wrapRef.current;
    if (!rightEl || !wrapEl) return;
    const sync = (): void => {
      const rr = rightEl.getBoundingClientRect();
      const wr = wrapEl.getBoundingClientRect();
      if (rr.width <= 0) return;
      setEdgeRight(Math.max(0, Math.round(wr.right - rr.left)));
      const tw = topbarWsRef.current;
      if (tw) {
        const tr = tw.getBoundingClientRect();
        // 顶部栏右端到右侧面板左边缘的距离：减去 8px 分隔空隙后正好让左侧工具区最右端（广播）贴齐终端黑框右边缘
        setTopRightW(Math.max(210, Math.round(tr.right - rr.left)));
      } else {
        setTopRightW(Math.round(rr.width));
      }
    };
    const raf = requestAnimationFrame(sync);
    const ro = new ResizeObserver(sync);
    ro.observe(rightEl);
    ro.observe(wrapEl);
    if (topbarWsRef.current) ro.observe(topbarWsRef.current);
    window.addEventListener('resize', sync);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [connected, rightOpen, page, roots.length]);

  const onResize = (sz: number[]): void => {
    setSizes(sz);
    if (sz[1] > 0) lastWidth.current = sz[1];
    const ui = useWorkspaceUi.getState();
    if (sz[1] === 0 && ui.rightOpen) ui.closeRight();
    else if (sz[1] > 0 && !ui.rightOpen) ui.openRight();
  };

  // 终端里 # 问 AI、让 AI 解释、引用到 AI 对话框：打开右侧的 AI 面板
  const pendingSeq = useAgent((s) => s.pending?.seq);
  const quotedSeq = useAgent((s) => s.quoted?.seq);
  useEffect(() => {
    if (pendingSeq) useWorkspaceUi.getState().openRight('ai');
  }, [pendingSeq]);
  useEffect(() => {
    if (quotedSeq) useWorkspaceUi.getState().focusAi();
  }, [quotedSeq]);

  const splitActive = (dir: 'h' | 'v'): void => {
    if (!pane || pane.kind === 'sftp') return;
    useTabs.getState().split(pane.id, dir, { kind: pane.kind, title: pane.title, hostId: pane.hostId });
  };
  const splitTab = (t: Tab, dir: 'h' | 'v'): void => {
    if (t.kind === 'sftp') return;
    const target = tabs.find((x) => x.id === (focused[t.id] ?? t.id)) ?? t;
    activate(t.id);
    useTabs.getState().split(target.id, dir, { kind: target.kind, title: target.title, hostId: target.hostId });
  };

  const [renaming, setRenaming] = useState<Tab | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<TabDrop | null>(null);
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<string | null>(null);

  useEffect(() => {
    const strip = tabScrollRef.current;
    if (!dragging || !strip) return;
    const slotAt = (e: DragEvent): TabDrop | null | undefined => {
      const r = strip.getBoundingClientRect();
      if (e.clientX < r.left - 16 || e.clientX > r.right + 48 || e.clientY < r.top - TAB_DROP_SLACK || e.clientY > r.bottom + TAB_DROP_SLACK) return undefined;
      const shown = [...strip.querySelectorAll<HTMLElement>('.ws-top-tab')]
        .map((n) => ({ id: n.dataset.tabId ?? '', b: n.getBoundingClientRect() }))
        .filter((t) => t.id && t.b.width > 0 && t.b.right > r.left && t.b.left < r.right);
      return tabDropSlot(shown.map((t) => t.id), shown.map((t) => t.b.left + t.b.width / 2), dragging, e.clientX);
    };
    const finish = (): void => {
      dragRef.current = null;
      setDragging(null);
      setDropAt(null);
    };
    const over = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes(TAB_MIME)) return;
      const slot = slotAt(e);
      if (slot === undefined) return setDropAt(null);
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropAt((cur) => (cur?.id === slot?.id && cur?.after === slot?.after ? cur : slot));
    };
    const drop = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes(TAB_MIME)) return;
      const slot = slotAt(e);
      if (slot === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      if (slot) useTabs.getState().move(dragging, slot.id, slot.after);
      finish();
    };
    const leave = (e: DragEvent): void => {
      if (!e.relatedTarget) setDropAt(null);
    };
    window.addEventListener('dragover', over, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('dragend', finish, true);
    return () => {
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('dragend', finish, true);
    };
  }, [dragging]);

  const connectSeq = useWorkspaceUi((s) => s.connectSeq);
  useEffect(() => {
    if (connectSeq) setPicking(true);
  }, [connectSeq]);

  // 切换或新开标签时自动滚入可视区域，保证当前激活标签始终完整可见
  useEffect(() => {
    const strip = tabScrollRef.current;
    if (!strip || !activeId) return;
    const raf = requestAnimationFrame(() => {
      const el = strip.querySelector<HTMLElement>('.ws-top-tab.active');
      if (!el) return;
      const left = el.offsetLeft;
      const right = left + el.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - 4);
      else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth + 4;
    });
    return () => cancelAnimationFrame(raf);
  }, [activeId, roots.length, page]);

  const newTabMenu = {
    items: [
      { key: 'local', label: '本地终端', icon: <CodeOutlined /> },
      { key: 'host', label: '连接主机…', icon: <CloudServerOutlined /> },
    ],
    onClick: ({ key }: { key: string }) => (key === 'local' ? openLocalShell() : setPicking(true)),
  };

  return (
    <>
      {/* 终端页顶部统一栏：标签行（+ 紧跟最后一个标签后）、快捷指令/历史命令等工具按钮、右侧面板切换（文件/监控/AI）全部融合在一行 */}
      <TopBarSlot active={page === 'workspace'}>
        {roots.length === 0 ? (
          <div className="topbar-ctx">
            <div className="topbar-ctx-title">
              <span className="topbar-page-name">终端</span>
            </div>
            <div className="topbar-ctx-actions no-drag">
              <Space size={6}>
                <Button size="small" icon={<CloudServerOutlined />} onClick={() => setPicking(true)} data-testid="topbar-connect-host">
                  连接主机
                </Button>
                <Button size="small" type="primary" icon={<CodeOutlined />} onClick={openLocalShell} data-testid="topbar-local-shell">
                  本地终端
                </Button>
              </Space>
            </div>
          </div>
        ) : (
          <div ref={topbarWsRef} className={`topbar-workspace ${dragging ? 'tab-dnd' : ''}`} data-testid="topbar-workspace">
            <div className="topbar-ws-left">
              <div className="topbar-tabs-area">
                <div
                  ref={tabScrollRef}
                  className="topbar-tabs-scroll no-drag"
                  onWheel={(e) => {
                    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                      e.currentTarget.scrollLeft += e.deltaY;
                    }
                  }}
                >
                  {roots.map((t) => {
                    const panes = layouts[t.id] ? leaves(layouts[t.id]) : [t.id];
                    const inBroadcast = broadcast.on && panes.some((id) => broadcast.targets.includes(id));
                    const isActive = t.id === activeId;
                    const mark = dropAt?.id === t.id ? (dropAt.after ? ' tab-drop-after' : ' tab-drop-before') : '';
                    return (
                      <TabMenu key={t.id} tab={t} roots={roots} onRename={setRenaming} onSplit={(dir) => splitTab(t, dir)}>
                        <div
                          role="tab"
                          aria-selected={isActive}
                          draggable
                          data-tab-id={t.id}
                          className={`ws-top-tab ${isActive ? 'active' : ''} ${dragging === t.id ? 'tab-dragging' : ''}${mark}`}
                          onClick={() => activate(t.id)}
                          onMouseDown={(e) => {
                            if (e.button === 1) {
                              e.preventDefault();
                              close(t.id);
                            }
                          }}
                          onDragStart={(e) => {
                            dragRef.current = t.id;
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData(TAB_MIME, t.id);
                            setTimeout(() => dragRef.current === t.id && setDragging(t.id));
                          }}
                          onDragEnd={() => {
                            dragRef.current = null;
                            setDragging(null);
                            setDropAt(null);
                          }}
                          data-testid={`tab-${t.title}`}
                        >
                          <span className="status-dot" style={{ background: STATUS_COLOR[t.status] }} />
                          <span className="ws-top-tab-title">{t.title}</span>
                          {panes.length > 1 && <span className="tab-panes">{panes.length}</span>}
                          {inBroadcast && <WifiOutlined className="broadcast-mark" />}
                          <button
                            type="button"
                            className="ws-top-tab-close"
                            aria-label={`关闭 ${t.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              close(t.id);
                            }}
                          >
                            <CloseOutlined />
                          </button>
                        </div>
                      </TabMenu>
                    );
                  })}
                </div>
                {/* + 紧跟在最后一个终端标签后面；标签过多滚动时仍固定紧贴滚动区末尾可见 */}
                <Dropdown menu={newTabMenu} trigger={['click']}>
                  <Tooltip title="新建终端" placement="bottom">
                    <button type="button" className="ws-top-add no-drag" data-testid="tab-new" aria-label="新建终端">
                      <PlusOutlined />
                    </button>
                  </Tooltip>
                </Dropdown>
                <div className="topbar-tabs-drag-tail drag" />
              </div>

              <div className="topbar-ws-tools no-drag">
                <TabTools pane={pane} host={activeHost} onSplit={splitActive} />
              </div>
            </div>

            {connected && rightOpen && (
              <div className="topbar-ws-right no-drag" style={{ width: topRightW > 0 ? topRightW : RIGHT_WIDTH }} data-testid="topbar-ws-right">
                <RightPanelHeader
                  mode={rightMode}
                  onMode={(m) => useWorkspaceUi.getState().setRightMode(m)}
                  onCollapse={() => useWorkspaceUi.getState().closeRight()}
                  compact
                />
              </div>
            )}
          </div>
        )}
      </TopBarSlot>

      {/* 所有终端都通过 Portal 挂在固定的容器里：分屏、关闭窗格时终端不会重建 */}
      {tabs.filter((t) => t.kind !== 'sftp').map((t) => createPortal(<TerminalView tab={t} active={page === 'workspace' && pane?.id === t.id} />, paneElement(t.id), t.id))}

      <div
        ref={wrapRef}
        className="workspace-wrap"
        data-active-kind={roots.find((t) => t.id === activeId)?.kind}
        style={{ ['--itm-term-bg' as string]: termTheme.background, ['--itm-term-fg' as string]: termTheme.foreground }}
      >
        <Splitter className="workspace-split" onResize={onResize}>
          <Splitter.Panel size={connected ? sizes[0] : undefined} min={420}>
            {roots.length === 0 ? (
              <EmptyWorkspace onPick={() => setPicking(true)} />
            ) : (
              <div className="workspace-panes">
                {roots.map((t) => (
                  <div key={t.id} className={t.id === activeId ? 'workspace-pane-slot' : 'workspace-pane-slot hidden'}>
                    {t.kind === 'sftp' ? (
                      <SftpView tab={t} active={t.id === activeId} />
                    ) : (
                      <LayoutView node={layouts[t.id] ?? { type: 'leaf', tabId: t.id }} rootId={t.id} visible={t.id === activeId} />
                    )}
                  </div>
                ))}
              </div>
            )}
          </Splitter.Panel>
          {connected && (
            <Splitter.Panel size={sizes[1]} min={300} max="65%" collapsible={{ showCollapsibleIcon: false }}>
              <div ref={rightBoxRef} className="right-panel-measure">
                <RightPanel
                  mode={rightMode}
                  onMode={(m) => useWorkspaceUi.getState().setRightMode(m)}
                  onCollapse={() => useWorkspaceUi.getState().closeRight()}
                  hideHeader
                />
              </div>
            </Splitter.Panel>
          )}
        </Splitter>
        {connected && <EdgeToggle open={rightOpen} right={rightOpen ? edgeRight : 0} />}
      </div>
      <QuickConnect open={picking} onClose={() => setPicking(false)} />
      <RenameModal tab={renaming} onClose={() => setRenaming(null)} />
    </>
  );
}

function recentHosts(hosts: Host[]): Host[] {
  return hosts
    .filter((h) => h.lastConnectedAt)
    .sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0))
    .slice(0, 6);
}

const PROTO_ICON = { SSH: <CloudServerOutlined />, TELNET: <ApiOutlined />, SERIAL: <UsbOutlined /> } as const;

function EmptyWorkspace({ onPick }: { onPick(): void }): React.JSX.Element {
  const hosts = useHosts((s) => s.hosts);
  const setPage = useApp((s) => s.setPage);
  const recent = recentHosts(hosts);
  return (
    <div className="empty-workspace" data-testid="empty-workspace">
      <div className="empty-ws-box">
        <div className="empty-ws-hero">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有打开的终端" />
          <div className="empty-ws-actions">
            <Button type="primary" icon={<CodeOutlined />} onClick={openLocalShell} data-testid="empty-local-shell">
              打开本地终端
            </Button>
            <Button icon={<CloudServerOutlined />} onClick={hosts.length ? onPick : () => setPage('hosts')} data-testid="empty-connect-host">
              {hosts.length ? '连接主机' : '去添加主机'}
            </Button>
          </div>
        </div>
        {recent.length > 0 && (
          <div className="empty-recent-card" data-testid="empty-recent-card">
            <div className="empty-recent-head">
              <span className="empty-recent-title">最近连接</span>
              <button type="button" className="empty-recent-all" onClick={() => setPage('hosts')}>
                全部主机
              </button>
            </div>
            <div className="empty-recent-list">
              {recent.map((h) => {
                const endpoint = h.protocol === 'SERIAL' ? h.address : `${h.username ? `${h.username}@` : ''}${h.address}${h.port && h.port !== (h.protocol === 'TELNET' ? 23 : 22) ? `:${h.port}` : ''}`;
                return (
                  <div key={h.id} className="empty-recent-row" onClick={() => openHost(h, 'ssh')} data-testid={`recent-host-${h.name}`}>
                    <span className="empty-recent-icon">{PROTO_ICON[h.protocol]}</span>
                    <div className="empty-recent-meta">
                      <div className="empty-recent-name">{h.name}</div>
                      <div className="empty-recent-sub mono">{endpoint}</div>
                    </div>
                    <span className="empty-recent-time">{formatRelative(h.lastConnectedAt)}</span>
                    <div className="empty-recent-ops" onClick={(e) => e.stopPropagation()}>
                      <Button size="small" type="primary" ghost onClick={() => openHost(h, 'ssh')}>
                        连接
                      </Button>
                      {h.protocol === 'SSH' && (
                        <Button size="small" icon={<FolderOpenOutlined />} onClick={() => openHost(h, 'sftp')}>
                          SFTP
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QuickConnect({ open, onClose }: { open: boolean; onClose(): void }): React.JSX.Element {
  const hosts = useHosts((s) => s.hosts);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    const sorted = [...hosts].sort((a, b) => (b.lastConnectedAt ?? 0) - (a.lastConnectedAt ?? 0) || a.name.localeCompare(b.name));
    return k ? sorted.filter((h) => [h.name, h.address, h.username].some((v) => v.toLowerCase().includes(k))) : sorted;
  }, [hosts, q]);

  const go = (h: Host, kind: 'ssh' | 'sftp'): void => {
    openHost(h, kind);
    setQ('');
    onClose();
  };

  return (
    <Modal open={open} title="连接主机" footer={null} onCancel={onClose} destroyOnHidden width={560}>
      <Input
        autoFocus
        allowClear
        prefix={<SearchOutlined />}
        placeholder="搜索名称或地址，回车连接第一个"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onPressEnter={() => list[0] && go(list[0], 'ssh')}
      />
      <List
        style={{ marginTop: 12, maxHeight: 360, overflow: 'auto' }}
        size="small"
        dataSource={list}
        locale={{ emptyText: hosts.length ? '没有匹配的主机' : '还没有主机，请先在「主机」页添加' }}
        renderItem={(h) => (
          <List.Item
            style={{ cursor: 'pointer' }}
            onClick={() => go(h, 'ssh')}
            actions={[
              <Button
                key="sftp"
                size="small"
                type="link"
                onClick={(e) => {
                  e.stopPropagation();
                  go(h, 'sftp');
                }}
              >
                SFTP
              </Button>,
            ]}
          >
            <List.Item.Meta
              avatar={<CloudServerOutlined style={{ color: 'var(--itm-primary)', marginTop: 4 }} />}
              title={h.name}
              description={<Typography.Text type="secondary" className="mono">{`${h.username}@${h.address}:${h.port}`}</Typography.Text>}
            />
          </List.Item>
        )}
      />
    </Modal>
  );
}
