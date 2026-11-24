import { useEffect, useState } from 'react';
import { Alert, App, Badge, Button, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { MCP_SERVER_TOOLS, type McpHostState, type McpPermission, type McpServerConfig, type McpServerInput, type McpServerStatus, type McpTransport } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { FormSection } from '../../components/FormSection';
import { SettingGroup, SettingRow, SettingsSection } from './parts';
import { freshOnOpen } from '../../util/fresh';

const PERMISSION_OPTIONS: { value: McpPermission; label: string }[] = [
  { value: 'AUTO', label: '自动' },
  { value: 'APPROVE', label: '需批准' },
  { value: 'DISABLED', label: '禁用' },
];

/** KEY=VALUE 每行一个 ⇄ 对象 */
const parseKv = (s: string): Record<string, string> =>
  Object.fromEntries(
    s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.search(/[=:]/);
        return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  );

interface FormValues {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  env: string;
  headers: string;
  defaultPermission: McpPermission;
  enabled: boolean;
}

/** 添加 / 编辑外部 MCP Server */
function McpServerEditorDialog({ target, onClose }: { target: McpServerConfig | 'new' | null; onClose(saved: boolean): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const transport = Form.useWatch('transport', form) ?? 'STDIO';
  const editing = target && target !== 'new' ? target : null;
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    // 只渲染当前传输方式的字段（stdio 没有请求头、HTTP 没有命令），没渲染的字段不会出现在结果里
    const v: Partial<FormValues> = await form.validateFields();
    const env = v.env ?? '';
    const headers = v.headers ?? '';
    const input: McpServerInput = {
      name: v.name ?? '',
      transport: v.transport ?? 'STDIO',
      command: v.command ?? null,
      args: (v.args ?? '').split('\n').map((a) => a.trim()).filter(Boolean),
      url: v.url ?? null,
      defaultPermission: v.defaultPermission ?? 'APPROVE',
      toolPolicies: editing?.toolPolicies,
      enabled: v.enabled ?? true,
      // 编辑时留空表示不修改已保存的值
      ...(env.trim() || !editing ? { env: parseKv(env) } : {}),
      ...(headers.trim() || !editing ? { headers: parseKv(headers) } : {}),
    };
    setSaving(true);
    try {
      await invoke('mcp.save', { id: editing?.id ?? null, input });
      onClose(true);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title={editing ? `编辑 MCP Server · ${editing.name}` : '添加 MCP Server'}
      width={640}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={() => onClose(false)}
      destroyOnHidden
      okButtonProps={{ 'data-testid': 'mcp-save' } as never}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        preserve={false}
        initialValues={
          editing
            ? { name: editing.name, transport: editing.transport, command: editing.command ?? '', args: editing.args.join('\n'), url: editing.url ?? '', env: '', headers: '', defaultPermission: editing.defaultPermission, enabled: editing.enabled }
            : { name: '', transport: 'STDIO', command: '', args: '', url: '', env: '', headers: '', defaultPermission: 'APPROVE', enabled: true }
        }
      >
        <FormSection title="连接">
          <div style={{ display: 'flex', gap: 8 }}>
            <Form.Item name="name" label="名称" style={{ flex: 1 }} rules={[{ required: true, message: '请填写名称' }]} extra="Agent 用这个名称调用，例如 github">
              <Input data-testid="mcp-name" />
            </Form.Item>
            <Form.Item name="transport" label="传输方式">
              <Segmented
                options={[
                  { value: 'STDIO', label: '本机命令（stdio）' },
                  { value: 'HTTP', label: 'HTTP' },
                  { value: 'SSE', label: 'SSE' },
                ]}
              />
            </Form.Item>
          </div>
          {transport === 'STDIO' ? (
            <>
              <Form.Item name="command" label="启动命令" rules={[{ required: true, message: '请填写启动命令' }]}>
                <Input className="mono" placeholder="例如 npx" data-testid="mcp-command" />
              </Form.Item>
              <Form.Item name="args" label="参数（每行一个）">
                <Input.TextArea rows={2} className="mono" placeholder={'-y\n@modelcontextprotocol/server-github'} data-testid="mcp-args" />
              </Form.Item>
              <Form.Item
                name="env"
                label="环境变量"
                extra={editing?.envKeys.length ? `已保存 ${editing.envKeys.join('、')}（加密）。留空表示不修改，填写后整体替换` : '每行一个 KEY=VALUE，例如令牌；加密保存在本机'}
              >
                <Input.TextArea rows={2} className="mono" placeholder="GITHUB_TOKEN=ghp_…" />
              </Form.Item>
            </>
          ) : (
            <>
              <Form.Item name="url" label="地址" rules={[{ required: true, message: '请填写地址' }]}>
                <Input className="mono" placeholder="https://example.com/mcp" data-testid="mcp-url" />
              </Form.Item>
              <Form.Item
                name="headers"
                label="请求头"
                extra={editing?.headerKeys.length ? `已保存 ${editing.headerKeys.join('、')}（加密）。留空表示不修改，填写后整体替换` : '每行一个 名称: 值，例如 Authorization: Bearer …；加密保存在本机'}
              >
                <Input.TextArea rows={2} className="mono" placeholder="Authorization: Bearer …" data-testid="mcp-headers" />
              </Form.Item>
            </>
          )}
        </FormSection>
        <FormSection title="权限">
          <div style={{ display: 'flex', gap: 16 }}>
            <Form.Item name="defaultPermission" label="工具的默认权限" extra="单个工具的权限在列表里「工具」中设置">
              <Segmented options={PERMISSION_OPTIONS} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>
        </FormSection>
      </Form>
    </Modal>
  );
}

const McpServerEditor = freshOnOpen(McpServerEditorDialog, (p) => p.target);

/** 一个 Server 的工具和权限 */
function ToolsModalDialog({ server, status, onClose }: { server: McpServerConfig | null; status: McpServerStatus | undefined; onClose(changed: boolean): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [policies, setPolicies] = useState<Record<string, McpPermission>>({});
  useEffect(() => setPolicies(server?.toolPolicies ?? {}), [server?.id]);
  const save = async (): Promise<void> => {
    if (!server) return;
    try {
      await invoke('mcp.save', {
        id: server.id,
        input: { name: server.name, transport: server.transport, command: server.command, args: server.args, url: server.url, defaultPermission: server.defaultPermission, toolPolicies: policies, enabled: server.enabled },
      });
      onClose(true);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  return (
    <Modal open={!!server} title={`工具 · ${server?.name ?? ''}`} width={720} okText="保存" cancelText="取消" onOk={() => void save()} onCancel={() => onClose(false)} destroyOnHidden>
      <Table
        size="small"
        rowKey="name"
        pagination={false}
        dataSource={status?.tools ?? []}
        locale={{ emptyText: status?.message ?? '还没有读取到工具，请先测试连接' }}
        columns={[
          { title: '工具', dataIndex: 'name', width: 180, render: (v: string) => <span className="mono">{v}</span> },
          { title: '说明', dataIndex: 'description', render: (v: string) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{v}</Typography.Text> },
          {
            title: '权限',
            key: 'p',
            width: 120,
            render: (_: unknown, t: { name: string }) => (
              <Select
                size="small"
                style={{ width: 100 }}
                value={policies[t.name] ?? server?.defaultPermission}
                options={PERMISSION_OPTIONS}
                onChange={(v: McpPermission) => setPolicies((p) => ({ ...p, [t.name]: v }))}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}

const ToolsModal = freshOnOpen(ToolsModalDialog, (p) => p.server);

/**
 * 设置 → MCP（文档一 6.8）：本机 MCP 服务（让外部 Agent 使用 iTerminal）、外部 MCP Server（给 iTerminal 的 Agent 用的工具）。
 */
export function McpSettings(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [host, setHost] = useState<McpHostState | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [status, setStatus] = useState<Record<string, McpServerStatus>>({});
  const [editing, setEditing] = useState<McpServerConfig | 'new' | null>(null);
  const [toolsOf, setToolsOf] = useState<McpServerConfig | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    const r = await invoke('mcp.list');
    setServers(r.servers);
    setStatus(Object.fromEntries(r.status.map((s) => [s.id, s])));
  };
  useEffect(() => {
    void invoke('mcp.host.get').then(setHost);
    void reload();
  }, []);

  const [port, setPort] = useState<number | null>(null);
  useEffect(() => setPort(host?.port ?? null), [host?.port]);
  const setHostOpt = async (o: { enabled?: boolean; port?: number; tools?: string[]; allowWrite?: boolean; allowDanger?: boolean }): Promise<void> => {
    try {
      await invoke('mcp.host.set', o);
    } catch (e) {
      message.error(errorMessage(e));
    }
    // 以主进程的当前状态为准（避免多个请求乱序返回时用了旧状态）
    setHost(await invoke('mcp.host.get'));
  };
  const commitPort = (): void => {
    if (port && port !== host?.port) void setHostOpt({ port });
  };
  const test = async (id: string): Promise<void> => {
    setTesting(id);
    try {
      const st = await invoke('mcp.test', { id });
      setStatus((s) => ({ ...s, [id]: st }));
      if (st.state === 'connected') message.success(`连接成功，${st.tools.length} 个工具`);
      else message.error(st.message ?? '连接失败');
    } finally {
      setTesting(null);
    }
  };
  const copy = (t: string): void => void navigator.clipboard.writeText(t).then(() => message.success('已复制'));
  const claudeCmd = host ? `claude mcp add --transport http iterminal ${host.url} --header "Authorization: Bearer ${host.token}"` : '';

  return (
    <SettingsSection title="MCP" description="MCP（Model Context Protocol）：让外部 Agent 使用 iTerminal 的主机和命令，也让 iTerminal 的 Agent 使用外部工具。">
      <SettingGroup title="本机 MCP 服务（给外部 Agent 用）">
        <SettingRow
          label={
            <Space size={8}>
              启用
              {host?.running && <Badge status="success" text={<Typography.Text type="secondary" style={{ fontSize: 12 }}>运行中</Typography.Text>} />}
            </Space>
          }
          description="Claude Code、Cursor 等外部 Agent 可以列出主机、执行命令、读写文件、运行 Skill、读写笔记和 Skill、检索知识库。外部 Agent 的调用不弹审批，按下面勾选的权限直接执行或拒绝；审计来源记为 MCP_EXTERNAL。只监听 127.0.0.1。"
        >
          <Switch checked={!!host?.enabled} onChange={(v) => void setHostOpt({ enabled: v })} data-testid="mcp-host-enabled" />
        </SettingRow>
        {host?.error && <Alert type="error" showIcon message={host.error} style={{ margin: '0 18px 12px' }} />}
        <SettingRow label="端口">
          <InputNumber min={1024} max={65535} value={port} onChange={(v) => setPort(v)} onBlur={commitPort} onPressEnter={commitPort} style={{ width: 120 }} data-testid="mcp-host-port" />
        </SettingRow>
        <SettingRow label="地址" description={<Typography.Text code className="selectable" data-testid="mcp-host-url">{host?.url}</Typography.Text>} />
        <SettingRow
          label="令牌"
          description={
            <>
              <Typography.Text code className="selectable mono">
                {host ? (showToken ? host.token : `${host.token.slice(0, 8)}••••••••••••`) : ''}
              </Typography.Text>
              {/* 第三十二轮：令牌一旦写进外部 Agent 的配置文件就是明文，本机上的程序（也包括 iTerminal 自己的 Agent）都能读到 */}
              <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
                下面的命令会把令牌明文写进外部 Agent 的配置文件（例如 ~/.claude.json）。本机上任何程序都能读到那个文件，拿到令牌就能按上面勾选的权限调用这些工具。不用时请关闭服务，或者重置令牌。
              </Typography.Text>
            </>
          }
        >
          <Space>
            <Tooltip title={showToken ? '隐藏' : '显示'}>
              <Button icon={showToken ? <EyeInvisibleOutlined /> : <EyeOutlined />} onClick={() => setShowToken((v) => !v)} />
            </Tooltip>
            <Button icon={<CopyOutlined />} onClick={() => host && copy(host.token)}>
              复制
            </Button>
            <Popconfirm title="重置令牌？" description="旧令牌立即失效，外部 Agent 需要更新配置" okText="重置" cancelText="取消" onConfirm={async () => setHost(await invoke('mcp.host.resetToken'))}>
              <Button icon={<ReloadOutlined />}>重置</Button>
            </Popconfirm>
          </Space>
        </SettingRow>
        <SettingRow
          label="权限"
          description="外部 Agent 的调用不需要审批。只读：只读和安全命令、读文件、查监控、读笔记和 Skill、检索知识库；允许写操作：再加上会修改服务器的命令（systemctl restart、mkdir、cp…）、写文件、新建 / 修改笔记和 Skill；允许高危指令：再加上 rm -rf、reboot、mkfs 等。超出权限的调用直接拒绝并告诉外部 Agent 原因；命令黑名单、主机的 Agent 权限、夜间禁止写操作仍然生效。"
          testId="mcp-host-perm"
        >
          {/* 第二十六轮：三档滑块——只读 / 允许写操作 / 允许高危指令（允许高危就包含写操作） */}
          <Segmented
            className="mcp-perm-slider"
            value={host?.allowDanger ? 'danger' : host?.allowWrite ? 'write' : 'read'}
            onChange={(v) => {
              if (v === 'read') return void setHostOpt({ allowWrite: false, allowDanger: false });
              if (v === 'write') return void setHostOpt({ allowWrite: true, allowDanger: false });
              modal.confirm({
                title: '允许外部 Agent 执行高危指令？',
                content: 'rm -rf、reboot、mkfs、修改关键系统文件等高危指令会直接执行，不再询问（同时允许写操作）。请只在信任外部 Agent 和它的使用者时开启，用完及时关闭。',
                okText: '允许',
                okButtonProps: { danger: true },
                cancelText: '取消',
                onOk: () => setHostOpt({ allowWrite: true, allowDanger: true }),
              });
            }}
            options={[
              { value: 'read', label: <span data-testid="mcp-perm-read">只读</span> },
              { value: 'write', label: <span data-testid="mcp-allow-write">允许写操作</span> },
              { value: 'danger', label: <span data-testid="mcp-allow-danger">允许高危指令</span> },
            ]}
            data-testid="mcp-perm"
          />
        </SettingRow>
        <SettingRow
          label="开放的工具"
          description="勾选的工具会被外部 Agent 发现和调用；没勾选的看不到也调不了。标着「写操作」的工具还要上面勾选了「允许写操作」才能执行。"
          block
          testId="mcp-host-tools"
        >
          <div className="mcp-tools">
            {MCP_SERVER_TOOLS.map((t) => {
              const on = !!host?.tools.includes(t.name);
              return (
                <label key={t.name} className={`mcp-tool ${on ? 'on' : ''}`} data-testid={`mcp-tool-${t.name}`}>
                  <Checkbox
                    checked={on}
                    onChange={(e) => {
                      const cur = host?.tools ?? [];
                      void setHostOpt({ tools: e.target.checked ? [...new Set([...cur, t.name])] : cur.filter((x) => x !== t.name) });
                    }}
                  />
                  <div className="mcp-tool-main">
                    <div className="mcp-tool-title">
                      {t.title} <Typography.Text code>{t.name}</Typography.Text>
                      <Tag bordered={false} color={t.kind === 'write' ? 'orange' : t.kind === 'mixed' ? 'blue' : 'green'}>
                        {t.kind === 'write' ? '写操作' : t.kind === 'mixed' ? '按权限' : '只读'}
                      </Tag>
                      {t.account && <Tag bordered={false}>登录后可用</Tag>}
                    </div>
                    <div className="mcp-tool-desc">{t.description}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow label="在 Claude Code 里添加" description={<Typography.Text code className="selectable mono" style={{ wordBreak: 'break-all' }}>{showToken ? claudeCmd : claudeCmd.replace(host?.token ?? '__', '<令牌>')}</Typography.Text>}>
          <Button icon={<CopyOutlined />} onClick={() => copy(claudeCmd)}>
            复制命令
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title="外部 MCP Server（给 iTerminal 的 Agent 用）"
        flush
        extra={
          <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')} data-testid="mcp-add">
            添加
          </Button>
        }
      >
        <Table<McpServerConfig>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={servers}
          locale={{ emptyText: '还没有 MCP Server。添加后在 AI 面板的引用里勾选，Agent 就能调用它的工具' }}
          columns={[
            { title: '名称', dataIndex: 'name', render: (v: string, s) => <span data-testid={`mcp-row-${v}`}>{v}{!s.enabled && <Tag style={{ marginLeft: 6 }}>停用</Tag>}</span> },
            { title: '方式', dataIndex: 'transport', width: 90, render: (v: McpTransport) => <Tag bordered={false}>{v === 'STDIO' ? 'stdio' : v}</Tag> },
            {
              title: '状态',
              key: 'st',
              width: 160,
              render: (_, s) => {
                const st = status[s.id];
                if (!st || st.state === 'idle') return <Badge status="default" text="未连接" />;
                if (st.state === 'connecting') return <Badge status="processing" text="连接中" />;
                if (st.state === 'error')
                  return (
                    <Tooltip title={st.message}>
                      <Badge status="error" text="出错" />
                    </Tooltip>
                  );
                return <Badge status="success" text={`${st.tools.length} 个工具`} data-testid={`mcp-tools-${s.name}`} />;
              },
            },
            { title: '默认权限', dataIndex: 'defaultPermission', width: 90, render: (v: McpPermission) => PERMISSION_OPTIONS.find((o) => o.value === v)?.label },
            {
              title: '',
              key: 'op',
              width: 200,
              render: (_, s) => (
                <Space size={2}>
                  <Button size="small" icon={<ApiOutlined />} loading={testing === s.id} onClick={() => void test(s.id)} data-testid={`mcp-test-${s.name}`}>
                    测试
                  </Button>
                  <Button size="small" onClick={() => setToolsOf(s)}>
                    工具
                  </Button>
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(s)} />
                  <Popconfirm
                    title={`删除「${s.name}」？`}
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={async () => {
                      await invoke('mcp.delete', { id: s.id });
                      await reload();
                    }}
                  >
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </SettingGroup>
      <McpServerEditor
        target={editing}
        onClose={(saved) => {
          setEditing(null);
          if (saved) void reload();
        }}
      />
      <ToolsModal
        server={toolsOf}
        status={toolsOf ? status[toolsOf.id] : undefined}
        onClose={(changed) => {
          setToolsOf(null);
          if (changed) void reload();
        }}
      />
    </SettingsSection>
  );
}
