import { useState } from 'react';
import { Collapse, Progress, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleFilled, ClockCircleOutlined, CloseCircleFilled, LoadingOutlined, MinusCircleOutlined, PauseCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { SkillRisk, SkillRunHost, SkillRunView } from '@itm/protocol';
import { Markdown } from '../Markdown';

const RISK: Record<SkillRisk, { text: string; color: string }> = {
  readonly: { text: '只读', color: 'green' },
  'write-needs-approval': { text: '写操作需批准', color: 'orange' },
  dangerous: { text: '高危', color: 'red' },
};

const STATUS: Record<SkillRunHost['status'], { icon: React.ReactNode; text: string }> = {
  queued: { icon: <ClockCircleOutlined style={{ color: 'var(--itm-text-secondary)' }} />, text: '排队中' },
  running: { icon: <LoadingOutlined style={{ color: 'var(--itm-primary)' }} />, text: '执行中' },
  waiting: { icon: <PauseCircleOutlined style={{ color: '#faad14' }} />, text: '等待批准' },
  done: { icon: <CheckCircleFilled style={{ color: '#52c41a' }} />, text: '完成' },
  error: { icon: <CloseCircleFilled style={{ color: '#ff4d4f' }} />, text: '失败' },
  canceled: { icon: <MinusCircleOutlined style={{ color: 'var(--itm-text-secondary)' }} />, text: '已取消' },
};

function Md({ text }: { text: string }): React.JSX.Element {
  return <Markdown text={text} />;
}

/**
 * Skill 运行卡片（文档一 7.6）：按主机逐行显示进度和结论，展开看执行过的命令；结束后显示汇总。
 */
export function SkillRunCard({ run }: { run: SkillRunView }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const finished = run.hosts.filter((h) => h.status === 'done' || h.status === 'error' || h.status === 'canceled').length;
  const failed = run.hosts.filter((h) => h.status === 'error').length;
  const percent = Math.round((finished / Math.max(1, run.hosts.length)) * 100);
  const params = Object.entries(run.params);

  return (
    <div className="skill-run" data-testid="skill-run" data-status={run.status}>
      <div className="skill-run-head">
        <ThunderboltOutlined style={{ color: '#b37feb' }} />
        <Typography.Text strong>{run.skillName}</Typography.Text>
        <Tag bordered={false}>{run.mode === 'parallel' ? `并行 ×${run.concurrency}` : '单个 Agent'}</Tag>
        <Tag bordered={false} color={RISK[run.risk].color}>
          {RISK[run.risk].text}
        </Tag>
        <Typography.Text type="secondary" style={{ marginLeft: 'auto', fontSize: 12 }} data-testid="skill-run-progress">
          {run.status === 'running' ? `${finished} / ${run.hosts.length}` : run.status === 'stopped' ? '已停止' : `${run.hosts.length - failed} 台完成${failed ? `，${failed} 台失败` : ''}`}
        </Typography.Text>
      </div>
      {params.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`参数：${params.map(([k, v]) => `${k}=${v}`).join('，')}`}
        </Typography.Text>
      )}
      {run.status === 'running' && <Progress percent={percent} size="small" showInfo={false} style={{ margin: '4px 0 0' }} />}
      <div className="skill-run-hosts">
        {run.hosts.map((h) => {
          const key = h.hostId;
          const firstLine = (h.error ?? h.result).split('\n').find((l) => l.trim()) ?? '';
          return (
            <div key={key} className="skill-run-host" data-testid={`skill-host-${h.name}`} data-status={h.status}>
              <div className="skill-run-row" onClick={() => setOpen(open === key ? null : key)}>
                <Tooltip title={STATUS[h.status].text}>{STATUS[h.status].icon}</Tooltip>
                <span className="skill-run-name">{h.name}</span>
                <Typography.Text type={h.status === 'error' ? 'danger' : 'secondary'} ellipsis style={{ flex: 1, fontSize: 12 }}>
                  {firstLine || STATUS[h.status].text}
                </Typography.Text>
                {h.commands.length > 0 && <Tag bordered={false} style={{ marginRight: 0 }}>{`${h.commands.length} 条命令`}</Tag>}
              </div>
              {open === key && (
                <div className="skill-run-detail">
                  {h.commands.map((c, i) => (
                    <div key={i} className="skill-run-cmd mono">
                      {STATUS[c.status === 'done' ? 'done' : c.status === 'error' ? 'error' : c.status === 'rejected' ? 'canceled' : c.status === 'approval' ? 'waiting' : 'running'].icon}
                      <span>{c.command}</span>
                      {c.exitCode !== null && <span className="skill-run-exit">{`退出码 ${c.exitCode}`}</span>}
                    </div>
                  ))}
                  {run.mode === 'parallel' && h.result && <Md text={h.result} />}
                  {h.error && <Typography.Text type="danger">{h.error}</Typography.Text>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {run.summary && (
        <Collapse
          size="small"
          ghost
          defaultActiveKey={['s']}
          items={[{ key: 's', label: run.mode === 'parallel' ? '汇总' : '结论', children: <Md text={run.summary} /> }]}
          data-testid="skill-run-summary"
        />
      )}
      {run.status === 'running' && (
        <Space style={{ fontSize: 12 }}>
          <Typography.Text type="secondary">写操作会合并成一张批量审批卡片，可以逐台勾选。</Typography.Text>
        </Space>
      )}
    </div>
  );
}
