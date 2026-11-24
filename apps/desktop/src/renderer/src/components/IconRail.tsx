import { useState } from 'react';
import { App as AntApp, Avatar, Button, Popover, Tooltip } from 'antd';
import {
  CloudSyncOutlined,
  KeyOutlined,
  LockOutlined,
  LoginOutlined,
  LogoutOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  SwapOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { invoke } from '../api';
import { useAccount } from '../store/account';
import { useAgent } from '../store/agent';
import { useApp, type Page } from '../store/app';
import { useHosts } from '../store/hosts';
import { useServer } from '../store/server';
import { useTabs } from '../store/tabs';
import { AI_PRIMARY_NAV_KEYS, isOptionalNav, OVERFLOW_NAV_KEYS, PRIMARY_NAV_KEYS, type NavPageKey } from '../util/nav';
import { LockSvgIcon, MoreDotsIcon, RAIL_PAGE_META } from './RailIcons';

const profileLabel = (p: { displayName: string; username: string }): string =>
  p.displayName && p.displayName !== p.username ? `${p.displayName}（${p.username}）` : p.username || p.displayName;

/**
 * 最左侧常驻窄图标栏（参考 GPT / Codex 桌面端）：
 * - 始终常驻，只展示精简线性 SVG 图标，鼠标放上去展示描述；
 * - 终端模式展示 5 个核心图标：终端、主机、笔记、运维审计、批量执行；
 * - AI 模式第一个图标切换为 AI 对话，同时隐藏主机；
 * - 其余功能收在 ··· 里，鼠标悬浮即展开菜单；
 * - 底部放置头像，点击弹出账号 + 设置菜单，点「设置」进入设置页。
 */
export function IconRail(): React.JSX.Element {
  const mode = useApp((s) => s.mode);
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const tabCount = useTabs((s) => s.tabs.length);
  const hostCount = useHosts((s) => s.hosts.length);
  const aiWaiting = useAgent((s) => !!s.current?.messages.some((m) => m.role === 'assistant' && m.steps.some((st) => st.status === 'approval')));
  const masterPassword = useApp((s) => !!s.security?.masterPassword);
  const serverOn = useServer((s) => !!s.state?.enabled);
  const pendingApprovals = useServer((s) => s.approvals.length);
  const navHidden = useApp((s) => s.settings['ui.navHidden']);
  const [moreOpen, setMoreOpen] = useState(false);

  const primaryKeys = mode === 'ai' ? AI_PRIMARY_NAV_KEYS : PRIMARY_NAV_KEYS;

  const showOverflow = (key: NavPageKey): boolean => {
    if (key === 'approvals' && !serverOn && pendingApprovals === 0) return false;
    if (!isOptionalNav(key) || !navHidden.includes(key)) return true;
    return page === key || (key === 'approvals' && pendingApprovals > 0);
  };
  const overflowKeys = OVERFLOW_NAV_KEYS.filter(showOverflow);
  const overflowActive = overflowKeys.includes(page as NavPageKey);
  const overflowBadgeCount = serverOn || pendingApprovals > 0 ? pendingApprovals : 0;

  const tooltipOf = (key: Page): string => {
    const base = RAIL_PAGE_META[key].label;
    if (key === 'hosts' && hostCount > 0) return `${base}（${hostCount}）`;
    if (key === 'workspace' && tabCount > 0) return `${base}（${tabCount} 个会话）`;
    if (key === 'ai' && aiWaiting) return `${base}（有命令等你批准）`;
    return base;
  };

  const badgeOf = (key: NavPageKey): number => {
    if (key === 'approvals') return pendingApprovals;
    return 0;
  };

  return (
    <aside className="icon-rail" aria-label="主导航" data-testid="icon-rail">
      <nav className="icon-rail-nav">
        {primaryKeys.map((key) => {
          const item = RAIL_PAGE_META[key];
          const active = page === key;
          return (
            <Tooltip key={key} title={tooltipOf(key)} placement="right" mouseEnterDelay={0.12}>
              <button
                type="button"
                className={`rail-btn ${active ? 'active' : ''}`}
                onClick={() => setPage(key)}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                data-testid={`nav-${key}`}
              >
                <span className="rail-btn-icon">{item.icon}</span>
                {key === 'workspace' && tabCount > 0 && <span className="rail-dot ok" aria-hidden />}
                {key === 'ai' && aiWaiting && <span className="rail-dot alert" aria-hidden />}
              </button>
            </Tooltip>
          );
        })}

        {overflowKeys.length > 0 && (
          <Popover
            open={moreOpen}
            onOpenChange={setMoreOpen}
            trigger="hover"
            placement="rightTop"
            arrow={false}
            mouseEnterDelay={0.04}
            mouseLeaveDelay={0.22}
            overlayClassName="rail-more-popover"
            content={
              <div className="rail-more-menu" data-testid="rail-more-menu">
                <div className="rail-more-title">更多功能</div>
                {overflowKeys.map((key) => {
                  const item = RAIL_PAGE_META[key];
                  const active = page === key;
                  const badge = badgeOf(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`rail-more-item ${active ? 'active' : ''}`}
                      onClick={() => {
                        setPage(key as Page);
                        setMoreOpen(false);
                      }}
                      data-testid={`nav-${key}`}
                    >
                      <span className="rail-more-item-icon">{item.icon}</span>
                      <span className="rail-more-item-label">{item.label}</span>
                      {badge > 0 && (
                        <span className="rail-more-badge" data-testid={`nav-${key}-count`}>
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            }
          >
            <button
              type="button"
              className={`rail-btn ${overflowActive ? 'active' : ''} ${moreOpen ? 'hovered' : ''}`}
              aria-label="更多功能"
              data-testid="rail-more"
            >
              <span className="rail-btn-icon">
                <MoreDotsIcon />
              </span>
              {overflowBadgeCount > 0 && <span className="rail-dot alert" aria-hidden />}
            </button>
          </Popover>
        )}
      </nav>

      <div className="icon-rail-foot">
        {masterPassword && (
          <Tooltip title="立即锁定（需要主密码解锁）" placement="right" mouseEnterDelay={0.12}>
            <button
              type="button"
              className="rail-btn"
              onClick={() => void invoke('security.lock')}
              aria-label="锁定"
              data-testid="lock-now"
            >
              <span className="rail-btn-icon">
                <LockSvgIcon />
              </span>
            </button>
          </Tooltip>
        )}
        <AvatarMenu />
      </div>
    </aside>
  );
}

/** 左下角头像按钮 + 弹出菜单（含账号状态、设置、凭证库、问题反馈、登录 / 切换 / 退出） */
function AvatarMenu(): React.JSX.Element {
  const { modal } = AntApp.useApp();
  const [open, setOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const account = useAccount((s) => s.state);
  const openLogin = useAccount((s) => s.openLogin);
  const server = useServer((s) => s.state);
  const page = useApp((s) => s.page);
  const setPage = useApp((s) => s.setPage);
  const openSettings = useApp((s) => s.openSettings);
  const setVaultOpen = useApp((s) => s.setVaultOpen);
  const requireLogin = useApp((s) => !!s.info?.preset.requireLogin);
  const masterPassword = useApp((s) => !!s.security?.masterPassword);

  const loggedIn = !!account && account.status !== 'none';
  const dead = loggedIn && account.status !== 'valid';
  const online = loggedIn && !dead && server?.status === 'online';
  const mockServer = !loggedIn && !!server?.enabled;
  const name = loggedIn ? account.displayName || account.username || '账号' : mockServer ? '服务端' : 'Guest';
  const sub = loggedIn ? account.email || account.username || '' : mockServer ? '自动化测试' : '离线使用';
  const others = (account?.profiles ?? []).filter((p) => !loggedIn || p.id !== account?.profileId);

  const closeAnd = (fn: () => void): void => {
    setOpen(false);
    fn();
  };

  const relogin = (): void => {
    if (!account) return;
    openLogin({ username: account.username ?? '', reason: account.message ?? undefined });
  };

  const confirmLogout = (wipe: boolean): void => {
    setOpen(false);
    if (wipe) {
      modal.confirm({
        title: '退出并清除本机数据？',
        content: '会删除这个账号在本机的全部数据（主机、命令、笔记、凭证、对话、审计和录像），无法恢复。服务端上的审计和录像不受影响。',
        okText: '退出并清除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => invoke('account.logout', { wipe: true }),
      });
    } else {
      modal.confirm({
        title: '退出登录？',
        content: '切换回离线使用（Guest）。这个账号的主机、命令和对话仍然加密保存在本机，下次登录后继续使用。',
        okText: '退出登录',
        cancelText: '取消',
        onOk: () => invoke('account.logout', {}),
      });
    }
  };

  const tipTitle = loggedIn
    ? `${name} · ${dead ? '登录已过期' : online ? '已连接' : '连接中…'}`
    : mockServer
      ? `服务端 · ${server?.status === 'online' ? '已连接' : '连接中…'}`
      : 'Guest · 离线使用（点击打开菜单与设置）';

  const content = (
    <div className="avatar-popover-body" data-testid={loggedIn ? 'account-card' : mockServer ? 'server-card' : 'local-mode'} data-status={loggedIn ? account.status : (server?.status ?? 'none')}>
      <div className="avatar-popover-head">
        <span className="avatar-wrap">
          {loggedIn ? (
            <Avatar size={36} className="profile-avatar" src={account.avatar || undefined} data-testid="account-avatar">
              {name.slice(0, 1).toUpperCase()}
            </Avatar>
          ) : mockServer ? (
            <Avatar size={36} className="profile-avatar" icon={<CloudSyncOutlined />} />
          ) : (
            <Avatar size={36} className="profile-avatar guest" icon={<UserOutlined />} />
          )}
          {(loggedIn || mockServer) && (
            <span className={`avatar-dot ${online || (mockServer && server?.status === 'online') ? 'ok' : 'warn'}`} />
          )}
        </span>
        <div className="avatar-popover-meta">
          <div className="avatar-popover-name-row">
            <span className="avatar-popover-name" data-testid="account-name">
              {name}
            </span>
            {(loggedIn || mockServer) && (
              <span
                className={`profile-status ${online || (mockServer && server?.status === 'online') ? 'ok' : 'warn'}`}
                data-testid="server-status"
                onClick={dead ? () => closeAnd(relogin) : undefined}
                style={dead ? { cursor: 'pointer' } : undefined}
              >
                {online || (mockServer && server?.status === 'online') ? '已连接' : '连接中…'}
              </span>
            )}
          </div>
          <div className="avatar-popover-sub" data-testid="account-email">
            {sub}
          </div>
        </div>
      </div>

      {!loggedIn && !mockServer && (
        <div className="avatar-popover-cta">
          <Button
            type="primary"
            size="small"
            block
            icon={<LoginOutlined />}
            onClick={() => closeAnd(() => openLogin())}
            data-testid="login-open"
          >
            登录 iTerminal 账号
          </Button>
        </div>
      )}

      {dead && (
        <div className="avatar-popover-cta">
          <Button
            type="primary"
            size="small"
            block
            icon={<LoginOutlined />}
            onClick={() => closeAnd(relogin)}
            data-testid="account-relogin"
          >
            重新登录
          </Button>
        </div>
      )}

      <div className="avatar-popover-sep" />

      <div className="avatar-popover-list">
        <button
          type="button"
          className={`avatar-menu-item ${page === 'settings' ? 'active' : ''}`}
          onClick={() => closeAnd(() => setPage('settings'))}
          data-testid="nav-settings"
        >
          <SettingOutlined />
          <span>设置</span>
        </button>
        <button
          type="button"
          className="avatar-menu-item"
          onClick={() => closeAnd(() => setVaultOpen(true))}
          data-testid="avatar-menu-vault"
        >
          <KeyOutlined />
          <span>凭证保险库</span>
        </button>
        <button
          type="button"
          className="avatar-menu-item"
          onClick={() => closeAnd(() => openSettings('feedback'))}
          data-testid="avatar-menu-feedback"
        >
          <QuestionCircleOutlined />
          <span>问题反馈</span>
        </button>
      </div>

      {(loggedIn || others.length > 0 || masterPassword) && (
        <>
          <div className="avatar-popover-sep" />
          <div className="avatar-popover-list">
            {loggedIn && !requireLogin && (
              <button
                type="button"
                className="avatar-menu-item"
                onClick={() => closeAnd(() => void invoke('account.switch', { profileId: 'local' }))}
              >
                <SwapOutlined />
                <span>切换到离线使用（Guest）</span>
              </button>
            )}
            {others.map((p) => (
              <button
                key={p.id}
                type="button"
                className="avatar-menu-item"
                onClick={() => closeAnd(() => void invoke('account.switch', { profileId: p.id }))}
              >
                <SwapOutlined />
                <span>切换到 {profileLabel(p)}</span>
              </button>
            ))}
            {loggedIn && (
              <button type="button" className="avatar-menu-item" onClick={() => closeAnd(() => openLogin())}>
                <LoginOutlined />
                <span>登录其他账号</span>
              </button>
            )}
            {masterPassword && (
              <button type="button" className="avatar-menu-item" onClick={() => closeAnd(() => void invoke('security.lock'))}>
                <LockOutlined />
                <span>立即锁定</span>
              </button>
            )}
            {loggedIn && (
              <>
                <div className="avatar-popover-sep" />
                <button type="button" className="avatar-menu-item" onClick={() => confirmLogout(false)}>
                  <LogoutOutlined />
                  <span>退出登录</span>
                </button>
                <button type="button" className="avatar-menu-item danger" onClick={() => confirmLogout(true)}>
                  <LogoutOutlined />
                  <span>退出并清除本机数据</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="rightBottom"
      arrow={false}
      overlayClassName="avatar-menu-popover"
      content={content}
    >
      <Tooltip title={tipTitle} placement="right" open={tipOpen && !open} onOpenChange={setTipOpen} mouseEnterDelay={0.15}>
        <button
          type="button"
          className={`rail-avatar-btn ${page === 'settings' || open ? 'active' : ''}`}
          aria-label="账号与设置"
          data-testid="avatar-trigger"
          // 账号 / 服务端状态挂在常驻的头像按钮上（弹出菜单只在打开时渲染）：none 本地模式、server 自动化测试的服务端、其余为账号状态
          data-status={loggedIn ? account.status : mockServer ? 'server' : 'none'}
          data-online={online || (mockServer && server?.status === 'online') ? '1' : '0'}
        >
          <span className="avatar-wrap">
            {loggedIn ? (
              <Avatar size={30} className="profile-avatar" src={account.avatar || undefined}>
                {name.slice(0, 1).toUpperCase()}
              </Avatar>
            ) : mockServer ? (
              <Avatar size={30} className="profile-avatar" icon={<CloudSyncOutlined />} />
            ) : (
              <Avatar size={30} className="profile-avatar guest" icon={<UserOutlined />} />
            )}
            {(loggedIn || mockServer) && (
              <span className={`avatar-dot ${online || (mockServer && server?.status === 'online') ? 'ok' : 'warn'}`} />
            )}
          </span>
        </button>
      </Tooltip>
    </Popover>
  );
}
