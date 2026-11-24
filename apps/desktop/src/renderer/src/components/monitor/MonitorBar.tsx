import { Tooltip, Typography } from 'antd';
import { DashboardOutlined, DatabaseOutlined, DesktopOutlined, HddOutlined, LoadingOutlined, RightOutlined, WifiOutlined } from '@ant-design/icons';
import { useMonitor, useMonitorSubscription } from '../../store/monitor';
import { useTabs } from '../../store/tabs';
import { useWorkspaceUi, type MonitorTab } from '../../store/workspace';
import { formatSize } from '../../util/format';
import { formatRate, formatUptime, pct } from '../../util/metrics';
import { levelColor, MON_COLOR } from './parts';
import { Sparkline } from './Sparkline';

/** 紧凑的大小：11.5G、512M */
const short = (n: number): string => formatSize(n).replace(/\s?([KMGT])B$/, '$1').replace(/\.0([KMGT])$/, '$1');

function Seg({
  tab,
  icon,
  color,
  label,
  value,
  percent,
  sub,
  tip,
  testId,
  open,
  children,
}: {
  tab: MonitorTab;
  icon: React.ReactNode;
  color: string;
  label: string;
  value: React.ReactNode;
  percent?: number;
  sub?: React.ReactNode;
  tip: React.ReactNode;
  testId?: string;
  open(tab: MonitorTab): void;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <Tooltip title={tip} placement="top" mouseEnterDelay={0.4}>
      <button
        type="button"
        className="mseg"
        onClick={(e) => {
          e.stopPropagation();
          open(tab);
        }}
        data-testid={testId}
      >
        <span className="mseg-icon" style={{ color }}>
          {icon}
        </span>
        <span className="mseg-label">{label}</span>
        <span className="mseg-value">{value}</span>
        {percent !== undefined && (
          <span className="mseg-meter">
            <span style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: levelColor(percent, color) }} />
          </span>
        )}
        {children}
        {sub && <span className="mseg-sub">{sub}</span>}
      </button>
    </Tooltip>
  );
}

/**
 * 终端底部的实时监控条：CPU、内存、显卡（有 GPU 时）、磁盘、网络分段显示，段与段之间有分隔；
 * 点击某一段打开右侧的监控面板并切到对应分类，点空白处打开「综合」。
 */
export function MonitorBar({ hostId, tabId, enabled }: { hostId: string; tabId: string; enabled: boolean }): React.JSX.Element | null {
  useMonitorSubscription(hostId, enabled);
  const snap = useMonitor((s) => s.latest[hostId]);
  const history = useMonitor((s) => s.history[hostId]);

  if (!enabled && !snap) return null;

  const open = (tab: MonitorTab): void => {
    // 右侧面板跟随获得焦点的窗格：先把焦点给这个窗格
    useTabs.getState().focus(tabId);
    useWorkspaceUi.getState().openMonitor(tab);
  };

  let body: React.ReactNode;
  if (!snap) {
    body = (
      <Typography.Text type="secondary" className="mbar-note">
        <LoadingOutlined /> 正在采集监控数据…
      </Typography.Text>
    );
  } else if (snap.state !== 'ok') {
    body = (
      <Typography.Text type="secondary" className="mbar-note">
        {snap.message}
      </Typography.Text>
    );
  } else {
    const root = snap.disks.find((d) => d.mount === '/') ?? snap.disks[0];
    const rx = snap.net.reduce((a, n) => a + n.rxBps, 0);
    const tx = snap.net.reduce((a, n) => a + n.txBps, 0);
    const memPct = pct(snap.mem.used, snap.mem.total);
    const custom = snap.source === 'custom';
    const gpu = snap.gpus[0];
    const cpu = snap.cpu;
    body = (
      <>
        <Seg
          tab="cpu"
          icon={<DashboardOutlined />}
          color={MON_COLOR.cpu}
          label="CPU"
          value={cpu ? `${cpu.usage.toFixed(1)}%` : '—'}
          percent={cpu?.usage}
          tip={
            <>
              <div>{cpu ? `用户 ${cpu.user.toFixed(1)}% · 系统 ${cpu.system.toFixed(1)}% · IO 等待 ${cpu.iowait.toFixed(1)}% · ${cpu.cores} 核` : 'CPU 使用率（需要两次采样）'}</div>
              <div>{`负载 ${snap.load.map((l) => l.toFixed(2)).join(' / ')}`}</div>
              <div>点击查看处理器详情</div>
            </>
          }
          testId="monitor-cpu"
          open={open}
        >
          <span className="mseg-spark">
            <Sparkline values={(history ?? []).slice(-45).map((p) => p.cpu)} max={100} width={44} height={14} color={MON_COLOR.cpu} />
          </span>
        </Seg>
        <Seg
          tab="mem"
          icon={<DatabaseOutlined />}
          color={MON_COLOR.mem}
          label="内存"
          value={`${memPct.toFixed(0)}%`}
          percent={memPct}
          sub={!custom && `${short(snap.mem.used)}/${short(snap.mem.total)}`}
          tip={custom ? '内存使用率' : `已用 ${formatSize(snap.mem.used)} · 可用 ${formatSize(snap.mem.available)} · 共 ${formatSize(snap.mem.total)}`}
          testId="monitor-mem"
          open={open}
        />
        {gpu && (
          <Seg
            tab="gpu"
            icon={<DesktopOutlined />}
            color={MON_COLOR.gpu}
            label="显卡"
            value={`${gpu.util}%`}
            percent={gpu.util}
            sub={gpu.memTotal ? `${short(gpu.memUsed * 1024 * 1024)}/${short(gpu.memTotal * 1024 * 1024)}` : undefined}
            tip={`${gpu.name}${snap.gpus.length > 1 ? ` 等 ${snap.gpus.length} 块` : ''} · 显存 ${gpu.memUsed} / ${gpu.memTotal} MiB${gpu.tempC !== null ? ` · ${gpu.tempC}°C` : ''}`}
            testId="monitor-gpu"
            open={open}
          />
        )}
        {root && (
          <Seg
            tab="disk"
            icon={<HddOutlined />}
            color={MON_COLOR.disk}
            label="磁盘"
            value={`${root.usePct.toFixed(0)}%`}
            percent={root.usePct}
            sub={!custom && `${short(root.size - root.used)} 可用`}
            tip={`${root.mount}${custom ? '' : `：已用 ${formatSize(root.used)} / ${formatSize(root.size)}`}${snap.disks.length > 1 ? `（共 ${snap.disks.length} 个分区）` : ''}${snap.diskIo ? ` · 读 ${formatRate(snap.diskIo.readBps)} 写 ${formatRate(snap.diskIo.writeBps)}` : ''}`}
            testId="monitor-disk"
            open={open}
          />
        )}
        <Seg
          tab="net"
          icon={<WifiOutlined />}
          color={MON_COLOR.net}
          label="网络"
          value={
            <span className="mono mseg-rates">
              <span>↓{formatRate(rx)}</span>
              <span>↑{formatRate(tx)}</span>
            </span>
          }
          tip={
            snap.net.length ? (
              <>
                {snap.net.map((n) => (
                  <div key={n.name}>{`${n.name}${n.ip ? ` ${n.ip}` : ''}：↓${formatRate(n.rxBps)} ↑${formatRate(n.txBps)}`}</div>
                ))}
              </>
            ) : (
              '网络'
            )
          }
          testId="monitor-net"
          open={open}
        />
        <span className="mbar-uptime">运行 {formatUptime(snap.uptimeSec)}</span>
      </>
    );
  }

  return (
    <div className="monitor-bar" onClick={() => open('overview')} data-testid="monitor-bar" title="点击查看详细监控">
      {body}
      <RightOutlined className="mbar-expand" />
    </div>
  );
}
