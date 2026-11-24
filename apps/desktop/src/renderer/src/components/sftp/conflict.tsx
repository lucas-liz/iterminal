import { Radio, Space, Typography } from 'antd';
import type { HookAPI } from 'antd/es/modal/useModal';
import type { ConflictPolicy } from '@itm/protocol';

const OPTIONS: { value: ConflictPolicy; label: string; desc: string }[] = [
  { value: 'overwrite', label: '覆盖', desc: '用新文件替换目标' },
  { value: 'skip', label: '跳过', desc: '保留目标，不传这些文件' },
  { value: 'rename', label: '保留两者', desc: '新文件改名为「名称 (1).扩展名」' },
  { value: 'resume', label: '断点续传', desc: '目标比源小时从目标的大小继续传（适合中断过的大文件）' },
];

/**
 * 目标已有同名文件时让用户选择冲突策略（文档一 6.3）；取消返回 null。目录里的文件按同样的策略处理。
 */
export function askConflict(modal: HookAPI, names: string[]): Promise<ConflictPolicy | null> {
  let choice: ConflictPolicy = 'overwrite';
  return new Promise((resolve) => {
    modal.confirm({
      title: `目标已有 ${names.length} 个同名项目`,
      width: 480,
      icon: null,
      content: (
        <div data-testid="conflict-dialog">
          <Typography.Text code style={{ display: 'inline-block', marginBottom: 12, wordBreak: 'break-all' }}>
            {names.slice(0, 5).join('、')}
            {names.length > 5 ? ' …' : ''}
          </Typography.Text>
          <Radio.Group defaultValue="overwrite" onChange={(e) => (choice = e.target.value as ConflictPolicy)}>
            <Space direction="vertical">
              {OPTIONS.map((o) => (
                <Radio key={o.value} value={o.value} data-testid={`conflict-${o.value}`}>
                  <span style={{ fontWeight: 500 }}>{o.label}</span>
                  <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                    {o.desc}
                  </Typography.Text>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </div>
      ),
      okText: '继续',
      cancelText: '取消',
      onOk: () => resolve(choice),
      onCancel: () => resolve(null),
    });
  });
}
