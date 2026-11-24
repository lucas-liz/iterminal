import { useEffect, useRef } from 'react';
import { App, Button } from 'antd';
import { useAccount } from '../../store/account';

/**
 * 登录过期 / 设备被吊销时提醒一次（文档二 6.1）：定时任务、远程审批和审计上报都会暂停，重新登录后自动恢复。
 */
export function AccountWatcher(): null {
  const { notification } = App.useApp();
  const state = useAccount((s) => s.state);
  const last = useRef(state?.status);

  useEffect(() => {
    const prev = last.current;
    last.current = state?.status;
    if (!state || prev !== 'valid' || (state.status !== 'expired' && state.status !== 'revoked')) return;
    notification.error({
      key: 'account-expired',
      message: state.status === 'revoked' ? '这台设备已被管理员吊销' : '登录已过期',
      description: `${state.message ?? ''}。定时任务、远程审批和审计上报已暂停，重新登录后自动恢复。`,
      duration: 0,
      actions: (
        <Button
          size="small"
          type="primary"
          data-testid="account-expired-relogin"
          onClick={() => {
            notification.destroy('account-expired');
            useAccount.getState().openLogin({ username: state.username ?? '' });
          }}
        >
          重新登录
        </Button>
      ),
    });
  }, [state, notification]);

  return null;
}
