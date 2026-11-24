import { useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Empty, Input, Tooltip, Typography } from 'antd';
import { CheckSquareOutlined, DeleteOutlined, LoadingOutlined, MessageOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { App } from 'antd';
import { errorMessage, invoke } from '../../api';
import { useAgent } from '../../store/agent';
import { AgentPanel } from '../../components/agent/AgentPanel';
import { useApp } from '../../store/app';
import { NotesPage } from '../library/NotesPage';
import { AuditPage } from '../audit/AuditPage';
import { BatchPage } from '../batch/BatchPage';
import { SettingsPage } from '../settings/SettingsPage';
import { SnippetsPage } from '../library/SnippetsPage';
import { useShortcutLabel } from '../../util/shortcuts';
import { useAiAllowed } from '../../util/ai-access';
import { AiLocked } from '../../components/AiLocked';
import { CollapsibleSider } from '../../components/CollapsibleSider';
import { TopBarSlot } from '../../components/TopBar';

/** 会话按时间分组：今天 / 最近 7 天 / 更早 */
function groupOf(t: number): string {
  const d = dayjs(t);
  if (d.isSame(dayjs(), 'day')) return '今天';
  if (d.isAfter(dayjs().subtract(7, 'day'))) return '最近 7 天';
  return '更早';
}

/**
 * AI 对话模式（文档一 6.15.9）：左侧会话列表，中间整页对话。不需要打开终端：用 @ 引用主机，
 * Agent 通过独立的执行通道操作；和终端页右侧的 AI 面板共用同一批会话。
 */
export function AiPage(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const conversations = useAgent((s) => s.conversations);
  const current = useAgent((s) => s.current);
  const view = useApp((s) => s.aiView);
  const collapsed = useApp((s) => s.siderCollapsed);
  const setView = useApp((s) => s.setAiView);
  const [q, setQ] = useState('');
  /** 多选删除：选择模式和已选的对话 */
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggleKey = useShortcutLabel('toggleMode');
  const aiAllowed = useAiAllowed();

  useEffect(() => {
    void useAgent.getState().refreshList();
  }, []);

  const groups = useMemo(() => {
    const k = q.trim().toLowerCase();
    const list = conversations.filter((c) => !k || c.title.toLowerCase().includes(k));
    const out: { name: string; items: typeof list }[] = [];
    for (const c of list) {
      const g = groupOf(c.updatedAt);
      const last = out.at(-1);
      if (last?.name === g) last.items.push(c);
      else out.push({ name: g, items: [c] });
    }
    return out;
  }, [conversations, q]);

  const visibleIds = groups.flatMap((g) => g.items.map((c) => c.id));
  const pickedVisible = visibleIds.filter((id) => picked.has(id));
  const exitSelect = (): void => {
    setSelecting(false);
    setPicked(new Set());
  };
  const togglePick = (id: string): void =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  /** 删除对话（先二次确认）；正在执行的对话跳过；删掉的是当前对话时打开下一个 */
  const remove = (ids: string[]): void => {
    if (!ids.length) return;
    const one = ids.length === 1 ? conversations.find((c) => c.id === ids[0]) : null;
    modal.confirm({
      title: one ? `删除对话「${one.title || '新对话'}」？` : `删除选中的 ${ids.length} 个对话？`,
      content: '删除后不能恢复。正在执行的对话会跳过。',
      okText: '删除',
      okButtonProps: { danger: true, ['data-testid' as never]: 'ai-conv-del-ok' },
      cancelText: '取消',
      onOk: async () => {
        const failed: string[] = [];
        for (const id of ids) {
          try {
            await invoke('agent.delete', { id });
          } catch (err) {
            failed.push(errorMessage(err));
          }
        }
        const st = useAgent.getState();
        await st.refreshList();
        if (st.current && ids.includes(st.current.id) && !useAgent.getState().conversations.some((c) => c.id === st.current?.id)) {
          const next = useAgent.getState().conversations[0];
          if (next) await st.open(next.id);
          else await st.newConversation();
        }
        const done = ids.length - failed.length;
        if (failed.length) message.warning(`已删除 ${done} 个，${failed.length} 个没有删除：${failed[0]}`);
        else if (ids.length > 1) message.success(`已删除 ${done} 个对话`);
        exitSelect();
      },
    });
  };

  return (
    <div className="ai-page" data-testid="ai-page">
      <TopBarSlot active={view === 'chat'}>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title">
            <span className="topbar-page-name">AI 对话</span>
            {current?.title && <span className="topbar-page-sub keep">{current.title}</span>}
          </div>
          <div className="topbar-ctx-actions no-drag">
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              disabled={!aiAllowed}
              onClick={() => {
                setView('chat');
                void useAgent.getState().newConversation();
              }}
              data-testid="ai-page-new"
            >
              新对话
            </Button>
          </div>
        </div>
      </TopBarSlot>
      <CollapsibleSider collapsed={collapsed} width={242} className="ai-conv-collapsible">
        <aside className="ai-conv-list">
        {selecting ? (
          <div className="ai-conv-head selecting" data-testid="ai-conv-select-bar">
            <Checkbox
              checked={visibleIds.length > 0 && pickedVisible.length === visibleIds.length}
              indeterminate={pickedVisible.length > 0 && pickedVisible.length < visibleIds.length}
              onChange={(e) => setPicked(e.target.checked ? new Set(visibleIds) : new Set())}
              data-testid="ai-conv-select-all"
            >
              {pickedVisible.length ? `已选 ${pickedVisible.length}` : '全选'}
            </Checkbox>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              <Button size="small" danger icon={<DeleteOutlined />} disabled={!pickedVisible.length} onClick={() => remove(pickedVisible)} data-testid="ai-conv-del-selected">
                删除
              </Button>
              <Button size="small" onClick={exitSelect} data-testid="ai-conv-select-cancel">
                取消
              </Button>
            </span>
          </div>
        ) : (
          <div className="ai-conv-head">
            <Typography.Text strong className="ai-conv-head-title">
              最近对话
              {conversations.length > 0 && <span className="ai-conv-count">{conversations.length}</span>}
            </Typography.Text>
            <Tooltip title="多选删除">
              <Button size="small" type="text" icon={<CheckSquareOutlined />} disabled={!conversations.length} onClick={() => setSelecting(true)} data-testid="ai-conv-select" aria-label="多选" />
            </Tooltip>
          </div>
        )}
        <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索对话" value={q} onChange={(e) => setQ(e.target.value)} className="ai-conv-search" data-testid="ai-conv-search" />
        <div className={`ai-conv-scroll ${aiAllowed ? '' : 'ai-greyed'}`}>
          {groups.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? '没有匹配的对话' : '还没有对话'} style={{ marginTop: 40 }} />}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="ai-conv-group">{g.name}</div>
              {g.items.map((c) => (
                <div
                  key={c.id}
                  className={`ai-conv-item ${!selecting && view === 'chat' && current?.id === c.id ? 'active' : ''} ${selecting && picked.has(c.id) ? 'picked' : ''}`}
                  onClick={() => {
                    if (selecting) return togglePick(c.id);
                    setView('chat');
                    void useAgent.getState().open(c.id);
                  }}
                  data-testid="ai-conv-item"
                >
                  {selecting ? (
                    <Checkbox checked={picked.has(c.id)} className="ai-conv-check" onClick={(e) => e.stopPropagation()} onChange={() => togglePick(c.id)} data-testid="ai-conv-check" />
                  ) : c.running ? (
                    <Tooltip title="正在执行">
                      <LoadingOutlined spin className="ai-conv-icon running" data-testid="ai-conv-running" />
                    </Tooltip>
                  ) : (
                    <MessageOutlined className="ai-conv-icon" />
                  )}
                  <span className="ai-conv-title">{c.title || '新对话'}</span>
                  {/* 时间和删除按钮叠在同一个固定宽度的位置：悬停时只换显示，不改变布局（以前悬停会抖动） */}
                  <span className="ai-conv-tail">
                    <span className="ai-conv-time">{dayjs(c.updatedAt).format(groupOf(c.updatedAt) === '今天' ? 'HH:mm' : 'MM-DD')}</span>
                    {!selecting && (
                      <Button
                        size="small"
                        type="text"
                        danger
                        icon={<DeleteOutlined />}
                        className="ai-conv-del"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          remove([c.id]);
                        }}
                        data-testid="ai-conv-del"
                        aria-label="删除对话"
                      />
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        {toggleKey && <div className="ai-conv-foot">{toggleKey} 在终端和 AI 对话之间切换</div>}
        </aside>
      </CollapsibleSider>
      {/* 对话区始终挂载（切到笔记等页面时只隐藏），输入到一半的内容和终端发来的提问都不会丢 */}
      <section className={`ai-chat ${view === 'chat' ? '' : 'hidden'}`}>
        {/* 离线使用（Guest）不能用 AI 对话：显示登录提示（第十二轮） */}
        {aiAllowed ? <AgentPanel variant="page" /> : <AiLocked title="登录后使用 AI 对话" />}
      </section>
      {view !== 'chat' && (
        <section className="ai-subpage" data-testid={`ai-subpage-${view}`}>
          {view === 'notes' && <NotesPage />}
          {view === 'audit' && <AuditPage />}
          {view === 'batch' && <BatchPage />}
          {view === 'settings' && <SettingsPage />}
          {view === 'snippets' && <SnippetsPage />}
        </section>
      )}
    </div>
  );
}
