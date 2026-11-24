import { useEffect, useState } from 'react';
import { App, Button, Form, Input, InputNumber, Modal, Segmented, Select, Space, Tabs, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { dump, JSON_SCHEMA, load } from 'js-yaml';
import { errorMessage, invoke } from '../../api';
import { useAgent } from '../../store/agent';
import { freshOnOpen } from '../../util/fresh';

interface ParamRow {
  name: string;
  type: 'string' | 'number' | 'boolean';
  default?: string;
  description?: string;
}

interface SkillForm {
  name: string;
  title: string;
  description: string;
  risk: 'readonly' | 'write-needs-approval' | 'dangerous';
  mode: 'single' | 'parallel';
  concurrency: number;
  triggers: string[];
  tools: string[];
  params: ParamRow[];
  body: string;
}

const TOOLS = [
  { value: 'run_command', label: 'run_command（执行命令）' },
  { value: 'ssh_exec_batch', label: 'ssh_exec_batch（批量执行）' },
  { value: 'get_metrics', label: 'get_metrics（读取监控）' },
  { value: 'host_list', label: 'host_list（主机列表）' },
  { value: 'read_terminal', label: 'read_terminal（读取终端）' },
  { value: 'sftp_list', label: 'sftp_list（列出目录）' },
  { value: 'sftp_read', label: 'sftp_read（读取文件）' },
  { value: 'sftp_write', label: 'sftp_write（写入文件）' },
  { value: 'file_upload', label: 'file_upload（上传文件）' },
  { value: 'file_download', label: 'file_download（下载文件）' },
  { value: 'kb_search', label: 'kb_search（知识库）' },
  { value: 'serial_send', label: 'serial_send（串口发送）' },
  { value: 'mcp_call', label: 'mcp_call（MCP 工具）' },
  { value: 'ask_user', label: 'ask_user（向用户提问）' },
];

const TEMPLATE = `# 标题

## 步骤
1. 先用只读命令确认现状（例如 systemctl status、df -h）；
2. 说明要做的修改和原因，再执行；
3. 执行后验证结果。

## 输出
列出每台主机的结果、发现的问题和建议。参数可以这样引用：{{param_name}}
`;

const EMPTY: SkillForm = { name: '', title: '', description: '', risk: 'readonly', mode: 'single', concurrency: 4, triggers: [], tools: [], params: [], body: TEMPLATE };

/** 表单 → SKILL.md（front matter 用 YAML） */
function toSource(f: SkillForm): string {
  const meta: Record<string, unknown> = {
    name: f.name.trim(),
    title: f.title.trim() || undefined,
    description: f.description.trim(),
    risk: f.risk,
    mode: f.mode,
    ...(f.mode === 'parallel' ? { concurrency: f.concurrency } : {}),
    ...(f.triggers.length ? { triggers: f.triggers } : {}),
    ...(f.tools.length ? { 'allowed-tools': f.tools } : {}),
    ...(f.params.length
      ? {
          params: f.params
            .filter((p) => p?.name?.trim())
            .map((p) => ({
              name: p.name.trim(),
              type: p.type ?? 'string',
              ...(p.default !== undefined && p.default !== '' ? { default: p.type === 'number' ? Number(p.default) : p.type === 'boolean' ? p.default === 'true' : p.default } : {}),
              ...(p.description ? { description: p.description } : {}),
            })),
        }
      : {}),
  };
  Object.keys(meta).forEach((k) => meta[k] === undefined && delete meta[k]);
  return `---\n${dump(meta, { schema: JSON_SCHEMA, lineWidth: 200 }).trimEnd()}\n---\n${f.body.replace(/^\n+/, '')}`;
}

/** SKILL.md → 表单（front matter 解析失败时抛错，留在源码页） */
function toForm(src: string): SkillForm {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/.exec(src);
  if (!m) throw new Error('开头需要用 --- 包起来的 front matter');
  const meta = (load(m[1], { schema: JSON_SCHEMA }) ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);
  return {
    name: String(meta.name ?? ''),
    title: String(meta.title ?? ''),
    description: String(meta.description ?? ''),
    risk: meta.risk === 'write-needs-approval' || meta.risk === 'dangerous' ? meta.risk : 'readonly',
    mode: meta.mode === 'parallel' ? 'parallel' : 'single',
    concurrency: Number(meta.concurrency) || 4,
    triggers: arr(meta.triggers),
    tools: arr(meta['allowed-tools']),
    params: Array.isArray(meta.params)
      ? (meta.params as Record<string, unknown>[]).map((p) => ({
          name: String(p.name ?? ''),
          type: p.type === 'number' || p.type === 'boolean' ? p.type : 'string',
          default: p.default === undefined ? undefined : String(p.default),
          description: p.description ? String(p.description) : undefined,
        }))
      : [],
    body: m[2],
  };
}

/**
 * 手动创建 / 编辑 Skill：表单填写常用字段（会生成 SKILL.md），也可以切到「源码」直接编辑 SKILL.md。
 */
function SkillEditorDialog({ target, onClose }: { target: { id: string | null } | null; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [form] = Form.useForm<SkillForm>();
  const [tab, setTab] = useState<'form' | 'source'>('form');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const editing = !!target?.id;
  const mode = Form.useWatch('mode', form);

  useEffect(() => {
    if (!target) return;
    setTab('form');
    if (target.id) {
      invoke('skill.read', { id: target.id })
        .then((src) => {
          setSource(src);
          try {
            form.setFieldsValue(toForm(src));
          } catch {
            setTab('source');
          }
        })
        .catch((e) => message.error(errorMessage(e)));
    } else {
      form.setFieldsValue(EMPTY);
      setSource(toSource(EMPTY));
    }
  }, [target]);

  const switchTab = (next: 'form' | 'source'): void => {
    if (next === tab) return;
    if (next === 'source') {
      setSource(toSource({ ...EMPTY, ...form.getFieldsValue(true) }));
      setTab('source');
      return;
    }
    try {
      form.setFieldsValue(toForm(source));
      setTab('form');
    } catch (e) {
      message.error(`源码解析失败，先修正再切回表单：${(e as Error).message.split('\n')[0]}`);
    }
  };

  const save = async (): Promise<void> => {
    let content = source;
    if (tab === 'form') {
      try {
        await form.validateFields();
      } catch {
        return;
      }
      content = toSource({ ...EMPTY, ...form.getFieldsValue(true) });
    }
    setBusy(true);
    try {
      const info = await invoke('skill.save', { id: target?.id ?? null, content });
      await useAgent.getState().loadSkills();
      message.success(editing ? '已保存' : `已创建 Skill「${info.title}」`);
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
      title={editing ? '编辑 Skill' : '新建 Skill'}
      width={760}
      okText="保存"
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void save()}
      onCancel={onClose}
      destroyOnHidden
      className="skill-editor"
      styles={{ body: { maxHeight: 'min(680px, calc(100vh - 220px))', overflowY: 'auto', paddingRight: 6 } }}
    >
      <Tabs
        activeKey={tab}
        onChange={(k) => switchTab(k as 'form' | 'source')}
        items={[
          {
            key: 'form',
            label: '表单',
            forceRender: true,
            children: (
              <Form form={form} layout="vertical" requiredMark={false} preserve>
                <div className="skill-grid">
                  <Form.Item name="name" label="名称（英文标识）" rules={[{ required: true, pattern: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, message: '字母、数字、- 和 _，例如 nginx-reload' }]} extra="也是 Skill 目录名，创建后不能修改">
                    <Input placeholder="nginx-reload" disabled={editing} data-testid="skill-name" />
                  </Form.Item>
                  <Form.Item name="title" label="标题">
                    <Input placeholder="重载 Nginx 配置" data-testid="skill-title" />
                  </Form.Item>
                </div>
                <Form.Item name="description" label="说明" rules={[{ required: true, whitespace: true, message: '一句话说明这个 Skill 做什么' }]} extra="Agent 根据这句话判断什么时候使用这个 Skill">
                  <Input placeholder="检查配置语法后重载 Nginx，失败时回滚" data-testid="skill-desc" />
                </Form.Item>
                <div className="skill-grid">
                  <Form.Item name="risk" label="风险等级">
                    <Segmented
                      options={[
                        { label: '只读', value: 'readonly' },
                        { label: '写操作需批准', value: 'write-needs-approval' },
                        { label: '高危', value: 'dangerous' },
                      ]}
                    />
                  </Form.Item>
                  <Form.Item label="运行方式">
                    <Space>
                      <Form.Item name="mode" noStyle>
                        <Segmented
                          options={[
                            { label: '单个 Agent', value: 'single' },
                            { label: '多台并行', value: 'parallel' },
                          ]}
                        />
                      </Form.Item>
                      {mode === 'parallel' && (
                        <Form.Item name="concurrency" noStyle>
                          <InputNumber min={1} max={16} addonBefore="并发" style={{ width: 120 }} />
                        </Form.Item>
                      )}
                    </Space>
                  </Form.Item>
                </div>
                <div className="skill-grid">
                  <Form.Item name="tools" label="允许的工具" extra="不选表示用默认的只读工具">
                    <Select mode="multiple" options={TOOLS} placeholder="默认：执行命令、读取监控、读取文件" />
                  </Form.Item>
                  <Form.Item name="triggers" label="触发词" extra="对话里提到这些词时，Agent 更容易想到这个 Skill">
                    <Select mode="tags" placeholder="例如：重载 nginx" open={false} />
                  </Form.Item>
                </div>
                <Form.Item label="参数">
                  <Form.List name="params">
                    {(fields, { add, remove }) => (
                      <div className="skill-params">
                        {fields.map((f) => (
                          <Space key={f.key} align="start" className="skill-param-row">
                            <Form.Item name={[f.name, 'name']} rules={[{ required: true, message: '参数名' }]} noStyle>
                              <Input placeholder="参数名" style={{ width: 140 }} />
                            </Form.Item>
                            <Form.Item name={[f.name, 'type']} initialValue="string" noStyle>
                              <Select style={{ width: 100 }} options={[{ value: 'string', label: '文本' }, { value: 'number', label: '数字' }, { value: 'boolean', label: '是 / 否' }]} />
                            </Form.Item>
                            <Form.Item name={[f.name, 'default']} noStyle>
                              <Input placeholder="默认值" style={{ width: 120 }} />
                            </Form.Item>
                            <Form.Item name={[f.name, 'description']} noStyle>
                              <Input placeholder="说明" style={{ width: 220 }} />
                            </Form.Item>
                            <Button type="text" danger icon={<DeleteOutlined />} onClick={() => remove(f.name)} aria-label="删除参数" />
                          </Space>
                        ))}
                        <Button size="small" icon={<PlusOutlined />} onClick={() => add({ name: '', type: 'string' })}>
                          添加参数
                        </Button>
                      </div>
                    )}
                  </Form.List>
                </Form.Item>
                <Form.Item name="body" label="正文（Markdown：步骤、注意事项、输出要求）">
                  <Input.TextArea autoSize={{ minRows: 8, maxRows: 18 }} className="mono" spellCheck={false} data-testid="skill-body" />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: 'source',
            label: '源码（SKILL.md）',
            children: (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  开头用 --- 包起来的 front matter 写 name、description 等字段，后面是正文。
                </Typography.Text>
                <Input.TextArea value={source} onChange={(e) => setSource(e.target.value)} autoSize={{ minRows: 18, maxRows: 28 }} className="mono" spellCheck={false} style={{ marginTop: 8 }} data-testid="skill-source" />
              </>
            ),
          },
        ]}
      />
    </Modal>
  );
}

export const SkillEditor = freshOnOpen(SkillEditorDialog, (p) => p.target);
