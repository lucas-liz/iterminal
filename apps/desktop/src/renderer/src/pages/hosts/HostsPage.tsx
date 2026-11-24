import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Dropdown, Empty, Input, Modal, Radio, Segmented, Select, Space, Switch, Table, Tag, Tooltip, TreeSelect, Typography, type MenuProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ShareAltOutlined,
  ApiOutlined,
  BookOutlined,
  FileMarkdownOutlined,
  RobotOutlined,
  CopyOutlined,
  EditOutlined,
  LinkOutlined,
  NodeIndexOutlined,
  LoadingOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  FolderOpenOutlined,
  CloseCircleOutlined,
  CloudServerOutlined,
  CloudSyncOutlined,
  CloudDownloadOutlined,
  CodeOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EllipsisOutlined,
  FolderOutlined,
  KeyOutlined,
  LockOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  StarFilled,
  StarOutlined,
  SwapOutlined,
  TagsOutlined,
  UploadOutlined,
  UsbOutlined,
} from '@ant-design/icons';
import type { AuthMethod, Host } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { openHost, openLocalShell, referHostsInAi } from '../../actions';
import { ALL_HOSTS, FAVORITES, folderLabel, folderOptions, useHosts, visibleHosts } from '../../store/hosts';
import { useVault } from '../../store/vault';
import { useApp } from '../../store/app';
import { useAccount } from '../../store/account';
import { useForwards } from '../../store/forwards';
import { useShare, useSharePull } from '../../store/share';
import { useSkillRun } from '../../components/agent/SkillRunDialog';
import { useLibrary } from '../../store/library';
import { formatRelative } from '../../util/format';
import { promptLogin, useAiAllowed } from '../../util/ai-access';
import { FolderTree, HOSTS_MIME } from './FolderTree';
import { ImportDialog } from './ImportDialog';
import { TopBarSlot } from '../../components/TopBar';
import { CollapsibleSider } from '../../components/CollapsibleSider';

const AUTH_LABEL: Record<AuthMethod, { text: string; icon: React.ReactNode }> = {
  PASSWORD: { text: '密码', icon: <LockOutlined /> },
  KEY: { text: '私钥', icon: <KeyOutlined /> },
  AGENT: { text: 'Agent', icon: <UsbOutlined /> },
  INTERACTIVE: { text: '询问', icon: <QuestionCircleOutlined /> },
  CREDENTIAL: { text: '凭证', icon: <SafetyCertificateOutlined /> },
};

const PROTOCOL_ICON = { SSH: <CloudServerOutlined />, TELNET: <ApiOutlined />, SERIAL: <UsbOutlined /> } as const;

export function HostsPage(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const state = useHosts();
  const [query, setQuery] = useState('');
  const setEditor = useHosts((s) => s.openEditor);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moving, setMoving] = useState<string[] | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [tagging, setTagging] = useState<{ add: string[]; remove: string[] } | null>(null);
  /** 导出对话框：要导出的主机（null = 当前全部） */
  const [exporting, setExporting] = useState<{ ids: string[] | null } | null>(null);
  /** 右键菜单：鼠标位置和右键的主机 */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; host: Host } | null>(null);
  /** Shift + 单击按范围选择的起点 */
  const anchor = useRef<string | null>(null);
  const aiAllowed = useAiAllowed();
  const credentials = useVault((s) => s.credentials);
  const allTags = useMemo(() => [...new Set(state.hosts.flatMap((h) => h.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [state.hosts]);

  const list = useMemo(() => visibleHosts(state, query), [state, query]);
  // 延迟：列表变化时测量（1 分钟内测过的跳过）
  const refreshLatency = useHosts((s) => s.refreshLatency);
  useEffect(() => {
    void refreshLatency(list.map((h) => h.id)).catch(() => undefined);
  }, [list, refreshLatency]);
  const selectedFolder = state.selected === ALL_HOSTS || state.selected === FAVORITES ? null : state.folders.find((f) => f.id === state.selected) ?? null;
  const currentFolderId = selectedFolder?.id ?? null;
  const loggedIn = useAccount((s) => s.state?.status === 'valid');
  const [syncing, setSyncing] = useState(false);
  const syncTeam = async (): Promise<void> => {
    setSyncing(true);
    try {
      const r = await invoke('team.sync');
      await state.reload();
      message.success(r.added || r.updated || r.removed ? `团队主机已同步：新增 ${r.added} 台，更新 ${r.updated} 台，删除 ${r.removed} 台` : '团队主机已是最新');
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  const remove = (hosts: Host[]): void => {
    modal.confirm({
      title: hosts.length === 1 ? `删除主机「${hosts[0].name}」？` : `删除选中的 ${hosts.length} 台主机？`,
      content: '保存的密码和私钥会一起删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await invoke('host.delete', { ids: hosts.map((h) => h.id) });
          setSelectedIds((ids) => ids.filter((id) => !hosts.some((h) => h.id === id)));
          await state.reload();
          message.success('已删除');
        } catch (e) {
          message.error(errorMessage(e));
        }
      },
    });
  };

  const duplicate = async (h: Host): Promise<void> => {
    try {
      await invoke('host.duplicate', { id: h.id });
      await state.reload();
      message.success('已复制');
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const toggleFavorite = async (h: Host): Promise<void> => {
    try {
      await invoke('host.favorite', { id: h.id, on: !h.favorite });
      await state.reload();
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const connect = (h: Host): void => {
    openHost(h, 'ssh');
  };

  /** 批量连接：每台主机打开一个终端标签；超过 10 台先确认 */
  const connectMany = (hosts: Host[]): void => {
    const go = (): void => {
      hosts.forEach((h) => openHost(h, 'ssh'));
      setSelectedIds([]);
    };
    if (hosts.length <= 10) return go();
    modal.confirm({ title: `同时连接 ${hosts.length} 台主机？`, content: '每台主机会打开一个终端标签。', okText: '连接', cancelText: '取消', onOk: go });
  };

  /**
   * 单击行选中 / 取消选中（和前面的复选框一样）；Shift + 单击从上一次点的行选到这一行。
   * 点在按钮、收藏、标签这些控件上时不改变选择；双击仍然是连接。
   */
  const onRowClick = (e: React.MouseEvent, h: Host): void => {
    if ((e.target as HTMLElement).closest('button, a, input, .ant-checkbox-wrapper, .ant-checkbox, .fav-star, .host-tag, .ant-dropdown-trigger')) return;
    const ids = list.map((x) => x.id);
    if (e.shiftKey && anchor.current && ids.includes(anchor.current)) {
      const a = ids.indexOf(anchor.current);
      const b = ids.indexOf(h.id);
      const range = ids.slice(Math.min(a, b), Math.max(a, b) + 1);
      setSelectedIds((prev) => [...new Set([...prev, ...range])]);
      return;
    }
    anchor.current = h.id;
    setSelectedIds((prev) => (prev.includes(h.id) ? prev.filter((x) => x !== h.id) : [...prev, h.id]));
  };

  /** 导出主机记忆（第三十轮）：手工填写的主机记忆 + Agent 记忆，保存成一个 Markdown 文件 */
  const exportMemory = async (hosts: Host[]): Promise<void> => {
    try {
      const { fileName, content } = await invoke('host.memoryMarkdown', { ids: hosts.map((h) => h.id) });
      const path = await invoke('dialog.saveText', { title: '导出主机记忆', defaultName: fileName, content, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (path) message.success('主机记忆已导出');
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  /** AI 汇总为笔记（第三十轮）：主机信息、记忆、最近 7 天监控、告警、定时任务、执行过的命令整理成一篇主机档案 */
  const summarizing = useRef(false);
  const summarizeNote = async (hosts: Host[]): Promise<void> => {
    if (!aiAllowed) return promptLogin();
    if (summarizing.current) return void message.info('上一次汇总还没完成');
    if (hosts.length > 20) return void message.warning('一次最多汇总 20 台主机');
    summarizing.current = true;
    const key = 'host-summary-note';
    message.loading({ key, content: `AI 正在汇总${hosts.length === 1 ? `「${hosts[0].name}」` : ` ${hosts.length} 台主机`}…`, duration: 0 });
    try {
      const { title, body } = await invoke('host.summaryNote', { ids: hosts.map((h) => h.id) });
      const note = await useLibrary.getState().saveAsNote(title, body);
      message.success({
        key,
        content: (
          <span>
            已用 AI 汇总为笔记「{note.title}」
            <Button type="link" size="small" onClick={() => useLibrary.getState().openNote(note.id)} data-testid="host-note-open">
              查看
            </Button>
          </span>
        ),
        duration: 6,
      });
    } catch (e) {
      message.error({ key, content: errorMessage(e) });
    } finally {
      summarizing.current = false;
    }
  };

  const startMove = (ids: string[], folderId: string | null): void => {
    setMoving(ids);
    setMoveTarget(folderId);
  };

  /** 单台主机的操作（右键菜单和行尾的 ···） */
  const hostItems = (h: Host): MenuProps['items'] => [
    { key: 'connect', label: '连接终端', icon: <CodeOutlined /> },
    { key: 'sftp', label: '打开 SFTP', icon: <FolderOpenOutlined />, disabled: h.protocol !== 'SSH' },
    { type: 'divider' },
    { key: 'edit', label: h.team ? '查看' : '编辑', icon: <EditOutlined /> },
    { key: 'dup', label: '复制主机', icon: <CopyOutlined /> },
    { key: 'copyAddr', label: '复制地址', icon: <LinkOutlined /> },
    { key: 'fav', label: h.favorite ? '取消收藏' : '收藏', icon: h.favorite ? <StarFilled /> : <StarOutlined /> },
    { key: 'move', label: '移动到分组…', icon: <SwapOutlined /> },
    { key: 'forward', label: '端口转发…', icon: <NodeIndexOutlined />, disabled: h.protocol !== 'SSH' },
    { key: 'skill', label: aiAllowed ? '运行 Skill…' : '运行 Skill…（登录后可用）', icon: <ThunderboltOutlined />, disabled: h.protocol !== 'SSH' || !aiAllowed },
    { key: 'ai-ref', label: aiAllowed ? '在 AI 中引用' : '在 AI 中引用（登录后可用）', icon: <RobotOutlined />, disabled: !aiAllowed },
    { key: 'ai-note', label: aiAllowed ? 'AI 汇总为笔记' : 'AI 汇总为笔记（登录后可用）', icon: <BookOutlined />, disabled: !aiAllowed },
    { key: 'export', label: '导出…', icon: <DownloadOutlined /> },
    { key: 'mem-export', label: '导出主机记忆（Markdown）…', icon: <FileMarkdownOutlined /> },
    { key: 'share', label: h.team ? '分享…（团队主机不能分享）' : '分享…', icon: <ShareAltOutlined />, disabled: !!h.team },
    { type: 'divider' },
    { key: 'delete', label: '删除', danger: true, icon: <DeleteOutlined /> },
  ];
  const onHostItem = (key: string, h: Host): void => {
    if (key === 'connect') connect(h);
    if (key === 'sftp') openHost(h, 'sftp');
    if (key === 'edit') setEditor({ mode: 'edit', host: h });
    if (key === 'dup') void duplicate(h);
    if (key === 'copyAddr') void navigator.clipboard.writeText(h.protocol === 'SERIAL' ? h.address : `${h.username ? `${h.username}@` : ''}${h.address}${h.port === (h.protocol === 'TELNET' ? 23 : 22) ? '' : `:${h.port}`}`).then(() => message.success('已复制地址'));
    if (key === 'fav') void toggleFavorite(h);
    if (key === 'move') startMove([h.id], h.folderId);
    if (key === 'forward') useForwards.getState().open(h.id);
    if (key === 'skill') useSkillRun.getState().show({ targets: { hostIds: [h.id] } });
    if (key === 'ai-ref') referHostsInAi([h]);
    if (key === 'ai-note') void summarizeNote([h]);
    if (key === 'export') setExporting({ ids: [h.id] });
    if (key === 'mem-export') void exportMemory([h]);
    if (key === 'share') useShare.getState().open({ hostIds: [h.id] });
    if (key === 'delete') remove([h]);
  };
  /** 右键的是已选中的多台主机之一：批量操作 */
  const batchItems = (n: number): MenuProps['items'] => [
    { key: 'b-connect', label: `连接选中的 ${n} 台`, icon: <PlayCircleOutlined /> },
    { key: 'b-move', label: '移动到分组…', icon: <SwapOutlined /> },
    { key: 'b-tag', label: '修改标签…', icon: <TagsOutlined /> },
    { key: 'b-skill', label: aiAllowed ? '运行 Skill…' : '运行 Skill…（登录后可用）', icon: <ThunderboltOutlined />, disabled: !aiAllowed },
    { key: 'b-ai-ref', label: aiAllowed ? '在 AI 中引用' : '在 AI 中引用（登录后可用）', icon: <RobotOutlined />, disabled: !aiAllowed },
    { key: 'b-ai-note', label: aiAllowed ? `AI 汇总这 ${n} 台为笔记` : 'AI 汇总为笔记（登录后可用）', icon: <BookOutlined />, disabled: !aiAllowed },
    { key: 'b-export', label: '导出…', icon: <DownloadOutlined /> },
    { key: 'b-mem-export', label: '导出主机记忆（Markdown）…', icon: <FileMarkdownOutlined /> },
    { key: 'b-share', label: `分享选中的 ${n} 台…`, icon: <ShareAltOutlined /> },
    { type: 'divider' },
    { key: 'b-delete', label: `删除选中的 ${n} 台`, danger: true, icon: <DeleteOutlined /> },
    { key: 'b-clear', label: '取消选择', icon: <CloseCircleOutlined /> },
  ];
  const onBatchItem = (key: string): void => {
    const hs = list.filter((h) => selectedIds.includes(h.id));
    if (key === 'b-connect') connectMany(hs);
    if (key === 'b-move') startMove(hs.map((h) => h.id), currentFolderId);
    if (key === 'b-tag') setTagging({ add: [], remove: [] });
    if (key === 'b-skill') useSkillRun.getState().show({ targets: { hostIds: hs.map((h) => h.id) } });
    if (key === 'b-ai-ref') referHostsInAi(hs);
    if (key === 'b-ai-note') void summarizeNote(hs);
    if (key === 'b-export') setExporting({ ids: hs.map((h) => h.id) });
    if (key === 'b-mem-export') void exportMemory(hs);
    if (key === 'b-share') useShare.getState().open({ hostIds: hs.map((h) => h.id) });
    if (key === 'b-delete') remove(hs);
    if (key === 'b-clear') setSelectedIds([]);
  };
  const ctxBatch = !!ctxMenu && selectedIds.length > 1 && selectedIds.includes(ctxMenu.host.id);

  const showFolderCol = state.selected === ALL_HOSTS || state.selected === FAVORITES || state.includeSub;
  const columns: ColumnsType<Host> = [
    {
      title: '',
      key: 'fav',
      width: 32,
      render: (_, h) => (
        <span className={`fav-star ${h.favorite ? 'on' : ''}`} onClick={(e) => (e.stopPropagation(), void toggleFavorite(h))} data-testid={`fav-${h.name}`}>
          {h.favorite ? <StarFilled /> : <StarOutlined />}
        </span>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      // 名称列不设宽度：占用其余的空间

      sorter: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
      ellipsis: true,
      render: (_, h) => (
        <span className="host-name">
          <span className="host-proto-icon">{PROTOCOL_ICON[h.protocol]}</span>
          <span className="host-name-text" title={h.name}>
            {h.name}
          </span>
          {h.team && (
            <Tooltip title={h.team.allowReveal ? '团队主机：管理员在服务端维护，只读' : '团队主机：管理员在服务端维护，只读；不能查看密码'}>
              <Tag bordered={false} color="purple" className="host-tag" data-testid={`team-host-${h.name}`}>
                团队
              </Tag>
            </Tooltip>
          )}
          {/* 标签最多显示两个，其余收成 +N（悬停查看），窄的时候也不会把名称挤掉 */}
          {h.tags.slice(0, 2).map((t) => (
            <Tag key={t} bordered={false} className="host-tag" onClick={(e) => (e.stopPropagation(), state.setTagFilter([t]))}>
              {t}
            </Tag>
          ))}
          {h.tags.length > 2 && (
            <Tooltip title={h.tags.slice(2).join('、')}>
              <Tag bordered={false} className="host-tag">{`+${h.tags.length - 2}`}</Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: '地址',
      key: 'address',
      width: 140,
      ellipsis: true,
      render: (_, h) => (
        <span className="host-addr">
          <span className="mono selectable host-addr-text">
            {h.protocol === 'SERIAL'
              ? `${h.address} · ${h.serial?.baudRate ?? ''}`
              : `${h.username ? `${h.username}@` : ''}${h.address}${h.port === (h.protocol === 'TELNET' ? 23 : 22) ? '' : `:${h.port}`}`}
          </span>
          {h.protocol !== 'SSH' && <Tag bordered={false}>{h.protocol === 'TELNET' ? 'Telnet' : '串口'}</Tag>}
          {h.proxy && <Tag bordered={false}>{h.proxy.type}</Tag>}
          {h.jumpHostIds.length > 0 && (
            <Tooltip title={`经 ${h.jumpHostIds.map((id) => state.hosts.find((x) => x.id === id)?.name ?? '（已删除）').join(' → ')} 跳转`}>
              <Tag bordered={false} color="purple">
                跳板 {h.jumpHostIds.length}
              </Tag>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      title: '认证',
      dataIndex: 'authMethod',
      width: 80,
      render: (m: AuthMethod, h) =>
        h.protocol === 'SERIAL' ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Tooltip title={m === 'CREDENTIAL' ? (h.credentialId ? credentials.find((c) => c.id === h.credentialId)?.name : '继承分组默认凭证') : undefined}>
            <Tag icon={AUTH_LABEL[m].icon} bordered={false}>
              {AUTH_LABEL[m].text}
            </Tag>
          </Tooltip>
        ),
    },
    ...(showFolderCol
      ? [
          {
            title: '分组',
            key: 'folder',
            width: 100,
            ellipsis: true,
            render: (_: unknown, h: Host) =>
              h.folderId ? (
                <Typography.Text type="secondary">
                  <FolderOutlined /> {folderLabel(state.folders, h.folderId)}
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
        ]
      : []),
    {
      title: (
        <span className="latency-head">
          延迟
          <Tooltip title="重新测量（直连主机的 TCP 连接耗时）">
            <ReloadOutlined className="latency-refresh" onClick={() => void refreshLatency(list.map((h) => h.id), true)} data-testid="latency-refresh" />
          </Tooltip>
        </span>
      ),
      key: 'latency',
      width: 96,
      sorter: (a, b) => (useHosts.getState().latency[a.id]?.ms ?? 1e9) - (useHosts.getState().latency[b.id]?.ms ?? 1e9),
      render: (_, h) => <LatencyCell host={h} />,
    },
    {
      title: '备注',
      dataIndex: 'note',
      width: 120,
      ellipsis: { showTitle: false },
      render: (v: string | null, h) =>
        v ? (
          <Tooltip title={<span style={{ whiteSpace: 'pre-wrap' }}>{v}</span>} placement="topLeft">
            <span className="host-note" data-testid={`host-note-${h.name}`}>
              {v}
            </span>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '最近连接',
      dataIndex: 'lastConnectedAt',
      width: 104,
      sorter: (a, b) => (a.lastConnectedAt ?? 0) - (b.lastConnectedAt ?? 0),
      render: (v: number | null) => <Typography.Text type="secondary">{formatRelative(v)}</Typography.Text>,
    },
    {
      title: '',
      key: 'actions',
      // 第二十六轮：只保留「连接」，SFTP 在右键菜单和 ··· 里
      width: 112,
      render: (_, h) => (
        <Space size={4} onClick={(e) => e.stopPropagation()}>
          <Button size="small" type="primary" ghost icon={<CodeOutlined />} onClick={() => connect(h)} data-testid={`connect-${h.name}`}>
            连接
          </Button>
          <Dropdown trigger={['click']} menu={{ items: hostItems(h), onClick: ({ key }) => onHostItem(key, h) }}>
            <Button size="small" type="text" icon={<EllipsisOutlined />} data-testid={`more-${h.name}`} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  const selectedHosts = list.filter((h) => selectedIds.includes(h.id));
  const siderCollapsed = useApp((s) => s.siderCollapsed);

  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title">
            <span className="topbar-page-name">主机</span>
            <span className="topbar-page-sub keep">{selectedFolder ? folderLabel(state.folders, selectedFolder.id) : state.selected === FAVORITES ? '收藏' : '全部主机'}</span>
          </div>
          <div className="topbar-ctx-actions no-drag">
            <Space size={6}>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'file', label: '从文件导入…', icon: <UploadOutlined /> },
                    { key: 'share', label: '从分享码导入…', icon: <CloudDownloadOutlined /> },
                  ],
                  onClick: ({ key }) => (key === 'share' ? useSharePull.getState().show('hosts') : setImporting(true)),
                }}
              >
                <Button size="small" icon={<UploadOutlined />} data-testid="import-hosts">
                  导入
                </Button>
              </Dropdown>
              <Button size="small" icon={<DownloadOutlined />} disabled={useApp.getState().info?.preset.allowLocalExport === false} onClick={() => setExporting({ ids: null })} data-testid="export-hosts-open">
                导出
              </Button>
              <Button size="small" icon={<CodeOutlined />} onClick={openLocalShell} data-testid="open-local">
                本地终端
              </Button>
              {loggedIn && (
                <Tooltip title="从服务端同步团队主机（连上服务端时和每 10 分钟会自动同步）">
                  <Button size="small" icon={<CloudSyncOutlined />} loading={syncing} onClick={() => void syncTeam()} data-testid="team-sync">
                    同步团队主机
                  </Button>
                </Tooltip>
              )}
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setEditor({ mode: 'create', folderId: selectedFolder?.team ? null : currentFolderId })}
                data-testid="new-host"
              >
                新建主机
              </Button>
            </Space>
          </div>
        </div>
      </TopBarSlot>
      <div className="hosts-body">
        <CollapsibleSider collapsed={siderCollapsed} width={236} gapOffset={10}>
          <FolderTree onCreateHost={(folderId) => setEditor({ mode: 'create', folderId })} />
        </CollapsibleSider>
        <div className="host-list">
          <div className="host-toolbar">
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索名称、地址、用户名、备注"
              style={{ width: 300 }}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="host-search"
            />
            {allTags.length > 0 && (
              <Select
                mode="multiple"
                allowClear
                size="middle"
                prefix={<TagsOutlined />}
                placeholder="按标签筛选"
                style={{ minWidth: 160, maxWidth: 320 }}
                value={state.tagFilter}
                onChange={state.setTagFilter}
                options={allTags.map((t) => ({ value: t, label: t }))}
                maxTagCount="responsive"
                data-testid="tag-filter"
              />
            )}
            {selectedFolder && (
              <Space size={6}>
                <Switch size="small" checked={state.includeSub} onChange={state.setIncludeSub} />
                <Typography.Text type="secondary">包含子分组</Typography.Text>
              </Space>
            )}
          </div>
          <div className="host-table">
            <Table<Host>
              size="middle"
              rowKey="id"
              columns={columns}
              dataSource={list}
              pagination={false}
              tableLayout="fixed"
              // 窗口很窄时横向滚动，而不是把文字挤到重叠
              // 名称列不设宽度、占其余空间：表格最小宽度保证名称至少 180px，窗口窄时横向滚动
              scroll={{ x: (showFolderCol ? 824 : 724) + 180, y: 'calc(100vh - 170px)' }}
              rowSelection={{ selectedRowKeys: selectedIds, onChange: (keys) => setSelectedIds(keys as string[]), columnWidth: 40 }}
              rowClassName={() => 'host-row'}
              onRow={(h) => ({
                onClick: (e) => onRowClick(e, h),
                // Shift + 单击时不要选中文字
                onMouseDown: (e) => e.shiftKey && e.preventDefault(),
                onDoubleClick: () => connect(h),
                onContextMenu: (e) => {
                  e.preventDefault();
                  setCtxMenu({ x: e.clientX, y: e.clientY, host: h });
                },
                draggable: true,
                onDragStart: (e: React.DragEvent) => {
                  const ids = selectedIds.includes(h.id) ? selectedIds : [h.id];
                  e.dataTransfer.setData(HOSTS_MIME, JSON.stringify(ids));
                  e.dataTransfer.effectAllowed = 'move';
                },
              })}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={query ? '没有匹配的主机' : state.hosts.length === 0 ? '还没有主机，先添加一台吧' : '这个分组里没有主机'}
                  >
                    {!query && (
                      <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor({ mode: 'create', folderId: currentFolderId })}>
                        新建主机
                      </Button>
                    )}
                  </Empty>
                ),
              }}
            />
          </div>
          {selectedHosts.length > 0 && (
            <SelectionBar
              count={selectedHosts.length}
              onConnect={() => connectMany(selectedHosts)}
              onMove={() => {
                setMoving(selectedHosts.map((h) => h.id));
                setMoveTarget(currentFolderId);
              }}
              onTag={() => setTagging({ add: [], remove: [] })}
              onExport={() => setExporting({ ids: selectedHosts.map((h) => h.id) })}
              aiAllowed={aiAllowed}
              onAi={(key) => (key === 'ref' ? referHostsInAi(selectedHosts) : key === 'note' ? void summarizeNote(selectedHosts) : void exportMemory(selectedHosts))}
              onShare={() => useShare.getState().open({ hostIds: selectedHosts.map((h) => h.id) })}
              onDelete={() => remove(selectedHosts)}
              onClear={() => setSelectedIds([])}
            />
          )}
        </div>
      </div>

      {/* 右键菜单：在鼠标位置放一个看不见的锚点 */}
      <Dropdown
        open={!!ctxMenu}
        onOpenChange={(o) => !o && setCtxMenu(null)}
        trigger={['contextMenu']}
        menu={{
          items: ctxMenu ? (ctxBatch ? batchItems(selectedIds.length) : hostItems(ctxMenu.host)) : [],
          onClick: ({ key }) => {
            const h = ctxMenu?.host;
            setCtxMenu(null);
            if (key.startsWith('b-')) onBatchItem(key);
            else if (h) onHostItem(key, h);
          },
        }}
        overlayClassName="host-ctx-menu"
      >
        <div className="ctx-anchor" style={{ left: ctxMenu?.x ?? -10, top: ctxMenu?.y ?? -10 }} data-testid="host-ctx-anchor" />
      </Dropdown>
      <ExportHostsDialog
        target={exporting}
        total={state.hosts.length}
        onClose={() => setExporting(null)}
      />
      <ImportDialog open={importing} onClose={() => setImporting(false)} defaultFolderId={currentFolderId} />
      <Modal
        open={!!tagging}
        title={`修改 ${selectedHosts.length} 台主机的标签`}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setTagging(null)}
        onOk={async () => {
          try {
            await invoke('host.tag', { hostIds: selectedHosts.map((h) => h.id), add: tagging!.add, remove: tagging!.remove });
            await state.reload();
            setTagging(null);
            message.success('标签已更新');
          } catch (e) {
            message.error(errorMessage(e));
          }
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>添加标签</Typography.Text>
          <Select mode="tags" style={{ width: '100%' }} value={tagging?.add} onChange={(add) => setTagging((t) => t && { ...t, add })} options={allTags.map((t) => ({ value: t, label: t }))} />
          <Typography.Text>移除标签</Typography.Text>
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            value={tagging?.remove}
            onChange={(remove) => setTagging((t) => t && { ...t, remove })}
            options={[...new Set(selectedHosts.flatMap((h) => h.tags))].map((t) => ({ value: t, label: t }))}
          />
        </Space>
      </Modal>

      <Modal
        open={!!moving}
        title={`移动 ${moving?.length ?? 0} 台主机`}
        okText="移动"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setMoving(null)}
        onOk={async () => {
          try {
            await invoke('host.move', { hostIds: moving!, folderId: moveTarget ?? null });
            await state.reload();
            setMoving(null);
            message.success('已移动');
          } catch (e) {
            message.error(errorMessage(e));
          }
        }}
      >
        <TreeSelect
          style={{ width: '100%' }}
          allowClear
          placeholder="不分组"
          value={moveTarget ?? undefined}
          onChange={(v) => setMoveTarget(v ?? null)}
          treeData={folderOptions(state.folders)}
          treeDefaultExpandAll
        />
      </Modal>
    </>
  );
}

/** 选中主机后在列表底部浮出的操作条（参考 iShell）：连接、移动、标签、导出、分享、删除 */
function SelectionBar({
  count,
  onConnect,
  onMove,
  onTag,
  onExport,
  aiAllowed,
  onAi,
  onShare,
  onDelete,
  onClear,
}: {
  count: number;
  onConnect(): void;
  onMove(): void;
  onTag(): void;
  onExport(): void;
  /** 没有登录时 AI 的两项不可用，导出主机记忆仍然可以 */
  aiAllowed: boolean;
  /** AI：引用 / 汇总为笔记 / 导出主机记忆 */
  onAi(key: 'ref' | 'note' | 'memory'): void;
  onShare(): void;
  onDelete(): void;
  onClear(): void;
}): React.JSX.Element {
  return (
    <div className="selection-bar" data-testid="selection-bar" role="toolbar" aria-label="批量操作">
      <span className="selection-count">
        已选择 <b>{count}</b> 台主机
      </span>
      <span className="selection-sep" />
      <button type="button" className="selection-act ok" onClick={onConnect} data-testid="batch-connect">
        <PlayCircleOutlined /> 连接
      </button>
      <button type="button" className="selection-act" onClick={onMove} data-testid="batch-move">
        <SwapOutlined /> 移动
      </button>
      <button type="button" className="selection-act" onClick={onTag} data-testid="batch-tag">
        <TagsOutlined /> 标签
      </button>
      <button type="button" className="selection-act" onClick={onExport} data-testid="batch-export">
        <DownloadOutlined /> 导出
      </button>
      <Dropdown
        trigger={['click']}
        placement="top"
        menu={{
          items: [
            { key: 'ref', label: aiAllowed ? '在 AI 中引用' : '在 AI 中引用（登录后可用）', icon: <RobotOutlined />, disabled: !aiAllowed },
            { key: 'note', label: aiAllowed ? 'AI 汇总为笔记' : 'AI 汇总为笔记（登录后可用）', icon: <BookOutlined />, disabled: !aiAllowed },
            { key: 'memory', label: '导出主机记忆（Markdown）…', icon: <FileMarkdownOutlined /> },
          ],
          onClick: ({ key }) => onAi(key as 'ref' | 'note' | 'memory'),
        }}
      >
        <button type="button" className="selection-act" data-testid="batch-ai">
          <RobotOutlined /> AI
        </button>
      </Dropdown>
      <button type="button" className="selection-act" onClick={onShare} data-testid="batch-share">
        <ShareAltOutlined /> 分享
      </button>
      <button type="button" className="selection-act danger" onClick={onDelete} data-testid="batch-delete">
        <DeleteOutlined /> 删除
      </button>
      <span className="selection-sep" />
      <Tooltip title="取消选择">
        <button type="button" className="selection-x" onClick={onClear} aria-label="取消选择" data-testid="batch-clear">
          <CloseCircleOutlined />
        </button>
      </Tooltip>
    </div>
  );
}

/** 延迟：绿 < 100ms、黄 < 300ms、红；经跳板机 / 代理的主机测试连接成功后显示那次的耗时 */
function LatencyCell({ host }: { host: Host }): React.JSX.Element {
  const p = useHosts((s) => s.latency[host.id]);
  const busy = useHosts((s) => !!s.pinging[host.id]);
  if (host.protocol === 'SERIAL') return <Typography.Text type="secondary">—</Typography.Text>;
  if (!p) return busy ? <LoadingOutlined className="latency-spin" /> : <Typography.Text type="secondary">—</Typography.Text>;
  if (p.ms == null) {
    if (p.skipped)
      return (
        <Tooltip title={p.skipped === 'jump' ? '经跳板机连接，不直接测量；测试连接成功后显示耗时' : '经代理连接，不直接测量；测试连接成功后显示耗时'}>
          <Typography.Text type="secondary" data-testid={`latency-${host.name}`}>
            —
          </Typography.Text>
        </Tooltip>
      );
    return (
      <Tooltip title={p.error ?? '连接失败'}>
        <span className="latency bad" data-testid={`latency-${host.name}`}>
          <span className="latency-dot" />
          {p.error === '超时' ? '超时' : '不通'}
        </span>
      </Tooltip>
    );
  }
  const level = p.ms < 100 ? 'good' : p.ms < 300 ? 'mid' : 'bad';
  return (
    <span className={`latency ${level}`} data-testid={`latency-${host.name}`}>
      <span className="latency-dot" />
      {p.ms} ms
    </span>
  );
}

/**
 * 导出主机（第十二轮）：格式 CSV / JSON；内容二选一——安全导出（不含密码、私钥、凭证）或者包含敏感信息
 * （密码、私钥，使用凭证的主机展开成主机自己的密码 / 私钥），包含敏感信息时先验证主密码。
 */
function ExportHostsDialog({ target, total, onClose }: { target: { ids: string[] | null } | null; total: number; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const masterPassword = useApp((s) => !!s.security?.masterPassword);
  const [format, setFormat] = useState<'CSV' | 'JSON'>('CSV');
  const [mode, setMode] = useState<'safe' | 'secrets'>('safe');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!target) return;
    setMode('safe');
    setPassword('');
  }, [target]);
  const count = target?.ids ? target.ids.length : total;

  const run = async (): Promise<void> => {
    if (!target) return;
    if (mode === 'secrets' && masterPassword && !password) {
      message.warning('请输入主密码');
      return;
    }
    const path = await invoke('dialog.saveFile', {
      title: '导出主机列表',
      defaultName: `iterminal-hosts${mode === 'secrets' ? '-secrets' : ''}.${format.toLowerCase()}`,
      filters: [{ name: format, extensions: [format.toLowerCase()] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const r = await invoke('export.hosts', { format, path, hostIds: target.ids, includeSecrets: mode === 'secrets', password: mode === 'secrets' && masterPassword ? password : undefined });
      message.success(mode === 'secrets' ? `已导出 ${r.count} 台主机（${r.secrets} 台带密码或私钥）` : `已导出 ${r.count} 台主机（不含密码和私钥）`);
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title={`导出主机（${count} 台）`}
      okText="导出…"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void run()}
      onCancel={onClose}
      okButtonProps={{ danger: mode === 'secrets', ['data-testid' as never]: 'export-ok' }}
      destroyOnHidden
      width={500}
    >
      <div className="export-form" data-testid="export-dialog">
        <div className="export-row">
          <span className="export-label">格式</span>
          <Segmented
            value={format}
            onChange={(v) => setFormat(v as 'CSV' | 'JSON')}
            options={[
              { label: 'CSV（可用 Excel 编辑）', value: 'CSV' },
              { label: 'JSON', value: 'JSON' },
            ]}
            data-testid="export-format"
          />
        </div>
        <div className="export-row top">
          <span className="export-label">内容</span>
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value)} className="export-modes">
            <Radio value="safe" data-testid="export-mode-safe">
              <span className="export-mode-title">安全导出（推荐）</span>
              <span className="export-mode-desc">不含密码、私钥和凭证，导入后连接时再输入</span>
            </Radio>
            <Radio value="secrets" data-testid="export-mode-secrets">
              <span className="export-mode-title">包含敏感信息</span>
              <span className="export-mode-desc">连同密码、私钥和凭证一起导出（使用凭证的主机展开成主机自己的密码 / 私钥）</span>
            </Radio>
          </Radio.Group>
        </div>
        {mode === 'secrets' && (
          <>
            <Alert type="warning" showIcon message="导出的文件是明文，任何拿到文件的人都能看到密码和私钥。请妥善保管，用完及时删除。" />
            {masterPassword && (
              <div className="export-row">
                <span className="export-label">主密码</span>
                <Input.Password value={password} onChange={(e) => setPassword(e.target.value)} placeholder="验证主密码后导出" autoComplete="current-password" onPressEnter={() => void run()} data-testid="export-password" />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
