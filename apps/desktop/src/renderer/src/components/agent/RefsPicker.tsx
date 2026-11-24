import { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Select, Space, Typography } from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  CheckOutlined,
  CloudServerOutlined,
  CodeOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  FolderOutlined,
  PaperClipOutlined,
  PlayCircleOutlined,
  ReadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { McpServerConfig } from '@itm/protocol';
import { invoke } from '../../api';
import { useAccount } from '../../store/account';
import { useAgentStore, terminalTabs } from '../../store/agent';
import { useApp } from '../../store/app';
import { useHosts } from '../../store/hosts';
import { useLibrary } from '../../store/library';
import { useTabs } from '../../store/tabs';
import { DB_TYPE_LABEL, dbWhere, useDatabases } from '../../store/databases';
import { useKb } from '../../store/kb';
import { useSkillRun } from './SkillRunDialog';

type Cat = 'terminal' | 'host' | 'db' | 'kb' | 'folder' | 'file' | 'skill' | 'note' | 'mcp';

const CATS: { key: Cat; label: string; icon: React.ReactNode }[] = [
  { key: 'terminal', label: '终端', icon: <CodeOutlined /> },
  { key: 'host', label: '主机', icon: <CloudServerOutlined /> },
  { key: 'db', label: '数据库', icon: <DatabaseOutlined /> },
  { key: 'kb', label: '知识库', icon: <ReadOutlined /> },
  { key: 'folder', label: '分组', icon: <FolderOutlined /> },
  { key: 'file', label: '文件', icon: <FileTextOutlined /> },
  { key: 'skill', label: 'Skill', icon: <ThunderboltOutlined /> },
  { key: 'note', label: '笔记', icon: <BookOutlined /> },
  { key: 'mcp', label: 'MCP', icon: <ApiOutlined /> },
];

interface Row {
  id: string;
  title: string;
  sub?: string;
  checked: boolean;
  disabled?: boolean;
  toggle(): void;
  extra?: React.ReactNode;
  testId?: string;
}

/**
 * 添加引用（AI 对话框上方的「添加」）：顶部按类别切换，一个搜索框，点一行就勾选 / 取消。
 * 已经引用的内容显示在对话框上方的标签里，可以直接点 × 去掉。
 */
export function RefsPicker(): React.JSX.Element {
  const st = useAgentStore()();
  const tabs = useTabs((s) => s.tabs);
  const hosts = useHosts((s) => s.hosts);
  const folders = useHosts((s) => s.folders);
  const notes = useLibrary((s) => s.notes);
  const account = useAccount((s) => s.state);
  const databases = useDatabases((s) => s.list);
  const kbList = useKb((s) => s.list);
  const [cat, setCat] = useState<Cat>('terminal');
  const [q, setQ] = useState('');
  const [mcp, setMcp] = useState<McpServerConfig[]>([]);
  const [fileHost, setFileHost] = useState<string | null>(null);
  const [filePath, setFilePath] = useState('');

  useEffect(() => {
    void invoke('mcp.list')
      .then((r) => setMcp(r.servers.filter((s) => s.enabled)))
      .catch(() => undefined);
  }, []);
  /** 只看已选（清理引用时用）；Shift 点击的起点 */
  const [onlySel, setOnlySel] = useState(false);
  const [anchor, setAnchor] = useState<string | null>(null);
  useEffect(() => {
    setQ('');
    setOnlySel(false);
    setAnchor(null);
  }, [cat]);
  useEffect(() => {
    void useDatabases
      .getState()
      .load()
      .catch(() => undefined);
  }, []);
  // 知识库在服务端：登录后才有，账号状态变化时重新取
  useEffect(() => {
    void useKb
      .getState()
      .load()
      .catch(() => undefined);
  }, [account?.status, account?.profileId]);

  const rows = useMemo<Row[]>(() => {
    switch (cat) {
      case 'terminal':
        return terminalTabs(tabs).map((t) => ({
          id: t.id,
          title: t.title,
          sub: t.status === 'ready' ? (t.kind === 'local' ? '本机终端' : '已连接') : '未连接',
          checked: t.status === 'ready' && !st.excludedTabs.includes(t.id),
          disabled: t.status !== 'ready',
          toggle: () => st.toggleTab(t.id, st.excludedTabs.includes(t.id)),
        }));
      case 'host':
        return hosts
          .filter((h) => h.protocol === 'SSH')
          .map((h) => ({
            id: h.id,
            title: h.name,
            sub: `${h.username ? `${h.username}@` : ''}${h.address}`,
            checked: st.extraHostIds.includes(h.id),
            toggle: () => st.toggleHost(h.id, !st.extraHostIds.includes(h.id)),
          }));
      case 'db':
        return databases.map((d) => ({
          id: d.id,
          title: d.name,
          sub: `${DB_TYPE_LABEL[d.type]} ${dbWhere(d)}`,
          checked: st.databaseIds.includes(d.id),
          toggle: () => st.toggleDatabase(d.id, !st.databaseIds.includes(d.id)),
          testId: `ref-db-${d.name}`,
        }));
      case 'kb':
        if (account?.status !== 'valid') return [];
        return [
          { id: '*', title: '全部知识库', sub: '发送时按问题检索你能看到的所有知识库', checked: st.kbCollections.includes('*'), toggle: () => st.toggleKb('*', !st.kbCollections.includes('*')), testId: 'ref-kb-all' },
          ...kbList.map((c) => ({
            id: c.id,
            title: c.name,
            sub: c.description ?? '发送时按问题检索这个知识库',
            checked: st.kbCollections.includes(c.id),
            toggle: () => st.toggleKb(c.id, !st.kbCollections.includes(c.id)),
            testId: `ref-kb-${c.name}`,
          })),
        ];
      case 'folder':
        return folders.map((f) => ({ id: f.id, title: f.name, sub: '包含子分组里的主机', checked: st.folderIds.includes(f.id), toggle: () => st.toggleFolder(f.id, !st.folderIds.includes(f.id)) }));
      case 'skill':
        return st.skills.map((s) => ({
          id: s.id,
          title: s.title,
          sub: `${s.description ? `${s.description.slice(0, 40)} · ` : ''}约 ${s.tokens} token`,
          checked: st.skillIds.includes(s.id),
          toggle: () => st.toggleSkill(s.id, !st.skillIds.includes(s.id)),
          extra: (
            <Button
              size="small"
              type="text"
              icon={<PlayCircleOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                useSkillRun.getState().show({ skillId: s.id });
              }}
              data-testid={`refs-skill-run-${s.id}`}
            >
              运行
            </Button>
          ),
        }));
      case 'note':
        return notes.map((n) => ({ id: n.id, title: n.title, sub: '发给模型前脱敏', checked: st.noteIds.includes(n.id), toggle: () => st.toggleNote(n.id, !st.noteIds.includes(n.id)) }));
      case 'mcp':
        return mcp.map((s) => ({ id: s.id, title: s.name, sub: 'Agent 可以调用它的工具', checked: st.mcpServerIds.includes(s.id), toggle: () => st.toggleMcp(s.id, !st.mcpServerIds.includes(s.id)), testId: `ref-mcp-${s.name}` }));
      default:
        return [];
    }
  }, [cat, tabs, hosts, databases, kbList, account?.status, folders, notes, mcp, st]);

  const filtered = (q.trim() ? rows.filter((r) => `${r.title} ${r.sub ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())) : rows).filter((r) => !onlySel || r.checked);
  const checkedN = rows.filter((r) => r.checked).length;
  /** 批量勾选 / 取消（跳过不可选的） */
  const setRows = (list: Row[], on: boolean): void => list.forEach((r) => !r.disabled && r.checked !== on && r.toggle());
  /** 点一行：勾选 / 取消；按住 Shift 把上次点的那一行到这一行之间都设成同样的状态 */
  const click = (r: Row, shift: boolean): void => {
    const a = shift && anchor ? filtered.findIndex((x) => x.id === anchor) : -1;
    const b = filtered.findIndex((x) => x.id === r.id);
    if (a >= 0 && b >= 0) setRows(filtered.slice(Math.min(a, b), Math.max(a, b) + 1), !r.checked);
    else r.toggle();
    setAnchor(r.id);
  };
  // 知识库的「全部」和具体知识库互斥，不提供全选
  const canSelectAll = cat !== 'kb';
  const allOn = filtered.length > 0 && filtered.every((r) => r.checked || r.disabled);
  const countOf = (c: Cat): number =>
    c === 'terminal'
      ? terminalTabs(tabs).filter((t) => t.status === 'ready' && !st.excludedTabs.includes(t.id)).length
      : c === 'host'
        ? st.extraHostIds.length
        : c === 'db'
          ? st.databaseIds.length
          : c === 'kb'
            ? st.kbCollections.length
            : c === 'folder'
              ? st.folderIds.length
              : c === 'file'
                ? st.files.length + st.attachments.length
                : c === 'skill'
                  ? st.skillIds.length
                  : c === 'note'
                    ? st.noteIds.length
                    : st.mcpServerIds.length;

  const empty: Record<Cat, React.ReactNode> = {
    terminal: '还没有打开终端',
    host: '还没有 SSH 主机',
    db: (
      <>
        还没有数据库
        <Button size="small" type="link" onClick={() => useApp.getState().setPage('databases')}>
          去添加
        </Button>
      </>
    ),
    kb: account?.status === 'valid' ? '管理员还没有给你开放知识库' : '知识库在服务端，登录后可用',
    folder: '还没有主机分组',
    file: null,
    skill: (
      <>
        还没有 Skill
        <Button size="small" type="link" onClick={() => void invoke('skill.openDir')}>
          打开 Skill 目录
        </Button>
      </>
    ),
    note: '还没有笔记',
    mcp: (
      <>
        还没有启用的 MCP Server
        <Button size="small" type="link" onClick={() => useApp.getState().openSettings('mcp')}>
          去设置
        </Button>
      </>
    ),
  };

  return (
    <div className="refs-picker" data-testid="refs-panel">
      <div className="refs-cats" role="tablist">
        {CATS.map((c) => {
          const n = countOf(c.key);
          return (
            <button key={c.key} type="button" role="tab" aria-selected={cat === c.key} className={`refs-cat ${cat === c.key ? 'on' : ''}`} onClick={() => setCat(c.key)} data-testid={`refs-cat-${c.key}`}>
              {c.icon}
              <span>{c.label}</span>
              {n > 0 && <span className="refs-cat-n">{n}</span>}
            </button>
          );
        })}
      </div>

      {cat === 'file' ? (
        <div className="refs-file">
          <Button
            block
            icon={<PaperClipOutlined />}
            onClick={async () => {
              const path = await invoke('dialog.openFile', { title: '选择要发给 AI 的本机文件（文本，最多 200KB）' });
              if (path) st.addAttachment({ name: path.split(/[\\/]/).pop() ?? path, path });
            }}
          >
            添加本机文件…
          </Button>
          <Typography.Text type="secondary" className="refs-hint">
            远端文件（只带最后 500 行）
          </Typography.Text>
          <Select
            size="small"
            placeholder="选择主机"
            value={fileHost ?? undefined}
            onChange={setFileHost}
            options={hosts.filter((h) => h.protocol === 'SSH').map((h) => ({ value: h.id, label: h.name }))}
            showSearch
            optionFilterProp="label"
            style={{ width: '100%' }}
          />
          <Space.Compact style={{ width: '100%' }}>
            <Input size="small" placeholder="绝对路径，例如 /var/log/nginx/error.log" value={filePath} onChange={(e) => setFilePath(e.target.value)} />
            <Button
              size="small"
              type="primary"
              disabled={!fileHost || !filePath.trim().startsWith('/')}
              onClick={() => {
                st.addFile({ hostId: fileHost!, path: filePath.trim(), tailLines: 500 });
                setFilePath('');
              }}
            >
              引用
            </Button>
          </Space.Compact>
          {st.files.length + st.attachments.length > 0 && (
            <Typography.Text type="secondary" className="refs-hint">
              已引用 {st.files.length + st.attachments.length} 个文件（显示在对话框上方，只在下一次发送时带上）
            </Typography.Text>
          )}
        </div>
      ) : (
        <>
          {rows.length > 6 && <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} className="refs-search" />}
          {rows.length > 3 && (
            <div className="refs-bulk" data-testid="refs-bulk">
              <span className="refs-bulk-n">已选 {checkedN}</span>
              <Button size="small" type="text" className={onlySel ? 'on' : ''} disabled={!checkedN && !onlySel} onClick={() => setOnlySel((v) => !v)} data-testid="refs-only-selected">
                只看已选
              </Button>
              {canSelectAll && (
                <Button size="small" type="text" disabled={!filtered.length} onClick={() => setRows(filtered, !allOn)} data-testid="refs-select-all">
                  {allOn ? '取消全选' : q.trim() ? '全选搜索结果' : '全选'}
                </Button>
              )}
              <Button size="small" type="text" danger disabled={!checkedN} onClick={() => setRows(rows, false)} data-testid="refs-clear">
                清空
              </Button>
            </div>
          )}
          <div className="refs-rows">
            {filtered.map((r) => (
              <div
                key={r.id}
                role="checkbox"
                aria-checked={r.checked}
                aria-disabled={r.disabled}
                tabIndex={r.disabled ? -1 : 0}
                className={`refs-row ${r.checked ? 'on' : ''} ${r.disabled ? 'disabled' : ''}`}
                onClick={(e) => !r.disabled && click(r, e.shiftKey)}
                onKeyDown={(e) => !r.disabled && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), click(r, e.shiftKey))}
                data-testid={r.testId}
              >
                <span className="refs-check">{r.checked && <CheckOutlined />}</span>
                <div className="refs-row-main">
                  <div className="refs-row-title">{r.title}</div>
                  {r.sub && <div className="refs-row-sub">{r.sub}</div>}
                </div>
                {r.extra}
              </div>
            ))}
            {rows.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty[cat]} />}
            {rows.length > 0 && filtered.length === 0 && <Typography.Text type="secondary">{onlySel && !q.trim() ? '没有已选的项目' : '没有匹配的项目'}</Typography.Text>}
          </div>
        </>
      )}
      <div className="refs-foot" data-testid="refs-kb">
        <BookOutlined /> {account?.status === 'valid' ? 'AI 会按需检索团队知识库；在「知识库」里引用后，每次发送都先检索，任何模型都能用上' : account && account.status !== 'none' ? '知识库在服务端，重新登录后可用' : '知识库在服务端，登录后可用'}
      </div>
    </div>
  );
}
