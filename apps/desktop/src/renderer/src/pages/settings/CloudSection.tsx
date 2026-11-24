import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Checkbox, Dropdown, Empty, Input, Modal, Radio, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  EyeOutlined,
  KeyOutlined,
  LinkOutlined,
  LockOutlined,
  PushpinFilled,
  ReloadOutlined,
  ShareAltOutlined,
  StopOutlined,
  SafetyCertificateOutlined,
  UnlockOutlined,
} from '@ant-design/icons';
import { SYNC_GROUPS, SYNC_GROUP_LABEL, type CloudBackupInfo, type CloudShareInfo, type CloudStatus, type ShareContent, type ShareLinkInfo, type SharePreview, type SyncGroup, type SyncReport } from '@itm/protocol';
import { expiresText, shareMessage } from '../../components/share/ShareDialog';
import { errorMessage, invoke } from '../../api';
import { FormSection } from '../../components/FormSection';
import { useSharePull, type SharePullScope } from '../../store/share';
import { SettingGroup, SettingRow } from './parts';
import { GroupPicker, ReportTable, countsText, reloadAll, size, time } from './SyncSettings';

const MIN_SYNC_PASSWORD = 10;
const SHARE_DEFAULT: SyncGroup[] = ['HOSTS', 'SNIPPETS', 'NOTES'];

/**
 * 云同步页的云端部分（文档一 6.10.9，账号模式）：同步密码、我的分享码、上传备份、从分享码拉取、云端备份记录。
 * 加密都在客户端：服务端只保存密文，同步密码和分享码不上传。
 */
export function CloudSection({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [share, setShare] = useState<CloudShareInfo | null>(null);
  const [backups, setBackups] = useState<CloudBackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pwDialog, setPwDialog] = useState<'setup' | 'unlock' | 'change' | 'recover' | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [restoring, setRestoring] = useState<CloudBackupInfo | null>(null);
  const [pulling, setPulling] = useState(false);
  const [shareGroups, setShareGroups] = useState<SyncGroup[]>(SHARE_DEFAULT);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [links, setLinks] = useState<ShareLinkInfo[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const st = await invoke('cloud.status');
      setStatus(st);
      const [sh, bs, ls] = await Promise.all([invoke('cloud.share'), invoke('cloud.backups'), invoke('share.links').catch(() => [] as ShareLinkInfo[])]);
      setShare(sh);
      if (sh) setShareGroups(sh.dataGroups);
      setBackups(bs);
      setLinks(ls);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(key);
    try {
      await fn();
      if (ok) message.success(ok);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(null);
      // 失败时也刷新：有的操作分两步（例如开启分享码后再上传分享内容），前一步可能已经生效
      await refresh();
    }
  };

  const unlocked = !!status?.unlocked;
  if (loading && !status) return <Spin style={{ display: 'block', margin: '24px auto' }} />;
  if (error && !status)
    return (
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 16 }}
        message="连不上服务端"
        description={error}
        action={
          <Button size="small" onClick={() => void refresh()}>
            重试
          </Button>
        }
      />
    );

  return (
    <div data-testid="cloud-section">
      {/* 同步密码 */}
      <SettingGroup
        title={
          <Space size={6}>
            <LockOutlined />
            同步密码
          </Space>
        }
      >
        <SettingRow
          label={!status?.configured ? '未设置' : unlocked ? '已设置' : '已设置 · 这台设备未解锁'}
          description="同步密码用来加密云端备份和分享码，只保存在你自己的设备上，服务端无法解密。忘记时可以用恢复码重置。"
          testId="cloud-password-row"
        >
          {!status?.configured ? (
            <Button type="primary" icon={<KeyOutlined />} onClick={() => setPwDialog('setup')} data-testid="cloud-setup">
              设置同步密码
            </Button>
          ) : unlocked ? (
            <Space>
              <Tag color="green" icon={<SafetyCertificateOutlined />}>
                已解锁
              </Tag>
              <Button onClick={() => setPwDialog('change')} data-testid="cloud-change">
                修改
              </Button>
            </Space>
          ) : (
            <Space>
              <Button type="primary" icon={<UnlockOutlined />} onClick={() => setPwDialog('unlock')} data-testid="cloud-unlock">
                输入同步密码解锁
              </Button>
              <Button onClick={() => setPwDialog('recover')} data-testid="cloud-recover">
                用恢复码重置
              </Button>
            </Space>
          )}
        </SettingRow>
      </SettingGroup>

      {/* 我的分享码 */}
      <SettingGroup
        title={
          <Space size={6}>
            <LinkOutlined />
            我的分享码
          </Space>
        }
        extra={
          share && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="share-status">
              {share.enabled ? `● 分享中 · 已被拉取 ${share.pullCount} 次` : '已暂停'}
            </Typography.Text>
          )
        }
      >
        {!share ? (
          <SettingRow label="开启分享码" description="同事输入你的分享码，就能把你分享的主机、快捷命令、笔记合并到他们自己的本地；相同的条目保留他们本地的配置。">
            <Space>
              <Checkbox.Group value={shareGroups} onChange={(v) => setShareGroups(v as SyncGroup[])} options={SYNC_GROUPS.map((g) => ({ value: g, label: SYNC_GROUP_LABEL[g] }))} data-testid="share-groups" />
              <Tooltip title={unlocked ? undefined : '先设置并解锁同步密码（分享码用它托管）'}>
                <Button
                  type="primary"
                  disabled={!unlocked || !shareGroups.length}
                  loading={busy === 'share-enable'}
                  onClick={() => confirmCredentials(modal, shareGroups, () => void run('share-enable', () => invoke('cloud.shareEnable', { groups: shareGroups }), '分享码已开启'))}
                  data-testid="share-enable"
                >
                  开启分享码
                </Button>
              </Tooltip>
            </Space>
          </SettingRow>
        ) : (
          <>
            <SettingRow
              label={
                <span className="mono" data-testid="share-code">
                  {revealed ?? share.maskedCode ?? 'ITM-•••••-•••••-•••••-•••••-•••••'}
                </span>
              }
              description={share.content ? `内容更新于 ${time(share.content.updatedAt)} · ${countsText(share.content.groups, share.content.counts)}` : '还没有上传分享内容'}
            >
              <Space wrap>
                <Button
                  icon={<EyeOutlined />}
                  disabled={!unlocked}
                  onClick={() => void invoke('cloud.shareReveal').then(setRevealed).catch((e) => message.error(errorMessage(e)))}
                  data-testid="share-reveal"
                >
                  显示
                </Button>
                <Button
                  icon={<CopyOutlined />}
                  disabled={!unlocked}
                  onClick={() =>
                    void invoke('cloud.shareReveal')
                      .then((c) => navigator.clipboard.writeText(c))
                      .then(() => message.success('已复制分享码'))
                      .catch((e) => message.error(errorMessage(e)))
                  }
                  data-testid="share-copy"
                >
                  复制
                </Button>
                <Button loading={busy === 'share-refresh'} disabled={!unlocked || !share.enabled} onClick={() => void run('share-refresh', () => invoke('cloud.shareRefresh'), '分享内容已更新')} data-testid="share-refresh">
                  立即更新
                </Button>
                <Button onClick={() => void run('share-pause', () => invoke('cloud.shareUpdate', { enabled: !share.enabled }), share.enabled ? '已暂停分享' : '已恢复分享')} data-testid="share-pause">
                  {share.enabled ? '暂停' : '恢复'}
                </Button>
                <Button
                  disabled={!unlocked}
                  onClick={() =>
                    modal.confirm({
                      title: '重置分享码？',
                      content: '会生成新的分享码，旧的分享码立即失效（同事需要用新码拉取）。',
                      okText: '重置',
                      cancelText: '取消',
                      onOk: () => run('share-reset', () => invoke('cloud.shareReset').then(() => setRevealed(null)), '分享码已重置'),
                    })
                  }
                  data-testid="share-reset"
                >
                  重置
                </Button>
                <Button
                  danger
                  onClick={() =>
                    modal.confirm({
                      title: '关闭分享码？',
                      content: '分享码失效，云端的分享内容一起删除。',
                      okText: '关闭',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () => run('share-close', () => invoke('cloud.shareClose').then(() => setRevealed(null)), '分享码已关闭'),
                    })
                  }
                  data-testid="share-close"
                >
                  关闭
                </Button>
              </Space>
            </SettingRow>
            <SettingRow label="分享范围" description="收窄范围后，云端超出范围的分享内容会立即删除，然后按新范围重新上传。">
              <Space>
                <Checkbox.Group value={shareGroups} onChange={(v) => setShareGroups(v as SyncGroup[])} options={SYNC_GROUPS.map((g) => ({ value: g, label: SYNC_GROUP_LABEL[g] }))} data-testid="share-scope" />
                <Button
                  size="small"
                  disabled={!shareGroups.length || sameGroups(shareGroups, share.dataGroups)}
                  onClick={() => confirmCredentials(modal, shareGroups, () => void run('share-scope', () => invoke('cloud.shareUpdate', { groups: shareGroups }), '分享范围已更新'))}
                  data-testid="share-scope-save"
                >
                  应用
                </Button>
              </Space>
            </SettingRow>
          </>
        )}
      </SettingGroup>

      {/* 我分享的内容（单项分享，第十三轮） */}
      <SettingGroup
        title={
          <Space size={6}>
            <ShareAltOutlined />
            我分享的内容（{links.length}）
          </Space>
        }
        flush
      >
        {links.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="在主机列表、分组、指令集、笔记里右键「分享…」可以只分享选中的内容，每次生成一个独立的分享码"
            style={{ margin: '12px 0' }}
          />
        ) : (
          <div className="share-links" data-testid="share-links">
            {links.map((l) => {
              const state = l.expired ? '已过期' : l.exhausted ? '拉取次数已用完' : null;
              return (
                <div key={l.id} className="share-link-row" data-testid={`share-link-${l.id}`}>
                  <div className="share-link-main">
                    <Space size={6}>
                      <Typography.Text strong ellipsis style={{ maxWidth: 320 }}>
                        {l.title}
                      </Typography.Text>
                      {state ? <Tag>{state}</Tag> : <Tag color="green">有效</Tag>}
                    </Space>
                    <div className="share-link-meta">
                      {countsText(l.groups, l.counts as never)} · {time(l.createdAt)} 创建 · {expiresText(l.expiresAt)} · 拉取 {l.pullCount}
                      {l.maxPulls ? ` / ${l.maxPulls}` : ''} 次
                    </div>
                  </div>
                  <Tooltip title={l.codeAvailable ? undefined : '分享码是在其他设备上创建的（那台设备没有用同步密码托管），这里看不到'}>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      disabled={!l.codeAvailable || !!state}
                      onClick={() =>
                        void invoke('share.reveal', { id: l.id })
                          .then((code) => navigator.clipboard.writeText(shareMessage(l, code)))
                          .then(() => message.success('已复制分享码和说明'))
                          .catch((e) => message.error(errorMessage(e)))
                      }
                      data-testid="share-link-copy-code"
                    >
                      复制分享码
                    </Button>
                  </Tooltip>
                  <Button
                    size="small"
                    danger
                    icon={<StopOutlined />}
                    onClick={() =>
                      modal.confirm({
                        title: `撤销「${l.title}」？`,
                        content: '分享码立即失效，云端的分享内容一起删除。已经拉取过的同事本地的数据不受影响。',
                        okText: '撤销',
                        okButtonProps: { danger: true },
                        cancelText: '取消',
                        onOk: () => run('link-revoke', () => invoke('share.revoke', { id: l.id }), '已撤销'),
                      })
                    }
                    data-testid="share-link-revoke"
                  >
                    撤销
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </SettingGroup>

      {/* 操作 */}
      <div className="cloud-actions">
        <Tooltip title={unlocked ? undefined : '先设置并解锁同步密码'}>
          <Button type="primary" icon={<CloudUploadOutlined />} disabled={!unlocked} onClick={() => setUploading(true)} data-testid="cloud-upload">
            上传备份
          </Button>
        </Tooltip>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void refresh()} data-testid="cloud-refresh">
          刷新列表
        </Button>
        <Button icon={<CloudDownloadOutlined />} onClick={() => setPulling(true)} data-testid="share-pull">
          从分享码拉取
        </Button>
      </div>

      {/* 云端备份记录 */}
      <SettingGroup title={`云端备份记录（${backups.length}）`}>
        {backups.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有云端备份" />
        ) : (
          <div className="cloud-backups" data-testid="cloud-backups">
            {backups.map((b) => (
              <div key={b.id} className="cloud-backup-card" data-testid={`cloud-backup-${b.id}`}>
                <div className="cloud-backup-head">
                  <Space size={6}>
                    {b.pinned && <PushpinFilled style={{ color: 'var(--itm-primary)' }} />}
                    <Typography.Text strong>{time(b.createdAt)}</Typography.Text>
                    <Tag bordered={false}>V{b.formatVersion}</Tag>
                    {b.keyMissing && (
                      <Tooltip title="这份备份用的是轮换之前的密钥，这台设备上没有，无法恢复">
                        <Tag color="orange">密钥已轮换</Tag>
                      </Tooltip>
                    )}
                  </Space>
                  <Space size={0}>
                    <Tooltip title="下载并恢复">
                      <Button type="text" size="small" icon={<CloudDownloadOutlined />} disabled={b.keyMissing || !unlocked} onClick={() => setRestoring(b)} data-testid="backup-restore" />
                    </Tooltip>
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'pin', label: b.pinned ? '取消置顶' : '置顶（不会被自动清理）' },
                          { key: 'remark', label: '备注' },
                          { type: 'divider' },
                          { key: 'delete', label: '删除', danger: true, icon: <DeleteOutlined /> },
                        ],
                        onClick: ({ key }) => {
                          if (key === 'pin') void run('pin', () => invoke('cloud.backupUpdate', { id: b.id, pinned: !b.pinned }));
                          else if (key === 'remark') editRemark(modal, b.remark, (remark) => run('remark', () => invoke('cloud.backupUpdate', { id: b.id, remark })));
                          else if (key === 'delete')
                            modal.confirm({
                              title: '删除这份云端备份？',
                              okText: '删除',
                              okButtonProps: { danger: true },
                              cancelText: '取消',
                              onOk: () => run('delete', () => invoke('cloud.backupDelete', { id: b.id }), '已删除'),
                            });
                        },
                      }}
                    >
                      <Button type="text" size="small" icon={<EllipsisOutlined />} data-testid="backup-more" />
                    </Dropdown>
                  </Space>
                </div>
                <div className="cloud-backup-counts">{countsText(b.groups, b.counts)}</div>
                <div className="cloud-backup-meta">
                  {size(b.size)} · {b.platform} v{b.clientVersion}
                  {b.remark ? ` · ${b.remark}` : ''}
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingGroup>

      <PasswordDialog
        mode={pwDialog}
        onClose={() => setPwDialog(null)}
        onDone={(code) => {
          setPwDialog(null);
          if (code) setRecoveryCode(code);
          void refresh();
        }}
      />
      <RecoveryCodeDialog code={recoveryCode} onClose={() => setRecoveryCode(null)} />
      <UploadDialog
        open={uploading}
        onClose={() => setUploading(false)}
        onDone={() => {
          setUploading(false);
          onChanged();
          void refresh();
        }}
      />
      <RestoreDialog
        backup={restoring}
        onClose={() => setRestoring(null)}
        onDone={() => {
          setRestoring(null);
          onChanged();
        }}
      />
      <PullDialog
        open={pulling}
        onClose={() => setPulling(false)}
        onDone={() => {
          setPulling(false);
          onChanged();
        }}
      />
    </div>
  );
}

const sameGroups = (a: SyncGroup[], b: SyncGroup[]): boolean => a.length === b.length && a.every((g) => b.includes(g));

/** 分享范围包含凭证时二次确认 */
function confirmCredentials(modal: ReturnType<typeof App.useApp>['modal'], groups: SyncGroup[], go: () => void): void {
  if (!groups.includes('CREDENTIALS')) return go();
  modal.confirm({
    title: '分享凭证？',
    content: '拿到分享码的人可以看到这些凭证的密码和私钥，请只分享给可信的同事。',
    okText: '仍然分享',
    okButtonProps: { danger: true },
    cancelText: '取消',
    onOk: go,
  });
}

function editRemark(modal: ReturnType<typeof App.useApp>['modal'], current: string, save: (v: string) => Promise<void>): void {
  let value = current;
  modal.confirm({
    title: '备注',
    icon: null,
    content: <Input defaultValue={current} maxLength={200} onChange={(e) => (value = e.target.value)} autoFocus />,
    okText: '保存',
    cancelText: '取消',
    onOk: () => save(value),
  });
}

// ---------------------------------------------------------------- 同步密码

function PasswordDialog({ mode, onClose, onDone }: { mode: 'setup' | 'unlock' | 'change' | 'recover' | null; onClose: () => void; onDone: (recoveryCode: string | null) => void }): React.JSX.Element {
  const { message } = App.useApp();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [words, setWords] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setPw('');
    setPw2('');
    setWords('');
  }, [mode]);
  const needsNew = mode === 'setup' || mode === 'change' || mode === 'recover';
  const invalid = !pw || (needsNew && (pw.length < MIN_SYNC_PASSWORD || pw !== pw2)) || (mode === 'recover' && words.trim().split(/\s+/).length !== 24);
  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      if (mode === 'setup') onDone((await invoke('cloud.setupPassword', { password: pw })).recoveryCode);
      else if (mode === 'unlock') {
        await invoke('cloud.unlock', { password: pw });
        message.success('已解锁');
        onDone(null);
      } else if (mode === 'change') {
        await invoke('cloud.changePassword', { newPassword: pw });
        message.success('同步密码已修改，其他设备不受影响（已经解锁过的不用重新输入）');
        onDone(null);
      } else if (mode === 'recover') onDone((await invoke('cloud.recover', { recoveryCode: words, newPassword: pw })).recoveryCode);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const title = { setup: '设置同步密码', unlock: '输入同步密码', change: '修改同步密码', recover: '用恢复码重置同步密码' }[mode ?? 'setup'];
  return (
    <Modal
      open={!!mode}
      title={title}
      onCancel={onClose}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} disabled={invalid} onClick={() => void submit()} data-testid="cloud-pw-ok">
            确定
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {mode === 'setup' && <Alert type="info" showIcon message="同步密码只保存在你的设备上，服务端无法解密。设置后会生成恢复码，请务必保存好：同步密码和恢复码都丢失时，云端备份无法恢复。" />}
        {mode === 'recover' && (
          <Input.TextArea rows={3} placeholder="设置同步密码时保存的 24 个英文单词，用空格分开" value={words} onChange={(e) => setWords(e.target.value)} data-testid="cloud-recovery-input" />
        )}
        <Input.Password
          placeholder={mode === 'unlock' ? '同步密码' : `新的同步密码（至少 ${MIN_SYNC_PASSWORD} 位）`}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onPressEnter={() => !invalid && void submit()}
          autoFocus
          data-testid="cloud-pw"
        />
        {needsNew && <Input.Password placeholder="再输入一次" value={pw2} onChange={(e) => setPw2(e.target.value)} status={pw2 && pw !== pw2 ? 'error' : undefined} data-testid="cloud-pw2" />}
      </Space>
    </Modal>
  );
}

function RecoveryCodeDialog({ code, onClose }: { code: string | null; onClose: () => void }): React.JSX.Element {
  const { message } = App.useApp();
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [code]);
  return (
    <Modal
      open={!!code}
      title="请保存恢复码"
      closable={false}
      maskClosable={false}
      footer={
        <Button type="primary" disabled={!saved} onClick={onClose} data-testid="recovery-done">
          我已保存
        </Button>
      }
    >
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="恢复码只显示这一次。忘记同步密码时用它重置；同步密码和恢复码都丢失时，云端备份无法恢复。" />
      <div className="recovery-code mono selectable" data-testid="recovery-code">
        {code}
      </div>
      <Space style={{ marginTop: 12 }}>
        <Button icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(code ?? '').then(() => message.success('已复制'))}>
          复制
        </Button>
        <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)} data-testid="recovery-saved">
          我已经把恢复码保存在安全的地方
        </Checkbox>
      </Space>
    </Modal>
  );
}

// ---------------------------------------------------------------- 上传、恢复、拉取

function UploadDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { message } = App.useApp();
  const [groups, setGroups] = useState<SyncGroup[]>([...SYNC_GROUPS]);
  const [remark, setRemark] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setGroups([...SYNC_GROUPS]);
      setRemark('');
    }
  }, [open]);
  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const b = await invoke('cloud.upload', { groups, remark });
      message.success(`已上传备份（${countsText(b.groups, b.counts)}）`);
      onDone();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      title="上传备份"
      onCancel={onClose}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} disabled={!groups.length} onClick={() => void submit()} data-testid="cloud-upload-ok">
            上传
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <GroupPicker value={groups} onChange={setGroups} testId="cloud-upload-groups" />
        <Input placeholder="备注（可选）" maxLength={200} value={remark} onChange={(e) => setRemark(e.target.value)} />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          用同步密码加密后上传，服务端只保存密文；开启了分享码时会顺带更新分享内容。
        </Typography.Text>
      </Space>
    </Modal>
  );
}

/** 恢复 / 拉取共用：选分组和方式 → 预览 → 确认 */
function MergeFlow({
  groupsAvailable,
  allowReplace,
  call,
  onDone,
  onCancel,
  testPrefix,
}: {
  groupsAvailable: SyncGroup[];
  allowReplace: boolean;
  call: (groups: SyncGroup[], mode: 'merge' | 'replace', dryRun: boolean) => Promise<SyncReport>;
  onDone: () => void;
  onCancel: () => void;
  testPrefix: string;
}): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [groups, setGroups] = useState<SyncGroup[]>(groupsAvailable);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setReport(null), [groups, mode]);
  const go = async (dryRun: boolean): Promise<void> => {
    setBusy(true);
    try {
      const r = await call(groups, mode, dryRun);
      if (dryRun) setReport(r);
      else {
        await reloadAll();
        message.success(`完成。写入前的数据已自动备份（${r.autoBackup}），可以在「自动备份」里撤回`);
        onDone();
      }
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const confirm = (): void => {
    if (mode === 'merge') return void go(false);
    modal.confirm({
      title: '覆盖本地数据？',
      content: '选中分组里本机多出来的条目会被删除，其余以云端备份为准。写入前会自动备份，可以撤回。',
      okText: '覆盖',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => go(false),
    });
  };
  return (
    <>
      <FormSection title="恢复方式">
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <GroupPicker value={groups} onChange={setGroups} available={groupsAvailable} testId={`${testPrefix}-groups`} />
          {allowReplace && (
            <Radio.Group value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}>
              <Space direction="vertical" size={6}>
                <Radio value="merge">
                  合并到本地（推荐）<span className="sync-hint">只增不删；相同的条目保留本地的配置，只补空字段</span>
                </Radio>
                <Radio value="replace">
                  覆盖本地<span className="sync-hint">选中的分组以备份为准，本机多出来的条目会被删除</span>
                </Radio>
              </Space>
            </Radio.Group>
          )}
        </Space>
      </FormSection>
      {report && (
        <FormSection title="预览">
          <ReportTable report={report} />
        </FormSection>
      )}
      <div className="cloud-flow-footer">
        <Space>
          <Button onClick={onCancel}>取消</Button>
          {!report ? (
            <Button type="primary" loading={busy} disabled={!groups.length} onClick={() => void go(true)} data-testid={`${testPrefix}-preview`}>
              预览{mode === 'merge' ? '合并' : '覆盖'}
            </Button>
          ) : (
            <Button type="primary" danger={mode === 'replace'} loading={busy} onClick={confirm} data-testid={`${testPrefix}-confirm`}>
              {mode === 'merge' ? '确认合并' : '确认覆盖'}
            </Button>
          )}
        </Space>
      </div>
    </>
  );
}

function RestoreDialog({ backup, onClose, onDone }: { backup: CloudBackupInfo | null; onClose: () => void; onDone: () => void }): React.JSX.Element {
  return (
    <Modal open={!!backup} title="从云端备份恢复" onCancel={onClose} width={640} destroyOnHidden footer={null}>
      {backup && (
        <>
          <div className="sync-file-card">
            <div>
              <Typography.Text strong>{time(backup.createdAt)}</Typography.Text>
              <Tag style={{ marginLeft: 8 }}>V{backup.formatVersion}</Tag>
            </div>
            <div className="sync-file-meta">
              {backup.platform} v{backup.clientVersion} · {size(backup.size)}
            </div>
            <div className="sync-file-meta">{countsText(backup.groups, backup.counts)}</div>
          </div>
          <MergeFlow
            groupsAvailable={backup.groups}
            allowReplace
            call={(groups, mode, dryRun) => invoke('cloud.restore', { id: backup.id, groups, mode, dryRun })}
            onDone={onDone}
            onCancel={onClose}
            testPrefix="restore"
          />
        </>
      )}
    </Modal>
  );
}

/** 预览卡片：分享者、标题、类型、有效期、条数 */
function SharePreviewCard({ preview }: { preview: SharePreview }): React.JSX.Element {
  const link = preview.kind === 'LINK';
  return (
    <div className="sync-file-card" data-testid="share-preview">
      <div>
        <Typography.Text strong>{preview.ownerDisplayName || preview.ownerUsername}</Typography.Text>
        <Typography.Text type="secondary">
          {' '}
          的{link ? '分享' : '个人分享码'}（{preview.ownerUsername}）
        </Typography.Text>
        {link && preview.title && <Tag style={{ marginLeft: 8 }}>{preview.title}</Tag>}
      </div>
      <div className="sync-file-meta">
        {link ? `分享于 ${time(preview.updatedAt)} · ${expiresText(preview.expiresAt ?? null)}${preview.maxPulls ? ` · 已拉取 ${preview.pullCount ?? 0} / ${preview.maxPulls} 次` : ''}` : `更新于 ${time(preview.updatedAt)}`} · {size(preview.size)}
      </div>
      <div className="sync-file-meta">{countsText(preview.groups, preview.counts)}</div>
    </div>
  );
}

/** 一组可以勾选的条目：标题行带全选 */
function PickGroup<T extends { id: string }>({
  title,
  items,
  value,
  onChange,
  row,
  testId,
}: {
  title: string;
  items: T[];
  value: string[];
  onChange(v: string[]): void;
  row(item: T): React.ReactNode;
  testId: string;
}): React.JSX.Element | null {
  if (!items.length) return null;
  const all = items.every((x) => value.includes(x.id));
  const some = items.some((x) => value.includes(x.id));
  return (
    <div className="pull-pick-group" data-testid={testId}>
      <div className="pull-pick-head">
        <Checkbox checked={all} indeterminate={some && !all} onChange={(e) => onChange(e.target.checked ? items.map((x) => x.id) : [])} data-testid={`${testId}-all`}>
          {title}（{items.filter((x) => value.includes(x.id)).length} / {items.length}）
        </Checkbox>
      </div>
      {items.map((x) => (
        <div key={x.id} className="pull-pick-row">
          <Checkbox checked={value.includes(x.id)} onChange={(e) => onChange(e.target.checked ? [...value, x.id] : value.filter((id) => id !== x.id))} />
          {row(x)}
        </div>
      ))}
    </div>
  );
}

/**
 * 从分享码拉取（第十三轮，文档一 6.27.3）：输入分享码 → 预览 → 获取内容（下载解密）→ 逐条勾选要获取的主机、凭证、快捷命令、笔记，
 * 选择是否导入主机分组（同名分组直接使用）、是否连同凭证 → 预览合并 → 确认合并。个人分享码和单项分享共用。
 */
export function PullDialog({ open, onClose, onDone, only = null }: { open: boolean; onClose: () => void; onDone: () => void; only?: SharePullScope }): React.JSX.Element {
  const { message } = App.useApp();
  const [code, setCode] = useState('');
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [content, setContent] = useState<ShareContent | null>(null);
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [credIds, setCredIds] = useState<string[]>([]);
  const [snippetIds, setSnippetIds] = useState<string[]>([]);
  const [noteIds, setNoteIds] = useState<string[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [withGroups, setWithGroups] = useState(true);
  const [withCreds, setWithCreds] = useState(true);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCode('');
      setPreview(null);
      setContent(null);
      setReport(null);
    }
  }, [open]);
  useEffect(() => setReport(null), [hostIds, credIds, snippetIds, noteIds, skillIds, withGroups, withCreds]);
  const close = (): void => {
    if (code) void invoke('cloud.shareForget', { code }).catch(() => undefined);
    onClose();
  };
  const step = async (key: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const lookup = (): Promise<void> => step('lookup', async () => setPreview(await invoke('cloud.shareLookup', { code })));
  const fetchContent = (): Promise<void> =>
    step('open', async () => {
      const c = await invoke('cloud.shareOpen', { code });
      setContent(c);
      setPreview(c.preview);
      // 从主机页 / 笔记页打开时只勾选这一类（第二十六轮）
      const want = (k: 'hosts' | 'notes' | 'other'): boolean => !only || only === k;
      setHostIds(want('hosts') ? c.hosts.map((h) => h.id) : []);
      setCredIds(want('hosts') ? c.credentials.map((x) => x.id) : []);
      setSnippetIds(want('other') ? c.snippets.map((x) => x.id) : []);
      setNoteIds(want('notes') ? c.notes.map((x) => x.id) : []);
      setSkillIds(want('other') ? (c.skills ?? []).map((x) => x.id) : []);
      setWithGroups(true);
      setWithCreds(want('hosts'));
    });
  const pick = { hostIds, credentialIds: credIds, snippetIds, noteIds, skillIds, withGroups, withCredentials: withCreds };
  const nothing = !hostIds.length && !snippetIds.length && !noteIds.length && !skillIds.length && !(withCreds && credIds.length);
  const merge = (dryRun: boolean): Promise<void> =>
    step(dryRun ? 'preview' : 'confirm', async () => {
      const r = await invoke('cloud.shareImport', { code, pick, dryRun });
      if (dryRun) setReport(r);
      else {
        await reloadAll();
        message.success(`完成。写入前的数据已自动备份（${r.autoBackup}），可以在「自动备份」里撤回`);
        onDone();
      }
    });
  // 主机按分组路径排列
  const hostsSorted = content ? [...content.hosts].sort((a, b) => a.folderPath.localeCompare(b.folderPath, 'zh-CN') || a.name.localeCompare(b.name, 'zh-CN')) : [];
  const valid = code.replace(/[\s-]/g, '').replace(/^ITM/i, '').length >= 25;
  return (
    <Modal
      open={open}
      title={only === 'hosts' ? '从分享码导入主机' : only === 'notes' ? '从分享码导入笔记' : '从分享码拉取'}
      onCancel={close}
      width={680}
      destroyOnHidden
      maskClosable={false}
      footer={
        content ? (
          <Space>
            <Button onClick={close}>取消</Button>
            {!report ? (
              <Button type="primary" loading={busy === 'preview'} disabled={nothing} onClick={() => void merge(true)} data-testid="pull-preview">
                预览合并
              </Button>
            ) : (
              <Button type="primary" loading={busy === 'confirm'} onClick={() => void merge(false)} data-testid="pull-confirm">
                确认合并
              </Button>
            )}
          </Space>
        ) : preview ? (
          <Space>
            <Button onClick={close}>取消</Button>
            <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy === 'open'} onClick={() => void fetchContent()} data-testid="pull-open">
              获取内容
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={close}>取消</Button>
            <Button type="primary" loading={busy === 'lookup'} disabled={!valid} onClick={() => void lookup()} data-testid="share-lookup">
              查找
            </Button>
          </Space>
        )
      }
    >
      {!preview ? (
        <Input placeholder="ITM-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" value={code} onChange={(e) => setCode(e.target.value.trim())} onPressEnter={() => valid && void lookup()} className="mono" autoFocus data-testid="share-code-input" />
      ) : (
        <>
          <SharePreviewCard preview={preview} />
          {!content ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              「获取内容」会下载并解密分享内容（计一次拉取{preview.maxPulls ? `，还能拉取 ${Math.max(0, preview.maxPulls - (preview.pullCount ?? 0))} 次` : ''}），然后可以逐条勾选要合并到本地的内容。
            </Typography.Text>
          ) : (
            <>
              <FormSection title="勾选要获取的内容">
                <div className="pull-pick" data-testid="pull-pick">
                  {(!only || only === 'hosts') && (
                  <PickGroup
                    title="主机"
                    testId="pull-hosts"
                    items={hostsSorted}
                    value={hostIds}
                    onChange={setHostIds}
                    row={(h) => (
                      <>
                        <span className="share-item-name">{h.name}</span>
                        <Typography.Text type="secondary" className="mono share-item-sub" ellipsis>
                          {h.username ? `${h.username}@` : ''}
                          {h.address}
                          {h.port ? `:${h.port}` : ''}
                        </Typography.Text>
                        {h.folderPath && <Tag bordered={false}>{h.folderPath}</Tag>}
                        {h.hasSecret && <Tag>带密码 / 私钥</Tag>}
                      </>
                    )}
                  />
                  )}
                  {withCreds && (!only || only === 'hosts') && (
                    <PickGroup
                      title="凭证"
                      testId="pull-creds"
                      items={content.credentials}
                      value={credIds}
                      onChange={setCredIds}
                      row={(c) => (
                        <>
                          <span className="share-item-name">{c.name}</span>
                          <Tag bordered={false}>{c.type}</Tag>
                          {c.username && <Typography.Text type="secondary">{c.username}</Typography.Text>}
                        </>
                      )}
                    />
                  )}
                  {!only && <PickGroup title="快捷命令" testId="pull-snippets" items={content.snippets} value={snippetIds} onChange={setSnippetIds} row={(x) => <><span className="share-item-name">{x.name}</span>{x.group && <Tag bordered={false}>{x.group}</Tag>}</>} />}
                  {(!only || only === 'notes') && <PickGroup title="笔记" testId="pull-notes" items={content.notes} value={noteIds} onChange={setNoteIds} row={(x) => <><span className="share-item-name">{x.title}</span>{x.group && <Tag bordered={false}>{x.group}</Tag>}</>} />}
                  {!only && <PickGroup
                    title="Skill（本机已有同名的保留本机的）"
                    testId="pull-skills"
                    items={content.skills ?? []}
                    value={skillIds}
                    onChange={setSkillIds}
                    row={(x) => (
                      <>
                        <span className="share-item-name">{x.title}</span>
                        {x.title !== x.id && <Tag bordered={false}>{x.id}</Tag>}
                        {x.description && <Typography.Text type="secondary" ellipsis style={{ maxWidth: 260 }}>{x.description}</Typography.Text>}
                      </>
                    )}
                  />}
                </div>
                <Space direction="vertical" size={6} style={{ marginTop: 10 }}>
                  {content.hosts.length > 0 && only !== 'notes' && (
                    <Checkbox checked={withGroups} onChange={(e) => setWithGroups(e.target.checked)} data-testid="pull-with-groups">
                      同时导入主机分组<span className="sync-hint">主机放进和对方相同的分组路径；本地已经有同名分组时直接使用，没有时创建。不勾选时放在「未分组」</span>
                    </Checkbox>
                  )}
                  {content.hasSecrets && only !== 'notes' && (
                    <Checkbox checked={withCreds} onChange={(e) => setWithCreds(e.target.checked)} data-testid="pull-with-creds">
                      连同凭证导入（密码、私钥）<span className="sync-hint">不勾选时只导入地址、端口、用户名等，需要自己填写密码</span>
                    </Checkbox>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    快捷命令、笔记的分组同名时直接使用。合并只增不删：本地已有的条目保留本地的配置，只补空字段。
                  </Typography.Text>
                </Space>
              </FormSection>
              {report && (
                <FormSection title="预览">
                  <ReportTable report={report} />
                </FormSection>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/** 全局的「从分享码导入」对话框（主机页、笔记页的导入菜单打开，第二十六轮） */
export function SharePullHost(): React.JSX.Element {
  const open = useSharePull((s) => s.open);
  const only = useSharePull((s) => s.only);
  return <PullDialog open={open} only={only} onClose={() => useSharePull.getState().close()} onDone={() => useSharePull.getState().close()} />;
}
