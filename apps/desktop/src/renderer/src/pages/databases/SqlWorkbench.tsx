import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Empty, Input, Modal, Select, Space, Tabs, Tag, Tooltip, Typography } from 'antd';
import {
  AlignLeftOutlined,
  BugOutlined,
  CaretRightOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  CopyOutlined,
  DownloadOutlined,
  MessageOutlined,
  ForwardOutlined,
  NodeIndexOutlined,
  QuestionCircleOutlined,
  RobotOutlined,
  StopOutlined,
  ThunderboltOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { format as formatSql } from 'sql-formatter';
import type { DbAsset, SqlExecItem, SqlPlan } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { AgentStoreContext, useDbAgent } from '../../store/agent';
import { useApp } from '../../store/app';
import { DB_TYPE_LABEL, useDatabases } from '../../store/databases';
import { objKey, runtimeOf, useSqlWorkbench, type SqlTab } from '../../store/sql-workbench';
import { aiAllowed, promptLogin } from '../../util/ai-access';
import { AgentPanel } from '../../components/agent/AgentPanel';
import { SqlRunContext, type SqlRunner } from '../../components/agent/AnswerMarkdown';
import { DbResultView } from '../../components/agent/DbResultView';
import { SqlEditor, type SqlDialectName, type SqlEditorApi } from '../../components/sql/SqlEditor';
import { DbTree, type DbNodeRef, type DbTreeActions } from './DbTree';
import { CollapsibleSider } from '../../components/CollapsibleSider';

const dialectOf = (a: DbAsset | undefined): SqlDialectName => (a?.type === 'POSTGRES' ? 'postgres' : a?.type === 'SQLITE' ? 'sqlite' : 'mysql');
const FORMAT_LANG = { mysql: 'mysql', postgres: 'postgresql', sqlite: 'sqlite' } as const;
const KIND_TAG: Record<string, { color: string; text: string }> = {
  read: { color: 'green', text: '只读' },
  session: { color: 'default', text: '会话设置' },
  write: { color: 'orange', text: '写操作' },
  danger: { color: 'red', text: '高危' },
  error: { color: 'magenta', text: '不能执行' },
};

const quote = (dialect: SqlDialectName, name: string): string => (dialect === 'mysql' ? `\`${name.replace(/`/g, '``')}\`` : /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);
const qualified = (dialect: SqlDialectName, r: DbNodeRef): string => (dialect === 'postgres' && r.schema && r.schema !== 'public' ? `${quote(dialect, r.schema)}.${quote(dialect, r.name)}` : quote(dialect, r.name));
/** 每个标签的执行 / 插入（右侧 AI 对话里点 SQL 的「执行」时，在当前标签里执行，第二十九轮） */
const tabRunners = new Map<string, SqlRunner>();
const CHAT_KEY = 'itm.sql.chat';
const fence = (sql: string): string => `\n\`\`\`sql\n${sql.trim()}\n\`\`\``;

/** 右侧 AI 对话的入口（工具栏按钮、结果里的「AI 诊断」） */
interface ChatApi {
  open: boolean;
  toggle(): void;
  focus(): void;
  ask(text: string): void;
}

/** 执行前的确认（写操作单击确认；高危 / 生产环境输入数据库名） */
function ConfirmRun({ plan, asset, onDone }: { plan: SqlPlan; asset: DbAsset; onDone(ok: boolean, text?: string): void }): React.JSX.Element {
  const [text, setText] = useState('');
  const writes = plan.items.filter((x) => x.kind === 'write' || x.kind === 'danger');
  const typed = plan.confirm === 'type';
  return (
    <Modal
      open
      title={
        <Space>
          <WarningFilled style={{ color: typed ? '#ff4d4f' : '#faad14' }} />
          {typed ? `高危操作：输入「${asset.name}」确认` : '确认执行写操作'}
        </Space>
      }
      okText="确认执行"
      okButtonProps={{ danger: typed, disabled: typed && text.trim() !== asset.name, 'data-testid': 'sql-confirm-ok' } as never}
      cancelText="取消"
      onOk={() => onDone(true, text.trim())}
      onCancel={() => onDone(false)}
      width={640}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        {asset.production && !writes.some((w) => w.kind === 'danger') ? `「${asset.name}」是生产环境。` : ''}下面 {writes.length} 条语句会修改数据，每条单独提交，出错时这一条回滚、后面的不再执行：
      </Typography.Paragraph>
      <div className="sql-confirm-list" data-testid="sql-confirm-list">
        {writes.map((w, i) => (
          <div key={i} className="sql-confirm-item">
            <Tag color={KIND_TAG[w.kind].color} bordered={false}>
              {KIND_TAG[w.kind].text}
            </Tag>
            <code className="mono">{w.text.length > 300 ? `${w.text.slice(0, 300)}…` : w.text}</code>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {w.reasons.join('；')}
            </Typography.Text>
          </div>
        ))}
      </div>
      {typed && <Input autoFocus placeholder={`输入「${asset.name}」确认`} value={text} onChange={(e) => setText(e.target.value)} onPressEnter={() => text.trim() === asset.name && onDone(true, text.trim())} data-testid="sql-confirm-input" style={{ marginTop: 12 }} />}
    </Modal>
  );
}

/** 结果区：每个结果集一个标签 + 「消息」 */
function Results({ tab, asset, onDiagnose, onLocate }: { tab: SqlTab; asset: DbAsset | undefined; onDiagnose(item: SqlExecItem): void; onLocate(i: number): void }): React.JSX.Element {
  const { message } = App.useApp();
  const rt = useSqlWorkbench((s) => runtimeOf(s, tab.id));
  const sets = rt.results.map((r, i) => ({ r, i })).filter(({ r }) => r.ok && r.columns.length > 0).slice(-10);
  const exportAll = async (item: SqlExecItem): Promise<void> => {
    if (!asset) return;
    const path = await invoke('dialog.saveFile', { title: '导出全部结果', defaultName: `${asset.name.replace(/[\\/:*?"<>|]/g, '_')}-查询结果.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!path) return;
    try {
      const r = await invoke('db.exportQuery', { id: asset.id, database: tab.database, schema: tab.schema, sql: item.text, path });
      void message.success(`已导出 ${r.rows} 行${r.truncated ? '（达到 10 万行上限）' : ''}到 ${path}`);
    } catch (e) {
      void message.error(errorMessage(e));
    }
  };
  if (rt.running && !rt.results.length)
    return (
      <div className="sql-results-empty">
        <Typography.Text type="secondary">执行中…</Typography.Text>
      </div>
    );
  if (rt.error)
    return (
      <div className="sql-results-empty error" data-testid="sql-error">
        <CloseCircleFilled style={{ color: '#ff4d4f' }} /> {rt.error}
      </div>
    );
  if (!rt.results.length)
    return (
      <div className="sql-results-empty">
        <Typography.Text type="secondary">⌘ / Ctrl + Enter 执行选中的部分或光标所在的语句，⇧ + ⌘ / Ctrl + Enter 执行全部</Typography.Text>
      </div>
    );
  const messages = (
    <div className="sql-messages" data-testid="sql-messages">
      {rt.results.map((r, i) => (
        <div key={i} className={`sql-msg ${r.ok ? '' : 'error'}`}>
          {r.ok ? <CheckCircleFilled style={{ color: '#52c41a' }} /> : <CloseCircleFilled style={{ color: '#ff4d4f' }} />}
          <code className="mono sql-msg-sql" onClick={() => onLocate(i)} title="在编辑器里选中这条语句">
            {r.text.replace(/\s+/g, ' ').slice(0, 160)}
          </code>
          <span className="sql-msg-res">
            {r.ok ? (r.columns.length ? `返回 ${r.rowCount} 行${r.truncated ? '（达到显示上限）' : ''}` : r.affected !== null ? `影响 ${r.affected} 行` : '执行成功') : r.error}
            {r.ok && ` · ${r.durationMs} ms`}
          </span>
          {!r.ok && (
            <Button size="small" type="link" icon={<BugOutlined />} onClick={() => onDiagnose(r)} data-testid="sql-diagnose">
              AI 诊断
            </Button>
          )}
        </div>
      ))}
      {rt.stopped && <Typography.Text type="warning">已停止，后面的语句没有执行</Typography.Text>}
    </div>
  );
  const items = [
    ...sets.map(({ r, i }, n) => ({
      key: `r${i}`,
      label: `结果 ${n + 1}`,
      children: (
        <DbResultView
          fill
          name={asset?.name ?? '数据库'}
          table={{ columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated, durationMs: r.durationMs }}
          summary={`返回 ${r.rowCount} 行${r.truncated ? `（只显示前 ${r.rowCount} 行）` : ''} · ${r.durationMs} ms`}
          actions={
            <Tooltip title="重新执行这条查询，把全部结果写成 CSV（最多 10 万行）">
              <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => void exportAll(r)} data-testid="sql-export-all">
                导出全部
              </Button>
            </Tooltip>
          }
        />
      ),
    })),
    { key: 'messages', label: `消息${rt.results.some((r) => !r.ok) ? ' ⚠' : ''}`, children: messages },
  ];
  const view = items.some((x) => x.key === rt.view) ? rt.view : items[0].key;
  return <Tabs size="small" className="sql-results-tabs" activeKey={view} onChange={(k) => useSqlWorkbench.getState().setRuntime(tab.id, { view: k })} items={items} />;
}

/** AI 抽屉：问题输入（写 SQL）、结果 Markdown、SQL 代码块的替换 / 插入 / 复制 */
/** 一个编辑器标签：工具栏、编辑器、结果、AI 抽屉 */
function SqlTabView({ tab, selectedTables, active, chat }: { tab: SqlTab; selectedTables: string[]; active: boolean; chat: ChatApi }): React.JSX.Element {
  const { message } = App.useApp();
  const assets = useDatabases((s) => s.list);
  const asset = assets.find((a) => a.id === tab.dbId);
  const dialect = dialectOf(asset);
  const st = useSqlWorkbench();
  const rt = runtimeOf(st, tab.id);
  const api = useRef<SqlEditorApi | null>(null);
  const [apiState, setApiState] = useState<SqlEditorApi | null>(null);
  const [confirm, setConfirm] = useState<{ plan: SqlPlan; resolve(v: { ok: boolean; text?: string }): void } | null>(null);
  /** 最近一次执行的 SQL 在编辑器里的起点（消息里点语句时定位） */
  const runBase = useRef<{ base: number; plan: SqlPlan } | null>(null);

  const top = asset ? st.objects[objKey(asset.id, null, null)] : undefined;
  const database = asset?.type === 'SQLITE' ? null : tab.database || asset?.database || (top?.kind === 'databases' ? top.current : null) || null;
  const schemas = asset?.type === 'POSTGRES' && database ? st.objects[objKey(asset.id, database, null)] : undefined;
  const schema = asset?.type === 'POSTGRES' ? tab.schema || 'public' : null;
  const tables = asset ? st.objects[objKey(asset.id, asset.type === 'SQLITE' ? null : database, asset.type === 'POSTGRES' ? schema : null)] : undefined;
  const cols = asset ? st.columns[objKey(asset.id, asset.type === 'SQLITE' ? null : database, asset.type === 'POSTGRES' ? schema : null)] : undefined;

  // 切换数据库 / 库 / schema 时加载库列表、表和列（补全用）
  useEffect(() => {
    if (!asset) return;
    const s = useSqlWorkbench.getState();
    const fail = (): undefined => undefined;
    if (asset.type !== 'SQLITE') void s.loadObjects(asset.id, null, null).catch(fail);
    if (asset.type === 'POSTGRES' && database) void s.loadObjects(asset.id, database, null).catch(fail);
    const db = asset.type === 'SQLITE' ? null : database;
    if (asset.type !== 'SQLITE' && !db) return;
    void s
      .loadObjects(asset.id, db, asset.type === 'POSTGRES' ? schema : null)
      .then((l) => (l.kind === 'tables' && l.items.length ? s.loadColumns(asset.id, db, asset.type === 'POSTGRES' ? schema : null, l.items.slice(0, 50).map((t) => t.name)) : undefined))
      .catch(fail);
  }, [asset?.id, database, schema]);

  // 双击表新开的标签：编辑器准备好后执行一次
  useEffect(() => {
    if (!rt.autoRun || !asset || !apiState) return;
    st.setRuntime(tab.id, { autoRun: false });
    void exec('all');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rt.autoRun, asset?.id, apiState]);

  const completion = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const t of tables?.kind === 'tables' ? tables.items : []) out[t.name] = (cols ?? []).filter((c) => c.table === t.name).map((c) => c.name);
    return out;
  }, [tables, cols]);

  const setTab = (patch: Partial<SqlTab>): void => st.update(tab.id, patch);

  /** 要执行的 SQL：选中的部分 / 光标所在语句 / 全部 */
  const pick = async (mode: 'current' | 'all'): Promise<{ sql: string; base: number } | null> => {
    const ed = api.current;
    const value = ed?.value() ?? tab.sql;
    if (mode === 'all') return value.trim() ? { sql: value, base: 0 } : null;
    const sel = ed?.selection();
    if (sel && sel.text.trim()) return { sql: sel.text, base: sel.from };
    const all = await invoke('db.plan', { id: asset!.id, sql: value });
    const cur = ed?.cursor() ?? value.length;
    const item = all.items.find((x) => cur >= x.start && cur <= x.end + 1) ?? [...all.items].reverse().find((x) => x.start <= cur) ?? all.items[0];
    return item ? { sql: item.text, base: item.start } : null;
  };

  /** explicit：右侧 AI 对话里点「执行」的 SQL（不改编辑器内容，结果照样显示在下面） */
  const exec = async (mode: 'current' | 'all' | 'explain', explicit?: string): Promise<void> => {
    if (!asset) return void message.warning('先在工具栏选择数据库');
    if (rt.running) return void message.info('上一条还在执行');
    try {
      const picked = explicit !== undefined ? { sql: explicit, base: -1 } : await pick(mode === 'all' ? 'all' : 'current');
      if (!picked) return void message.info('没有可以执行的 SQL');
      const sql = mode === 'explain' ? `${dialect === 'sqlite' ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'} ${picked.sql.trim().replace(/;\s*$/, '')}` : picked.sql;
      const plan = await invoke('db.plan', { id: asset.id, sql });
      if (plan.error) {
        st.setRuntime(tab.id, { error: plan.error, results: [] });
        return;
      }
      let confirmed = false;
      let confirmText: string | undefined;
      if (plan.confirm !== 'none') {
        const r = await new Promise<{ ok: boolean; text?: string }>((resolve) => setConfirm({ plan, resolve }));
        setConfirm(null);
        if (!r.ok) return;
        confirmed = true;
        confirmText = r.text;
      }
      runBase.current = mode === 'explain' || picked.base < 0 ? null : { base: picked.base, plan };
      const runId = `${tab.id}-${Date.now()}`;
      st.setRuntime(tab.id, { running: true, runId, error: null, results: [], stopped: false });
      const res = await invoke('db.exec', { id: asset.id, database, schema, sql, runId, confirmed, confirmText });
      const firstSet = res.items.findIndex((x) => x.ok && x.columns.length > 0);
      st.setRuntime(tab.id, { running: false, runId: null, results: res.items, stopped: res.stopped, view: res.items.some((x) => !x.ok) || firstSet < 0 ? 'messages' : `r${firstSet}` });
    } catch (e) {
      st.setRuntime(tab.id, { running: false, runId: null, error: errorMessage(e), results: [] });
    }
  };

  const stop = (): void => {
    if (rt.runId) void invoke('db.cancel', { runId: rt.runId });
  };

  const format = (): void => {
    const ed = api.current;
    if (!ed) return;
    const sel = ed.selection();
    try {
      const out = formatSql(sel.text.trim() ? sel.text : ed.value(), { language: FORMAT_LANG[dialect], keywordCase: 'upper', tabWidth: 2 });
      if (sel.text.trim()) ed.insert(out);
      else ed.replaceAll(out);
    } catch (e) {
      void message.error(`格式化失败：${(e as Error).message.split('\n')[0]}`);
    }
  };

  /** 解释 / 优化 / 诊断：把 SQL 发到右侧的 AI 对话（第二十九轮：对话形式，可以接着追问） */
  const askAbout = async (kind: 'explain' | 'optimize'): Promise<void> => {
    if (!asset) return void message.warning('先在工具栏选择数据库');
    const sql = (await pick('current'))?.sql?.trim();
    if (!sql) return void message.info('先在编辑器里写好（或选中）要处理的 SQL');
    chat.ask(kind === 'explain' ? `解释这条 SQL 在做什么，并指出潜在问题：${fence(sql)}` : `分析这条 SQL 的性能，结合表结构和索引给出优化建议和改写后的 SQL：${fence(sql)}`);
  };

  // 右侧 AI 对话的上下文跟着当前标签：数据库、库、schema、选中的表、编辑器里的 SQL
  useEffect(() => {
    if (!active || !asset) return;
    useDbAgent.getState().setSqlContext({ dbId: asset.id, database, schema, tables: selectedTables, sql: tab.sql.slice(0, 4000) });
    useDbAgent.setState({ databaseIds: [asset.id] });
  }, [active, asset?.id, database, schema, selectedTables.join('\u0000'), tab.sql]);

  // 右侧 AI 对话里点 SQL 的「执行」/「插入」
  useEffect(() => {
    tabRunners.set(tab.id, {
      run: (sql) => void exec('current', sql),
      insert: (sql) => {
        const ed = api.current;
        if (!ed) return;
        ed.insert(`${sql.trim()}\n`);
        message.success('已插入编辑器');
      },
    });
  });
  useEffect(() => () => void tabRunners.delete(tab.id), [tab.id]);

  const locate = (i: number): void => {
    const b = runBase.current;
    const item = b?.plan.items[i];
    if (b && item) api.current?.select(b.base + item.start, b.base + item.end);
  };

  return (
    <div className="sql-tab" data-testid="sql-tab">
      <div className="sql-toolbar">
        <Select
          size="small"
          value={tab.dbId ?? undefined}
          placeholder="选择数据库"
          style={{ width: 170 }}
          onChange={(v) => {
            const a = assets.find((x) => x.id === v);
            setTab({ dbId: v, database: a?.database || null, schema: null, title: tab.sql.trim() ? tab.title : `${a?.name ?? ''}：查询` });
          }}
          options={assets.map((a) => ({ value: a.id, label: `${a.name}（${DB_TYPE_LABEL[a.type]}）` }))}
          data-testid="sql-asset"
        />
        {asset && asset.type !== 'SQLITE' && (
          <Select
            size="small"
            showSearch
            value={database ?? undefined}
            placeholder="库"
            style={{ width: 140 }}
            onChange={(v) => setTab({ database: v, schema: null })}
            options={(top?.kind === 'databases' ? top.items : []).map((d) => ({ value: d.name, label: d.name }))}
            data-testid="sql-database"
          />
        )}
        {asset?.type === 'POSTGRES' && (
          <Select size="small" value={schema ?? undefined} style={{ width: 120 }} onChange={(v) => setTab({ schema: v })} options={(schemas?.kind === 'schemas' ? schemas.items : []).map((d) => ({ value: d.name, label: d.name }))} data-testid="sql-schema" />
        )}
        <span className="sql-toolbar-sep" />
        <Tooltip title="执行选中的部分或光标所在的语句（⌘ / Ctrl + Enter）">
          <Button size="small" type="primary" icon={<CaretRightOutlined />} loading={rt.running} disabled={!asset} onClick={() => void exec('current')} data-testid="sql-run">
            执行
          </Button>
        </Tooltip>
        <Tooltip title="按分号拆开依次执行全部语句（⇧ + ⌘ / Ctrl + Enter）">
          <Button size="small" icon={<ForwardOutlined />} disabled={!asset || rt.running} onClick={() => void exec('all')} data-testid="sql-run-all">
            执行全部
          </Button>
        </Tooltip>
        <Tooltip title="查看光标所在语句的执行计划（EXPLAIN，不执行语句）">
          <Button size="small" icon={<NodeIndexOutlined />} disabled={!asset || rt.running} onClick={() => void exec('explain')} data-testid="sql-explain-plan">
            计划
          </Button>
        </Tooltip>
        <Tooltip title="格式化（有选中时只格式化选中的部分）">
          <Button size="small" icon={<AlignLeftOutlined />} onClick={format} data-testid="sql-format">
            格式化
          </Button>
        </Tooltip>
        {rt.running && (
          <Button size="small" danger icon={<StopOutlined />} onClick={stop} data-testid="sql-stop">
            停止
          </Button>
        )}
        <span className="sql-toolbar-sep" />
        <Tooltip title="在右侧的 AI 对话里用自然语言描述要查什么，AI 根据表结构写出 SQL，点「执行」直接看结果">
          <Button size="small" icon={<ThunderboltOutlined />} disabled={!asset} onClick={() => chat.focus()} data-testid="sql-ai-nl2sql">
            AI 写 SQL
          </Button>
        </Tooltip>
        <Tooltip title="解释选中的 SQL 或光标所在的语句（在右侧的 AI 对话里）">
          <Button size="small" icon={<QuestionCircleOutlined />} disabled={!asset} onClick={() => void askAbout('explain')} data-testid="sql-ai-explain">
            解释
          </Button>
        </Tooltip>
        <Tooltip title="结合表结构和索引给出优化建议（在右侧的 AI 对话里）">
          <Button size="small" icon={<RobotOutlined />} disabled={!asset} onClick={() => void askAbout('optimize')} data-testid="sql-ai-optimize">
            优化
          </Button>
        </Tooltip>
        <Tooltip title={chat.open ? '收起右侧的 AI 对话' : '打开右侧的 AI 对话'}>
          <Button size="small" type={chat.open ? 'primary' : 'default'} ghost={chat.open} icon={<MessageOutlined />} onClick={chat.toggle} style={{ marginLeft: 'auto' }} data-testid="sql-chat-toggle">
            问 AI
          </Button>
        </Tooltip>
      </div>
      <div className="sql-body">
        <div className="sql-main">
          <div className="sql-editor-box">
            <SqlEditor
              value={tab.sql}
              onChange={(v) => setTab({ sql: v })}
              dialect={dialect}
              schema={completion}
              onRun={() => void exec('current')}
              onRunAll={() => void exec('all')}
              apiRef={(a) => {
                api.current = a;
                setApiState(a);
              }}
              placeholder={asset ? `在这里写 ${DB_TYPE_LABEL[asset.type]} 的 SQL，例如 SELECT * FROM 表 LIMIT 100` : '先在左边或工具栏选择数据库'}
              testId="sql-editor"
            />
          </div>
          <div className="sql-results" data-testid="sql-results">
            <Results tab={tab} asset={asset} onDiagnose={(r) => chat.ask(`这条 SQL 执行失败了，说明原因并给出修正后的 SQL：${fence(r.text)}\n\n数据库返回的错误：\n${r.error ?? ''}`)} onLocate={locate} />
          </div>
        </div>
      </div>
      {confirm && asset && <ConfirmRun plan={confirm.plan} asset={asset} onDone={(ok, text) => confirm.resolve({ ok, text })} />}
    </div>
  );
}

/**
 * SQL 工作台（第十八轮，文档一 6.32.1）：左边库表树，中间编辑器标签（每个标签绑定数据库 + 库），下面结果；
 * 第二十九轮：右侧是 AI 对话（和终端页右侧的 AI 面板一样，独立的对话，默认 Ask 模式），自然语言写 SQL、解释 / 优化 / 诊断都在这里，
 * 回答里的 SQL 点「执行」在当前标签里执行，结果显示在左边的结果区。
 */
export function SqlWorkbench({ onEditAsset }: { onEditAsset(a: DbAsset): void }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const assets = useDatabases((s) => s.list);
  const tabs = useSqlWorkbench((s) => s.tabs);
  const active = useSqlWorkbench((s) => s.active);
  const [selected, setSelected] = useState<DbNodeRef[]>([]);
  // 右侧的 AI 对话（第二十九轮）：默认打开，记住开关
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem(CHAT_KEY) !== '0');
  const [chatFocus, setChatFocus] = useState(0);
  const [chatWidth, setChatWidth] = useState(() => Math.min(Math.max(Number(localStorage.getItem(`${CHAT_KEY}.width`)) || 400, 320), 720));
  /** 拖动左边缘调整对话的宽度 */
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = chatWidth;
    let w = w0;
    const move = (ev: MouseEvent): void => {
      w = Math.min(Math.max(w0 + x0 - ev.clientX, 320), 720);
      setChatWidth(w);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      localStorage.setItem(`${CHAT_KEY}.width`, String(w));
    };
    document.body.classList.add('col-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const setChat = useCallback((open: boolean) => {
    setChatOpen(open);
    localStorage.setItem(CHAT_KEY, open ? '1' : '0');
  }, []);
  const chat: ChatApi = {
    open: chatOpen,
    toggle: () => (chatOpen ? setChat(false) : aiAllowed() ? setChat(true) : promptLogin()),
    focus: () => {
      if (!aiAllowed()) return promptLogin();
      setChat(true);
      setChatFocus((n) => n + 1);
    },
    ask: (text) => {
      if (!aiAllowed()) return promptLogin();
      setChat(true);
      // 面板刚打开时等它挂载好再发送
      setTimeout(() => useDbAgent.getState().ask(text, useDbAgent.getState().mode), 0);
    },
  };
  // 先读好模型：从工具栏按钮发来的第一条提问不会因为模型还没读到而丢掉
  useEffect(() => {
    if (aiAllowed()) void useDbAgent.getState().loadProviders().catch(() => undefined);
  }, []);
  const runner: SqlRunner = {
    run: (sql) => (active && tabRunners.get(active) ? tabRunners.get(active)!.run(sql) : void message.warning('先打开一个查询')),
    insert: (sql) => (active && tabRunners.get(active) ? tabRunners.get(active)!.insert(sql) : void message.warning('先打开一个查询')),
  };

  // 第一次打开：给第一个数据库开一个标签；删掉的数据库对应的标签保留（工具栏重新选择）
  useEffect(() => {
    if (!tabs.length && assets.length) useSqlWorkbench.getState().addTab({ dbId: assets[0].id, database: assets[0].database || null, title: `${assets[0].name}：查询` });
  }, [tabs.length, assets.length]);

  const activeTab = tabs.find((t) => t.id === active);
  const dialectFor = (id: string): SqlDialectName => dialectOf(assets.find((a) => a.id === id));
  const actions: DbTreeActions = {
    openTable: (r) => {
      const d = dialectFor(r.dbId);
      const s = useSqlWorkbench.getState();
      const id = s.addTab({ dbId: r.dbId, database: r.database, schema: r.schema, title: r.name, sql: `SELECT * FROM ${qualified(d, r)} LIMIT 100;` });
      s.setRuntime(id, { autoRun: true });
    },
    newQuery: (r) => {
      const a = assets.find((x) => x.id === r.dbId);
      useSqlWorkbench.getState().addTab({ dbId: r.dbId, database: r.database ?? (a?.database || null), schema: r.schema, title: `${a?.name ?? ''}：查询` });
    },
    describe: (r) => {
      void invoke('db.describe', { id: r.dbId, database: r.database, schema: r.schema, table: r.name })
        .then((text) => {
          modal.info({ title: `表结构：${r.name}`, width: 760, icon: null, content: <pre className="mono selectable sql-ddl">{text}</pre>, okText: '关闭' });
        })
        .catch((e) => message.error(errorMessage(e)));
    },
    template: (r, kind) => {
      const d = dialectFor(r.dbId);
      const s = useSqlWorkbench.getState();
      void s
        .loadColumns(r.dbId, r.database, r.schema, [r.name])
        .then((cols) => {
          const names = cols.map((c) => quote(d, c.name));
          const sql = kind === 'select' ? `SELECT ${names.join(', ') || '*'}\nFROM ${qualified(d, r)}\nWHERE 1 = 1\nLIMIT 100;` : `INSERT INTO ${qualified(d, r)} (${names.join(', ')})\nVALUES (${names.map(() => '?').join(', ')});`;
          const cur = activeTab && activeTab.dbId === r.dbId ? activeTab : null;
          if (cur) s.update(cur.id, { sql: `${cur.sql.trimEnd()}${cur.sql.trim() ? '\n\n' : ''}${sql}` });
          else s.addTab({ dbId: r.dbId, database: r.database, schema: r.schema, title: r.name, sql });
        })
        .catch((e) => message.error(errorMessage(e)));
    },
    editAsset: onEditAsset,
    // 右键「问 AI」：在右侧的 AI 对话里问（当前标签不是这个数据库时先新开一个查询）
    askAi: (a) => {
      if (!aiAllowed()) return promptLogin();
      if (activeTab?.dbId !== a.id) useSqlWorkbench.getState().addTab({ dbId: a.id, database: a.database || null, title: `${a.name}：查询` });
      chat.focus();
    },
  };

  const siderCollapsed = useApp((s) => s.siderCollapsed);

  return (
    <div className="sql-wb" data-testid="sql-workbench">
      <CollapsibleSider collapsed={siderCollapsed} width={260}>
        <aside className="sql-wb-side">
          <DbTree actions={actions} selected={selected.map((r) => JSON.stringify(['table', r.dbId, r.database, r.schema, r.table, r.name]))} onSelect={setSelected} />
        </aside>
      </CollapsibleSider>
      <section className="sql-wb-main">
        {tabs.length === 0 ? (
          <Empty description={assets.length ? '没有打开的查询' : '还没有数据库：切换到「连接管理」添加'} style={{ marginTop: 80 }}>
            {assets.length > 0 && (
              <Button type="primary" onClick={() => useSqlWorkbench.getState().addTab({ dbId: assets[0].id, database: assets[0].database || null })}>
                新建查询
              </Button>
            )}
          </Empty>
        ) : (
          <Tabs
            type="editable-card"
            size="small"
            className="sql-wb-tabs"
            activeKey={active ?? undefined}
            onChange={(k) => useSqlWorkbench.getState().setActive(k)}
            onEdit={(key, act) => {
              const s = useSqlWorkbench.getState();
              if (act === 'add') s.addTab({ dbId: activeTab?.dbId ?? assets[0]?.id ?? null, database: activeTab?.database ?? null, schema: activeTab?.schema ?? null });
              else s.closeTab(String(key));
            }}
            items={tabs.map((t) => ({
              key: t.id,
              label: <span data-testid={`sql-tab-${t.title}`}>{t.title}</span>,
              children: (
                <div className="sql-tab-host" data-tab-id={t.id}>
                  <SqlTabView tab={t} active={t.id === active} chat={chat} selectedTables={selected.filter((r) => r.dbId === t.dbId).map((r) => r.name)} />
                </div>
              ),
            }))}
          />
        )}
      </section>
      {chatOpen && aiAllowed() && (
        <aside className="sql-chat" data-testid="sql-chat" style={{ width: chatWidth }}>
          <div className="sql-chat-resizer" onMouseDown={startResize} title="拖动调整宽度" />
          <AgentStoreContext.Provider value={useDbAgent}>
            <SqlRunContext.Provider value={runner}>
              <AgentPanel variant="side" focusSeq={chatFocus} />
            </SqlRunContext.Provider>
          </AgentStoreContext.Provider>
        </aside>
      )}
    </div>
  );
}
