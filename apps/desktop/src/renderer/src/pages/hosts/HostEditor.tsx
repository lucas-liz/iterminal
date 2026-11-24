import { AgentMemoryButton } from './AgentMemoryModal';
import { useEffect, useMemo, useState } from 'react';
import { Alert, App, AutoComplete, Button, Checkbox, Collapse, Form, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Tag, Tooltip, TreeSelect, Typography } from 'antd';
import { ApiOutlined, CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { DEFAULT_SERIAL, type ConnLogEntry, type SerialPortInfo, type AgentPolicy, type AuthMethod, type EffectiveHostPolicy, type FileTransferMode, type Host, type HostInput, type HostProtocol, type HostTestOutcome, type SerialOptions } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { folderOptions, useHosts } from '../../store/hosts';
import { useVault } from '../../store/vault';
import { policyLabel } from '../../util/policy';
import { AgentPolicySelect } from '../../components/AgentPolicyMenu';
import { FormSection } from '../../components/FormSection';
import { ConnLogList } from '../../components/ConnLog';
import { freshOnOpen } from '../../util/fresh';

export type { EditorTarget } from '../../store/hosts';
import type { EditorTarget } from '../../store/hosts';

interface FormValues {
  name: string;
  folderId: string | null;
  protocol: HostProtocol;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  credentialId: string | null;
  password: string;
  privateKey: string;
  passphrase: string;
  keepaliveSec: number;
  startupScript: string;
  note: string;
  jumpHostIds: string[];
  jumpInherit: boolean;
  tags: string[];
  favorite: boolean;
  encoding: string;
  termType: string;
  env: string;
  proxyType: 'NONE' | 'SOCKS5' | 'HTTP';
  proxyHost: string;
  proxyPort: number | null;
  proxyUser: string;
  proxyPassword: string;
  fileMode: FileTransferMode;
  ftpPort: number | null;
  recordSession: boolean;
  agentPolicy: AgentPolicy | '';
  cmdDenylist: string;
  aiMemory: string;
  serial: SerialOptions;
}

type TestState = { status: 'idle' } | { status: 'running'; log: ConnLogEntry[] } | { status: 'done'; outcome: HostTestOutcome };

/** 影响测试结果的字段 */
const CONN_FIELDS = new Set(['address', 'port', 'username', 'authMethod', 'password', 'privateKey', 'passphrase', 'credentialId', 'jumpHostIds', 'jumpInherit', 'proxyType', 'proxyHost', 'proxyPort', 'proxyUser', 'proxyPassword', 'protocol', 'folderId']);

/**
 * 「测试连接」旁边的结果（第十二轮）：测试中转圈；成功显示绿色「测试成功」和耗时；失败显示红色「测试失败」和原因（太长时省略，悬停看全文），
 * 后面跟「查看日志」。整行不换行，文字过长时只省略文字，按钮不会被挤走。
 */
function TestSummary({ test, onLog }: { test: Exclude<TestState, { status: 'idle' }>; onLog(): void }): React.JSX.Element {
  if (test.status === 'running')
    return (
      <span className="host-test-summary running" data-testid="host-test-result">
        <LoadingOutlined />
        <span className="host-test-text">测试中…</span>
      </span>
    );
  const o = test.outcome;
  return (
    <>
      <Tooltip title={o.ok ? [o.os, o.via.length ? `经 ${o.via.join(' → ')}` : ''].filter(Boolean).join('，') || undefined : o.error} placement="topLeft">
        <span className={`host-test-summary ${o.ok ? 'ok' : 'failed'}`} data-testid="host-test-result">
          {o.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          <span className="host-test-label">{o.ok ? '测试成功' : '测试失败'}</span>
          {o.ok ? (
            <>
              <span className="host-test-latency" data-testid="host-test-latency">
                {o.latencyMs} ms
              </span>
              {o.via.length > 0 && <span className="host-test-text">经 {o.via.join(' → ')}</span>}
            </>
          ) : (
            <span className="host-test-text" data-testid="host-test-error">
              {o.error}
            </span>
          )}
        </span>
      </Tooltip>
      <Button size="small" className="host-test-log-btn" onClick={onLog} data-testid="host-test-log-open">
        查看日志
      </Button>
    </>
  );
}

const AUTH_OPTIONS: Record<HostProtocol, { label: string; value: AuthMethod }[]> = {
  SSH: [
    { label: '密码', value: 'PASSWORD' },
    { label: '私钥', value: 'KEY' },
    { label: 'SSH Agent', value: 'AGENT' },
    { label: '每次询问', value: 'INTERACTIVE' },
    { label: '使用凭证', value: 'CREDENTIAL' },
  ],
  TELNET: [
    { label: '密码', value: 'PASSWORD' },
    { label: '每次询问', value: 'INTERACTIVE' },
    { label: '使用凭证', value: 'CREDENTIAL' },
  ],
  SERIAL: [],
};

const ENCODINGS = ['UTF-8', 'GBK', 'GB18030', 'BIG5', 'SHIFT_JIS', 'EUC-JP', 'EUC-KR', 'ISO-8859-1', 'WINDOWS-1252'];
const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DEFAULT_PORT: Record<HostProtocol, number> = { SSH: 22, TELNET: 23, SERIAL: 0 };

/** KEY=VALUE 每行一个 */
function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

function InheritHint({ eff, kind }: { eff: EffectiveHostPolicy | null; kind: 'credential' | 'jump' | 'policy' }): React.JSX.Element | null {
  const hosts = useHosts((s) => s.hosts);
  const credentials = useVault((s) => s.credentials);
  if (!eff) return null;
  if (kind === 'credential') {
    if (eff.credentialFrom?.kind !== 'folder') return <Typography.Text type="secondary">分组没有设置默认凭证，连接时会询问密码</Typography.Text>;
    const c = credentials.find((x) => x.id === eff.credentialId);
    return <Typography.Text type="secondary">{`将使用分组「${eff.credentialFrom.folderName}」的默认凭证：${c?.name ?? '（已删除）'}`}</Typography.Text>;
  }
  if (kind === 'jump') {
    if (eff.jumpFrom?.kind !== 'folder') return null;
    return <Typography.Text type="secondary">{`将经过分组「${eff.jumpFrom.folderName}」的默认跳板机：${eff.jumpHostIds.map((id) => hosts.find((h) => h.id === id)?.name ?? '（已删除）').join(' → ')}`}</Typography.Text>;
  }
  const from = eff.agentPolicyFrom.kind === 'global' ? '全局默认' : eff.agentPolicyFrom.kind === 'folder' ? `分组「${eff.agentPolicyFrom.folderName}」` : '这台主机';
  return (
    <Typography.Text type="secondary">
      {`有效权限：${policyLabel(eff.agentPolicy)}（来自${from}）${eff.production ? '；生产环境分组：写操作至少需要审批' : ''}`}
    </Typography.Text>
  );
}

/**
 * 主机编辑框。每次打开（新建 / 编辑某台主机）都用一个全新的表单：
 * 同一个表单实例重复使用时，antd 会把这次的初值和上次留下的值合并（上次的值优先），
 * 没显示出来的字段（代理、串口、跳板机等）也会残留——新建时会带出上一台主机的数据、编辑时会串数据。
 */
function HostEditorDialog({ target, onClose }: { target: EditorTarget | null; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const folders = useHosts((s) => s.folders);
  const allHosts = useHosts((s) => s.hosts);
  const reload = useHosts((s) => s.reload);
  const credentials = useVault((s) => s.credentials);
  const [form] = Form.useForm<FormValues>();
  const protocol = Form.useWatch('protocol', form) ?? 'SSH';
  const authMethod = Form.useWatch('authMethod', form);
  const folderId = Form.useWatch('folderId', form);
  const proxyType = Form.useWatch('proxyType', form);
  const fileMode = Form.useWatch('fileMode', form);
  const favorite = Form.useWatch('favorite', form);
  const [saving, setSaving] = useState(false);
  const [serialPorts, setSerialPorts] = useState<SerialPortInfo[]>([]);
  /** 编辑时是否清除已保存的秘密 */
  const [clear, setClear] = useState({ password: false, key: false, proxy: false });
  const [test, setTest] = useState<TestState>({ status: 'idle' });
  const [showLog, setShowLog] = useState(false);
  const [eff, setEff] = useState<EffectiveHostPolicy | null>(null);
  const [tagOptions, setTagOptions] = useState<string[]>([]);
  const editing = target?.mode === 'edit' ? target.host : null;
  const treeData = useMemo(() => folderOptions(folders), [folders]);

  useEffect(() => {
    setClear({ password: false, key: false, proxy: false });
    setTest({ status: 'idle' });
    if (target) void invoke('tag.list').then((t) => setTagOptions(t.map((x) => x.name)));
  }, [target]);

  // 分组变化时刷新继承来的配置（按编辑前保存的主机设置计算，新建时只看分组）
  useEffect(() => {
    if (!target) return;
    const t = setTimeout(() => {
      invoke('host.effective', { id: editing && editing.folderId === (folderId ?? null) ? editing.id : null, folderId: folderId ?? null })
        .then(setEff)
        .catch(() => setEff(null));
    }, 100);
    return () => clearTimeout(t);
  }, [target, folderId]);

  /** 可选的跳板机：除自己以外的 SSH 主机 */
  const jumpOptions = useMemo(
    () =>
      allHosts
        .filter((h) => h.id !== editing?.id && h.protocol === 'SSH')
        .map((h) => ({ value: h.id, label: `${h.name}（${h.username}@${h.address}${h.port === 22 ? '' : `:${h.port}`}）` })),
    [allHosts, editing?.id],
  );
  const credentialOptions = useMemo(
    () => [
      { value: '', label: '继承分组的默认凭证' },
      ...credentials
        .filter((c) => !c.ownerHostId && (c.type === 'PASSWORD' || c.type === 'SSH_KEY' || c.type === 'DB'))
        .map((c) => ({ value: c.id, label: `${c.name}${c.username ? `（${c.username}）` : ''}` })),
    ],
    [credentials],
  );

  /** 弹窗每次打开都重新挂载表单（destroyOnHidden），初值通过 initialValues 传入 */
  const initialValues = useMemo((): Partial<FormValues> | undefined => {
    if (!target) return undefined;
    const h = target.mode === 'edit' ? target.host : null;
    return {
      name: h?.name ?? '',
      folderId: h ? h.folderId : target.mode === 'create' ? target.folderId : null,
      protocol: h?.protocol ?? 'SSH',
      address: h?.address ?? '',
      port: h?.port ?? 22,
      username: h?.username ?? 'root',
      authMethod: h?.authMethod ?? 'PASSWORD',
      credentialId: h?.credentialId ?? null,
      password: '',
      privateKey: '',
      passphrase: '',
      keepaliveSec: h?.keepaliveSec ?? 30,
      startupScript: h?.startupScript ?? '',
      note: h?.note ?? '',
      jumpHostIds: h?.jumpHostIds ?? [],
      jumpInherit: h?.jumpInherit ?? true,
      tags: h?.tags ?? [],
      favorite: h?.favorite ?? false,
      encoding: h?.encoding ?? 'UTF-8',
      termType: h?.termType ?? 'xterm-256color',
      env: Object.entries(h?.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      proxyType: h?.proxy?.type ?? 'NONE',
      proxyHost: h?.proxy?.host ?? '',
      proxyPort: h?.proxy?.port ?? null,
      proxyUser: h?.proxy?.username ?? '',
      proxyPassword: '',
      fileMode: h?.fileTransfer?.mode ?? 'AUTO',
      ftpPort: h?.fileTransfer?.ftpPort ?? 21,
      recordSession: h?.recordSession ?? true,
      agentPolicy: h?.agentPolicy ?? '',
      cmdDenylist: (h?.cmdDenylist ?? []).join('\n'),
      aiMemory: h?.aiMemory ?? '',
      serial: h?.serial ?? DEFAULT_SERIAL,
    };
  }, [target]);

  /** 编辑时：留空 = 不修改（undefined），点了清除 = null */
  const secret = (value: string, cleared: boolean): string | null | undefined => {
    if (value) return value;
    if (!editing) return null;
    return cleared ? null : undefined;
  };

  /** 校验表单并组装提交内容；校验失败返回 null（提示已经显示在表单上） */
  const collect = async (): Promise<HostInput | null> => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return null;
    }
    const isSerial = v.protocol === 'SERIAL';
    return {
      folderId: v.folderId ?? null,
      name: v.name,
      protocol: v.protocol,
      address: v.address,
      port: isSerial ? 0 : v.port,
      username: v.username ?? '',
      authMethod: isSerial ? 'INTERACTIVE' : v.authMethod,
      credentialId: v.authMethod === 'CREDENTIAL' ? v.credentialId || null : null,
      keepaliveSec: v.keepaliveSec,
      startupScript: v.startupScript || null,
      note: v.note || null,
      password: v.authMethod === 'PASSWORD' ? secret(v.password, clear.password) : undefined,
      privateKey: v.authMethod === 'KEY' ? secret(v.privateKey, clear.key) : undefined,
      passphrase: v.authMethod === 'KEY' ? secret(v.passphrase, clear.key) : undefined,
      jumpHostIds: isSerial ? [] : (v.jumpHostIds ?? []),
      jumpInherit: v.jumpInherit,
      tags: v.tags ?? [],
      favorite: !!v.favorite,
      encoding: v.encoding,
      termType: v.termType,
      env: parseEnv(v.env ?? ''),
      proxy: v.proxyType === 'NONE' || isSerial ? null : { type: v.proxyType, host: v.proxyHost, port: v.proxyPort ?? 1080, username: v.proxyUser || null },
      proxyPassword: v.proxyType === 'NONE' ? undefined : secret(v.proxyPassword, clear.proxy),
      fileTransfer: isSerial ? null : { mode: v.fileMode ?? 'AUTO', ftpPort: v.ftpPort ?? 21 },
      recordSession: v.recordSession,
      agentPolicy: v.agentPolicy || null,
      cmdDenylist: (v.cmdDenylist ?? '').split('\n').map((x) => x.trim()).filter(Boolean),
      aiMemory: v.aiMemory || null,
      serial: isSerial ? v.serial : null,
    };
  };

  /** 测试连接：直接打开日志框，边测边显示日志；测完在按钮旁边显示结果 */
  const runTest = async (): Promise<void> => {
    const input = await collect();
    if (!input) return;
    const testId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setTest({ status: 'running', log: [] });
    setShowLog(true);
    const off = window.itm.on('host.testLog', (e) => {
      if (e.testId === testId) setTest((t) => (t.status === 'running' ? { ...t, log: [...t.log, e.entry] } : t));
    });
    try {
      const outcome = await invoke('host.test', { id: editing?.id ?? null, input, testId });
      setTest({ status: 'done', outcome });
      // 主机列表的延迟列也用这次的耗时（经跳板机的主机只能这样得到）
      if (outcome.ok && editing) useHosts.getState().setLatency(editing.id, outcome.latencyMs);
    } catch (e) {
      setTest({ status: 'done', outcome: { ok: false, error: errorMessage(e), log: [] } });
    } finally {
      off();
    }
  };

  const save = async (): Promise<void> => {
    const input = await collect();
    if (!input) return;
    setSaving(true);
    try {
      if (editing) {
        await invoke('host.update', { id: editing.id, input });
        message.success('已保存');
      } else {
        await invoke('host.create', input);
        message.success('主机已添加');
      }
      await reload();
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const importKeyFile = async (file: File): Promise<void> => {
    if (file.size > 64 * 1024) {
      message.error('文件太大，不像是私钥');
      return;
    }
    form.setFieldValue('privateKey', await file.text());
  };

  const savedPassword = editing?.hasPassword && !clear.password;
  const savedKey = editing?.hasPrivateKey && !clear.key;
  const savedProxy = editing?.proxy?.hasPassword && !clear.proxy;
  const isSerial = protocol === 'SERIAL';
  // 团队主机：管理员在服务端维护，这里只能查看和测试连接
  const team = editing?.team ?? null;

  return (
    <Modal
      open={!!target}
      title={
        <Space>
          <span>{editing ? `${team ? '查看主机' : '编辑主机'} · ${editing.name}` : '新建主机'}</span>
          {team && (
            <Tag color="purple" bordered={false}>
              团队 · 只读
            </Tag>
          )}
          <Button
            type="text"
            size="small"
            icon={favorite ? <StarFilled style={{ color: '#fadb14' }} /> : <StarOutlined />}
            onClick={() => form.setFieldValue('favorite', !favorite)}
            data-testid="host-favorite"
          />
        </Space>
      }
      width={620}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={false}
      // 从凭证管理的「查看使用凭证的主机」里打开时要盖在列表上面（第二十六轮）
      zIndex={1500}
      footer={
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {protocol === 'SSH' && (
            <div className="host-test-bar">
              <Button icon={<ApiOutlined />} disabled={test.status === 'running'} onClick={() => void runTest()} data-testid="host-test" className="host-test-btn">
                测试连接
              </Button>
              {test.status !== 'idle' && <TestSummary test={test} onLog={() => setShowLog(true)} />}
            </div>
          )}
          <Space style={{ marginLeft: 'auto', flex: 'none' }}>
            <Button onClick={onClose}>{team ? '关闭' : '取消'}</Button>
            {!team && (
              <Button type="primary" loading={saving} onClick={() => void save()} data-testid="host-save">
                保存
              </Button>
            )}
          </Space>
        </div>
      }
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        preserve={false}
        initialValues={initialValues}
        disabled={!!team}
        data-testid="host-form"
        onValuesChange={(changed: Partial<FormValues>) => {
          // 改了连接相关的字段，之前的测试结果作废（文档一 6.15.2）
          if (test.status === 'done' && Object.keys(changed).some((k) => CONN_FIELDS.has(k))) setTest({ status: 'idle' });
          if (changed.protocol) {
            form.setFieldValue('port', DEFAULT_PORT[changed.protocol]);
            const allowed = AUTH_OPTIONS[changed.protocol].map((o) => o.value);
            if (allowed.length && !allowed.includes(form.getFieldValue('authMethod'))) form.setFieldValue('authMethod', 'PASSWORD');
          }
        }}
      >
        {team && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            data-testid="team-host-readonly"
            message={`这是团队主机，由管理员在服务端维护，这里只能查看和测试连接${team.allowReveal ? '' : '；管理员没有允许查看密码'}。`}
          />
        )}
        <Form.Item name="favorite" hidden valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <FormSection title="基本信息">
          <Form.Item name="protocol" label="协议">
            <Segmented
              options={[
                { label: 'SSH', value: 'SSH' },
                { label: 'Telnet', value: 'TELNET' },
                { label: '串口', value: 'SERIAL' },
              ]}
              data-testid="host-protocol"
            />
          </Form.Item>
          <div style={{ display: 'flex', gap: 8 }}>
            <Form.Item name="name" label="名称" style={{ flex: 1 }} extra="留空时使用地址">
              <Input placeholder="例如：订单服务-01" data-testid="host-name" />
            </Form.Item>
            <Form.Item name="folderId" label="分组" style={{ flex: 1 }}>
              <TreeSelect allowClear placeholder="不分组" treeData={treeData} treeDefaultExpandAll />
            </Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Form.Item
              name="address"
              label={isSerial ? '串口' : '地址'}
              style={{ flex: 1 }}
              rules={[{ required: true, whitespace: true, message: isSerial ? '请填写串口' : '请填写主机地址' }]}
            >
              {isSerial ? (
                <AutoComplete
                  options={serialPorts.map((p) => ({ value: p.path, label: `${p.path}${p.manufacturer ? `（${p.manufacturer}）` : ''}` }))}
                  onFocus={() => void invoke('serial.list').then(setSerialPorts).catch(() => undefined)}
                  placeholder={window.itm.platform === 'win32' ? 'COM3' : '/dev/ttyUSB0'}
                  data-testid="host-address"
                />
              ) : (
                <Input placeholder="IP 或域名" data-testid="host-address" />
              )}
            </Form.Item>
            {!isSerial && (
              <Form.Item name="port" label="端口" style={{ width: 110 }} rules={[{ required: true, message: '请填写端口' }]}>
                <InputNumber min={1} max={65535} style={{ width: '100%' }} data-testid="host-port" />
              </Form.Item>
            )}
          </div>

          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="例如 prod、web" options={tagOptions.map((t) => ({ value: t, label: t }))} tokenSeparators={[',', '，', ' ']} data-testid="host-tags" />
          </Form.Item>
          <Form.Item name="note" label="备注" style={{ marginBottom: 12 }} extra="主机列表的「备注」列显示，搜索时也会匹配">
            <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} maxLength={500} placeholder="描述这台主机的用途，例如：订单服务主库，业务高峰 9:00-11:00 不要重启" data-testid="host-note" />
          </Form.Item>
        </FormSection>

        {isSerial && (
          <FormSection title="串口参数">
            <div className="form-grid">
              <Form.Item name={['serial', 'baudRate']} label="波特率">
                <AutoComplete options={BAUD_RATES.map((b) => ({ value: String(b) }))} onChange={(v) => form.setFieldValue(['serial', 'baudRate'], Number(v) || v)} />
              </Form.Item>
              <Form.Item name={['serial', 'dataBits']} label="数据位">
                <Select options={[5, 6, 7, 8].map((v) => ({ value: v, label: String(v) }))} />
              </Form.Item>
              <Form.Item name={['serial', 'parity']} label="校验">
                <Select options={[{ value: 'none', label: '无' }, { value: 'even', label: '偶' }, { value: 'odd', label: '奇' }, { value: 'mark', label: 'Mark' }, { value: 'space', label: 'Space' }]} />
              </Form.Item>
              <Form.Item name={['serial', 'stopBits']} label="停止位">
                <Select options={[1, 1.5, 2].map((v) => ({ value: v, label: String(v) }))} />
              </Form.Item>
              <Form.Item name={['serial', 'flowControl']} label="流控">
                <Select options={[{ value: 'none', label: '无' }, { value: 'hardware', label: '硬件（RTS/CTS）' }, { value: 'software', label: '软件（XON/XOFF）' }]} />
              </Form.Item>
              <Form.Item name={['serial', 'eol']} label="回车发送">
                <Select options={[{ value: 'CR', label: 'CR (\\r)' }, { value: 'LF', label: 'LF (\\n)' }, { value: 'CRLF', label: 'CRLF' }]} />
              </Form.Item>
              <Form.Item name={['serial', 'localEcho']} label="本地回显" valuePropName="checked">
                <Switch />
              </Form.Item>
            </div>
          </FormSection>
        )}

        {!isSerial && (
          <>
            <FormSection title="认证">
              <Form.Item name="authMethod" label="认证方式">
                <Segmented options={AUTH_OPTIONS[protocol]} data-testid="host-auth" />
              </Form.Item>
              <Form.Item
                name="username"
                label="用户名"
                rules={protocol === 'SSH' && authMethod !== 'CREDENTIAL' ? [{ required: true, whitespace: true, message: '请填写用户名' }] : undefined}
                extra={authMethod === 'CREDENTIAL' ? '留空时使用凭证里的用户名' : protocol === 'TELNET' ? '设备出现 login: 提示时自动输入' : undefined}
              >
                <Input data-testid="host-username" />
              </Form.Item>

              {authMethod === 'CREDENTIAL' && (
                <Form.Item
                  name="credentialId"
                  label="凭证"
                  extra={!form.getFieldValue('credentialId') ? <InheritHint eff={eff} kind="credential" /> : '凭证在「凭证」页统一管理，多台主机可以共用'}
                  getValueProps={(v) => ({ value: v ?? '' })}
                  normalize={(v: string) => v || null}
                >
                  <Select options={credentialOptions} showSearch optionFilterProp="label" data-testid="host-credential" />
                </Form.Item>
              )}

              {authMethod === 'PASSWORD' && (
                <Form.Item
                  name="password"
                  label="密码"
                  extra={
                    savedPassword ? (
                      <Space size={4}>
                        <span>已保存密码，留空表示不修改。</span>
                        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setClear((c) => ({ ...c, password: true }))}>
                          清除已保存的密码
                        </Button>
                      </Space>
                    ) : (
                      '密码加密保存在本机；不填则连接时询问'
                    )
                  }
                >
                  <Input.Password placeholder={savedPassword ? '••••••••' : ''} autoComplete="new-password" data-testid="host-password" />
                </Form.Item>
              )}

              {authMethod === 'KEY' && (
                <>
                  <Form.Item
                    name="privateKey"
                    label={
                      <Space>
                        <span>私钥</span>
                        <label style={{ cursor: 'pointer' }}>
                          <Typography.Link>从文件导入…</Typography.Link>
                          <input
                            type="file"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void importKeyFile(f);
                              e.target.value = '';
                            }}
                          />
                        </label>
                      </Space>
                    }
                    extra={
                      savedKey ? (
                        <Space size={4}>
                          <span>已保存私钥，留空表示不修改。</span>
                          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setClear((c) => ({ ...c, key: true }))}>
                            清除已保存的私钥
                          </Button>
                        </Space>
                      ) : (
                        '支持 OpenSSH / PEM 格式（例如 ~/.ssh/id_ed25519），加密保存在本机。多台主机共用的私钥建议保存为凭证'
                      )
                    }
                  >
                    <Input.TextArea rows={4} className="mono" placeholder={savedKey ? '（已保存）' : '-----BEGIN OPENSSH PRIVATE KEY-----'} spellCheck={false} />
                  </Form.Item>
                  <Form.Item name="passphrase" label="私钥口令" extra="私钥没有加密时留空；加密私钥不填则连接时询问">
                    <Input.Password placeholder={savedKey ? '（不修改）' : ''} autoComplete="new-password" />
                  </Form.Item>
                </>
              )}

              {authMethod === 'AGENT' && (
                <Typography.Paragraph type="secondary">
                  使用本机的 ssh-agent（macOS / Linux 读取 SSH_AUTH_SOCK，Windows 使用 OpenSSH Agent 服务），不在 iTerminal 里保存任何秘密。
                </Typography.Paragraph>
              )}
              {authMethod === 'INTERACTIVE' && (
                <Typography.Paragraph type="secondary">每次连接时输入密码，可以在输入框里选择「记住密码」。</Typography.Paragraph>
              )}
            </FormSection>

            <FormSection title="连接路径">
              <Form.Item
                name="jumpHostIds"
                label="跳板机"
                extra="可以选多个，按选择顺序依次跳转：本机 → 第 1 个 → 第 2 个 → … → 这台主机。每一跳使用各自保存的认证方式。"
              >
                <Select mode="multiple" allowClear placeholder="不使用跳板机（直连）" options={jumpOptions} optionFilterProp="label" maxCount={5} data-testid="host-jumps" />
              </Form.Item>
              <Form.Item name="jumpInherit" valuePropName="checked" style={{ marginTop: -12 }} extra={<InheritHint eff={eff} kind="jump" />}>
                <Checkbox>没有选择跳板机时，使用分组的默认跳板机</Checkbox>
              </Form.Item>
            </FormSection>
          </>
        )}

        <Collapse
          className="form-collapse"
          size="small"
          items={[
            {
              key: 'adv',
              label: '高级：心跳、编码、登录脚本、代理、文件传输、录像',
              forceRender: true,
              children: (
                <>
                  {!isSerial && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Form.Item name="keepaliveSec" label="心跳间隔（秒）" extra="0 表示不发送心跳">
                        <InputNumber min={0} max={3600} style={{ width: 140 }} />
                      </Form.Item>
                      <Form.Item name="encoding" label="字符编码">
                        <Select style={{ width: 140 }} options={ENCODINGS.map((e) => ({ value: e, label: e }))} />
                      </Form.Item>
                      <Form.Item name="termType" label="终端类型">
                        <AutoComplete style={{ width: 160 }} options={['xterm-256color', 'xterm', 'vt100', 'linux'].map((v) => ({ value: v }))} />
                      </Form.Item>
                    </div>
                  )}
                  <Form.Item name="startupScript" label="登录后执行">
                    <Input.TextArea rows={2} className="mono" placeholder="例如：cd /data/app && source .env" />
                  </Form.Item>
                  {protocol === 'SSH' && (
                    <Form.Item name="env" label="环境变量" extra="每行一个 KEY=VALUE（需要服务器 sshd 的 AcceptEnv 允许）">
                      <Input.TextArea rows={2} className="mono" placeholder="LANG=zh_CN.UTF-8" />
                    </Form.Item>
                  )}
                  {!isSerial && (
                    <>
                      <Form.Item name="proxyType" label="代理" extra="只用于直连的第一跳；使用跳板机时由跳板机负责转发">
                        <Segmented options={[{ label: '不使用', value: 'NONE' }, { label: 'SOCKS5', value: 'SOCKS5' }, { label: 'HTTP', value: 'HTTP' }]} />
                      </Form.Item>
                      {proxyType && proxyType !== 'NONE' && (
                        <div className="form-grid">
                          <Form.Item name="proxyHost" label="代理地址" rules={[{ required: true, whitespace: true, message: '请填写代理地址' }]}>
                            <Input />
                          </Form.Item>
                          <Form.Item name="proxyPort" label="端口" rules={[{ required: true, message: '请填写端口' }]}>
                            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                          </Form.Item>
                          <Form.Item name="proxyUser" label="用户名">
                            <Input />
                          </Form.Item>
                          <Form.Item
                            name="proxyPassword"
                            label="密码"
                            extra={savedProxy ? <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setClear((c) => ({ ...c, proxy: true }))}>清除已保存的代理密码</Button> : undefined}
                          >
                            <Input.Password placeholder={savedProxy ? '••••••••' : ''} autoComplete="new-password" />
                          </Form.Item>
                        </div>
                      )}
                    </>
                  )}
                  {protocol === 'SSH' && (
                    <div className="form-grid">
                      <Form.Item
                        name="fileMode"
                        label="文件传输方式"
                        extra="文件面板、SFTP 标签、上传下载、AI 的文件工具使用。自动：先用 SFTP；服务器没有 sftp-server 时用 SSH 命令通道（stat / cat，终端能连就能用）；还不行再用同样的用户名密码连 FTP（先尝试加密）"
                        style={{ gridColumn: '1 / -1' }}
                      >
                        <Segmented
                          options={[
                            { label: '自动', value: 'AUTO' },
                            { label: 'SFTP', value: 'SFTP' },
                            { label: 'SSH 命令', value: 'SHELL' },
                            { label: 'FTP', value: 'FTP' },
                            { label: 'FTPS', value: 'FTPS' },
                          ]}
                          data-testid="host-file-mode"
                        />
                      </Form.Item>
                      {(fileMode === 'AUTO' || fileMode === 'FTP' || fileMode === 'FTPS') && (
                        <Form.Item name="ftpPort" label="FTP 端口">
                          <InputNumber min={1} max={65535} style={{ width: '100%' }} data-testid="host-ftp-port" />
                        </Form.Item>
                      )}
                    </div>
                  )}
                  {protocol === 'SSH' && (
                    <Form.Item
                      name="monitorScript"
                      label="自定义监控采集脚本"
                      extra="内置监控只支持 Linux。交换机、AIX 等设备可以填一条命令，每 5 秒执行一次，输出 cpu=12.5、mem=63、load=0.1 0.2 0.3、disk./=71 这样的行（每行一个指标）"
                    >
                      <Input.TextArea rows={3} className="mono" spellCheck={false} placeholder={'echo cpu=$(…); echo mem=$(…); echo disk./=$(df -P / | awk \'NR==2{print $5+0}\')'} data-testid="host-monitor-script" />
                    </Form.Item>
                  )}
                  <Form.Item name="recordSession" label="会话录像" valuePropName="checked" extra="保存终端输出的录像（asciicast），可以在审计里回放">
                    <Switch />
                  </Form.Item>
                </>
              ),
            },
            {
              key: 'ai',
              label: 'AI：Agent 权限、命令黑名单、主机记忆',
              forceRender: true,
              children: (
                <>
                  <Form.Item name="agentPolicy" label="Agent 权限" extra={<InheritHint eff={eff} kind="policy" />}>
                    <AgentPolicySelect inherit={{ label: '继承分组', description: '使用所在分组的 Agent 权限，没有分组设置时使用「设置 → Agent 与审批」里的默认权限' }} testId="host-agent-policy" />
                  </Form.Item>
                  <Form.Item name="cmdDenylist" label="命令黑名单" extra="每行一个正则，命中时 Agent 直接拒绝执行，例如 ^systemctl\s+restart\s+mysql">
                    <Input.TextArea rows={2} className="mono" />
                  </Form.Item>
                  <Form.Item
                    name="aiMemory"
                    label={
                      <span className="host-mem-label">
                        主机记忆（手工填写）
                        {editing && <AgentMemoryButton hostId={editing.id} />}
                      </span>
                    }
                    extra="Agent 引用这台主机时会看到（发给模型前同样脱敏）；Agent 自己记下的在「Agent 记忆」里"
                  >
                    <Input.TextArea rows={3} maxLength={8000} placeholder="例如：MySQL 主库，从库是 db-02；业务高峰 9:00-11:00" />
                  </Form.Item>
                </>
              ),
            },
          ]}
        />
      </Form>
      <Modal
        open={showLog && test.status !== 'idle'}
        title="SSH 测试连接"
        width={680}
        footer={null}
        onCancel={() => setShowLog(false)}
        destroyOnHidden
      >
        {test.status !== 'idle' && (
          <div data-testid="host-test-log" className="host-test-log">
            <div className={`host-test-head ${test.status === 'running' ? 'running' : test.outcome.ok ? 'ok' : 'failed'}`} data-testid="host-test-log-status">
              {test.status === 'running' ? (
                <>
                  <LoadingOutlined /> 正在测试连接…
                </>
              ) : test.outcome.ok ? (
                <>
                  <CheckCircleOutlined /> 测试成功，用时 {test.outcome.latencyMs} ms{test.outcome.os ? ` · ${test.outcome.os}` : ''}
                </>
              ) : (
                <>
                  <CloseCircleOutlined /> 测试失败：{test.outcome.error}
                </>
              )}
            </div>
            <ConnLogList entries={test.status === 'running' ? test.log : test.outcome.log} showTime maxHeight={420} autoScroll={test.status === 'running'} />
          </div>
        )}
      </Modal>
    </Modal>
  );
}

/** 每次打开（新建 / 编辑某台主机）都重新挂载，见 util/fresh */
export const HostEditor = freshOnOpen(HostEditorDialog, (p) => p.target);
