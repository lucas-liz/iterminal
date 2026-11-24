import { useEffect, useState } from 'react';
import { App, Dropdown, Input, Modal, type MenuProps } from 'antd';
import {
  BorderHorizontalOutlined,
  BorderVerticleOutlined,
  CloseCircleOutlined,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  FormOutlined,
  LayoutOutlined,
  PlusSquareOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { useHosts } from '../../store/hosts';
import { useTabs, type Tab } from '../../store/tabs';

/**
 * 终端标签的右键菜单（参考 iShell）：复制 IP、重命名、编辑主机、克隆会话、分屏、重新连接、关闭（本标签 / 右侧 / 左侧 / 其他 / 所有）。
 */
export function TabMenu({ tab, roots, onRename, onSplit, children }: { tab: Tab; roots: Tab[]; onRename(t: Tab): void; onSplit(dir: 'h' | 'v'): void; children: React.ReactNode }): React.JSX.Element {
  const { message } = App.useApp();
  const host = useHosts((s) => (tab.hostId ? s.hosts.find((h) => h.id === tab.hostId) : undefined));
  const idx = roots.findIndex((t) => t.id === tab.id);
  const terminal = tab.kind !== 'sftp';
  const closeMany = (ids: string[]): void => ids.forEach((id) => useTabs.getState().close(id));

  const items: MenuProps['items'] = [
    { key: 'ip', label: '复制 IP', icon: <CopyOutlined />, disabled: !host || tab.kind === 'local' },
    { key: 'rename', label: '重命名', icon: <EditOutlined /> },
    { key: 'edit', label: '编辑主机', icon: <FormOutlined />, disabled: !host },
    { key: 'clone', label: '克隆会话（新标签）', icon: <PlusSquareOutlined />, disabled: tab.kind === 'serial' },
    {
      key: 'split',
      label: '分屏',
      icon: <LayoutOutlined />,
      disabled: !terminal,
      children: [
        { key: 'split-h', label: '左右分屏', icon: <BorderHorizontalOutlined /> },
        { key: 'split-v', label: '上下分屏', icon: <BorderVerticleOutlined /> },
      ],
    },
    { key: 'reconnect', label: '重新连接', icon: <ReloadOutlined />, disabled: !terminal },
    { type: 'divider' },
    { key: 'close', label: '关闭标签', icon: <CloseOutlined /> },
    { key: 'close-right', label: '关闭右侧', icon: <CloseCircleOutlined />, disabled: idx === roots.length - 1 },
    { key: 'close-left', label: '关闭左侧', icon: <CloseCircleOutlined />, disabled: idx <= 0 },
    { key: 'close-others', label: '关闭其他', icon: <CloseCircleOutlined />, disabled: roots.length <= 1 },
    { key: 'close-all', label: '关闭所有', icon: <CloseCircleOutlined /> },
  ];

  const onClick: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    const st = useTabs.getState();
    switch (key) {
      case 'ip':
        if (host) void navigator.clipboard.writeText(host.address).then(() => message.success(`已复制 ${host.address}`));
        break;
      case 'rename':
        onRename(tab);
        break;
      case 'edit':
        if (host) useHosts.getState().openEditor({ mode: 'edit', host });
        break;
      case 'clone':
        st.open({ kind: tab.kind, title: tab.title, hostId: tab.hostId });
        break;
      case 'split-h':
      case 'split-v':
        onSplit(key === 'split-h' ? 'h' : 'v');
        break;
      case 'reconnect':
        st.activate(tab.id);
        st.requestReconnect(st.focused[tab.id] ?? tab.id);
        break;
      case 'close':
        st.close(tab.id);
        break;
      case 'close-right':
        closeMany(roots.slice(idx + 1).map((t) => t.id));
        break;
      case 'close-left':
        closeMany(roots.slice(0, idx).map((t) => t.id));
        break;
      case 'close-others':
        closeMany(roots.filter((t) => t.id !== tab.id).map((t) => t.id));
        break;
      case 'close-all':
        closeMany(roots.map((t) => t.id));
        break;
    }
  };

  return (
    <Dropdown trigger={['contextMenu']} menu={{ items, onClick }} overlayClassName="tab-context-menu">
      <span onContextMenu={(e) => e.stopPropagation()}>{children}</span>
    </Dropdown>
  );
}

/** 重命名标签（只改显示的名称，不改主机） */
export function RenameModal({ tab, onClose }: { tab: Tab | null; onClose(): void }): React.JSX.Element {
  const [name, setName] = useState('');
  useEffect(() => {
    if (tab) setName(tab.title);
  }, [tab]);
  const ok = (): void => {
    if (tab && name.trim()) useTabs.getState().patch(tab.id, { title: name.trim().slice(0, 60) });
    onClose();
  };
  return (
    <Modal open={!!tab} title="重命名标签" okText="确定" cancelText="取消" onOk={ok} onCancel={onClose} destroyOnHidden width={380}>
      <Input value={name} onChange={(e) => setName(e.target.value)} onPressEnter={ok} maxLength={60} autoFocus data-testid="tab-rename-input" />
    </Modal>
  );
}
