import { useMemo, useState } from 'react';
import { App, Button, Dropdown, Form, Input, Modal, Radio, Space, Tree, Typography, type TreeDataNode, type TreeProps } from 'antd';
import { DatabaseOutlined, FolderOpenOutlined, FolderOutlined, KeyOutlined, PlusOutlined, SafetyOutlined, StarFilled } from '@ant-design/icons';
import type { Folder, FolderDeleteStrategy } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { openHost } from '../../actions';
import { useSkillRun } from '../../components/agent/SkillRunDialog';
import { ALL_HOSTS, FAVORITES, useHosts } from '../../store/hosts';
import { useApp } from '../../store/app';
import { dueCredentials, useVault } from '../../store/vault';
import { FolderSettingsModal } from './FolderSettingsModal';
import { freshOnOpen } from '../../util/fresh';
import { useShare } from '../../store/share';

export const HOSTS_MIME = 'application/x-itm-hosts';

type NameDialog = { mode: 'create'; parentId: string | null } | { mode: 'rename'; folder: Folder };

interface Props {
  onCreateHost(folderId: string | null): void;
}

export function FolderTree({ onCreateHost }: Props): React.JSX.Element {
  const { message } = App.useApp();
  const folders = useHosts((s) => s.folders);
  const hosts = useHosts((s) => s.hosts);
  const selected = useHosts((s) => s.selected);
  const select = useHosts((s) => s.select);
  const reload = useHosts((s) => s.reload);
  const [expanded, setExpanded] = useState<React.Key[]>([ALL_HOSTS]);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [deleting, setDeleting] = useState<Folder | null>(null);
  const [settingsOf, setSettingsOf] = useState<Folder | null>(null);
  const [dropOver, setDropOver] = useState<string | null>(null);

  /** 每个分组（含子分组）下的主机数 */
  const counts = useMemo(() => {
    const byFolder = new Map<string, number>();
    hosts.forEach((h) => h.folderId && byFolder.set(h.folderId, (byFolder.get(h.folderId) ?? 0) + 1));
    const total = new Map<string, number>();
    folders.forEach((f) => {
      const n = folders.filter((x) => x.path.startsWith(f.path)).reduce((acc, x) => acc + (byFolder.get(x.id) ?? 0), 0);
      total.set(f.id, n);
    });
    return total;
  }, [folders, hosts]);

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<boolean> => {
    try {
      await fn();
      await reload();
      if (ok) message.success(ok);
      return true;
    } catch (e) {
      message.error(errorMessage(e));
      return false;
    }
  };

  const moveHosts = (ids: string[], folderId: string | null): void => {
    void run(() => invoke('host.move', { hostIds: ids, folderId }), `已移动 ${ids.length} 台主机`);
  };

  const title = (key: string, label: string, folder: Folder | null, count: number): React.ReactNode => {
    const content = (
      <span
        className={`tree-title ${dropOver === key ? 'drop-over' : ''}`}
        data-testid={folder ? `folder-${folder.name}` : 'folder-all'}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(HOSTS_MIME)) {
            e.preventDefault();
            e.stopPropagation();
            setDropOver(key);
          }
        }}
        onDragLeave={() => setDropOver((k) => (k === key ? null : k))}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(HOSTS_MIME);
          setDropOver(null);
          if (raw) {
            e.preventDefault();
            e.stopPropagation();
            const ids = JSON.parse(raw) as string[];
            if (key === FAVORITES) void run(() => Promise.all(ids.map((id) => invoke('host.favorite', { id, on: true }))), `已收藏 ${ids.length} 台主机`);
            else moveHosts(ids, folder?.id ?? null);
          }
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
        {folder && (folder.production || folder.agentPolicy || folder.defaultCredentialId || folder.defaultJumpHostId) && (
          <SafetyOutlined className="tree-badge" title={folder.production ? '生产环境' : '有分组设置'} style={{ color: folder.production ? '#ff7a45' : undefined }} />
        )}
        <span className="count">{count}</span>
      </span>
    );
    const items = folder
      ? [
          { key: 'new', label: '新建子分组' },
          { key: 'host', label: '在此新建主机' },
          { key: 'rename', label: '重命名' },
          { key: 'settings', label: '分组设置…' },
          { key: 'connect', label: '批量连接（包含子分组）', disabled: count === 0 },
          { key: 'skill', label: '对整个分组运行 Skill…', disabled: count === 0 },
          { key: 'share', label: folder.team ? '分享整个分组…（团队分组不能分享）' : '分享整个分组…', disabled: count === 0 || !!folder.team },
          { type: 'divider' as const },
          { key: 'delete', label: '删除分组', danger: true },
        ]
      : key === FAVORITES
        ? []
        : [
            { key: 'new', label: '新建分组' },
            { key: 'host', label: '新建主机' },
          ];
    return (
      <Dropdown
        trigger={['contextMenu']}
        menu={{
          items,
          onClick: ({ key: action, domEvent }) => {
            domEvent.stopPropagation();
            if (action === 'new') setNameDialog({ mode: 'create', parentId: folder?.id ?? null });
            if (action === 'host') onCreateHost(folder?.id ?? null);
            if (action === 'rename' && folder) setNameDialog({ mode: 'rename', folder });
            if (action === 'settings' && folder) setSettingsOf(folder);
            if (action === 'share' && folder) useShare.getState().open({ folderIds: [folder.id] });
            if (action === 'connect' && folder) {
              const ids = new Set(folders.filter((f) => f.path.startsWith(folder.path)).map((f) => f.id));
              const list = hosts.filter((h) => h.folderId && ids.has(h.folderId));
              if (list.length > 20) {
                message.warning(`分组里有 ${list.length} 台主机，一次最多批量连接 20 台`);
              }
              list.slice(0, 20).forEach((h) => openHost(h, 'ssh'));
            }
            if (action === 'delete' && folder) setDeleting(folder);
            if (action === 'skill' && folder) useSkillRun.getState().show({ targets: { folderIds: [folder.id] } });
          },
        }}
      >
        {content}
      </Dropdown>
    );
  };

  const treeData = useMemo((): TreeDataNode[] => {
    const build = (parentId: string | null): TreeDataNode[] =>
      folders
        .filter((f) => f.parentId === parentId)
        .map((f) => ({
          key: f.id,
          title: title(f.id, f.name, f, counts.get(f.id) ?? 0),
          icon: ({ expanded: open }: { expanded?: boolean }) => (open ? <FolderOpenOutlined /> : <FolderOutlined />),
          children: build(f.id),
        }));
    const favCount = hosts.filter((h) => h.favorite).length;
    return [
      ...(favCount > 0 ? [{ key: FAVORITES, title: title(FAVORITES, '收藏', null, favCount), icon: <StarFilled style={{ color: '#fadb14' }} />, isLeaf: true }] : []),
      {
        key: ALL_HOSTS,
        title: title(ALL_HOSTS, '全部主机', null, hosts.length),
        icon: <DatabaseOutlined />,
        children: build(null),
      },
    ];
    // title 依赖 dropOver（拖拽高亮），需要随之重建
  }, [folders, hosts, counts, dropOver]);

  /** 拖到分组上 = 移进去；拖到两个分组之间 = 调整顺序（beforeId 为排在它后面的那个分组） */
  const onDrop: TreeProps['onDrop'] = (info) => {
    const dragId = String(info.dragNode.key);
    const target = String(info.node.key);
    if (target === FAVORITES) return;
    let parentId: string | null;
    let beforeId: string | null | undefined;
    if (target === ALL_HOSTS) {
      parentId = null;
    } else if (info.dropToGap) {
      const t = folders.find((f) => f.id === target);
      parentId = t?.parentId ?? null;
      const siblings = folders.filter((f) => f.parentId === parentId && f.id !== dragId);
      const idx = siblings.findIndex((f) => f.id === target);
      const relative = info.dropPosition - Number(String(info.node.pos).split('-').pop());
      beforeId = relative < 0 ? target : (siblings[idx + 1]?.id ?? null);
    } else {
      parentId = target;
    }
    void run(() => invoke('folder.move', { id: dragId, parentId, beforeId }));
  };

  return (
    <div className="folder-panel">
      <div className="folder-panel-header">
        <span>主机分组</span>
        <Button
          size="small"
          type="text"
          icon={<PlusOutlined />}
          data-testid="new-folder"
          onClick={() => setNameDialog({ mode: 'create', parentId: selected === ALL_HOSTS ? null : selected })}
        />
      </div>
      <div className="folder-tree">
        <Tree
          showIcon
          blockNode
          draggable={{ icon: false, nodeDraggable: (n) => n.key !== ALL_HOSTS && n.key !== FAVORITES }}
          allowDrop={({ dropNode, dropPosition }) => dropNode.key !== FAVORITES && !(dropNode.key === ALL_HOSTS && dropPosition !== 0)}
          treeData={treeData}
          selectedKeys={[selected]}
          expandedKeys={expanded}
          onExpand={setExpanded}
          onSelect={(keys) => keys[0] !== undefined && select(String(keys[0]))}
          onDrop={onDrop}
        />
      </div>
      <div className="folder-panel-foot">
        <CredentialButton />
      </div>

      <NameModal
        dialog={nameDialog}
        onClose={() => setNameDialog(null)}
        onSubmit={async (name) => {
          if (!nameDialog) return false;
          if (nameDialog.mode === 'create') {
            return run(async () => {
              const f = await invoke('folder.create', { parentId: nameDialog.parentId, name });
              setExpanded((keys) => [...new Set([...keys, nameDialog.parentId ?? ALL_HOSTS])]);
              select(f.id);
            });
          }
          return run(() => invoke('folder.rename', { id: nameDialog.folder.id, name }));
        }}
      />
      <FolderSettingsModal folder={settingsOf} onClose={() => setSettingsOf(null)} onSaved={() => void reload()} />
      <DeleteFolderModal
        folder={deleting}
        hostCount={deleting ? (counts.get(deleting.id) ?? 0) : 0}
        subCount={deleting ? folders.filter((f) => f.path.startsWith(deleting.path) && f.id !== deleting.id).length : 0}
        onClose={() => setDeleting(null)}
        onSubmit={(strategy) => run(() => invoke('folder.delete', { id: deleting!.id, strategy }), '分组已删除')}
      />
    </div>
  );
}

/** 左下角的凭证管理入口：点击打开凭证管理小窗；有需要轮换 / 即将到期的凭证时显示数量 */
function CredentialButton(): React.JSX.Element {
  const due = dueCredentials(useVault((s) => s.credentials)).length;
  // 和凭证列表一致：只数共享凭证（主机自己保存的密码 / 私钥不算）
  const total = useVault((s) => s.credentials.filter((c) => !c.ownerHostId).length);
  return (
    <Button block icon={<KeyOutlined />} onClick={() => useApp.getState().setVaultOpen(true)} data-testid="open-vault" className="foot-btn">
      凭证管理
      {due > 0 ? (
        <span className="foot-badge warn" title={`${due} 个凭证需要轮换或即将到期`}>
          {due}
        </span>
      ) : (
        total > 0 && <span className="foot-badge">{total}</span>
      )}
    </Button>
  );
}

function NameModalDialog({
  dialog,
  onClose,
  onSubmit,
}: {
  dialog: NameDialog | null;
  onClose(): void;
  onSubmit(name: string): Promise<boolean>;
}): React.JSX.Element {
  const [form] = Form.useForm<{ name: string }>();
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      open={!!dialog}
      title={dialog?.mode === 'rename' ? '重命名分组' : '新建分组'}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
      onCancel={onClose}
      onOk={async () => {
        let name: string;
        try {
          ({ name } = await form.validateFields());
        } catch {
          return; // 校验提示已经显示在表单上
        }
        setSaving(true);
        const ok = await onSubmit(name.trim());
        setSaving(false);
        if (ok) onClose();
      }}
    >
      {/* 每次打开都重新挂载（destroyOnHidden），初值用 initialValues，避免打开动画结束后才重置而覆盖用户输入 */}
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ name: dialog?.mode === 'rename' ? dialog.folder.name : '' }}
        onFinish={() => undefined}
      >
        <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true, message: '请填写名称' }, { max: 64 }]}>
          <Input autoFocus placeholder="例如：生产环境" data-testid="folder-name-input" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const NameModal = freshOnOpen(NameModalDialog, (p) => p.dialog);

function DeleteFolderModal({
  folder,
  hostCount,
  subCount,
  onClose,
  onSubmit,
}: {
  folder: Folder | null;
  hostCount: number;
  subCount: number;
  onClose(): void;
  onSubmit(strategy: FolderDeleteStrategy): Promise<boolean>;
}): React.JSX.Element {
  const [strategy, setStrategy] = useState<FolderDeleteStrategy>('MOVE_TO_PARENT');
  const empty = hostCount === 0 && subCount === 0;
  return (
    <Modal
      open={!!folder}
      title={`删除分组「${folder?.name ?? ''}」`}
      okText="删除"
      okButtonProps={{ danger: true }}
      cancelText="取消"
      destroyOnHidden
      onCancel={onClose}
      onOk={async () => {
        if (await onSubmit(empty ? 'MOVE_TO_PARENT' : strategy)) onClose();
      }}
    >
      {empty ? (
        <Typography.Text>这个分组是空的。</Typography.Text>
      ) : (
        <Space direction="vertical">
          <Typography.Text>{`其中有 ${subCount} 个子分组、${hostCount} 台主机，删除后：`}</Typography.Text>
          <Radio.Group value={strategy} onChange={(e) => setStrategy(e.target.value as FolderDeleteStrategy)}>
            <Space direction="vertical">
              <Radio value="MOVE_TO_PARENT">子分组和主机移到上一级（推荐）</Radio>
              <Radio value="CASCADE">
                <Typography.Text type="danger">连同子分组和主机一起删除</Typography.Text>
              </Radio>
            </Space>
          </Radio.Group>
        </Space>
      )}
    </Modal>
  );
}
