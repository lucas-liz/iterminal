import { useMemo, useState } from 'react';
import { Button, Empty, Modal, Space, Tag, Tooltip, Typography } from 'antd';
import { CaretRightOutlined, CloseOutlined, DeleteOutlined, EditOutlined, FolderOpenOutlined, PauseOutlined } from '@ant-design/icons';
import type { RemoteEditState, TransferState } from '@itm/protocol';
import { invoke } from '../../api';
import { isActive, useTransfers, type TransferView } from '../../store/transfers';
import { useEdits } from '../../store/edits';
import { formatSize } from '../../util/format';

const STATUS: Record<TransferState['status'], { text: string; color: string }> = {
  queued: { text: '排队中', color: 'default' },
  running: { text: '传输中', color: 'processing' },
  paused: { text: '已暂停', color: 'warning' },
  done: { text: '完成', color: 'success' },
  error: { text: '失败', color: 'error' },
  canceled: { text: '已取消', color: 'default' },
};
const EDIT_LABEL: Record<RemoteEditState['state'], string> = { watching: '编辑中', uploading: '正在回传', uploaded: '已保存', conflict: '远端有冲突', error: '回传失败', stopped: '已结束' };

const pct = (t: TransferState): number => (t.total > 0 ? (t.transferred / t.total) * 100 : t.status === 'done' ? 100 : 0);
const dirLabel = (t: TransferState): string => (t.direction === 'upload' ? '上传' : '下载');

/** 「44.97 MB / 204.35 MB (22.0%) · 2.33 MB/s · 跳过 1 个」 */
export function transferDetail(t: TransferState): string {
  if (t.status === 'error') return t.message ?? '失败';
  const extra = [t.skipped ? `跳过 ${t.skipped} 个` : '', t.retries ? `重试 ${t.retries} 次` : ''].filter(Boolean);
  const base = `${formatSize(t.transferred)} / ${formatSize(t.total)} (${pct(t).toFixed(1)}%)${t.status === 'running' && t.speed ? ` · ${formatSize(t.speed)}/s` : ''}`;
  return [base, ...extra].join(' · ');
}

function TransferItem({ t }: { t: TransferView }): React.JSX.Element {
  const s = STATUS[t.status];
  const removeOne = useTransfers((x) => x.remove);
  const path = t.localPath;
  return (
    <div className={`transfer-item status-${t.status}`} data-testid={`transfer-${t.name}`} data-status={t.status}>
      <div className="transfer-item-main">
        <div className="transfer-item-title">
          <Tag color={s.color} bordered={false}>
            {s.text}
          </Tag>
          <Typography.Text ellipsis={{ tooltip: t.direction === 'upload' ? `${t.localPath ?? ''} → ${t.remotePath ?? ''}` : `${t.remotePath ?? ''} → ${t.localPath ?? ''}` }}>
            {dirLabel(t)}: {t.name}
          </Typography.Text>
        </div>
        <Typography.Text type={t.status === 'error' ? 'danger' : 'secondary'} className="mono transfer-item-detail" data-testid={`transfer-detail-${t.name}`}>
          {transferDetail(t)}
        </Typography.Text>
        {isActive(t) && (
          <div className="transfer-item-bar">
            <div className={`transfer-item-fill status-${t.status}`} style={{ width: `${pct(t)}%` }} />
          </div>
        )}
      </div>
      <Space size={6}>
        {t.status === 'running' && (
          <Tooltip title="暂停（继续时从断点续传）">
            <Button size="small" icon={<PauseOutlined />} onClick={() => void invoke('transfer.pause', { transferId: t.transferId })} data-testid="transfer-pause" />
          </Tooltip>
        )}
        {t.status === 'paused' && (
          <Tooltip title="继续">
            <Button size="small" icon={<CaretRightOutlined />} onClick={() => void invoke('transfer.resume', { transferId: t.transferId })} data-testid="transfer-resume" />
          </Tooltip>
        )}
        {isActive(t) ? (
          <Tooltip title="取消">
            <Button size="small" icon={<CloseOutlined />} onClick={() => void invoke('transfer.cancel', { transferId: t.transferId })} data-testid="transfer-cancel" />
          </Tooltip>
        ) : (
          <>
            {path && (
              <Tooltip title={t.direction === 'download' ? '在访达 / 资源管理器中显示' : '显示本机的源文件'}>
                <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void invoke('local.reveal', { path })} data-testid="transfer-reveal" />
              </Tooltip>
            )}
            <Tooltip title="从历史记录中删除（不删除文件）">
              <Button size="small" icon={<DeleteOutlined />} onClick={() => removeOne(t.transferId)} data-testid="transfer-remove" />
            </Tooltip>
          </>
        )}
      </Space>
    </div>
  );
}

/**
 * 文件面板底部的传输条（第十六轮，参考 iShell）：
 * - 传输中：底色按进度填充，显示「上传 / 下载、文件名、百分比、已传 / 总大小、速度」，一批有多个文件时显示「第几个 / 共几个」；
 * - 空闲时显示「传输：N」（历史记录条数）；
 * - 点击打开「传输列表」：进行中（暂停 / 继续 / 取消）、编辑中、历史记录（显示文件、删除记录）。
 */
export function TransferBar({ sftpId }: { sftpId: string }): React.JSX.Element | null {
  const all = useTransfers((s) => s.items);
  const clearFinished = useTransfers((s) => s.clearFinished);
  const editMap = useEdits((s) => s.edits);
  const [open, setOpen] = useState(false);
  const items = useMemo(() => all.filter((t) => t.sftpId === sftpId), [all, sftpId]);
  const edits = useMemo(() => Object.values(editMap).filter((e) => e.sftpId === sftpId), [editMap, sftpId]);
  const active = items.filter(isActive);
  const history = items.filter((t) => !isActive(t)).reverse();
  const current = active.find((t) => t.status === 'running') ?? active.find((t) => t.status === 'queued') ?? active[0];
  if (!items.length && !edits.length) return null;

  let bar: React.ReactNode;
  if (current) {
    const batch = items.filter((t) => t.batch === current.batch);
    const index = batch.indexOf(current) + 1;
    bar = (
      <button type="button" className={`transfer-strip active status-${current.status}`} onClick={() => setOpen(true)} data-testid="transfer-strip">
        <span className="transfer-strip-fill" style={{ width: `${pct(current)}%` }} />
        <span className="transfer-strip-tag">{dirLabel(current)}</span>
        <span className="transfer-strip-name">{current.name}</span>
        <span className="transfer-strip-meta mono">
          {current.status === 'paused' ? '已暂停 ' : ''}
          {pct(current).toFixed(1)}% {formatSize(current.transferred)}/{formatSize(current.total)}
          {current.status === 'running' && current.speed ? ` · ${formatSize(current.speed)}/s` : ''}
        </span>
        {batch.length > 1 && <span className="transfer-strip-count mono">{`${index}/${batch.length}`}</span>}
      </button>
    );
  } else {
    const failed = history.filter((t) => t.status === 'error').length;
    bar = (
      <button type="button" className="transfer-strip idle" onClick={() => setOpen(true)} data-testid="transfer-strip">
        传输：{history.length}
        {failed > 0 && <span className="transfer-strip-failed">（失败 {failed}）</span>}
        {edits.length > 0 && <span className="transfer-strip-edit"> · 编辑中 {edits.length}</span>}
      </button>
    );
  }

  return (
    <>
      <div className="transfer-strip-wrap" data-testid="transfers">
        {bar}
      </div>
      <Modal
        open={open}
        title={
          <div>
            <div>传输列表</div>
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              上传 / 下载
            </Typography.Text>
          </div>
        }
        onCancel={() => setOpen(false)}
        width={620}
        footer={
          <Space>
            {history.length > 0 && (
              <Button onClick={() => clearFinished(sftpId)} data-testid="transfer-clear">
                清除历史
              </Button>
            )}
            <Button onClick={() => setOpen(false)}>关闭</Button>
          </Space>
        }
        data-testid="transfer-modal"
      >
        {active.length > 0 && (
          <div className="transfer-section">
            <div className="transfer-section-title">进行中</div>
            {active.map((t) => (
              <TransferItem key={t.transferId} t={t} />
            ))}
          </div>
        )}
        {edits.length > 0 && (
          <div className="transfer-section">
            <div className="transfer-section-title">编辑中（保存后自动回传）</div>
            {edits.map((e) => (
              <div key={e.editId} className="transfer-item" data-testid={`edit-${e.path.split('/').pop()}`} data-state={e.state}>
                <div className="transfer-item-main">
                  <div className="transfer-item-title">
                    <Tag bordered={false} icon={<EditOutlined />} color={e.state === 'error' ? 'error' : e.state === 'conflict' ? 'warning' : 'processing'}>
                      {EDIT_LABEL[e.state]}
                    </Tag>
                    <Typography.Text ellipsis={{ tooltip: e.path }}>{e.path.split('/').pop()}</Typography.Text>
                  </div>
                  <Typography.Text type="secondary" className="transfer-item-detail">
                    {e.message ?? (e.savedAt ? `最近保存 ${new Date(e.savedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '用本机程序编辑，保存后自动回传')}
                  </Typography.Text>
                </div>
                <Space size={6}>
                  <Tooltip title="显示临时文件">
                    <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void invoke('local.reveal', { path: e.localPath })} />
                  </Tooltip>
                  <Tooltip title="结束编辑（删除临时文件）">
                    <Button size="small" icon={<CloseOutlined />} onClick={() => void invoke('sftp.editStop', { editId: e.editId })} data-testid="edit-stop" />
                  </Tooltip>
                </Space>
              </div>
            ))}
          </div>
        )}
        {history.length > 0 && (
          <div className="transfer-section">
            <div className="transfer-section-title">历史记录</div>
            {history.map((t) => (
              <TransferItem key={t.transferId} t={t} />
            ))}
          </div>
        )}
        {!active.length && !edits.length && !history.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有传输记录" />}
      </Modal>
    </>
  );
}
