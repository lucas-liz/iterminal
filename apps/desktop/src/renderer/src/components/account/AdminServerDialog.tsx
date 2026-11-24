import { useRef, useState } from 'react';
import { Alert, App, Button, Input, Modal, Space, Typography } from 'antd';
import type { AdminServerConfig, AdminServerTest } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';

const TAPS = 5;
const TAP_GAP_MS = 1500;

/** 连续快速点击 5 次（每两次间隔不超过 1.5 秒）时调用 onTrigger；界面上没有任何提示 */
export function useSecretTaps(onTrigger: () => void): () => void {
  const taps = useRef<{ n: number; at: number }>({ n: 0, at: 0 });
  return () => {
    const now = Date.now();
    const t = taps.current;
    t.n = now - t.at <= TAP_GAP_MS ? t.n + 1 : 1;
    t.at = now;
    if (t.n >= TAPS) {
      t.n = 0;
      onTrigger();
    }
  };
}

const SOURCE_TEXT: Record<AdminServerConfig['source'], string> = {
  custom: '当前使用：这里设置的地址',
  preset: '当前使用：企业预置的地址',
  default: '当前使用：默认地址',
};

/**
 * 隐藏的服务端地址设置（设置 → 关于里连续点 5 次软件图标）：先输入管理员密码，再修改连接的服务端地址。
 * 不显示默认地址；留空保存 = 恢复默认。
 */
export function AdminServerDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  return (
    <Modal open={open} title="服务端设置" footer={null} width={520} onCancel={onClose} destroyOnHidden maskClosable={false} data-testid="admin-dialog">
      {open && <AdminServerBody onClose={onClose} />}
    </Modal>
  );
}

function AdminServerBody({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { message } = App.useApp();
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [cfg, setCfg] = useState<AdminServerConfig | null>(null);
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<AdminServerTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'unlock' | 'test' | 'save' | 'reset' | null>(null);

  const unlock = async (): Promise<void> => {
    setError(null);
    setBusy('unlock');
    try {
      const { token: t } = await invoke('admin.unlock', { password });
      const c = await invoke('admin.serverGet', { token: t });
      setToken(t);
      setCfg(c);
      setUrl(c.custom ?? '');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPassword('');
      setBusy(null);
    }
  };

  const test = async (): Promise<void> => {
    if (!token) return;
    setError(null);
    setResult(null);
    setBusy('test');
    try {
      setResult(await invoke('admin.serverTest', { token, url }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const save = async (value: string | null): Promise<void> => {
    if (!token) return;
    setError(null);
    setBusy(value ? 'save' : 'reset');
    try {
      const c = await invoke('admin.serverSet', { token, url: value });
      setCfg(c);
      setUrl(c.custom ?? '');
      message.success(value ? '已保存服务端地址' : '已恢复默认地址');
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!token) {
    return (
      <>
        <Typography.Paragraph type="secondary">需要管理员密码。</Typography.Paragraph>
        <Input.Password
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onPressEnter={() => void unlock()}
          placeholder="管理员密码"
          autoComplete="off"
          data-testid="admin-password"
        />
        {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} data-testid="admin-error" />}
        <Button type="primary" block style={{ marginTop: 16 }} loading={busy === 'unlock'} disabled={!password} onClick={() => void unlock()} data-testid="admin-unlock">
          确定
        </Button>
      </>
    );
  }

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }} data-testid="admin-source">
        {cfg ? SOURCE_TEXT[cfg.source] : ''}
      </Typography.Paragraph>
      <Input
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setResult(null);
        }}
        placeholder="服务端地址，例如 http://192.168.1.10:8080 或 https://ops.example.com/prod-api；留空使用默认地址"
        autoComplete="off"
        spellCheck={false}
        data-testid="admin-server-url"
      />
      {result && <Alert type={result.ok ? 'success' : 'error'} showIcon message={result.message} style={{ marginTop: 12 }} data-testid="admin-test-result" />}
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} data-testid="admin-error" />}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        保存后，登录、匿名问题反馈和自动更新使用这个地址。当前已登录的账号仍然连接原来的服务端，退出登录后重新登录才会切换。
      </Typography.Paragraph>
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <Button onClick={() => void save(null)} loading={busy === 'reset'} disabled={!cfg?.custom} data-testid="admin-server-reset">
          恢复默认
        </Button>
        <Space>
          <Button onClick={() => void test()} loading={busy === 'test'} disabled={!url.trim()} data-testid="admin-server-test">
            测试连接
          </Button>
          <Button type="primary" onClick={() => void save(url.trim() || null)} loading={busy === 'save'} data-testid="admin-server-save">
            保存
          </Button>
        </Space>
      </Space>
    </>
  );
}
