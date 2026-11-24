import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, DatePicker, Dropdown, Input, Popconfirm, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, MoreOutlined, ReloadOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { AUDIT_SOURCE_LABEL, type AuditEntry, type AuditSourceKind, type Host, type RecordingInfo } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { useHosts } from '../../store/hosts';
import { useAccount } from '../../store/account';
import { openHost } from '../../actions';
import { RecordingNoteDialog, RecordingPlayer } from '../../components/RecordingPlayer';
import { useAiAllowed } from '../../util/ai-access';
import { TopBarSlot } from '../../components/TopBar';

const RISK: Record<string, { color: string; text: string }> = {
  L0: { color: 'green', text: 'L0' },
  L1: { color: 'orange', text: 'L1' },
  L2: { color: 'red', text: 'L2' },
  DENY: { color: 'magenta', text: '禁止' },
};
const DECISION: Record<string, string> = { AUTO: '自动', APPROVED: '已批准', REJECTED: '已拒绝', DENIED: '已禁止' };
const KIND_LABEL: Record<RecordingInfo['kind'], { text: string; color?: string }> = {
  ssh: { text: 'SSH', color: 'blue' },
  telnet: { text: 'TELNET', color: 'geekblue' },
  serial: { text: '串口', color: 'gold' },
  local: { text: '本机' },
  agent: { text: 'AI 后台', color: 'purple' },
  schedule: { text: '定时任务', color: 'cyan' },
};
/** 命令记录里「用户」一列：手动执行显示当前账号，其余显示执行者 */
const ACTOR: Record<AuditSourceKind, string> = { USER: '', AGENT: 'AI Agent', SKILL: 'Skill', SCHEDULE: '定时任务', MCP_EXTERNAL: '外部 Agent' };
const PAGE_SIZES = [10, 20, 50, 100];
const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const dur = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`;
};
const fmt = (t: number): string => dayjs(t).format('YYYY-MM-DD HH:mm:ss');

type Range = [Dayjs | null, Dayjs | null] | null;
const rangeArgs = (r: Range): { from?: number; to?: number } => ({
  ...(r?.[0] ? { from: r[0].startOf('day').valueOf() } : {}),
  ...(r?.[1] ? { to: r[1].endOf('day').valueOf() + 1 } : {}),
});

/** 当前登录的账号（本地模式为「本机」）：连接日志、命令记录里的「连接用户 / 用户」 */
function useActorName(): string {
  return useAccount((s) => (s.state && s.state.status !== 'none' ? s.state.displayName || s.state.username || '账号' : '本机'));
}

/** 主机名 + 地址（主机已删除时只显示记录里的名称） */
function HostCell({ name, host }: { name: string | null; host: Host | undefined }): React.JSX.Element {
  return (
    <div className="ops-host-cell">
      <div className="ops-host-name">{name || host?.name || '—'}</div>
      {host && <div className="ops-host-addr mono">{host.protocol === 'SERIAL' ? host.address : `${host.address}${host.port && host.port !== (host.protocol === 'TELNET' ? 23 : 22) ? `:${host.port}` : ''}`}</div>}
    </div>
  );
}

function hostOptions(hosts: Host[]): { value: string; label: string }[] {
  return hosts.map((h) => ({ value: h.id, label: `${h.name}（${h.address}）` }));
}

/**
 * 连接日志（第三十五轮）：每次连接（终端会话）一条，就是原来的「会话回放」——记录登录的用户名、开始和结束时间、时长，可以回放、AI 汇总、重新连接。
 */
function ConnectionLog(): React.JSX.Element {
  const { message } = App.useApp();
  const hosts = useHosts((s) => s.hosts);
  const hostMap = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);
  const actor = useActorName();
  const aiAllowed = useAiAllowed();
  const [hostId, setHostId] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [kind, setKind] = useState<string | null>(null);
  const [range, setRange] = useState<Range>(null);
  /** 点「搜索」才生效的条件 */
  const [applied, setApplied] = useState<{ hostId: string | null; username: string; kind: string | null; range: Range }>({ hostId: null, username: '', kind: null, range: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState<{ items: RecordingInfo[]; total: number; diskBytes: number }>({ items: [], total: 0, diskBytes: 0 });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState<RecordingInfo | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await invoke('recording.list', {
          hostId: applied.hostId,
          username: applied.username,
          kind: applied.kind,
          ...rangeArgs(applied.range),
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
      );
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [applied, page, pageSize, message]);
  useEffect(() => void load(), [load]);

  const search = (): void => {
    setPage(1);
    setApplied({ hostId, username, kind, range });
  };
  const reset = (): void => {
    setHostId(null);
    setUsername('');
    setKind(null);
    setRange(null);
    setPage(1);
    setApplied({ hostId: null, username: '', kind: null, range: null });
  };
  const remove = async (ids: string[]): Promise<void> => {
    try {
      await invoke('recording.delete', { ids });
      setSelected((s) => s.filter((x) => !ids.includes(x)));
      await load();
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <div className="ops-panel" data-testid="ops-connection-log">
      <div className="ops-filter-card">
        <div className="ops-filter-item">
          <span className="ops-filter-label">连接主机</span>
          <Select allowClear showSearch optionFilterProp="label" placeholder="请选择主机" value={hostId} onChange={(v) => setHostId(v ?? null)} options={hostOptions(hosts)} data-testid="conn-filter-host" />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">登录账号</span>
          <Input allowClear placeholder="请输入登录账号" value={username} onChange={(e) => setUsername(e.target.value)} onPressEnter={search} data-testid="conn-filter-user" />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">类型</span>
          <Select
            allowClear
            placeholder="请选择类型"
            value={kind}
            onChange={(v) => setKind(v ?? null)}
            options={(Object.keys(KIND_LABEL) as RecordingInfo['kind'][]).filter((k) => k !== 'schedule').map((k) => ({ value: k, label: KIND_LABEL[k].text }))}
          />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">连接时间</span>
          <DatePicker.RangePicker value={range} onChange={(v) => setRange(v as Range)} />
        </div>
        <div className="ops-filter-actions">
          <Button onClick={reset}>重置</Button>
          <Button type="primary" icon={<SearchOutlined />} onClick={search} data-testid="conn-search">
            搜索
          </Button>
        </div>
      </div>

      <div className="ops-table-card">
        <div className="ops-table-head">
          <span className="ops-table-title">连接日志</span>
          <Space size={8}>
            <Typography.Text type="secondary" className="ops-table-sub">
              录像共占用 {size(data.diskBytes)}
            </Typography.Text>
            <Popconfirm
              title={`删除选中的 ${selected.length} 条连接日志（含录像）？`}
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              disabled={!selected.length}
              onConfirm={() => remove(selected)}
            >
              <Button danger icon={<DeleteOutlined />} disabled={!selected.length} data-testid="conn-delete">
                删除
              </Button>
            </Popconfirm>
            <Tooltip title="刷新">
              <Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="刷新" />
            </Tooltip>
          </Space>
        </div>
        <Table<RecordingInfo>
          size="middle"
          rowKey="id"
          loading={loading}
          dataSource={data.items}
          data-testid="recording-table"
          rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), getCheckboxProps: (r) => ({ disabled: r.endedAt === null }) }}
          pagination={{
            current: page,
            pageSize,
            total: data.total,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZES,
            onChange: (p, ps) => {
              setPage(ps !== pageSize ? 1 : p);
              setPageSize(ps);
            },
            showTotal: (t) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '还没有连接日志。打开 SSH / Telnet / 串口终端后会自动记录并录像（可以在设置 → 安全与锁定里关闭）' }}
          tableLayout="auto"
          columns={[
            { title: '连接用户', key: 'actor', width: 110, render: (_, r) => (r.kind === 'agent' ? 'AI Agent' : r.kind === 'schedule' ? '定时任务' : actor) },
            { title: '连接主机', key: 'host', render: (_, r) => <HostCell name={r.hostName} host={r.hostId ? hostMap.get(r.hostId) : undefined} /> },
            { title: '登录账号', dataIndex: 'username', width: 110, render: (v: string | null) => (v ? <span className="mono">{v}</span> : <Typography.Text type="secondary">—</Typography.Text>) },
            { title: '类型', dataIndex: 'kind', width: 90, render: (v: RecordingInfo['kind']) => <Tag bordered={false} color={KIND_LABEL[v]?.color}>{KIND_LABEL[v]?.text ?? v.toUpperCase()}</Tag> },
            {
              title: '状态',
              key: 'status',
              width: 90,
              render: (_, r) => (r.endedAt === null ? <span className="ops-status running">进行中</span> : <span className="ops-status ok">完成</span>),
            },
            { title: '持续时间', dataIndex: 'durationMs', width: 110, render: (v: number, r) => (r.endedAt === null ? dur(Date.now() - r.startedAt) : dur(v)) },
            {
              title: '连接时间',
              key: 'time',
              width: 210,
              render: (_, r) => (
                <div className="ops-time-cell">
                  <div>从：{fmt(r.startedAt)}</div>
                  <div>至：{r.endedAt === null ? '—' : fmt(r.endedAt)}</div>
                </div>
              ),
            },
            {
              title: '操作',
              key: 'op',
              width: 240,
              render: (_, r) => {
                const host = r.hostId ? hostMap.get(r.hostId) : undefined;
                return (
                  <Space size={2} className="ops-ops">
                    <Button type="link" size="small" disabled={!host && r.kind !== 'local'} onClick={() => (host ? openHost(host, 'ssh') : undefined)} data-testid="conn-reconnect">
                      连接
                    </Button>
                    <Button type="link" size="small" onClick={() => setPlaying(r.id)} data-testid="recording-play">
                      回放
                    </Button>
                    <Tooltip title={!aiAllowed ? '登录后可用' : r.endedAt === null ? '连接结束后才能汇总' : '把执行的命令和输出交给 AI，整理成笔记'}>
                      <Button type="link" size="small" disabled={!aiAllowed || r.endedAt === null} onClick={() => setSummarizing(r)} data-testid="recording-summarize">
                        AI 汇总
                      </Button>
                    </Tooltip>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'size', label: `录像大小：${size(r.bytes)}${r.truncated ? '（已截断）' : ''}`, disabled: true },
                          { type: 'divider' },
                          { key: 'delete', label: '删除', danger: true, disabled: r.endedAt === null },
                        ],
                        onClick: ({ key }) => key === 'delete' && void remove([r.id]),
                      }}
                    >
                      <Button type="link" size="small" icon={<MoreOutlined />} aria-label="更多" />
                    </Dropdown>
                  </Space>
                );
              },
            },
          ]}
        />
      </div>
      <RecordingPlayer id={playing} onClose={() => setPlaying(null)} />
      {summarizing && (
        <RecordingNoteDialog open onClose={() => setSummarizing(null)} recordingId={summarizing.id} defaultTitle={`${summarizing.hostName} · ${dayjs(summarizing.startedAt).format('YYYY-MM-DD HH:mm')}`} />
      )}
    </div>
  );
}

/** 命令记录：手动、Agent、Skill、外部 MCP 执行的每一条命令；能对应到连接录像的可以直接回放 */
function CommandLog(): React.JSX.Element {
  const { message } = App.useApp();
  const hosts = useHosts((s) => s.hosts);
  const hostMap = useMemo(() => new Map(hosts.map((h) => [h.id, h])), [hosts]);
  const actor = useActorName();
  const [hostId, setHostId] = useState<string | null>(null);
  const [source, setSource] = useState<AuditSourceKind | null>(null);
  const [command, setCommand] = useState('');
  const [range, setRange] = useState<Range>(null);
  const [applied, setApplied] = useState<{ hostId: string | null; source: AuditSourceKind | null; command: string; range: Range }>({ hostId: null, source: null, command: '', range: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [data, setData] = useState<{ items: AuditEntry[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await invoke('audit.list', {
          kind: 'COMMAND',
          hostId: applied.hostId,
          source: applied.source,
          command: applied.command,
          ...rangeArgs(applied.range),
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
      );
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [applied, page, pageSize, message]);
  useEffect(() => void load(), [load]);

  const search = (): void => {
    setPage(1);
    setApplied({ hostId, source, command, range });
  };

  return (
    <div className="ops-panel" data-testid="ops-command-log">
      <div className="ops-filter-card">
        <div className="ops-filter-item">
          <span className="ops-filter-label">主机</span>
          <Select allowClear showSearch optionFilterProp="label" placeholder="请选择主机" value={hostId} onChange={(v) => setHostId(v ?? null)} options={hostOptions(hosts)} data-testid="cmd-filter-host" />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">用户</span>
          <Select
            allowClear
            placeholder="请选择用户"
            value={source}
            onChange={(v) => setSource(v ?? null)}
            options={(Object.keys(AUDIT_SOURCE_LABEL) as AuditSourceKind[]).filter((k) => k !== 'SCHEDULE').map((k) => ({ value: k, label: k === 'USER' ? `${actor}（手动）` : AUDIT_SOURCE_LABEL[k] }))}
            data-testid="audit-source"
          />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">命令</span>
          <Input allowClear placeholder="命令（包含）" value={command} onChange={(e) => setCommand(e.target.value)} onPressEnter={search} data-testid="audit-search-COMMAND" />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">时间</span>
          <DatePicker.RangePicker value={range} onChange={(v) => setRange(v as Range)} />
        </div>
        <div className="ops-filter-actions">
          <Button
            onClick={() => {
              setHostId(null);
              setSource(null);
              setCommand('');
              setRange(null);
              setPage(1);
              setApplied({ hostId: null, source: null, command: '', range: null });
            }}
          >
            重置
          </Button>
          <Button type="primary" icon={<SearchOutlined />} onClick={search} data-testid="cmd-search">
            查询
          </Button>
        </div>
      </div>

      <div className="ops-table-card">
        <div className="ops-table-head">
          <span className="ops-table-title">命令记录</span>
          <Tooltip title="刷新">
            <Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="刷新" />
          </Tooltip>
        </div>
        <Table<AuditEntry>
          size="middle"
          rowKey="id"
          loading={loading}
          dataSource={data.items}
          data-testid="audit-table-COMMAND"
          pagination={{
            current: page,
            pageSize,
            total: data.total,
            showSizeChanger: true,
            pageSizeOptions: PAGE_SIZES,
            onChange: (p, ps) => {
              setPage(ps !== pageSize ? 1 : p);
              setPageSize(ps);
            },
            showTotal: (t) => `共 ${t} 条`,
          }}
          tableLayout="auto"
          columns={[
            { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: number) => fmt(v) },
            {
              title: '用户',
              dataIndex: 'source',
              width: 110,
              render: (v: AuditSourceKind | null) =>
                !v || v === 'USER' ? actor : <Tag bordered={false} color={v === 'AGENT' ? 'purple' : v === 'MCP_EXTERNAL' ? 'orange' : undefined}>{ACTOR[v] || AUDIT_SOURCE_LABEL[v]}</Tag>,
            },
            { title: '主机', key: 'host', width: 180, render: (_, r) => <HostCell name={r.hostName} host={r.hostId ? hostMap.get(r.hostId) : undefined} /> },
            { title: '账号', dataIndex: 'account', width: 90, render: (v: string | null | undefined) => (v ? <span className="mono">{v}</span> : <Typography.Text type="secondary">—</Typography.Text>) },
            {
              title: '命令',
              dataIndex: 'command',
              render: (v: string, r) => (
                <Tooltip title={typeof r.detail?.explanation === 'string' ? `作用：${r.detail.explanation}` : undefined}>
                  <code className="mono audit-cmd">{v}</code>
                </Tooltip>
              ),
            },
            { title: '风险', dataIndex: 'risk', width: 70, render: (v: string | null) => (v && RISK[v] ? <Tag color={RISK[v].color}>{RISK[v].text}</Tag> : '') },
            {
              title: '结果',
              key: 'result',
              width: 110,
              render: (_, r) => {
                const decision = r.decision ? (DECISION[r.decision] ?? r.decision) : null;
                if (r.decision === 'REJECTED' || r.decision === 'DENIED') return <Typography.Text type="danger">{decision}</Typography.Text>;
                return (
                  <span className="ops-result">
                    {r.exitCode === null ? '执行' : r.exitCode === 0 ? '成功' : <Typography.Text type="danger">{`退出码 ${r.exitCode}`}</Typography.Text>}
                    {decision && r.decision !== 'AUTO' && <span className="ops-result-sub">{decision}</span>}
                  </span>
                );
              },
            },
            {
              title: '录像',
              key: 'rec',
              width: 70,
              render: (_, r) =>
                r.recordingId ? (
                  <Button type="link" size="small" onClick={() => setPlaying(r.recordingId!)} data-testid="cmd-play">
                    回放
                  </Button>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                ),
            },
          ]}
        />
      </div>
      <RecordingPlayer id={playing} onClose={() => setPlaying(null)} />
    </div>
  );
}

/**
 * 运维审计（文档一 6.12；第三十五轮由「审计&回放」改版）：顶部切换「连接日志」（每次连接一条，可回放）和「命令记录」。
 * 本地模式下只保存在本机；登录后由上报任务批量发给服务端。
 */
export function AuditPage(): React.JSX.Element {
  const retention = useApp((s) => s.settings['audit.retentionDays']);
  const recRetention = useApp((s) => s.settings['audit.recordingRetentionDays']);
  const [tab, setTab] = useState<'conn' | 'cmd'>('conn');
  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title no-drag">
            <span className="topbar-page-name">运维审计</span>
            <Segmented
              size="small"
              value={tab}
              onChange={(v) => setTab(v as typeof tab)}
              options={[
                { value: 'conn', label: <span data-testid="audit-tab-conn">连接日志</span> },
                { value: 'cmd', label: <span data-testid="audit-tab-cmd">命令记录</span> },
              ]}
              data-testid="audit-tabs"
            />
          </div>
          <div className="topbar-ctx-actions no-drag">
            <Space size={8}>
              <Typography.Text type="secondary" className="topbar-page-sub">
                本机保留：命令 {retention} 天 · 录像 {recRetention} 天
              </Typography.Text>
              <Button size="small" icon={<SettingOutlined />} onClick={() => useApp.getState().openSettings('security')}>
                录像设置
              </Button>
            </Space>
          </div>
        </div>
      </TopBarSlot>
      <div className="audit-body ops-audit">{tab === 'conn' ? <ConnectionLog /> : <CommandLog />}</div>
    </>
  );
}
