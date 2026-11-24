import { useEffect, useMemo, useState } from 'react';
import { useAppScheme } from './util/theme';
import { appPalette } from './util/palette';
import { App as AntApp, ConfigProvider, Modal, Spin, theme, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { errorMessage, isMac } from './api';
import { useApp } from './store/app';
import { useHosts } from './store/hosts';
import { activePane, useTabs } from './store/tabs';
import { useAgent } from './store/agent';
import { useWorkspaceUi } from './store/workspace';
import { openLocalShell } from './actions';
import { matchShortcut } from './util/shortcuts';
import { TopBar, MinimalWindowBar } from './components/TopBar';
import { IconRail } from './components/IconRail';
import { PromptHost } from './components/PromptHost';
import { HostsPage } from './pages/hosts/HostsPage';
import { DatabasesPage } from './pages/databases/DatabasesPage';
import { WorkspacePage } from './pages/workspace/WorkspacePage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { VaultPage } from './pages/vault/VaultPage';
import { SnippetsPage } from './pages/library/SnippetsPage';
import { NotesPage } from './pages/library/NotesPage';
import { MonitorPage } from './pages/monitor/MonitorPage';
import { SnippetRunner } from './components/SnippetRunner';
import { HostEditor } from './pages/hosts/HostEditor';
import { UpdateWatcher } from './components/UpdateWatcher';
import { AiPage } from './pages/ai/AiPage';
import { AuditPage } from './pages/audit/AuditPage';
import { ApprovalsPage } from './pages/approvals/ApprovalsPage';
import { ServerWatcher } from './components/ServerWatcher';
import { HighlightDialog } from './components/HighlightDialog';
import { TerminalColorsDialog } from './components/TerminalColorsDialog';
import { ForwardImportDialog } from './components/ForwardImport';
import { BatchPage } from './pages/batch/BatchPage';
import { PortForwardModal } from './components/PortForwardModal';
import { RemoteEditor } from './components/sftp/RemoteEditor';
import { SkillRunDialog } from './components/agent/SkillRunDialog';
import { AttentionWatcher } from './components/AttentionWatcher';
import { ShareDialog } from './components/share/ShareDialog';
import { EditWatcher } from './components/sftp/EditWatcher';
import { useForwards } from './store/forwards';
import { useLibrary } from './store/library';
import { SecurityScreen } from './components/SecurityScreens';
import { useVault } from './store/vault';
import { useAccount } from './store/account';
import { LoginDialog, LoginGate } from './components/account/LoginDialog';
import { AccountWatcher } from './components/account/AccountWatcher';
import { AddSnippetDialog } from './components/AddSnippetDialog';
import { ShExecDialog } from './components/files/ShExecDialog';
import { SharePullHost } from './pages/settings/CloudSection';


/** 系统的「减少动态效果」设置（跟随变化） */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const fn = (): void => setOn(m.matches);
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, []);
  return on;
}

export function App(): React.JSX.Element {
  const loadInfo = useApp((s) => s.loadInfo);
  const load = useApp((s) => s.load);
  const security = useApp((s) => s.security);
  const reloadHosts = useHosts((s) => s.reload);
  const reloadVault = useVault((s) => s.reload);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // 应用主题（设置 → 外观 → 主题）决定整个界面的配色
  const scheme = useAppScheme();
  const palette = useMemo(() => appPalette(scheme), [scheme]);

  useEffect(() => {
    loadInfo().catch((e) => setError(errorMessage(e)));
  }, [loadInfo]);

  // 档案解锁后才能读取设置、主机和凭证
  const unlocked = !!security?.ready;
  useEffect(() => {
    if (!unlocked || ready) return;
    Promise.all([
      load(),
      reloadHosts(),
      reloadVault(),
      useLibrary.getState().reloadSnippets(),
      useLibrary.getState().reloadNotes(),
      useForwards.getState().reload(),
      useAccount.getState().load(),
    ])
      .then(() => setReady(true))
      .catch((e) => setError(errorMessage(e)));
  }, [unlocked, ready, load, reloadHosts, reloadVault]);

  // 菜单栏「帮助 → 问题反馈…」（第十三轮）
  // 菜单栏「窗口 → 关闭标签页」（⌘W / Ctrl+Shift+W，第三十一轮）：在终端页时关闭当前标签（分屏时关闭获得焦点的窗格）
  useEffect(
    () =>
      window.itm.on('app.command', (c) => {
        if (c.command === 'feedback') useApp.getState().openSettings('feedback');
        else if (c.command === 'closeTab' && useApp.getState().page === 'workspace') {
          const pane = activePane(useTabs.getState());
          if (pane) useTabs.getState().closePane(pane.id);
        }
      }),
    [],
  );

  // 界面字体：空字符串表示用样式表里的系统字体
  const uiFont = useApp((s) => s.settings['ui.fontFamily']);
  useEffect(() => {
    document.body.style.fontFamily = uiFont || '';
  }, [uiFont]);

  useEffect(() => {
    const vars = palette.vars;
    Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
    document.body.style.background = vars['--itm-bg'];
    document.body.style.color = vars['--itm-text'];
    // 外框、阴影这些按深浅色区分的样式用这个属性（第二十六轮）
    document.documentElement.dataset.theme = palette.dark ? 'dark' : 'light';
  }, [palette]);

  // 系统要求减少动态效果（Windows 关闭了「显示动画」、远程桌面、虚拟机常见）：antd 的浮层不用动画，直接显示。
  // 以前在样式里把所有动画压成 1ms，antd 在放大动画的第一帧量浮层大小，算出来的位置跑到屏幕外，提示、下拉、右键菜单都看不到（1.2.0 Windows 包的问题）
  const reducedMotion = useReducedMotion();
  const themeConfig = useMemo(() => {
    const p = palette.vars;
    const t = palette.tokens;
    const dark = palette.dark;
    return {
      algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: {
        colorPrimary: p['--itm-primary'],
        colorInfo: p['--itm-primary'],
        colorSuccess: t.success,
        colorWarning: t.warning,
        colorError: t.error,
        colorTextLightSolid: t.solidText,
        colorBgLayout: p['--itm-bg'],
        // 输入框、选择器、表格等的底色
        colorBgContainer: p['--itm-input-bg'],
        colorBgElevated: p['--itm-elevated-bg'],
        colorBorder: p['--itm-border-strong'],
        colorBorderSecondary: p['--itm-border'],
        colorText: p['--itm-text'],
        colorTextSecondary: p['--itm-text-secondary'],
        colorBgMask: dark ? 'rgba(0, 0, 0, 0.6)' : 'rgba(0, 0, 0, 0.3)',
        colorTextPlaceholder: t.placeholder,
        controlItemBgActive: p['--itm-primary-soft'],
        ...(uiFont ? { fontFamily: uiFont } : {}),
        // 圆角参考 NewMax 的 8 / 12 / 18（第二十六轮）
        borderRadius: 10,
        borderRadiusSM: 8,
        borderRadiusLG: 14,
        borderRadiusXS: 6,
        borderRadiusOuter: 8,
        ...(reducedMotion ? { motion: false } : {}),
        motionEaseOut: 'cubic-bezier(0.33, 1, 0.68, 1)',
        motionEaseInOut: 'cubic-bezier(0.22, 1, 0.36, 1)',
        boxShadowSecondary: dark
          ? '0 0 0 0.5px rgba(255, 255, 255, 0.08), 0 3px 6px rgba(0, 0, 0, 0.3), 0 12px 28px rgba(0, 0, 0, 0.45)'
          : '0 0 0 0.5px rgba(0, 0, 0, 0.06), 0 3px 6px rgba(0, 0, 0, 0.04), 0 11px 11px rgba(0, 0, 0, 0.03), 0 24px 15px rgba(0, 0, 0, 0.02)',
      },
      components: {
        // 排序列不另外加底色（默认的 bodySortBg / headerSortActiveBg 在透明表格上会变成一整列深色）
        Table: {
          colorBgContainer: 'transparent',
          headerBg: p['--itm-panel-bg'],
          rowHoverBg: p['--itm-hover'],
          headerSplitColor: 'transparent',
          bodySortBg: 'transparent',
          headerSortActiveBg: p['--itm-panel-bg'],
          headerSortHoverBg: p['--itm-hover'],
          fixedHeaderSortActiveBg: p['--itm-panel-bg'],
        },
        // 对话框：标题栏、内容、按钮栏用分隔线分开；iOS 风格的大圆角
        Modal: {
          contentBg: p['--itm-elevated-bg'],
          headerBg: p['--itm-elevated-bg'],
          footerBg: p['--itm-elevated-bg'],
          borderRadiusLG: 18,
          contentPadding: 0,
          headerPadding: '14px 24px',
          headerMarginBottom: 0,
          headerBorderBottom: `1px solid ${p['--itm-border']}`,
          bodyPadding: '18px 24px 6px',
          footerPadding: '12px 24px',
          footerMarginTop: 0,
          footerBorderTop: `1px solid ${p['--itm-border']}`,
          footerBorderRadius: '0 0 18px 18px',
          confirmBodyPadding: '24px 24px 20px',
        },
        Drawer: { colorBgElevated: p['--itm-elevated-bg'] },
        Button: {
          defaultBg: t.buttonBg,
          defaultBorderColor: p['--itm-border-strong'],
          defaultHoverBg: t.buttonHoverBg,
          defaultShadow: 'none',
          primaryShadow: 'none',
          fontWeight: 500,
        },
        // iOS 的分段控件：浅灰轨道 + 浮起的选中块
        Segmented: {
          trackBg: t.segmentTrack,
          itemColor: p['--itm-text-secondary'],
          itemHoverColor: p['--itm-text'],
          itemHoverBg: dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.04)',
          itemSelectedBg: t.segmentSelected,
          itemSelectedColor: t.segmentSelectedText,
          trackPadding: 3,
          borderRadius: 10,
          borderRadiusSM: 8,
        },
        Switch: { colorPrimary: t.success, colorPrimaryHover: t.success },
        Tabs: { cardBg: p['--itm-panel-bg'] },
        Form: { itemMarginBottom: 18, verticalLabelPadding: '0 0 6px' },
        Collapse: { headerBg: p['--itm-section-bg'], contentBg: 'transparent' },
        Tooltip: { colorBgSpotlight: t.tooltipBg },
        Menu: { itemSelectedBg: p['--itm-primary-soft'] },
        Dropdown: { borderRadiusLG: 14, borderRadiusSM: 8 },
        Popover: { borderRadiusLG: 14 },
        Input: { borderRadius: 10, activeShadow: 'none' },
        InputNumber: { activeShadow: 'none' },
        Select: { optionSelectedBg: p['--itm-primary-soft'], optionBorderRadius: 8 },
        Card: { colorBgContainer: p['--itm-card-bg'], headerBg: 'transparent', borderRadiusLG: 14 },
      },
    };
  }, [palette, uiFont, reducedMotion]);

  return (
    <ConfigProvider locale={zhCN} theme={themeConfig} button={{ autoInsertSpace: false }}>
      <AntApp style={{ height: '100%' }}>
        {error ? (
          <div className="standalone-screen">
            <MinimalWindowBar />
            <div style={{ padding: 40 }}>
              <Typography.Title level={4}>加载失败</Typography.Title>
              <Typography.Text type="danger">{error}</Typography.Text>
            </div>
          </div>
        ) : security && !security.ready ? (
          <SecurityScreen mode={security.needsSetup ? 'setup' : 'cold'} />
        ) : !ready ? (
          <div className="standalone-screen">
            <MinimalWindowBar />
            <div className="empty-workspace" style={{ flex: 1 }}>
              <Spin />
            </div>
          </div>
        ) : (
          <>
            <MainOrGate />
            {security?.locked && <SecurityScreen mode="locked" />}
          </>
        )}
        <PromptHost />
        {/* 自动更新提醒放在最外层：没有登录（必须登录的登录页）、还没输入主密码、锁定时也能收到更新和强制升级（第十五轮） */}
        <UpdateWatcher />
      </AntApp>
    </ConfigProvider>
  );
}

/** 管理员要求必须登录（requireLogin）且当前是本地模式时只显示登录页 */
function MainOrGate(): React.JSX.Element {
  const requireLogin = useApp((s) => !!s.info?.preset.requireLogin);
  const local = useAccount((s) => s.state?.status === 'none');
  if (requireLogin && local) return <LoginGate />;
  return <Shell />;
}

function Shell(): React.JSX.Element {
  const page = useApp((s) => s.page);
  const collapsed = useApp((s) => s.siderCollapsed);

  // 全局快捷键（设置 → 快捷键可以改）：捕获阶段处理，终端获得焦点时也有效。
  // 同时支持 ⌘[/⌘]（macOS）或 Alt+←/Alt+→（Windows/Linux）以及鼠标侧键进行导航返回 / 前进
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat && !matchShortcut(e, 'nextTab') && !matchShortcut(e, 'prevTab')) return;
      const handle = (): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      const app = useApp.getState();
      if ((isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === '[') || (!isMac && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowLeft')) {
        handle();
        app.goBack();
      } else if ((isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && e.key === ']') || (!isMac && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowRight')) {
        handle();
        app.goForward();
      } else if (matchShortcut(e, 'toggleMode')) {
        handle();
        app.setMode(app.mode === 'ai' ? 'terminal' : 'ai');
      } else if (matchShortcut(e, 'toggleSider')) {
        handle();
        app.toggleSider();
      } else if (matchShortcut(e, 'openSettings')) {
        handle();
        app.setPage('settings');
      } else if (matchShortcut(e, 'newLocalTerminal')) {
        handle();
        openLocalShell();
      } else if (matchShortcut(e, 'nextTab') || matchShortcut(e, 'prevTab')) {
        handle();
        const t = useTabs.getState();
        const roots = t.tabs.filter((x) => !x.parentId);
        if (!roots.length) return;
        const i = Math.max(0, roots.findIndex((x) => x.id === t.activeId));
        const next = roots[(i + (matchShortcut(e, 'nextTab') ? 1 : roots.length - 1)) % roots.length];
        t.activate(next.id);
        if (app.page !== 'workspace') app.leaveAi('workspace');
      } else if (matchShortcut(e, 'aiNewConversation')) {
        handle();
        void useAgent.getState().newConversation();
        if (app.page === 'ai') app.setAiView('chat');
        else useWorkspaceUi.getState().focusAi();
      } else if (matchShortcut(e, 'focusAiInput')) {
        handle();
        if (app.page === 'ai') app.setAiView('chat');
        else if (app.page !== 'workspace') app.setPage('workspace');
        useWorkspaceUi.getState().focusAi();
      }
    };
    const onMouseUp = (e: MouseEvent): void => {
      if (e.button === 3) {
        e.preventDefault();
        useApp.getState().goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        useApp.getState().goForward();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div className={`app-shell ${collapsed ? 'sider-collapsed' : ''} ${isMac ? 'mac' : 'win'} page-${page}`}>
      <TopBar />
      <div className="shell-body">
        <IconRail />
        <main className={`page shell-frame ${page === 'ai' ? 'frame-ai' : ''}`}>
          {page === 'ai' && <AiPage />}
          {page === 'hosts' && <HostsPage />}
          {page === 'databases' && <DatabasesPage />}
          {page === 'settings' && <SettingsPage />}
          {page === 'audit' && <AuditPage />}
          {page === 'approvals' && <ApprovalsPage />}
          {page === 'batch' && <BatchPage />}
          {page === 'monitor' && <MonitorPage />}
          {page === 'snippets' && <SnippetsPage />}
          {page === 'notes' && <NotesPage />}
          {/* 终端页始终挂载，切走时只隐藏，保证会话和滚动缓冲不丢 */}
          <div className={page === 'workspace' ? 'page' : 'hidden'} style={{ flex: 1 }}>
            <WorkspacePage />
          </div>
        </main>
      </div>
      <SnippetRunner />
      <ServerWatcher />
      <VaultModal />
      <HighlightDialog />
      <TerminalColorsDialog />
      <GlobalHostEditor />
      <PortForwardModal />
      <ForwardImportDialog />
      <RemoteEditor />
      <SkillRunDialog />
      <AttentionWatcher />
      <EditWatcher />
      <LoginDialog />
      <AccountWatcher />
      <AddSnippetDialog />
      <ShExecDialog />
      <ShareDialog />
      <SharePullHost />
    </div>
  );
}

/** 凭证管理小窗：内容和原来的凭证页相同 */
function VaultModal(): React.JSX.Element {
  const open = useApp((s) => s.vaultOpen);
  return (
    <Modal
      open={open}
      onCancel={() => useApp.getState().setVaultOpen(false)}
      footer={null}
      width="min(1120px, 92vw)"
      centered
      destroyOnHidden
      title={null}
      closable
      className="vault-modal"
      styles={{ body: { padding: 0, height: 'min(760px, 82vh)', display: 'flex', flexDirection: 'column' } }}
    >
      <VaultPage embedded />
    </Modal>
  );
}

function GlobalHostEditor(): React.JSX.Element {
  const editor = useHosts((s) => s.editor);
  return <HostEditor target={editor} onClose={() => useHosts.getState().openEditor(null)} />;
}
