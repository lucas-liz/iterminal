import { useEffect, useRef } from 'react';
import { App, Button, Modal, Progress, Space, Typography } from 'antd';
import { CloudDownloadOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { useUpdate } from '../store/update';
import { useApp } from '../store/app';
import { errorMessage } from '../api';

/**
 * 更新提醒（文档一 11.5）：发现新版本时提示一次；低于最低支持版本时弹出不能关闭的升级窗口。
 */
export function UpdateWatcher(): React.JSX.Element | null {
  const { notification, message } = App.useApp();
  const state = useUpdate((s) => s.state);
  const notified = useRef<string | null>(null);

  useEffect(() => {
    void useUpdate.getState().load();
  }, []);

  useEffect(() => {
    const v = state?.available?.version;
    if (!state || state.forced || state.status !== 'available' || !v || notified.current === v) return;
    notified.current = v;
    notification.info({
      key: 'update-available',
      message: `发现新版本 ${v}`,
      description: state.available?.notes?.slice(0, 200) ?? '可以在「设置 → 关于」里下载更新',
      duration: 0,
      actions: (
        <Button
          size="small"
          type="primary"
          onClick={() => {
            notification.destroy('update-available');
            useApp.getState().openSettings('about');
          }}
          data-testid="update-notify-open"
        >
          查看
        </Button>
      ),
    });
  }, [state, notification]);

  if (!state?.forced) return null;
  const p = state.progress;
  const busy = state.status === 'downloading' || state.status === 'checking';
  const run = (x: Promise<unknown>): void => void x.catch((e) => message.error(errorMessage(e)));
  return (
    <Modal open closable={false} maskClosable={false} keyboard={false} footer={null} title="需要升级" data-testid="update-forced">
      <Typography.Paragraph>
        当前版本 {state.currentVersion} 低于最低支持版本 {state.minimumVersion}，请升级到 {state.available?.version} 后继续使用。
      </Typography.Paragraph>
      {state.available?.notes && (
        <Typography.Paragraph type="secondary" className="update-notes">
          {state.available.notes}
        </Typography.Paragraph>
      )}
      {state.status === 'downloading' && p && <Progress percent={Math.round(p.percent)} size="small" />}
      {state.error && (
        <Typography.Paragraph type="danger" className="update-error" data-testid="update-forced-error">
          {state.error}
        </Typography.Paragraph>
      )}
      {state.savedFile && <SavedInstaller file={state.savedFile} />}
      <Space wrap>
        {state.status === 'downloaded' ? (
          <Button type="primary" icon={<ReloadOutlined />} onClick={() => run(useUpdate.getState().install())}>
            重启并安装
          </Button>
        ) : (
          <Button type="primary" icon={<CloudDownloadOutlined />} loading={state.status === 'downloading'} disabled={busy} onClick={() => run(useUpdate.getState().download())} data-testid="update-forced-download">
            下载更新
          </Button>
        )}
        {state.status !== 'downloaded' && state.available && (
          <Button icon={<DownloadOutlined />} disabled={busy} onClick={() => run(useUpdate.getState().saveInstaller())} data-testid="update-forced-manual">
            手动下载安装包
          </Button>
        )}
      </Space>
    </Modal>
  );
}

/** 手动下载的安装包保存在哪里（第十九轮） */
export function SavedInstaller({ file }: { file: string }): React.JSX.Element {
  return (
    <Typography.Paragraph type="secondary" className="update-saved" data-testid="update-saved">
      安装包已保存到 <Typography.Text code copyable={{ text: file }}>{file}</Typography.Text>，已为你打开。请按提示安装，安装后重新打开 iTerminal。
    </Typography.Paragraph>
  );
}
