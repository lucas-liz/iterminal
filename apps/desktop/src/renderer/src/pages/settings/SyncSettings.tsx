import { useCallback, useEffect, useState } from 'react';
import { Alert, App, Button, Checkbox, Empty, Input, Modal, Radio, Space, Table, Tag, Tooltip, Typography } from 'antd';
import {
  CloudSyncOutlined,
  ExportOutlined,
  HistoryOutlined,
  ImportOutlined,
  LockOutlined,
  ReloadOutlined,
  RollbackOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  GROUP_ITEM_TYPES,
  SYNC_GROUP_LABEL,
  SYNC_GROUPS,
  SYNC_ITEM_LABEL,
  SYNC_ITEM_TYPES,
  type AutoBackupInfo,
  type BackupFileInfo,
  type ItemCounts,
  type LocalStats,
  type SyncGroup,
  type SyncReport,
} from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { useHosts } from '../../store/hosts';
import { useVault } from '../../store/vault';
import { useLibrary } from '../../store/library';
import { useForwards } from '../../store/forwards';
import { useAccount } from '../../store/account';
import { CloudSection } from './CloudSection';
import { FormSection } from '../../components/FormSection';
import { SettingGroup, SettingRow, SettingsSection } from './parts';

const MIN_EXPORT_PASSWORD = 8;
export const time = (t: number | null): string => (t ? dayjs(t).format('YYYY/MM/DD HH:mm') : '—');
export const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** 导入 / 撤回之后，界面上的主机、凭证、命令、笔记、端口转发都要重新加载 */
export async function reloadAll(): Promise<void> {
  await Promise.all([
    useHosts.getState().reload(),
    useVault.getState().reload(),
    useLibrary.getState().reloadSnippets(),
    useLibrary.getState().reloadNotes(),
    useForwards.getState().reload(),
  ]);
}

/** 分组 + 条数的简短说明：主机 3（分组 2）· 命令 5 */
export function countsText(groups: SyncGroup[], counts: ItemCounts): string {
  return groups
    .map((g) => {
      const [main, sub] = GROUP_ITEM_TYPES[g];
      return `${SYNC_GROUP_LABEL[g]} ${counts[main] ?? 0}${sub ? `（分组 ${counts[sub] ?? 0}）` : ''}`;
    })
    .join(' · ');
}

function StatsGrid({ counts }: { counts: ItemCounts | null }): React.JSX.Element {
  return (
    <div className="sync-stats">
      {SYNC_ITEM_TYPES.map((t) => (
        <div key={t} className="sync-stat" data-testid={`sync-stat-${t}`}>
          <div className="sync-stat-value">{counts ? counts[t] : '—'}</div>
          <div className="sync-stat-label">{SYNC_ITEM_LABEL[t]}</div>
        </div>
      ))}
    </div>
  );
}

/** 合并 / 覆盖预览：每类数据一行 */
export function ReportTable({ report }: { report: SyncReport }): React.JSX.Element {
  const types = SYNC_ITEM_TYPES.filter((t) => report.groups.some((g) => GROUP_ITEM_TYPES[g].includes(t)));
  const merge = report.mode === 'merge';
  const rows = types.map((t) => ({ key: t, label: SYNC_ITEM_LABEL[t], ...(report.perType[t] as unknown as Record<string, number>) }));
  const num = (v: number, tone?: 'add' | 'warn' | 'danger'): React.ReactNode => (v ? <span className={`sync-num ${tone ?? ''}`}>{v}</span> : <span className="sync-num zero">0</span>);
  return (
    <>
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        data-testid="sync-report"
        columns={
          merge
            ? [
                { title: '数据', dataIndex: 'label' },
                { title: '新增', dataIndex: 'added', align: 'right', render: (v: number) => num(v, 'add') },
                { title: '已存在（保留本地）', dataIndex: 'kept', align: 'right', render: (v: number) => num(v) },
                { title: '补充字段', dataIndex: 'filled', align: 'right', render: (v: number) => num(v, 'warn') },
              ]
            : [
                { title: '数据', dataIndex: 'label' },
                { title: '新增', dataIndex: 'added', align: 'right', render: (v: number) => num(v, 'add') },
                { title: '修改', dataIndex: 'updated', align: 'right', render: (v: number) => num(v, 'warn') },
                { title: '删除', dataIndex: 'removed', align: 'right', render: (v: number) => num(v, 'danger') },
                { title: '不变', dataIndex: 'unchanged', align: 'right', render: (v: number) => num(v) },
              ]
        }
      />
      {report.unresolvedRefs.length > 0 && (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message={`${report.unresolvedRefs.length} 处引用无法映射，导入后会置空`}
          description={
            <div className="sync-unresolved">
              {report.unresolvedRefs.slice(0, 8).map((r, i) => (
                <div key={i}>
                  {SYNC_ITEM_LABEL[r.type]}「{r.name}」的{FIELD_LABEL[r.field] ?? r.field}
                </div>
              ))}
              {report.unresolvedRefs.length > 8 && <div>…… 还有 {report.unresolvedRefs.length - 8} 处</div>}
            </div>
          }
        />
      )}
    </>
  );
}

const FIELD_LABEL: Record<string, string> = {
  credentialId: '凭证（需要重新选择）',
  defaultCredentialId: '默认凭证',
  defaultJumpHostId: '默认跳板机',
  jumpHostIds: '跳板机',
  folderId: '所在分组',
  parentId: '上级分组',
  groupId: '分组',
};

export function GroupPicker({ value, onChange, available, testId }: { value: SyncGroup[]; onChange: (v: SyncGroup[]) => void; available?: SyncGroup[]; testId: string }): React.JSX.Element {
  return (
    <Checkbox.Group
      value={value}
      onChange={(v) => onChange(SYNC_GROUPS.filter((g) => (v as SyncGroup[]).includes(g)))}
      options={SYNC_GROUPS.map((g) => ({ value: g, label: SYNC_GROUP_LABEL[g], disabled: available ? !available.includes(g) : false }))}
      data-testid={testId}
    />
  );
}

function ExportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { message } = App.useApp();
  const masterPassword = useApp((s) => !!s.security?.masterPassword);
  const [groups, setGroups] = useState<SyncGroup[]>([...SYNC_GROUPS]);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [master, setMaster] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setGroups([...SYNC_GROUPS]);
      setPw('');
      setPw2('');
      setMaster('');
    }
  }, [open]);
  const withCreds = groups.includes('CREDENTIALS');
  const error = !groups.length
    ? '请至少选择一个分组'
    : pw.length < MIN_EXPORT_PASSWORD
      ? `导出密码至少 ${MIN_EXPORT_PASSWORD} 位`
      : pw !== pw2
        ? '两次输入的导出密码不一致'
        : withCreds && masterPassword && !master
          ? '包含凭证时需要输入主密码验证身份'
          : null;

  const run = async (): Promise<void> => {
    const filePath = await invoke('dialog.saveFile', {
      title: '导出 iTerminal 数据',
      defaultName: `iTerminal-${dayjs().format('YYYYMMDD-HHmm')}.itmbak`,
      filters: [{ name: 'iTerminal 备份', extensions: ['itmbak'] }],
    });
    if (!filePath) return;
    setBusy(true);
    try {
      const info = await invoke('backup.export', { groups, filePath, password: pw, masterPassword: withCreds && masterPassword ? master : undefined });
      message.success(`已导出：${countsText(info.groups, info.counts)}`);
      onDone();
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="导出到本地文件"
      onCancel={onClose}
      width={560}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Tooltip title={error}>
            <Button type="primary" icon={<ExportOutlined />} disabled={!!error} loading={busy} onClick={() => void run()} data-testid="export-confirm">
              选择位置并导出
            </Button>
          </Tooltip>
        </Space>
      }
    >
      <FormSection title="导出范围">
        <GroupPicker value={groups} onChange={setGroups} testId="export-groups" />
        {withCreds && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="文件里会包含凭证和主机的密码、私钥"
            description="内容用导出密码加密；请妥善保管文件和密码，不要发给不可信的人。"
          />
        )}
      </FormSection>
      <FormSection title="导出密码">
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          导入时需要输入这个密码。密码不会保存，忘记后文件无法打开。
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input.Password placeholder={`导出密码（至少 ${MIN_EXPORT_PASSWORD} 位）`} value={pw} onChange={(e) => setPw(e.target.value)} data-testid="export-password" />
          <Input.Password placeholder="再输入一次" value={pw2} onChange={(e) => setPw2(e.target.value)} data-testid="export-password2" />
        </Space>
      </FormSection>
      {withCreds && masterPassword && (
        <FormSection title="验证身份">
          <Input.Password prefix={<LockOutlined />} placeholder="主密码" value={master} onChange={(e) => setMaster(e.target.value)} data-testid="export-master" />
        </FormSection>
      )}
    </Modal>
  );
}

function ImportModal({ file, onClose, onDone }: { file: { path: string; info: BackupFileInfo } | null; onClose: () => void; onDone: () => void }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [groups, setGroups] = useState<SyncGroup[]>([]);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [pw, setPw] = useState('');
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (file) {
      setGroups(file.info.groups);
      setMode('merge');
      setPw('');
      setReport(null);
    }
  }, [file]);
  // 改了选项，之前的预览就作废
  useEffect(() => setReport(null), [groups, mode, pw]);

  const call = async (dryRun: boolean): Promise<SyncReport | null> => {
    if (!file) return null;
    setBusy(true);
    try {
      return await invoke('backup.import', { filePath: file.path, password: pw, groups, mode, dryRun });
    } catch (e) {
      message.error(errorMessage(e));
      return null;
    } finally {
      setBusy(false);
    }
  };
  const apply = async (): Promise<void> => {
    const r = await call(false);
    if (!r) return;
    await reloadAll();
    message.success(`导入完成。导入前的数据已自动备份（${r.autoBackup}），可以在「自动备份」里撤回`);
    onDone();
    onClose();
  };
  const confirm = (): void => {
    if (mode === 'merge') return void apply();
    modal.confirm({
      title: '覆盖本地数据？',
      content: '选中分组里本机多出来的条目会被删除，其余以文件为准。写入前会自动备份，可以撤回。',
      okText: '覆盖',
      okButtonProps: { danger: true, 'data-testid': 'replace-ok' } as never,
      cancelText: '取消',
      onOk: () => apply(),
    });
  };
  const info = file?.info;
  return (
    <Modal
      open={!!file}
      title="从文件导入"
      onCancel={onClose}
      width={640}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          {!report ? (
            <Button type="primary" loading={busy} disabled={!groups.length || !pw} onClick={() => void call(true).then(setReport)} data-testid="import-preview">
              预览{mode === 'merge' ? '合并' : '覆盖'}
            </Button>
          ) : (
            <Button type="primary" danger={mode === 'replace'} loading={busy} onClick={confirm} data-testid="import-confirm">
              {mode === 'merge' ? '确认合并' : '确认覆盖'}
            </Button>
          )}
        </Space>
      }
    >
      {info && (
        <FormSection title="文件">
          <div className="sync-file-card" data-testid="import-file-info">
            <div>
              <Typography.Text strong>{file.path.split(/[\\/]/).pop()}</Typography.Text>
              <Tag style={{ marginLeft: 8 }}>V{info.formatVersion}</Tag>
            </div>
            <div className="sync-file-meta">
              {time(info.createdAt)} · {info.deviceName} · {info.platform} v{info.clientVersion} · {size(info.size)}
            </div>
            <div className="sync-file-meta">{countsText(info.groups, info.counts)}</div>
          </div>
        </FormSection>
      )}
      <FormSection title="导入方式">
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <GroupPicker value={groups} onChange={setGroups} available={info?.groups} testId="import-groups" />
          <Radio.Group value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}>
            <Space direction="vertical" size={6}>
              <Radio value="merge" data-testid="import-mode-merge">
                合并到本地（推荐）<span className="sync-hint">只增不删；相同的条目保留本地的地址、端口、凭证，只补空字段</span>
              </Radio>
              <Radio value="replace" data-testid="import-mode-replace">
                覆盖本地<span className="sync-hint">选中的分组以文件为准，本机多出来的条目会被删除</span>
              </Radio>
            </Space>
          </Radio.Group>
          <Input.Password placeholder="导出密码" value={pw} onChange={(e) => setPw(e.target.value)} onPressEnter={() => pw && !report && void call(true).then(setReport)} data-testid="import-password" />
        </Space>
      </FormSection>
      {report && (
        <FormSection title={mode === 'merge' ? '合并预览' : '覆盖预览'}>
          <ReportTable report={report} />
        </FormSection>
      )}
    </Modal>
  );
}

export function SyncSettings(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const allowExport = useApp((s) => s.info?.preset.allowLocalExport !== false);
  const account = useAccount((s) => s.state);
  const loggedIn = !!account && account.status !== 'none';
  const [stats, setStats] = useState<LocalStats | null>(null);
  const [autos, setAutos] = useState<AutoBackupInfo[]>([]);
  const [exporting, setExporting] = useState(false);
  const [importFile, setImportFile] = useState<{ path: string; info: BackupFileInfo } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([invoke('sync.localStats'), invoke('backup.autoList')]);
      setStats(s);
      setAutos(a);
    } catch (e) {
      message.error(errorMessage(e));
    }
  }, [message]);
  useEffect(() => void refresh(), [refresh]);

  const pickImport = async (): Promise<void> => {
    const path = await invoke('dialog.openFile', { title: '选择 iTerminal 备份文件', filters: [{ name: 'iTerminal 备份', extensions: ['itmbak'] }] });
    if (!path) return;
    try {
      setImportFile({ path, info: await invoke('backup.inspect', { filePath: path }) });
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const restore = async (a: AutoBackupInfo): Promise<void> => {
    let preview: SyncReport;
    try {
      preview = await invoke('backup.autoRestore', { name: a.name, dryRun: true });
    } catch (e) {
      message.error(errorMessage(e));
      return;
    }
    modal.confirm({
      title: `撤回到 ${time(a.createdAt)} 的状态？`,
      width: 600,
      content: (
        <>
          <Typography.Paragraph type="secondary">{countsText(a.groups, a.counts)}；这些分组会恢复成备份时的样子（撤回前同样会先自动备份）。</Typography.Paragraph>
          <ReportTable report={preview} />
        </>
      ),
      okText: '撤回',
      okButtonProps: { danger: true, 'data-testid': 'auto-restore-ok' } as never,
      cancelText: '取消',
      onOk: async () => {
        try {
          await invoke('backup.autoRestore', { name: a.name });
          await reloadAll();
          message.success('已撤回');
          void refresh();
        } catch (e) {
          message.error(errorMessage(e));
        }
      },
    });
  };

  return (
    <SettingsSection title="云同步" description="主机、快捷命令、笔记和凭证的备份与迁移。数据只保存在本机加密数据库里，导出文件同样加密。">
      {/* 没有登录时不再单独显示云端一行：上面的账户卡片就有「登录」（第二十六轮） */}
      {account?.status === 'valid' ? (
        <CloudSection onChanged={() => void refresh()} />
      ) : !loggedIn ? null : (
        <SettingGroup>
          <SettingRow
            label={
              <Space size={8}>
                <CloudSyncOutlined />
                云端备份与分享码
              </Space>
            }
            description={
              loggedIn
                ? `${account.message ?? '登录已过期'}，重新登录后可以上传备份、恢复和使用分享码。`
                : '当前为本地模式（未登录）。登录 iTerminal 服务端后可以把加密备份上传到云端、从任意设备恢复，开启个人分享码与同事共享主机和命令；数据上传前在本机加密，服务端无法解密。'
            }
            testId="sync-cloud-row"
          >
            <Button
              icon={<CloudSyncOutlined />}
              onClick={() => useAccount.getState().openLogin(loggedIn ? { username: account.username ?? '' } : {})}
              data-testid="sync-login"
            >
              {loggedIn ? '重新登录' : '登录'}
            </Button>
          </SettingRow>
        </SettingGroup>
      )}

      <SettingGroup
        title="本地数据统计"
        extra={
          <Tooltip title="刷新">
            <Button size="small" type="text" icon={<ReloadOutlined />} onClick={() => void refresh()} data-testid="sync-refresh" />
          </Tooltip>
        }
      >
        <StatsGrid counts={stats?.counts ?? null} />
        <div className="sync-stats-foot">
          <HistoryOutlined /> 上次备份：<span data-testid="sync-last-backup">{time(stats?.lastBackupAt ?? null)}</span>
        </div>
      </SettingGroup>

      <SettingGroup title="本地文件">
        <SettingRow
          label="导出到文件"
          description="生成 .itmbak 文件，用你设置的导出密码加密（AES-256-GCM，密钥经 Argon2id 派生）。适合离线迁移到其他电脑，或者不想把数据放到云端。"
        >
          <Tooltip title={allowExport ? undefined : '管理员禁止了导出本地数据'}>
            <Button icon={<ExportOutlined />} disabled={!allowExport} onClick={() => setExporting(true)} data-testid="sync-export">
              导出…
            </Button>
          </Tooltip>
        </SettingRow>
        <SettingRow label="从文件导入" description="可以合并到本地（相同的条目保留本地配置），也可以覆盖本地；写入前会先预览，并自动备份当前数据。">
          <Button icon={<ImportOutlined />} onClick={() => void pickImport()} data-testid="sync-import">
            导入…
          </Button>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        title={
          <Space size={6}>
            <SafetyCertificateOutlined />
            自动备份
          </Space>
        }
        extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>合并或覆盖之前自动生成，保留最近 5 份，只能在本机恢复</Typography.Text>}
      >
        {autos.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有自动备份" style={{ margin: '18px 0' }} />
        ) : (
          autos.map((a) => (
            <SettingRow key={a.name} testId="auto-backup-row" label={time(a.createdAt)} description={`${a.reason} · ${countsText(a.groups, a.counts)} · ${size(a.size)}`}>
              <Button icon={<RollbackOutlined />} onClick={() => void restore(a)} data-testid="auto-restore">
                撤回到此
              </Button>
            </SettingRow>
          ))
        )}
      </SettingGroup>

      <ExportModal open={exporting} onClose={() => setExporting(false)} onDone={() => void refresh()} />
      <ImportModal file={importFile} onClose={() => setImportFile(null)} onDone={() => void refresh()} />
    </SettingsSection>
  );
}
