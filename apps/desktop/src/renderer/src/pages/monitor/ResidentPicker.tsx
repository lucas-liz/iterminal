import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Segmented, Select, Space, Table, Tag, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Folder, Host } from '@itm/protocol';
import { useHosts } from '../../store/hosts';
import { hostMatches } from '../../util/monitor-attention';

/** 分组的完整路径：生产 / 华东 / web */
function folderPath(folders: Folder[], id: string | null): string {
  const names: string[] = [];
  for (let f = folders.find((x) => x.id === id); f; f = folders.find((x) => x.id === f!.parentId)) names.unshift(f.name);
  return names.join(' / ');
}

/**
 * 选择常驻监控的主机（第二十七轮）：列出所有 SSH 主机，勾选即常驻；可以按名称 / IP / 备注 / 标签搜索、按分组筛选，
 * 一次勾选整个分组或全部搜索结果。底部显示这次新增、移除了几台。
 */
export function ResidentPicker({
  open,
  selected,
  onClose,
  onSave,
  title = '常驻监控的主机',
  intro = '常驻主机在应用运行期间一直在后台采集（每台主机一条 SSH 通道，不在服务器上安装任何东西），记录历史趋势，随时查看。需要保存了密码或密钥的主机才能在后台连接。',
  saveText = '保存',
  markLabel = '常驻中',
}: {
  open: boolean;
  selected: string[];
  onClose(): void;
  onSave(ids: string[]): void;
  /** 批量执行等其他地方复用（第三十五轮） */
  title?: string;
  intro?: string;
  saveText?: string;
  /** 已选主机名后面的标记；空字符串不显示 */
  markLabel?: string;
}): React.JSX.Element {
  const hosts = useHosts((s) => s.hosts);
  const folders = useHosts((s) => s.folders);
  const [picked, setPicked] = useState<string[]>(selected);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState<string>('');
  const [only, setOnly] = useState<'all' | 'picked' | 'recent'>('all');

  useEffect(() => {
    if (!open) return;
    setPicked(selected);
    setQ('');
    setFolder('');
    setOnly('all');
  }, [open, selected]);

  const ssh = useMemo(() => hosts.filter((h) => h.protocol === 'SSH'), [hosts]);
  const folderOptions = useMemo(() => {
    const used = new Set(ssh.map((h) => h.folderId ?? ''));
    return [
      { value: '', label: '全部分组' },
      ...folders.filter((f) => used.has(f.id)).map((f) => ({ value: f.id, label: folderPath(folders, f.id) })),
      ...(used.has('') ? [{ value: '__none', label: '未分组' }] : []),
    ].sort((a, b) => (a.value === '' ? -1 : b.value === '' ? 1 : a.label.localeCompare(b.label)));
  }, [ssh, folders]);

  const rows = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    return ssh
      .filter((h) => {
        if (!hostMatches(h, q)) return false;
        if (folder === '__none' && h.folderId) return false;
        if (folder && folder !== '__none') {
          // 选中的分组及其子分组
          const f = folders.find((x) => x.id === h.folderId);
          if (!f || !f.path.includes(`/${folder}/`)) return false;
        }
        if (only === 'picked' && !picked.includes(h.id)) return false;
        if (only === 'recent' && !(h.lastConnectedAt && h.lastConnectedAt >= weekAgo)) return false;
        return true;
      })
      .sort((a, b) => Number(picked.includes(b.id)) - Number(picked.includes(a.id)) || a.name.localeCompare(b.name));
    // 勾选时不重新排序：只在打开、筛选变化时排
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ssh, q, folder, only, folders, open]);

  const added = picked.filter((id) => !selected.includes(id)).length;
  const removed = selected.filter((id) => !picked.includes(id)).length;
  const allShownPicked = rows.length > 0 && rows.every((h) => picked.includes(h.id));

  return (
    <Modal
      open={open}
      title={title}
      width={860}
      onCancel={onClose}
      destroyOnHidden
      footer={
        <Space style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`已选 ${picked.length} 台${added ? ` · 新增 ${added}` : ''}${removed ? ` · 移除 ${removed}` : ''}`}
          </Typography.Text>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" disabled={!added && !removed} onClick={() => onSave(picked)} data-testid="resident-save">
            {saveText}
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 10 }}>
        {intro}
      </Typography.Paragraph>
      <div className="resident-filters">
        <Input autoFocus allowClear prefix={<SearchOutlined />} placeholder="名称 / IP / 备注 / 标签（空格分开多个词）" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} data-testid="resident-search" />
        <Select value={folder} onChange={setFolder} options={folderOptions} style={{ width: 200 }} showSearch optionFilterProp="label" />
        <Segmented
          value={only}
          onChange={(v) => setOnly(v as typeof only)}
          options={[
            { value: 'all', label: '全部' },
            { value: 'picked', label: '已选' },
            { value: 'recent', label: '7 天内连过' },
          ]}
        />
        <Button
          onClick={() => setPicked(allShownPicked ? picked.filter((id) => !rows.some((h) => h.id === id)) : [...new Set([...picked, ...rows.map((h) => h.id)])])}
          disabled={!rows.length}
          data-testid="resident-pick-all"
        >
          {allShownPicked ? `取消这 ${rows.length} 台` : `全选这 ${rows.length} 台`}
        </Button>
      </div>
      <Table<Host>
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ y: 380 }}
        data-testid="resident-table"
        rowSelection={{ selectedRowKeys: picked, preserveSelectedRowKeys: true, onChange: (keys) => setPicked(keys as string[]), columnWidth: 40 }}
        onRow={(h) => ({ onClick: () => setPicked(picked.includes(h.id) ? picked.filter((x) => x !== h.id) : [...picked, h.id]), style: { cursor: 'pointer' } })}
        locale={{ emptyText: ssh.length ? '没有符合条件的主机' : '还没有 SSH 主机' }}
        columns={[
          {
            title: '名称',
            dataIndex: 'name',
            ellipsis: true,
            render: (v: string, h) => (
              <Space size={4}>
                <Typography.Text strong>{v}</Typography.Text>
                {markLabel && selected.includes(h.id) && (
                  <Tag bordered={false} color="blue">
                    {markLabel}
                  </Tag>
                )}
              </Space>
            ),
          },
          { title: '地址', key: 'addr', width: 170, ellipsis: true, render: (_, h) => <span className="mono">{h.address}</span> },
          { title: '分组', key: 'folder', width: 150, ellipsis: true, render: (_, h) => folderPath(folders, h.folderId) || <Typography.Text type="secondary">未分组</Typography.Text> },
          {
            title: '备注 / 标签',
            key: 'note',
            ellipsis: true,
            render: (_, h) => (
              <Space size={4}>
                {h.tags.slice(0, 2).map((t) => (
                  <Tag key={t} bordered={false}>
                    {t}
                  </Tag>
                ))}
                <Typography.Text type="secondary">{h.note ?? ''}</Typography.Text>
              </Space>
            ),
          },
          { title: '最近连接', dataIndex: 'lastConnectedAt', width: 100, render: (v: number | null) => (v ? dayjs(v).format('MM-DD HH:mm') : <Typography.Text type="secondary">—</Typography.Text>) },
        ]}
      />
    </Modal>
  );
}
