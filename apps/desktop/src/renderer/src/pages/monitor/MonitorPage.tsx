import { useEffect, useMemo, useState } from 'react';
import { App, Button, Dropdown, Empty, Input, Segmented, Select, Space, Tooltip, Typography, type MenuProps } from 'antd';
import {
  CodeOutlined,
  DashboardOutlined,
  DisconnectOutlined,
  EditOutlined,
  ExclamationCircleFilled,
  FolderOpenOutlined,
  LineChartOutlined,
  LinkOutlined,
  MessageOutlined,
  PlusOutlined,
  PushpinFilled,
  PushpinOutlined,
  RobotOutlined,
  SearchOutlined,
  WarningFilled,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { DEFAULT_MONITOR_ALERT, usageLevel, type DiskForecast, type Host, type MetricsSnapshot, type MonitorAlertConfig } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { useHosts } from '../../store/hosts';
import { useTabs } from '../../store/tabs';
import { useMonitor } from '../../store/monitor';
import { formatRate, formatUptime, pct } from '../../util/metrics';
import { attentionOf, cardQuoteText, hostMatches, LEVEL_RANK, uptimeMatches, type CardLevel, type UptimeFilter } from '../../util/monitor-attention';
import { Meter, Sparkline } from '../../components/monitor/Sparkline';
import { MonitorDrawer } from '../../components/monitor/MonitorDrawer';
import { askDiskAnalysis } from '../../components/monitor/MonitorHistory';
import { openHost, referHostsInAi } from '../../actions';
import { ResidentPicker } from './ResidentPicker';
import { TopBarSlot } from '../../components/TopBar';

const LEVEL_TEXT: Record<CardLevel, string> = { crit: '偏高', warn: '注意', ok: '正常', offline: '连不上', unsupported: '不支持', pending: '连接中' };
const METER_COLOR = { ok: 'var(--itm-primary)', warn: '#faad14', crit: '#ff4d4f' } as const;

type Scope = 'all' | 'resident' | 'session';
type StatusFilter = '' | 'issue' | 'ok' | 'offline';
type SortKey = 'attention' | 'name' | 'cpu' | 'mem' | 'disk' | 'uptime' | 'added';

/** 页面打开期间订阅这些主机的监控（筛选掉的卡片也保持订阅，数据不过期） */
function useSubscriptions(ids: string[]): void {
  const key = [...ids].sort().join(',');
  useEffect(() => {
    const list = key ? key.split(',') : [];
    list.forEach((hostId) => void invoke('monitor.subscribe', { hostId }));
    return () => list.forEach((hostId) => void invoke('monitor.unsubscribe', { hostId }));
  }, [key]);
}

/** 磁盘写满预测（最近 7 天），10 分钟刷新一次 */
function useForecasts(ids: string[]): Record<string, DiskForecast[]> {
  const key = [...ids].sort().join(',');
  const [map, setMap] = useState<Record<string, DiskForecast[]>>({});
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(',') : [];
    const load = (): void => {
      void Promise.all(list.map((hostId) => invoke('monitor.history', { hostId, days: 7 }).then((r) => [hostId, r.forecast] as const).catch(() => [hostId, []] as const))).then((rows) => alive && setMap(Object.fromEntries(rows)));
    };
    load();
    const t = setInterval(load, 10 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key]);
  return map;
}

const okSnap = (s: MetricsSnapshot | undefined): Extract<MetricsSnapshot, { state: 'ok' }> | null => (s && s.state === 'ok' ? s : null);

/** 一台主机的卡片：状态、需要注意的地方、CPU 趋势、内存、最满的分区、负载、网络、运行时长 */
function HostCard({
  host,
  resident,
  since,
  cfg,
  forecast,
  onToggle,
  onOpen,
  onMenu,
}: {
  host: Host;
  resident: boolean;
  since: number | null;
  cfg: MonitorAlertConfig;
  forecast: DiskForecast[];
  onToggle(): void;
  onOpen(): void;
  /** 右键菜单（第三十轮） */
  onMenu(e: React.MouseEvent): void;
}): React.JSX.Element {
  const snap = useMonitor((s) => s.latest[host.id]);
  const history = useMonitor((s) => s.history[host.id]);
  const alerts = useMonitor((s) => s.alerts);
  const att = attentionOf(snap, cfg, forecast, alerts);
  const ok = okSnap(snap);

  let body: React.ReactNode;
  if (!snap) body = <Typography.Text type="secondary">正在连接…</Typography.Text>;
  else if (!ok) {
    body = (
      <div className="mon-card-offline">
        {snap.state === 'unsupported' ? <DashboardOutlined /> : <DisconnectOutlined />}
        <Typography.Text type="secondary">{snap.state !== 'ok' ? snap.message : ''}</Typography.Text>
      </div>
    );
  } else {
    const memPct = pct(ok.mem.used, ok.mem.total);
    const fullest = [...ok.disks].sort((a, b) => b.usePct - a.usePct)[0];
    const rx = ok.net.reduce((a, n) => a + n.rxBps, 0);
    const tx = ok.net.reduce((a, n) => a + n.txBps, 0);
    const cpuLv = ok.cpu ? usageLevel(ok.cpu.usage, cfg.cpu) : 'ok';
    body = (
      <>
        <div className="mon-card-cpu">
          <div>
            <div className="mon-card-label">CPU</div>
            <div className={`mon-card-big lv-${cpuLv}`} data-testid={`mon-cpu-${host.name}`}>
              {ok.cpu ? `${ok.cpu.usage.toFixed(1)}%` : '—'}
            </div>
            {ok.cpu && <div className="mon-card-tiny">{`${ok.cpu.cores} 核 · 负载 ${ok.load[0].toFixed(2)}`}</div>}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Sparkline values={(history ?? []).map((p) => p.cpu)} max={100} fluid width={200} height={44} color={METER_COLOR[cpuLv]} />
          </div>
        </div>
        <div className="mon-card-row">
          <span className="mon-card-label">内存</span>
          <Meter percent={memPct} color={METER_COLOR[usageLevel(memPct, cfg.mem)]} />
          <span className="mon-card-val">{`${memPct.toFixed(0)}%`}</span>
        </div>
        {fullest && (
          <Tooltip title={<pre className="tooltip-pre">{ok.disks.map((d) => `${d.mount}  ${d.usePct.toFixed(0)}%`).join('\n')}</pre>}>
            <div className="mon-card-row">
              <span className="mon-card-label mono">{fullest.mount}</span>
              <Meter percent={fullest.usePct} color={METER_COLOR[usageLevel(fullest.usePct, cfg.disk)]} />
              <span className="mon-card-val">{`${fullest.usePct.toFixed(0)}%`}</span>
            </div>
          </Tooltip>
        )}
        <div className="mon-card-meta">
          {ok.disks.length > 1 && <span>{`${ok.disks.length} 个分区`}</span>}
          {ok.net.length > 0 && <span className="mono">{`↓${formatRate(rx)} ↑${formatRate(tx)}`}</span>}
          {ok.uptimeSec > 0 && <span title="系统运行时长（上次开机到现在）">{`已运行 ${formatUptime(ok.uptimeSec)}`}</span>}
        </div>
      </>
    );
  }

  return (
    <div
      className={`mon-card lv-${att.level}`}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
      data-testid={`mon-card-${host.name}`} data-level={att.level}>
      <div className="mon-card-head">
        <span className={`mon-dot lv-${att.level}`} />
        <span className="mon-card-name" title={host.name}>
          {host.name}
        </span>
        <Typography.Text type="secondary" className="mono mon-card-addr">
          {host.address}
        </Typography.Text>
        <span className="mon-card-actions" onClick={(e) => e.stopPropagation()}>
          <Tooltip title="打开终端">
            <Button size="small" type="text" icon={<CodeOutlined />} onClick={() => openHost(host, 'ssh')} aria-label="打开终端" />
          </Tooltip>
          <Tooltip title={resident ? '取消常驻（不再在后台采集）' : '设为常驻：应用运行期间在后台持续采集和告警'}>
            <Button size="small" type="text" icon={resident ? <PushpinFilled /> : <PushpinOutlined />} className={resident ? 'pinned' : ''} onClick={onToggle} data-testid={`mon-pin-${host.name}`} aria-label={resident ? '取消常驻' : '设为常驻'} />
          </Tooltip>
        </span>
      </div>
      <div className="mon-card-status" data-testid={`mon-status-${host.name}`}>
        {att.items.length === 0 ? (
          <span className={`mon-pill lv-${att.level}`}>{att.level === 'ok' ? '一切正常' : LEVEL_TEXT[att.level]}</span>
        ) : (
          att.items.slice(0, 4).map((a) => (
            <span key={a.kind + a.text} className={`mon-pill lv-${a.level}`} data-testid={a.kind === 'forecast' ? `mon-forecast-${host.name}` : undefined}>
              {a.level === 'crit' ? <ExclamationCircleFilled /> : <WarningFilled />}
              {a.kind === 'offline' ? '连不上' : a.text}
              {a.kind === 'forecast' && (
                <RobotOutlined
                  className="mon-pill-ai"
                  title="让 AI 分析"
                  onClick={(e) => {
                    e.stopPropagation();
                    const f = forecast.find((x) => a.text.startsWith(x.mount));
                    if (f) askDiskAnalysis(host.id, host.name, f);
                  }}
                />
              )}
            </span>
          ))
        )}
        {att.items.length > 4 && <span className="mon-pill">{`+${att.items.length - 4}`}</span>}
      </div>
      <div className="mon-card-body">{body}</div>
      {(host.note || (resident && since)) && (
        <div className="mon-card-foot">
          {host.note && (
            <span className="mon-card-note" title={host.note}>
              {host.note}
            </span>
          )}
          {resident && since && <span className="mon-card-since">{`${dayjs(since).format('MM-DD')} 加入常驻`}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * 监控（文档一 6.4，第二十七轮改版；第三十五轮去掉告警，只查看）：分成「常驻监控」（应用运行期间在后台持续采集）和「随终端」（打开了 SSH 终端的主机）。
 * 卡片直接标出需要注意的地方；可以按名称 / IP / 备注 / 标签搜索，按状态、运行时长筛选，按需要注意的程度、资源占用、运行时长排序。
 */
export function MonitorPage(): React.JSX.Element {
  const { message } = App.useApp();
  const hosts = useHosts((s) => s.hosts);
  const tabs = useTabs((s) => s.tabs);
  const pinnedIds = useApp((s) => s.settings['monitor.dashboardHosts']);
  const sinceMap = useApp((s) => s.settings['monitor.residentSince']) ?? {};
  const cfg = useApp((s) => s.settings['monitor.alert']) ?? DEFAULT_MONITOR_ALERT;
  const update = useApp((s) => s.updateSetting);
  const latest = useMonitor((s) => s.latest);
  const alerts = useMonitor((s) => s.alerts);
  const [detail, setDetail] = useState<Host | null>(null);
  /** 卡片右键菜单：鼠标位置和右键的主机 */
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; host: Host } | null>(null);
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [status, setStatus] = useState<StatusFilter>('');
  const [uptime, setUptime] = useState<UptimeFilter>('');
  const [sort, setSort] = useState<SortKey>('attention');

  useEffect(() => {
    void useMonitor.getState().loadAlerts().catch(() => undefined);
  }, []);

  const ssh = useMemo(() => new Map(hosts.filter((h) => h.protocol === 'SSH').map((h) => [h.id, h])), [hosts]);
  const resident = useMemo(() => pinnedIds.map((id) => ssh.get(id)).filter((h): h is Host => !!h), [pinnedIds, ssh]);
  const openIds = useMemo(() => [...new Set(tabs.filter((t) => t.kind === 'ssh' && t.status === 'ready' && t.hostId).map((t) => t.hostId!))], [tabs]);
  const session = useMemo(() => openIds.filter((id) => !pinnedIds.includes(id)).map((id) => ssh.get(id)).filter((h): h is Host => !!h), [openIds, pinnedIds, ssh]);
  const allIds = useMemo(() => [...resident, ...session].map((h) => h.id), [resident, session]);
  useSubscriptions(allIds);
  const forecasts = useForecasts(allIds);

  const levelOf = (h: Host): CardLevel => attentionOf(latest[h.id], cfg, forecasts[h.id], alerts).level;
  const counts = useMemo(() => {
    const c = { issue: 0, crit: 0, offline: 0, ok: 0 };
    for (const h of [...resident, ...session]) {
      const lv = levelOf(h);
      if (lv === 'crit' || lv === 'warn') c.issue++;
      if (lv === 'crit') c.crit++;
      if (lv === 'offline') c.offline++;
      if (lv === 'ok') c.ok++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resident, session, latest, cfg, forecasts, alerts]);

  const arrange = (list: Host[]): Host[] => {
    const filtered = list.filter((h) => {
      if (!hostMatches(h, q)) return false;
      const lv = levelOf(h);
      if (status === 'issue' && lv !== 'crit' && lv !== 'warn') return false;
      if (status === 'ok' && lv !== 'ok') return false;
      if (status === 'offline' && lv !== 'offline' && lv !== 'unsupported') return false;
      return uptimeMatches(okSnap(latest[h.id])?.uptimeSec ?? null, uptime);
    });
    const num = (h: Host, f: (s: Extract<MetricsSnapshot, { state: 'ok' }>) => number): number => {
      const s = okSnap(latest[h.id]);
      return s ? f(s) : -1;
    };
    const by: Record<SortKey, (a: Host, b: Host) => number> = {
      attention: (a, b) => LEVEL_RANK[levelOf(a)] - LEVEL_RANK[levelOf(b)] || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      cpu: (a, b) => num(b, (s) => s.cpu?.usage ?? 0) - num(a, (s) => s.cpu?.usage ?? 0),
      mem: (a, b) => num(b, (s) => pct(s.mem.used, s.mem.total)) - num(a, (s) => pct(s.mem.used, s.mem.total)),
      disk: (a, b) => num(b, (s) => Math.max(0, ...s.disks.map((d) => d.usePct))) - num(a, (s) => Math.max(0, ...s.disks.map((d) => d.usePct))),
      uptime: (a, b) => (num(a, (s) => s.uptimeSec) < 0 ? 1 : num(b, (s) => s.uptimeSec) < 0 ? -1 : num(a, (s) => s.uptimeSec) - num(b, (s) => s.uptimeSec)),
      added: (a, b) => (sinceMap[b.id] ?? 0) - (sinceMap[a.id] ?? 0),
    };
    return filtered.sort(by[sort]);
  };

  const setResident = async (ids: string[]): Promise<void> => {
    const since: Record<string, number> = {};
    for (const id of ids) since[id] = sinceMap[id] ?? Date.now();
    try {
      await update('monitor.dashboardHosts', ids);
      await update('monitor.residentSince', since);
    } catch (e) {
      void message.error(errorMessage(e));
    }
  };
  const toggle = (h: Host): void => {
    if (pinnedIds.includes(h.id)) void setResident(pinnedIds.filter((x) => x !== h.id));
    else void setResident([...pinnedIds, h.id]).then(() => message.success(`「${h.name}」已设为常驻监控`));
  };

  /** 卡片右键菜单（第三十轮）：快速打开终端 / SFTP、在 AI 对话里引用主机或当前状态、详情、常驻、编辑、复制地址 */
  const cardItems = (h: Host): MenuProps['items'] => [
    { key: 'term', label: '打开终端', icon: <CodeOutlined /> },
    { key: 'sftp', label: '打开 SFTP', icon: <FolderOpenOutlined /> },
    { type: 'divider' },
    { key: 'ai-host', label: '在 AI 中引用这台主机', icon: <RobotOutlined /> },
    { key: 'ai-state', label: '引用当前状态到 AI 对话', icon: <MessageOutlined /> },
    { type: 'divider' },
    { key: 'detail', label: '查看详情（历史、进程）', icon: <LineChartOutlined /> },
    { key: 'pin', label: pinnedIds.includes(h.id) ? '取消常驻' : '设为常驻', icon: pinnedIds.includes(h.id) ? <PushpinFilled /> : <PushpinOutlined /> },
    { key: 'edit', label: h.team ? '查看主机' : '编辑主机', icon: <EditOutlined /> },
    { key: 'copy', label: '复制地址', icon: <LinkOutlined /> },
  ];
  const onCardItem = (key: string, h: Host): void => {
    if (key === 'term') openHost(h, 'ssh');
    if (key === 'sftp') openHost(h, 'sftp');
    if (key === 'ai-host') referHostsInAi([h]);
    if (key === 'ai-state') referHostsInAi([h], cardQuoteText(h, latest[h.id], attentionOf(latest[h.id], cfg, forecasts[h.id], alerts).items));
    if (key === 'detail') setDetail(h);
    if (key === 'pin') toggle(h);
    if (key === 'edit') useHosts.getState().openEditor({ mode: 'edit', host: h });
    if (key === 'copy') void navigator.clipboard.writeText(`${h.username ? `${h.username}@` : ''}${h.address}${h.port === 22 ? '' : `:${h.port}`}`).then(() => message.success('已复制地址'));
  };

  const card = (h: Host): React.JSX.Element => (
    <HostCard
      key={h.id}
      host={h}
      resident={pinnedIds.includes(h.id)}
      since={sinceMap[h.id] ?? null}
      cfg={cfg}
      forecast={forecasts[h.id] ?? []}
      onToggle={() => toggle(h)}
      onOpen={() => setDetail(h)}
      onMenu={(e) => setCtxMenu({ x: e.clientX, y: e.clientY, host: h })}
    />
  );
  const residentShown = scope === 'session' ? [] : arrange(resident);
  const sessionShown = scope === 'resident' ? [] : arrange(session);
  const filtering = !!(q.trim() || status || uptime);
  const total = resident.length + session.length;

  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title no-drag">
            <span className="topbar-page-name">监控</span>
            <span className="topbar-page-sub">{`常驻 ${resident.length} 台 · 随终端 ${session.length} 台`}</span>
          </div>
          <div className="topbar-ctx-actions no-drag">
            <Space size={6}>
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setPicking(true)} data-testid="mon-add">
                添加常驻主机
              </Button>
            </Space>
          </div>
        </div>
      </TopBarSlot>
      <div className="mon-body">
        {total > 0 && (
          <div className="mon-toolbar">
            <div className="mon-summary">
              <button type="button" className={`mon-sum lv-crit ${status === 'issue' ? 'active' : ''}`} onClick={() => setStatus(status === 'issue' ? '' : 'issue')} data-testid="mon-sum-issue">
                <b>{counts.issue}</b> 需要注意{counts.crit ? `（${counts.crit} 台偏高）` : ''}
              </button>
              <button type="button" className={`mon-sum lv-offline ${status === 'offline' ? 'active' : ''}`} onClick={() => setStatus(status === 'offline' ? '' : 'offline')}>
                <b>{counts.offline}</b> 连不上
              </button>
              <button type="button" className={`mon-sum lv-ok ${status === 'ok' ? 'active' : ''}`} onClick={() => setStatus(status === 'ok' ? '' : 'ok')}>
                <b>{counts.ok}</b> 正常
              </button>
            </div>
            <Input allowClear prefix={<SearchOutlined />} placeholder="名称 / IP / 备注 / 标签" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} data-testid="mon-search" />
            <Segmented
              value={scope}
              onChange={(v) => setScope(v as Scope)}
              options={[
                { value: 'all', label: '全部' },
                { value: 'resident', label: `常驻 ${resident.length}` },
                { value: 'session', label: `随终端 ${session.length}` },
              ]}
              data-testid="mon-scope"
            />
            <Select
              value={uptime}
              onChange={setUptime}
              style={{ width: 150 }}
              options={[
                { value: '', label: '运行时长：不限' },
                { value: 'recent', label: '1 天内重启过' },
                { value: 'month', label: '运行超过 30 天' },
                { value: 'half', label: '运行超过 180 天' },
              ]}
              data-testid="mon-uptime"
            />
            <Select
              value={sort}
              onChange={setSort}
              style={{ width: 150 }}
              options={[
                { value: 'attention', label: '需要注意的在前' },
                { value: 'name', label: '按名称' },
                { value: 'cpu', label: 'CPU 从高到低' },
                { value: 'mem', label: '内存从高到低' },
                { value: 'disk', label: '磁盘从高到低' },
                { value: 'uptime', label: '运行时长从短到长' },
                { value: 'added', label: '最近加入常驻' },
              ]}
              data-testid="mon-sort"
            />
          </div>
        )}

        {scope !== 'session' && (
          <section className="mon-section" data-testid="mon-section-resident">
            <div className="mon-section-head">
              <PushpinFilled className="mon-section-icon resident" />
              <span className="mon-section-title">常驻监控</span>
              <Typography.Text type="secondary" className="mon-section-desc">
                应用运行期间在后台持续采集，不用打开终端，随时查看
              </Typography.Text>
            </div>
            {resident.length === 0 ? (
              <div className="mon-empty">
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有常驻主机。把需要一直盯着的服务器加进来：后台持续采集历史数据，随时查看" />
                <Button type="primary" ghost icon={<PlusOutlined />} onClick={() => setPicking(true)}>
                  添加常驻主机
                </Button>
              </div>
            ) : residentShown.length === 0 ? (
              <Typography.Text type="secondary" className="mon-none">
                没有符合条件的常驻主机
              </Typography.Text>
            ) : (
              <div className="mon-grid">{residentShown.map(card)}</div>
            )}
          </section>
        )}

        {scope !== 'resident' && (
          <section className="mon-section" data-testid="mon-section-session">
            <div className="mon-section-head">
              <CodeOutlined className="mon-section-icon" />
              <span className="mon-section-title">随终端</span>
              <Typography.Text type="secondary" className="mon-section-desc">
                打开了 SSH 终端的主机，终端关闭后不再显示；点卡片上的 <PushpinOutlined /> 可以设为常驻
              </Typography.Text>
            </div>
            {session.length === 0 ? (
              <Typography.Text type="secondary" className="mon-none">
                {resident.length ? '当前没有打开终端的其他主机' : '打开 SSH 终端后，主机会自动出现在这里'}
              </Typography.Text>
            ) : sessionShown.length === 0 ? (
              <Typography.Text type="secondary" className="mon-none">
                没有符合条件的主机
              </Typography.Text>
            ) : (
              <div className="mon-grid">{sessionShown.map(card)}</div>
            )}
          </section>
        )}
        {filtering && (
          <Button
            type="link"
            onClick={() => {
              setQ('');
              setStatus('');
              setUptime('');
            }}
            style={{ paddingLeft: 0 }}
          >
            清除筛选
          </Button>
        )}
      </div>
      {/* 右键菜单：在鼠标位置放一个看不见的锚点 */}
      <Dropdown
        open={!!ctxMenu}
        onOpenChange={(o) => !o && setCtxMenu(null)}
        trigger={['contextMenu']}
        menu={{
          items: ctxMenu ? cardItems(ctxMenu.host) : [],
          onClick: ({ key }) => {
            const h = ctxMenu?.host;
            setCtxMenu(null);
            if (h) onCardItem(key, h);
          },
        }}
        overlayClassName="host-ctx-menu"
      >
        <div className="ctx-anchor" style={{ left: ctxMenu?.x ?? -10, top: ctxMenu?.y ?? -10 }} data-testid="mon-ctx-anchor" />
      </Dropdown>
      {detail && <MonitorDrawer open onClose={() => setDetail(null)} hostId={detail.id} hostName={detail.name} />}
      <ResidentPicker open={picking} selected={pinnedIds} onClose={() => setPicking(false)} onSave={(ids) => void setResident(ids).then(() => setPicking(false))} />
    </>
  );
}
