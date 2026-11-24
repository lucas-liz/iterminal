import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, DatePicker, Form, Input, InputNumber, Modal, Radio, Segmented, Select, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import type { AiAccess, Credential, CredentialInput, CredentialType } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { CREDENTIAL_TYPES, useVault } from '../../store/vault';
import { FormSection } from '../../components/FormSection';
import { freshOnOpen } from '../../util/fresh';

export type CredentialEditorTarget = { mode: 'create'; type: CredentialType } | { mode: 'edit'; credential: Credential };

interface FormValues {
  type: CredentialType;
  name: string;
  username: string;
  secret: string;
  passphrase: string;
  otpSeed: string;
  publicKey: string;
  keySource: 'generate' | 'import' | 'public';
  algorithm: 'ed25519' | 'rsa';
  comment: string;
  aiAccess: AiAccess;
  rotateDays: number | null;
  expiresAt: Dayjs | null;
  note: string;
}

const SECRET_LABEL: Partial<Record<CredentialType, string>> = {
  PASSWORD: '密码',
  DB: '数据库密码',
  SSH_KEY: '私钥',
  CERT: '私钥',
  CLOUD_AK: 'Secret Key',
};

/** 新建 / 修改共享凭证（文档一 6.6）。秘密只从这里写入主进程，主进程不会返回明文（查看明文走单独的重新验证）。 */
function CredentialEditorDialog({ target, onClose, onSaved }: { target: CredentialEditorTarget | null; onClose(): void; onSaved?(c: Credential): void }): React.JSX.Element {
  const { message } = App.useApp();
  const reload = useVault((s) => s.reload);
  const [form] = Form.useForm<FormValues>();
  const type = Form.useWatch('type', form);
  const keySource = Form.useWatch('keySource', form);
  const [saving, setSaving] = useState(false);
  const [clear, setClear] = useState(false);
  const editing = target?.mode === 'edit' ? target.credential : null;

  useEffect(() => setClear(false), [target]);

  const initialValues = useMemo((): Partial<FormValues> | undefined => {
    if (!target) return undefined;
    const c = editing;
    return {
      type: c?.type ?? (target.mode === 'create' ? target.type : 'PASSWORD'),
      name: c?.name ?? '',
      username: c?.username ?? '',
      secret: '',
      passphrase: '',
      otpSeed: '',
      publicKey: c?.type === 'CERT' ? (c.publicKey ?? '') : '',
      keySource: c ? 'import' : 'generate',
      algorithm: 'ed25519',
      comment: '',
      aiAccess: c?.aiAccess ?? 'REFERENCE',
      rotateDays: c?.rotateDays ?? (target.mode === 'create' && (target.type === 'SSH_KEY' || target.type === 'PASSWORD') ? 180 : null),
      expiresAt: c?.expiresAt ? dayjs(c.expiresAt) : null,
      note: c?.note ?? '',
    };
  }, [target]);

  const importFile = async (file: File, field: 'secret' | 'publicKey'): Promise<void> => {
    if (file.size > 64 * 1024) {
      message.error('文件太大');
      return;
    }
    form.setFieldValue(field, await file.text());
  };

  const save = async (): Promise<void> => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const keep = (value: string): string | null | undefined => (value ? value : editing ? (clear ? null : undefined) : null);
    const input: CredentialInput = {
      type: v.type,
      name: v.name,
      username: v.username || null,
      aiAccess: v.aiAccess,
      rotateDays: v.rotateDays ?? null,
      expiresAt: v.expiresAt ? v.expiresAt.endOf('day').valueOf() : null,
      note: v.note || null,
    };
    if (v.type === 'SSH_KEY' && !editing && v.keySource === 'generate') {
      input.generate = { algorithm: v.algorithm, bits: 4096, comment: v.comment || undefined, passphrase: v.passphrase || undefined };
    } else if (v.type === 'SSH_KEY' && v.keySource === 'public') {
      input.publicKey = v.publicKey;
    } else if (v.type !== 'OTP') {
      input.secret = keep(v.secret);
      if (v.type === 'SSH_KEY' || v.type === 'CERT') input.passphrase = keep(v.passphrase);
      if (v.type === 'CERT') input.publicKey = v.publicKey || null;
    }
    if (v.type === 'OTP' || v.type === 'PASSWORD') input.otpSeed = v.otpSeed ? v.otpSeed : editing ? (clear ? null : undefined) : null;
    setSaving(true);
    try {
      const saved = await invoke('credential.save', { id: editing?.id ?? null, input });
      await reload();
      message.success(editing ? '已保存' : '凭证已创建');
      onSaved?.(saved);
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const secretLabel = SECRET_LABEL[type ?? 'PASSWORD'];
  const hasSaved = !!editing?.hasSecret && !clear;
  const keyField = type === 'SSH_KEY' || type === 'CERT';

  return (
    <Modal
      open={!!target}
      title={editing ? `编辑凭证 · ${editing.name}` : '新建凭证'}
      width={600}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={false}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void save()}
    >
      <Form form={form} layout="vertical" requiredMark={false} preserve={false} initialValues={initialValues} data-testid="credential-form">
        <FormSection title="基本信息">
          <Form.Item name="type" label="类型">
            <Select disabled={!!editing} options={CREDENTIAL_TYPES} data-testid="credential-type" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请填写名称' }, { max: 64 }]}>
            <Input placeholder="例如：生产运维账号" data-testid="credential-name" />
          </Form.Item>
          {type !== 'OTP' && (
            <Form.Item name="username" label={type === 'CLOUD_AK' ? 'AccessKey ID' : '用户名'} extra={type === 'PASSWORD' || type === 'SSH_KEY' ? '主机没有填写用户名时使用这里的用户名' : undefined}>
              <Input data-testid="credential-username" />
            </Form.Item>
          )}
        </FormSection>

        <FormSection title="密钥与秘密">
          {type === 'SSH_KEY' && !editing && (
            <Form.Item name="keySource" label="私钥">
              <Segmented
                options={[
                  { label: '生成新密钥', value: 'generate' },
                  { label: '导入私钥', value: 'import' },
                  { label: '只保存公钥', value: 'public' },
                ]}
              />
            </Form.Item>
          )}
          {type === 'SSH_KEY' && !editing && keySource === 'generate' && (
            <Space style={{ width: '100%' }} align="start">
              <Form.Item name="algorithm" label="算法">
                <Radio.Group>
                  <Radio value="ed25519">Ed25519（推荐）</Radio>
                  <Radio value="rsa">RSA 4096</Radio>
                </Radio.Group>
              </Form.Item>
              <Form.Item name="comment" label="备注（写在公钥末尾）">
                <Input placeholder="例如 ops@corp" />
              </Form.Item>
            </Space>
          )}
          {type === 'SSH_KEY' && keySource === 'public' && !editing && (
            <Form.Item name="publicKey" label="公钥" rules={[{ required: true, message: '请填写公钥' }]}>
              <Input.TextArea rows={3} className="mono" placeholder="ssh-ed25519 AAAA... comment" />
            </Form.Item>
          )}
          {editing && keyField && editing.publicKey && (
            <Alert
              style={{ marginBottom: 12 }}
              type="info"
              message={<span className="mono selectable" style={{ wordBreak: 'break-all' }}>{editing.publicKey}</span>}
              description={editing.fingerprint}
            />
          )}

          {secretLabel && !(type === 'SSH_KEY' && !editing && keySource !== 'import') && (
            <Form.Item
              name="secret"
              label={
                keyField ? (
                  <Space>
                    <span>{secretLabel}</span>
                    <label style={{ cursor: 'pointer' }}>
                      <Typography.Link>从文件导入…</Typography.Link>
                      <input type="file" style={{ display: 'none' }} onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void importFile(f, 'secret');
                        e.target.value = '';
                      }} />
                    </label>
                  </Space>
                ) : (
                  secretLabel
                )
              }
              rules={!editing && type !== 'PASSWORD' ? [{ required: true, message: `请填写${secretLabel}` }] : undefined}
              extra={
                hasSaved ? (
                  <Space size={4}>
                    <span>已保存，留空表示不修改。</span>
                    <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setClear(true)}>
                      清除
                    </Button>
                  </Space>
                ) : undefined
              }
            >
              {keyField ? (
                <Input.TextArea rows={4} className="mono" spellCheck={false} placeholder={hasSaved ? '（已保存）' : '-----BEGIN OPENSSH PRIVATE KEY-----'} />
              ) : (
                <Input.Password autoComplete="new-password" placeholder={hasSaved ? '••••••••' : ''} data-testid="credential-secret" />
              )}
            </Form.Item>
          )}
          {keyField && !(type === 'SSH_KEY' && !editing && keySource === 'public') && (
            <Form.Item name="passphrase" label="私钥口令" extra={type === 'SSH_KEY' && !editing && keySource === 'generate' ? '可以留空；设置后连接时也会自动使用' : '私钥没有加密时留空'}>
              <Input.Password autoComplete="new-password" placeholder={hasSaved && editing?.hasPassphrase ? '（已保存）' : ''} />
            </Form.Item>
          )}
          {type === 'CERT' && (
            <Form.Item name="publicKey" label="证书">
              <Input.TextArea rows={3} className="mono" placeholder="ssh-ed25519-cert-v01@openssh.com AAAA..." />
            </Form.Item>
          )}
          {(type === 'OTP' || type === 'PASSWORD') && (
            <Form.Item
              name="otpSeed"
              label={type === 'OTP' ? 'TOTP 种子' : 'TOTP 种子（可选）'}
              rules={type === 'OTP' && !editing ? [{ required: true, message: '请填写 TOTP 种子' }] : undefined}
              extra={
                type === 'PASSWORD'
                  ? '两步验证的堡垒机：连接时服务器要验证码，会自动生成并填写'
                  : editing?.hasOtp && !clear
                    ? '已保存，留空表示不修改'
                    : 'Base32 种子，或者 otpauth:// 链接'
              }
            >
              <Input.Password autoComplete="off" placeholder={editing?.hasOtp && !clear ? '（已保存）' : 'JBSWY3DPEHPK3PXP 或 otpauth://totp/...'} />
            </Form.Item>
          )}
        </FormSection>

        <FormSection title="使用与提醒">
          <Form.Item name="aiAccess" label="AI 访问" extra="Agent 永远拿不到明文；「禁止」时，使用这个凭证的主机不能被 Agent 引用执行命令">
            <Radio.Group>
              <Radio value="REFERENCE">允许通过引用使用</Radio>
              <Radio value="DENY">禁止</Radio>
            </Radio.Group>
          </Form.Item>
          <Space align="start" style={{ width: '100%' }}>
            <Form.Item name="rotateDays" label="轮换周期（天）" extra="到期前 7 天提醒">
              <InputNumber min={1} max={3650} style={{ width: 160 }} placeholder="不提醒" />
            </Form.Item>
            <Form.Item name="expiresAt" label="到期时间">
              <DatePicker style={{ width: 200 }} placeholder="不过期" />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
        </FormSection>
      </Form>
    </Modal>
  );
}

export const CredentialEditor = freshOnOpen(CredentialEditorDialog, (p) => p.target);
