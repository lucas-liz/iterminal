import { useMemo, useState } from 'react';
import { App, Button, Drawer, Empty, Progress, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, CopyOutlined, LoadingOutlined, MinusCircleFilled, StopOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { BATCH_HOST_STATUS_LABEL, BATCH_STATUS_LABEL, type BatchHostResult, type BatchJob } from '@itm/protocol';
import { invoke } from '../../api';

const STATUS_COLOR: Record<BatchJob['status'], string> = { running: 'processing', success: 'success', failed: 'error', partial: 'warning', cancelled: 'default' };

/** 任务状态标签；withCounts 时后面带成功 / 失败台数 */
export function BatchStatusTag({ job, withCounts }: { job: BatchJob; withCounts?: boolean }): React.JSX.Element {
  const done = job.counts.success + job.counts.failed;
  return (
    <span className="batch-status-tag">
      <Tag bordered={false} color={STATUS_COLOR[job.status]} icon={job.status === 'running' ? <LoadingOutlined /> : undefined}>
        {job.status === 'running' ? `执行中 ${done}/${job.hostCount}` : BATCH_STATUS_LABEL[job.status]}
      </Tag>
      {withCounts && job.status !== 'running' && (job.counts.failed > 0 || job.status === 'partial') && (
        <Typography.Text type="secondary" className="batch-status-counts">{`${job.counts.success} 成功 / ${job.counts.failed} 失败`}</Typography.Text>
      )}
    </span>
  );
}

function HostIcon({ h }: { h: BatchHostResult }): React.JSX.Element {
  if (h.status === 'success') return <CheckCircleFilled className="batch-host-icon ok" />;
  if (h.status === 'running') return <LoadingOutlined className="batch-host-icon run" />;
  if (h.status === 'pending') return <MinusCircleFilled className="batch-host-icon wait" />;
  if (h.status === 'cancelled') return <StopOutlined className="batch-host-icon wait" />;
  return <CloseCircleFilled className="batch-host-icon bad" />;
}

const elapsed = (h: BatchHostResult): string => {
  if (!h.startedAt) return '';
  const ms = (h.endedAt ?? Date.now()) - h.startedAt;
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}min ${Math.round((ms % 60_000) / 1000)}s`;
};

/** 执行详情：每台主机的状态、退出码、输出；执行中实时刷新 */
export function BatchJobDrawer({ job, onClose }: { job: BatchJob | null; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [filter, setFilter] = useState<'all' | 'failed' | 'success'>('all');
  const [open, setOpen] = useState<string | null>(null);
  const hosts = useMemo(() => {
    const list = job?.hosts ?? [];
    if (filter === 'failed') return list.filter((h) => h.status !== 'success' && h.status !== 'running' && h.status !== 'pending');
    if (filter === 'success') return list.filter((h) => h.status === 'success');
    return list;
  }, [job, filter]);
  const exec = job?.kind === 'exec';
  const done = job ? job.counts.success + job.counts.failed : 0;

  return (
    <Drawer
      open={!!job}
      onClose={onClose}
      width={760}
      destroyOnHidden
      title={
        job && (
          <div className="batch-drawer-title">
            <span>{exec ? '执行详情' : '上传详情'}</span>
            <BatchStatusTag job={job} />
          </div>
        )
      }
      extra={
        job?.status === 'running' && (
          <Button danger size="small" onClick={() => void invoke('batch.cancel', { id: job.id })} data-testid="batch-cancel">
            取消执行
          </Button>
        )
      }
      data-testid="batch-drawer"
    >
      {job && (
        <div className="batch-drawer">
          <div className="batch-drawer-meta">
            {job.description && (
              <div>
                <span className="k">描述</span>
                <span>{job.description}</span>
              </div>
            )}
            <div>
              <span className="k">时间</span>
              <span>{`${dayjs(job.createdAt).format('YYYY-MM-DD HH:mm:ss')}${job.endedAt ? ` → ${dayjs(job.endedAt).format('HH:mm:ss')}` : ''}`}</span>
            </div>
            {exec ? (
              <div>
                <span className="k">方式</span>
                <span>{`${job.script ? '脚本执行' : '命令执行'} · 超时 ${job.timeoutSec ? `${job.timeoutSec} 秒` : '不限制'}`}</span>
              </div>
            ) : (
              <>
                <div>
                  <span className="k">路径</span>
                  <span className="mono">{job.remotePath}</span>
                </div>
                <div>
                  <span className="k">文件</span>
                  <span>{`${job.fileCount} 个：${job.files.map((f) => f.name).join('、')}`}</span>
                </div>
              </>
            )}
          </div>
          {exec && (
            <div className="batch-drawer-cmd">
              <pre className="mono">{job.command}</pre>
              <Tooltip title="复制命令">
                <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(job.command ?? '').then(() => message.success('已复制'))} />
              </Tooltip>
            </div>
          )}
          <div className="batch-drawer-bar">
            <Progress
              percent={job.hostCount ? Math.round((done / job.hostCount) * 100) : 0}
              success={{ percent: job.hostCount ? Math.round((job.counts.success / job.hostCount) * 100) : 0 }}
              size="small"
              status={job.status === 'running' ? 'active' : job.counts.failed ? 'exception' : 'success'}
              format={() => `${done}/${job.hostCount}`}
            />
            <Segmented
              size="small"
              value={filter}
              onChange={(v) => setFilter(v as typeof filter)}
              options={[
                { value: 'all', label: `全部 ${job.hostCount}` },
                { value: 'success', label: `成功 ${job.counts.success}` },
                { value: 'failed', label: `失败 ${job.counts.failed}` },
              ]}
            />
          </div>
          <div className="batch-host-list" data-testid="batch-host-list">
            {hosts.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有符合条件的主机" />
            ) : (
              hosts.map((h) => {
                const expanded = open === h.hostId || (hosts.length === 1 && open === null);
                const pct = h.totalBytes ? Math.round(((h.bytes ?? 0) / h.totalBytes) * 100) : null;
                return (
                  <div key={h.hostId} className={`batch-host-row s-${h.status}`} data-testid={`batch-host-${h.hostName}`} data-status={h.status}>
                    <div className="batch-host-head" onClick={() => setOpen(expanded ? '' : h.hostId)}>
                      <HostIcon h={h} />
                      <span className="batch-host-name">{h.hostName}</span>
                      <span className="batch-host-addr mono">{`${h.username ? `${h.username}@` : ''}${h.address}`}</span>
                      <span className="batch-host-flex" />
                      {!exec && h.status === 'running' && pct !== null && <Progress percent={pct} size="small" style={{ width: 120, margin: 0 }} />}
                      {h.exitCode !== null && h.exitCode !== 0 && <Tag bordered={false} color="error">{`退出码 ${h.exitCode}`}</Tag>}
                      <span className="batch-host-status">{BATCH_HOST_STATUS_LABEL[h.status]}</span>
                      <span className="batch-host-time">{elapsed(h)}</span>
                    </div>
                    {expanded && (
                      <div className="batch-host-body">
                        {h.error && <div className="batch-host-error">{h.error}</div>}
                        {h.output ? (
                          <pre className="batch-host-output mono" data-testid="batch-host-output">
                            {h.output}
                          </pre>
                        ) : (
                          !h.error && <Typography.Text type="secondary">{h.status === 'running' || h.status === 'pending' ? '等待输出…' : '（没有输出）'}</Typography.Text>
                        )}
                        {h.output && (
                          <Space className="batch-host-tools">
                            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(h.output).then(() => message.success('已复制输出'))}>
                              复制输出
                            </Button>
                          </Space>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
