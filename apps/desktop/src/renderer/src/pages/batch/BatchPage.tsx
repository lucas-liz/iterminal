import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, DatePicker, Empty, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Steps, Switch, Table, Tag, Tooltip, Typography, type ButtonProps } from 'antd';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  FileOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  HistoryOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { BATCH_PATH_VARS, BATCH_STATUS_LABEL, type BatchJob, type BatchKind, type BatchLocalItem, type BatchStatus, type Host } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useHosts } from '../../store/hosts';
import { useLibrary } from '../../store/library';
import { TopBarSlot } from '../../components/TopBar';
import { ShellEditor, type ShellEditorApi } from '../../components/batch/ShellEditor';
import { BatchJobDrawer, BatchStatusTag } from './BatchJobDrawer';
import { ResidentPicker } from '../monitor/ResidentPicker';

const HISTORY_SIZE = 15;
const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);
const firstLine = (s: string | null): string => (s ?? '').split('\n').find((l) => l.trim()) ?? '';

type Range = [Dayjs | null, Dayjs | null] | null;

/** 订阅执行进度：更新正在看的任务 */
function useBatchProgress(onJob: (job: BatchJob) => void): void {
  const ref = useRef(onJob);
  ref.current = onJob;
  useEffect(() => window.itm.on('batch.progress', (job) => ref.current(job)), []);
}

/** 已选主机：按钮 + 标签 */
function HostPickField({ value, onChange, testId }: { value: string[]; onChange(ids: string[]): void; testId: string }): React.JSX.Element {
  const hosts = useHosts((s) => s.hosts);
  const [open, setOpen] = useState(false);
  const picked = useMemo(() => value.map((id) => hosts.find((h) => h.id === id)).filter((h): h is Host => !!h), [value, hosts]);
  return (
    <div className="batch-host-field">
      <Button type="link" className="batch-host-pick" onClick={() => setOpen(true)} data-testid={testId}>
        {picked.length ? `已选 ${picked.length} 台主机` : '选择主机'}
      </Button>
      {picked.length > 0 && (
        <div className="batch-host-tags">
          {picked.slice(0, 12).map((h) => (
            <Tag key={h.id} closable bordered={false} onClose={() => onChange(value.filter((x) => x !== h.id))}>
              {h.name}
            </Tag>
          ))}
          {picked.length > 12 && <Tag bordered={false}>{`+${picked.length - 12}`}</Tag>}
        </div>
      )}
      <ResidentPicker
        open={open}
        selected={value}
        title="选择主机"
        intro="勾选要执行的 SSH 主机（需要保存了密码或密钥，执行时在后台连接，不占用终端）。可以按名称 / IP / 备注 / 标签搜索，按分组一次全选。"
        saveText="确定"
        markLabel=""
        onClose={() => setOpen(false)}
        onSave={(ids) => {
          onChange(ids);
          setOpen(false);
        }}
      />
    </div>
  );
}

/** 「从模板中选择」：指令集里的命令 */
function SnippetPicker({ open, onClose, onPick }: { open: boolean; onClose(): void; onPick(content: string): void }): React.JSX.Element {
  const snippets = useLibrary((s) => s.snippets);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase();
    return snippets.filter((s) => !k || s.name.toLowerCase().includes(k) || s.content.toLowerCase().includes(k) || (s.description ?? '').toLowerCase().includes(k));
  }, [snippets, q]);
  return (
    <Modal open={open} title="从模板中选择" width={760} footer={null} onCancel={onClose} destroyOnHidden>
      <Input autoFocus allowClear prefix={<SearchOutlined />} placeholder="搜索名称 / 命令 / 说明" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 10 }} />
      <Table
        size="small"
        rowKey="id"
        dataSource={rows}
        pagination={false}
        scroll={{ y: 380 }}
        locale={{ emptyText: snippets.length ? '没有符合条件的命令' : '指令集里还没有命令（左侧 ··· → 指令集里添加）' }}
        onRow={(s) => ({ onClick: () => onPick(s.content), style: { cursor: 'pointer' } })}
        data-testid="batch-snippet-table"
        columns={[
          { title: '名称', dataIndex: 'name', width: 180, ellipsis: true },
          { title: '命令', dataIndex: 'content', ellipsis: true, render: (v: string) => <code className="mono">{firstLine(v)}</code> },
          { title: '说明', dataIndex: 'description', width: 180, ellipsis: true },
        ]}
      />
    </Modal>
  );
}

/** 批量执行命令：左侧参数、中间命令编辑器、右侧最近 15 条执行历史 */
function ExecComposer({ onOpenJob, seed }: { onOpenJob(job: BatchJob): void; seed: { job: BatchJob; n: number } | null }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [timeoutSec, setTimeoutSec] = useState<number>(0);
  const [script, setScript] = useState(false);
  const [command, setCommand] = useState('');
  const [hostError, setHostError] = useState(false);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<BatchJob[]>([]);
  const [templates, setTemplates] = useState(false);
  const editor = useRef<ShellEditorApi | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      setHistory((await invoke('batch.list', { kind: 'exec', limit: HISTORY_SIZE })).items);
    } catch {
      // 忽略
    }
  }, []);
  useEffect(() => void loadHistory(), [loadHistory]);
  useBatchProgress((job) => {
    if (job.kind !== 'exec') return;
    setHistory((list) => (list.some((j) => j.id === job.id) ? list.map((j) => (j.id === job.id ? { ...job, hosts: undefined } : j)) : [{ ...job, hosts: undefined }, ...list].slice(0, HISTORY_SIZE)));
  });

  // 「重新执行」：把那次的参数填回来
  useEffect(() => {
    if (!seed) return;
    const j = seed.job;
    setHostIds(j.hosts?.map((h) => h.hostId) ?? []);
    setDescription(j.description);
    setTimeoutSec(j.timeoutSec);
    setScript(j.script);
    setCommand(j.command ?? '');
    editor.current?.replaceAll(j.command ?? '');
  }, [seed]);

  const reset = (): void => {
    setHostIds([]);
    setDescription('');
    setTimeoutSec(0);
    setScript(false);
    setCommand('');
    setHostError(false);
  };

  const run = async (): Promise<void> => {
    if (running) return;
    if (!hostIds.length) {
      setHostError(true);
      return;
    }
    if (!command.trim()) {
      void message.warning('请输入要执行的命令');
      editor.current?.focus();
      return;
    }
    setRunning(true);
    try {
      const check = await invoke('batch.check', { hostIds, command });
      if (check.level === 'DENY') {
        modal.error({ title: '命令被拦截', content: `命中黑名单，不能执行：${check.denied[0]?.reasons.join('；') ?? ''}` });
        return;
      }
      const vars = /\{\{[^}]+\}\}/.test(command);
      const ok = await modal.confirm({
        title: check.level === 'L2' ? '高危命令，确认批量执行？' : '确认批量执行？',
        okText: '执行',
        okButtonProps: { danger: check.level === 'L2', 'data-testid': 'batch-exec-confirm' } as ButtonProps,
        cancelText: '取消',
        width: 520,
        content: (
          <div className="batch-confirm">
            <div>{`在 ${hostIds.length - check.denied.length} 台主机上${script ? '按脚本' : ''}执行：`}</div>
            <pre className="batch-confirm-cmd mono">{command.length > 600 ? `${command.slice(0, 600)}…` : command}</pre>
            {check.level !== 'L0' && check.reasons.length > 0 && <Typography.Text type={check.level === 'L2' ? 'danger' : 'warning'}>{`风险 ${check.level}：${check.reasons.join('；')}`}</Typography.Text>}
            {check.denied.length > 0 && <div className="batch-confirm-deny">{`${check.denied.map((d) => d.hostName).join('、')} 命中主机的命令黑名单，不会执行`}</div>}
            {vars && <Typography.Text type="warning">命令里还有 {'{{变量}}'}，批量执行不会替换，请确认已经改成实际的值</Typography.Text>}
          </div>
        ),
      });
      if (!ok) return;
      const job = await invoke('batch.exec', { hostIds, command, description, timeoutSec, script });
      setHistory((list) => [{ ...job, hosts: undefined }, ...list.filter((j) => j.id !== job.id)].slice(0, HISTORY_SIZE));
      onOpenJob(job);
    } catch (e) {
      void message.error(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="batch-compose exec" data-testid="batch-exec-compose">
      <section className="batch-card batch-params">
        <div className="batch-card-head">
          <span className="batch-card-title">执行参数</span>
          <Space size={6}>
            <Button size="small" onClick={reset}>
              重置
            </Button>
            <Button size="small" type="primary" loading={running} onClick={() => void run()} data-testid="batch-exec-run">
              执行
            </Button>
          </Space>
        </div>
        <div className="batch-form">
          <div className="batch-form-row">
            <label className="batch-form-label required">执行主机</label>
            <div className="batch-form-control">
              <HostPickField
                value={hostIds}
                onChange={(ids) => {
                  setHostIds(ids);
                  if (ids.length) setHostError(false);
                }}
                testId="batch-exec-hosts"
              />
              {hostError && <div className="batch-form-error">请选择执行主机</div>}
            </div>
          </div>
          <div className="batch-form-row">
            <label className="batch-form-label">执行描述</label>
            <Input className="batch-form-control" placeholder="请输入执行描述" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} data-testid="batch-exec-desc" />
          </div>
          <div className="batch-form-row">
            <label className="batch-form-label">超时时间</label>
            <div className="batch-form-control batch-inline">
              <InputNumber min={0} max={86400} value={timeoutSec} onChange={(v) => setTimeoutSec(Number(v) || 0)} suffix="秒" style={{ width: 140 }} data-testid="batch-exec-timeout" />
            </div>
          </div>
          <div className="batch-form-row">
            <label className="batch-form-label">脚本执行</label>
            <div className="batch-form-control batch-inline batch-switch-row">
              <Switch size="small" checked={script} onChange={setScript} data-testid="batch-exec-script" />
              <Tooltip title="打开后把命令写成临时脚本文件再执行（有 #! 时按 #! 指定的解释器，否则用 bash），执行完自动删除；适合多行、带函数和条件判断的脚本">
                <QuestionCircleOutlined className="batch-help" />
              </Tooltip>
            </div>
          </div>
          <Typography.Text type="secondary" className="batch-form-hint">
            超时时间 0 表示不限制。命令在每台主机的独立通道里执行（不占用终端、不会等待输入），并记入运维审计的命令记录。
          </Typography.Text>
        </div>
      </section>

      <section className="batch-card batch-editor-card">
        <div className="batch-card-head">
          <span className="batch-card-title">执行命令</span>
          <Button type="link" size="small" onClick={() => setTemplates(true)} data-testid="batch-from-template">
            从模板中选择
          </Button>
        </div>
        <div className="batch-editor-wrap">
          <ShellEditor value={command} onChange={setCommand} onRun={() => void run()} apiRef={(a) => (editor.current = a)} placeholder="# 输入要在所选主机上执行的命令，⌘ / Ctrl + Enter 执行" />
        </div>
        <div className="batch-editor-foot">多行命令按顺序执行；需要分支、循环、函数时打开「脚本执行」。</div>
      </section>

      <section className="batch-card batch-history">
        <div className="batch-card-head">
          <span className="batch-card-title">执行历史</span>
          <Typography.Text type="secondary" className="batch-card-sub">
            展示最近 {HISTORY_SIZE} 条执行记录
          </Typography.Text>
        </div>
        <div className="batch-history-list" data-testid="batch-exec-history">
          {history.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无执行记录" />
          ) : (
            history.map((j) => (
              <div key={j.id} className="batch-history-item" onClick={() => void invoke('batch.get', { id: j.id }).then(onOpenJob, (e) => message.error(errorMessage(e)))} data-testid="batch-history-item">
                <div className="batch-history-top">
                  <span className="batch-history-title">{j.description || firstLine(j.command)}</span>
                  <BatchStatusTag job={j} />
                </div>
                {j.description && <code className="batch-history-cmd mono">{firstLine(j.command)}</code>}
                <div className="batch-history-meta">
                  <span>{dayjs(j.createdAt).format('MM-DD HH:mm:ss')}</span>
                  <span>{`${j.hostCount} 台主机`}</span>
                  {j.counts.failed > 0 && <Typography.Text type="danger">{`${j.counts.failed} 台失败`}</Typography.Text>}
                </div>
              </div>
            ))
          )}
        </div>
      </section>
      <SnippetPicker
        open={templates}
        onClose={() => setTemplates(false)}
        onPick={(content) => {
          setTemplates(false);
          editor.current?.insert(content);
        }}
      />
    </div>
  );
}

/** 批量上传文件：左侧步骤、中间参数、右侧文件列表 */
function UploadComposer({ onOpenJob }: { onOpenJob(job: BatchJob): void }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [hostIds, setHostIds] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [remotePath, setRemotePath] = useState('');
  const [items, setItems] = useState<BatchLocalItem[]>([]);
  const [errors, setErrors] = useState<{ path?: boolean; hosts?: boolean }>({});
  const [job, setJob] = useState<BatchJob | null>(null);
  const [busy, setBusy] = useState(false);

  useBatchProgress((j) => {
    if (job && j.id === job.id) setJob(j);
  });

  const addPaths = async (paths: string[]): Promise<void> => {
    if (!paths.length) return;
    try {
      const got = await invoke('batch.inspectLocal', { paths });
      setItems((cur) => [...cur.filter((x) => !got.some((g) => g.path === x.path)), ...got]);
    } catch (e) {
      void message.error(errorMessage(e));
    }
  };
  const pickFiles = async (): Promise<void> => addPaths(await invoke('dialog.openFiles'));
  const pickFolder = async (): Promise<void> => {
    const dir = await invoke('dialog.openDirectory', { title: '选择要上传的文件夹' });
    if (dir) await addPaths([dir]);
  };

  const reset = (): void => {
    setHostIds([]);
    setDescription('');
    setRemotePath('');
    setItems([]);
    setErrors({});
    setJob(null);
  };

  const start = async (): Promise<void> => {
    const e = { path: !remotePath.trim(), hosts: !hostIds.length };
    setErrors(e);
    if (e.path || e.hosts) return;
    if (!items.length) {
      void message.warning('请先在右侧选择要上传的文件');
      return;
    }
    const files = items.reduce((a, x) => a + x.files, 0);
    const bytes = items.reduce((a, x) => a + x.size, 0);
    const ok = await modal.confirm({
      title: '确认批量上传？',
      content: `把 ${files} 个文件（${size(bytes)}）上传到 ${hostIds.length} 台主机的「${remotePath.trim()}」，同名文件会被覆盖。`,
      okText: '开始上传',
      cancelText: '取消',
      okButtonProps: { 'data-testid': 'batch-upload-confirm' } as ButtonProps,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const j = await invoke('batch.upload', { hostIds, localPaths: items.map((x) => x.path), remotePath: remotePath.trim(), description });
      setJob(j);
    } catch (err) {
      void message.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const running = job?.status === 'running';
  const step = !job ? (items.length && hostIds.length && remotePath.trim() ? 1 : 0) : running ? 2 : 3;
  const totalBytes = items.reduce((a, x) => a + x.size, 0);
  const sentBytes = job?.hosts?.reduce((a, h) => a + (h.status === 'success' ? (h.totalBytes ?? totalBytes) : (h.bytes ?? 0)), 0) ?? 0;
  const allBytes = (job?.hostCount ?? 0) * totalBytes;

  return (
    <div className="batch-compose upload" data-testid="batch-upload-compose">
      <section className="batch-card batch-steps">
        <Steps
          direction="vertical"
          size="small"
          current={step}
          status={job && !running && job.status !== 'success' ? 'error' : undefined}
          items={[
            { title: '创建任务', description: '填写上传路径、选择主机' },
            { title: '选择文件', description: '选择本机的文件或文件夹' },
            { title: '分发文件', description: running && allBytes ? `已上传 ${Math.min(100, Math.round((sentBytes / allBytes) * 100))}%` : '上传到每台目标主机' },
            { title: '上传完成', description: job && !running ? BATCH_STATUS_LABEL[job.status] : '释放连接' },
          ]}
        />
        {job && (
          <Button size="small" block onClick={() => void invoke('batch.get', { id: job.id }).then(onOpenJob)} data-testid="batch-upload-detail">
            查看每台主机的结果
          </Button>
        )}
      </section>

      <section className="batch-card batch-params">
        <div className="batch-card-head">
          <span className="batch-card-title">批量上传</span>
          <Space size={6}>
            <Button size="small" onClick={reset} disabled={running}>
              重置
            </Button>
            {running ? (
              <Button size="small" danger onClick={() => job && void invoke('batch.cancel', { id: job.id })}>
                取消上传
              </Button>
            ) : (
              <Button size="small" type="primary" loading={busy} onClick={() => void start()} data-testid="batch-upload-start">
                开始上传
              </Button>
            )}
          </Space>
        </div>
        <div className="batch-form">
          <div className="batch-form-row">
            <label className="batch-form-label">上传描述</label>
            <Input className="batch-form-control" placeholder="请输入上传描述" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} data-testid="batch-upload-desc" />
          </div>
          <div className="batch-form-row">
            <label className="batch-form-label required">上传路径</label>
            <div className="batch-form-control">
              <Input
                placeholder="请输入上传路径"
                value={remotePath}
                status={errors.path ? 'error' : undefined}
                onChange={(e) => {
                  setRemotePath(e.target.value);
                  if (e.target.value.trim()) setErrors((x) => ({ ...x, path: false }));
                }}
                data-testid="batch-upload-path"
              />
              <div className="batch-form-tip">{BATCH_PATH_VARS}；相对路径按家目录算，目录不存在时自动创建</div>
              {errors.path && <div className="batch-form-error">请输入上传路径</div>}
            </div>
          </div>
          <div className="batch-form-row">
            <label className="batch-form-label required">上传主机</label>
            <div className="batch-form-control">
              <HostPickField
                value={hostIds}
                onChange={(ids) => {
                  setHostIds(ids);
                  if (ids.length) setErrors((x) => ({ ...x, hosts: false }));
                }}
                testId="batch-upload-hosts"
              />
              {errors.hosts && <div className="batch-form-error">请选择上传主机</div>}
            </div>
          </div>
        </div>
      </section>

      <section className="batch-card batch-files">
        <div className="batch-card-head">
          <span className="batch-card-title">
            文件列表
            {items.length > 0 && <span className="batch-card-sub">{` · ${items.reduce((a, x) => a + x.files, 0)} 个文件，${size(totalBytes)}`}</span>}
          </span>
          <Space size={6}>
            <Button size="small" onClick={() => setItems([])} disabled={!items.length || running}>
              清空
            </Button>
            <Button size="small" type="primary" icon={<FileOutlined />} onClick={() => void pickFiles()} disabled={running} data-testid="batch-pick-files">
              选择文件
            </Button>
            <Button size="small" type="primary" icon={<FolderOpenOutlined />} onClick={() => void pickFolder()} disabled={running} data-testid="batch-pick-folder">
              选择文件夹
            </Button>
          </Space>
        </div>
        {items.length === 0 ? (
          <div className="batch-files-empty">
            <Empty image={<CloudUploadOutlined className="batch-files-empty-icon" />} description="请先点击上方按钮选择文件" />
          </div>
        ) : (
          <div className="batch-file-list" data-testid="batch-file-list">
            {items.map((x) => (
              <div key={x.path} className="batch-file-row">
                {x.dir ? <FolderOutlined className="batch-file-icon dir" /> : <FileOutlined className="batch-file-icon" />}
                <div className="batch-file-meta">
                  <div className="batch-file-name">{x.name}</div>
                  <div className="batch-file-path mono">{x.path}</div>
                </div>
                <span className="batch-file-size">{x.dir ? `${x.files} 个文件 · ${size(x.size)}` : size(x.size)}</span>
                <Button size="small" type="text" icon={<DeleteOutlined />} disabled={running} onClick={() => setItems((cur) => cur.filter((y) => y.path !== x.path))} aria-label="移除" />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/** 执行记录 / 上传任务列表 */
function JobList({ kind, onOpenJob, onRerun, onNew }: { kind: BatchKind; onOpenJob(job: BatchJob): void; onRerun(job: BatchJob): void; onNew(): void }): React.JSX.Element {
  const { message } = App.useApp();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const [range, setRange] = useState<Range>(null);
  const [applied, setApplied] = useState<{ q: string; status: BatchStatus | null; range: Range }>({ q: '', status: null, range: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState<{ items: BatchJob[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const exec = kind === 'exec';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await invoke('batch.list', {
          kind,
          q: applied.q,
          status: applied.status,
          ...(applied.range?.[0] ? { from: applied.range[0].startOf('day').valueOf() } : {}),
          ...(applied.range?.[1] ? { to: applied.range[1].endOf('day').valueOf() + 1 } : {}),
          limit: pageSize,
          offset: (page - 1) * pageSize,
        }),
      );
    } catch (e) {
      void message.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [kind, applied, page, pageSize, message]);
  useEffect(() => void load(), [load]);
  useBatchProgress((job) => {
    if (job.kind === kind) setData((d) => ({ ...d, items: d.items.map((j) => (j.id === job.id ? { ...job, hosts: undefined } : j)) }));
  });

  const remove = async (ids: string[]): Promise<void> => {
    try {
      await invoke('batch.delete', { ids });
      setSelected((s) => s.filter((x) => !ids.includes(x)));
      await load();
    } catch (e) {
      void message.error(errorMessage(e));
    }
  };

  return (
    <div className="ops-panel" data-testid={`batch-list-${kind}`}>
      <div className="ops-filter-card">
        <div className="ops-filter-item">
          <span className="ops-filter-label">{exec ? '执行描述' : '上传描述'}</span>
          <Input allowClear placeholder={exec ? '描述 / 命令（包含）' : '描述 / 路径 / 文件名'} value={q} onChange={(e) => setQ(e.target.value)} onPressEnter={() => (setPage(1), setApplied({ q, status, range }))} />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">{exec ? '执行状态' : '上传状态'}</span>
          <Select allowClear placeholder="请选择状态" value={status} onChange={(v) => setStatus(v ?? null)} options={(Object.keys(BATCH_STATUS_LABEL) as BatchStatus[]).map((k) => ({ value: k, label: BATCH_STATUS_LABEL[k] }))} />
        </div>
        <div className="ops-filter-item">
          <span className="ops-filter-label">时间</span>
          <DatePicker.RangePicker value={range} onChange={(v) => setRange(v as Range)} />
        </div>
        <div className="ops-filter-actions">
          <Button
            onClick={() => {
              setQ('');
              setStatus(null);
              setRange(null);
              setPage(1);
              setApplied({ q: '', status: null, range: null });
            }}
          >
            重置
          </Button>
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={() => {
              setPage(1);
              setApplied({ q, status, range });
            }}
          >
            搜索
          </Button>
        </div>
      </div>
      <div className="ops-table-card">
        <div className="ops-table-head">
          <span className="ops-table-title">{exec ? '批量执行日志列表' : '上传任务列表'}</span>
          <Space size={8}>
            <Button type="primary" icon={exec ? <ThunderboltOutlined /> : <CloudUploadOutlined />} onClick={onNew}>
              {exec ? '执行命令' : '上传'}
            </Button>
            <Popconfirm title={`删除选中的 ${selected.length} 条记录？`} okText="删除" okButtonProps={{ danger: true }} cancelText="取消" disabled={!selected.length} onConfirm={() => remove(selected)}>
              <Button danger icon={<DeleteOutlined />} disabled={!selected.length}>
                删除
              </Button>
            </Popconfirm>
            <Tooltip title="刷新">
              <Button icon={<ReloadOutlined />} onClick={() => void load()} aria-label="刷新" />
            </Tooltip>
          </Space>
        </div>
        <Table<BatchJob>
          size="middle"
          rowKey="id"
          loading={loading}
          dataSource={data.items}
          rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), getCheckboxProps: (r) => ({ disabled: r.status === 'running' }) }}
          pagination={{
            current: page,
            pageSize,
            total: data.total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50],
            onChange: (p, ps) => {
              setPage(ps !== pageSize ? 1 : p);
              setPageSize(ps);
            },
            showTotal: (t) => `共 ${t} 条`,
          }}
          tableLayout="auto"
          columns={[
            { title: exec ? '执行描述' : '上传描述', dataIndex: 'description', width: 180, ellipsis: true, render: (v: string) => v || <Typography.Text type="secondary">—</Typography.Text> },
            exec
              ? { title: '执行命令', dataIndex: 'command', ellipsis: true, render: (v: string | null, r) => <code className="mono audit-cmd">{`${r.script ? '[脚本] ' : ''}${firstLine(v)}`}</code> }
              : { title: '远程路径', dataIndex: 'remotePath', ellipsis: true, render: (v: string | null) => <span className="mono">{v}</span> },
            { title: exec ? '执行状态' : '上传状态', key: 'status', width: 150, render: (_, r) => <BatchStatusTag job={r} withCounts /> },
            ...(exec ? [] : [{ title: '文件数量', dataIndex: 'fileCount', width: 90 }]),
            { title: '主机数量', dataIndex: 'hostCount', width: 90 },
            { title: exec ? '执行时间' : '上传时间', dataIndex: 'createdAt', width: 170, render: (v: number) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
            {
              title: '操作',
              key: 'op',
              width: 200,
              render: (_, r) => (
                <Space size={2}>
                  <Button type="link" size="small" onClick={() => void invoke('batch.get', { id: r.id }).then(onOpenJob, (e) => message.error(errorMessage(e)))} data-testid="batch-job-detail">
                    详情
                  </Button>
                  {exec && (
                    <Button type="link" size="small" onClick={() => void invoke('batch.get', { id: r.id }).then(onRerun, (e) => message.error(errorMessage(e)))}>
                      重新执行
                    </Button>
                  )}
                  {r.status === 'running' ? (
                    <Button type="link" size="small" danger onClick={() => void invoke('batch.cancel', { id: r.id })}>
                      取消
                    </Button>
                  ) : (
                    <Popconfirm title="删除这条记录？" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => remove([r.id])}>
                      <Button type="link" size="small" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * 批量执行（第三十五轮，替代定时任务的位置）：顶部切换「批量执行命令」和「批量上传文件」；
 * 每个都分「新建」（参数 + 命令 / 文件）和「记录」两个视图，执行详情在右侧抽屉里实时刷新。
 */
export function BatchPage(): React.JSX.Element {
  const [kind, setKind] = useState<BatchKind>('exec');
  const [view, setView] = useState<Record<BatchKind, 'compose' | 'list'>>({ exec: 'compose', upload: 'compose' });
  const [detail, setDetail] = useState<BatchJob | null>(null);
  const [seed, setSeed] = useState<{ job: BatchJob; n: number } | null>(null);
  useBatchProgress((job) => setDetail((d) => (d && d.id === job.id ? job : d)));
  const cur = view[kind];
  const setCur = (v: 'compose' | 'list'): void => setView((x) => ({ ...x, [kind]: v }));

  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title no-drag">
            <span className="topbar-page-name">批量执行</span>
            <Segmented
              size="small"
              value={kind}
              onChange={(v) => setKind(v as BatchKind)}
              options={[
                { value: 'exec', label: <span data-testid="batch-tab-exec">批量执行命令</span> },
                { value: 'upload', label: <span data-testid="batch-tab-upload">批量上传文件</span> },
              ]}
              data-testid="batch-tabs"
            />
          </div>
          <div className="topbar-ctx-actions no-drag">
            {cur === 'compose' ? (
              <Button size="small" icon={<HistoryOutlined />} onClick={() => setCur('list')} data-testid="batch-show-list">
                {kind === 'exec' ? '执行记录' : '上传记录'}
              </Button>
            ) : (
              <Button size="small" type="primary" icon={kind === 'exec' ? <ThunderboltOutlined /> : <CloudUploadOutlined />} onClick={() => setCur('compose')} data-testid="batch-show-compose">
                {kind === 'exec' ? '执行命令' : '上传文件'}
              </Button>
            )}
          </div>
        </div>
      </TopBarSlot>
      <div className="batch-body">
        {/* 两个新建视图都保持挂载：切换 tab / 记录时填到一半的内容不丢 */}
        <div className={kind === 'exec' && cur === 'compose' ? 'batch-view' : 'batch-view hidden'}>
          <ExecComposer onOpenJob={setDetail} seed={seed} />
        </div>
        <div className={kind === 'upload' && cur === 'compose' ? 'batch-view' : 'batch-view hidden'}>
          <UploadComposer onOpenJob={setDetail} />
        </div>
        {cur === 'list' && (
          <div className="batch-view">
            <JobList
              key={kind}
              kind={kind}
              onOpenJob={setDetail}
              onNew={() => setCur('compose')}
              onRerun={(job) => {
                setSeed((s) => ({ job, n: (s?.n ?? 0) + 1 }));
                setCur('compose');
              }}
            />
          </div>
        )}
      </div>
      <BatchJobDrawer job={detail} onClose={() => setDetail(null)} />
    </>
  );
}
