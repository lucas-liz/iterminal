import { useState } from 'react';
import { App as AntApp, Avatar, Button, Dropdown, Tooltip, Typography, type MenuProps } from 'antd';
import { CloudSyncOutlined, EllipsisOutlined, LoginOutlined, UserOutlined } from '@ant-design/icons';
import type { AccountState, ServerState } from '@itm/protocol';
import { invoke } from '../../api';
import { useAccount } from '../../store/account';
import { useApp } from '../../store/app';
import { useServer } from '../../store/server';

/**
 * 侧栏底部的账号卡片（终端模式的导航栏和 AI 对话模式的会话列表底部都有）。
 * 第十二轮：登录后只显示头像、用户名、邮箱和连接状态（已连接绿色、连接中黄色）；没有登录（离线使用）显示 Guest 和「登录」。
 */
export function ProfileCard(): React.JSX.Element {
  const account = useAccount((s) => s.state);
  const server = useServer((s) => s.state);
  if (account && account.status !== 'none') return <AccountCard account={account} server={server} />;
  // 自动化测试：本地档案连接模拟服务端
  if (server?.enabled) return <ServerCard state={server} />;
  return <GuestCard account={account} />;
}

/** 切换账号的菜单：显示名和登录名（界面上不显示服务端地址） */
const profileLabel = (p: { displayName: string; username: string }): string => (p.displayName && p.displayName !== p.username ? `${p.displayName}（${p.username}）` : p.username || p.displayName);

/** 离线使用（本地模式）：Guest + 登录；本机有其他账号时可以切换 */
function GuestCard({ account }: { account: AccountState | null }): React.JSX.Element {
  const openLogin = useAccount((s) => s.openLogin);
  const others = account?.profiles ?? [];
  const items: MenuProps['items'] = others.map((p) => ({ key: p.id, label: profileLabel(p) }));
  // 切换菜单向上展开，和按钮的提示在同一个位置：菜单打开时不显示提示，否则会盖住菜单项
  const [menuOpen, setMenuOpen] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  return (
    <div className="profile-card guest" data-testid="local-mode">
      <Avatar size={34} className="profile-avatar guest" icon={<UserOutlined />} />
      <div className="profile-meta">
        <div className="profile-name">Guest</div>
        <div className="profile-sub">离线使用</div>
      </div>
      <Tooltip title="登录 iTerminal 账号：AI 对话、团队模型、定时任务、远程审批，审计和录像上报服务端">
        <Button size="small" type="primary" icon={<LoginOutlined />} onClick={() => openLogin()} data-testid="login-open">
          登录
        </Button>
      </Tooltip>
      {others.length > 0 && (
        <Dropdown menu={{ items, onClick: ({ key }) => void invoke('account.switch', { profileId: key }) }} trigger={['click']} placement="topRight" onOpenChange={setMenuOpen}>
          <Tooltip title="切换到本机已有的账号" open={tipOpen && !menuOpen} onOpenChange={setTipOpen}>
            <Button size="small" type="text" icon={<EllipsisOutlined />} data-testid="profile-switch" />
          </Tooltip>
        </Dropdown>
      )}
    </div>
  );
}

/** 登录的账号：头像（右下角是状态点）、用户名、邮箱、状态；菜单里重新登录、切换、退出登录 */
function AccountCard({ account, server }: { account: AccountState; server: ServerState | null }): React.JSX.Element {
  const { modal } = AntApp.useApp();
  const openLogin = useAccount((s) => s.openLogin);
  const requireLogin = useApp((s) => !!s.info?.preset.requireLogin);
  const dead = account.status !== 'valid';
  // 只有两种状态：连上服务端是「已连接」，其他（正在连、断线重连、登录过期等待重新登录）都是「连接中…」
  const online = !dead && server?.status === 'online';
  const relogin = (): void => openLogin({ username: account.username ?? '', reason: account.message ?? undefined });
  const name = account.displayName || account.username || '账号';
  const items: MenuProps['items'] = [
    ...(dead ? [{ key: 'relogin', label: '重新登录' }] : []),
    ...(requireLogin ? [] : [{ key: 'local', label: '切换到离线使用（Guest）' }]),
    ...account.profiles.filter((p) => p.id !== account.profileId).map((p) => ({ key: `p:${p.id}`, label: `切换到 ${profileLabel(p)}` })),
    { key: 'login', label: '登录其他账号' },
    { type: 'divider' as const },
    { key: 'logout', label: '退出登录' },
    { key: 'wipe', label: '退出并清除本机数据', danger: true },
  ];
  const onMenu = ({ key }: { key: string }): void => {
    if (key === 'relogin') relogin();
    else if (key === 'login') openLogin();
    else if (key === 'local') void invoke('account.switch', { profileId: 'local' });
    else if (key.startsWith('p:')) void invoke('account.switch', { profileId: key.slice(2) });
    else if (key === 'logout') {
      modal.confirm({
        title: '退出登录？',
        content: '切换回离线使用（Guest）。这个账号的主机、命令和对话仍然加密保存在本机，下次登录后继续使用。',
        okText: '退出登录',
        cancelText: '取消',
        onOk: () => invoke('account.logout', {}),
      });
    } else if (key === 'wipe') {
      modal.confirm({
        title: '退出并清除本机数据？',
        content: '会删除这个账号在本机的全部数据（主机、命令、笔记、凭证、对话、审计和录像），无法恢复。服务端上的审计和录像不受影响。',
        okText: '退出并清除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => invoke('account.logout', { wipe: true }),
      });
    }
  };
  const status = (
    <span className={`profile-status ${online ? 'ok' : 'warn'}`} data-testid="server-status">
      {online ? '已连接' : '连接中…'}
    </span>
  );
  const tip = dead ? `${account.message ?? (account.status === 'revoked' ? '设备已被吊销' : '登录已过期')}，点击重新登录` : `${online ? '已连接服务端' : '正在连接服务端'}${server?.lastError ? `（${server.lastError}）` : ''}`;
  return (
    <div className="profile-card account" data-testid="account-card" data-status={account.status}>
      <span className="profile-avatar-wrap">
        <Avatar size={34} className="profile-avatar" src={account.avatar || undefined} data-testid="account-avatar">
          {name.slice(0, 1).toUpperCase()}
        </Avatar>
        <span className={`profile-dot ${online ? 'ok' : 'warn'}`} />
      </span>
      <div className="profile-meta">
        <div className="profile-name-row">
          <span className="profile-name" data-testid="account-name">
            {name}
          </span>
          <Tooltip title={tip}>
            {dead ? (
              <span className="profile-relogin" onClick={relogin} data-testid="account-relogin">
                {status}
              </span>
            ) : (
              status
            )}
          </Tooltip>
        </div>
        <Typography.Text className="profile-sub" ellipsis={{ tooltip: account.email || account.username }} data-testid="account-email">
          {account.email || account.username}
        </Typography.Text>
      </div>
      <Dropdown menu={{ items, onClick: onMenu }} trigger={['click']} placement="topRight">
        <Button size="small" type="text" icon={<EllipsisOutlined />} data-testid="account-menu" />
      </Dropdown>
    </div>
  );
}

const SERVER_STATUS: Record<string, { text: string; cls: string }> = {
  online: { text: '已连接', cls: 'ok' },
  connecting: { text: '连接中…', cls: 'warn' },
  offline: { text: '连接中…', cls: 'warn' },
  off: { text: '连接中…', cls: 'warn' },
};

/** 自动化测试：本地档案连接模拟服务端时的状态卡片 */
function ServerCard({ state }: { state: ServerState }): React.JSX.Element {
  const st = SERVER_STATUS[state.status] ?? SERVER_STATUS.off;
  return (
    <div className="profile-card account" data-testid="server-card" data-status={state.status}>
      <Avatar size={34} className="profile-avatar" icon={<CloudSyncOutlined />} />
      <div className="profile-meta">
        <div className="profile-name-row">
          <span className="profile-name">服务端</span>
          <Tooltip title={state.lastError ?? st.text}>
            <span className={`profile-status ${st.cls}`} data-testid="server-status">
              {st.text}
            </span>
          </Tooltip>
        </div>
        <div className="profile-sub">自动化测试</div>
      </div>
    </div>
  );
}
