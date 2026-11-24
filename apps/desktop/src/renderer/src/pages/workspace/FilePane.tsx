import { useEffect, useMemo, useState } from 'react';
import { Button, Dropdown, Input, Modal, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileOutlined,
  FormOutlined,
  FolderAddOutlined,
  FolderFilled,
  FolderOpenOutlined,
  HomeOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { FileEntry } from '@itm/protocol';
import { formatSize, formatTime } from '../../util/format';

export const FILES_MIME = 'application/x-itm-files';

export type Side = 'local' | 'remote';

export interface PathOps {
  join(dir: string, name: string): string;
  parent(path: string): string;
}

interface Props {
  side: Side;
  title: string;
  path: string;
  home: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  pathOps: PathOps;
  onNavigate(path: string): void;
  onRefresh(): void;
  onMkdir(path: string): Promise<boolean>;
  onRename(from: string, to: string): Promise<boolean>;
  onDelete(entries: FileEntry[]): void;
  /** 传到另一侧（本地 → 远端为上传） */
  onTransfer(entries: FileEntry[]): void;
  /** 拖进来的文件：来自另一侧，或者来自系统（访达 / 资源管理器，只有远端接受） */
  onDropPaths(paths: string[], from: Side | 'os'): void;
  onReveal?(entry: FileEntry): void;
  /** 远端文件：内置编辑器 / 用系统默认程序编辑（保存后自动回传） */
  onEdit?(entry: FileEntry): void;
  onEditExternal?(entry: FileEntry): void;
}

type Dialog = { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry };

export function FilePane(props: Props): React.JSX.Element {
  const { side, path, entries, pathOps } = props;
  const [selected, setSelected] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(true);
  const [filter, setFilter] = useState('');
  const [pathInput, setPathInput] = useState(path);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState('');
  const [dropOver, setDropOver] = useState(false);

  useEffect(() => {
    setPathInput(path);
    setSelected([]);
    setFilter('');
  }, [path]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
  }, [entries, showHidden, filter]);
  const selectedEntries = visible.filter((e) => selected.includes(e.path));

  const submitDialog = async (): Promise<void> => {
    const n = name.trim();
    if (!n || !dialog) return;
    if (n.includes('/') || (side === 'local' && n.includes('\\'))) {
      return;
    }
    const ok =
      dialog.kind === 'mkdir'
        ? await props.onMkdir(pathOps.join(path, n))
        : await props.onRename(dialog.entry.path, pathOps.join(path, n));
    if (ok) setDialog(null);
  };

  const columns: ColumnsType<FileEntry> = [
    {
      title: '名称',
      dataIndex: 'name',
      ellipsis: true,
      sorter: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      render: (_, e) => (
        <Space size={6}>
          {e.type === 'dir' ? (
            <FolderFilled style={{ color: '#e8b64c' }} />
          ) : e.type === 'link' ? (
            <LinkOutlined />
          ) : (
            <FileOutlined style={{ color: 'var(--itm-text-secondary)' }} />
          )}
          <span className="selectable">{e.name}</span>
        </Space>
      ),
    },
    {
      title: '大小',
      dataIndex: 'size',
      width: 90,
      align: 'right',
      sorter: (a, b) => a.size - b.size,
      render: (v: number, e) => <Typography.Text type="secondary">{e.type === 'dir' ? '—' : formatSize(v)}</Typography.Text>,
    },
    {
      title: '修改时间',
      dataIndex: 'mtime',
      width: 140,
      sorter: (a, b) => a.mtime - b.mtime,
      render: (v: number) => <Typography.Text type="secondary">{formatTime(v)}</Typography.Text>,
    },
    ...(entries.some((e) => e.perms)
      ? [
          {
            title: '权限',
            dataIndex: 'perms',
            width: 100,
            render: (v: string) => <span className="mono">{v}</span>,
          },
        ]
      : []),
  ];

  const transferLabel = side === 'local' ? '上传' : '下载';

  return (
    <div
      className={`file-pane ${dropOver ? 'drop-over' : ''}`}
      data-testid={`pane-${side}`}
      onDragOver={(e) => {
        const types = e.dataTransfer.types;
        const fromOtherSide = types.includes(FILES_MIME);
        const fromOs = side === 'remote' && types.includes('Files');
        if (fromOtherSide || fromOs) {
          e.preventDefault();
          setDropOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropOver(false);
        const raw = e.dataTransfer.getData(FILES_MIME);
        if (raw) {
          const data = JSON.parse(raw) as { side: Side; paths: string[] };
          if (data.side !== side) props.onDropPaths(data.paths, data.side);
          return;
        }
        if (side === 'remote' && e.dataTransfer.files.length > 0) {
          const paths = Array.from(e.dataTransfer.files).map((f) => window.itm.getPathForFile(f)).filter(Boolean);
          props.onDropPaths(paths, 'os');
        }
      }}
    >
      <div className="file-pane-bar">
        <Typography.Text strong style={{ width: 36, flex: 'none' }}>
          {props.title}
        </Typography.Text>
        <Tooltip title="上一级">
          <Button size="small" icon={<ArrowUpOutlined />} onClick={() => props.onNavigate(pathOps.parent(path))} />
        </Tooltip>
        <Tooltip title="主目录">
          <Button size="small" icon={<HomeOutlined />} onClick={() => props.onNavigate(props.home)} />
        </Tooltip>
        <Input
          size="small"
          value={pathInput}
          className="mono"
          onChange={(e) => setPathInput(e.target.value)}
          onPressEnter={() => props.onNavigate(pathInput.trim() || path)}
          data-testid={`path-${side}`}
        />
        <Tooltip title="刷新">
          <Button size="small" icon={<ReloadOutlined />} loading={props.loading} onClick={props.onRefresh} data-testid={`refresh-${side}`} />
        </Tooltip>
      </div>
      <div className="file-pane-bar">
        <Button
          size="small"
          type="primary"
          icon={side === 'local' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
          disabled={selectedEntries.length === 0}
          onClick={() => props.onTransfer(selectedEntries)}
          data-testid={`transfer-${side}`}
        >
          {transferLabel}
        </Button>
        <Tooltip title="新建目录">
          <Button
            size="small"
            icon={<FolderAddOutlined />}
            onClick={() => {
              setName('');
              setDialog({ kind: 'mkdir' });
            }}
            data-testid={`mkdir-${side}`}
          />
        </Tooltip>
        <Tooltip title="重命名">
          <Button
            size="small"
            icon={<EditOutlined />}
            disabled={selectedEntries.length !== 1}
            onClick={() => {
              setName(selectedEntries[0].name);
              setDialog({ kind: 'rename', entry: selectedEntries[0] });
            }}
          />
        </Tooltip>
        <Tooltip title={side === 'local' ? '移到废纸篓' : '删除'}>
          <Button size="small" danger icon={<DeleteOutlined />} disabled={selectedEntries.length === 0} onClick={() => props.onDelete(selectedEntries)} data-testid={`delete-${side}`} />
        </Tooltip>
        <Tooltip title={showHidden ? '隐藏以 . 开头的文件' : '显示隐藏文件'}>
          <Button size="small" icon={showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />} onClick={() => setShowHidden((v) => !v)} />
        </Tooltip>
        {props.onEdit && (
          <Dropdown.Button
            size="small"
            disabled={selectedEntries.length !== 1 || selectedEntries[0].type !== 'file'}
            onClick={() => props.onEdit!(selectedEntries[0])}
            menu={{ items: [{ key: 'external', label: '用默认程序编辑（保存后自动回传）' }], onClick: () => props.onEditExternal?.(selectedEntries[0]) }}
            data-testid={`edit-${side}`}
          >
            <FormOutlined /> 编辑
          </Dropdown.Button>
        )}
        {props.onReveal && (
          <Tooltip title="在文件管理器中显示">
            <Button size="small" icon={<FolderOpenOutlined />} disabled={selectedEntries.length !== 1} onClick={() => props.onReveal!(selectedEntries[0])} />
          </Tooltip>
        )}
        <Input
          size="small"
          allowClear
          prefix={<SearchOutlined />}
          placeholder="过滤"
          style={{ marginLeft: 'auto', width: 140 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="file-pane-list">
        {props.error ? (
          <div style={{ padding: 16 }}>
            <Typography.Text type="danger">{props.error}</Typography.Text>
          </div>
        ) : (
          <Table<FileEntry>
            size="small"
            rowKey="path"
            columns={columns}
            dataSource={visible}
            pagination={false}
            loading={props.loading}
            showSorterTooltip={false}
            // 名称列没有固定宽度，窗格太窄时会被挤没：给表格一个最小宽度（名称至少 200px），不够时横向滚动
            scroll={{ x: 32 + 200 + 90 + 140 + (entries.some((e) => e.perms) ? 100 : 0) }}
            rowSelection={{ selectedRowKeys: selected, onChange: (keys) => setSelected(keys as string[]), columnWidth: 32 }}
            onRow={(entry) => ({
              'data-testid': `file-${side}-${entry.name}`,
              onClick: (e: React.MouseEvent) => {
                const multi = e.metaKey || e.ctrlKey;
                setSelected((cur) => (multi ? (cur.includes(entry.path) ? cur.filter((p) => p !== entry.path) : [...cur, entry.path]) : [entry.path]));
              },
              onDoubleClick: () => (entry.type === 'dir' ? props.onNavigate(entry.path) : props.onTransfer([entry])),
              draggable: true,
              onDragStart: (e: React.DragEvent) => {
                const paths = selected.includes(entry.path) ? selectedEntries.map((x) => x.path) : [entry.path];
                e.dataTransfer.setData(FILES_MIME, JSON.stringify({ side, paths }));
                e.dataTransfer.effectAllowed = 'copy';
              },
            })}
            locale={{ emptyText: '空目录' }}
          />
        )}
      </div>

      <Modal
        open={!!dialog}
        title={dialog?.kind === 'mkdir' ? '新建目录' : '重命名'}
        okText="确定"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setDialog(null)}
        onOk={() => void submitDialog()}
      >
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onPressEnter={() => void submitDialog()} data-testid={`dialog-name-${side}`} />
        {(name.includes('/') || (side === 'local' && name.includes('\\'))) && (
          <Typography.Text type="danger">名称不能包含路径分隔符</Typography.Text>
        )}
      </Modal>
    </div>
  );
}
