import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Checkbox, Form, Input, InputNumber, Modal, Segmented, Select, Space, Typography } from 'antd';
import { ApiOutlined, FolderOpenOutlined, SwapOutlined } from '@ant-design/icons';
import { DB_PRODUCTS, dbProductOf, type DbAsset, type DbAssetInput, type DbProduct, type DbType } from '@itm/protocol';
import { DbProductIcon } from '../../components/db/DbIcon';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { useHosts } from '../../store/hosts';
import { useVault } from '../../store/vault';
import { FormSection } from '../../components/FormSection';
import { policyLabel } from '../../util/policy';
import { AgentPolicySelect } from '../../components/AgentPolicyMenu';
import { freshOnOpen } from '../../util/fresh';

interface FormValues {
  name: string;
  type: DbType;
  flavor: string | null;
  host: string;
  port: number;
  database: string;
  username: string;
  auth: 'password' | 'credential';
  password: string;
  credentialId: string | null;
  ssl: DbAssetInput['ssl'];
  viaHostId: string | null;
  filePath: string;
  agentPolicy: string;
  production: boolean;
  sqlDenylist: string;
  note: string;
}

const SSL_OPTIONS = [
  { value: 'OFF', label: '关闭' },
  { value: 'REQUIRE', label: '需要（不校验证书）' },
  { value: 'VERIFY', label: '需要并校验证书' },
];

/** 表单 → 保存 / 测试用的输入；密码留空表示不修改（编辑已有记录时） */
function toInput(v: FormValues, editing: DbAsset | null): DbAssetInput {
  const sqlite = v.type === 'SQLITE';
  const useCred = !sqlite && v.auth === 'credential';
  return {
    name: v.name?.trim() ?? '',
    type: v.type,
    flavor: v.flavor ?? null,
    host: sqlite ? '' : (v.host ?? '').trim(),
    port: sqlite ? 0 : Number(v.port),
    database: sqlite ? '' : (v.database ?? '').trim(),
    username: sqlite ? '' : (v.username ?? '').trim(),
    // 编辑时密码框留空 = 不修改；新建时留空 = 没有密码
    password: sqlite || useCred ? null : v.password ? v.password : editing ? undefined : null,
    credentialId: useCred ? v.credentialId || null : null,
    ssl: sqlite ? 'OFF' : v.ssl,
    viaHostId: sqlite ? null : v.viaHostId || null,
    filePath: sqlite ? (v.filePath ?? '').trim() : null,
    agentPolicy: v.agentPolicy ? (v.agentPolicy as DbAssetInput['agentPolicy']) : null,
    production: !!v.production,
    sqlDenylist: (v.sqlDenylist ?? '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean),
    note: v.note?.trim() || null,
  };
}

const GROUPS: { key: DbProduct['group']; title: string; desc: string }[] = [
  { key: 'mysql', title: 'MySQL 协议', desc: 'MySQL 和兼容 MySQL 协议的数据库' },
  { key: 'postgres', title: 'PostgreSQL 协议', desc: 'PostgreSQL 和兼容它的数据库' },
  { key: 'local', title: '本机文件', desc: '' },
  { key: 'soon', title: '即将支持', desc: '后续版本加入' },
];

/** 第一步：选择数据库（第二十七轮） */
function DbTypePicker({ onPick }: { onPick(p: DbProduct): void }): React.JSX.Element {
  return (
    <div className="db-picker" data-testid="db-picker">
      {GROUPS.map((g) => (
        <div key={g.key} className="db-picker-group">
          <div className="db-picker-title">
            <span>{g.title}</span>
            {g.desc && <Typography.Text type="secondary">{g.desc}</Typography.Text>}
          </div>
          <div className="db-picker-grid">
            {DB_PRODUCTS.filter((p) => p.group === g.key).map((p) => {
              const soon = !p.engine;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`db-picker-card ${soon ? 'soon' : ''}`}
                  disabled={soon}
                  onClick={() => onPick(p)}
                  data-testid={`db-product-${p.id}`}
                  title={soon ? `${p.label}：即将支持` : `${p.label}${p.defaultPort ? `（默认端口 ${p.defaultPort}）` : ''}`}
                >
                  <DbProductIcon id={p.id} size={36} muted={soon} />
                  <span className="db-picker-name">{p.label}</span>
                  <span className="db-picker-desc">{soon ? '即将支持' : p.desc || (p.defaultPort ? `端口 ${p.defaultPort}` : '')}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 新建 / 编辑数据库（文档一 6.31.2；第二十七轮分两步：先选数据库，再填连接信息）：连接（地址、账号、SSL、经过的 SSH 主机，或 SQLite 文件）和 Agent 的权限。
 * 「测试连接」用表单里当前的值，不需要先保存。
 */
function DbEditorDialog({ target, onClose }: { target: { asset: DbAsset | null } | null; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const editing = target?.asset ?? null;
  const hosts = useHosts((s) => s.hosts);
  const credentials = useVault((s) => s.credentials);
  const globalPolicy = useApp((s) => s.settings['ai.defaultAgentPolicy']);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const type = Form.useWatch('type', form) ?? editing?.type ?? 'MYSQL';
  const flavor = Form.useWatch('flavor', form) as string | null | undefined;
  // 新建时先选数据库；编辑时直接显示表单（可以点「更换」重新选）
  const [step, setStep] = useState<'pick' | 'form'>(editing ? 'form' : 'pick');
  const product = dbProductOf({ type, flavor: flavor ?? editing?.flavor ?? null });
  const pick = (p: DbProduct): void => {
    if (!p.engine) return;
    const port = form.getFieldValue('port') as number | undefined;
    const known = !port || DB_PRODUCTS.some((x) => x.defaultPort === port);
    form.setFieldsValue({ type: p.engine, flavor: p.id, ...(p.defaultPort && known ? { port: p.defaultPort } : {}) });
    setTest(null);
    setStep('form');
  };
  const auth = Form.useWatch('auth', form) ?? (editing?.credentialId ? 'credential' : 'password');

  useEffect(() => {
    if (target) void useVault.getState().reload().catch(() => undefined);
  }, [target]);

  const initialValues = useMemo((): FormValues => {
    const a = editing;
    return {
      name: a?.name ?? '',
      type: a?.type ?? 'MYSQL',
      flavor: a?.flavor ?? null,
      host: a?.host ?? '',
      port: a?.port || 3306,
      database: a?.database ?? '',
      username: a?.username ?? '',
      auth: a?.credentialId ? 'credential' : 'password',
      password: '',
      credentialId: a?.credentialId ?? null,
      ssl: a?.ssl ?? 'OFF',
      viaHostId: a?.viaHostId ?? null,
      filePath: a?.filePath ?? '',
      agentPolicy: a?.agentPolicy ?? '',
      production: a?.production ?? false,
      sqlDenylist: (a?.sqlDenylist ?? []).join('\n'),
      note: a?.note ?? '',
    };
  }, [editing]);

  const hostOptions = useMemo(() => hosts.filter((h) => h.protocol === 'SSH').map((h) => ({ value: h.id, label: `${h.name}（${h.username ? `${h.username}@` : ''}${h.address}）` })), [hosts]);
  const credOptions = useMemo(
    () => credentials.filter((c) => !c.ownerHostId && (c.type === 'DB' || c.type === 'PASSWORD')).map((c) => ({ value: c.id, label: `${c.name}${c.username ? `（${c.username}）` : ''}${c.aiAccess === 'DENY' ? ' · 禁止 AI 引用' : ''}` })),
    [credentials],
  );

  const values = (): FormValues => ({ ...initialValues, ...form.getFieldsValue(true) });

  const runTest = async (): Promise<void> => {
    setTesting(true);
    setTest(null);
    try {
      const r = await invoke('db.test', { id: editing?.id ?? null, input: toInput(values(), editing) });
      setTest(r.ok ? { ok: true, text: `连接成功：${r.version} · ${r.latencyMs} ms${r.databases !== null ? ` · 可以看到 ${r.databases} 个库` : ''}` } : { ok: false, text: r.error });
    } catch (e) {
      setTest({ ok: false, text: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    try {
      await form.validateFields();
    } catch {
      return;
    }
    setBusy(true);
    try {
      const saved = await invoke('db.save', { id: editing?.id ?? null, input: toInput(values(), editing) });
      message.success(editing ? '已保存' : `已添加数据库「${saved.name}」`);
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title={editing ? `编辑数据库「${editing.name}」` : step === 'pick' ? '新建数据库连接 · 选择数据库' : '新建数据库连接 · 填写连接信息'}
      width={step === 'pick' ? 760 : 720}
      onCancel={onClose}
      destroyOnHidden
      className="db-editor"
      styles={{ body: { maxHeight: 'min(720px, calc(100vh - 220px))', overflowY: 'auto', paddingRight: 6 } }}
      footer={
        step === 'pick' ? (
          <div className="db-editor-foot">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              兼容 MySQL / PostgreSQL 协议的数据库用对应的驱动连接，只是默认端口不同
            </Typography.Text>
            <span style={{ flex: 1 }} />
            {editing && <Button onClick={() => setStep('form')}>返回</Button>}
            <Button onClick={onClose}>取消</Button>
          </div>
        ) : (
        <div className="db-editor-foot">
          <Button icon={<ApiOutlined />} loading={testing} onClick={() => void runTest()} data-testid="db-test">
            测试连接
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={busy} onClick={() => void save()} data-testid="db-save">
            保存
          </Button>
        </div>
        )
      }
    >
      {step === 'pick' && <DbTypePicker onPick={pick} />}
      <div style={step === 'pick' ? { display: 'none' } : undefined}>
      {test && <Alert type={test.ok ? 'success' : 'error'} showIcon message={test.text} style={{ marginBottom: 12 }} data-testid="db-test-result" closable onClose={() => setTest(null)} />}
      <Form form={form} layout="vertical" requiredMark={false} initialValues={initialValues} preserve>
        <FormSection title="连接">
          <div className="skill-grid">
            <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请填写名称' }, { max: 100 }]} extra="Agent 和 @ 引用时显示这个名称">
              <Input placeholder="例如：订单库（生产）" data-testid="db-name" />
            </Form.Item>
            <Form.Item label="数据库">
              <div className="db-chosen" data-testid="db-type" data-type={type} data-flavor={product.id}>
                <DbProductIcon id={product.id} size={28} />
                <div className="db-chosen-text">
                  <span className="db-chosen-name">{product.label}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {product.engine === 'SQLITE' ? '本机文件' : `${product.engine === 'POSTGRES' ? 'PostgreSQL' : 'MySQL'} 协议`}
                  </Typography.Text>
                </div>
                <Button size="small" type="link" icon={<SwapOutlined />} onClick={() => setStep('pick')} data-testid="db-change-type">
                  更换
                </Button>
              </div>
              <Form.Item name="type" hidden>
                <Input />
              </Form.Item>
              <Form.Item name="flavor" hidden>
                <Input />
              </Form.Item>
            </Form.Item>
          </div>
          {type === 'SQLITE' ? (
            <Form.Item label="SQLite 文件" required extra="本机上的数据库文件（服务器上的 SQLite 请在终端里用 sqlite3 命令）">
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="filePath" noStyle rules={[{ required: true, whitespace: true, message: '请选择 SQLite 文件' }]}>
                  <Input placeholder="/Users/me/data/app.db" className="mono" data-testid="db-file" />
                </Form.Item>
                <Button
                  icon={<FolderOpenOutlined />}
                  onClick={async () => {
                    const p = await invoke('dialog.openFile', { title: '选择 SQLite 数据库文件', filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }, { name: '所有文件', extensions: ['*'] }] });
                    if (p) form.setFieldValue('filePath', p);
                  }}
                >
                  选择…
                </Button>
              </Space.Compact>
            </Form.Item>
          ) : (
            <>
              <div className="db-addr">
                <Form.Item name="host" label="地址" rules={[{ required: true, whitespace: true, message: '请填写地址' }]} extra="经过 SSH 主机时填从那台主机看到的地址（数据库就在那台主机上时填 127.0.0.1）">
                  <Input placeholder="10.0.3.21 或 db.internal" data-testid="db-host" />
                </Form.Item>
                <Form.Item name="port" label="端口" rules={[{ required: true, message: '请填写端口' }]}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} data-testid="db-port" />
                </Form.Item>
              </div>
              <div className="skill-grid">
                <Form.Item name="database" label="默认库" extra={type === 'POSTGRES' ? '不填时连接 postgres 库' : '可以不填（Agent 用 database 参数指定）'}>
                  <Input placeholder={type === 'POSTGRES' ? 'postgres' : '例如 shop'} data-testid="db-database" />
                </Form.Item>
                <Form.Item name="ssl" label="SSL">
                  <Select options={SSL_OPTIONS} />
                </Form.Item>
              </div>
              <Form.Item name="auth" label="账号">
                <Segmented
                  options={[
                    { value: 'password', label: '填写用户名和密码' },
                    { value: 'credential', label: '引用凭证' },
                  ]}
                  data-testid="db-auth"
                />
              </Form.Item>
              {auth === 'credential' ? (
                <div className="skill-grid">
                  <Form.Item name="credentialId" label="凭证" rules={[{ required: true, message: '请选择凭证' }]} extra="「数据库账号」或「密码」类型；凭证设置了禁止 AI 引用时 Agent 不能使用这个数据库">
                    <Select options={credOptions} placeholder="选择凭证" showSearch optionFilterProp="label" notFoundContent="还没有数据库账号类型的凭证（在凭证管理里添加）" data-testid="db-credential" />
                  </Form.Item>
                  <Form.Item name="username" label="用户名" extra="不填时用凭证里的用户名">
                    <Input autoComplete="off" />
                  </Form.Item>
                </div>
              ) : (
                <div className="skill-grid">
                  <Form.Item name="username" label="用户名" rules={[{ required: true, whitespace: true, message: '请填写用户名' }]}>
                    <Input autoComplete="off" data-testid="db-username" />
                  </Form.Item>
                  <Form.Item name="password" label="密码" extra={editing?.hasPassword ? '已保存密码，不修改请留空' : '用保险库密钥加密保存，Agent 拿不到明文'}>
                    <Input.Password autoComplete="new-password" placeholder={editing?.hasPassword ? '••••••（已保存）' : ''} data-testid="db-password" />
                  </Form.Item>
                </div>
              )}
              <Form.Item name="viaHostId" label="经过 SSH 主机" extra="数据库只能从内网访问时选择一台能连到它的 SSH 主机（沿用那台主机的跳板机和认证）；不选是直连">
                <Select allowClear placeholder="直连" options={hostOptions} showSearch optionFilterProp="label" data-testid="db-via" />
              </Form.Item>
            </>
          )}
        </FormSection>
        <FormSection title="Agent">
          <div className="skill-grid">
            <Form.Item name="agentPolicy" label="Agent 权限" extra="不带 WHERE 的 UPDATE / DELETE、DROP、TRUNCATE 等高危语句要输入数据库名确认（完全允许时可以取消）">
              <AgentPolicySelect inherit={{ label: `跟随全局默认（${policyLabel(globalPolicy)}）`, description: '使用「设置 → Agent 与审批」里的默认 Agent 权限' }} testId="db-agent-policy" />
            </Form.Item>
            <Form.Item name="production" label="生产环境" valuePropName="checked" extra="勾选后查询也要你批准，AI 审批不代批">
              <Checkbox data-testid="db-production">按生产环境处理</Checkbox>
            </Form.Item>
          </div>
          <Form.Item name="sqlDenylist" label="SQL 黑名单" extra="每行一个正则（不区分大小写），命中时 Agent 直接拒绝，例如 \bt_payment\b 不让 Agent 碰支付表">
            <Input.TextArea rows={2} className="mono" spellCheck={false} placeholder={'\\bt_payment\\b'} data-testid="db-denylist" />
          </Form.Item>
          <Form.Item name="note" label="说明（给 Agent 看）" style={{ marginBottom: 0 }}>
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={4000} placeholder="例如：订单主库，t_order 按月分表；大表查询必须带 create_time 条件" data-testid="db-note" />
          </Form.Item>
        </FormSection>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Agent 每次执行 SQL 都单独建立连接，只读查询在只读事务里执行；结果发给模型前按列名和内容脱敏。
        </Typography.Text>
      </Form>
      </div>
    </Modal>
  );
}

export const DbEditor = freshOnOpen(DbEditorDialog, (p) => p.target);
