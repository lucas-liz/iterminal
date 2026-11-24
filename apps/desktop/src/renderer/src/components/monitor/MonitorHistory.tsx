import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Segmented, Space, Table, Typography } from 'antd';
import { RobotOutlined } from '@ant-design/icons';
import { DISK_WARN_DAYS, type DiskForecast, type MetricSample } from '@itm/protocol';
import { invoke } from '../../api';
import { useAgent } from '../../store/agent';
import { useWorkspaceUi } from '../../store/workspace';
import { useApp } from '../../store/app';
import { HistoryChart } from './HistoryChart';

/** 让 AI 分析磁盘为什么在涨：引用这台主机，用 Agent 模式提问 */
export function askDiskAnalysis(hostId: string, hostName: string, f: DiskForecast): void {
  useAgent.getState().toggleHost(hostId, true);
  useAgent
    .getState()
    .ask(
      `主机「${hostName}」的 ${f.mount} 分区预计 ${f.daysToFull!.toFixed(1)} 天后写满（当前 ${f.usedPct.toFixed(0)}%，最近 7 天每天增长约 ${f.slopePerDay.toFixed(1)} 个百分点）。` +
        '请排查占用空间最多、增长最快的目录和文件，分析增长原因，给出清理或扩容建议。清理前先列出要删除的内容让我确认。',
      'agent',
    );
  useWorkspaceUi.getState().focusAi();
  useApp.getState().setPage('workspace');
}

/** 磁盘预计写满的提示（少于 5 天告警），带「让 AI 分析」 */
export function ForecastAlerts({ hostId, hostName, forecast }: { hostId: string; hostName: string; forecast: DiskForecast[] }): React.JSX.Element | null {
  const urgent = forecast.filter((f) => f.daysToFull !== null && f.daysToFull < DISK_WARN_DAYS);
  if (urgent.length === 0) return null;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {urgent.map((f) => (
        <Alert
          key={f.mount}
          type={f.daysToFull! < 1 ? 'error' : 'warning'}
          showIcon
          data-testid={`forecast-${f.mount}`}
          message={`${f.mount} 预计 ${f.daysToFull! < 1 ? '1 天内' : `${f.daysToFull!.toFixed(1)} 天后`}写满`}
          description={`当前 ${f.usedPct.toFixed(0)}%，最近 7 天每天增长约 ${f.slopePerDay.toFixed(1)} 个百分点`}
          action={
            <Button size="small" icon={<RobotOutlined />} onClick={() => askDiskAnalysis(hostId, hostName, f)} data-testid="forecast-ask-ai">
              让 AI 分析
            </Button>
          }
        />
      ))}
    </Space>
  );
}

/**
 * 最近 7 天（每小时一条）：CPU / 内存一张图，磁盘每个分区一条线（最多 3 个，按写满的先后）；可以切换成表格查看。
 */
export function MonitorHistory({ hostId, hostName }: { hostId: string; hostName: string }): React.JSX.Element {
  const [data, setData] = useState<{ samples: MetricSample[]; forecast: DiskForecast[] } | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      invoke('monitor.history', { hostId, days: 7 })
        .then((r) => alive && setData(r))
        .catch(() => undefined);
    };
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [hostId]);

  if (!data) return <Typography.Text type="secondary">正在读取历史…</Typography.Text>;
  if (data.samples.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有历史数据（监控运行后每小时记录一次，保留 30 天）" />;

  const ts = data.samples.map((s) => s.ts);
  const mounts = data.forecast.map((f) => f.mount).slice(0, 3);
  return (
    <Space direction="vertical" style={{ width: '100%' }} data-testid="monitor-history">
      <ForecastAlerts hostId={hostId} hostName={hostName} forecast={data.forecast} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as 'chart' | 'table')}
          options={[
            { label: '图表', value: 'chart' },
            { label: '表格', value: 'table' },
          ]}
        />
      </div>
      {view === 'chart' ? (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            CPU / 内存使用率（每小时平均）
          </Typography.Text>
          <HistoryChart
            testId="chart-cpu-mem"
            ts={ts}
            series={[
              { name: 'CPU', values: data.samples.map((s) => s.cpu) },
              { name: '内存', values: data.samples.map((s) => s.mem) },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`磁盘使用率${data.forecast.length > 3 ? '（最先写满的 3 个分区）' : ''}`}
          </Typography.Text>
          <HistoryChart testId="chart-disk" ts={ts} series={mounts.map((m) => ({ name: m, values: data.samples.map((s) => s.disk[m] ?? null) }))} />
          <Table<DiskForecast>
            size="small"
            rowKey="mount"
            pagination={false}
            dataSource={data.forecast}
            columns={[
              { title: '分区', dataIndex: 'mount', render: (v: string) => <span className="mono">{v}</span> },
              { title: '当前', dataIndex: 'usedPct', width: 90, render: (v: number) => `${v.toFixed(0)}%` },
              { title: '每天增长', dataIndex: 'slopePerDay', width: 110, render: (v: number) => (Math.abs(v) < 0.05 ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} 个百分点`) },
              {
                title: '预计写满',
                dataIndex: 'daysToFull',
                width: 130,
                render: (v: number | null, f) => (v === null ? (f.samples < 6 ? '数据不够' : '不会写满') : v < DISK_WARN_DAYS ? <Typography.Text type="danger">{`${v.toFixed(1)} 天`}</Typography.Text> : `${v.toFixed(0)} 天`),
              },
            ]}
          />
        </>
      ) : (
        <Table<MetricSample>
          size="small"
          rowKey="ts"
          pagination={{ pageSize: 24, size: 'small' }}
          dataSource={[...data.samples].reverse()}
          columns={[
            { title: '时间', dataIndex: 'ts', width: 140, render: (v: number) => new Date(v).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) },
            { title: 'CPU', dataIndex: 'cpu', width: 80, render: (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`) },
            { title: '内存', dataIndex: 'mem', width: 80, render: (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}%`) },
            { title: '负载', dataIndex: 'load1', width: 70, render: (v: number | null) => (v === null ? '—' : v.toFixed(2)) },
            ...mounts.map((m) => ({ title: m, key: m, width: 90, render: (_: unknown, s: MetricSample) => (s.disk[m] === undefined ? '—' : `${s.disk[m].toFixed(0)}%`) })),
          ]}
        />
      )}
    </Space>
  );
}
