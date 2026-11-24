import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Checkbox, Dropdown, Empty, Input, Segmented, Select, Space, Tooltip, Typography, type MenuProps } from 'antd';
import { CloseCircleOutlined, CloudDownloadOutlined, CopyOutlined, DeleteOutlined, EditOutlined, FolderOutlined, FileMarkdownOutlined, FileWordOutlined, ImportOutlined, PlusOutlined, PushpinFilled, PushpinOutlined, RobotOutlined, SearchOutlined, ShareAltOutlined, UndoOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Note } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useLibrary } from '../../store/library';
import { useAgent } from '../../store/agent';
import { useApp } from '../../store/app';
import { useWorkspaceUi } from '../../store/workspace';
import { formatRelative } from '../../util/format';
import { GroupList, type GroupKey } from './GroupList';
import { MD_COMPONENTS } from '../../components/Markdown';
import { useShare, useSharePull } from '../../store/share';
import { TopBarSlot } from '../../components/TopBar';
import { CollapsibleSider } from '../../components/CollapsibleSider';

const SAVE_DELAY = 600;

/** 列表里的摘要：去掉行首的 Markdown 标记（标题、引用、列表）和代码块围栏，正文里的 - * 保留（例如 df -h） */
function excerpt(md: string): string {
  return md
    .split('\n')
    .filter((l) => !/^\s*```/.test(l))
    .map((l) => l.replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/, '').replace(/`/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** 笔记编辑区：标题、分组、置顶；正文 Markdown，可以切换预览。停止输入后自动保存 */
function NoteEditor({ note }: { note: Note }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const groups = useLibrary((s) => s.noteGroups);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [view, setView] = useState<'edit' | 'preview'>(note.content ? 'preview' : 'edit');
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ title, content, groupId: note.groupId });
  /** 这次打开后还没保存过：第一次保存时把打开前的内容记为「上一个版本」 */
  const firstSave = useRef(true);

  const flush = async (): Promise<void> => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      const snapshot = firstSave.current;
      firstSave.current = false;
      await invoke('note.save', { id: note.id, input: { groupId: latest.current.groupId, title: latest.current.title, content: latest.current.content, snapshot } });
      setSaved(true);
      await useLibrary.getState().reloadNotes();
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  const schedule = (patch: Partial<typeof latest.current>): void => {
    latest.current = { ...latest.current, ...patch };
    setSaved(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
  };
  // 切换笔记 / 离开页面前把没保存的内容存掉
  useEffect(
    () => () => {
      if (timer.current) void flush();
    },
    [],
  );

  return (
    <div className="note-editor" data-testid="note-editor">
      <div className="note-editor-bar">
        <Input
          variant="borderless"
          className="note-title"
          value={title}
          placeholder="标题"
          maxLength={200}
          onChange={(e) => {
            setTitle(e.target.value);
            schedule({ title: e.target.value });
          }}
          data-testid="note-title"
        />
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {saved ? `已保存 · ${formatRelative(note.updatedAt)}` : '正在保存…'}
        </Typography.Text>
      </div>
      <div className="note-editor-tools">
        <Select
          size="small"
          style={{ width: 160 }}
          value={note.groupId ?? ''}
          options={[{ value: '', label: '未分组' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
          onChange={(v: string) => schedule({ groupId: v || null })}
        />
        <Segmented
          size="small"
          value={view}
          onChange={(v) => setView(v as 'edit' | 'preview')}
          options={[
            { label: '编辑', value: 'edit' },
            { label: '预览', value: 'preview' },
          ]}
        />
        <Space size={4} style={{ marginLeft: 'auto' }}>
          <Tooltip title="在 AI 对话里引用这篇笔记">
            <Button
              size="small"
              icon={<RobotOutlined />}
              onClick={() => {
                useAgent.getState().toggleNote(note.id, true);
                useWorkspaceUi.getState().focusAi();
                // AI 对话模式里打开的笔记：回到对话；终端模式：到终端页右侧的 AI 面板
                if (useApp.getState().page === 'ai') useApp.getState().setAiView('chat');
                else useApp.getState().setPage('workspace');
              }}
            >
              引用到 AI
            </Button>
          </Tooltip>
          <Tooltip title={note.hasPrev ? `撤回到上一个版本${note.prevAt ? `（${formatRelative(note.prevAt)}）` : ''}；再点一次可以恢复` : '还没有可以撤回的版本'}>
            <Button
              size="small"
              icon={<UndoOutlined />}
              disabled={!note.hasPrev}
              onClick={() =>
                modal.confirm({
                  title: '撤回到上一个版本？',
                  content: '当前内容会成为新的「上一个版本」，可以再撤回回来。只保留一个版本。',
                  okText: '撤回',
                  cancelText: '取消',
                  onOk: async () => {
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = null;
                    try {
                      await invoke('note.revert', { id: note.id });
                      await useLibrary.getState().reloadNotes();
                      useLibrary.getState().bumpNote(note.id);
                    } catch (e) {
                      message.error(errorMessage(e));
                    }
                  },
                })
              }
              data-testid="note-revert"
            >
              撤回
            </Button>
          </Tooltip>
          <Tooltip title={note.pinned ? '取消置顶' : '置顶'}>
            <Button
              size="small"
              icon={note.pinned ? <PushpinFilled style={{ color: 'var(--itm-primary)' }} /> : <PushpinOutlined />}
              onClick={async () => {
                await invoke('note.pin', { id: note.id, pinned: !note.pinned });
                await useLibrary.getState().reloadNotes();
              }}
              data-testid="note-pin"
            />
          </Tooltip>
          <Tooltip title="分享这篇笔记">
            <Button size="small" icon={<ShareAltOutlined />} onClick={() => useShare.getState().open({ noteIds: [note.id] })} data-testid="note-share" />
          </Tooltip>
          <Tooltip title="删除">
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              onClick={() =>
                modal.confirm({
                  title: `删除笔记「${note.title}」？`,
                  okText: '删除',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: async () => {
                    if (timer.current) clearTimeout(timer.current);
                    timer.current = null;
                    await invoke('note.delete', { ids: [note.id] });
                    useLibrary.getState().selectNote(null);
                    await useLibrary.getState().reloadNotes();
                  },
                })
              }
            />
          </Tooltip>
        </Space>
      </div>
      {view === 'edit' ? (
        <Input.TextArea
          className="note-content"
          variant="borderless"
          value={content}
          placeholder="支持 Markdown：# 标题、- 列表、```代码块```"
          onChange={(e) => {
            setContent(e.target.value);
            schedule({ content: e.target.value });
          }}
          onBlur={() => timer.current && void flush()}
          data-testid="note-content"
        />
      ) : (
        <div className="note-preview md selectable" onDoubleClick={() => setView('edit')} title="双击编辑">
          {content.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{content}</ReactMarkdown> : <Typography.Text type="secondary">（空白笔记，双击开始编辑）</Typography.Text>}
        </div>
      )}
    </div>
  );
}

/** 「笔记」页（文档一 6.14） */
export function NotesPage(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const st = useLibrary();
  const [group, setGroup] = useState<GroupKey>('all');
  const [q, setQ] = useState('');
  /** 勾选的笔记（批量分享，第十三轮） */
  const [checked, setChecked] = useState<string[]>([]);

  useEffect(() => {
    void st.reloadNotes();
  }, []);
  useEffect(() => setChecked((c) => c.filter((id) => st.notes.some((n) => n.id === id))), [st.notes]);

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return st.notes
      .filter((n) => (group === 'all' ? true : group === 'none' ? !n.groupId : n.groupId === group))
      .filter((n) => !k || n.title.toLowerCase().includes(k) || n.content.toLowerCase().includes(k));
  }, [st.notes, group, q]);
  const current = st.notes.find((n) => n.id === st.selectedNoteId) ?? null;

  const create = async (inGroup: GroupKey = group): Promise<void> => {
    const note = await invoke('note.save', { id: null, input: { groupId: inGroup !== 'all' && inGroup !== 'none' ? inGroup : null, title: '新笔记', content: '' } });
    await st.reloadNotes();
    st.selectNote(note.id);
  };

  /** 右键菜单（第二十六轮）：笔记 / 列表空白处 */
  const [ctx, setCtx] = useState<{ x: number; y: number; note: Note | null } | null>(null);
  const noteMenu = (n: Note): MenuProps => ({
    items: [
      { key: 'open', label: '打开', icon: <EditOutlined /> },
      { key: 'ai', label: '引用到 AI 对话', icon: <RobotOutlined /> },
      { key: 'pin', label: n.pinned ? '取消置顶' : '置顶', icon: <PushpinOutlined /> },
      { key: 'copy', label: '复制正文', icon: <CopyOutlined /> },
      { key: 'move', label: '移动到', icon: <FolderOutlined />, children: [{ key: 'move:', label: '未分组' }, ...st.noteGroups.map((g) => ({ key: `move:${g.id}`, label: g.name }))] },
      { key: 'share', label: '分享…', icon: <ShareAltOutlined /> },
      { type: 'divider' },
      { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true },
    ],
    onClick: async ({ key }) => {
      setCtx(null);
      try {
        if (key === 'open') st.selectNote(n.id);
        if (key === 'ai') {
          useAgent.getState().toggleNote(n.id, true);
          useWorkspaceUi.getState().focusAi();
          if (useApp.getState().page === 'ai') useApp.getState().setAiView('chat');
          else useApp.getState().setPage('workspace');
        }
        if (key === 'pin') {
          await invoke('note.pin', { id: n.id, pinned: !n.pinned });
          await st.reloadNotes();
        }
        if (key === 'copy') await navigator.clipboard.writeText(n.content).then(() => message.success('已复制'));
        if (key.startsWith('move:')) {
          await invoke('note.move', { ids: [n.id], groupId: key.slice(5) || null });
          await st.reloadNotes();
        }
        if (key === 'share') useShare.getState().open({ noteIds: [n.id] });
        if (key === 'delete')
          modal.confirm({
            title: `删除笔记「${n.title}」？`,
            okText: '删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: async () => {
              await invoke('note.delete', { ids: [n.id] });
              if (st.selectedNoteId === n.id) st.selectNote(null);
              await st.reloadNotes();
            },
          });
      } catch (e) {
        message.error(errorMessage(e));
      }
    },
  });
  const blankMenu: MenuProps = {
    items: [
      { key: 'new', label: '新建笔记', icon: <PlusOutlined /> },
      { key: 'md', label: '导入 Markdown / 文本', icon: <FileMarkdownOutlined /> },
      { key: 'word', label: '导入 Word', icon: <FileWordOutlined /> },
      { key: 'share', label: '从分享码导入…', icon: <CloudDownloadOutlined /> },
    ],
    onClick: ({ key }) => {
      setCtx(null);
      if (key === 'new') void create(group);
      if (key === 'md') void importFiles(null, 'markdown');
      if (key === 'word') void importFiles(null, 'word');
      if (key === 'share') useSharePull.getState().show('notes');
    },
  };

  /** 从 Markdown / 文本文件导入（第二十二轮）：不传 paths 时选择文件；放进当前分组 */
  const [dropOver, setDropOver] = useState(false);
  const siderCollapsed = useApp((s) => s.siderCollapsed);
  const importFiles = async (paths: string[] | null, kind: 'markdown' | 'word' = 'markdown'): Promise<void> => {
    try {
      const r = await invoke('note.importFiles', { paths, kind, groupId: group !== 'all' && group !== 'none' ? group : null });
      if (!r.notes.length && !r.skipped.length) return;
      await st.reloadNotes();
      if (r.notes.length) st.selectNote(r.notes[0].id);
      const skipped = r.skipped.length ? `；跳过 ${r.skipped.length} 个：${r.skipped.slice(0, 3).map((x) => `${x.name}（${x.reason}）`).join('、')}${r.skipped.length > 3 ? '…' : ''}` : '';
      if (r.notes.length) message.success({ content: `已导入 ${r.notes.length} 篇笔记${skipped}`, duration: skipped ? 6 : 3 });
      else message.warning({ content: `没有导入笔记${skipped}`, duration: 6 });
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title">
            <span className="topbar-page-name">笔记</span>
            <span className="topbar-page-sub">排障记录、操作手册，可引用到 AI 对话</span>
          </div>
          <div className="topbar-ctx-actions no-drag">
            <Space size={6}>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'md', label: '导入 Markdown / 文本（.md .txt）', icon: <FileMarkdownOutlined /> },
                    { key: 'word', label: '导入 Word（.docx .doc）', icon: <FileWordOutlined /> },
                    { type: 'divider' },
                    { key: 'share', label: '从分享码导入…', icon: <CloudDownloadOutlined /> },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'md') void importFiles(null, 'markdown');
                    if (key === 'word') void importFiles(null, 'word');
                    if (key === 'share') useSharePull.getState().show('notes');
                  },
                }}
              >
                <Button size="small" icon={<ImportOutlined />} data-testid="note-import">
                  导入
                </Button>
              </Dropdown>
              <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => void create(group)} data-testid="note-new">
                新建笔记
              </Button>
            </Space>
          </div>
        </div>
      </TopBarSlot>
      <div
        className={`hosts-body ${dropOver ? 'note-drop-over' : ''}`}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          if (!dropOver) setDropOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDropOver(false);
          const paths = Array.from(e.dataTransfer.files).map((f) => window.itm.getPathForFile(f)).filter(Boolean);
          if (paths.length) void importFiles(paths);
        }}
        data-testid="notes-body"
      >
        <CollapsibleSider collapsed={siderCollapsed} width={236} gapOffset={10}>
          <GroupList
            title="笔记分组"
            testId="note-group"
            itemNoun="笔记"
            onCreateItem={(k) => {
              setGroup(k);
              void create(k);
            }}
            groups={st.noteGroups}
            total={st.notes.length}
            ungrouped={st.notes.filter((n) => !n.groupId).length}
            selected={group}
            onSelect={setGroup}
            onSave={async (id, name) => {
              const gid = await invoke('note.group.save', { id, name });
              await st.reloadNotes();
              return gid;
            }}
            onDelete={async (id) => {
              await invoke('note.group.delete', { id });
              await st.reloadNotes();
            }}
            onReorder={async (ids) => {
              await invoke('note.group.reorder', { ids });
              await st.reloadNotes();
            }}
            onShare={(id) => useShare.getState().open({ noteGroupIds: [id] })}
          />
        </CollapsibleSider>
        <div className="note-list-panel">
          <div className="note-list-search">
            <Input allowClear prefix={<SearchOutlined />} placeholder="搜索标题和正文" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div
            className="note-list"
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, note: null });
            }}
          >
            {list.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={st.notes.length ? '没有匹配的笔记' : '还没有笔记'} style={{ marginTop: 40 }} />}
            {list.map((n) => (
              <div
                key={n.id}
                className={`note-item ${n.id === st.selectedNoteId ? 'active' : ''} ${checked.length ? 'checking' : ''}`}
                onClick={() => st.selectNote(n.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({ x: e.clientX, y: e.clientY, note: n });
                }}
                data-testid={`note-item-${n.title}`}
              >
                <div className="note-item-title">
                  <Checkbox
                    className="note-item-check"
                    checked={checked.includes(n.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setChecked((c) => (e.target.checked ? [...c, n.id] : c.filter((x) => x !== n.id)))}
                    data-testid={`note-check-${n.title}`}
                  />
                  {n.pinned && <PushpinFilled style={{ color: 'var(--itm-primary)', fontSize: 11 }} />}
                  <span>{n.title}</span>
                </div>
                <div className="note-item-excerpt">{excerpt(n.content) || '（空）'}</div>
                <div className="note-item-time">{formatRelative(n.updatedAt)}</div>
              </div>
            ))}
          </div>
          {checked.length > 0 && (
            <div className="selection-bar note-selection-bar" data-testid="note-selection-bar" role="toolbar" aria-label="批量操作">
              <span className="selection-count">
                已选 <b>{checked.length}</b> 篇
              </span>
              <span className="selection-sep" />
              <button type="button" className="selection-act" onClick={() => useShare.getState().open({ noteIds: checked })} data-testid="note-batch-share">
                <ShareAltOutlined /> 分享
              </button>
              <button type="button" className="selection-act" onClick={() => setChecked(list.map((n) => n.id))}>
                全选
              </button>
              <Tooltip title="取消选择">
                <button type="button" className="selection-x" onClick={() => setChecked([])} aria-label="取消选择">
                  <CloseCircleOutlined />
                </button>
              </Tooltip>
            </div>
          )}
        </div>
        <Dropdown open={!!ctx} onOpenChange={(o) => !o && setCtx(null)} trigger={['contextMenu']} menu={ctx?.note ? noteMenu(ctx.note) : blankMenu}>
          <div className="ctx-anchor" style={{ left: ctx?.x ?? -10, top: ctx?.y ?? -10 }} />
        </Dropdown>
        <div className="note-main">
          {current ? <NoteEditor key={`${current.id}:${st.noteRev[current.id] ?? 0}`} note={current} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择或新建一篇笔记" style={{ marginTop: 120 }} />}
        </div>
      </div>
    </>
  );
}
