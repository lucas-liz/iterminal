import { useEffect, useState } from 'react';
import { Alert, App, Button, Modal, Radio, Space, Spin, Typography } from 'antd';
import { FolderOpenOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { create } from 'zustand';
import { errorMessage, invoke } from '../../api';
import { runInTab } from '../../util/run-in-terminal';
import { absoluteOf, shCommands, type ShFix } from '../../util/sh-exec';

export interface ShExecTarget {
  /** 脚本所在主机；null = 本机 */
  hostId: string | null;
  /** 脚本路径：文件面板给绝对路径；终端里选中的可能是相对路径 */
  path: string;
  /** 相对路径时终端的当前目录（不知道时为 null，按相对路径执行） */
  cwd: string | null;
  /** 在这个终端里执行；null 时用这台主机已连接的终端，没有就新开一个 */
  tabId: string | null;
  /** 文件面板里的权限字符串（检查失败时参考） */
  perms?: string;
}

interface ShExecState {
  target: ShExecTarget | null;
  seq: number;
  show(t: ShExecTarget): void;
  close(): void;
}

export const useShExec = create<ShExecState>((set) => ({
  target: null,
  seq: 0,
  show: (target) => set((s) => ({ target, seq: s.seq + 1 })),
  close: () => set({ target: null }),
}));

type Check = { state: 'checking' } | { state: 'ok'; executable: boolean } | { state: 'missing'; reason: string } | { state: 'unknown'; reason: string };

/**
 * 执行 .sh 脚本（文件面板右键、终端里选中脚本名后右键）：先检查当前用户有没有执行权限——
 * 没有时提示，可以选「添加执行权限后执行」或「用 bash 执行」；然后选择「到目录下执行」（cd 到脚本目录再 ./脚本）或「直接执行」（完整路径）。
 * 命令发到终端里执行，输出就在终端里。
 */
export function ShExecDialog(): React.JSX.Element | null {
  const target = useShExec((s) => s.target);
  const seq = useShExec((s) => s.seq);
  if (!target) return null;
  return <ShExecBody key={seq} target={target} />;
}

function ShExecBody({ target }: { target: ShExecTarget }): React.JSX.Element {
  const { message } = App.useApp();
  const close = useShExec((s) => s.close);
  const abs = absoluteOf(target.path, target.cwd);
  const [check, setCheck] = useState<Check>(abs ? { state: 'checking' } : { state: 'unknown', reason: '不知道终端的当前目录，按相对路径在终端当前目录下执行' });
  const [fix, setFix] = useState<ShFix>('chmod');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!abs) return;
    let live = true;
    invoke('file.execCheck', { hostId: target.hostId, path: abs })
      .then((r) => {
        if (!live) return;
        if (!r.exists) setCheck({ state: 'missing', reason: `找不到 ${abs}` });
        else if (!r.isFile) setCheck({ state: 'missing', reason: `${abs} 不是普通文件` });
        else setCheck({ state: 'ok', executable: r.executable });
      })
      .catch((e) => {
        if (!live) return;
        // 检查不了（例如只有 FTP）：参考文件面板里的权限位
        const x = target.perms ? /x|s|t/.test(target.perms.slice(1)) : null;
        if (x === null) setCheck({ state: 'unknown', reason: `没能检查执行权限：${errorMessage(e)}` });
        else setCheck({ state: 'ok', executable: x });
      });
    return () => {
      live = false;
    };
  }, []);

  const noExec = check.state === 'ok' && !check.executable;
  const cmds = shCommands(target.path, target.cwd, noExec ? fix : 'none');
  const name = target.path.split('/').pop() ?? target.path;

  const run = async (command: string): Promise<void> => {
    setBusy(true);
    try {
      await runInTab(command, target.tabId, target.hostId);
      close();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const blocked = check.state === 'checking' || check.state === 'missing';
  return (
    <Modal
      open
      title={
        <span>
          <PlayCircleOutlined /> 执行脚本 {name}
        </span>
      }
      onCancel={close}
      width={560}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={close}>取消</Button>
          <Button icon={<FolderOpenOutlined />} disabled={blocked} loading={busy} onClick={() => void run(cmds.inDir)} data-testid="sh-exec-indir">
            到目录下执行
          </Button>
          <Button type="primary" icon={<PlayCircleOutlined />} disabled={blocked} loading={busy} onClick={() => void run(cmds.direct)} data-testid="sh-exec-direct">
            直接执行
          </Button>
        </Space>
      }
    >
      <div className="sh-exec" data-testid="sh-exec-dialog">
        <Typography.Text type="secondary" className="sh-exec-path mono">
          {abs ?? target.path}
        </Typography.Text>
        {check.state === 'checking' && (
          <div className="sh-exec-checking">
            <Spin size="small" /> 正在检查执行权限…
          </div>
        )}
        {check.state === 'missing' && <Alert type="error" showIcon message={check.reason} />}
        {check.state === 'unknown' && <Alert type="info" showIcon message={check.reason} />}
        {noExec && (
          <Alert
            type="warning"
            showIcon
            data-testid="sh-exec-noperm"
            message="当前登录用户没有这个脚本的执行权限"
            description={
              <Radio.Group value={fix} onChange={(e) => setFix(e.target.value as ShFix)} className="sh-exec-fix">
                <Radio value="chmod">先添加执行权限再执行（chmod u+x）</Radio>
                <Radio value="bash">用 bash 执行（不修改权限）</Radio>
              </Radio.Group>
            }
          />
        )}
        {!blocked && (
          <div className="sh-exec-cmds">
            <div className="sh-exec-cmd">
              <span className="sh-exec-label">到目录下执行</span>
              <code className="mono">{cmds.inDir}</code>
            </div>
            <div className="sh-exec-cmd">
              <span className="sh-exec-label">直接执行</span>
              <code className="mono">{cmds.direct}</code>
            </div>
            <Typography.Text type="secondary" className="sh-exec-hint">
              命令发到{target.tabId ? '当前' : '这台主机的'}终端里执行，输出显示在终端里；「到目录下执行」会切换终端的当前目录。
            </Typography.Text>
          </div>
        )}
      </div>
    </Modal>
  );
}
