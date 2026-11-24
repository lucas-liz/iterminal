import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Progress, Select, Space, Steps, Table, Tag, Typography } from 'antd';
import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, MinusCircleOutlined } from '@ant-design/icons';
import type { Credential, CredentialSecretView, DeployResult, Folder, Host, RotateProgress, RotateReport, TotpCode } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { useHosts } from '../../store/hosts';
import { useVault } from '../../store/vault';

/** 实际使用这个凭证的主机：主机专属凭证就是它的主机；共享凭证是直接引用或者继承分组默认凭证的主机 */
export function hostsUsing(credential: Credential, hosts: Host[], folders: Folder[]): Host[] {
  if (credential.ownerHostId) return hosts.filter((h) => h.id === credential.ownerHostId);
  const credentialId = credential.id;
  const byId = new Map(folders.map((f) => [f.id, f]));
  return hosts.filter((h) => {
    if (h.authMethod !== 'CREDENTIAL') return false;
    if (h.credentialId) return h.credentialId === credentialId;
    for (let f = h.folderId ? byId.get(h.folderId) : undefined; f; f = f.parentId ? byId.get(f.parentId) : undefined) {
      if (f.defaultCredentialId) return f.defaultCredentialId === credentialId;
    }
    return false;
  });
}

/** 查看明文：开启了主密码时先输入主密码；没有主密码时 macOS 会弹出 Touch ID。30 秒后自动隐藏。 */
export function RevealModal({ credential, onClose }: { credential: Credential | null; onClose(): void }): React.JSX.Element {
  const masterPassword = useApp((s) => !!s.security?.masterPassword);
  const [password, setPassword] = useState('');
  const [view, setView] = useState<CredentialSecretView | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPassword('');
    setView(null);
    setError(null);
  }, [credential]);

  useEffect(() => {
    if (!view) return;
    setLeft(view.ttlSec);
    const t = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) {
          clearInterval(t);
          setView(null);
          onClose();
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [view]);

  const reveal = async (): Promise<void> => {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      setView(await invoke('credential.reveal', { id: credential.id, password: masterPassword ? password : undefined }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, value: string | null): React.ReactNode =>
    value ? (
      <div>
        <Typography.Text type="secondary">{label}</Typography.Text>
        <Typography.Paragraph copyable={{ text: value }} className="mono selectable reveal-box">
          {value}
        </Typography.Paragraph>
      </div>
    ) : null;

  return (
    <Modal open={!!credential} title={`查看明文 · ${credential?.name ?? ''}`} footer={null} onCancel={onClose} destroyOnHidden width={560}>
      {view ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Progress percent={(left / view.ttlSec) * 100} showInfo={false} size="small" />
          <Typography.Text type="secondary">{`${left} 秒后自动隐藏。查看操作已记录到审计日志。`}</Typography.Text>
          {field(credential?.type === 'SSH_KEY' || credential?.type === 'CERT' ? '私钥' : credential?.type === 'CLOUD_AK' ? 'Secret Key' : '密码', view.secret)}
          {field('私钥口令', view.passphrase)}
          {field('TOTP 种子', view.otpSeed)}
          {!view.secret && !view.passphrase && !view.otpSeed && <Typography.Text>这个凭证没有保存秘密。</Typography.Text>}
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert type="warning" showIcon message="明文会显示在屏幕上，请确认周围没有其他人。" />
          {masterPassword ? (
            <Input.Password autoFocus placeholder="输入主密码验证身份" value={password} onChange={(e) => setPassword(e.target.value)} onPressEnter={() => void reveal()} data-testid="reveal-password" />
          ) : (
            <Typography.Text type="secondary">没有设置主密码：支持 Touch ID 的电脑会先验证指纹。建议在「设置 → 安全」里设置主密码。</Typography.Text>
          )}
          {error && <Typography.Text type="danger">{error}</Typography.Text>}
          <Button type="primary" loading={busy} disabled={masterPassword && !password} onClick={() => void reveal()} data-testid="reveal-confirm">
            显示明文
          </Button>
        </Space>
      )}
    </Modal>
  );
}

/** OTP 凭证的当前验证码（每 30 秒刷新） */
export function TotpBadge({ id }: { id: string }): React.JSX.Element {
  const [code, setCode] = useState<TotpCode | null>(null);
  const [left, setLeft] = useState(0);
  const fetchRef = useRef(0);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      const n = ++fetchRef.current;
      void invoke('credential.totp', { id })
        .then((c) => {
          if (alive && n === fetchRef.current) {
            setCode(c);
            setLeft(c.remainingSec);
          }
        })
        .catch(() => undefined);
    };
    load();
    const t = setInterval(() => {
      setLeft((x) => {
        if (x <= 1) {
          load();
          return 30;
        }
        return x - 1;
      });
    }, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  if (!code) return <Typography.Text type="secondary">…</Typography.Text>;
  return (
    <Space size={6}>
      <Typography.Text code copyable={{ text: code.code }} className="mono" data-testid="totp-code">
        {`${code.code.slice(0, 3)} ${code.code.slice(3)}`}
      </Typography.Text>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{`${left}s`}</Typography.Text>
    </Space>
  );
}

function HostPicker({ value, onChange, hosts }: { value: string[]; onChange(v: string[]): void; hosts: Host[] }): React.JSX.Element {
  return (
    <Select
      mode="multiple"
      style={{ width: '100%' }}
      placeholder="选择主机"
      value={value}
      onChange={onChange}
      optionFilterProp="label"
      options={hosts.filter((h) => h.protocol === 'SSH').map((h) => ({ value: h.id, label: `${h.name}（${h.username || '凭证用户'}@${h.address}）` }))}
      maxTagCount="responsive"
    />
  );
}

const STATUS_ICON: Record<DeployResult['status'], React.ReactNode> = {
  ok: <CheckCircleFilled style={{ color: '#52c41a' }} />,
  skipped: <MinusCircleOutlined style={{ color: '#8c8c8c' }} />,
  error: <CloseCircleFilled style={{ color: '#ff4d4f' }} />,
};

/** 批量部署公钥（ssh-copy-id）：用各台主机现有的认证方式登录后追加到 authorized_keys */
export function DeployModal({ credential, onClose }: { credential: Credential | null; onClose(): void }): React.JSX.Element {
  const hosts = useHosts((s) => s.hosts);
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<DeployResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSelected([]);
    setResults(null);
    setError(null);
  }, [credential]);

  const run = async (): Promise<void> => {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await invoke('credential.deploy', { id: credential.id, hostIds: selected }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!credential}
      title={`部署公钥 · ${credential?.name ?? ''}`}
      width={640}
      onCancel={onClose}
      destroyOnHidden
      footer={
        results ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" loading={busy} disabled={selected.length === 0} onClick={() => void run()} data-testid="deploy-run">
              {`部署到 ${selected.length} 台主机`}
            </Button>
          </Space>
        )
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">把公钥追加到每台主机的 ~/.ssh/authorized_keys（已存在则跳过），登录用的是主机现在的认证方式。</Typography.Text>
        {credential?.publicKey && <Typography.Text code className="mono" ellipsis style={{ maxWidth: 580 }}>{credential.publicKey}</Typography.Text>}
        {!results && <HostPicker hosts={hosts} value={selected} onChange={setSelected} />}
        {error && <Alert type="error" showIcon message={error} />}
        {results && (
          <Table<DeployResult>
            size="small"
            rowKey="hostId"
            pagination={false}
            dataSource={results}
            columns={[
              { title: '', width: 30, render: (_, r) => STATUS_ICON[r.status] },
              { title: '主机', dataIndex: 'hostName' },
              { title: '结果', dataIndex: 'message' },
            ]}
          />
        )}
      </Space>
    </Modal>
  );
}

type StageStatus = 'wait' | 'process' | 'finish' | 'error';

/** 轮换向导：生成新密钥 → 部署 → 验证 → 吊销旧密钥 → 替换凭证（任何一台验证失败都会回滚） */
export function RotateModal({ credential, onClose }: { credential: Credential | null; onClose(): void }): React.JSX.Element {
  const hosts = useHosts((s) => s.hosts);
  const folders = useHosts((s) => s.folders);
  const reloadVault = useVault((s) => s.reload);
  const using = useMemo(() => (credential ? hostsUsing(credential, hosts, folders) : []), [credential, hosts, folders]);
  const [selected, setSelected] = useState<string[]>([]);
  const [progress, setProgress] = useState<Record<string, Record<string, RotateProgress['status']>>>({});
  const [report, setReport] = useState<RotateReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelected(using.map((h) => h.id));
    setProgress({});
    setReport(null);
    setError(null);
  }, [credential]);

  useEffect(
    () =>
      window.itm.on('credential.rotateProgress', (p) => {
        if (p.credentialId !== credential?.id) return;
        setProgress((cur) => ({ ...cur, [p.hostId]: { ...cur[p.hostId], [p.stage]: p.status } }));
      }),
    [credential?.id],
  );

  const run = async (): Promise<void> => {
    if (!credential) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await invoke('credential.rotate', { id: credential.id, hostIds: selected }));
      await reloadVault();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const stage = (hostId: string, s: 'deploy' | 'verify' | 'revoke'): StageStatus => {
    const v = progress[hostId]?.[s];
    return v === 'running' ? 'process' : v === 'ok' ? 'finish' : v === 'error' ? 'error' : 'wait';
  };

  return (
    <Modal
      open={!!credential}
      title={`轮换密钥 · ${credential?.name ?? ''}`}
      width={720}
      onCancel={busy ? undefined : onClose}
      closable={!busy}
      maskClosable={false}
      destroyOnHidden
      footer={
        report ? (
          <Button onClick={onClose}>完成</Button>
        ) : (
          <Space>
            <Button onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button type="primary" loading={busy} disabled={selected.length === 0} onClick={() => void run()} data-testid="rotate-run">
              开始轮换
            </Button>
          </Space>
        )
      }
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Steps
          size="small"
          items={[{ title: '生成新密钥' }, { title: '部署新公钥' }, { title: '新密钥验证登录' }, { title: '替换凭证并吊销旧公钥' }]}
          current={report ? 4 : busy ? 1 : 0}
        />
        <Typography.Text type="secondary">
          用现在的密钥登录每台主机部署新公钥，再用新密钥逐台验证。全部通过后才替换凭证并删除旧公钥；有一台失败就撤回新公钥，凭证保持不变。
        </Typography.Text>
        {!report && !busy && (
          <>
            <Typography.Text>{`使用这个凭证的主机：${using.length} 台`}</Typography.Text>
            <HostPicker hosts={hosts} value={selected} onChange={setSelected} />
          </>
        )}
        {error && <Alert type="error" showIcon message={error} />}
        {(busy || report) && (
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={selected.map((id) => ({ id, name: hosts.find((h) => h.id === id)?.name ?? id }))}
            columns={[
              { title: '主机', dataIndex: 'name' },
              ...(['deploy', 'verify', 'revoke'] as const).map((s) => ({
                title: { deploy: '部署', verify: '验证', revoke: '吊销旧公钥' }[s],
                key: s,
                width: 100,
                render: (_: unknown, r: { id: string }) => {
                  const st = stage(r.id, s);
                  return st === 'process' ? <LoadingOutlined /> : st === 'finish' ? STATUS_ICON.ok : st === 'error' ? STATUS_ICON.error : <Typography.Text type="secondary">—</Typography.Text>;
                },
              })),
              { title: '说明', key: 'msg', render: (_: unknown, r: { id: string }) => report?.steps.find((x) => x.hostId === r.id)?.message ?? '' },
            ]}
          />
        )}
        {report && (
          <Alert
            type={report.replaced ? 'success' : 'error'}
            showIcon
            message={report.replaced ? '轮换完成，凭证已经换成新密钥' : '轮换没有完成，已撤回新公钥，凭证保持不变'}
            description={report.replaced ? <span className="mono">{report.fingerprint}</span> : '请检查失败的主机后重试。'}
          />
        )}
        {report?.replaced && <Tag color="green">新指纹 {report.fingerprint}</Tag>}
      </Space>
    </Modal>
  );
}
