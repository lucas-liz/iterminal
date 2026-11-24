import { useMemo, useState } from 'react';
import { App, Button, Dropdown, Empty, Input, List, Modal, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudOutlined,
  DatabaseOutlined,
  EllipsisOutlined,
  EyeOutlined,
  FieldNumberOutlined,
  KeyOutlined,
  LockOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { Credential, CredentialType, Host } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useHosts } from '../../store/hosts';
import { CREDENTIAL_TYPES, credentialHealth, typeLabel, useVault } from '../../store/vault';
import { formatRelative, formatTime } from '../../util/format';
import { CredentialEditor, type CredentialEditorTarget } from './CredentialEditor';
import { DeployModal, RevealModal, RotateModal, TotpBadge } from './CredentialActions';

const TYPE_ICON: Record<CredentialType, React.ReactNode> = {
  PASSWORD: <LockOutlined />,
  SSH_KEY: <KeyOutlined />,
  CERT: <SafetyCertificateOutlined />,
  OTP: <FieldNumberOutlined />,
  CLOUD_AK: <CloudOutlined />,
  DB: <DatabaseOutlined />,
};

/** 凭证管理（文档一 6.6）：个人凭证保存在本机加密库里；AI 永远拿不到明文 */
/** embedded：放在凭证管理小窗里（不占窗口拖动区，表格高度按小窗计算） */
export function VaultPage({ embedded = false }: { embedded?: boolean } = {}): React.JSX.Element {
  const { message, modal } = App.useApp();
  const credentials = useVault((s) => s.credentials);
  const reload = useVault((s) => s.reload);
  const [query, setQuery] = useState('');
  /** 「查看使用凭证的主机」（第二十六轮，替代「显示主机专属凭证」开关） */
  const [usedBy, setUsedBy] = useState<Credential | null>(null);
  const [editor, setEditor] = useState<CredentialEditorTarget | null>(null);
  const [revealing, setRevealing] = useState<Credential | null>(null);
  const [deploying, setDeploying] = useState<Credential | null>(null);
  const [rotating, setRotating] = useState<Credential | null>(null);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return credentials
      // 主机专属凭证（在主机编辑框里填的密码 / 私钥）不在这里列出，到主机里管理
      .filter((c) => !c.ownerHostId)
      .filter((c) => !q || [c.name, c.username ?? '', c.fingerprint ?? '', c.note ?? ''].some((v) => v.toLowerCase().includes(q)));
  }, [credentials, query]);

  const remove = (c: Credential): void => {
    modal.confirm({
      title: `删除凭证「${c.name}」？`,
      content: '删除后无法恢复。正在被主机或分组使用的凭证不能删除。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await invoke('credential.delete', { id: c.id });
          await reload();
          message.success('已删除');
        } catch (e) {
          message.error(errorMessage(e));
        }
      },
    });
  };

  const columns: ColumnsType<Credential> = [
    {
      title: '名称',
      dataIndex: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name, 'zh-CN'),
      render: (_, c) => (
        <Space size={6}>
          <span style={{ color: 'var(--itm-primary)' }}>{TYPE_ICON[c.type]}</span>
          <span>{c.name}</span>
          {c.aiAccess === 'DENY' && (
            <Tooltip title="使用这个凭证的主机不能被 Agent 引用">
              <Tag color="red" bordered={false}>
                禁止 AI
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    { title: '类型', dataIndex: 'type', width: 110, render: (t: CredentialType) => <Tag bordered={false}>{typeLabel(t)}</Tag> },
    {
      title: '用户名 / 指纹',
      key: 'who',
      render: (_, c) =>
        c.type === 'OTP' ? (
          <TotpBadge id={c.id} />
        ) : (
          <Space direction="vertical" size={0}>
            {c.username && <span className="mono selectable">{c.username}</span>}
            {c.fingerprint && (
              <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }} copyable={{ text: c.publicKey ?? c.fingerprint }}>
                {c.fingerprint}
              </Typography.Text>
            )}
            {c.hasOtp && (
              <Space size={4}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  验证码
                </Typography.Text>
                <TotpBadge id={c.id} />
              </Space>
            )}
          </Space>
        ),
    },
    {
      title: '使用',
      key: 'used',
      width: 120,
      render: (_, c) =>
        c.usedByHosts + c.usedByFolders === 0 ? (
          <Typography.Text type="secondary">未使用</Typography.Text>
        ) : (
          <Typography.Text>{[c.usedByHosts ? `${c.usedByHosts} 台主机` : '', c.usedByFolders ? `${c.usedByFolders} 个分组` : ''].filter(Boolean).join('、')}</Typography.Text>
        ),
    },
    {
      title: '状态',
      key: 'health',
      width: 150,
      render: (_, c) => {
        const h = credentialHealth(c);
        if (h.kind === 'ok') {
          return c.expiresAt ? <Typography.Text type="secondary">{`${formatTime(c.expiresAt).slice(0, 10)} 到期`}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>;
        }
        const what = h.reason === 'rotate' ? '轮换' : '到期';
        return (
          <Tag color={h.kind === 'overdue' ? 'red' : 'orange'} icon={<WarningOutlined />} bordered={false}>
            {h.kind === 'overdue' ? `已超过${what}时间 ${h.days} 天` : `${h.days} 天后${what}`}
          </Tag>
        );
      },
    },
    {
      title: '最近使用',
      dataIndex: 'lastUsedAt',
      width: 110,
      render: (v: number | null) => <Typography.Text type="secondary">{v ? formatRelative(v) : '—'}</Typography.Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      render: (_, c) => (
        <Space size={4}>
          <Tooltip title="查看明文">
            <Button size="small" type="text" icon={<EyeOutlined />} disabled={!c.hasSecret && !c.hasOtp} onClick={() => setRevealing(c)} data-testid={`reveal-${c.name}`} />
          </Tooltip>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                { key: 'edit', label: '编辑', disabled: !!c.ownerHostId },
                { key: 'usedBy', label: '查看使用凭证的主机', disabled: c.usedByHosts + c.usedByFolders === 0 },
                ...(c.type === 'SSH_KEY'
                  ? [
                      { key: 'deploy', label: '部署公钥到主机…', disabled: !c.publicKey },
                      { key: 'rotate', label: '轮换密钥…', disabled: !c.hasSecret },
                    ]
                  : []),
                { type: 'divider' as const },
                { key: 'delete', label: '删除', danger: true, disabled: !!c.ownerHostId },
              ],
              onClick: ({ key }) => {
                if (key === 'edit') setEditor({ mode: 'edit', credential: c });
                if (key === 'usedBy') setUsedBy(c);
                if (key === 'deploy') setDeploying(c);
                if (key === 'rotate') setRotating(c);
                if (key === 'delete') remove(c);
              },
            }}
          >
            <Button size="small" type="text" icon={<EllipsisOutlined />} data-testid={`credential-more-${c.name}`} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <>
      <div className={embedded ? 'page-header vault-modal-head' : 'page-header drag'}>
        <h1>{embedded ? '凭证管理' : '凭证'}</h1>
        <Typography.Text type="secondary">保存在本机加密库，Agent 只能引用，永远拿不到明文</Typography.Text>
        <div style={{ marginLeft: 'auto' }} className="no-drag">
          <Dropdown
            trigger={['click']}
            menu={{ items: CREDENTIAL_TYPES.map((t) => ({ key: t.value, label: t.label, icon: TYPE_ICON[t.value] })), onClick: ({ key }) => setEditor({ mode: 'create', type: key as CredentialType }) }}
          >
            <Button type="primary" icon={<PlusOutlined />} data-testid="new-credential">
              新建凭证
            </Button>
          </Dropdown>
        </div>
      </div>
      <div className="vault-body">
        <div className="host-toolbar">
          <Input allowClear prefix={<SearchOutlined />} placeholder="搜索名称、用户名、指纹、备注" style={{ width: 300 }} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Table<Credential>
          size="middle"
          rowKey="id"
          columns={columns}
          dataSource={list}
          pagination={false}
          scroll={{ y: embedded ? 'calc(min(760px, 82vh) - 170px)' : 'calc(100vh - 170px)' }}
          locale={{
            emptyText: (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? '没有匹配的凭证' : '还没有共享凭证。多台主机共用的账号、密钥建议保存在这里，分组也可以设置默认凭证。'}>
                {!query && (
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditor({ mode: 'create', type: 'SSH_KEY' })}>
                    新建凭证
                  </Button>
                )}
              </Empty>
            ),
          }}
        />
      </div>
      <CredentialEditor target={editor} onClose={() => setEditor(null)} />
      <RevealModal credential={revealing} onClose={() => setRevealing(null)} />
      <DeployModal credential={deploying} onClose={() => setDeploying(null)} />
      <RotateModal credential={rotating} onClose={() => setRotating(null)} />
      <UsedByModal credential={usedBy} onClose={() => setUsedBy(null)} />
    </>
  );
}

/**
 * 使用这个凭证的主机（第二十六轮）：直接选了这个凭证的主机，以及默认凭证是它的分组（分组里没有单独设置凭证的主机继承它）。
 * 点主机名打开主机编辑框
 */
function UsedByModal({ credential, onClose }: { credential: Credential | null; onClose(): void }): React.JSX.Element {
  const hosts = useHosts((s) => s.hosts);
  const folders = useHosts((s) => s.folders);
  const id = credential?.id;
  const direct = hosts.filter((h) => h.authMethod === 'CREDENTIAL' && h.credentialId === id);
  const viaFolders = folders.filter((f) => f.defaultCredentialId === id);
  // 分组的默认凭证：分组（含子分组）里认证方式是「凭证」且没有单独选凭证的主机
  const inFolder = (h: Host, fid: string): boolean => {
    for (let cur: string | null = h.folderId; cur; cur = folders.find((f) => f.id === cur)?.parentId ?? null) if (cur === fid) return true;
    return false;
  };
  const inherited = viaFolders.flatMap((f) => hosts.filter((h) => h.authMethod === 'CREDENTIAL' && !h.credentialId && inFolder(h, f.id)).map((h) => ({ h, f })));
  const rows: { h: Host; via: string }[] = [...direct.map((h) => ({ h, via: '直接使用' })), ...inherited.map(({ h, f }) => ({ h, via: `继承分组「${f.name}」` }))];
  return (
    <Modal open={!!credential} title={`使用「${credential?.name ?? ''}」的主机`} footer={null} onCancel={onClose} destroyOnHidden width={520}>
      <div data-testid="credential-used-by">
        {rows.length === 0 && viaFolders.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有主机使用这个凭证" />
        ) : (
          <List
            size="small"
            dataSource={rows}
            locale={{ emptyText: '分组里还没有继承这个凭证的主机' }}
            renderItem={({ h, via }) => (
              <List.Item
                actions={[
                  <Typography.Text key="via" type="secondary" style={{ fontSize: 12 }}>
                    {via}
                  </Typography.Text>,
                ]}
              >
                <Space direction="vertical" size={0}>
                  <Typography.Link onClick={() => useHosts.getState().openEditor({ mode: 'edit', host: h })} data-testid="used-by-host">
                    {h.name}
                  </Typography.Link>
                  <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>{`${h.username ? `${h.username}@` : ''}${h.address}:${h.port}`}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
        {viaFolders.length > 0 && (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
            {`默认凭证是它的分组：${viaFolders.map((f) => f.name).join('、')}`}
          </Typography.Text>
        )}
      </div>
    </Modal>
  );
}
