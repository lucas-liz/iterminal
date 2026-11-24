import { useEffect, useMemo, useState } from 'react';
import { App, Button, Dropdown, Empty, Form, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, type MenuProps } from 'antd';
import { CloseCircleOutlined, CopyOutlined, DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, SearchOutlined, SendOutlined, ShareAltOutlined, WifiOutlined } from '@ant-design/icons';
import { snippetVars, type Snippet, type SnippetInput } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useLibrary } from '../../store/library';
import { useApp } from '../../store/app';
import { FormSection } from '../../components/FormSection';
import { GroupList, type GroupKey } from './GroupList';
import { freshOnOpen } from '../../util/fresh';
import { useShare } from '../../store/share';
import { TopBarSlot } from '../../components/TopBar';
import { CollapsibleSider } from '../../components/CollapsibleSider';

/** 快捷命令编辑框 */
function SnippetEditorDialog({ target, defaultGroupId, onClose }: { target: Snippet | 'new' | null; defaultGroupId: string | null; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [form] = Form.useForm<SnippetInput>();
  const groups = useLibrary((s) => s.snippetGroups);
  const content = Form.useWatch('content', form) ?? '';
  const vars = snippetVars(content);
  const editing = target && target !== 'new' ? target : null;
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await invoke('snippet.save', { id: editing?.id ?? null, input: { ...v, groupId: v.groupId || null } });
      await useLibrary.getState().reloadSnippets();
      message.success('已保存');
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!target}
      title={editing ? `编辑快捷命令 · ${editing.name}` : '新建快捷命令'}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={onClose}
      width={640}
      destroyOnHidden
      maskClosable={false}
      okButtonProps={{ 'data-testid': 'snippet-save' } as never}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        preserve={false}
        initialValues={
          editing
            ? { groupId: editing.groupId ?? '', name: editing.name, content: editing.content, description: editing.description ?? '', tags: editing.tags }
            : { groupId: defaultGroupId ?? '', name: '', content: '', description: '', tags: [] }
        }
      >
        <FormSection title="基本信息">
          <div style={{ display: 'flex', gap: 8 }}>
            <Form.Item name="name" label="名称" style={{ flex: 1 }} rules={[{ required: true, whitespace: true, message: '请填写名称' }]}>
              <Input placeholder="例如：查看 Nginx 错误日志" data-testid="snippet-name" />
            </Form.Item>
            <Form.Item name="groupId" label="分组" style={{ width: 200 }}>
              <Select options={[{ value: '', label: '未分组' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
            </Form.Item>
          </div>
          <Form.Item name="tags" label="标签">
            <Select mode="tags" placeholder="例如 nginx、日志" tokenSeparators={[',', '，', ' ']} />
          </Form.Item>
        </FormSection>
        <FormSection title="命令">
          <Form.Item
            name="content"
            rules={[{ required: true, whitespace: true, message: '请填写命令' }]}
            extra={
              <span>
                可以用 <Typography.Text code>{'{{变量}}'}</Typography.Text> 或 <Typography.Text code>{'{{变量:默认值}}'}</Typography.Text>，发送前弹出填写框；多行命令会逐行发送。
              </span>
            }
          >
            <Input.TextArea rows={5} className="mono" spellCheck={false} placeholder={'tail -n {{行数:200}} /var/log/nginx/error.log'} data-testid="snippet-content" />
          </Form.Item>
          {vars.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                变量：
              </Typography.Text>
              {vars.map((v) => (
                <Tag key={v.name} color="purple">
                  {v.name}
                  {v.defaultValue && `（默认 ${v.defaultValue}）`}
                </Tag>
              ))}
            </div>
          )}
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} maxLength={1000} placeholder="什么时候用、注意事项" />
          </Form.Item>
        </FormSection>
      </Form>
    </Modal>
  );
}

export const SnippetEditor = freshOnOpen(SnippetEditorDialog, (p) => p.target);

/** 「指令集」页（文档一 6.14）：左侧分组，右侧命令列表；可以发送到当前终端或广播到多个终端 */
export function SnippetsPage(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const st = useLibrary();
  const [group, setGroup] = useState<GroupKey>('all');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Snippet | 'new' | null>(null);
  /** 右键菜单的位置：snippet 为空 = 空白处 */
  const [ctx, setCtx] = useState<{ x: number; y: number; snippet: Snippet | null } | null>(null);
  /** 勾选的命令（批量分享、删除，第十三轮） */
  const [checked, setChecked] = useState<string[]>([]);
  const siderCollapsed = useApp((s) => s.siderCollapsed);

  useEffect(() => {
    void st.reloadSnippets();
  }, []);
  // 列表变了（切换分组、搜索、删除）时去掉已经不在列表里的勾选
  useEffect(() => setChecked((c) => c.filter((id) => st.snippets.some((s) => s.id === id))), [st.snippets]);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return st.snippets
      .filter((s) => (group === 'all' ? true : group === 'none' ? !s.groupId : s.groupId === group))
      .filter((s) => !k || [s.name, s.content, s.description ?? '', ...s.tags].some((v) => v.toLowerCase().includes(k)));
  }, [st.snippets, group, q]);

  const remove = (s: Snippet): void => {
    modal.confirm({
      title: `删除快捷命令「${s.name}」？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await invoke('snippet.delete', { ids: [s.id] });
        await st.reloadSnippets();
      },
    });
  };

  /** 一条命令的菜单：··· 和右键共用（第二十六轮） */
  const snippetMenu = (s: Snippet): MenuProps => ({
    items: [
      { key: 'send', label: '发送到当前终端并执行', icon: <SendOutlined /> },
      { key: 'insert', label: '放入输入行（不执行）', icon: <SendOutlined /> },
      { key: 'broadcast', label: '广播到多个终端…', icon: <WifiOutlined /> },
      { type: 'divider' },
      { key: 'edit', label: '编辑', icon: <EditOutlined /> },
      { key: 'copy', label: '复制命令', icon: <CopyOutlined /> },
      { key: 'share', label: '分享…', icon: <ShareAltOutlined /> },
      {
        key: 'move',
        label: '移动到',
        children: [{ key: 'move:', label: '未分组' }, ...st.snippetGroups.map((g) => ({ key: `move:${g.id}`, label: g.name }))],
      },
      { type: 'divider' },
      { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true },
    ],
    onClick: async ({ key }) => {
      setCtx(null);
      if (key === 'send') st.run(s);
      if (key === 'broadcast') st.run(s, { broadcast: true });
      if (key === 'edit') setEditing(s);
      if (key === 'insert') st.run(s, { execute: false });
      if (key === 'copy') void navigator.clipboard.writeText(s.content).then(() => message.success('已复制'));
      if (key === 'delete') remove(s);
      if (key === 'share') useShare.getState().open({ snippetIds: [s.id] });
      if (key.startsWith('move:')) {
        await invoke('snippet.move', { ids: [s.id], groupId: key.slice(5) || null });
        await st.reloadSnippets();
      }
    },
  });

  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title">
            <span className="topbar-page-name">指令集</span>
            <span className="topbar-page-sub">常用命令一键发送到终端，支持变量和广播</span>
          </div>
          <div className="topbar-ctx-actions no-drag">
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')} data-testid="snippet-new">
              新建命令
            </Button>
          </div>
        </div>
      </TopBarSlot>
      <div className="hosts-body">
        <CollapsibleSider collapsed={siderCollapsed} width={236} gapOffset={10}>
          <GroupList
            title="命令分组"
            testId="snippet-group"
            itemNoun="命令"
            onCreateItem={(k) => {
              setGroup(k);
              setEditing('new');
            }}
            groups={st.snippetGroups}
            total={st.snippets.length}
            ungrouped={st.snippets.filter((s) => !s.groupId).length}
            selected={group}
            onSelect={setGroup}
            onSave={async (id, name) => {
              const gid = await invoke('snippet.group.save', { id, name });
              await st.reloadSnippets();
              return gid;
            }}
            onDelete={async (id) => {
              await invoke('snippet.group.delete', { id });
              await st.reloadSnippets();
            }}
            onReorder={async (ids) => {
              await invoke('snippet.group.reorder', { ids });
              await st.reloadSnippets();
            }}
            onShare={(id) => useShare.getState().open({ snippetGroupIds: [id] })}
          />
        </CollapsibleSider>
        <div
          className="host-list"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('.ant-table-thead, .ant-input-affix-wrapper')) return;
            e.preventDefault();
            setCtx({ x: e.clientX, y: e.clientY, snippet: null });
          }}
        >
          <div className="host-toolbar">
            <Input allowClear prefix={<SearchOutlined />} placeholder="搜索名称、命令、说明、标签" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 360 }} />
          </div>
          <Table<Snippet>
            className="host-table"
            size="middle"
            rowKey="id"
            pagination={false}
            dataSource={list}
            rowSelection={{ selectedRowKeys: checked, onChange: (keys) => setChecked(keys as string[]), columnWidth: 36 }}
            scroll={{ y: 'calc(100vh - 190px)' }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={st.snippets.length ? '没有匹配的命令' : '还没有快捷命令，点右上角「新建命令」'} /> }}
            onRow={(s) =>
              ({
                onDoubleClick: () => setEditing(s),
                // 右键菜单（第二十六轮）：和 ··· 里的一样
                onContextMenu: (e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({ x: e.clientX, y: e.clientY, snippet: s });
                },
                'data-testid': `snippet-row-${s.name}`,
              }) as React.HTMLAttributes<HTMLElement>
            }
            columns={[
              {
                title: '名称',
                dataIndex: 'name',
                width: 240,
                render: (_, s) => (
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{s.name}</div>
                    {s.description && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: s.description }}>
                        {s.description}
                      </Typography.Text>
                    )}
                  </div>
                ),
              },
              {
                title: '命令',
                dataIndex: 'content',
                render: (c: string) => (
                  <Tooltip title={<pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{c}</pre>} placement="topLeft">
                    <code className="snippet-code">{c.split('\n')[0]}{c.includes('\n') ? ' …' : ''}</code>
                  </Tooltip>
                ),
              },
              { title: '标签', dataIndex: 'tags', width: 160, render: (tags: string[]) => tags.map((t) => <Tag key={t}>{t}</Tag>) },
              {
                title: '',
                key: 'op',
                width: 170,
                render: (_, s) => (
                  <Space size={4}>
                    <Tooltip title="发送到当前终端并执行">
                      <Button size="small" type="primary" ghost icon={<SendOutlined />} onClick={() => st.run(s)} data-testid={`snippet-send-${s.name}`}>
                        发送
                      </Button>
                    </Tooltip>
                    <Tooltip title="广播到多个终端">
                      <Button size="small" icon={<WifiOutlined />} onClick={() => st.run(s, { broadcast: true })} data-testid={`snippet-broadcast-${s.name}`} />
                    </Tooltip>
                    <Dropdown trigger={['click']} menu={snippetMenu(s)}>
                      <Button size="small" type="text" icon={<MoreOutlined />} />
                    </Dropdown>
                  </Space>
                ),
              },
            ]}
          />
          {checked.length > 0 && (
            <div className="selection-bar" data-testid="snippet-selection-bar" role="toolbar" aria-label="批量操作">
              <span className="selection-count">
                已选择 <b>{checked.length}</b> 条命令
              </span>
              <span className="selection-sep" />
              <button type="button" className="selection-act" onClick={() => useShare.getState().open({ snippetIds: checked })} data-testid="snippet-batch-share">
                <ShareAltOutlined /> 分享
              </button>
              <button
                type="button"
                className="selection-act danger"
                onClick={() =>
                  modal.confirm({
                    title: `删除选中的 ${checked.length} 条快捷命令？`,
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: async () => {
                      await invoke('snippet.delete', { ids: checked });
                      setChecked([]);
                      await st.reloadSnippets();
                    },
                  })
                }
              >
                <DeleteOutlined /> 删除
              </button>
              <span className="selection-sep" />
              <Tooltip title="取消选择">
                <button type="button" className="selection-x" onClick={() => setChecked([])} aria-label="取消选择">
                  <CloseCircleOutlined />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
      <Dropdown
        open={!!ctx}
        onOpenChange={(o) => !o && setCtx(null)}
        trigger={['contextMenu']}
        menu={
          ctx?.snippet
            ? snippetMenu(ctx.snippet)
            : {
                items: [{ key: 'new', label: '新建命令', icon: <PlusOutlined /> }],
                onClick: () => {
                  setCtx(null);
                  setEditing('new');
                },
              }
        }
      >
        <div className="ctx-anchor" style={{ left: ctx?.x ?? -10, top: ctx?.y ?? -10 }} />
      </Dropdown>
      <SnippetEditor target={editing} defaultGroupId={group !== 'all' && group !== 'none' ? group : null} onClose={() => setEditing(null)} />
    </>
  );
}
