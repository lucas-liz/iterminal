import { useEffect, useState } from 'react';
import { Alert, App, Button, Checkbox, Input, InputNumber, Modal, Result, Select, Space, Spin, Tag, Typography } from 'antd';
import { ApiOutlined, BookOutlined, CopyOutlined, ExperimentOutlined, FolderOutlined, KeyOutlined, LinkOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ShareLinkCreated, ShareSelectionPreview } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useShare } from '../../store/share';
import { FormSection } from '../FormSection';

const EXPIRES: { value: number; label: string }[] = [
  { value: 1, label: '1 天' },
  { value: 7, label: '7 天' },
  { value: 30, label: '30 天' },
  { value: 0, label: '永久' },
];
const PULLS: { value: number; label: string }[] = [
  { value: 0, label: '不限' },
  { value: 1, label: '1 次' },
  { value: 5, label: '5 次' },
  { value: 10, label: '10 次' },
  { value: -1, label: '自定义' },
];

export const expiresText = (t: number | null): string => (t ? `有效期至 ${new Date(t).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '永久有效');

/** 发给同事的说明 */
export function shareMessage(l: Pick<ShareLinkCreated, 'title' | 'expiresAt' | 'maxPulls'>, code: string): string {
  return [
    `我用 iTerminal 分享了「${l.title}」给你：`,
    `分享码：${code}`,
    `拉取方法：iTerminal → 设置 → 云同步 → 从分享码拉取，输入上面的分享码（需要登录）。`,
    `${expiresText(l.expiresAt)}${l.maxPulls ? `，最多拉取 ${l.maxPulls} 次` : ''}。`,
  ].join('\n');
}

/**
 * 分享对话框（第十三轮，文档一 6.27.4）：列出要分享的内容（自动带上跳板机、分组路径、凭证），选择是否连同凭证、有效期、
 * 可拉取次数，生成分享码。分享码只在客户端，服务端只保存密文。
 */
export function ShareDialog(): React.JSX.Element {
  const { message } = App.useApp();
  const selection = useShare((s) => s.selection);
  const [preview, setPreview] = useState<ShareSelectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [withCreds, setWithCreds] = useState(true);
  const [days, setDays] = useState(7);
  const [pulls, setPulls] = useState(0);
  const [customPulls, setCustomPulls] = useState<number | null>(3);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<ShareLinkCreated | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    setCreated(null);
    setWithCreds(true);
    setDays(7);
    setPulls(0);
    if (!selection) return;
    invoke('share.preview', { selection })
      .then((p) => {
        setPreview(p);
        setTitle(p.title);
      })
      .catch((e) => setError(errorMessage(e)));
  }, [selection]);

  const close = (): void => useShare.getState().close();
  const create = async (): Promise<void> => {
    if (!selection) return;
    setBusy(true);
    try {
      const maxPulls = pulls === -1 ? Math.max(1, Math.min(1000, customPulls ?? 1)) : pulls;
      setCreated(await invoke('share.create', { selection, options: { title: title.trim(), includeCredentials: withCreds && !!preview?.hasSecrets, expiresDays: days === 0 ? null : days, maxPulls } }));
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string, ok: string): void => void navigator.clipboard.writeText(text).then(() => message.success(ok));

  const p = preview;
  const empty = p && !p.hosts.length && !p.snippets.length && !p.notes.length && !p.skills.length;
  return (
    <Modal
      open={!!selection}
      title={created ? '分享码已生成' : '分享'}
      width={640}
      onCancel={close}
      destroyOnHidden
      maskClosable={!busy}
      footer={
        created ? (
          <Button type="primary" onClick={close} data-testid="share-done">
            完成
          </Button>
        ) : (
          <Space>
            <Button onClick={close}>取消</Button>
            <Button type="primary" icon={<LinkOutlined />} loading={busy} disabled={!p || !!empty} onClick={() => void create()} data-testid="share-create">
              生成分享码
            </Button>
          </Space>
        )
      }
    >
      {error && <Alert type="error" showIcon message={error} />}
      {!error && !p && <Spin style={{ display: 'block', margin: '32px auto' }} />}
      {created ? (
        <Result
          status="success"
          style={{ padding: '12px 0' }}
          title={<span className="mono selectable share-code-big" data-testid="share-link-code">{created.code}</span>}
          subTitle={`${created.title} · ${expiresText(created.expiresAt)} · ${created.maxPulls ? `最多拉取 ${created.maxPulls} 次` : '不限拉取次数'}。同事在「设置 → 云同步 → 从分享码拉取」里输入分享码即可获取；随时可以在「我分享的内容」里撤销。`}
          extra={
            <Space>
              <Button type="primary" icon={<CopyOutlined />} onClick={() => copy(created.code, '已复制分享码')} data-testid="share-link-copy">
                复制分享码
              </Button>
              <Button icon={<CopyOutlined />} onClick={() => copy(shareMessage(created, created.code), '已复制分享说明')}>
                复制分享说明
              </Button>
            </Space>
          }
        />
      ) : (
        p && (
          <>
            <FormSection title="要分享的内容">
              {empty ? (
                <Alert type="warning" showIcon message={p.skippedTeam ? '团队主机由管理员维护，不能分享' : '没有可以分享的内容'} />
              ) : (
                <div className="share-items" data-testid="share-items">
                  {p.hosts.length > 0 && (
                    <div className="share-item-group">
                      <div className="share-item-head">
                        <ApiOutlined /> 主机 {p.hosts.length} 台
                      </div>
                      {p.hosts.map((h) => (
                        <div key={h.id} className="share-item" data-testid={`share-host-${h.name}`}>
                          <span className="share-item-name">{h.name}</span>
                          <Typography.Text type="secondary" className="mono share-item-sub" ellipsis>
                            {h.address}
                          </Typography.Text>
                          {h.folderPath && (
                            <Tag bordered={false} icon={<FolderOutlined />}>
                              {h.folderPath}
                            </Tag>
                          )}
                          {h.jump && <Tag color="blue">跳板机，自动包含</Tag>}
                          {h.credentialName && <Tag icon={<KeyOutlined />}>{h.credentialName}</Tag>}
                          {h.hasSecret && <Tag>保存了密码 / 私钥</Tag>}
                        </div>
                      ))}
                      {p.folders.length > 0 && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          同时分享分组：{p.folders.join('、')}（对方本地有同名分组时直接使用）
                        </Typography.Text>
                      )}
                    </div>
                  )}
                  {p.snippets.length > 0 && (
                    <div className="share-item-group">
                      <div className="share-item-head">
                        <ThunderboltOutlined /> 快捷命令 {p.snippets.length} 条
                      </div>
                      {p.snippets.map((s) => (
                        <div key={s.id} className="share-item">
                          <span className="share-item-name">{s.name}</span>
                          {s.group && <Tag bordered={false}>{s.group}</Tag>}
                        </div>
                      ))}
                    </div>
                  )}
                  {p.notes.length > 0 && (
                    <div className="share-item-group">
                      <div className="share-item-head">
                        <BookOutlined /> 笔记 {p.notes.length} 篇
                      </div>
                      {p.notes.map((n) => (
                        <div key={n.id} className="share-item">
                          <span className="share-item-name">{n.title}</span>
                          {n.group && <Tag bordered={false}>{n.group}</Tag>}
                        </div>
                      ))}
                    </div>
                  )}
                  {p.skills.length > 0 && (
                    <div className="share-item-group" data-testid="share-skills">
                      <div className="share-item-head">
                        <ExperimentOutlined /> Skill {p.skills.length} 个
                      </div>
                      {p.skills.map((s) => (
                        <div key={s.id} className="share-item">
                          <span className="share-item-name">{s.title}</span>
                          {s.title !== s.id && <Tag bordered={false}>{s.id}</Tag>}
                        </div>
                      ))}
                    </div>
                  )}
                  {p.skippedTeam > 0 && <Alert type="info" showIcon message={`跳过了 ${p.skippedTeam} 台团队主机（团队主机由管理员维护，不能分享）`} />}
                </div>
              )}
            </FormSection>
            {!empty && (
              <FormSection title="选项">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <div className="share-opt">
                    <span className="share-opt-label">标题</span>
                    <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder={p.title} data-testid="share-title" />
                  </div>
                  {p.hasSecrets && (
                    <div>
                      <Checkbox checked={withCreds} onChange={(e) => setWithCreds(e.target.checked)} data-testid="share-with-creds">
                        连同凭证一起分享（{p.credentials.length ? `凭证 ${p.credentials.map((c) => c.name).join('、')}，` : ''}主机保存的密码 / 私钥）
                      </Checkbox>
                      <div className="sync-hint" style={{ marginLeft: 24 }}>
                        {withCreds ? '同事拿到就能直接连接。拿到分享码的人可以看到这些密码和私钥，请只分享给可信的同事。' : '只分享地址、端口、用户名等，同事需要自己填写密码或私钥。'}
                      </div>
                    </div>
                  )}
                  <div className="share-opt">
                    <span className="share-opt-label">有效期</span>
                    <Select value={days} onChange={setDays} options={EXPIRES} style={{ width: 120 }} data-testid="share-expires" />
                    <span className="share-opt-label" style={{ marginLeft: 16 }}>
                      可拉取次数
                    </span>
                    <Select value={pulls} onChange={setPulls} options={PULLS} style={{ width: 110 }} data-testid="share-pulls" />
                    {pulls === -1 && <InputNumber min={1} max={1000} value={customPulls} onChange={setCustomPulls} style={{ width: 90 }} addonAfter="次" />}
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    内容用分享码加密后上传，服务端只保存密文；过期、拉满或撤销后分享码失效。
                  </Typography.Text>
                </Space>
              </FormSection>
            )}
          </>
        )
      )}
    </Modal>
  );
}
