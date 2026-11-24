import { useState } from 'react';
import { Alert, App, Badge, Button, Checkbox, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { CaretRightOutlined, CodeOutlined, DeleteOutlined, EditOutlined, ImportOutlined, PauseOutlined, PlusOutlined } from '@ant-design/icons';
import { ForwardCommand, useForwardImport } from './ForwardImport';
import type { PortForward, PortForwardInput, PortForwardType } from '@itm/protocol';
import { errorMessage, invoke } from '../api';
import { useForwards } from '../store/forwards';
import { useHosts } from '../store/hosts';
import { FormSection } from './FormSection';
import { useOpenKey } from '../util/fresh';

const TYPE_INFO: Record<PortForwardType, { label: string; tag: string; color: string; help: string }> = {
  LOCAL: { label: '本地转发 -L', tag: '本地', color: 'blue', help: '本机端口 → 经过这台主机 → 目标（例如访问内网数据库）' },
  REMOTE: { label: '远程转发 -R', tag: '远程', color: 'purple', help: '这台主机上的端口 → 经过本机 → 目标（例如让服务器访问本机的服务）' },
  DYNAMIC: { label: '动态转发 -D', tag: 'SOCKS5', color: 'cyan', help: '本机 SOCKS5 代理，经过这台主机访问任意地址（浏览器等设置代理即可）' },
};

const EMPTY: PortForwardInput = { type: 'LOCAL', bindAddr: '127.0.0.1', bindPort: 0, targetAddr: '', targetPort: null, autoStart: false };

/** 端口转发管理（文档一 6.10.1 port_forward）：一台 SSH 主机的转发列表、新增 / 修改、启动 / 停止 */
export function PortForwardModal(): React.JSX.Element {
  const hostId = useForwards((s) => s.editingHostId);
  return <PortForwardDialog key={useOpenKey(hostId)} />;
}

function PortForwardDialog(): React.JSX.Element {
  const { message } = App.useApp();
  const st = useForwards();
  const host = useHosts((s) => s.hosts.find((h) => h.id === st.editingHostId));
  const [form] = Form.useForm<PortForwardInput>();
  const [editing, setEditing] = useState<PortForward | 'new' | null>(null);
  const [showCmd, setShowCmd] = useState(false);
  /** 批量操作：勾选的转发 */
  const [picked, setPicked] = useState<string[]>([]);
  const type = Form.useWatch('type', form) ?? 'LOCAL';
  const bindAddr = Form.useWatch('bindAddr', form);
  const list = st.forwards.filter((f) => f.hostId === st.editingHostId);

  const save = async (): Promise<void> => {
    const v = await form.validateFields();
    try {
      await invoke('portforward.save', { id: editing && editing !== 'new' ? editing.id : null, hostId: st.editingHostId!, input: { ...v, targetPort: v.targetPort ?? null, targetAddr: v.targetAddr ?? null } });
      setEditing(null);
      await st.reload();
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  /** 批量启动 / 停止 / 删除（第十二轮），逐条执行，失败的汇总提示 */
  const batch = async (op: 'start' | 'stop' | 'delete'): Promise<void> => {
    const items = list.filter((f) => picked.includes(f.id));
    const todo = op === 'start' ? items.filter((f) => st.status[f.id]?.state !== 'running') : op === 'stop' ? items.filter((f) => st.status[f.id]?.state === 'running') : items;
    const failed: string[] = [];
    for (const f of todo) {
      try {
        if (op === 'start') await invoke('portforward.start', { id: f.id });
        else if (op === 'stop') await invoke('portforward.stop', { id: f.id });
        else await invoke('portforward.delete', { id: f.id });
      } catch (e) {
        failed.push(`${f.bindPort || '自动'}：${errorMessage(e)}`);
      }
    }
    if (op === 'delete') {
      setPicked([]);
      await st.reload();
    }
    const verb = op === 'start' ? '启动' : op === 'stop' ? '停止' : '删除';
    if (failed.length) message.warning(`${verb}了 ${todo.length - failed.length} 条，${failed.length} 条失败：${failed[0]}`);
    else message.success(todo.length ? `已${verb} ${todo.length} 条转发` : op === 'start' ? '选中的转发都在运行' : '选中的转发都没有运行');
  };
  const pickedRunning = list.filter((f) => picked.includes(f.id) && st.status[f.id]?.state === 'running').length;

  const toggle = async (f: PortForward): Promise<void> => {
    try {
      if (st.status[f.id]?.state === 'running') await invoke('portforward.stop', { id: f.id });
      else await invoke('portforward.start', { id: f.id });
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <Modal
      open={!!st.editingHostId}
      title={`端口转发 · ${host?.name ?? ''}`}
      width={820}
      footer={null}
      onCancel={() => {
        setEditing(null);
        st.close();
      }}
      destroyOnHidden
    >
      <FormSection
        title="转发列表"
        extra={
          !editing && (
            <Space size={6}>
              <Button size="small" icon={<ImportOutlined />} onClick={() => useForwardImport.getState().show(st.editingHostId)} data-testid="pf-import">
                从 ssh 命令导入
              </Button>
              <Button size="small" icon={<CodeOutlined />} disabled={!list.length} onClick={() => setShowCmd(true)} data-testid="pf-export">
                生成 ssh 命令
              </Button>
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  form.setFieldsValue(EMPTY);
                  setEditing('new');
                }}
                data-testid="pf-add"
              >
                添加转发
              </Button>
            </Space>
          )
        }
      >
        {picked.length > 0 && (
          <div className="pf-batch" data-testid="pf-batch">
            <span>
              已选择 <b>{picked.length}</b> 条
            </span>
            <Button size="small" type="primary" ghost icon={<CaretRightOutlined />} disabled={pickedRunning === picked.length} onClick={() => void batch('start')} data-testid="pf-batch-start">
              连接（启动）
            </Button>
            <Button size="small" icon={<PauseOutlined />} disabled={pickedRunning === 0} onClick={() => void batch('stop')} data-testid="pf-batch-stop">
              断开
            </Button>
            <Popconfirm title={`删除选中的 ${picked.length} 条转发？`} okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void batch('delete')}>
              <Button size="small" danger icon={<DeleteOutlined />} data-testid="pf-batch-delete">
                删除
              </Button>
            </Popconfirm>
            <Button size="small" type="text" onClick={() => setPicked([])} style={{ marginLeft: 'auto' }}>
              取消选择
            </Button>
          </div>
        )}
        <Table<PortForward>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={list}
          style={{ marginBottom: 12 }}
          rowSelection={{ selectedRowKeys: picked, onChange: (keys) => setPicked(keys as string[]), columnWidth: 36 }}
          onRow={(f) => ({
            // 单击行也能勾选（点在按钮上除外）
            onClick: (e) => {
              if ((e.target as HTMLElement).closest('button, a, input, .ant-checkbox-wrapper, .ant-popover')) return;
              setPicked((p) => (p.includes(f.id) ? p.filter((x) => x !== f.id) : [...p, f.id]));
            },
          })}
          locale={{ emptyText: '还没有端口转发' }}
          columns={[
            { title: '类型', dataIndex: 'type', width: 80, render: (t: PortForwardType) => <Tag color={TYPE_INFO[t].color}>{TYPE_INFO[t].tag}</Tag> },
            {
              title: '监听',
              key: 'bind',
              render: (_, f) => {
                const s = st.status[f.id];
                return (
                  <span className="mono">
                    {f.type === 'REMOTE' ? '主机 ' : '本机 '}
                    {`${f.bindAddr}:${s?.boundPort ?? (f.bindPort || '自动')}`}
                  </span>
                );
              },
            },
            { title: '目标', key: 'target', render: (_, f) => <span className="mono">{f.type === 'DYNAMIC' ? '任意（SOCKS5）' : `${f.targetAddr}:${f.targetPort}`}</span> },
            { title: '自动启动', dataIndex: 'autoStart', width: 80, render: (v: boolean) => (v ? '是' : '—') },
            {
              title: '状态',
              key: 'status',
              width: 150,
              render: (_, f) => {
                const s = st.status[f.id];
                if (!s || s.state === 'stopped') return <Badge status="default" text="未启动" />;
                if (s.state === 'starting') return <Badge status="processing" text="启动中" />;
                if (s.state === 'error')
                  return (
                    <Tooltip title={s.message}>
                      <Badge status="error" text="出错" />
                    </Tooltip>
                  );
                return <Badge status="success" text={`运行中${s.connections ? ` · ${s.connections} 个连接` : ''}`} data-testid={`pf-running-${f.bindPort}`} />;
              },
            },
            {
              title: '',
              key: 'op',
              width: 110,
              render: (_, f) => {
                const running = st.status[f.id]?.state === 'running';
                return (
                  <Space size={2}>
                    <Tooltip title={running ? '停止' : '启动'}>
                      <Button size="small" type="text" icon={running ? <PauseOutlined /> : <CaretRightOutlined />} onClick={() => void toggle(f)} data-testid={`pf-toggle-${f.bindPort}`} />
                    </Tooltip>
                    <Button
                      size="small"
                      type="text"
                      icon={<EditOutlined />}
                      onClick={() => {
                        form.setFieldsValue(f);
                        setEditing(f);
                      }}
                    />
                    <Popconfirm
                      title="删除这条转发？"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={async () => {
                        await invoke('portforward.delete', { id: f.id });
                        setPicked((p) => p.filter((x) => x !== f.id));
                        await st.reload();
                      }}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                );
              },
            },
          ]}
        />
        {list.some((f) => st.status[f.id]?.state === 'error') && (
          <Alert type="error" showIcon style={{ marginBottom: 12 }} message={list.map((f) => st.status[f.id]?.message).filter(Boolean).join('；')} />
        )}
      </FormSection>

      {editing && (
        <FormSection title={editing === 'new' ? '添加转发' : '修改转发'}>
          <Form form={form} layout="vertical" requiredMark={false} initialValues={EMPTY}>
            <Form.Item name="type" label="类型" extra={TYPE_INFO[type as PortForwardType].help}>
              <Segmented options={(Object.keys(TYPE_INFO) as PortForwardType[]).map((t) => ({ value: t, label: TYPE_INFO[t].label }))} data-testid="pf-type" />
            </Form.Item>
            <div style={{ display: 'flex', gap: 8 }}>
              <Form.Item name="bindAddr" label={type === 'REMOTE' ? '主机上的监听地址' : '本机监听地址'} style={{ flex: 1 }}>
                <Input placeholder="127.0.0.1" />
              </Form.Item>
              <Form.Item name="bindPort" label="监听端口" style={{ width: 160 }} extra="0 = 自动分配" rules={[{ required: true, message: '请填写端口' }]}>
                <InputNumber min={0} max={65535} style={{ width: '100%' }} data-testid="pf-bind-port" />
              </Form.Item>
            </div>
            {type !== 'DYNAMIC' && (
              <div style={{ display: 'flex', gap: 8 }}>
                <Form.Item
                  name="targetAddr"
                  label={type === 'LOCAL' ? '目标地址（从这台主机访问）' : '目标地址（从本机访问）'}
                  style={{ flex: 1 }}
                  rules={[{ required: true, whitespace: true, message: '请填写目标地址' }]}
                >
                  <Input placeholder={type === 'LOCAL' ? '例如 10.0.0.5 或 db.internal' : '例如 127.0.0.1'} data-testid="pf-target-addr" />
                </Form.Item>
                <Form.Item name="targetPort" label="目标端口" style={{ width: 160 }} rules={[{ required: true, message: '请填写端口' }]}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} data-testid="pf-target-port" />
                </Form.Item>
              </div>
            )}
            <Form.Item name="autoStart" valuePropName="checked">
              <Checkbox>打开这台主机的终端时自动启动</Checkbox>
            </Form.Item>
            {bindAddr && bindAddr !== '127.0.0.1' && bindAddr !== 'localhost' && bindAddr !== '::1' && (
              <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="监听地址不是本机回环地址：局域网里的其他电脑也能通过这个端口访问，请确认需要这样做。" />
            )}
            <Space style={{ marginBottom: 12 }}>
              <Button type="primary" onClick={() => void save()} data-testid="pf-save">
                保存
              </Button>
              <Button onClick={() => setEditing(null)}>取消</Button>
            </Space>
          </Form>
        </FormSection>
      )}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: 0 }}>
        转发和这台主机的终端、SFTP 共用一条 SSH 连接；关闭窗口时停止。
      </Typography.Paragraph>
      <ForwardCommand host={host} open={showCmd} onClose={() => setShowCmd(false)} />
    </Modal>
  );
}
