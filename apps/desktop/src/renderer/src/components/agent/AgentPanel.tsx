import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Collapse, Dropdown, Empty, Input, InputNumber, Popover, Switch, Tag, Tooltip, Typography } from 'antd';
import {
  ApiOutlined,
  BookOutlined,
  FileTextOutlined,
  FolderOutlined,
  PaperClipOutlined,
  ReadOutlined,
  CloseOutlined,
  GlobalOutlined,
  CloudServerOutlined,
  CodeOutlined,
  CopyOutlined,
  DownOutlined,
  EllipsisOutlined,
  HistoryOutlined,
  PlusOutlined,
  SendOutlined,
  ConsoleSqlOutlined,
  DatabaseOutlined,
  StopOutlined,
  ThunderboltOutlined,
  FieldTimeOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  VerticalAlignTopOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import {
  AGENT_IMAGE_TYPES,
  DEFAULT_CHAT_POLICY,
  DEFAULT_SETTINGS,
  MAX_AGENT_IMAGES,
  TERMINAL_CONTEXT_LINES,
  type AgentViewMessage,
  type McpServerConfig,
  type ModelRef,
} from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useAgentStore, buildRefs, effectiveThinking, effectiveWeb, MAX_QUEUE, modelConfig, terminalTabs, type QueuedMessage } from '../../store/agent';

const NO_QUEUE: QueuedMessage[] = [];
const CTX_KEY = 'itm.ai.contextPanel';
/**
 * 已经处理过的外部提问 / 引用的序号。面板在切换终端 / AI 对话模式时会重新挂载，
 * 挂载时 effect 会再跑一次——不记下来就会把上一条提问重新发送一遍。
 */
const handledByStore = new WeakMap<object, { pending: number; quoted: number }>();
function handledFor(store: object): { pending: number; quoted: number } {
  let h = handledByStore.get(store);
  if (!h) handledByStore.set(store, (h = { pending: 0, quoted: 0 }));
  return h;
}
import { useApp } from '../../store/app';
import { useHosts } from '../../store/hosts';
import { useTabs } from '../../store/tabs';
import { useWorkspaceUi } from '../../store/workspace';
import { useLibrary } from '../../store/library';
import { DB_TYPE_LABEL, dbWhere, useDatabases } from '../../store/databases';
import { kbName, useKb } from '../../store/kb';
import { ContextRing } from './ContextRing';
import { ModelPicker } from './ModelPicker';
import { ConversationRail } from './ConversationRail';
import { WebToggle } from './WebToggle';
import { MentionPopup, type PopupItem } from './MentionPopup';
import { MAX_IMAGE_INPUT_BYTES, prepareImage } from '../../util/image-resize';
import { SkillRunCard } from './SkillRunCard';
import { useSkillRun } from './SkillRunDialog';
import { openHost } from '../../actions';
import { StepCard } from './StepCard';
import { AnswerMarkdown } from './AnswerMarkdown';
import { RefsPicker } from './RefsPicker';
import { HOST_CHIP_MAX, HostRefsChip } from './HostRefsChip';
import { ConversationActions } from './ConversationActions';
import { CopyButton, Markdown } from '../Markdown';
import { ContextPanel } from './ContextPanel';
import { ChatPolicyPicker } from './ChatPolicyPicker';

/** 第 i 条消息之前最近的一条用户提问 */
function lastQuestion(messages: AgentViewMessage[], i: number): string {
  for (let k = i - 1; k >= 0; k--) {
    const m = messages[k];
    if (m.role === 'user') return m.text;
  }
  return '';
}

const modelKey = (m: ModelRef | null): string => (m ? `${m.providerId}\u0000${m.modelId}` : '');

/** AI 回答卡片右下角的操作（只显示图标，悬停显示说明）：复制、存为笔记 */
function AnswerActions({ text, question }: { text: string; question: string }): React.JSX.Element {
  const { message } = App.useApp();
  return (
    <div className="answer-actions">
      <Tooltip title="复制回答">
        <Button
          size="small"
          type="text"
          icon={<CopyOutlined />}
          aria-label="复制回答"
          data-testid="answer-copy"
          onClick={() => void navigator.clipboard.writeText(text).then(() => message.success('已复制'))}
        />
      </Tooltip>
      <Tooltip title="这条回答存为笔记">
        <Button
          size="small"
          type="text"
          icon={<BookOutlined />}
          aria-label="这条回答存为笔记"
          data-testid="answer-save-note"
          onClick={async () => {
            try {
              const note = await useLibrary.getState().saveAsNote(question.split('\n')[0].trim() || 'AI 回答', `> ${question.replace(/\n/g, '\n> ')}\n\n${text}`);
              message.success({
                key: 'note-saved',
                content: (
                  <span>
                    已存为笔记「{note.title}」
                    <Button type="link" size="small" onClick={() => useLibrary.getState().openNote(note.id)}>
                      查看
                    </Button>
                  </span>
                ),
              });
            } catch (e) {
              message.error(errorMessage(e));
            }
          }}
        />
      </Tooltip>
    </div>
  );
}

/** 回答上方的模型标签：服务商 / 模型名（第二十六轮，参考 NewMax） */
function modelLabel(id: string, providers: { name: string; models: { id: string; displayName?: string | null }[] }[]): string {
  if (!id || id === 'external') return '';
  for (const p of providers) {
    const m = p.models.find((x) => x.id === id);
    if (m) return `${p.name} / ${m.displayName || m.id}`;
  }
  return id;
}

function MessageView({
  m,
  conversationId,
  question,
  first,
  settled,
}: {
  m: AgentViewMessage;
  conversationId: string;
  question: string;
  first?: boolean;
  /** 这条消息所在的一轮对话已经结束：执行结果默认收起（第三十一轮） */
  settled?: boolean;
}): React.JSX.Element {
  const providers = useAgentStore()((s) => s.providers);
  if (m.role === 'notice') {
    return <Alert className="agent-notice" type="info" showIcon message={m.text} data-testid="agent-notice" />;
  }
  if (m.role === 'summary') {
    return (
      <div className="agent-summary" data-testid="agent-summary">
        <div className="agent-divider">以上对话已压缩成摘要</div>
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 's',
              label: '查看摘要',
              children: <Markdown text={m.text} />,
            },
          ]}
        />
      </div>
    );
  }
  if (m.role === 'user') {
    return (
      <div className={`agent-msg user ${m.compacted ? 'compacted' : ''}`} data-testid="agent-user-msg" data-msg-id={m.id}>
        <div className="bubble selectable">{m.text}</div>
        <div className="agent-msg-meta">
          <CopyButton text={() => m.text} title="复制消息" testId="user-msg-copy" className="user-msg-copy" />
          {m.mode === 'ask' && <Tag bordered={false}>Ask</Tag>}
          {m.refLabels.length > 0 && <Typography.Text type="secondary">{`引用 ${m.refLabels.join('、')}`}</Typography.Text>}
        </div>
      </div>
    );
  }
  return (
    <div className={`agent-msg assistant ${m.compacted ? 'compacted' : ''} ${first ? 'first' : ''}`} data-testid="agent-assistant-msg">
      {first && modelLabel(m.model, providers) && (
        <div className="agent-msg-model" data-testid="agent-msg-model">
          <ThunderboltOutlined />
          {modelLabel(m.model, providers)}
        </div>
      )}
      {m.thinking && (
        <Collapse
          ghost
          size="small"
          className="agent-thinking"
          items={[
            {
              key: 't',
              label: '思考过程',
              children: <div className="thinking selectable">{m.thinking}</div>,
            },
          ]}
        />
      )}
      {m.skillRun ? (
        <SkillRunCard run={m.skillRun} />
      ) : (
        m.text && (
          <div className="answer-card">
            {/* 回答里的命令可以复制、可以直接在终端运行（第十五轮，参考 iShell 运维模式） */}
            <AnswerMarkdown text={m.text} />
            {!m.compacted && <AnswerActions text={m.text} question={question} />}
          </div>
        )
      )}
      {m.steps.map((s) => (
        <StepCard key={s.id} step={s} conversationId={conversationId} settled={settled} />
      ))}
      {m.notice && <Alert type="warning" showIcon message={m.notice} style={{ marginTop: 6 }} />}
    </div>
  );
}

/**
 * Agent 面板（右侧「AI」）：默认引用所有已连接的终端；对话里每条命令都标明执行的主机。
 */
/** 图片识别 Fallback 打开并选了识图模型（第二十五轮）：看不了图片的模型也能发图片 */
function visionFallbackOn(): boolean {
  const fb = useApp.getState().settings['ai.visionFallback'];
  return !!fb?.enabled && !!fb.model;
}

export function AgentPanel({
  variant = 'side',
  handleExternal = true,
  focusSeq: focusOverride,
}: {
  /** side：终端页右侧的 AI 面板；page：整页 AI 对话（文档一 6.15.9） */
  variant?: 'side' | 'page';
  /** 处理终端里发来的提问和引用（两个面板同时挂载时只由一个处理） */
  handleExternal?: boolean;
  /** 变化时聚焦输入框（SQL 工作台的「AI 写 SQL」用，第二十九轮）；不传时跟随终端页的 AI 按钮 */
  focusSeq?: number;
} = {}): React.JSX.Element {
  const { message } = App.useApp();
  const useA = useAgentStore();
  const st = useA();
  /** SQL 工作台的对话（第二十九轮）：不引用终端，SQL 代码块可以直接执行 */
  const db = st.scope === 'db';
  const handledExternal = handledFor(useA);
  const tabs = useTabs((s) => s.tabs);
  const hosts = useHosts((s) => s.hosts);
  const settings = useApp((s) => s.settings);
  const [text, setText] = useState('');
  const [compressing, setCompressing] = useState(false);
  // AI 对话模式右侧的上下文面板：记住展开 / 收起
  const [ctxOpen, setCtxOpen] = useState(() => localStorage.getItem(CTX_KEY) !== '0');
  const toggleCtx = (): void =>
    setCtxOpen((v) => {
      localStorage.setItem(CTX_KEY, v ? '0' : '1');
      return !v;
    });
  // 输入框里的 @ 引用和 / 命令（文档一 6.15.8）
  const [popup, setPopup] = useState<{
    kind: 'mention' | 'slash';
    start: number;
    query: string;
  } | null>(null);
  const [popupIdx, setPopupIdx] = useState(0);
  const [mentionCat, setMentionCat] = useState('全部');
  const [dragOver, setDragOver] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const anyFileRef = useRef<HTMLInputElement>(null);
  /** 整页模式输入框左下角的 + */
  const [plusOpen, setPlusOpen] = useState(false);
  /** 终端页 AI 面板引用行最右边的 ···：查看全部引用、添加引用 */
  const [moreOpen, setMoreOpen] = useState(false);
  const refsBarCleanup = useRef<(() => void) | null>(null);
  /**
   * 引用行（第十二轮）：一行显示全部引用，放不下时左右滑动——滚轮 / 触控板的上下滚动换成左右，按住鼠标拖动也可以；
   * 不显示滚动条。拖动超过 4px 才算拖动，不影响点标签上的 ×。
   */
  const refsBarRef = useCallback((el: HTMLDivElement | null) => {
    refsBarCleanup.current?.();
    refsBarCleanup.current = null;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (el.scrollWidth <= el.clientWidth) return;
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft += d;
    };
    let drag: { x: number; left: number; moved: boolean } | null = null;
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0 || el.scrollWidth <= el.clientWidth) return;
      drag = { x: e.clientX, left: el.scrollLeft, moved: false };
    };
    const onMove = (e: MouseEvent): void => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 4) return;
      drag.moved = true;
      el.classList.add('dragging');
      el.scrollLeft = drag.left - dx;
    };
    const onUp = (): void => {
      if (drag?.moved) {
        // 拖动结束后的那次 click 不触发标签上的按钮
        const stop = (ev: MouseEvent): void => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        el.addEventListener('click', stop, { capture: true, once: true });
        setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 0);
      }
      drag = null;
      el.classList.remove('dragging');
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    refsBarCleanup.current = () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);
  /** 选中 @ / / 项目后要恢复的光标位置：在 React 提交新文字后立即设置，避免和后续输入抢顺序 */
  const pendingCaret = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<TextAreaRef>(null);

  // 终端右键「引用到 AI 对话框」：把内容作为代码块加到输入框末尾，光标放到最后，由用户补充问题
  const quotedSeq = useA((s) => s.quoted?.seq);
  useEffect(() => {
    const q = useA.getState().quoted;
    if (!q || !handleExternal || q.seq <= handledExternal.quoted) return;
    handledExternal.quoted = q.seq;
    setText((t) => `${t.trimEnd()}${t.trim() ? '\n' : ''}\`\`\`\n${q.text}\n\`\`\`\n`);
  }, [quotedSeq]);
  // AI 按钮、引用：聚焦输入框
  const wsFocusSeq = useWorkspaceUi((s) => s.aiFocusSeq);
  const focusSeq = focusOverride ?? wsFocusSeq;
  useEffect(() => {
    if (!focusSeq) return;
    // 等输入框按新内容自动调整完高度再聚焦
    const t = setTimeout(() => {
      const el = inputRef.current?.resizableTextArea?.textArea;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      // 内容没超过最大高度时（antd 会设 overflow-y: hidden）不需要滚动，避免第一行被卷上去
      if (getComputedStyle(el).overflowY === 'hidden') el.scrollTop = 0;
    }, 60);
    return () => clearTimeout(t);
  }, [focusSeq, quotedSeq]);

  useEffect(() => {
    void st.loadProviders();
    void st.loadSkills();
    void st.refreshList().then(async () => {
      const list = useA.getState().conversations;
      if (!useA.getState().current) {
        // SQL 工作台的对话从新对话开始（不接着终端页最近的对话）
        if (list[0] && !db) await useA.getState().open(list[0].id);
        else await useA.getState().newConversation();
      }
    });
  }, []);

  const folders = useHosts((s) => s.folders);
  // + 里的「引用终端最近 N 行」（默认开启、200 行）
  const termCtx = settings['ai.terminalContext'] ?? DEFAULT_SETTINGS['ai.terminalContext'];
  const termLines = termCtx.enabled ? termCtx.lines : 0;
  const refs = useMemo(
    () => buildRefs(db ? [] : tabs, hosts, st, db ? 0 : termLines),
    // st.images 也要在依赖里：只加了图片就发送时，图片不能丢（第二十四轮修复）
    [tabs, hosts, st.excludedTabs, st.extraHostIds, st.skillIds, st.folderIds, st.noteIds, st.mcpServerIds, st.databaseIds, st.kbCollections, st.files, st.attachments, st.images, termLines, st.sqlContext],
  );
  const setTermCtx = (patch: Partial<typeof termCtx>): void => void useApp.getState().updateSetting('ai.terminalContext', { ...termCtx, ...patch }).catch((e) => message.error(errorMessage(e)));
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  useEffect(() => {
    if (plusOpen || moreOpen || st.mcpServerIds.length || popup?.kind === 'mention')
      void invoke('mcp.list')
        .then((r) => setMcpServers(r.servers.filter((s) => s.enabled)))
        .catch(() => undefined);
  }, [plusOpen, moreOpen, st.mcpServerIds.length, popup?.kind]);
  const notes = useLibrary((s) => s.notes);
  // 数据库资产（第十七轮）：@ 引用、引用标签
  const databases = useDatabases((s) => s.list);
  const kbList = useKb((s) => s.list);
  useEffect(() => {
    if (plusOpen || moreOpen || st.databaseIds.length || popup?.kind === 'mention') void useDatabases.getState().load().catch(() => undefined);
    if (popup?.kind === 'mention') void useKb.getState().load().catch(() => undefined);
  }, [plusOpen, moreOpen, st.databaseIds.length, popup?.kind]);
  const termTabsAll = terminalTabs(tabs);
  const conv = st.current;
  // 排队的消息（hook 要放在所有提前 return 之前）
  const queued = useA((s) => (conv ? s.queue[conv.id] : undefined)) ?? NO_QUEUE;

  // 引用、模型或对话变化时刷新上下文占用
  useEffect(() => {
    if (!conv) return;
    const t = setTimeout(() => {
      invoke('agent.usage', { id: conv.id, model: st.model, refs })
        .then(st.setUsage)
        .catch(() => st.setUsage(null));
    }, 300);
    return () => clearTimeout(t);
  }, [conv?.id, conv?.messages.length, conv?.running, modelKey(st.model), JSON.stringify(refs)]);

  /**
   * 是否停在底部（第二十六轮）：往上翻看历史时不再被新内容拉回底部，输入框上方出现「回到底部」按钮；
   * 停在底部时新内容自动跟随
   */
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const onListScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    const v = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    atBottomRef.current = v;
    if (v !== atBottom) setAtBottom(v);
  };
  const scrollToBottom = (smooth = false): void => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottomRef.current = true;
    setAtBottom(true);
  };
  // 新内容时滚动到底部（只在停在底部时）
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [conv?.messages.length, conv?.streamingText, conv?.streamingThinking, conv?.messages.at(-1)]);
  // 换对话：回到底部
  useEffect(() => scrollToBottom(), [conv?.id]);

  const send = async (override?: { text: string; mode: 'agent' | 'ask' }): Promise<void> => {
    const q = (override?.text ?? text).trim();
    const current = useA.getState().current;
    if (!q || !current || !st.model) return;
    try {
      const eff = effectiveThinking(useA.getState().thinking[current.id], modelConfig(st.providers, st.model));
      await invoke('agent.send', {
        id: current.id,
        text: q,
        mode: override?.mode ?? st.mode,
        model: st.model,
        refs,
        thinking: { enabled: eff.enabled, effort: eff.effort ?? null },
        policy: useA.getState().chatPolicy[current.id],
        web: effectiveWeb(current.id, useA).on,
      });
      if (!override) setText('');
      // 自己发出的消息：回到底部看回答
      atBottomRef.current = true;
      // 文件和附件只在这一次发送时带上
      st.clearOneShot();
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  /** 回答还没结束：放进排队（最多 5 条），上一条结束后自动按顺序发送 */
  const enqueue = (override?: { text: string; mode: 'agent' | 'ask' }): void => {
    const q = (override?.text ?? text).trim();
    const current = useA.getState().current;
    if (!q || !current || !st.model) return;
    // 刚好在这时已经结束：直接发送
    if (!current.running) return void send(override);
    const eff = effectiveThinking(useA.getState().thinking[current.id], modelConfig(st.providers, st.model));
    const ok = st.enqueue(current.id, {
      text: q,
      mode: override?.mode ?? st.mode,
      model: st.model,
      refs,
      thinking: { enabled: eff.enabled, effort: eff.effort ?? null },
      policy: useA.getState().chatPolicy[current.id],
      web: effectiveWeb(current.id, useA).on,
    });
    if (!ok) {
      message.warning(`排队最多 ${MAX_QUEUE} 条，等前面的发送后再加`);
      return;
    }
    if (!override) setText('');
    st.clearOneShot();
  };

  // 终端里的 # 问 AI、「让 AI 解释」、文件面板的「让 AI 分析」：直接发送
  const pendingSeq = st.pending?.seq;
  useEffect(() => {
    const p = useA.getState().pending;
    if (!p || !handleExternal || p.seq <= handledExternal.pending) return;
    handledExternal.pending = p.seq;
    if (!st.model) {
      message.warning('请先在「设置 → AI 模型」里配置模型');
      return;
    }
    if (useA.getState().current?.running) {
      enqueue({ text: p.text, mode: p.mode });
      message.info('上一条消息还在执行，问题已排队，结束后自动发送');
      return;
    }
    void (async () => {
      if (!useA.getState().current) await st.newConversation();
      await send({ text: p.text, mode: p.mode });
    })();
  }, [pendingSeq]);

  const compress = async (): Promise<void> => {
    if (!conv || !st.model) return;
    setCompressing(true);
    try {
      await invoke('agent.compress', { id: conv.id, model: st.model });
      message.success('已压缩');
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setCompressing(false);
    }
  };

  // ---------------------------------------------------------------- @ 引用 / / 命令

  const snippets = useLibrary((s) => s.snippets);
  const MENTION_CATS = ['全部', '主机', '数据库', '知识库', '分组', 'Skill', '笔记', 'MCP'];
  const popupItems = useMemo<PopupItem[]>(() => {
    if (!popup) return [];
    const q = popup.query.toLowerCase();
    const match = (...xs: (string | undefined)[]): boolean => !q || xs.some((x) => x?.toLowerCase().includes(q));
    const out: PopupItem[] = [];
    if (popup.kind === 'slash') {
      const cmds: [string, string, () => void][] = [
        ['new', '新对话', () => void st.newConversation()],
        ['compact', '压缩上下文', () => void compress()],
        ['agent', '切换到 Agent 模式', () => st.setMode('agent')],
        ['ask', '切换到 Ask 模式（只回答不执行）', () => st.setMode('ask')],
      ];
      for (const [k, label, run] of cmds)
        if (match(k, label))
          out.push({
            key: `cmd:${k}`,
            group: '命令',
            label: `/${k}`,
            sub: label,
            icon: <CodeOutlined />,
            run,
          });
      for (const sk of st.skills)
        if (match(sk.name, sk.title, sk.description))
          out.push({
            key: `skill:${sk.id}`,
            group: '运行 Skill',
            label: sk.title,
            sub: sk.description,
            icon: <ThunderboltOutlined />,
            run: () => useSkillRun.getState().show({ skillId: sk.id }),
          });
      for (const sn of snippets)
        if (match(sn.name, sn.content))
          out.push({
            key: `snippet:${sn.id}`,
            group: '插入快捷命令',
            label: sn.name,
            sub: sn.content.split('\n')[0],
            icon: <ConsoleSqlOutlined />,
            run: () => setText((t) => `${t.trimEnd()}${t.trim() ? '\n' : ''}\`\`\`\n${sn.content}\n\`\`\`\n`),
          });
      return out.slice(0, 60);
    }
    const cat = mentionCat;
    if (cat === '全部' || cat === '主机') {
      for (const t of termTabsAll)
        if (match(t.title))
          out.push({
            key: `tab:${t.id}`,
            group: '终端',
            label: t.title,
            sub: t.status === 'ready' ? '已连接' : '未连接',
            icon: t.kind === 'local' ? <CodeOutlined /> : <CloudServerOutlined />,
            selected: t.status === 'ready' && !st.excludedTabs.includes(t.id),
            run: () => (t.status === 'ready' ? st.toggleTab(t.id, true) : t.hostId && st.toggleHost(t.hostId, true)),
          });
      for (const h of hosts)
        if (match(h.name, h.address, ...h.tags))
          out.push({
            key: `host:${h.id}`,
            group: '主机',
            label: h.name,
            sub: h.address,
            icon: <CloudServerOutlined />,
            selected: refs.terminals.some((t) => t.hostId === h.id),
            run: () => {
              const tab = termTabsAll.find((t) => t.hostId === h.id && t.status === 'ready');
              if (tab) st.toggleTab(tab.id, true);
              else st.toggleHost(h.id, true);
            },
          });
    }
    if (cat === '全部' || cat === '数据库')
      for (const d of databases)
        if (match(d.name, d.host, d.database, d.note ?? ''))
          out.push({
            key: `db:${d.id}`,
            group: '数据库',
            label: d.name,
            sub: `${DB_TYPE_LABEL[d.type]} ${dbWhere(d)}`,
            icon: <DatabaseOutlined />,
            selected: st.databaseIds.includes(d.id),
            run: () => st.toggleDatabase(d.id, true),
          });
    // 知识库（第二十六轮）：和 + 里的引用一样，登录后才有
    if ((cat === '全部' || cat === '知识库') && kbList.length) {
      if (match('全部知识库', '知识库 kb'))
        out.push({
          key: 'kb:*',
          group: '知识库',
          label: '全部知识库',
          sub: '发送时按问题检索你能看到的所有知识库',
          icon: <ReadOutlined />,
          selected: st.kbCollections.includes('*'),
          run: () => st.toggleKb('*', true),
        });
      for (const k of kbList)
        if (match(k.name, k.description ?? ''))
          out.push({
            key: `kb:${k.id}`,
            group: '知识库',
            label: k.name,
            sub: k.description ?? '发送时按问题检索这个知识库',
            icon: <ReadOutlined />,
            selected: st.kbCollections.includes(k.id),
            run: () => st.toggleKb(k.id, true),
          });
    }
    if (cat === '全部' || cat === '分组')
      for (const f of folders)
        if (match(f.name))
          out.push({
            key: `folder:${f.id}`,
            group: '分组',
            label: f.name,
            sub: '包含子分组里的主机',
            icon: <FolderOutlined />,
            selected: st.folderIds.includes(f.id),
            run: () => st.toggleFolder(f.id, true),
          });
    if (cat === '全部' || cat === 'Skill')
      for (const sk of st.skills)
        if (match(sk.name, sk.title))
          out.push({
            key: `skill:${sk.id}`,
            group: 'Skill',
            label: sk.title,
            sub: sk.description,
            icon: <ThunderboltOutlined />,
            selected: st.skillIds.includes(sk.id),
            run: () => st.toggleSkill(sk.id, true),
          });
    if (cat === '全部' || cat === '笔记')
      for (const n of notes)
        if (match(n.title))
          out.push({
            key: `note:${n.id}`,
            group: '笔记',
            label: n.title,
            icon: <BookOutlined />,
            selected: st.noteIds.includes(n.id),
            run: () => st.toggleNote(n.id, true),
          });
    if (cat === '全部' || cat === 'MCP')
      for (const m of mcpServers)
        if (match(m.name))
          out.push({
            key: `mcp:${m.id}`,
            group: 'MCP',
            label: m.name,
            icon: <ApiOutlined />,
            selected: st.mcpServerIds.includes(m.id),
            run: () => st.toggleMcp(m.id, true),
          });
    return out.slice(0, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup, mentionCat, hosts, folders, notes, mcpServers, databases, kbList, st.skills, snippets, tabs, st.excludedTabs, st.extraHostIds, st.folderIds, st.skillIds, st.noteIds, st.mcpServerIds, st.databaseIds, st.kbCollections]);

  /** 根据光标前的文字判断是否打开 @ / / 弹窗 */
  const detectPopup = (value: string, caret: number): void => {
    const before = value.slice(0, caret);
    const at = /(^|\s)@([^\s@]{0,30})$/.exec(before);
    if (at) {
      setPopup((p) => ({
        kind: 'mention',
        start: caret - at[2].length - 1,
        query: at[2],
      }));
      setPopupIdx(0);
      return;
    }
    const slash = /^\/(\S{0,30})$/.exec(before);
    if (slash) {
      setPopup({ kind: 'slash', start: 0, query: slash[1] });
      setPopupIdx(0);
      return;
    }
    setPopup(null);
  };

  const pickPopup = (item: PopupItem): void => {
    if (!popup) return;
    const el = inputRef.current?.resizableTextArea?.textArea;
    const caret = el?.selectionStart ?? text.length;
    // @ 引用（第十二轮）：选中后在输入框里留下「@名称 」，同时加到引用里；/ 命令不留文字
    const insert = popup.kind === 'mention' ? `@${item.label.replace(/\s+/g, '')} ` : '';
    const next = text.slice(0, popup.start) + insert + text.slice(caret);
    pendingCaret.current = popup.start + insert.length;
    setText(next);
    setPopup(null);
    item.run();
  };

  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    if (pos === null) return;
    pendingCaret.current = null;
    const el = inputRef.current?.resizableTextArea?.textArea;
    if (!el) return;
    el.focus();
    el.setSelectionRange(pos, pos);
  }, [text, popup]);

  // ---------------------------------------------------------------- 图片和文件

  const currentModel = modelConfig(st.providers, st.model);
  const addImageFiles = async (files: File[]): Promise<void> => {
    const imgs = files.filter((f) => AGENT_IMAGE_TYPES.includes(f.type));
    if (!imgs.length) return;
    const room = MAX_AGENT_IMAGES - useA.getState().images.length;
    if (room <= 0) {
      message.warning(`每条消息最多 ${MAX_AGENT_IMAGES} 张图片`);
      return;
    }
    // 大图先缩小再发送（长边 2048）：选择或粘贴的图片最大 20MB，缩小后每张不超过 5MB
    const ok = imgs.filter((f) => {
      if (f.size > MAX_IMAGE_INPUT_BYTES) message.warning(`「${f.name}」超过 20MB`);
      return f.size <= MAX_IMAGE_INPUT_BYTES;
    });
    const done = await Promise.allSettled(ok.slice(0, room).map(prepareImage));
    st.addImages(done.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
    for (const r of done) if (r.status === 'rejected') message.warning(errorMessage(r.reason));
    if (currentModel && !currentModel.supportsImages && !visionFallbackOn()) message.warning('当前模型不支持图片：发送前请换一个支持图片的模型，或者在「设置 → AI 模型 → 图片识别 Fallback」里选一个识图模型');
  };
  const addFilePaths = (paths: string[]): void => {
    for (const p of paths) st.addAttachment({ name: p.split(/[\\/]/).pop() ?? p, path: p });
  };

  if (st.providers.length === 0) {
    return (
      <div className="side-empty">
        <Empty description="还没有配置 AI 模型">
          <Button type="primary" onClick={() => useApp.getState().openSettings('models')} data-testid="goto-ai-settings">
            去设置 AI 模型
          </Button>
        </Empty>
      </div>
    );
  }

  const selectedSkills = st.skills.filter((s) => st.skillIds.includes(s.id));
  const running = !!conv?.running;
  /** 正在进行的这一轮从最后一条用户消息开始：之前的几轮已经结束 */
  const lastUserIndex = conv ? conv.messages.findLastIndex((m) => m.role === 'user') : -1;

  const headEl = (
    <div className="agent-head">
      {variant === 'page' ? (
        <Typography.Text strong className="agent-page-title" ellipsis>
          {conv?.title ?? '新对话'}
        </Typography.Text>
      ) : (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [{ key: '__new', label: '新对话', icon: <PlusOutlined /> }, { type: 'divider' }, ...st.conversations.slice(0, 30).map((c) => ({ key: c.id, label: c.title }))],
            onClick: ({ key }) => void (key === '__new' ? st.newConversation() : st.open(key)),
          }}
        >
          <Button size="small" type="text" icon={<HistoryOutlined />} className="agent-title">
            <span className="agent-title-text">{conv?.title ?? '新对话'}</span>
            <DownOutlined style={{ fontSize: 10 }} />
          </Button>
        </Dropdown>
      )}
      <span className="agent-head-tools">
        {variant === 'page' && (
          <Tooltip title={ctxOpen ? '收起上下文面板' : '展开上下文面板'}>
            <Button size="small" type="text" icon={ctxOpen ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => toggleCtx()} data-testid="agent-ctx-toggle" aria-label="上下文面板" />
          </Tooltip>
        )}
        {conv && <ConversationActions id={conv.id} title={conv.title || '新对话'} model={conv.model} empty={!conv.messages.length || !!running} />}
        <Tooltip title="新对话">
          <Button size="small" type="text" icon={<PlusOutlined />} onClick={() => void st.newConversation()} data-testid="agent-new" aria-label="新对话" />
        </Tooltip>
      </span>
    </div>
  );
  const isEmpty = !!conv && conv.messages.length === 0 && !running;
  const listEl = (
    <div className="agent-list-wrap">
    {conv && <ConversationRail messages={conv.messages} listRef={listRef} />}
    {!atBottom && !isEmpty && (
      <button type="button" className={`agent-to-bottom ${running ? 'running' : ''}`} onClick={() => scrollToBottom(true)} data-testid="agent-to-bottom" aria-label="回到底部">
        <ArrowDownOutlined />
      </button>
    )}
    <div className={`agent-list ${isEmpty ? 'empty' : ''}`} ref={listRef} onScroll={onListScroll}>
      {/* 新对话（AI 对话模式和终端页右侧面板）：图标和标题在中间，不显示说明 */}
      {isEmpty && (
        <div className="agent-hello page-hello" data-testid="agent-hello">
          <span className="page-hello-icon">
            <ThunderboltOutlined />
          </span>
          <div className="page-hello-title">{db ? 'SQL 助手' : 'iTerminal 运维助手'}</div>
          {db && <div className="page-hello-sub">用自然语言描述要查什么，AI 根据表结构写 SQL；点 SQL 上的「执行」在左边看结果</div>}
        </div>
      )}
      {conv?.messages.map((m, i) => (
        <MessageView
          key={m.id}
          m={m}
          conversationId={conv.id}
          question={lastQuestion(conv.messages, i)}
          first={m.role === 'assistant' && conv.messages[i - 1]?.role === 'user'}
          settled={!running || i < lastUserIndex}
        />
      ))}
      {running && (conv?.streamingThinking || conv?.streamingText) && (
        <div className="agent-msg assistant streaming">
          {conv.streamingThinking && !conv.streamingText && <div className="thinking">{conv.streamingThinking}</div>}
          {conv.streamingText && <Markdown text={conv.streamingText} />}
        </div>
      )}
      {conv?.error && <Alert type="error" showIcon message={conv.error} style={{ margin: 8 }} data-testid="agent-error" />}
    </div>
    </div>
  );
  const refCount = refs.terminals.length + st.folderIds.length + st.noteIds.length + st.mcpServerIds.length + st.databaseIds.length + st.kbCollections.length + st.files.length + st.attachments.length + selectedSkills.length;
  /** 引用标签：引用行和 ··· 里的「已引用」共用 */
  // 联网（第二十四轮）：右侧窄面板的底栏放不下开关，放在 + 菜单里，打开时引用行显示一个「联网」标签
  const web = effectiveWeb(conv?.id, useA);
  const refChips = (): React.ReactNode[] => [
    ...(variant === 'side' && web.on
      ? [
          <span key="web" className="ref-chip web" title={`联网已打开：AI 可以搜索和读取公开网页（用「${web.label}」搜索）`} data-testid="ref-chip-web">
            <GlobalOutlined />
            <span className="ref-chip-text">联网</span>
            <CloseOutlined className="ref-x" onClick={() => conv && st.setWeb(conv.id, false)} />
          </span>,
        ]
      : []),
    // 引用的主机多了合成一个「N 台主机」标签，点开可以多选移除（第三十三轮）
    ...(refs.terminals.length > HOST_CHIP_MAX ? [<HostRefsChip key="hosts" terminals={refs.terminals} onRemove={(r) => st.removeTerminalRefs(r)} />] : []),
    ...(refs.terminals.length > HOST_CHIP_MAX ? [] : refs.terminals).map((t) => (
      <span key={t.tabId} className="ref-chip" title={t.sessionId ? `${t.title}（已连接的终端）` : `${t.title}（未打开终端的主机，执行命令时会建立连接）`}>
        {t.kind === 'local' ? <CodeOutlined /> : <CloudServerOutlined />}
        <span className="ref-chip-text">{t.title}</span>
        {!t.sessionId && t.hostId && (
          <Tooltip title="在终端中打开">
            <CodeOutlined
              className="ref-open"
              onClick={() => {
                const h = hosts.find((x) => x.id === t.hostId);
                if (!h) return;
                openHost(h, 'ssh');
                useApp.getState().setPage('workspace');
              }}
              data-testid="ref-open-terminal"
            />
          </Tooltip>
        )}
        <CloseOutlined className="ref-x" onClick={() => st.removeTerminalRefs([t])} />
      </span>
    )),
    ...st.databaseIds.map((did) => {
      const d = databases.find((x) => x.id === did);
      return (
        <span key={`db:${did}`} className="ref-chip db" title={d ? `${d.name}（${DB_TYPE_LABEL[d.type]} ${dbWhere(d)}）：Agent 可以查询，改数据需要你批准` : '数据库（已删除）'} data-testid="ref-chip-db">
          <DatabaseOutlined />
          <span className="ref-chip-text">{d?.name ?? '（已删除）'}</span>
          <CloseOutlined className="ref-x" onClick={() => st.toggleDatabase(did, false)} />
        </span>
      );
    }),
    ...st.kbCollections.map((kid) => (
      <span key={`kb:${kid}`} className="ref-chip kb" title="知识库：发送时先按问题检索，命中的片段一起发给模型（任何模型都能用上）" data-testid="ref-chip-kb">
        <ReadOutlined />
        <span className="ref-chip-text">{kbName(kbList, kid)}</span>
        <CloseOutlined className="ref-x" onClick={() => st.toggleKb(kid, false)} />
      </span>
    )),
    ...st.folderIds.map((fid) => (
      <span key={`folder:${fid}`} className="ref-chip" title="整个分组（包含子分组里的主机）">
        <FolderOutlined />
        <span className="ref-chip-text">{folders.find((f) => f.id === fid)?.name ?? '（已删除）'}</span>
        <CloseOutlined className="ref-x" onClick={() => st.toggleFolder(fid, false)} />
      </span>
    )),
    ...st.noteIds.map((nid) => (
      <span key={`note:${nid}`} className="ref-chip note" title="笔记（发给模型前脱敏）">
        <BookOutlined />
        <span className="ref-chip-text">{notes.find((n) => n.id === nid)?.title ?? '（已删除）'}</span>
        <CloseOutlined className="ref-x" onClick={() => st.toggleNote(nid, false)} />
      </span>
    )),
    ...st.mcpServerIds.map((mid) => (
      <span key={`mcp:${mid}`} className="ref-chip mcp" title="MCP Server（Agent 可以调用它的工具）">
        <ApiOutlined />
        <span className="ref-chip-text">{mcpServers.find((s) => s.id === mid)?.name ?? 'MCP'}</span>
        <CloseOutlined className="ref-x" onClick={() => st.toggleMcp(mid, false)} />
      </span>
    )),
    ...st.files.map((f, i) => (
      <span key={`file:${f.hostId}:${f.path}`} className="ref-chip file" title={`${f.path}（尾部 ${f.tailLines ?? 200} 行，只在下一次发送时带上）`}>
        <FileTextOutlined />
        <span className="ref-chip-text">{f.path.split('/').pop()}</span>
        <CloseOutlined className="ref-x" onClick={() => st.removeFile(i)} />
      </span>
    )),
    ...st.attachments.map((a) => (
      <span key={`att:${a.path}`} className="ref-chip file" title={`${a.path}（只在下一次发送时带上）`}>
        <PaperClipOutlined />
        <span className="ref-chip-text">{a.name}</span>
        <CloseOutlined className="ref-x" onClick={() => st.removeAttachment(a.path)} />
      </span>
    )),
    ...selectedSkills.map((s) => (
      <span key={`skill:${s.id}`} className="ref-chip skill">
        <ThunderboltOutlined />
        <span className="ref-chip-text">{s.title}</span>
        <CloseOutlined className="ref-x" onClick={() => st.toggleSkill(s.id, false)} />
      </span>
    )),
  ];
  // 输入框上方的引用行（终端页右侧 AI 面板和 AI 对话模式都有）：一行显示全部，放不下时左右滑动；最右边的 ··· 查看全部引用、添加引用
  const refsBarEl = (
    // AI 对话模式里 agent-refs 是右侧的上下文面板，引用行换一个 testid
    <div className="agent-refs" data-testid={variant === 'page' ? 'agent-refs-bar' : 'agent-refs'}>
      <div className="agent-refs-bar" ref={refsBarRef}>
        {refChips()}
        {refs.terminals.length === 0 && selectedSkills.length === 0 && st.folderIds.length === 0 && st.noteIds.length === 0 && st.databaseIds.length === 0 && st.kbCollections.length === 0 && (
          <Typography.Text type="secondary" className="agent-refs-empty">
            没有引用终端，Agent 不能执行命令
          </Typography.Text>
        )}
      </div>
      <Popover
        open={moreOpen}
        onOpenChange={setMoreOpen}
        trigger="click"
        placement="topRight"
        arrow={false}
        overlayClassName="refs-popover"
        destroyOnHidden
        content={
          <div className="refs-more" data-testid="refs-more-panel">
            <div className="refs-more-head">已引用 {refCount}</div>
            <div className="refs-more-chips">{refCount > 0 ? refChips() : <Typography.Text type="secondary">还没有引用</Typography.Text>}</div>
            <div className="composer-plus-sep">添加引用</div>
            <RefsPicker />
          </div>
        }
      >
        <Tooltip title={refCount > 0 ? `已引用 ${refCount} 个，点击查看全部、添加引用` : '添加引用'} open={moreOpen ? false : undefined}>
          <Button size="small" type="text" className={`refs-more-btn ${moreOpen ? 'on' : ''} ${refCount > 0 ? 'has-count' : ''}`} aria-label="更多引用" data-count={refCount} data-testid="refs-more">
            <EllipsisOutlined />
            {refCount > 0 && (
              <span className="refs-more-count" data-testid="refs-count">
                {refCount}
              </span>
            )}
          </Button>
        </Tooltip>
      </Popover>
    </div>
  );
  const inputEl = (
    <div
      className={`agent-input ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        void addImageFiles(files);
        addFilePaths(
          files
            .filter((f) => !AGENT_IMAGE_TYPES.includes(f.type))
            .map((f) => window.itm.getPathForFile(f))
            .filter(Boolean),
        );
      }}
    >
      {popup && (
        <MentionPopup
          title={popup.kind === 'mention' ? '引用到对话' : '命令'}
          items={popupItems}
          active={Math.min(popupIdx, Math.max(0, popupItems.length - 1))}
          onHover={setPopupIdx}
          onPick={pickPopup}
          categories={popup.kind === 'mention' ? MENTION_CATS : undefined}
          empty={popup.kind === 'mention' && mentionCat === '知识库' && !kbList.length ? '知识库在服务端：登录后、管理员开放了知识库才能引用' : undefined}
          category={mentionCat}
          onCategory={(c) => {
            setMentionCat(c);
            setPopupIdx(0);
          }}
        />
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept={AGENT_IMAGE_TYPES.join(',')}
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          void addImageFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
        data-testid="image-input"
      />
      {/* 整页模式：左下角 + 里的「添加图片或文件」，图片作为图片发送，其他文件按本机文本文件附加 */}
      <input
        ref={anyFileRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void addImageFiles(files);
          addFilePaths(
            files
              .filter((f) => !AGENT_IMAGE_TYPES.includes(f.type))
              .map((f) => window.itm.getPathForFile(f))
              .filter(Boolean),
          );
          e.target.value = '';
        }}
        data-testid="any-file-input"
      />
      {st.images.length > 0 && (
        <div className="agent-images" data-testid="agent-images">
          {st.images.map((img, i) => (
            <div key={i} className="agent-image" title={img.name}>
              <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name} />
              <button type="button" className="agent-image-x" onClick={() => st.removeImage(i)} data-testid="image-remove">
                <CloseOutlined />
              </button>
            </div>
          ))}
          {currentModel && !currentModel.supportsImages && (
            <Typography.Text type={visionFallbackOn() ? 'secondary' : 'warning'} style={{ fontSize: 12 }} data-testid="image-unsupported">
              {visionFallbackOn() ? '当前模型看不了图片，发送时先用识图模型转成文字' : '当前模型不支持图片'}
            </Typography.Text>
          )}
        </div>
      )}
      {queued.length > 0 && (
        <div className="agent-queue" data-testid="agent-queue">
          <Typography.Text type="secondary" className="agent-queue-title">
            排队中（{queued.length}/{MAX_QUEUE}），上一条结束后按顺序发送
          </Typography.Text>
          {queued.map((m, i) => (
            <div key={m.qid} className="agent-queue-item" data-testid="queue-item">
              <span className="agent-queue-no">{i + 1}</span>
              {m.mode === 'ask' && (
                <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                  Ask
                </Tag>
              )}
              <Tooltip title={m.text} placement="topLeft">
                <span className="agent-queue-text">{m.text}</span>
              </Tooltip>
              {m.inserting ? (
                <Typography.Text type="secondary" className="agent-queue-inserting" data-testid="queue-inserting">
                  正在打断…
                </Typography.Text>
              ) : (
                <Tooltip title="立即插入：打断当前的回答（正在执行的命令也会停止），马上把这条发给 AI，让它按新的要求继续">
                  <Button size="small" type="text" icon={<VerticalAlignTopOutlined />} className="agent-queue-insert" onClick={() => conv && st.insertNow(conv.id, m.qid)} data-testid="queue-insert" aria-label="立即插入" />
                </Tooltip>
              )}
              <Tooltip title="不发送这条">
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => conv && st.removeQueued(conv.id, m.qid)} data-testid="queue-remove" aria-label="删除排队消息" />
              </Tooltip>
            </div>
          ))}
        </div>
      )}
      <div className={`agent-input-box ${running && text.trim() ? 'two' : ''} composer`}>
        <Input.TextArea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            detectPopup(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) => detectPopup(text, e.currentTarget.selectionStart ?? text.length)}
          onBlur={() => setTimeout(() => setPopup(null), 120)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files ?? []).filter((f) => AGENT_IMAGE_TYPES.includes(f.type));
            if (files.length) {
              e.preventDefault();
              void addImageFiles(files);
            }
          }}
          autoSize={{ minRows: 2, maxRows: 8 }}
          placeholder={
            db
              ? st.mode === 'agent'
                ? 'Agent 模式：AI 可以自己查询数据库（改数据要你批准），Enter 发送'
                : '例如：最近 7 天每天新增多少订单？Enter 发送'
              : st.mode === 'agent'
                ? '描述要排查或处理的问题，@ 引用主机，/ 命令，Enter 发送'
                : 'Ask 模式：只回答和给建议，不执行命令'
          }
          onKeyDown={(e) => {
            // @ 弹窗里 Tab / Shift+Tab 只在分类之间切换，不会把焦点移到输入框外面（第二十六轮）；没有结果时也一样
            if (popup?.kind === 'mention' && e.key === 'Tab' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const i = MENTION_CATS.indexOf(mentionCat);
              setMentionCat(MENTION_CATS[(i + (e.shiftKey ? MENTION_CATS.length - 1 : 1)) % MENTION_CATS.length]);
              setPopupIdx(0);
              return;
            }
            if (popup && popupItems.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setPopupIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + popupItems.length) % popupItems.length);
                return;
              }
              if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
                e.preventDefault();
                pickPopup(popupItems[Math.min(popupIdx, popupItems.length - 1)]);
                return;
              }
            }
            if (popup && e.key === 'Escape') {
              e.preventDefault();
              setPopup(null);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (running) enqueue();
              else void send();
            }
          }}
          data-testid="agent-input"
        />
        <div className="composer-bar">
          <Popover
            open={plusOpen}
            onOpenChange={setPlusOpen}
            trigger="click"
            placement="topLeft"
            arrow={false}
            overlayClassName="refs-popover composer-plus-popover"
            destroyOnHidden
            content={
              <div className="composer-plus">
                <div
                  className="composer-plus-item"
                  onClick={() => {
                    setPlusOpen(false);
                    anyFileRef.current?.click();
                  }}
                  data-testid="composer-add-file"
                >
                  <PaperClipOutlined />
                  <span>添加图片或文件</span>
                  <span className="composer-plus-hint">也可以粘贴截图、拖入</span>
                </div>
                {!db && <div className="composer-plus-item composer-plus-term" title="每次发送带上引用终端里 AI 还没看过的最近输出，最多这么多行" data-testid="composer-term-ctx">
                  <CodeOutlined />
                  <span className={termCtx.enabled ? '' : 'off'}>引用终端最近</span>
                  <InputNumber
                    size="small"
                    className="composer-term-lines"
                    min={TERMINAL_CONTEXT_LINES.min}
                    max={TERMINAL_CONTEXT_LINES.max}
                    step={50}
                    precision={0}
                    value={termCtx.lines}
                    disabled={!termCtx.enabled}
                    onChange={(v) => {
                      if (typeof v === 'number' && v >= TERMINAL_CONTEXT_LINES.min && v <= TERMINAL_CONTEXT_LINES.max && v !== termCtx.lines) setTermCtx({ lines: v });
                    }}
                    aria-label="引用终端的行数"
                    data-testid="composer-term-lines"
                  />
                  <span className={termCtx.enabled ? '' : 'off'}>行</span>
                  <Switch size="small" className="composer-term-switch" checked={termCtx.enabled} onChange={(v) => setTermCtx({ enabled: v })} data-testid="composer-term-switch" />
                </div>}
                {variant === 'side' && (
                  <div className="composer-plus-item composer-plus-term" title={web.available ? `AI 可以搜索和读取公开网页（用「${web.label}」搜索，按次计费）` : (web.reason ?? undefined)} data-testid="composer-web">
                    <GlobalOutlined />
                    <span className={web.on ? '' : 'off'}>联网搜索</span>
                    {!web.available && <span className="composer-plus-hint">需要 DeepSeek</span>}
                    <Switch size="small" className="composer-term-switch" checked={web.on} disabled={!web.available || !conv} onChange={(v) => conv && st.setWeb(conv.id, v)} data-testid="composer-web-switch" />
                  </div>
                )}
                <div className="composer-plus-sep">引用主机、数据库、知识库、分组、笔记、Skill、MCP</div>
                <RefsPicker />
              </div>
            }
          >
            <Tooltip title="添加图片、文件和引用" placement="top" open={plusOpen ? false : undefined}>
              <Button type="text" shape="circle" className={`composer-plus-btn ${plusOpen ? 'on' : ''}`} icon={<PlusOutlined />} data-testid="refs-expand" aria-label="添加" />
            </Tooltip>
          </Popover>
          {/* Agent / Ask（第二十六轮）：一个小按钮，点一下切换，原来的分段控件太占位置 */}
          {/* 模式 + 权限合成一个按钮（第二十六轮）：Agent · 跟随分组 / Ask */}
          <ChatPolicyPicker mode={st.mode} onMode={(m) => st.setMode(m)} value={(conv && st.chatPolicy[conv.id]) || DEFAULT_CHAT_POLICY} onChange={(p) => conv && st.setChatPolicy(conv.id, p)} />
          <span className="composer-spacer" />
          <ModelPicker
            providers={st.providers}
            model={st.model}
            choice={conv ? st.thinking[conv.id] : undefined}
            onModel={(m) => st.setModel(m)}
            onThinking={(c) => conv && st.setThinking(conv.id, c)}
            compact={variant === 'side'}
          />
          {variant === 'page' && <WebToggle compact conversationId={conv?.id ?? null} />}
          <ContextRing usage={st.usage} threshold={settings['ai.autoCompressPct']} onCompress={() => void compress()} compressing={compressing} disabled={running || !conv?.messages.length} />
          <div className="agent-input-actions">
            {running && text.trim() && (
              <Tooltip key="queue" title={`排队发送（Enter）：上一条结束后自动发送，最多 ${MAX_QUEUE} 条`}>
                <Button
                  size="small"
                  type="primary"
                  icon={<FieldTimeOutlined />}
                  onClick={() => enqueue()}
                  disabled={!st.model || queued.length >= MAX_QUEUE}
                  data-testid="agent-queue-add"
                  className="agent-send"
                />
              </Tooltip>
            )}
            {running ? (
              // key 不同：「停止」和「发送」切换时重新挂载，否则 antd 按钮会残留红色的 danger 样式
              <Tooltip key="stop" title="停止">
                <Button size="small" danger icon={<StopOutlined />} onClick={() => conv && void invoke('agent.stop', { id: conv.id })} data-testid="agent-stop" className="agent-send" />
              </Tooltip>
            ) : (
              <Tooltip key="send" title="发送（Enter）">
                <Button size="small" type="primary" icon={<SendOutlined />} disabled={!text.trim() || !st.model} onClick={() => void send()} data-testid="agent-send" className="agent-send" />
              </Tooltip>
            )}
          </div>
        </div>
      </div>
      <div className="agent-disclaimer" data-testid="agent-disclaimer">
        内容由 AI 生成，可能有误，请勿完全相信；执行命令前请仔细审核
      </div>
    </div>
  );

  return (
    <div className={`agent-panel ${variant} ${db ? 'db-chat' : ''}`} data-testid={variant === 'page' ? 'agent-page-panel' : db ? 'db-agent-panel' : 'agent-panel'}>
      {variant === 'page' ? (
        <div className="agent-page-body">
          <div className="agent-page-main">
            {headEl}
            {listEl}
            {refsBarEl}
            {inputEl}
          </div>
          {ctxOpen && <ContextPanel refs={refs} hosts={hosts} folders={folders} notes={notes} mcpServers={mcpServers} skills={selectedSkills} />}
        </div>
      ) : (
        <>
          {headEl}
          {listEl}
          {refsBarEl}
          {inputEl}
        </>
      )}
    </div>
  );
}
