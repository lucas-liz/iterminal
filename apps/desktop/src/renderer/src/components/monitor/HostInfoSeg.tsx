import { App, Tooltip } from 'antd';
import { CloudServerOutlined } from '@ant-design/icons';
import { useHosts } from '../../store/hosts';
import { useMonitor } from '../../store/monitor';
import { formatUptime } from '../../util/metrics';

/**
 * 终端底部状态栏里 AI 按钮后面的主机信息（参考 MobaXterm）：主机名和 IP；
 * 悬停显示主机名、地址、登录用户、系统 / 内核、运行时长、网卡 IP、默认网关，点击复制 IP。
 */
export function HostInfoSeg({ hostId }: { hostId: string }): React.JSX.Element | null {
  const { message } = App.useApp();
  const host = useHosts((s) => s.hosts.find((h) => h.id === hostId));
  const snap = useMonitor((s) => s.latest[hostId]);
  if (!host) return null;
  const ok = snap?.state === 'ok' ? snap : null;
  const hostname = ok?.hostname || host.name;
  const nicIps = ok ? ok.net.filter((n) => n.ip).map((n) => `${n.name} ${n.ip}`) : [];
  const rows: [string, string | null | undefined][] = [
    ['主机名', hostname],
    ['地址', `${host.address}${host.port && host.port !== 22 ? `:${host.port}` : ''}`],
    ['用户', host.username],
    ['系统', host.osInfo],
    ['内核', ok?.kernel],
    ['运行', ok ? formatUptime(ok.uptimeSec) : null],
    ['网卡', nicIps.length ? nicIps.join('，') : null],
    ['网关', ok?.gateway],
  ];
  return (
    <Tooltip
      placement="topLeft"
      mouseEnterDelay={0.3}
      title={
        <div className="hostinfo-tip">
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <b>{k}</b>：{v}
              </div>
            ))}
          <div className="hostinfo-tip-hint">点击复制 IP</div>
        </div>
      }
    >
      <button
        type="button"
        className="statusbar-host"
        onClick={() => void navigator.clipboard.writeText(host.address).then(() => message.success(`已复制 ${host.address}`))}
        data-testid="statusbar-host"
      >
        <CloudServerOutlined />
        <span className="statusbar-host-name">{hostname}</span>
        <span className="statusbar-host-ip mono">{host.address}</span>
      </button>
    </Tooltip>
  );
}
