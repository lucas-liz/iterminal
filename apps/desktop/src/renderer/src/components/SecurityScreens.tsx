import { useState } from 'react';
import { Alert, Button, Input, Space, Typography } from 'antd';
import { LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { errorMessage, invoke } from '../api';
import { useApp } from '../store/app';
import { UpdateCheckLink } from './UpdateCheckLink';
import { MinimalWindowBar } from './TopBar';

/**
 * 解锁 / 首次设置主密码 / 锁屏（文档一 10.2）。
 * - cold：冷启动，开启了主密码；
 * - setup：这台电脑没有系统钥匙串（Linux），第一次使用前必须设置主密码；
 * - locked：使用中被锁定（无操作、系统锁屏），盖在界面上方，终端会话在后台继续运行。
 */
export function SecurityScreen({ mode }: { mode: 'cold' | 'setup' | 'locked' }): React.JSX.Element {
  const security = useApp((s) => s.security);
  const touchId = useApp((s) => s.settings['security.touchId']);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!password || busy) return;
    if (mode === 'setup' && password !== confirm) {
      setError('两次输入的主密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await invoke('security.setup', { password });
      else await invoke('security.unlock', { password });
      setPassword('');
      setConfirm('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const touch = async (): Promise<void> => {
    setError(null);
    try {
      await invoke('security.unlockTouchId');
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className={`security-screen ${mode === 'locked' ? 'overlay' : ''}`} data-testid={`security-${mode}`}>
      <MinimalWindowBar />
      <div className="security-card">
        <div className="security-icon">{mode === 'setup' ? <SafetyOutlined /> : <LockOutlined />}</div>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {mode === 'setup' ? '设置主密码' : mode === 'locked' ? 'iTerminal 已锁定' : '输入主密码'}
        </Typography.Title>
        <Typography.Text type="secondary" style={{ textAlign: 'center' }}>
          {mode === 'setup'
            ? '这台电脑没有可用的系统钥匙串（Secret Service），需要用主密码保护本地的主机密码和私钥。主密码只保存在你的记忆里，忘记后无法找回本地数据。'
            : mode === 'locked'
              ? '终端会话仍在后台运行，解锁后继续使用。'
              : '本地数据由主密码保护。'}
        </Typography.Text>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.Password
            autoFocus
            size="large"
            placeholder={mode === 'setup' ? '主密码（至少 8 位）' : '主密码'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onPressEnter={() => (mode === 'setup' ? undefined : void submit())}
            data-testid="master-password"
          />
          {mode === 'setup' && (
            <Input.Password
              size="large"
              placeholder="再输入一次"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onPressEnter={() => void submit()}
              data-testid="master-password-confirm"
            />
          )}
          {error && <Alert type="error" showIcon message={error} />}
          <Button type="primary" size="large" block loading={busy} disabled={!password} onClick={() => void submit()} data-testid="unlock">
            {mode === 'setup' ? '设置并进入' : '解锁'}
          </Button>
          {mode === 'locked' && security?.touchIdAvailable && touchId && (
            <Button block onClick={() => void touch()}>
              使用 Touch ID 解锁
            </Button>
          )}
          {/* 还没输入主密码、锁定时也能检查更新（第十五轮） */}
          <UpdateCheckLink />
        </Space>
      </div>
    </div>
  );
}
