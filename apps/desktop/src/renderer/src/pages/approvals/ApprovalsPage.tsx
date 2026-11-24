import { useEffect, useState } from 'react';
import { App, Button, Empty, Input, Popconfirm, Space, Tag, Typography } from 'antd';
import { CheckOutlined, ClockCircleOutlined, CloseOutlined, ExclamationCircleOutlined, SafetyCertificateOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { RemoteApproval } from '@itm/protocol';
import { errorMessage } from '../../api';
import { useServer } from '../../store/server';
import { TopBarSlot } from '../../components/TopBar';

const RISK: Record<string, { text: string; icon: React.ReactNode }> = {
  L0: { text: '安全', icon: <SafetyCertificateOutlined /> },
  L1: { text: '需注意', icon: <ExclamationCircleOutlined /> },
  L2: { text: '危险', icon: <WarningOutlined /> },
};

/** 剩余时间（每秒刷新） */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const left = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function ApprovalCard({ a, now }: { a: RemoteApproval; now: number }): React.JSX.Element {
  const { message } = App.useApp();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const risk = RISK[a.risk] ?? RISK.L1;
  const remain = a.expiresAt - now;
  const decide = async (d: 'APPROVED' | 'REJECTED'): Promise<void> => {
    setBusy(d);
    try {
      await useServer.getState().decide(a.approvalId, d, comment.trim() || undefined);
      message.success(d === 'APPROVED' ? '已批准，执行器会继续执行' : '已拒绝，执行器会跳过这台主机');
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const approve = (
    <Button type="primary" size="small" icon={<CheckOutlined />} loading={busy === 'APPROVED'} disabled={!!busy || remain <= 0} onClick={a.risk === 'L2' ? undefined : () => void decide('APPROVED')} data-testid="approval-approve">
      批准
    </Button>
  );
  return (
    <div className={`step-card approval-card level-${a.risk}`} data-testid="approval-card" data-approval={a.approvalId}>
      <div className={`step-banner level-${a.risk}`}>
        <span className="step-banner-tag">
          {risk.icon}
          {risk.text}
        </span>
        <span className="step-banner-text" data-testid="approval-explanation">
          — {a.explanation ?? '执行器没有给出这条命令的作用说明'}
        </span>
      </div>
      <div className="approval-meta">
        <Typography.Text strong>{a.taskName ?? '定时任务'}</Typography.Text>
        <Tag bordered={false}>{a.host}</Tag>
        <Typography.Text type={remain < 60_000 ? 'danger' : 'secondary'} className="approval-left" data-testid="approval-left">
          <ClockCircleOutlined /> {remain > 0 ? `剩余 ${left(remain)}` : '已过期'}
        </Typography.Text>
      </div>
      <pre className="approval-command" data-testid="approval-command">
        {a.command}
      </pre>
      {a.reasons.length > 0 && (
        <ul className="approval-reasons">
          {a.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
      {a.diff && (
        <details className="approval-diff">
          <summary>查看改动</summary>
          <pre>{a.diff}</pre>
        </details>
      )}
      <div className="approval-actions">
        <Input size="small" placeholder="备注（可选，会记入审计）" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} data-testid="approval-comment" />
        <Space>
          <Button size="small" danger icon={<CloseOutlined />} loading={busy === 'REJECTED'} disabled={!!busy} onClick={() => void decide('REJECTED')} data-testid="approval-reject">
            拒绝
          </Button>
          {a.risk === 'L2' ? (
            <Popconfirm title="这是高危命令，确认批准执行？" okText="批准" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => decide('APPROVED')}>
              {approve}
            </Popconfirm>
          ) : (
            approve
          )}
        </Space>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        收到于 {dayjs(a.receivedAt).format('MM-DD HH:mm:ss')} · 任务运行 {a.runId}
      </Typography.Text>
    </div>
  );
}

/**
 * 远程审批（文档一 6.11，审批人侧）：无人值守任务需要人批准的命令。
 * 批准 / 拒绝后发给服务端，由执行器继续或跳过；别人处理过的会自动移除。
 */
export function ApprovalsPage(): React.JSX.Element {
  const approvals = useServer((s) => s.approvals);
  const server = useServer((s) => s.state);
  const now = useNow();
  useEffect(() => {
    void useServer.getState().load();
  }, []);
  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title">
            <span className="topbar-page-name">审批</span>
          </div>
          <div className="topbar-ctx-actions">
            <span className="topbar-page-sub">
              {server?.status === 'online' ? '已连接服务端，新的审批会实时出现' : '没有连接服务端：审批暂时收不到，连上后自动刷新'}
            </span>
          </div>
        </div>
      </TopBarSlot>
      <div className="approvals-body" data-testid="approvals-page">
        {approvals.length === 0 ? (
          <Empty description="没有等你审批的命令" style={{ marginTop: 80 }} />
        ) : (
          approvals.map((a) => <ApprovalCard key={a.approvalId} a={a} now={now} />)
        )}
      </div>
    </>
  );
}
