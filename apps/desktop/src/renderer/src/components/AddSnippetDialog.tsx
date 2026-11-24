import { useEffect, useState } from 'react';
import { App, Button, Divider, Input, Modal, Select, Space, Tooltip, Typography } from 'antd';
import { PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { create } from 'zustand';
import { errorMessage, invoke } from '../api';
import { useLibrary } from '../store/library';
import { useAiAllowed } from '../util/ai-access';

/** 上次选的目录：连续添加时不用每次重新选 */
const LAST_GROUP = 'itm.addSnippet.group';

interface AddSnippetState {
  /** 要添加的命令；context 是命令附近的终端输出（AI 生成说明时参考） */
  target: { content: string; context?: string; name?: string; description?: string; autoAi?: boolean } | null;
  /** 每次打开加一：对话框按它重新挂载（不残留上次的内容） */
  seq: number;
  show(t: NonNullable<AddSnippetState['target']>): void;
  close(): void;
}

export const useAddSnippet = create<AddSnippetState>((set) => ({
  target: null,
  seq: 0,
  show(target) {
    set((s) => ({ target, seq: s.seq + 1 }));
  },
  close() {
    set({ target: null });
  },
}));

/** 命令的前几个词作为默认名称 */
const defaultName = (cmd: string): string => {
  const first = cmd.split('\n').find((l) => l.trim()) ?? cmd;
  const t = first.trim();
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
};

/**
 * 添加到快捷指令（第十二轮）：终端右键、录像回放右键和命令列表都用这个对话框。
 * 选择目录（可以新建）、填写名称和描述；登录后可以用 AI 生成名称和描述。
 */
export function AddSnippetDialog(): React.JSX.Element {
  const seq = useAddSnippet((s) => s.seq);
  return <AddSnippetForm key={seq} />;
}

function AddSnippetForm(): React.JSX.Element {
  const { message } = App.useApp();
  const target = useAddSnippet((s) => s.target);
  const groups = useLibrary((s) => s.snippetGroups);
  const aiAllowed = useAiAllowed();
  const [content, setContent] = useState(target?.content ?? '');
  const [name, setName] = useState(target?.name ?? (target ? defaultName(target.content) : ''));
  const [description, setDescription] = useState(target?.description ?? '');
  const [groupId, setGroupId] = useState<string>(() => {
    const last = localStorage.getItem(LAST_GROUP) ?? '';
    return groups.some((g) => g.id === last) ? last : '';
  });
  const [newGroup, setNewGroup] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  const generate = async (): Promise<void> => {
    if (!content.trim()) return;
    setAiBusy(true);
    try {
      const r = await invoke('ai.describeCommand', { command: content, context: target?.context });
      setName(r.name);
      setDescription(r.description);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setAiBusy(false);
    }
  };
  // 从命令列表点「AI 汇总」进来时直接生成
  useEffect(() => {
    if (target?.autoAi && aiAllowed) void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addGroup = async (): Promise<void> => {
    const n = newGroup.trim();
    if (!n) return;
    try {
      const id = await invoke('snippet.group.save', { id: null, name: n });
      await useLibrary.getState().reloadSnippets();
      setGroupId(id);
      setNewGroup('');
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const save = async (): Promise<void> => {
    if (!content.trim()) {
      message.warning('指令内容是空的');
      return;
    }
    setSaving(true);
    try {
      await invoke('snippet.save', { id: null, input: { groupId: groupId || null, name: name.trim() || defaultName(content), content: content.replace(/\s+$/, ''), description: description.trim() || null } });
      await useLibrary.getState().reloadSnippets();
      localStorage.setItem(LAST_GROUP, groupId);
      message.success(`已添加到快捷指令${groupId ? `「${groups.find((g) => g.id === groupId)?.name ?? ''}」` : ''}`);
      useAddSnippet.getState().close();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title="添加到快捷指令"
      okText="添加"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={() => useAddSnippet.getState().close()}
      width={560}
      destroyOnHidden
      okButtonProps={{ ['data-testid' as never]: 'add-snippet-ok' }}
    >
      <div className="add-snippet" data-testid="add-snippet-dialog">
        <div className="add-snippet-row">
          <span className="add-snippet-label">目录</span>
          <Select
            value={groupId}
            onChange={setGroupId}
            style={{ flex: 1 }}
            options={[{ value: '', label: '未分组' }, ...groups.map((g) => ({ value: g.id, label: `${g.name}（${g.count}）` }))]}
            popupRender={(menu) => (
              <>
                {menu}
                <Divider style={{ margin: '6px 0' }} />
                <Space.Compact style={{ width: '100%', padding: '0 6px 4px' }}>
                  <Input size="small" placeholder="新建目录" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} onKeyDown={(e) => e.stopPropagation()} onPressEnter={() => void addGroup()} data-testid="add-snippet-new-group" />
                  <Button size="small" icon={<PlusOutlined />} onClick={() => void addGroup()} disabled={!newGroup.trim()}>
                    新建
                  </Button>
                </Space.Compact>
              </>
            )}
            data-testid="add-snippet-group"
          />
        </div>
        <div className="add-snippet-row">
          <span className="add-snippet-label">名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="例如：查看 Nginx 错误日志" data-testid="add-snippet-name" />
          <Tooltip title={aiAllowed ? '用 AI 根据命令生成名称和描述' : '登录后可用'}>
            <Button icon={<RobotOutlined />} loading={aiBusy} disabled={!aiAllowed || !content.trim()} onClick={() => void generate()} data-testid="add-snippet-ai">
              AI 生成
            </Button>
          </Tooltip>
        </div>
        <div className="add-snippet-row top">
          <span className="add-snippet-label">描述</span>
          <Input.TextArea value={description} onChange={(e) => setDescription(e.target.value)} autoSize={{ minRows: 2, maxRows: 4 }} maxLength={500} placeholder="这条指令做什么、什么时候用、有什么风险（鼠标移到快捷指令上时显示）" data-testid="add-snippet-desc" />
        </div>
        <div className="add-snippet-row top">
          <span className="add-snippet-label">指令</span>
          <Input.TextArea value={content} onChange={(e) => setContent(e.target.value)} autoSize={{ minRows: 2, maxRows: 8 }} className="mono" spellCheck={false} data-testid="add-snippet-content" />
        </div>
        <Typography.Text type="secondary" className="add-snippet-hint">
          可以用 {'{{变量}}'} 或 {'{{变量:默认值}}'}，发送前会弹出填写框。
        </Typography.Text>
      </div>
    </Modal>
  );
}
