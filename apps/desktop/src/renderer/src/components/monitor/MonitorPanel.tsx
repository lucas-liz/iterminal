import { App, Empty, Tooltip, Typography } from 'antd';
import { AppstoreOutlined, CloudServerOutlined, CopyOutlined, DashboardOutlined, DatabaseOutlined, DesktopOutlined, HddOutlined, LineChartOutlined, WifiOutlined } from '@ant-design/icons';
import { useHosts } from '../../store/hosts';
import { useMonitor, useMonitorSubscription } from '../../store/monitor';
import type { MonitorTab } from '../../store/workspace';
import { formatSize } from '../../util/format';
import { formatRate, formatUptime, pct } from '../../util/metrics';
import { HistoryChart } from './HistoryChart';
import { MonitorHistory } from './MonitorHistory';
import { Bar, levelColor, MON_COLOR, MON_INK, MonCard, SectionTitle, timeOf, useRange, useStaticInfo, type OkSnapshot } from './parts';
import { CpuTab, GpuTab, MemTab } from './MonitorCpuMem';
import { DiskTab, NetIfaces, NetTab } from './MonitorDiskNet';

const TABS: { key: MonitorTab; label: string; icon: React.ReactNode }[] = [
  { key: 'overview', label: '综合', icon: <AppstoreOutlined /> },
  { key: 'cpu', label: '处理器', icon: <DashboardOutlined /> },
  { key: 'gpu', label: '显卡', icon: <DesktopOutlined /> },
  { key: 'mem', label: '内存', icon: <DatabaseOutlined /> },
  { key: 'disk', label: '磁盘', icon: <HddOutlined /> },
  { key: 'net', label: '网络', icon: <WifiOutlined /> },
];

/**
 * 主机监控详情（文档一 6.4，界面参考 iShell 的「工具」面板）：综合、处理器、显卡、内存、磁盘、网络。
 * 放在终端右侧面板（跟随当前终端的主机）和监控页的详情抽屉里；进程、端口等只在打开对应分类时才去读取。
 */
export function MonitorPanel({ hostId, hostName, tab, onTab }: { hostId: string; hostName: string; tab: MonitorTab; onTab(t: MonitorTab): void }): React.JSX.Element {
  useMonitorSubscription(hostId, true);
  const snap = useMonitor((s) => s.latest[hostId]);

  let body: React.ReactNode;
  if (!snap) body = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="正在采集监控数据…" style={{ marginTop: 48 }} />;
  else if (snap.state !== 'ok')
    body = (
      <>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={snap.message} style={{ marginTop: 32 }} />
        <MonCard title="最近 7 天" icon={<LineChartOutlined />} color={MON_COLOR.cpu}>
          <MonitorHistory hostId={hostId} hostName={hostName} />
        </MonCard>
      </>
    );
  else if (tab === 'overview') body = <OverviewTab snap={snap} hostId={hostId} hostName={hostName} onTab={onTab} />;
  else if (tab === 'cpu') body = <CpuTab snap={snap} hostId={hostId} />;
  else if (tab === 'gpu') body = <GpuTab snap={snap} hostId={hostId} />;
  else if (tab === 'mem') body = <MemTab snap={snap} hostId={hostId} />;
  else if (tab === 'disk') body = <DiskTab snap={snap} hostId={hostId} />;
  else body = <NetTab snap={snap} hostId={hostId} />;

  return (
    <div className="mx-panel" data-testid="monitor-detail" data-tab={tab}>
      <div className="mx-tabs" role="tablist">
        {TABS.map((t) => (
          <Tooltip key={t.key} title={t.label} placement="bottom" mouseEnterDelay={0.6}>
            <button type="button" role="tab" aria-selected={tab === t.key} className={`mx-tab ${tab === t.key ? 'active' : ''}`} onClick={() => onTab(t.key)} data-testid={`mx-tab-${t.key}`}>
              {t.icon}
              <span className="mx-tab-label">{t.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="mx-body">{body}</div>
    </div>
  );
}

function OverviewTab({ snap, hostId, hostName, onTab }: { snap: OkSnapshot; hostId: string; hostName: string; onTab(t: MonitorTab): void }): React.JSX.Element {
  const { message } = App.useApp();
  const copy = (text: string): void => void navigator.clipboard.writeText(text).then(() => message.success(`已复制 ${text}`));
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const info = useStaticInfo(hostId);
  const history = useMonitor((s) => s.history[hostId]) ?? [];
  const [, rangeEl, cut] = useRange();
  const shown = cut(history);
  const memPct = pct(snap.mem.used, snap.mem.total);
  const root = snap.disks.find((d) => d.mount === '/') ?? snap.disks[0];
  const rx = snap.net.reduce((a, n) => a + n.rxBps, 0);
  const tx = snap.net.reduce((a, n) => a + n.txBps, 0);
  const custom = snap.source === 'custom';
  return (
    <>
      <div className="mx-card mx-host" data-testid="mx-host">
        <CloudServerOutlined className="mx-host-icon" />
        <div className="mx-host-main">
          <div className="mx-host-line">
            <Typography.Text strong className="mx-host-name" ellipsis>
              {hostName}
            </Typography.Text>
            {host && (
              <Tooltip title="点击复制">
                <button type="button" className="mx-chip mono mx-copy" onClick={() => copy(host.address)} data-testid="mx-copy-ip">
                  {host.address}
                  <CopyOutlined />
                </button>
              </Tooltip>
            )}
          </div>
          <div className="mx-host-line">
            {host?.username && <span className="mx-chip mono">{host.username}</span>}
            <Tooltip title={[info?.os, snap.kernel].filter(Boolean).join(' · ')}>
              <Typography.Text type="secondary" className="mono mx-host-kernel" ellipsis>
                {snap.hostname} · {info?.os ?? 'Linux'} {snap.kernel}
              </Typography.Text>
            </Tooltip>
          </div>
        </div>
        <div className="mx-host-up">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            运行时间
          </Typography.Text>
          <span className="mono" style={{ color: MON_COLOR.ok }}>
            {formatUptime(snap.uptimeSec)}
          </span>
        </div>
      </div>

      <div className="mx-grid2">
        <MonCard icon={<DashboardOutlined />} title="CPU" value={snap.cpu ? `${snap.cpu.usage.toFixed(1)}%` : '—'} color={MON_COLOR.cpu} testId="mx-ov-cpu" onClick={() => onTab('cpu')} clickTip="查看处理器详情">
          <Bar percent={snap.cpu?.usage ?? 0} color={levelColor(snap.cpu?.usage ?? 0, MON_COLOR.cpu)} />
          <div className="mx-foot">
            <span>User: {snap.cpu?.user.toFixed(1) ?? '—'}%</span>
            <span>Sys: {snap.cpu?.system.toFixed(1) ?? '—'}%</span>
          </div>
        </MonCard>
        <MonCard icon={<DatabaseOutlined />} title="内存" value={`${memPct.toFixed(0)}%`} color={MON_COLOR.mem} testId="mx-ov-mem" onClick={() => onTab('mem')} clickTip="查看内存详情">
          <Bar percent={memPct} color={levelColor(memPct, MON_COLOR.mem)} />
          <div className="mx-foot">{!custom && <><span>{formatSize(snap.mem.used)}</span><span>{formatSize(snap.mem.total)}</span></>}</div>
        </MonCard>
        <MonCard icon={<HddOutlined />} title="磁盘" value={root ? `${root.usePct.toFixed(0)}%` : '—'} color={MON_COLOR.disk} testId="mx-ov-disk" onClick={() => onTab('disk')} clickTip="查看磁盘详情">
          <Bar percent={root?.usePct ?? 0} color={levelColor(root?.usePct ?? 0, MON_COLOR.disk)} />
          <div className="mx-foot">{root && !custom && <><span>{formatSize(root.used)}</span><span>{formatSize(root.size)}</span></>}</div>
        </MonCard>
        <MonCard icon={<WifiOutlined />} title="网络" color={MON_COLOR.net} testId="mx-ov-net" onClick={() => onTab('net')} clickTip="查看网络详情">
          <div className="mx-net-rates mono">
            <span style={{ color: MON_INK.net }}>↓ {formatRate(rx)}</span>
            <span style={{ color: MON_INK.cpu }}>↑ {formatRate(tx)}</span>
          </div>
          <div className="mx-foot">
            <span>默认网关</span>
            <span className="mono">{snap.gateway ?? '—'}</span>
          </div>
        </MonCard>
      </div>

      <MonCard icon={<LineChartOutlined />} title="CPU 负载趋势" color={MON_COLOR.cpu} extra={<span className="mx-card-extra">{rangeEl}</span>}>
        <HistoryChart
          testId="chart-cpu-live"
          ts={shown.map((p) => p.ts)}
          series={[{ name: 'CPU', values: shown.map((p) => p.cpu) }]}
          height={120}
          time={timeOf}
          ticks={4}
          endLabels={false}
          yLabels={false}
        />
      </MonCard>

      <SectionTitle icon={<HddOutlined />} color={MON_COLOR.disk}>
        磁盘分区
      </SectionTitle>
      {snap.disks.map((d) => (
        <div key={d.mount} className="mx-row-card">
          <div className="mx-row-head">
            <span className="mono">{d.mount}</span>
            <span className="mono">{d.usePct.toFixed(0)}%</span>
          </div>
          <Bar percent={d.usePct} color={levelColor(d.usePct, MON_COLOR.disk)} height={5} />
        </div>
      ))}

      <SectionTitle icon={<WifiOutlined />} color={MON_COLOR.net}>
        网络接口
      </SectionTitle>
      <NetIfaces snap={snap} />

      <MonCard icon={<LineChartOutlined />} title="最近 7 天" color={MON_COLOR.cpu}>
        <MonitorHistory hostId={hostId} hostName={hostName} />
      </MonCard>
    </>
  );
}
