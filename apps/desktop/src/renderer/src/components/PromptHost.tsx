import { useEffect, useState } from 'react';
import { Alert, Checkbox, Input, Modal, Space, Typography } from 'antd';
import type { PromptAnswer, PromptRequest } from '@itm/protocol';
import { invoke } from '../api';

/** 连接提示的层级：高于嵌套弹窗（antd 会给弹窗里的弹窗加层级） */
const PROMPT_Z = 2100;

/**
 * 连接过程中的提示：确认主机指纹、输入密码 / 私钥口令。同一时间只显示一个，其余排队。
 */
export function PromptHost(): React.JSX.Element | null {
  const [queue, setQueue] = useState<PromptRequest[]>([]);
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);

  useEffect(() => window.itm.on('prompt.request', (req) => setQueue((q) => [...q, req])), []);

  const current = queue[0];
  if (!current) {
    return null;
  }

  const answer = (a: PromptAnswer): void => {
    void invoke('prompt.answer', { promptId: current.promptId, answer: a });
    setQueue((q) => q.slice(1));
    setValue('');
    setRemember(false);
  };

  if (current.kind === 'hostKey') {
    const changed = current.previousFingerprint !== null;
    return (
      <Modal
        open
        title={changed ? '主机指纹已变化' : '确认主机指纹'}
        okText={changed ? '仍然信任并连接' : '信任并连接'}
        cancelText="拒绝"
        okButtonProps={{ danger: changed }}
        onOk={() => answer({ kind: 'hostKey', accept: true })}
        onCancel={() => answer({ kind: 'hostKey', accept: false })}
        maskClosable={false}
        // 连接时的确认（指纹、密码）始终在最上面：测试连接的日志框、主机编辑框等弹窗里的弹窗层级更高
        zIndex={PROMPT_Z}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {changed ? (
            <Alert
              type="error"
              showIcon
              message="这台主机的指纹和之前记录的不一致"
              description="可能是服务器重装或更换了密钥，也可能有人在拦截连接（中间人攻击）。确认原因之前不要继续。"
            />
          ) : (
            <Typography.Text type="secondary">第一次连接这台主机，请核对指纹后再信任。</Typography.Text>
          )}
          <div>
            <Typography.Text strong>{current.hostName}</Typography.Text>
            <Typography.Text type="secondary">{`  ${current.address}:${current.port}`}</Typography.Text>
          </div>
          <div className="selectable">
            <Typography.Text type="secondary">{current.keyType}</Typography.Text>
            <br />
            <Typography.Text code copyable>
              {current.fingerprint}
            </Typography.Text>
          </div>
          {changed && (
            <div className="selectable">
              <Typography.Text type="secondary">之前记录的指纹：</Typography.Text>
              <br />
              <Typography.Text code delete>
                {current.previousFingerprint}
              </Typography.Text>
            </div>
          )}
        </Space>
      </Modal>
    );
  }

  const title = current.forPassphrase ? '输入私钥口令' : current.otp ? `${current.hostName} · 两步验证` : `登录 ${current.hostName}`;
  // 共享凭证和一次性验证码不能「记住」
  const canRemember = current.rememberable !== false && !current.otp;
  return (
    <Modal
      open
      title={title}
      okText="连接"
      cancelText="取消"
      okButtonProps={{ disabled: !value }}
      onOk={() => answer({ kind: 'password', value, remember: canRemember && remember })}
      onCancel={() => answer({ kind: 'password', value: null, remember: false })}
      maskClosable={false}
      zIndex={PROMPT_Z}
      destroyOnHidden
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {current.message && <Alert type={current.message.includes('失败') || current.message.includes('不正确') ? 'error' : 'info'} showIcon message={current.message} />}
        {!current.forPassphrase && <Typography.Text type="secondary">{`用户：${current.username}`}</Typography.Text>}
        {current.otp ? (
          <Input
            autoFocus
            className="mono"
            placeholder="验证码"
            value={value}
            onChange={(e) => setValue(e.target.value.trim())}
            onPressEnter={() => value && answer({ kind: 'password', value, remember: false })}
            data-testid="prompt-otp"
          />
        ) : (
          <Input.Password
            autoFocus
            placeholder={current.forPassphrase ? '私钥口令' : '密码'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onPressEnter={() => value && answer({ kind: 'password', value, remember: canRemember && remember })}
          />
        )}
        {canRemember && (
          <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
            {current.forPassphrase ? '记住口令（加密保存在本机）' : '记住密码（加密保存在本机）'}
          </Checkbox>
        )}
        {current.otp && <Typography.Text type="secondary">在凭证里保存 TOTP 种子后，可以自动填写验证码。</Typography.Text>}
      </Space>
    </Modal>
  );
}
