import { useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Modal, Select, Space, Switch, Tag, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import type { Settings } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { SettingGroup, SettingRow, SettingsSection } from './parts';

type Dialog = 'set' | 'change' | 'remove' | null;

/** 设置 → 安全：主密码（文档一 10.2）、自动锁定、Touch ID */
export function SecuritySettings(): React.JSX.Element {
  const { message } = App.useApp();
  const security = useApp((s) => s.security);
  const info = useApp((s) => s.info);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.updateSetting);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [form] = Form.useForm<{ current: string; next: string; confirm: string }>();
  const [busy, setBusy] = useState(false);
  const master = !!security?.masterPassword;
  const forced = info?.keyProtection === 'weak' && master;

  const submit = async (): Promise<void> => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      if (dialog === 'remove') {
        await invoke('security.removeMasterPassword', { currentPassword: v.current });
        message.success('已取消主密码，本地数据改由系统钥匙串保护');
      } else {
        await invoke('security.setMasterPassword', { newPassword: v.next, currentPassword: dialog === 'change' ? v.current : undefined });
        message.success(dialog === 'set' ? '主密码已设置，下次启动需要输入' : '主密码已修改');
      }
      setDialog(null);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends 'security.autoLockMin' | 'security.touchId' | 'audit.recordSessions' | 'audit.recordLocal' | 'audit.retentionDays' | 'audit.recordingRetentionDays'>(
    key: K,
    value: Settings[K],
  ): void => {
    update(key, value as never).catch((e) => message.error(errorMessage(e)));
  };

  return (
    <SettingsSection
      title="安全与锁定"
      description="本地密钥由系统钥匙串保护；设置主密码后由钥匙串和主密码共同保护。"
      extra={
        master && (
          <Button icon={<LockOutlined />} onClick={() => void invoke('security.lock')}>
            立即锁定
          </Button>
        )
      }
    >
      {info?.keyProtection === 'weak' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="系统钥匙串不可用"
          description={master ? '本地数据由主密码保护。' : '本地数据库密钥没有受到系统钥匙串保护，请设置主密码。'}
        />
      )}
      <SettingGroup title="主密码">
        <SettingRow
          label={
            <Space size={8}>
              主密码
              {master ? <Tag color="green">已设置</Tag> : <Tag>未设置</Tag>}
            </Space>
          }
          description="设置后，启动时需要输入主密码，查看凭证明文前需要再次验证，并且可以自动锁定。主密码忘记后无法找回本地数据。"
        >
          {master ? (
            <Space>
              <Button onClick={() => setDialog('change')} data-testid="change-master">
                修改
              </Button>
              {!forced && (
                <Button danger onClick={() => setDialog('remove')}>
                  取消主密码
                </Button>
              )}
            </Space>
          ) : (
            <Button type="primary" onClick={() => setDialog('set')} data-testid="set-master">
              设置主密码
            </Button>
          )}
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="锁定">
        <SettingRow label="自动锁定" description={master ? '系统锁屏或睡眠时也会锁定；锁定期间终端会话继续运行' : '需要先设置主密码'}>
          <Select
            style={{ width: 200 }}
            disabled={!master}
            value={settings['security.autoLockMin']}
            onChange={(v) => set('security.autoLockMin', v)}
            options={[0, 5, 10, 15, 30, 60, 120].map((m) => ({ value: m, label: m === 0 ? '不自动锁定' : `无操作 ${m} 分钟后` }))}
          />
        </SettingRow>
        {security?.touchIdAvailable && (
          <SettingRow label="Touch ID" description="锁定后可以用指纹解锁（冷启动仍然需要主密码）">
            <Switch checked={settings['security.touchId']} disabled={!master} onChange={(v) => set('security.touchId', v)} />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup title="审计与录像">
        <SettingRow label="会话录像" description="记录终端输出（asciicast 格式，加密保存在本机），可以在「审计」里回放；只记录输出，不记录键盘输入。主机编辑框里可以单独关闭某台主机的录像">
          <Switch checked={settings['audit.recordSessions']} onChange={(v) => set('audit.recordSessions', v)} data-testid="setting-record-sessions" />
        </SettingRow>
        <SettingRow label="本机终端也录像" description="本机 Shell 默认不录像">
          <Switch checked={settings['audit.recordLocal']} disabled={!settings['audit.recordSessions']} onChange={(v) => set('audit.recordLocal', v)} data-testid="setting-record-local" />
        </SettingRow>
        <SettingRow label="命令审计保留" description="超过这个天数的命令记录和安全事件会自动删除（登录后还没上报的先保留）">
          <InputNumber min={1} max={3650} value={settings['audit.retentionDays']} onChange={(v) => v && set('audit.retentionDays', v)} addonAfter="天" style={{ width: 140 }} data-testid="setting-audit-retention" />
        </SettingRow>
        <SettingRow label="录像保留" description="超过这个天数的会话录像会自动删除（登录后还没上传的先保留）">
          <InputNumber min={1} max={3650} value={settings['audit.recordingRetentionDays']} onChange={(v) => v && set('audit.recordingRetentionDays', v)} addonAfter="天" style={{ width: 140 }} data-testid="setting-recording-retention" />
        </SettingRow>
      </SettingGroup>
      <Modal
        open={!!dialog}
        title={dialog === 'set' ? '设置主密码' : dialog === 'change' ? '修改主密码' : '取消主密码'}
        okText={dialog === 'remove' ? '取消主密码' : '保存'}
        okButtonProps={{ danger: dialog === 'remove' }}
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void submit()}
        onCancel={() => setDialog(null)}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          {dialog !== 'set' && (
            <Form.Item name="current" label="当前主密码" rules={[{ required: true, message: '请输入当前主密码' }]}>
              <Input.Password autoFocus autoComplete="current-password" />
            </Form.Item>
          )}
          {dialog !== 'remove' && (
            <>
              <Form.Item name="next" label="新主密码" rules={[{ required: true, message: '请输入新主密码' }, { min: 8, message: '至少 8 位' }]}>
                <Input.Password autoFocus={dialog === 'set'} autoComplete="new-password" data-testid="master-new" />
              </Form.Item>
              <Form.Item
                name="confirm"
                label="再输入一次"
                dependencies={['next']}
                rules={[
                  { required: true, message: '请再输入一次' },
                  ({ getFieldValue }) => ({ validator: (_, v) => (v === getFieldValue('next') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))) }),
                ]}
              >
                <Input.Password autoComplete="new-password" data-testid="master-confirm" />
              </Form.Item>
            </>
          )}
          {dialog === 'remove' && <Typography.Text type="secondary">取消后，本地数据只由系统钥匙串保护，启动时不再需要输入主密码。</Typography.Text>}
        </Form>
      </Modal>
    </SettingsSection>
  );
}
