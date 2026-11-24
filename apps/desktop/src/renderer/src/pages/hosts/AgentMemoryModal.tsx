import { useEffect, useState } from 'react';
import { App, Button, Empty, Input, Modal, Popconfirm, Space, Tooltip, Typography } from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import type { HostAgentMemory } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { formatRelative } from '../../util/format';

/** 主机编辑框「主机记忆」旁边的按钮：显示 Agent 记下的条数，点开查看、修改、删除（第二十六轮） */
export function AgentMemoryButton({ hostId }: { hostId: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const refresh = (): void => void invoke('host.agentMemory.list', { hostId }).then((l) => setCount(l.length)).catch(() => setCount(null));
  useEffect(refresh, [hostId]);
  return (
    <>
      <Button size="small" type="link" icon={<RobotOutlined />} onClick={() => setOpen(true)} data-testid="agent-memory-open" style={{ paddingInline: 4 }}>
        {`Agent 记忆${count ? `（${count}）` : ''}`}
      </Button>
      <AgentMemoryModal
        hostId={hostId}
        open={open}
        onClose={() => {
          setOpen(false);
          refresh();
        }}
      />
    </>
  );
}

function AgentMemoryModal({ hostId, open, onClose }: { hostId: string; open: boolean; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [list, setList] = useState<HostAgentMemory[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; text: string } | null>(null);
  const load = (): void => void invoke('host.agentMemory.list', { hostId }).then(setList).catch((e) => message.error(errorMessage(e)));
  useEffect(() => {
    if (open) {
      setEditing(null);
      load();
    }
  }, [open, hostId]);
  const save = async (): Promise<void> => {
    if (!editing) return;
    try {
      await invoke('host.agentMemory.save', { id: editing.id, hostId, content: editing.text });
      setEditing(null);
      load();
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  const editor = (
    <div className="agent-mem-edit">
      <Input.TextArea autoFocus autoSize={{ minRows: 2, maxRows: 6 }} maxLength={2000} value={editing?.text ?? ''} onChange={(e) => setEditing((x) => x && { ...x, text: e.target.value })} data-testid="agent-memory-input" />
      <Space style={{ marginTop: 6 }}>
        <Button size="small" type="primary" disabled={!editing?.text.trim()} onClick={() => void save()} data-testid="agent-memory-save">
          保存
        </Button>
        <Button size="small" onClick={() => setEditing(null)}>
          取消
        </Button>
      </Space>
    </div>
  );
  return (
    <Modal open={open} title="Agent 记下的主机记忆" footer={null} onCancel={onClose} width={560} destroyOnHidden>
      <div className="agent-mem" data-testid="agent-memory-modal">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Agent 在对话中提议、你确认后保存的记忆，引用这台主机时会一起发给模型（发送前脱敏）。手工填写的记忆在主机编辑框里。
        </Typography.Text>
        {list.length === 0 && editing?.id !== null && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有 Agent 记下的记忆" />}
        {list.map((m) =>
          editing?.id === m.id ? (
            <div key={m.id}>{editor}</div>
          ) : (
            <div key={m.id} className="agent-mem-item" data-testid="agent-memory-item">
              <div className="agent-mem-text selectable">{m.content}</div>
              <div className="agent-mem-foot">
                <span>{formatRelative(m.updatedAt)}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <Tooltip title="修改">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ id: m.id, text: m.content })} data-testid="agent-memory-edit" />
                  </Tooltip>
                  <Popconfirm title="删除这条记忆？" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => void invoke('host.agentMemory.delete', { id: m.id }).then(load)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} data-testid="agent-memory-delete" />
                  </Popconfirm>
                </span>
              </div>
            </div>
          ),
        )}
        {editing?.id === null ? (
          editor
        ) : (
          <Button size="small" icon={<PlusOutlined />} onClick={() => setEditing({ id: null, text: '' })} data-testid="agent-memory-add">
            新增一条
          </Button>
        )}
      </div>
    </Modal>
  );
}
