import { Button, Space, Tooltip } from 'antd';
import { CloseCircleFilled, CloseOutlined, CodeOutlined, EditOutlined, LoadingOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons';
import type { ConnLogEntry, ConnProgress, ConnStep, ConnStepStatus } from '@itm/protocol';
import { ConnLogList, ConnStepper, SSH_STEPS, TELNET_STEPS } from './ConnLog';

export interface ProgressState {
  steps: Record<ConnStep, ConnStepStatus>;
  entries: ConnLogEntry[];
  state: ConnProgress['state'];
  error?: string;
}

export const EMPTY_PROGRESS: ProgressState = {
  steps: { connect: 'pending', auth: 'pending', channel: 'pending', ready: 'pending' },
  entries: [],
  state: 'connecting',
};

/** 合并一条进度事件 */
export function mergeProgress(prev: ProgressState, p: ConnProgress): ProgressState {
  return { steps: p.steps, entries: [...prev.entries, ...p.entries].slice(-300), state: p.state, error: p.error ?? prev.error };
}

/** 失败原因对应的建议 */
function advice(error: string): string | null {
  if (/握手超时|SSH 服务/.test(error)) return '确认端口运行的是 SSH 服务，并检查设备的 SSH Banner / 协议兼容性';
  if (/拒绝/.test(error)) return '确认地址和端口正确、SSH 服务已启动，并检查防火墙';
  if (/超时|不可达/.test(error)) return '检查网络是否连通、是否需要跳板机或代理';
  if (/认证|密码|私钥|口令/.test(error)) return '检查用户名、密码或私钥，可以在「编辑主机」里修改';
  if (/指纹/.test(error)) return '主机指纹变化可能意味着服务器重装，也可能是中间人攻击，请先和管理员确认';
  if (/解析/.test(error)) return '检查主机地址拼写或 DNS 设置';
  return null;
}

/**
 * 连接进度小窗（文档一 6.15.3）：终端区域中央的卡片，显示四个步骤和彩色连接日志；连接中可以取消，失败后可以重试或编辑主机。
 */
export function ConnectProgress({
  kind,
  title,
  progress,
  onCancel,
  onRetry,
  onEdit,
  onDismiss,
}: {
  kind: 'ssh' | 'telnet';
  title: string;
  progress: ProgressState;
  onCancel(): void;
  onRetry(): void;
  onEdit?: () => void;
  onDismiss(): void;
}): React.JSX.Element {
  const failed = progress.state === 'error';
  const label = kind === 'ssh' ? 'SSH' : 'Telnet';
  const tip = failed && progress.error ? advice(progress.error) : null;
  return (
    <div className="conn-overlay" data-testid="conn-progress" data-state={progress.state}>
      <div className={`conn-card ${failed ? 'failed' : ''}`}>
        <div className="conn-card-head">
          <span className={`conn-card-icon ${failed ? 'failed' : ''}`}>{failed ? <CloseCircleFilled /> : <LoadingOutlined />}</span>
          <div className="conn-card-title">
            <div>{failed ? `${label} 连接失败` : `${label} 连接中…`}</div>
            <div className="conn-card-sub">{title}</div>
          </div>
          <Tooltip title={failed ? '关闭' : '取消连接'}>
            <Button type="text" size="small" icon={<CloseOutlined />} onClick={failed ? onDismiss : onCancel} data-testid="conn-close" />
          </Tooltip>
        </div>
        <ConnStepper steps={progress.steps} items={kind === 'ssh' ? SSH_STEPS : TELNET_STEPS} />
        <div className="conn-log-box">
          <div className="conn-log-title">
            <CodeOutlined /> 连接日志
          </div>
          <ConnLogList entries={progress.entries} />
        </div>
        {failed && progress.error && (
          <div className="conn-card-error" data-testid="conn-error">
            <div>{progress.error}</div>
            {tip && <div className="conn-card-tip">建议：{tip}</div>}
          </div>
        )}
        <div className="conn-card-foot">
          {failed ? (
            <Space>
              {onEdit && (
                <Button icon={<EditOutlined />} onClick={onEdit} data-testid="conn-edit">
                  编辑主机
                </Button>
              )}
              <Button onClick={onDismiss}>关闭</Button>
              <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry} data-testid="conn-retry">
                重试
              </Button>
            </Space>
          ) : (
            <Button danger type="primary" icon={<StopOutlined />} onClick={onCancel} data-testid="conn-cancel">
              取消连接
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
