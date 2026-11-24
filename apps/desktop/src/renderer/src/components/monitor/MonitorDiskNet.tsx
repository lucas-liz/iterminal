import { useCallback, useEffect, useState } from 'react';
import { App, Button, Empty, Input, Select, Tooltip, Typography } from 'antd';
import { ApiOutlined, CopyOutlined, DatabaseOutlined, FileSearchOutlined, HddOutlined, LineChartOutlined, NodeIndexOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, WifiOutlined } from '@ant-design/icons';
import type { BigFile, NetDetail } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useAgent } from '../../store/agent';
import { useApp } from '../../store/app';
import { useMonitor } from '../../store/monitor';
import { useWorkspaceUi } from '../../store/workspace';
import { formatSize } from '../../util/format';
import { formatRate, pct } from '../../util/metrics';
import { HistoryChart } from './HistoryChart';
import { Bar, levelColor, MON_COLOR, MON_INK, MonCard, SectionTitle, StatTile, timeOf, useRange, type OkSnapshot } from './parts';

export function DiskTab({ snap, hostId }: { snap: OkSnapshot; hostId: string }): React.JSX.Element {
  const custom = snap.source === 'custom';
  return (
    <>
      {snap.diskIo && (
        <div className="mx-grid2">
          <StatTile label="磁盘读取" value={formatRate(snap.diskIo.readBps)} color={MON_COLOR.cpu} />
          <StatTile label="磁盘写入" value={formatRate(snap.diskIo.writeBps)} color={MON_COLOR.disk} />
        </div>
      )}
      {snap.disks.map((d) => (
        <div key={d.mount} className="mx-card mx-disk" data-testid="disk-card">
          <div className="mx-disk-head">
            <span className="mx-disk-icon">
              <HddOutlined />
            </span>
            <div className="mx-disk-title">
              <div className="mx-disk-mount mono">{d.mount}</div>
              <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }} ellipsis>
                {d.fs}
              </Typography.Text>
            </div>
            <div className="mx-disk-pct">
              <span className="mono" style={{ color: levelColor(d.usePct, MON_COLOR.ok) }}>
                {d.usePct.toFixed(0)}%
              </span>
              <small>已使用</small>
            </div>
          </div>
          <Bar percent={d.usePct} color={levelColor(d.usePct, MON_COLOR.ok)} gradient={d.usePct < 75} />
          {!custom && (
            <div className="mx-disk-cols">
              <div>
                <small>已使用</small>
                <span className="mono">{formatSize(d.used)}</span>
              </div>
              <div>
                <small>可用</small>
                <span className="mono" style={{ color: MON_COLOR.ok }}>
                  {formatSize(Math.max(0, d.size - d.used))}
                </span>
              </div>
              <div>
                <small>总计</small>
                <span className="mono">{formatSize(d.size)}</span>
              </div>
            </div>
          )}
        </div>
      ))}
      <BigFiles hostId={hostId} />
    </>
  );
}

/** 大文件分析：find -xdev，按占用空间从大到小列出 */
function BigFiles({ hostId }: { hostId: string }): React.JSX.Element {
  const { message } = App.useApp();
  const [paths, setPaths] = useState('/home /var /opt');
  const [minMb, setMinMb] = useState(100);
  const [limit, setLimit] = useState(20);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ files: BigFile[]; elapsedMs: number } | null>(null);

  const scan = async (): Promise<void> => {
    setBusy(true);
    try {
      setResult(await invoke('monitor.bigfiles', { hostId, paths: paths.split(/\s+/).filter(Boolean), minMb, limit }));
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const askAi = (files: BigFile[]): void => {
    useAgent.getState().toggleHost(hostId, true);
    useAgent
      .getState()
      .ask(
        `这台主机上最大的文件（find -xdev，≥ ${minMb} MB）：\n${files.map((f) => `- ${f.path}（${formatSize(f.size)}）`).join('\n')}\n` +
          '请判断哪些可以安全清理（日志、缓存、旧备份等）、哪些在被进程使用，给出清理建议。删除前先列出要删除的内容让我确认。',
        'agent',
      );
    useWorkspaceUi.getState().focusAi();
    useApp.getState().setPage('workspace');
  };

  return (
    <div className="mx-card" data-testid="bigfiles">
      <SectionTitle
        icon={<FileSearchOutlined />}
        color={MON_COLOR.cpu}
        extra={
          <Button type="primary" size="small" icon={<SearchOutlined />} loading={busy} onClick={() => void scan()} data-testid="bigfiles-scan">
            扫描大文件
          </Button>
        }
      >
        大文件分析
      </SectionTitle>
      <div className="mx-form">
        <label>搜索路径</label>
        <Input value={paths} onChange={(e) => setPaths(e.target.value)} placeholder="空格分隔的绝对路径" className="mono" data-testid="bigfiles-paths" />
        <div className="mx-grid2">
          <div>
            <label>最小大小</label>
            <Select value={minMb} onChange={setMinMb} style={{ width: '100%' }} options={[10, 50, 100, 500, 1024].map((v) => ({ value: v, label: `≥ ${v >= 1024 ? `${v / 1024}GB` : `${v}MB`}` }))} />
          </div>
          <div>
            <label>显示数量</label>
            <Select value={limit} onChange={setLimit} style={{ width: '100%' }} options={[10, 20, 50, 100].map((v) => ({ value: v, label: `Top ${v}` }))} />
          </div>
        </div>
      </div>
      {!result ? (
        <div className="mx-empty">
          <SearchOutlined />
          <span>{busy ? '正在扫描，目录多时可能要一两分钟…' : '点击「扫描大文件」按钮开始分析'}</span>
        </div>
      ) : (
        <>
          <div className="mx-row-head" style={{ margin: '10px 0 6px' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {result.files.length ? `找到 ${result.files.length} 个文件，用时 ${(result.elapsedMs / 1000).toFixed(1)} 秒` : '没有找到符合条件的文件'}
            </Typography.Text>
            {result.files.length > 0 && (
              <Button size="small" type="link" icon={<RobotOutlined />} onClick={() => askAi(result.files)}>
                让 AI 分析
              </Button>
            )}
          </div>
          <div className="mx-file-list">
            {result.files.map((f) => (
              <div key={f.path} className="mx-file" data-testid="bigfile-row">
                <Tooltip title={f.path} placement="topLeft">
                  <span className="mono mx-file-path">{f.path}</span>
                </Tooltip>
                <span className="mono mx-file-size">{formatSize(f.size)}</span>
                <Button size="small" type="text" icon={<CopyOutlined />} aria-label="复制路径" onClick={() => void navigator.clipboard.writeText(f.path).then(() => message.success('已复制路径'))} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function NetTab({ snap, hostId }: { snap: OkSnapshot; hostId: string }): React.JSX.Element {
  const history = useMonitor((s) => s.history[hostId]) ?? [];
  const [, rangeEl, cut] = useRange();
  const shown = cut(history);
  const [detail, setDetail] = useState<NetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const rx = snap.net.reduce((a, n) => a + n.rxBps, 0);
  const tx = snap.net.reduce((a, n) => a + n.txBps, 0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await invoke('monitor.net', { hostId }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [hostId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const st = detail?.tcpStates ?? {};
  const fh = detail?.fileHandles;
  // 文件句柄上限可能是 2⁶³-1（相当于不限）
  const fhUnlimited = !!fh && fh.max > 1e15;
  const fhPct = fh && !fhUnlimited ? pct(fh.allocated, fh.max) : 0;
  return (
    <>
      <div className="mx-grid3">
        <StatTile
          label="总连接数"
          value={detail ? (detail.sockets ?? detail.tcp + detail.udp).toLocaleString() : '—'}
          sub={detail ? `LISTEN ${st.LISTEN ?? 0} · UDP ${detail.udp}` : ' '}
          color={MON_COLOR.cpu}
          icon={<NodeIndexOutlined />}
          tip="/proc/net/sockstat 里正在使用的套接字（含本机进程间的连接）"
          testId="net-sockets"
        />
        <StatTile label="TCP 连接" value={detail ? detail.tcp.toLocaleString() : '—'} sub={detail ? `已建立 ${st.ESTABLISHED ?? 0} · TIME_WAIT ${st.TIME_WAIT ?? 0}` : ' '} color={MON_COLOR.ok} icon={<ApiOutlined />} />
        <StatTile
          label="文件句柄"
          value={fh ? fh.allocated.toLocaleString() : '—'}
          sub={fh ? (fhUnlimited ? '上限：不限' : <span className="mx-fh"><Bar percent={fhPct} color={levelColor(fhPct, MON_COLOR.disk)} height={4} /> {fhPct.toFixed(1)}%</span>) : ' '}
          color={MON_COLOR.disk}
          icon={<DatabaseOutlined />}
          tip={fh && !fhUnlimited ? `已分配 ${fh.allocated.toLocaleString()} / 上限 ${fh.max.toLocaleString()}` : undefined}
        />
      </div>
      {error && (
        <Typography.Text type="secondary" className="mx-note">
          连接统计读取失败：{error}
        </Typography.Text>
      )}

      <MonCard
        icon={<LineChartOutlined />}
        title="流量监控"
        color={MON_COLOR.net}
        extra={
          <span className="mx-card-extra mx-chips mono">
            <span style={{ color: MON_INK.net }}>↓ {formatRate(rx)}</span>
            <span style={{ color: MON_INK.cpu }}>↑ {formatRate(tx)}</span>
          </span>
        }
      >
        <div className="mx-range-row">{rangeEl}</div>
        <HistoryChart
          testId="chart-net"
          ts={shown.map((p) => p.ts)}
          series={[
            { name: '↓ 接收', values: shown.map((p) => p.rx) },
            { name: '↑ 发送', values: shown.map((p) => p.tx) },
          ]}
          height={140}
          max="auto"
          format={formatRate}
          formatTip={formatRate}
          time={timeOf}
          ticks={4}
          endLabels={false}
          yLabels={false}
        />
      </MonCard>

      <div className="mx-card" data-testid="listen-ports">
        <SectionTitle
          icon={<ApiOutlined />}
          color={MON_COLOR.cpu}
          extra={
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
              刷新
            </Button>
          }
        >
          监听端口 {detail && <span className="mx-count">{detail.ports.length}</span>}
        </SectionTitle>
        <div className="mx-port-list">
          {detail?.ports.map((p) => (
            <div key={`${p.proto}${p.address}${p.port}`} className="mx-port" data-testid="port-row">
              <span className="mx-port-num mono">:{p.port}</span>
              <span className={`mx-proto ${p.proto}`}>{p.proto.toUpperCase()}</span>
              <div className="mx-port-main">
                <div>
                  <span className="mx-port-proc">{p.process ?? '（无权限查看进程）'}</span>
                  {p.pid !== null && <span className="mx-pid-sm mono">{p.pid}</span>}
                </div>
                <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }} ellipsis>
                  <span className="mx-dot" style={{ background: /^(0\.0\.0\.0|\*|\[::\])$/.test(p.address) ? MON_COLOR.ok : MON_COLOR.warn }} />
                  {p.address}
                </Typography.Text>
              </div>
            </div>
          ))}
          {detail && !detail.ports.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有监听端口（或者 ss / netstat 都不可用）" />}
          {!detail && !error && <Typography.Text type="secondary">正在读取…</Typography.Text>}
        </div>
      </div>

      <SectionTitle icon={<WifiOutlined />} color={MON_COLOR.net} extra={snap.gateway && <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>默认网关 {snap.gateway}</Typography.Text>}>
        网络接口
      </SectionTitle>
      <NetIfaces snap={snap} />
    </>
  );
}

export function NetIfaces({ snap }: { snap: OkSnapshot }): React.JSX.Element {
  return (
    <>
      {snap.net.map((n) => (
        <div key={n.name} className="mx-row-card mx-iface">
          <div>
            <div className="mx-iface-name">{n.name}</div>
            <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
              {n.ip ?? '—'}
            </Typography.Text>
          </div>
          <div className="mx-iface-rates mono">
            <span style={{ color: MON_INK.net }}>↓ {formatRate(n.rxBps)}</span>
            <span style={{ color: MON_INK.cpu }}>↑ {formatRate(n.txBps)}</span>
          </div>
        </div>
      ))}
      {!snap.net.length && <Typography.Text type="secondary">没有网络接口数据</Typography.Text>}
    </>
  );
}
