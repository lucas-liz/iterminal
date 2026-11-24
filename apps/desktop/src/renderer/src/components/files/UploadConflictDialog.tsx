import { useEffect, useState } from 'react';
import { Button, Modal, Segmented, Select, Space, Table, Typography } from 'antd';
import type { ConflictPolicy } from '@itm/protocol';

export interface ConflictRow {
  name: string;
  localPath: string;
  remotePath: string;
  type: 'file' | 'dir';
}

const OPTIONS: { value: ConflictPolicy; label: string }[] = [
  { value: 'overwrite', label: '覆盖' },
  { value: 'skip', label: '跳过' },
  { value: 'rename', label: '保留两者' },
  { value: 'resume', label: '续传' },
];

/**
 * 上传前的同名冲突（第十六轮，参考 iShell）：逐个选择跳过 / 覆盖 / 保留两者（改名为「名称 (1)」）/ 断点续传，
 * 也可以用「默认对同名文件」一次改全部。没有冲突的文件照常上传。
 */
export function UploadConflictDialog({ rows, onOk, onCancel }: { rows: ConflictRow[] | null; onOk(choices: Record<string, ConflictPolicy>): void; onCancel(): void }): React.JSX.Element {
  const [def, setDef] = useState<ConflictPolicy>('overwrite');
  const [choices, setChoices] = useState<Record<string, ConflictPolicy>>({});
  useEffect(() => {
    if (!rows) return;
    setDef('overwrite');
    setChoices(Object.fromEntries(rows.map((r) => [r.localPath, 'overwrite' as ConflictPolicy])));
  }, [rows]);
  return (
    <Modal
      open={!!rows}
      width={860}
      onCancel={onCancel}
      destroyOnHidden
      title={
        <div>
          <div>检测到批量上传同名冲突</div>
          <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
            请先选择每一项（或批量）的处理方式，再开始上传
          </Typography.Text>
        </div>
      }
      footer={
        <Space>
          <Button onClick={onCancel}>取消</Button>
          <Button type="primary" onClick={() => onOk(choices)} data-testid="upload-conflict-ok">
            开始上传
          </Button>
        </Space>
      }
      data-testid="upload-conflict"
    >
      <div className="upload-conflict-head">
        <span>
          冲突数量：<b>{rows?.length ?? 0}</b>
        </span>
        <Space>
          <Typography.Text type="secondary">默认对同名文件：</Typography.Text>
          <Select
            value={def}
            style={{ width: 130 }}
            options={OPTIONS.map((o) => ({ ...o, label: o.value === 'resume' ? '断点续传' : o.label }))}
            onChange={(v) => {
              setDef(v);
              setChoices(Object.fromEntries((rows ?? []).map((r) => [r.localPath, v])));
            }}
            data-testid="upload-conflict-default"
          />
        </Space>
      </div>
      <Table<ConflictRow>
        size="small"
        rowKey="localPath"
        pagination={false}
        dataSource={rows ?? []}
        scroll={{ y: 360 }}
        columns={[
          {
            title: '文件',
            key: 'file',
            width: 240,
            render: (_, r) => (
              <div style={{ minWidth: 0 }}>
                <div className="upload-conflict-name">{r.name}</div>
                <Typography.Text type="secondary" ellipsis={{ tooltip: r.localPath }} style={{ fontSize: 12, maxWidth: 220 }}>
                  {r.localPath}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: '远端路径',
            key: 'remote',
            render: (_, r) => (
              <div>
                <div className="mono selectable" style={{ wordBreak: 'break-all', fontSize: 12 }}>
                  {r.remotePath}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  类型：{r.type === 'dir' ? '目录（里面的同名文件按这里的选择处理）' : '文件'}
                </Typography.Text>
              </div>
            ),
          },
          {
            title: '处理',
            key: 'act',
            width: 270,
            render: (_, r) => (
              <Segmented<ConflictPolicy>
                size="small"
                value={choices[r.localPath] ?? def}
                options={OPTIONS}
                onChange={(v) => setChoices((c) => ({ ...c, [r.localPath]: v }))}
                data-testid={`upload-conflict-${r.name}`}
              />
            ),
          },
        ]}
      />
    </Modal>
  );
}
