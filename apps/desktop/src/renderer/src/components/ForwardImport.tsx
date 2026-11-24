import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Button, Checkbox, Input, Modal, Space, Table, Tag, Typography } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import { create } from 'zustand';
import { buildSshForwardCommand, parseSshForwardCommand, sameForward, type Host, type PortForwardInput, type PortForwardType } from '@itm/protocol';
import { errorMessage, invoke } from '../api';
import { useForwards } from '../store/forwards';
import { useHosts } from '../store/hosts';

const TYPE_TAG: Record<PortForwardType, { text: string; color: string }> = {
  LOCAL: { text: '本地 -L', color: 'blue' },
  REMOTE: { text: '远程 -R', color: 'purple' },
  DYNAMIC: { text: 'SOCKS5 -D', color: 'cyan' },
};

/** 从 ssh 命令导入端口转发：hostId 为空时按命令里的地址找主机，找不到就新建 */
export const useForwardImport = create<{ open: boolean; hostId: string | null; show(hostId: string | null): void; hide(): void }>((set) => ({
  open: false,
  hostId: null,
  show: (hostId) => set({ open: true, hostId }),
  hide: () => set({ open: false }),
}));

const EXAMPLE = 'ssh -p 2222 -L 8848:10.20.0.39:8848 -L 16379:10.20.0.39:6379 root@10.10.0.90';
const hostLabel = (h: { username: string | null; address: string; port: number | null }): string => `${h.username ? `${h.username}@` : ''}${h.address}${h.port && h.port !== 22 ? `:${h.port}` : ''}`;

export function ForwardImportDialog(): React.JSX.Element {
  const { message } = App.useApp();
  const { open, hostId } = useForwardImport();
  const hosts = useHosts((s) => s.hosts);
  const forwards = useForwards((s) => s.forwards);
  const [cmd, setCmd] = useState('');
  const [name, setName] = useState('');
  const [autoStart, setAutoStart] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setCmd('');
      setName('');
      setAutoStart(false);
      void useForwards.getState().reload();
    }
  }, [open]);

  const parsed = useMemo(() => (cmd.trim() ? parseSshForwardCommand(cmd) : null), [cmd]);
  const fixed = hostId ? hosts.find((h) => h.id === hostId) : undefined;
  // 没有指定主机：按地址、端口（和用户名）找已有的 SSH 主机
  const matched = useMemo<Host | undefined>(() => {
    if (fixed || !parsed?.host) return undefined;
    const p = parsed.host;
    return hosts.find((h) => h.protocol === 'SSH' && h.address === p.address && (h.port || 22) === p.port && (!p.username || h.username === p.username));
  }, [fixed, parsed, hosts]);
  const target = fixed ?? matched;
  const existing = target ? forwards.filter((f) => f.hostId === target.id) : [];
  const rows = (parsed?.forwards ?? []).map((f, i) => ({ ...f, key: i, exists: existing.some((e) => sameForward(e, f)) }));
  const toAdd = rows.filter((r) => !r.exists);
  const differs = fixed && parsed?.host && (fixed.address !== parsed.host.address || (fixed.port || 22) !== parsed.host.port || (parsed.host.username && parsed.host.username !== fixed.username));
  const willCreate = !target && !!parsed?.host;

  const submit = async (): Promise<void> => {
    if (!parsed || !toAdd.length) return;
    setBusy(true);
    try {
      let id = target?.id;
      if (!id) {
        const h = parsed.host!;
        const created = await invoke('host.create', {
          folderId: null,
          name: name.trim() || hostLabel(h),
          address: h.address,
          port: h.port,
          username: h.username ?? 'root',
          authMethod: 'INTERACTIVE',
          keepaliveSec: 30,
          startupScript: null,
          note: '从 ssh 端口转发命令导入',
          jumpHostIds: [],
        });
        id = created.id;
        await useHosts.getState().reload();
      }
      for (const f of toAdd) {
        const input: PortForwardInput = { type: f.type, bindAddr: f.bindAddr, bindPort: f.bindPort, targetAddr: f.targetAddr, targetPort: f.targetPort, autoStart };
        await invoke('portforward.save', { id: null, hostId: id, input });
      }
      await useForwards.getState().reload();
      message.success(`导入了 ${toAdd.length} 条端口转发${rows.length > toAdd.length ? `（${rows.length - toAdd.length} 条已存在，跳过）` : ''}`);
      useForwardImport.getState().hide();
      useForwards.getState().open(id);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="从 ssh 命令导入端口转发"
      width={760}
      okText={toAdd.length ? `导入 ${toAdd.length} 条` : '导入'}
      cancelText="取消"
      okButtonProps={{ disabled: !toAdd.length, 'data-testid': 'pf-import-ok' } as never}
      confirmLoading={busy}
      onOk={() => void submit()}
      onCancel={() => useForwardImport.getState().hide()}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        粘贴 OpenSSH 的端口转发命令，支持 -L（本地）、-R（远程）、-D（SOCKS5）、-p、-o LocalForward 等写法；密码和私钥不会导入。
      </Typography.Paragraph>
      <Input.TextArea value={cmd} onChange={(e) => setCmd(e.target.value)} autoSize={{ minRows: 3, maxRows: 8 }} className="mono" placeholder={EXAMPLE} spellCheck={false} data-testid="pf-import-text" />
      {parsed && (
        <div className="pf-import-result">
          {parsed.host && (
            <div className="pf-import-host" data-testid="pf-import-host">
              {fixed ? (
                <>
                  导入到当前主机 <Typography.Text strong>{fixed.name}</Typography.Text>
                </>
              ) : matched ? (
                <>
                  命令里的 {hostLabel(parsed.host)} 对应已有主机 <Typography.Text strong>{matched.name}</Typography.Text>
                </>
              ) : (
                <Space wrap>
                  <span>
                    没有找到 {hostLabel(parsed.host)}，会新建这台主机（连接时询问密码，可以之后在主机设置里修改）：
                  </span>
                  <Input size="small" style={{ width: 220 }} placeholder={hostLabel(parsed.host)} value={name} onChange={(e) => setName(e.target.value)} data-testid="pf-import-name" />
                </Space>
              )}
            </div>
          )}
          {differs && <Alert type="warning" showIcon style={{ marginTop: 8 }} message={`命令里的主机是 ${hostLabel(parsed.host!)}，和当前主机（${hostLabel(fixed)}）不同；转发规则会导入到当前主机`} />}
          {parsed.warnings.length > 0 && <Alert type="info" showIcon style={{ marginTop: 8 }} message={parsed.warnings.join('；')} data-testid="pf-import-warnings" />}
          {rows.length > 0 && (
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={rows}
              style={{ marginTop: 8 }}
              scroll={{ y: 260 }}
              data-testid="pf-import-table"
              columns={[
                { title: '类型', dataIndex: 'type', width: 110, render: (t: PortForwardType) => <Tag color={TYPE_TAG[t].color}>{TYPE_TAG[t].text}</Tag> },
                { title: '监听', key: 'bind', render: (_, f) => <span className="mono">{`${f.bindAddr}:${f.bindPort}`}</span> },
                { title: '目标', key: 'target', render: (_, f) => <span className="mono">{f.type === 'DYNAMIC' ? '任意（SOCKS5）' : `${f.targetAddr}:${f.targetPort}`}</span> },
                { title: '', key: 'state', width: 90, render: (_, f) => (f.exists ? <Tag bordered={false}>已存在</Tag> : <Tag color="green" bordered={false}>新增</Tag>) },
              ]}
            />
          )}
          {willCreate || target ? (
            <Checkbox checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} style={{ marginTop: 8 }}>
              打开这台主机的终端时自动启动这些转发
            </Checkbox>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** 把一台主机的端口转发生成 OpenSSH 命令（可以在别的电脑上直接执行） */
export function ForwardCommand({ host, open, onClose }: { host: Host | undefined; open: boolean; onClose(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const hosts = useHosts((s) => s.hosts);
  const forwards = useForwards((s) => s.forwards);
  const [noShell, setNoShell] = useState(false);
  const list = host ? forwards.filter((f) => f.hostId === host.id) : [];
  const jumps = (host?.jumpHostIds ?? []).map((id) => hosts.find((h) => h.id === id)).filter((h): h is Host => !!h).map((h) => hostLabel(h));
  const cmd = host && list.length ? buildSshForwardCommand({ address: host.address, port: host.port, username: host.username || null }, list, { noShell, jumps }) : '';
  return (
    <Modal open={open} title="生成 ssh 命令" width={760} footer={null} onCancel={onClose} destroyOnHidden>
      {cmd ? (
        <>
          <pre className="pf-command mono selectable" data-testid="pf-command">
            {cmd}
          </pre>
          <Space>
            <Button type="primary" icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(cmd).then(() => message.success('已复制'))} data-testid="pf-command-copy">
              复制命令
            </Button>
            <Checkbox checked={noShell} onChange={(e) => setNoShell(e.target.checked)}>
              加 -N（只转发，不打开 shell）
            </Checkbox>
          </Space>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            包含这台主机的全部 {list.length} 条转发{jumps.length ? '和跳板机（-J）' : ''}；密码和私钥不包含在命令里。
          </Typography.Paragraph>
        </>
      ) : (
        <Typography.Text type="secondary">这台主机还没有端口转发</Typography.Text>
      )}
    </Modal>
  );
}
