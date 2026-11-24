import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Tooltip } from 'antd';
import { create } from 'zustand';
import { invoke, isMac } from '../api';
import { useApp } from '../store/app';
import { pageHasSecondarySider } from '../util/nav';
import { useShortcutLabel } from '../util/shortcuts';
import { ModeSwitch } from './ModeSwitch';

const useTopBarSlotEl = create<{ el: HTMLDivElement | null; setEl(el: HTMLDivElement | null): void }>((set) => ({
  el: null,
  setEl: (el) => set({ el }),
}));

/**
 * 将当前页面的上下文标题、操作按钮或终端标签栏投射到统一顶部栏中。
 * 这样顶部栏与窗口控制、侧栏收起按钮始终保持同一行，页面内容区零多余顶栏。
 */
export function TopBarSlot({ active = true, children }: { active?: boolean; children: React.ReactNode }): React.JSX.Element | null {
  const el = useTopBarSlotEl((s) => s.el);
  if (!active || !el) return null;
  return createPortal(children, el);
}

/** Codex 风格的侧栏图标：圆角窗口 + 左侧分隔竖线 */
export function SiderIcon({ collapsed }: { collapsed?: boolean }): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden className="topbar-svg">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.25" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5.75 3v10" stroke="currentColor" strokeWidth="1.25" />
      {!collapsed && <rect x="2.5" y="3.5" width="2.6" height="9" rx="1" fill="currentColor" opacity="0.22" />}
    </svg>
  );
}

function ChevronLeftIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="topbar-svg">
      <path d="M9.75 3.75L5.5 8l4.25 4.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="topbar-svg">
      <path d="M6.25 3.75L10.5 8l-4.25 4.25" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 自定义窗口控制按钮（最小化、最大化/还原、关闭）：Windows / Linux 是无边框窗口，用界面右上角的按钮 */
const CUSTOM_WINDOW_CONTROLS = !isMac;

/** Windows / Linux 自定义右上角窗口控制按钮（最小化、最大化/还原、关闭） */
export function WindowControls(): React.JSX.Element | null {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!CUSTOM_WINDOW_CONTROLS) return;
    void invoke('window.isMaximized').then(setMaximized).catch(() => undefined);
    return window.itm.on('window.maximized', (e) => setMaximized(e.maximized));
  }, []);

  if (!CUSTOM_WINDOW_CONTROLS) return null;

  return (
    <div className="win-controls no-drag" data-testid="win-controls">
      <button
        type="button"
        className="win-btn"
        onClick={() => void invoke('window.minimize')}
        aria-label="最小化"
        title="最小化"
        data-testid="win-min"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" />
        </svg>
      </button>
      <button
        type="button"
        className="win-btn"
        onClick={() => void invoke('window.maximizeToggle').then(setMaximized)}
        aria-label={maximized ? '向下还原' : '最大化'}
        title={maximized ? '向下还原' : '最大化'}
        data-testid="win-max"
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M3 3V1.5h5.5V7H7" stroke="currentColor" strokeWidth="1.05" />
            <rect x="1.5" y="3" width="5.5" height="5.5" stroke="currentColor" strokeWidth="1.05" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.05" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="win-btn win-btn-close"
        onClick={() => void invoke('window.close')}
        aria-label="关闭"
        title="关闭"
        data-testid="win-close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

/** 锁屏 / 登录拦截页用的精简顶部拖拽条 + Windows 右上角窗口控制 */
export function MinimalWindowBar(): React.JSX.Element {
  return (
    <div
      className={`minimal-winbar drag ${isMac ? 'mac' : 'win'}`}
      onDoubleClick={() => {
        if (CUSTOM_WINDOW_CONTROLS) void invoke('window.maximizeToggle');
      }}
    >
      <WindowControls />
    </div>
  );
}

/**
 * 统一顶部标题栏（参考 Codex 桌面端 + Chrome/Arc 融合顶栏）：
 * - 左侧固定：「返回 / 前进 / 收起侧栏」及「终端 / AI」模式切换；
 * - 中右侧为页面上下文插槽（TopBarSlot）：主机管理按钮、笔记操作、审计录像设置、终端标签行 + 工具区 + 右侧面板切换均融入这一行；
 * - Windows / Linux 最右侧为原生观感最小化 / 最大化 / 关闭按钮。
 */
export function TopBar(): React.JSX.Element {
  const page = useApp((s) => s.page);
  const collapsed = useApp((s) => s.siderCollapsed);
  const navIndex = useApp((s) => s.navIndex);
  const navLen = useApp((s) => s.navHistory.length);
  const goBack = useApp((s) => s.goBack);
  const goForward = useApp((s) => s.goForward);
  const toggleSider = useApp((s) => s.toggleSider);
  const setSlotEl = useTopBarSlotEl((s) => s.setEl);
  const siderShortcut = useShortcutLabel('toggleSider');

  const canBack = navIndex > 0;
  const canForward = navIndex < navLen - 1;
  const hasSider = pageHasSecondarySider(page);
  const backHint = isMac ? '返回上一级（⌘[）' : '返回上一级（Alt+←）';
  const forwardHint = isMac ? '前进（⌘]）' : '前进（Alt+→）';
  const siderHint = !hasSider
    ? '当前页面没有可收起的侧边栏'
    : `${collapsed ? '展开侧边栏' : '收起侧边栏'}${siderShortcut ? `（${siderShortcut}）` : ''}`;

  return (
    <header
      className={`app-topbar drag ${isMac ? 'mac' : 'win'} topbar-page-${page}`}
      data-testid="app-topbar"
      onDoubleClick={(e) => {
        if (!CUSTOM_WINDOW_CONTROLS) return;
        if ((e.target as HTMLElement).closest('.no-drag')) return;
        void invoke('window.maximizeToggle');
      }}
    >
      <div className="topbar-left no-drag">
        <Tooltip title={backHint} placement="bottom" mouseEnterDelay={0.35}>
          <button
            type="button"
            className="topbar-btn"
            disabled={!canBack}
            onClick={goBack}
            aria-label="返回上一级"
            data-testid="nav-back"
          >
            <ChevronLeftIcon />
          </button>
        </Tooltip>
        <Tooltip title={forwardHint} placement="bottom" mouseEnterDelay={0.35}>
          <button
            type="button"
            className="topbar-btn"
            disabled={!canForward}
            onClick={goForward}
            aria-label="前进"
            data-testid="nav-forward"
          >
            <ChevronRightIcon />
          </button>
        </Tooltip>
        <Tooltip title={siderHint} placement="bottom" mouseEnterDelay={0.35}>
          <button
            type="button"
            className={`topbar-btn ${hasSider && !collapsed ? 'active' : ''}`}
            disabled={!hasSider}
            onClick={toggleSider}
            aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
            data-testid={collapsed ? 'sider-expand' : 'sider-collapse'}
          >
            <SiderIcon collapsed={collapsed || !hasSider} />
          </button>
        </Tooltip>
        <span className="topbar-sep" aria-hidden />
        <ModeSwitch />
      </div>

      <div ref={setSlotEl} className="topbar-slot" data-testid="topbar-slot" />

      <WindowControls />
    </header>
  );
}
