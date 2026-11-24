import { useEffect, useMemo, useState } from 'react';
import { useForwardImport } from '../../components/ForwardImport';
import { Alert, App, Button, Modal, Select, Space, Switch, Table, Tag, TreeSelect, Typography } from 'antd';
import { FolderOpenOutlined, SwapOutlined } from '@ant-design/icons';
import type { ImportItem, ImportPreview, ImportSource } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { folderOptions, useHosts } from '../../store/hosts';

const SOURCES: { value: ImportSource; label: string; pick: 'file' | 'dir' | 'either'; hint: string; extensions?: string[] }[] = [
  { value: 'SSH_CONFIG', label: 'OpenSSH（~/.ssh/config）', pick: 'file', hint: '读取 Host、HostName、Port、User、IdentityFile、ProxyJump；私钥文件会一起导入', extensions: ['*'] },
  { value: 'XSHELL', label: 'Xshell 会话目录', pick: 'either', hint: '选择 Xshell 的 Sessions 目录（子目录导入为分组）或单个 .xsh 文件；Xshell 保存的密码是加密的，不导入', extensions: ['xsh'] },
  { value: 'SECURECRT', label: 'SecureCRT 会话目录', pick: 'dir', hint: '选择 SecureCRT 配置目录下的 Sessions 目录；密码不导入' },
  { value: 'FINALSHELL', label: 'FinalShell', pick: 'dir', hint: '选择 FinalShell 安装目录下的 conn 目录；密码不导入' },
  { value: 'MOBAXTERM', label: 'MobaXterm（.mxtsessions）', pick: 'file', hint: '在 MobaXterm 里「导出会话」得到的 .mxtsessions 文件', extensions: ['mxtsessions'] },
  { value: 'ELECTERM', label: 'Electerm 书签', pick: 'file', hint: 'Electerm 导出的书签 JSON（包含的密码和私钥会一起导入）', extensions: ['json'] },
  { value: 'CSV', label: 'CSV 表格', pick: 'file', hint: '第一行是表头：名称、分组（用 / 分隔多级）、地址、端口、用户名、密码、标签、备注、跳板机', extensions: ['csv'] },
  { value: 'JSON', label: 'iTerminal 主机列表（JSON）', pick: 'file', hint: '从 iTerminal「导出」得到的 JSON（不含密码）', extensions: ['json'] },
];

/** 导入主机（文档一 6.5）：选择来源 → 预览（标出重复）→ 选择要导入的主机和目标分组 */
export function ImportDialog({ open, onClose, defaultFolderId }: { open: boolean; onClose(): void; defaultFolderId: string | null }): React.JSX.Element {
  const { message } = App.useApp();
  const folders = useHosts((s) => s.folders);
  const hosts = useHosts((s) => s.hosts);
  const reload = useHosts((s) => s.reload);
  const [source, setSource] = useState<ImportSource>('SSH_CONFIG');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState<string | null>(defaultFolderId);
  const [skipDup, setSkipDup] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = SOURCES.find((s) => s.value === source)!;

  useEffect(() => {
    if (open) {
      setPreview(null);
      setError(null);
      setTarget(defaultFolderId);
    }
  }, [open]);

  const load = async (path: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const p = await invoke('import.preview', { source, path });
      setPreview(p);
      setSelected(p.items.filter((i) => !i.duplicateOf).map((i) => i.key));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const pick = async (kind: 'file' | 'dir'): Promise<void> => {
    const path =
      kind === 'dir'
        ? await invoke('dialog.openDirectory', { title: `选择${meta.label}` })
        : await invoke('dialog.openFile', { title: `选择${meta.label}`, filters: meta.extensions && meta.extensions[0] !== '*' ? [{ name: meta.label, extensions: meta.extensions }] : undefined });
    if (path) await load(path);
  };

  const commit = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    try {
      const r = await invoke('import.commit', { token: preview.token, keys: selected, targetFolderId: target, skipDuplicates: skipDup });
      await reload();
      message.success(`导入了 ${r.createdHosts} 台主机${r.createdFolders ? `、${r.createdFolders} 个分组` : ''}${r.skipped ? `，跳过 ${r.skipped} 台重复的主机` : ''}`);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const hostName = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);

  return (
    <Modal
      open={open}
      title="导入主机"
      width={860}
      onCancel={onClose}
      destroyOnHidden
      maskClosable={false}
      footer={
        preview ? (
          <Space>
            <Button onClick={() => setPreview(null)}>重新选择</Button>
            <Button type="primary" loading={busy} disabled={selected.length === 0} onClick={() => void commit()} data-testid="import-commit">
              {`导入 ${selected.length} 台`}
            </Button>
          </Space>
        ) : (
          <Space>
            <Button
              icon={<SwapOutlined />}
              onClick={() => {
                onClose();
                useForwardImport.getState().show(null);
              }}
              data-testid="import-ssh-forward"
            >
              从 ssh 端口转发命令导入
            </Button>
            <Button onClick={onClose}>取消</Button>
          </Space>
        )
      }
    >
      {!preview ? (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Select style={{ width: '100%' }} value={source} onChange={setSource} options={SOURCES.map((s) => ({ value: s.value, label: s.label }))} data-testid="import-source" />
          <Typography.Text type="secondary">{meta.hint}</Typography.Text>
          <Space>
            {source === 'SSH_CONFIG' && (
              <Button type="primary" loading={busy} onClick={() => void load('')}>
                读取 ~/.ssh/config
              </Button>
            )}
            {(meta.pick === 'file' || meta.pick === 'either') && (
              <Button icon={<FolderOpenOutlined />} loading={busy} onClick={() => void pick('file')}>
                选择文件…
              </Button>
            )}
            {(meta.pick === 'dir' || meta.pick === 'either') && (
              <Button icon={<FolderOpenOutlined />} loading={busy} onClick={() => void pick('dir')}>
                选择目录…
              </Button>
            )}
          </Space>
          {error && <Alert type="error" showIcon message={error} />}
        </Space>
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          {preview.warnings.length > 0 && (
            <Alert type="warning" showIcon message={`${preview.warnings.length} 条提示`} description={<ul style={{ margin: 0, paddingLeft: 18, maxHeight: 100, overflow: 'auto' }}>{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>} />
          )}
          <Space wrap>
            <Typography.Text>导入到</Typography.Text>
            <TreeSelect style={{ width: 240 }} allowClear placeholder="顶层" value={target ?? undefined} onChange={(v) => setTarget(v ?? null)} treeData={folderOptions(folders)} treeDefaultExpandAll />
            <Switch size="small" checked={skipDup} onChange={setSkipDup} />
            <Typography.Text type="secondary">跳过已存在的主机（协议、地址、端口、用户名都相同）</Typography.Text>
          </Space>
          <Table<ImportItem>
            size="small"
            rowKey="key"
            dataSource={preview.items}
            pagination={preview.items.length > 200 ? { pageSize: 200 } : false}
            scroll={{ y: 360 }}
            rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) }}
            columns={[
              { title: '名称', dataIndex: 'name', ellipsis: true },
              { title: '分组', key: 'folder', ellipsis: true, render: (_, i) => <Typography.Text type="secondary">{i.folderPath.join(' / ') || '—'}</Typography.Text> },
              { title: '地址', key: 'addr', render: (_, i) => <span className="mono">{`${i.username ? `${i.username}@` : ''}${i.address}:${i.port}`}</span> },
              {
                title: '认证',
                key: 'auth',
                width: 110,
                render: (_, i) => (i.hasPrivateKey ? <Tag bordered={false}>私钥</Tag> : i.hasPassword ? <Tag bordered={false}>密码</Tag> : <Tag bordered={false}>{i.authMethod === 'AGENT' ? 'Agent' : '询问'}</Tag>),
              },
              {
                title: '',
                key: 'dup',
                width: 150,
                render: (_, i) =>
                  i.duplicateOf ? (
                    <Tag color="orange" bordered={false}>{`已存在：${hostName.get(i.duplicateOf!) ?? ''}`}</Tag>
                  ) : i.protocol !== 'SSH' ? (
                    <Tag bordered={false}>{i.protocol}</Tag>
                  ) : null,
              },
            ]}
          />
          {error && <Alert type="error" showIcon message={error} />}
        </Space>
      )}
    </Modal>
  );
}
