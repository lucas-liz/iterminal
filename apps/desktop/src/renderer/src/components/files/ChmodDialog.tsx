import { useEffect, useState } from 'react';
import { Checkbox, Input, Modal, Space, Typography } from 'antd';
import type { FileEntry } from '@itm/protocol';

const WHO = [
  { key: 'u', label: '所有者', shift: 6 },
  { key: 'g', label: '用户组', shift: 3 },
  { key: 'o', label: '其他人', shift: 0 },
] as const;
const BITS = [
  { label: '读', bit: 4 },
  { label: '写', bit: 2 },
  { label: '执行', bit: 1 },
] as const;

/** drwxr-xr-x → 0o755 */
export function modeOfPerms(perms: string): number {
  const p = (perms ?? '').slice(-9);
  if (p.length < 9) return 0o644;
  let m = 0;
  // s / t：执行位 + 特殊位；S / T：只有特殊位（执行位没有）
  for (let i = 0; i < 9; i++) if (/[rwxst]/.test(p[i])) m |= 1 << (8 - i);
  return m;
}

/** 修改权限（第十六轮，参考 iShell）：按位勾选或直接输入八进制，目录可以递归 */
export function ChmodDialog({ entries, onOk, onCancel }: { entries: FileEntry[] | null; onOk(mode: number, recursive: boolean): Promise<void>; onCancel(): void }): React.JSX.Element {
  const [mode, setMode] = useState(0o644);
  const [text, setText] = useState('644');
  const [recursive, setRecursive] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!entries?.length) return;
    const m = modeOfPerms(entries[0].perms);
    setMode(m);
    setText(m.toString(8).padStart(3, '0'));
    setRecursive(false);
  }, [entries]);
  const set = (m: number): void => {
    setMode(m);
    setText(m.toString(8).padStart(3, '0'));
  };
  const hasDir = !!entries?.some((e) => e.type === 'dir');
  const title = entries?.length === 1 ? `修改权限 · ${entries[0].name}` : `修改权限 · ${entries?.length ?? 0} 项`;
  return (
    <Modal
      open={!!entries}
      title={title}
      onCancel={onCancel}
      okText="应用"
      cancelText="取消"
      confirmLoading={busy}
      destroyOnHidden
      width={420}
      onOk={async () => {
        setBusy(true);
        try {
          await onOk(mode, recursive);
        } finally {
          setBusy(false);
        }
      }}
      data-testid="chmod-dialog"
    >
      <table className="chmod-table">
        <thead>
          <tr>
            <th />
            {BITS.map((b) => (
              <th key={b.label}>{b.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((w) => (
            <tr key={w.key}>
              <td>{w.label}</td>
              {BITS.map((b) => {
                const bit = b.bit << w.shift;
                return (
                  <td key={b.label}>
                    <Checkbox checked={(mode & bit) !== 0} onChange={(e) => set(e.target.checked ? mode | bit : mode & ~bit)} data-testid={`chmod-${w.key}${b.bit}`} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <Space style={{ marginTop: 12 }}>
        <Typography.Text type="secondary">八进制</Typography.Text>
        <Input
          className="mono"
          style={{ width: 90 }}
          value={text}
          maxLength={4}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-7]/g, '');
            setText(v);
            if (v.length >= 3) setMode(parseInt(v, 8));
          }}
          data-testid="chmod-octal"
        />
        {hasDir && (
          <Checkbox checked={recursive} onChange={(e) => setRecursive(e.target.checked)} data-testid="chmod-recursive">
            包含子目录和文件
          </Checkbox>
        )}
      </Space>
    </Modal>
  );
}
