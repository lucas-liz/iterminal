import { useEffect } from 'react';
import { App, Button, Typography } from 'antd';
import { errorMessage } from '../api';
import { useApp } from '../store/app';
import { useUpdate } from '../store/update';

/**
 * 登录页 / 登录框 / 解锁页底部的「检查更新」（第十五轮）：自动更新不属于档案，没有登录、还没输入主密码时也能检查和安装。
 * 发现新版本后由 UpdateWatcher 弹出提示（低于最低支持版本时是强制升级的窗口）。
 */
export function UpdateCheckLink(): React.JSX.Element | null {
  const { message } = App.useApp();
  const st = useUpdate((s) => s.state);
  const version = useApp((s) => s.info?.version);
  useEffect(() => {
    if (!st) void useUpdate.getState().load().catch(() => undefined);
  }, [st]);
  if (!st) return null;
  const run = (p: Promise<unknown>): void => void p.catch((e) => message.error(errorMessage(e)));
  const text =
    st.status === 'checking'
      ? '正在检查…'
      : st.status === 'available'
        ? `发现新版本 ${st.available?.version ?? ''}`
        : st.status === 'not-available'
          ? '已经是最新版本'
          : st.status === 'downloading'
            ? `正在下载 ${Math.round(st.progress?.percent ?? 0)}%`
            : st.status === 'downloaded'
              ? '更新已下载'
              : st.status === 'error'
                ? (st.error ?? '检查失败')
                : '';
  return (
    <div className="update-check-link" data-testid="update-check-link">
      <Typography.Text type="secondary">版本 {version ?? st.currentVersion}</Typography.Text>
      {text && (
        <Typography.Text type={st.status === 'error' ? 'danger' : st.status === 'available' || st.status === 'downloaded' ? 'success' : 'secondary'} ellipsis style={{ maxWidth: 220 }}>
          {text}
        </Typography.Text>
      )}
      {st.status === 'error' && st.available && (
        <Button type="link" size="small" onClick={() => run(useUpdate.getState().saveInstaller())} data-testid="update-link-manual">
          手动下载
        </Button>
      )}
      {st.status === 'available' ? (
        <Button type="link" size="small" onClick={() => run(useUpdate.getState().download())} data-testid="update-link-download">
          下载更新
        </Button>
      ) : st.status === 'downloaded' ? (
        <Button type="link" size="small" onClick={() => run(useUpdate.getState().install())} data-testid="update-link-install">
          重启并安装
        </Button>
      ) : (
        <Button type="link" size="small" loading={st.status === 'checking'} disabled={!st.feedUrl || st.status === 'downloading'} onClick={() => run(useUpdate.getState().check())} data-testid="update-link-check">
          检查更新
        </Button>
      )}
    </div>
  );
}
