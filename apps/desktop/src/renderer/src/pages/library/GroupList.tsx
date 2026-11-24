import { App, Button, Dropdown, Input, Modal, Tooltip, type MenuProps } from 'antd';
import { AppstoreOutlined, DeleteOutlined, EditOutlined, FolderOutlined, InboxOutlined, MoreOutlined, PlusOutlined, ShareAltOutlined, VerticalAlignBottomOutlined, VerticalAlignTopOutlined } from '@ant-design/icons';
import { useState } from 'react';
import type { LibraryGroup } from '@itm/protocol';
import { errorMessage } from '../../api';

/** 'all' = 全部，'none' = 未分组，其他是分组 id */
export type GroupKey = 'all' | 'none' | string;

/**
 * 快捷命令 / 笔记页左侧的分组列表（单层）：全部、未分组、各个分组；分组可以改名、删除、上移下移。
 */
export function GroupList({
  title,
  groups,
  total,
  ungrouped,
  selected,
  onSelect,
  onSave,
  onDelete,
  onReorder,
  onShare,
  onCreateItem,
  itemNoun,
  testId,
}: {
  /** 右键菜单里的「在这里新建…」（第二十六轮）；groupKey 是右键的分组 */
  onCreateItem?(groupKey: GroupKey): void;
  /** 「新建笔记」「新建命令」里的名词 */
  itemNoun?: string;
  title: string;
  groups: LibraryGroup[];
  total: number;
  ungrouped: number;
  selected: GroupKey;
  onSelect(k: GroupKey): void;
  onSave(id: string | null, name: string): Promise<string>;
  onDelete(id: string): Promise<void>;
  onReorder(ids: string[]): Promise<void>;
  /** 分享整个分组（第十三轮） */
  onShare?(id: string): void;
  testId: string;
}): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [editing, setEditing] = useState<{ id: string | null; name: string } | null>(null);

  const save = async (): Promise<void> => {
    if (!editing) return;
    try {
      const id = await onSave(editing.id, editing.name);
      setEditing(null);
      if (!editing.id) onSelect(id);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const move = (i: number, d: -1 | 1): void => {
    const ids = groups.map((g) => g.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void onReorder(ids);
  };

  /** 分组的菜单：··· 和右键共用（第二十六轮） */
  const groupMenu = (g: LibraryGroup, i: number): MenuProps => ({
    items: [
      ...(onCreateItem ? [{ key: 'create', label: `在这个分组新建${itemNoun ?? ''}`, icon: <PlusOutlined /> }, { type: 'divider' as const }] : []),
      { key: 'rename', label: '重命名', icon: <EditOutlined /> },
      { key: 'up', label: '上移', icon: <VerticalAlignTopOutlined />, disabled: i === 0 },
      { key: 'down', label: '下移', icon: <VerticalAlignBottomOutlined />, disabled: i === groups.length - 1 },
      ...(onShare ? [{ key: 'share', label: '分享整个分组…', icon: <ShareAltOutlined />, disabled: g.count === 0 }] : []),
      { type: 'divider' },
      { key: 'delete', label: '删除分组', icon: <DeleteOutlined />, danger: true },
    ],
    onClick: ({ key, domEvent }) => {
      domEvent.stopPropagation();
      if (key === 'create') onCreateItem?.(g.id);
      if (key === 'rename') setEditing({ id: g.id, name: g.name });
      if (key === 'up') move(i, -1);
      if (key === 'down') move(i, 1);
      if (key === 'share') onShare?.(g.id);
      if (key === 'delete') {
        modal.confirm({
          title: `删除分组「${g.name}」？`,
          content: g.count > 0 ? `组内的 ${g.count} 条会移到「未分组」，不会被删除。` : undefined,
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: async () => {
            await onDelete(g.id);
            if (selected === g.id) onSelect('all');
          },
        });
      }
    },
  });
  /** 「全部」「未分组」和空白处的右键菜单 */
  const baseMenu = (key: GroupKey): MenuProps => ({
    items: [
      ...(onCreateItem ? [{ key: 'create', label: key === 'none' ? `新建未分组的${itemNoun ?? ''}` : `新建${itemNoun ?? ''}`, icon: <PlusOutlined /> }] : []),
      { key: 'group', label: '新建分组', icon: <FolderOutlined /> },
    ],
    onClick: ({ key: k, domEvent }) => {
      domEvent.stopPropagation();
      if (k === 'create') onCreateItem?.(key);
      if (k === 'group') setEditing({ id: null, name: '' });
    },
  });

  const item = (key: GroupKey, icon: React.ReactNode, name: string, count: number, menu: MenuProps, extra?: React.ReactNode): React.JSX.Element => (
    <Dropdown key={key} trigger={['contextMenu']} menu={menu}>
      <div className={`group-item ${selected === key ? 'active' : ''}`} onClick={() => onSelect(key)} onContextMenu={(e) => e.stopPropagation()} data-testid={`${testId}-${key === 'all' || key === 'none' ? key : name}`}>
        {icon}
        <span className="group-name">{name}</span>
        <span className="count">{count}</span>
        {extra}
      </div>
    </Dropdown>
  );

  return (
    <div className="folder-panel group-panel">
      <div className="folder-panel-header">
        <span>{title}</span>
        <Tooltip title="新建分组">
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => setEditing({ id: null, name: '' })} data-testid={`${testId}-new-group`} />
        </Tooltip>
      </div>
      <Dropdown trigger={['contextMenu']} menu={baseMenu('all')}>
      <div className="group-list">
        {item('all', <AppstoreOutlined />, '全部', total, baseMenu('all'))}
        {item('none', <InboxOutlined />, '未分组', ungrouped, baseMenu('none'))}
        {groups.map((g, i) =>
          item(
            g.id,
            <FolderOutlined />,
            g.name,
            g.count,
            groupMenu(g, i),
            <Dropdown trigger={['click']} menu={groupMenu(g, i)}>
              <MoreOutlined className="group-more" onClick={(e) => e.stopPropagation()} />
            </Dropdown>,
          ),
        )}
      </div>
      </Dropdown>
      <Modal
        open={!!editing}
        title={editing?.id ? '重命名分组' : '新建分组'}
        okText="保存"
        cancelText="取消"
        onOk={() => void save()}
        onCancel={() => setEditing(null)}
        destroyOnHidden
        width={400}
      >
        <Input
          autoFocus
          value={editing?.name ?? ''}
          maxLength={64}
          placeholder="分组名称"
          onChange={(e) => setEditing((x) => (x ? { ...x, name: e.target.value } : x))}
          onPressEnter={() => void save()}
          data-testid={`${testId}-group-name`}
        />
      </Modal>
    </div>
  );
}
