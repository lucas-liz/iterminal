import { Empty, Typography } from 'antd';
import { DashboardOutlined, DesktopOutlined, FireOutlined, LineChartOutlined, RiseOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useMonitor } from '../../store/monitor';
import { formatSize } from '../../util/format';
import { pct } from '../../util/metrics';
import { HistoryChart } from './HistoryChart';
import { Bar, Donut, levelColor, MON_COLOR, MonCard, SectionTitle, StatTile, timeOf, useRange, useStaticInfo, type OkSnapshot } from './parts';
import { ProcRanking } from './ProcRanking';

const na = (v: number | null | undefined, unit = ''): string => (v === null || v === undefined ? 'N/A' : `${v}${unit}`);

export function CpuTab({ snap, hostId }: { snap: OkSnapshot; hostId: string }): React.JSX.Element {
  const info = useStaticInfo(hostId);
  const history = useMonitor((s) => s.history[hostId]) ?? [];
  const [, rangeEl, cut] = useRange();
  const shown = cut(history);
  const cpu = snap.cpu;
  return (
    <>
      <div className="mx-grid3">
        <StatTile label="总负载" value={cpu ? `${cpu.usage.toFixed(1)}%` : '—'} sub={`核心数：${cpu?.cores ?? '—'}`} color={levelColor(cpu?.usage ?? 0, MON_COLOR.cpu)} icon={<DashboardOutlined />} testId="cpu-usage" />
        <StatTile
          label="负载均值 (1M)"
          value={snap.load[0].toFixed(2)}
          sub={`${snap.load[1].toFixed(2)} / ${snap.load[2].toFixed(2)}`}
          color={cpu && snap.load[0] > cpu.cores ? MON_COLOR.bad : MON_COLOR.ok}
          icon={<RiseOutlined />}
          tip="1 分钟平均负载；下面是 5 / 15 分钟。超过核心数说明 CPU 排队"
        />
        <StatTile label="CPU 温度" value={snap.tempC === null ? 'N/A' : `${snap.tempC}°C`} sub={snap.tempC === null ? '没有温度传感器' : '最高的传感器'} color={snap.tempC !== null && snap.tempC >= 80 ? MON_COLOR.bad : MON_COLOR.disk} icon={<FireOutlined />} />
        <StatTile label="用户态 (USER)" value={cpu ? `${cpu.user.toFixed(1)}%` : '—'} color={MON_COLOR.cpu} />
        <StatTile label="内核态 (SYS)" value={cpu ? `${cpu.system.toFixed(1)}%` : '—'} color={MON_COLOR.mem} />
        <StatTile label="IO 等待" value={cpu ? `${cpu.iowait.toFixed(1)}%` : '—'} color={cpu && cpu.iowait >= 20 ? MON_COLOR.bad : MON_COLOR.disk} tip="CPU 空闲但在等磁盘 / 网络 IO；持续偏高说明 IO 是瓶颈" />
      </div>

      <MonCard icon={<LineChartOutlined />} title="负载历史" color={MON_COLOR.cpu} extra={<span className="mx-card-extra">{rangeEl}</span>}>
        <HistoryChart
          testId="chart-cpu-sys-user"
          ts={shown.map((p) => p.ts)}
          series={[
            { name: 'User', values: shown.map((p) => p.user) },
            { name: 'Sys', values: shown.map((p) => p.sys) },
          ]}
          height={140}
          time={timeOf}
          ticks={4}
          endLabels={false}
          yLabels={false}
        />
      </MonCard>

      <SectionTitle icon={<DashboardOutlined />} color={MON_COLOR.cpu} extra={info?.cpuModel && <Typography.Text type="secondary" className="mx-cpu-model" ellipsis title={info.cpuModel}>{info.cpuModel}</Typography.Text>}>
        核心详情
      </SectionTitle>
      {cpu?.perCore?.length ? (
        <div className="mx-cores" data-testid="cpu-cores">
          {cpu.perCore.map((v, i) => (
            <div key={i} className="mx-core">
              <div className="mx-row-head mono">
                <span>#{i}</span>
                <span>{v.toFixed(0)}%</span>
              </div>
              <Bar percent={v} color={levelColor(v, MON_COLOR.cpu)} height={4} />
            </div>
          ))}
        </div>
      ) : (
        <Typography.Text type="secondary" className="mx-note">
          {cpu ? '没有每个核心的数据' : '正在计算（需要两次采样）…'}
        </Typography.Text>
      )}

      <ProcRanking hostId={hostId} sort="cpu" fallback={snap.procs} />
    </>
  );
}

/** lspci 的一行：`00:02.0 VGA compatible controller: Cirrus Logic GD 5446` → 型号和插槽 */
function lspciName(line: string): { slot: string; name: string } {
  const m = /^(\S+)\s+[^:]+:\s*(.+)$/.exec(line);
  return m ? { slot: m[1], name: m[2] } : { slot: '', name: line };
}

export function GpuTab({ snap, hostId }: { snap: OkSnapshot; hostId: string }): React.JSX.Element {
  const info = useStaticInfo(hostId);
  const gpus =
    snap.gpus.length > 0
      ? snap.gpus.map((g, i) => ({ key: `n${i}`, title: g.name, sub: `GPU #${i}`, g }))
      : (info?.gpus ?? []).map((line, i) => {
          const l = lspciName(line);
          return { key: `l${i}`, title: l.name, sub: `GPU #${i}${l.slot ? ` · ${l.slot}` : ''}`, g: null };
        });
  if (!gpus.length)
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={info ? '没有检测到显卡' : '正在检测显卡…'} style={{ marginTop: 48 }} />;
  return (
    <>
      {snap.gpus.length === 0 && (
        <Typography.Text type="secondary" className="mx-note">
          没有检测到 nvidia-smi，只能显示显卡型号；使用率、温度、显存需要安装 NVIDIA 驱动
        </Typography.Text>
      )}
      {gpus.map(({ key, title, sub, g }) => {
        const memPct = g && g.memTotal ? pct(g.memUsed, g.memTotal) : 0;
        return (
          <div key={key} className="mx-gpu" data-testid="gpu-card">
            <div className="mx-card mx-gpu-head">
              <span className="mx-gpu-icon">
                <DesktopOutlined />
              </span>
              <div className="mx-gpu-title">
                <div className="mx-gpu-name">{title}</div>
                <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                  {sub}
                </Typography.Text>
              </div>
              <div className="mx-gpu-util">
                <span className="mono" style={{ color: MON_COLOR.ok }}>
                  {g ? `${g.util}%` : 'N/A'}
                </span>
                <small>GPU 使用率</small>
              </div>
            </div>
            <div className="mx-grid2">
              <StatTile label="GPU 温度" value={na(g?.tempC, '°C')} color={g?.tempC && g.tempC >= 85 ? MON_COLOR.bad : undefined} icon={<FireOutlined />} />
              <StatTile label="风扇转速" value={na(g?.fanPct, '%')} />
              <StatTile label="功耗 (POWER)" value={na(g?.powerW, ' W')} color={MON_COLOR.disk} icon={<ThunderboltOutlined />} />
              <StatTile label="显存使用" value={g ? formatSize(g.memUsed * 1024 * 1024) : 'N/A'} />
            </div>
            <MonCard small title="VRAM MEMORY" value={g ? `${formatSize(g.memUsed * 1024 * 1024)} / ${formatSize(g.memTotal * 1024 * 1024)}` : 'N/A / N/A'} color={MON_COLOR.ok}>
              <div className="mx-vram">
                <Bar percent={memPct} color={levelColor(memPct, MON_COLOR.gpu)} height={10} />
              </div>
            </MonCard>
          </div>
        );
      })}
    </>
  );
}

export function MemTab({ snap, hostId }: { snap: OkSnapshot; hostId: string }): React.JSX.Element {
  const m = snap.mem;
  const memPct = pct(m.used, m.total);
  const detail = m.cached !== undefined;
  const p = (v: number | undefined): number => pct(v ?? 0, m.total);
  const rows = detail
    ? [
        { name: '页面缓存 (Cached)', value: m.cached!, color: MON_COLOR.disk },
        { name: '缓冲区 (Buffers)', value: m.buffers!, color: MON_COLOR.cpu },
        { name: '空闲内存 (Free)', value: m.free!, color: 'var(--itm-text-secondary)' },
      ]
    : [];
  return (
    <>
      <div className="mx-donut-wrap">
        <Donut
          segments={[
            { name: '已用', value: memPct, color: MON_COLOR.mem },
            ...(detail
              ? [
                  { name: '缓冲区', value: p(m.buffers), color: MON_COLOR.cpu },
                  { name: '页面缓存', value: p(m.cached), color: MON_COLOR.disk },
                  { name: '空闲', value: p(m.free), color: 'var(--itm-border-strong)' },
                ]
              : []),
          ]}
        >
          <div className="mx-donut-pct">{memPct.toFixed(0)}%</div>
          {snap.source !== 'custom' && (
            <div className="mx-donut-sub">
              {formatSize(m.used)} / {formatSize(m.total)}
            </div>
          )}
        </Donut>
      </div>
      {snap.source !== 'custom' && (
        <>
          <div className="mx-grid2">
            <StatTile label="可用内存" value={formatSize(m.available)} sub="应用可以立即使用" color={MON_COLOR.ok} testId="mem-available" />
            <StatTile label="已用内存" value={formatSize(m.used)} sub="总量 - 可用" color={levelColor(memPct, MON_COLOR.bad)} />
          </div>
          {rows.map((r) => (
            <div key={r.name} className="mx-mem-row">
              <div className="mx-row-head">
                <span>
                  <span className="mx-dot" style={{ background: r.color }} />
                  {r.name}
                </span>
                <span className="mono">{formatSize(r.value)}</span>
              </div>
              <Bar percent={pct(r.value, m.total)} color={r.color} height={5} />
            </div>
          ))}
          <MonCard small title="Swap 交换分区" value={m.swapTotal ? `${formatSize(m.swapUsed)} / ${formatSize(m.swapTotal)}` : '未启用'} color="var(--itm-text-secondary)">
            <Bar percent={pct(m.swapUsed, m.swapTotal)} color={levelColor(pct(m.swapUsed, m.swapTotal), MON_COLOR.mem)} height={5} />
          </MonCard>
        </>
      )}
      <ProcRanking hostId={hostId} sort="mem" fallback={snap.procs} />
    </>
  );
}
