import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Radio, Space, Typography } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { SYNC_ITEM_LABEL, type ItemCounts } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useTabs } from '../../store/tabs';
import { useAccount, type LoginPrefill } from '../../store/account';
import { UpdateCheckLink } from '../UpdateCheckLink';
import { MinimalWindowBar } from '../TopBar';

interface Values {
  username: string;
  password: string;
  importLocal: 'import' | 'keep';
}

const IMPORT_KEYS: (keyof ItemCounts)[] = ['hosts', 'snippets', 'notes', 'credentials'];

/**
 * 登录表单（文档一 2.3 / 6.10.8）：用户名密码。连接哪个服务端由主进程决定（企业预置 / 默认地址），界面上不显示服务端地址。
 * 从本地模式登录、本机还有数据时，可以选择把主机、命令、笔记、凭证导入到账号。
 */
export function LoginForm({ prefill, onDone, inline }: { prefill: LoginPrefill; onDone?: () => void; inline?: boolean }): React.JSX.Element {
  const [form] = Form.useForm<Values>();
  const account = useAccount((s) => s.state);
  const tabCount = useTabs((s) => s.tabs.length);
  const [counts, setCounts] = useState<ItemCounts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fromLocal = !account || account.status === 'none';
  // 重新登录当前账号：用户名不能改（改了就是另一个账号，会切换档案）
  const relogin = !!account && account.status !== 'none' && !!prefill.username;

  useEffect(() => {
    if (!fromLocal) return;
    invoke('sync.localStats')
      .then((s) => setCounts(s.counts))
      .catch(() => setCounts(null));
  }, [fromLocal]);

  const localItems = counts ? IMPORT_KEYS.filter((k) => (counts[k] ?? 0) > 0).map((k) => `${counts[k]} 个${SYNC_ITEM_LABEL[k]}`) : [];

  const submit = async (v: Values): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const before = account?.profileId;
      const r = await invoke('account.login', { username: v.username, password: v.password, importLocal: fromLocal && v.importLocal === 'import' });
      // 换到了另一个档案时主进程会重新加载窗口；同一个账号重新登录时只关闭登录框
      if (r.profileId === before) onDone?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Form<Values>
      form={form}
      layout="vertical"
      requiredMark={false}
      initialValues={{ username: prefill.username ?? '', password: '', importLocal: 'import' }}
      onFinish={(v) => void submit(v)}
      data-testid="login-form"
    >
      {prefill.reason && <Alert type={/过期|吊销|失效/.test(prefill.reason) ? 'warning' : 'info'} showIcon message={prefill.reason} style={{ marginBottom: 16 }} data-testid="login-reason" />}
      <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请填写用户名' }]}>
        <Input prefix={<UserOutlined />} disabled={relogin} autoComplete="username" spellCheck={false} autoFocus={!relogin} data-testid="login-username" />
      </Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true, message: '请填写密码' }]}>
        <Input.Password prefix={<LockOutlined />} autoComplete="current-password" autoFocus={relogin} data-testid="login-password" />
      </Form.Item>
      {fromLocal && localItems.length > 0 && (
        <Form.Item name="importLocal" label={`本机数据（${localItems.join('、')}）`} extra="只在第一次登录这个账号时导入；按「协议 + 地址 + 端口 + 用户名」去重，导入前会自动备份。">
          <Radio.Group data-testid="login-import">
            <Space direction="vertical" size={4}>
              <Radio value="import">导入到账号（推荐）</Radio>
              <Radio value="keep">仅保留在本机（退出登录后仍然可以使用）</Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
      )}
      {!relogin && tabCount > 0 && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          登录后切换到账号的数据，当前打开的 {tabCount} 个终端会关闭。
        </Typography.Paragraph>
      )}
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} data-testid="login-error" />}
      <Form.Item style={{ marginBottom: inline ? 0 : 12 }}>
        <Button type="primary" htmlType="submit" block loading={busy} data-testid="login-submit">
          {relogin ? '重新登录' : '登录'}
        </Button>
      </Form.Item>
      {/* 没有登录也能检查更新（第十五轮） */}
      <UpdateCheckLink />
    </Form>
  );
}

/** 登录对话框：侧栏「登录」、登录过期提醒、设置页都从这里登录 */
export function LoginDialog(): React.JSX.Element {
  const prefill = useAccount((s) => s.login);
  const close = useAccount((s) => s.closeLogin);
  return (
    <Modal open={!!prefill} title="登录 iTerminal" footer={null} width={440} onCancel={close} destroyOnHidden maskClosable={false} data-testid="login-dialog">
      {prefill && <LoginForm prefill={prefill} onDone={close} />}
    </Modal>
  );
}

/** 管理员要求必须登录（预置配置 requireLogin）时，没登录就只显示登录页 */
export function LoginGate(): React.JSX.Element {
  return (
    <div className="login-gate" data-testid="login-gate">
      <MinimalWindowBar />
      <div className="login-gate-card">
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          登录 iTerminal
        </Typography.Title>
        <Typography.Paragraph type="secondary">管理员要求登录后使用。</Typography.Paragraph>
        <LoginForm prefill={{}} inline />
      </div>
    </div>
  );
}
