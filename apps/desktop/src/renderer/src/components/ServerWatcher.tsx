import { useEffect, useRef } from 'react';
import { App, Button } from 'antd';
import { useServer } from '../store/server';
import { useApp } from '../store/app';

/**
 * 远程审批提醒（文档一 6.11）：收到新的审批请求时在应用内提示一次（应用不在前台时主进程另发系统通知）。
 */
export function ServerWatcher(): null {
  const { notification } = App.useApp();
  const approvals = useServer((s) => s.approvals);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    // 启动时已有的审批不弹提醒，只在侧栏显示数量
    void useServer
      .getState()
      .load()
      .catch(() => undefined)
      .finally(() => {
        seen.current = new Set(useServer.getState().approvals.map((a) => a.approvalId));
      });
  }, []);

  useEffect(() => {
    if (!seen.current) return;
    const fresh = approvals.filter((a) => !seen.current!.has(a.approvalId));
    approvals.forEach((a) => seen.current!.add(a.approvalId));
    if (!fresh.length || useApp.getState().page === 'approvals') return;
    const a = fresh[0];
    notification.warning({
      key: 'remote-approval',
      message: fresh.length > 1 ? `有 ${fresh.length} 条命令等你审批` : '有命令等你审批',
      description: `${a.taskName ? `${a.taskName} · ` : ''}${a.host}：${a.command}`.slice(0, 160),
      duration: 0,
      actions: (
        <Button
          size="small"
          type="primary"
          onClick={() => {
            notification.destroy('remote-approval');
            useApp.getState().setPage('approvals');
          }}
          data-testid="approval-notify-open"
        >
          去审批
        </Button>
      ),
    });
  }, [approvals, notification]);

  return null;
}
