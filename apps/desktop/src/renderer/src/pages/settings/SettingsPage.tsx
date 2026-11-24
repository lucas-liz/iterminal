import { useEffect, useMemo, useRef, useState } from 'react';
import { AppLogo } from '../../components/AppLogo';
import { SavedInstaller } from '../../components/UpdateWatcher';
import { App, Alert, Button, Empty, Input, InputNumber, Progress, Segmented, Space, Switch, Tooltip, Typography } from 'antd';
import {
  AppstoreOutlined,
  BgColorsOutlined,
  CodeOutlined,
  DatabaseOutlined,
  InfoCircleOutlined,
  LockOutlined,
  LoginOutlined,
  RobotOutlined,
  SearchOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { Settings } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { groupOfSection, normalizeSection, SETTINGS_GROUPS, type SettingsGroupKey } from '../../util/settings-sections';
import { AgentSettings, ModelSettings, SkillSettings } from './AiSettings';
import { SecuritySettings } from './SecuritySettings';
import { McpSettings } from './McpSettings';
import { CommandSecuritySettings } from './CommandSecuritySettings';
import { SyncSettings } from './SyncSettings';
import { useUpdate } from '../../store/update';
import { SettingGroup, SettingRow, SettingsDescMode, SettingsSection } from './parts';
import { searchSettings, SECTION_LABEL, TERMINAL_CAT_LABEL, useSettingsFocus, type SettingsSearchItem } from './search-index';
import { TerminalSettings } from './TerminalSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { ShortcutSettings } from './ShortcutSettings';
import { StorageSettings } from './StorageSettings';
import { FeedbackSettings } from './FeedbackSettings';
import { useAccount } from '../../store/account';
import { AdminServerDialog, useSecretTaps } from '../../components/account/AdminServerDialog';
import { promptLogin, useAiAllowed } from '../../util/ai-access';
import { TopBarSlot } from '../../components/TopBar';
import { CollapsibleSider } from '../../components/CollapsibleSider';

function useSet(): <K extends keyof Settings>(key: K, value: Settings[K] | null) => void {
  const { message } = App.useApp();
  const update = useApp((s) => s.updateSetting);
  return (key, value) => {
    if (value === null || value === undefined) return;
    update(key, value).catch((e) => message.error(errorMessage(e)));
  };
}

function TransferSettings(): React.JSX.Element {
  const settings = useApp((s) => s.settings);
  const set = useSet();
  return (
    <SettingsSection title="文件传输" description="SFTP 上传 / 下载。出错后会自动重试（最多 3 次），从已经传完的位置继续。">
      <SettingGroup title="传输">
        <SettingRow label="同时传输数" description="同一个 SFTP 会话最多同时进行几个传输，其余的排队">
          <InputNumber min={1} max={8} value={settings['sftp.concurrency']} onChange={(v) => set('sftp.concurrency', v)} style={{ width: 120 }} data-testid="sftp-concurrency" />
        </SettingRow>
        <SettingRow label="限速" description="所有传输共用的速度上限，0 表示不限速">
          <InputNumber min={0} max={1000000} step={128} value={settings['sftp.rateLimitKBps']} onChange={(v) => set('sftp.rateLimitKBps', v)} style={{ width: 160 }} suffix="KB/s" data-testid="sftp-rate" />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="同名文件">
        <SettingRow
          label="冲突处理"
          description="目标已有同名文件时会询问：覆盖、跳过、保留两者（改名为「名称 (1).扩展名」），或者断点续传（目标比源小时从目标的大小继续）"
        />
      </SettingGroup>
    </SettingsSection>
  );
}

/** 账户（第二十六轮，原「数据与账号」）：登录状态和登录 / 退出，放在「账户」页最上面 */
function AccountCard(): React.JSX.Element {
  const account = useAccount((s) => s.state);
  const { modal } = App.useApp();
  const loggedIn = !!account && account.status !== 'none';
  const name = loggedIn ? account.displayName || account.username || '' : 'Guest';
  return (
    <div className="account-card" data-testid="settings-account">
      <span className="account-avatar">{loggedIn ? name.slice(0, 1).toUpperCase() : <UserOutlined />}</span>
      <div className="account-text">
        <div className="account-name">
          {loggedIn ? `${name}（${account.username}）` : '本地模式（Guest，未登录）'}
          {loggedIn && <span className={`account-state ${account.status === 'valid' ? 'ok' : 'warn'}`}>{account.status === 'valid' ? '已登录' : '登录已过期'}</span>}
        </div>
        <div className="account-sub">
          {!loggedIn
            ? '数据只保存在本机，可直接配置个人 API Key 或连接 Ollama 使用 AI；登录后还可使用团队模型、云端备份和远程审批'
            : account.status === 'valid'
              ? '主机和密码仍只保存在本机；审计和录像上报服务端'
              : `${account.message ?? '登录已过期'}，定时任务、远程审批和审计上报已暂停`}
        </div>
      </div>
      <Space>
        {!loggedIn && (
          <Button type="primary" icon={<LoginOutlined />} onClick={() => useAccount.getState().openLogin()} data-testid="settings-login">
            登录
          </Button>
        )}
        {loggedIn && account.status !== 'valid' && (
          <Button type="primary" onClick={() => useAccount.getState().openLogin({ username: account.username ?? '' })}>
            重新登录
          </Button>
        )}
        {loggedIn && (
          <Button
            onClick={() =>
              modal.confirm({
                title: '退出登录？',
                content: '切换回本地模式。这个账号的数据仍然加密保存在本机，下次登录后继续使用。',
                okText: '退出登录',
                cancelText: '取消',
                onOk: () => invoke('account.logout', {}),
              })
            }
          >
            退出登录
          </Button>
        )}
      </Space>
    </div>
  );
}

function AboutSettings(): React.JSX.Element {
  const info = useApp((s) => s.info);
  const { message } = App.useApp();
  const st = useUpdate((s) => s.state);
  // 隐藏入口：连续点 5 次软件图标，输入管理员密码后修改服务端地址
  const [adminOpen, setAdminOpen] = useState(false);
  const tapLogo = useSecretTaps(() => setAdminOpen(true));
  useEffect(() => {
    void useUpdate.getState().load();
  }, []);
  const run = (p: Promise<unknown>): void => void p.catch((e) => message.error(errorMessage(e)));
  const statusText = (): React.ReactNode => {
    if (!st) return null;
    switch (st.status) {
      case 'disabled':
        return '没有可用的更新服务';
      case 'checking':
        return '正在检查…';
      case 'available':
        return <Typography.Text type="success">发现新版本 {st.available?.version}</Typography.Text>;
      case 'not-available':
        return '已经是最新版本';
      case 'downloading':
        return `正在下载 ${Math.round(st.progress?.percent ?? 0)}%`;
      case 'downloaded':
        return <Typography.Text type="success">更新已下载，重启后安装</Typography.Text>;
      case 'error':
        return <Typography.Text type="danger">{st.error}</Typography.Text>;
      default:
        return st.error ?? (st.lastCheckAt ? '' : '还没有检查过');
    }
  };
  return (
    <SettingsSection title="关于">
      <div className="about-hero" data-testid="about-hero">
        <span onClick={tapLogo} data-testid="about-logo">
          <AppLogo size={72} />
        </span>
        <div>
          <div className="about-name">iTerminal</div>
          <Typography.Text type="secondary">AI 运维终端 · 版本 {info?.version}</Typography.Text>
        </div>
      </div>
      <SettingGroup>
        <SettingRow label="版本">
          <Typography.Text data-testid="about-version">{info?.version}</Typography.Text>
        </SettingRow>
        <SettingRow label="平台">
          <Typography.Text>{info?.platform}</Typography.Text>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="更新">
        <SettingRow label="检查更新" description={<span data-testid="update-status">{statusText()}</span>}>
          <Space>
            {st?.status === 'available' && (
              <Button type="primary" onClick={() => run(useUpdate.getState().download())} data-testid="update-download">
                下载更新{st.available?.size ? `（${(st.available.size / 1024 / 1024).toFixed(1)} MB）` : ''}
              </Button>
            )}
            {st?.status === 'downloaded' && (
              <Button type="primary" onClick={() => run(useUpdate.getState().install())} data-testid="update-install">
                重启并安装
              </Button>
            )}
            {st?.status === 'error' && st.available && (
              <>
                <Button onClick={() => run(useUpdate.getState().download())} data-testid="update-retry">
                  重新下载
                </Button>
                <Button onClick={() => run(useUpdate.getState().saveInstaller())} data-testid="update-manual">
                  手动下载安装包
                </Button>
              </>
            )}
            <Button loading={st?.status === 'checking'} disabled={!st?.feedUrl || st.status === 'downloading'} onClick={() => run(useUpdate.getState().check())} data-testid="update-check">
              检查更新
            </Button>
          </Space>
        </SettingRow>
        {st?.status === 'downloading' && st.progress && (
          <div style={{ padding: '0 18px 12px' }}>
            <Progress percent={Math.round(st.progress.percent)} size="small" />
          </div>
        )}
        {st?.savedFile && (
          <div style={{ padding: '0 18px 12px' }}>
            <SavedInstaller file={st.savedFile} />
          </div>
        )}
        {st?.available?.notes && (
          <SettingRow label={`${st.available.version} 更新内容`} description={<span className="update-notes" data-testid="update-notes">{st.available.notes}</span>} />
        )}
        <SettingRow label="更新渠道" description={st?.channelLocked ? '管理员已锁定更新渠道' : '测试版（beta）会更早收到新功能，可能不够稳定'}>
          <Segmented
            value={st?.channel ?? 'stable'}
            disabled={!st || st.channelLocked}
            onChange={(v) => run(useUpdate.getState().configure({ channel: v as 'stable' | 'beta' }))}
            options={[
              { value: 'stable', label: '正式版' },
              { value: 'beta', label: '测试版' },
            ]}
            data-testid="update-channel"
          />
        </SettingRow>
        <SettingRow label="自动检查" description="启动后和每 6 小时检查一次">
          <Switch checked={st?.autoCheck ?? true} onChange={(v) => run(useUpdate.getState().configure({ autoCheck: v }))} />
        </SettingRow>
      </SettingGroup>
      <AdminServerDialog open={adminOpen} onClose={() => setAdminOpen(false)} />
    </SettingsSection>
  );
}

/**
 * 设置搜索（第二十二轮）：输入框在左侧分类上面，有内容时分类列表换成搜索结果；点结果（或回车）打开对应页面，
 * 终端设置会切到对应分类，然后滚动到那一行并闪一下。索引见 search-index.ts
 */
function SettingsSearch({ query, onQuery, onPick }: { query: string; onQuery(q: string): void; onPick(item: SettingsSearchItem): void }): React.JSX.Element {
  const aiAllowed = useAiAllowed();
  const results = useMemo(() => searchSettings(query, aiAllowed), [query, aiAllowed]);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [query]);
  return (
    <>
      <Input
        className="settings-search"
        allowClear
        size="small"
        prefix={<SearchOutlined />}
        placeholder="搜索设置"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (!results.length) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length);
          } else if (e.key === 'Enter') onPick(results[active] ?? results[0]);
        }}
        data-testid="settings-search"
      />
      {query.trim() && (
        <div className="settings-search-results" data-testid="settings-search-results">
          {results.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到相关设置" />}
          {results.map((r, i) => (
            <div
              key={`${r.section}-${r.cat ?? ''}-${r.group ?? ''}-${r.label}`}
              className={`settings-search-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(r)}
              data-testid="settings-search-item"
            >
              <div className="settings-search-label">{r.label}</div>
              <div className="settings-search-path">{[SECTION_LABEL[r.section], r.cat ? TERMINAL_CAT_LABEL[r.cat] : null, r.group && r.group !== r.label ? r.group : null].filter(Boolean).join(' › ')}</div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** 搜到的设置：等页面渲染出来后滚动到对应的设置行 / 分组并闪一下（找不到时只打开页面） */
function useFlashTarget(): void {
  const target = useSettingsFocus((s) => s.target);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!target) return;
    let tries = 0;
    let raf = 0;
    const find = (): HTMLElement | null => {
      const body = document.querySelector('.settings-body');
      if (!body) return null;
      const candidates = [...body.querySelectorAll<HTMLElement>('.setting-row-label, .setting-group-title, .settings-section-head h2')];
      const text = (el: HTMLElement): string => (el.textContent ?? '').trim();
      const hit = candidates.find((el) => text(el) === target.label) ?? candidates.find((el) => text(el).includes(target.label));
      return (hit?.closest('.setting-row') ?? hit?.closest('.setting-group') ?? hit?.closest('.settings-section-head') ?? null) as HTMLElement | null;
    };
    const tick = (): void => {
      const el = find();
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        document.querySelectorAll('.settings-search-hit').forEach((x) => x.classList.remove('settings-search-hit'));
        el.classList.add('settings-search-hit');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => el.classList.remove('settings-search-hit'), 2000);
        // 定位完了：以后手动打开终端设置时回到默认分类
        useSettingsFocus.setState({ target: null });
        return;
      }
      if (++tries < 60) raf = requestAnimationFrame(tick);
      else useSettingsFocus.setState({ target: null });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target?.seq]);
}

export function SettingsPage(): React.JSX.Element {
  const section = normalizeSection(useApp((s) => s.settingsSection));
  const open = useApp((s) => s.openSettings);
  const [query, setQuery] = useState('');
  useFlashTarget();
  const group = groupOfSection(section);
  const bands = [...new Set(SETTINGS_GROUPS.map((g) => g.band))];
  // 离线使用（Guest）不能配置 AI：AI 分组的设置显示为灰色（第十二轮）
  const aiAllowed = useAiAllowed();
  const aiLocked = !aiAllowed && !!group.ai;
  const siderCollapsed = useApp((s) => s.siderCollapsed);

  return (
    <div className="settings-layout" data-testid="settings-page">
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title no-drag">
            <span className="topbar-page-name">设置</span>
            <span className="topbar-page-sub keep">{group.label}</span>
            {group.sections.length > 1 && (
              <div className="settings-tabs topbar-settings-tabs" role="tablist">
                {group.sections.map((s) => (
                  <button key={s.key} type="button" role="tab" aria-selected={s.key === section} className={`settings-tab ${s.key === section ? 'on' : ''}`} onClick={() => open(s.key)} data-testid={`settings-tab-${s.key}`}>
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </TopBarSlot>
      <CollapsibleSider collapsed={siderCollapsed} width={220}>
        <nav className="settings-nav">
          <div className="settings-nav-top" />
          <SettingsSearch
            query={query}
            onQuery={setQuery}
            onPick={(item) => {
              useSettingsFocus.getState().focus(item);
              open(item.section);
            }}
          />
          {!query.trim() &&
            bands.map((b) => (
              <div key={b}>
                <div className="settings-nav-group">{b}</div>
                {SETTINGS_GROUPS.filter((g) => g.band === b).map((g) => (
                  <div
                    key={g.key}
                    className={`settings-nav-item ${group.key === g.key ? 'active' : ''} ${g.ai && !aiAllowed ? 'locked' : ''}`}
                    onClick={() => open(g.sections[0].key)}
                    data-testid={`settings-nav-${g.key}`}
                  >
                    {GROUP_ICON[g.key]}
                    <span>{g.label}</span>
                    {g.ai && !aiAllowed && (
                      <Tooltip title="登录后可用">
                        <LockOutlined className="settings-nav-lock" />
                      </Tooltip>
                    )}
                  </div>
                ))}
              </div>
            ))}
        </nav>
      </CollapsibleSider>
      <div className="settings-main">
        <div className="settings-body">
          {aiLocked && (
            <Alert
              type="info"
              showIcon
              icon={<LockOutlined />}
              className="settings-ai-locked"
              message="登录后才能使用和配置 AI"
              action={
                <Button type="primary" icon={<LoginOutlined />} onClick={() => promptLogin()} data-testid="settings-ai-login">
                  登录
                </Button>
              }
              data-testid="settings-ai-locked"
            />
          )}
          <div key={section} className={`settings-content ${aiLocked ? 'ai-greyed' : ''}`}>
            {section === 'appearance' && <AppearanceSettings />}
            {section === 'terminal' && <TerminalSettings />}
            {section === 'transfer' && <TransferSettings />}
            {section === 'security' && <SecuritySettings />}
            {section === 'shortcuts' && <ShortcutSettings />}
            {section === 'storage' && <StorageSettings />}
            {section === 'models' && (
              <SettingsDescMode.Provider value="full">
                <ModelSettings />
              </SettingsDescMode.Provider>
            )}
            {section === 'agent' && <AgentSettings />}
            {section === 'skills' && <SkillSettings />}
            {section === 'cmdsec' && <CommandSecuritySettings />}
            {section === 'mcp' && <McpSettings />}
            {section === 'sync' && (
              <>
                <AccountCard />
                <SyncSettings />
              </>
            )}
            {section === 'feedback' && <FeedbackSettings />}
            {section === 'about' && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

const GROUP_ICON: Record<SettingsGroupKey, React.ReactNode> = {
  account: <UserOutlined />,
  general: <BgColorsOutlined />,
  terminal: <CodeOutlined />,
  security: <LockOutlined />,
  models: <RobotOutlined />,
  agent: <SafetyCertificateOutlined />,
  ext: <AppstoreOutlined />,
  storage: <DatabaseOutlined />,
  about: <InfoCircleOutlined />,
};
