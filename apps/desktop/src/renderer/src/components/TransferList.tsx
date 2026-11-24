import { useMemo } from 'react';
import { Button, Tag, Tooltip, Typography } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CaretRightOutlined, CloseOutlined, EditOutlined, FolderOpenOutlined, PauseOutlined } from '@ant-design/icons';
import type { RemoteEditState, TransferState } from '@itm/protocol';
import { invoke } from '../api';
import { useTransfers } from '../store/transfers';
import { useEdits } from '../store/edits';
import { formatSize } from '../util/format';

const EDIT_LABEL: Record<RemoteEditState['state'], { text: string; color?: string }> = {
  watching: { text: '编辑中' },
  uploading: { text: '正在回传', color: 'processing' },
  uploaded: { text: '已保存', color: 'success' },
  conflict: { text: '远端有冲突', color: 'warning' },
  error: { text: '回传失败', color: 'error' },
  stopped: { text: '已结束' },
};

/** 运行中显示「已传 / 总大小 · 速度」，附带跳过和重试的次数 */
function detail(t: TransferState): string {
  const extra = [t.skipped ? `跳过 ${t.skipped} 个` : '', t.retries ? `重试 ${t.retries} 次` : ''].filter(Boolean).join(' · ');
  if (t.status === 'error') return t.message ?? '失败';
  if (t.status === 'canceled') return '已取消';
  if (t.status === 'queued') return '排队中';
  if (t.status === 'paused') return `已暂停 · ${formatSize(t.transferred)} / ${formatSize(t.total)}`;
  const base = `${formatSize(t.transferred)} / ${formatSize(t.total)}${t.status === 'running' && t.speed ? ` · ${formatSize(t.speed)}/s` : ''}`;
  return extra ? `${base} · ${extra}` : base;
}

/** 某个 SFTP 会话的传输队列 */
export function TransferList({ sftpId, compact = false }: { sftpId: string | null; compact?: boolean }): React.JSX.Element | null {
  const all = useTransfers((s) => s.items);
  const clearFinished = useTransfers((s) => s.clearFinished);
  const transfers = useMemo(() => all.filter((t) => t.sftpId === sftpId), [all, sftpId]);
  const editMap = useEdits((s) => s.edits);
  const edits = useMemo(() => Object.values(editMap).filter((e) => e.sftpId === sftpId), [editMap, sftpId]);
  if (!sftpId || (transfers.length === 0 && edits.length === 0)) return null;
  return (
    <div className="transfer-panel" data-testid="transfers">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          传输队列
        </Typography.Text>
        <Button size="small" type="link" onClick={() => clearFinished(sftpId)}>
          清除已完成
        </Button>
      </div>
      {edits.map((e) => (
        <div className="transfer-row" key={e.editId} data-testid={`edit-${e.path.split('/').pop()}`} data-state={e.state}>
          <EditOutlined />
          <span className="name mono" title={e.path} style={compact ? { width: 110 } : undefined}>
            {e.path.split('/').pop()}
          </span>
          <Tag color={EDIT_LABEL[e.state].color} bordered={false}>
            {EDIT_LABEL[e.state].text}
          </Tag>
          {!compact && (
            <Typography.Text type="secondary" style={{ flex: 1, fontSize: 12 }}>
              {e.message ?? (e.savedAt ? `最近保存 ${new Date(e.savedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '用默认程序编辑，保存后自动回传')}
            </Typography.Text>
          )}
          <Tooltip title="显示临时文件">
            <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => void invoke('local.reveal', { path: e.localPath })} />
          </Tooltip>
          <Tooltip title="结束编辑（删除临时文件）">
            <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => void invoke('sftp.editStop', { editId: e.editId })} data-testid="edit-stop" />
          </Tooltip>
        </div>
      ))}
      {transfers.map((t) => {
        const percent = t.total > 0 ? Math.floor((t.transferred / t.total) * 100) : t.status === 'done' ? 100 : 0;
        return (
          <div className="transfer-row" key={t.transferId} data-testid={`transfer-${t.name}`} data-status={t.status}>
            {t.direction === 'upload' ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
            <span className="name" title={t.name} style={compact ? { width: 110 } : undefined}>
              {t.name}
            </span>
            <div className="transfer-bar">
              <div className={`transfer-bar-fill ${t.status}`} style={{ width: `${percent}%` }} />
            </div>
            <Typography.Text type="secondary" style={{ width: 40, fontSize: 12, textAlign: 'right' }}>
              {`${percent}%`}
            </Typography.Text>
            {!compact && (
              <Typography.Text type="secondary" style={{ width: 260, fontSize: 12 }} ellipsis={{ tooltip: detail(t) }} data-testid={`transfer-detail-${t.name}`}>
                {detail(t)}
              </Typography.Text>
            )}
            {compact && t.status === 'error' && (
              <Typography.Text type="danger" style={{ fontSize: 12 }} title={t.message}>
                失败
              </Typography.Text>
            )}
            {t.status === 'running' && (
              <Tooltip title="暂停（继续时从断点续传）">
                <Button size="small" type="text" icon={<PauseOutlined />} onClick={() => void invoke('transfer.pause', { transferId: t.transferId })} />
              </Tooltip>
            )}
            {t.status === 'paused' && (
              <Tooltip title="继续">
                <Button size="small" type="text" icon={<CaretRightOutlined />} onClick={() => void invoke('transfer.resume', { transferId: t.transferId })} />
              </Tooltip>
            )}
            {(t.status === 'running' || t.status === 'queued' || t.status === 'paused') && (
              <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => void invoke('transfer.cancel', { transferId: t.transferId })} />
            )}
          </div>
        );
      })}
    </div>
  );
}
