import { createContext, useContext } from 'react';
import { create } from 'zustand';
import { aiAllowed, promptLogin } from '../util/ai-access';
import type {
  AgentConversationSummary,
  AgentConversationView,
  AgentImage,
  AgentMode,
  AgentRefs,
  AgentTerminalRef,
  AiProvider,
  ContextUsage,
  Host,
  AiModelConfig,
  ModelRef,
  SkillInfo,
  ThinkingChoice,
  ChatPolicy,
  SqlChatContext,
} from '@itm/protocol';
import { DEFAULT_SETTINGS, type WebSearchStatus } from '@itm/protocol';
import { invoke } from '../api';
import { onFirstTerminal, type Tab } from './tabs';
import { useApp } from './app';

interface AgentState {
  /** main：终端页右侧 / AI 对话；db：SQL 工作台右侧的对话（第二十九轮，独立的对话、默认 Ask 模式、不引用终端） */
  scope: 'main' | 'db';
  /** SQL 工作台当前标签的数据库上下文（只有 db 用） */
  sqlContext: SqlChatContext | null;
  setSqlContext(c: SqlChatContext | null): void;
  providers: AiProvider[];
  skills: SkillInfo[];
  conversations: AgentConversationSummary[];
  current: AgentConversationView | null;
  mode: AgentMode;
  model: ModelRef | null;
  usage: ContextUsage | null;
  /** 用户从引用里移除的终端标签（默认引用所有已连接的终端） */
  excludedTabs: string[];
  /** 额外引用的主机（没有打开终端的主机也可以让 Agent 执行命令） */
  extraHostIds: string[];
  skillIds: string[];
  /** 引用整个分组 */
  folderIds: string[];
  /** 引用的笔记（发给模型前脱敏） */
  noteIds: string[];
  /** 引用的 MCP Server（Agent 可以调用它的工具） */
  mcpServerIds: string[];
  /** 引用的数据库（第十七轮，Agent 用 db_* 工具查询 / 修改） */
  databaseIds: string[];
  /** 引用的团队知识库：发送时先按问题检索，命中的片段放进上下文；'*' 表示全部可见的知识库 */
  kbCollections: string[];
  /** 远端文件 / 本机附件：只在下一次发送时带上，发送后清空 */
  files: { hostId: string; path: string; tailLines?: number }[];
  attachments: { name: string; path: string }[];
  /** 图片：只在下一次发送时带上（文档一 6.15.8） */
  images: AgentImage[];
  /** 其他地方发起的提问（终端里 # 开头的输入、选中文字让 AI 解释），由 AI 面板发送 */
  pending: { text: string; mode: AgentMode; seq: number } | null;
  /** 引用到输入框的内容（终端右键「引用到 AI 对话框」）：AI 面板把它加到输入框里，由用户补充问题后再发送 */
  quoted: { text: string; seq: number } | null;
  /** 每个会话的深度思考开关（文档一 6.15.5），记在本机 */
  thinking: Record<string, ThinkingChoice>;
  /** null = 自动（跟随模型默认，第二十六轮） */
  setThinking(conversationId: string, c: ThinkingChoice | null): void;
  /** 每个会话的「联网」开关（文档一 6.38），记在本机；没有设置过的会话按「新对话默认开启」 */
  web: Record<string, boolean>;
  setWeb(conversationId: string, on: boolean): void;
  /** 联网搜索现在能不能用、用哪个服务（第二十五轮：独立的工具，和模型提供商无关） */
  webStatus: WebSearchStatus | null;
  loadWebStatus(): Promise<void>;
  loadProviders(): Promise<void>;
  loadSkills(): Promise<void>;
  refreshList(): Promise<void>;
  open(id: string): Promise<void>;
  newConversation(): Promise<void>;
  /** 换成一个全新的对话（当前对话还是空的就沿用），并清掉上一个对话留下的引用 */
  freshConversation(): Promise<void>;
  setMode(m: AgentMode): void;
  setModel(m: ModelRef | null): void;
  toggleTab(tabId: string, on: boolean): void;
  toggleHost(hostId: string, on: boolean): void;
  /** 一次去掉多个引用的终端 / 主机（tabId 为 host:{id} 的是没打开终端的主机）；去掉终端时也去掉同一台主机的额外引用，避免换成「未连接」重新出现 */
  removeTerminalRefs(refs: { tabId: string; hostId: string | null }[]): void;
  toggleSkill(id: string, on: boolean): void;
  toggleFolder(id: string, on: boolean): void;
  toggleNote(id: string, on: boolean): void;
  toggleMcp(id: string, on: boolean): void;
  toggleDatabase(id: string, on: boolean): void;
  /** 引用知识库：'*'（全部）和具体的知识库互斥 */
  toggleKb(id: string, on: boolean): void;
  addFile(f: { hostId: string; path: string; tailLines?: number }): void;
  removeFile(index: number): void;
  addAttachment(a: { name: string; path: string }): void;
  removeAttachment(path: string): void;
  addImages(images: AgentImage[]): void;
  removeImage(index: number): void;
  /** 发送成功后清掉一次性的引用（文件、附件） */
  clearOneShot(): void;
  ask(text: string, mode: AgentMode): void;
  quote(text: string): void;
  setUsage(u: ContextUsage | null): void;
  /** 回答还没结束时发的消息先排队（每个会话最多 5 条），上一条结束后按顺序自动发送 */
  queue: Record<string, QueuedMessage[]>;
  enqueue(conversationId: string, m: Omit<QueuedMessage, 'qid'>): boolean;
  removeQueued(conversationId: string, qid: string): void;
  /**
   * 立即插入（第十四轮，参考 Claude / ChatGPT 的打断）：把这条排到最前面，停止当前回答（正在执行的命令、等待的审批一并结束），
   * 停下来后马上发送它，引导 AI 换个方向
   */
  insertNow(conversationId: string, qid: string): void;
  /** 对话里临时调整的 Agent 权限（第十四轮）：每个对话一个，只在内存里（重启后回到跟随主机设置） */
  chatPolicy: Record<string, ChatPolicy>;
  setChatPolicy(conversationId: string, p: ChatPolicy): void;
}

/** 排队的消息：发送时用排队那一刻的模式、模型、引用和深度思考设置 */
export interface QueuedMessage {
  qid: string;
  text: string;
  mode: AgentMode;
  model: ModelRef;
  refs: AgentRefs;
  thinking?: ThinkingChoice;
  /** 点了「立即插入」：正在打断当前回答，结束后马上发送这条 */
  inserting?: boolean;
  /** 排队时的对话权限 */
  policy?: ChatPolicy;
  /** 排队时打开了「联网」 */
  web?: boolean;
}
export const MAX_QUEUE = 5;

/** 按会话记住的开关（必须在 create 之前定义：创建 store 时就会读取） */
const THINKING_KEY = 'itm.agent.thinking';
const WEB_KEY = 'itm.agent.web';

function makeAgentStore(scope: AgentState['scope']) {
  const store = create<AgentState>((set, get) => ({
    scope,
    sqlContext: null,
    setSqlContext(sqlContext) {
      set({ sqlContext });
    },
    providers: [],
    webStatus: null,
    skills: [],
    conversations: [],
    current: null,
    mode: scope === 'db' ? 'ask' : 'agent',
    model: null,
    usage: null,
    excludedTabs: [],
    extraHostIds: [],
    skillIds: [],
    folderIds: [],
    noteIds: [],
    mcpServerIds: [],
    databaseIds: [],
    kbCollections: [],
    files: [],
    attachments: [],
    images: [],
    pending: null,
    quoted: null,
    thinking: loadThinking(),
    web: loadRecord<boolean>(WEB_KEY),
    setWeb(id, on) {
      set((s) => ({ web: saveRecent(WEB_KEY, { ...s.web, [id]: on }) }));
    },
    queue: {},
    enqueue(id, m) {
      const cur = get().queue[id] ?? [];
      if (cur.length >= MAX_QUEUE) return false;
      set((s) => ({ queue: { ...s.queue, [id]: [...cur, { ...m, qid: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` }] } }));
      return true;
    },
    removeQueued(id, qid) {
      set((s) => ({ queue: { ...s.queue, [id]: (s.queue[id] ?? []).filter((q) => q.qid !== qid) } }));
    },
    chatPolicy: {},
    setChatPolicy(id, p) {
      set((s) => ({ chatPolicy: { ...s.chatPolicy, [id]: p } }));
    },
    insertNow(id, qid) {
      const cur = get().queue[id] ?? [];
      const item = cur.find((q) => q.qid === qid);
      if (!item || item.inserting) return;
      set((s) => ({ queue: { ...s.queue, [id]: [{ ...item, inserting: true }, ...cur.filter((q) => q.qid !== qid)] } }));
      const view = get().current;
      // 已经停了（刚好结束）：直接发送；还在回答：停止，结束时的 agent.update 会发送排在最前面的这条
      if (view?.id === id && !view.running) drainQueue(store, id);
      else void invoke('agent.stop', { id }).catch(() => undefined);
    },
    setThinking(id, c) {
      set((s) => {
        const next = { ...s.thinking };
        if (c) next[id] = c;
        else delete next[id];
        return { thinking: saveRecent(THINKING_KEY, next) };
      });
    },
    async loadWebStatus() {
      const webStatus = await invoke('web.status').catch(() => null);
      set({ webStatus });
    },
    async loadProviders() {
      void get().loadWebStatus();
      const providers = await invoke('ai.providers.list');
      const settings = await invoke('setting.getAll');
      set((s) => {
        const valid = (m: ModelRef | null): boolean =>
          !!m && providers.some((p) => p.enabled && p.id === m.providerId && p.models.some((x) => x.id === m.modelId));
        const first = providers.find((p) => p.enabled && p.models.length > 0);
        const fallback = first ? { providerId: first.id, modelId: first.models[0].id } : null;
        const model = valid(s.model) ? s.model : valid(settings['ai.defaultModel']) ? settings['ai.defaultModel'] : fallback;
        return { providers, model };
      });
    },
    async loadSkills() {
      set({ skills: await invoke('skill.list') });
    },
    async refreshList() {
      set({ conversations: await invoke('agent.list') });
    },
    async open(id) {
      const view = await invoke('agent.get', { id });
      set({ current: view, model: view.model ?? get().model });
    },
    async newConversation() {
      const view = await invoke('agent.create', { model: get().model });
      set({ current: view, skillIds: [] });
      await get().refreshList();
    },
    async freshConversation() {
      const cur = get().current;
      set({ excludedTabs: [], extraHostIds: [], skillIds: [], folderIds: [], noteIds: [], mcpServerIds: [], databaseIds: [], kbCollections: [], files: [], attachments: [], images: [] });
      if (cur && cur.messages.length === 0 && !cur.running) return;
      await get().newConversation();
    },
    setMode(mode) {
      set({ mode });
    },
    setModel(model) {
      set({ model });
    },
    toggleTab(tabId, on) {
      set((s) => ({ excludedTabs: on ? s.excludedTabs.filter((t) => t !== tabId) : [...new Set([...s.excludedTabs, tabId])] }));
    },
    toggleHost(hostId, on) {
      set((s) => ({ extraHostIds: on ? [...new Set([...s.extraHostIds, hostId])] : s.extraHostIds.filter((h) => h !== hostId) }));
    },
    removeTerminalRefs(refs) {
      const tabIds = refs.filter((r) => !r.tabId.startsWith('host:')).map((r) => r.tabId);
      const hostIds = new Set(refs.map((r) => r.hostId).filter((h): h is string => !!h));
      set((s) => ({ excludedTabs: [...new Set([...s.excludedTabs, ...tabIds])], extraHostIds: s.extraHostIds.filter((h) => !hostIds.has(h)) }));
    },
    toggleSkill(id, on) {
      set((s) => ({ skillIds: on ? [...new Set([...s.skillIds, id])] : s.skillIds.filter((x) => x !== id) }));
    },
    toggleFolder(id, on) {
      set((s) => ({ folderIds: on ? [...new Set([...s.folderIds, id])] : s.folderIds.filter((x) => x !== id) }));
    },
    toggleMcp(id, on) {
      set((s) => ({ mcpServerIds: on ? [...new Set([...s.mcpServerIds, id])] : s.mcpServerIds.filter((x) => x !== id) }));
    },
    toggleDatabase(id, on) {
      if (on && !aiAllowed()) return promptLogin();
      set((s) => ({ databaseIds: on ? [...new Set([...s.databaseIds, id])] : s.databaseIds.filter((x) => x !== id) }));
    },
    toggleKb(id, on) {
      set((s) => ({ kbCollections: !on ? s.kbCollections.filter((x) => x !== id) : id === '*' ? ['*'] : [...new Set([...s.kbCollections.filter((x) => x !== '*'), id])] }));
    },
    toggleNote(id, on) {
      set((s) => ({ noteIds: on ? [...new Set([...s.noteIds, id])] : s.noteIds.filter((x) => x !== id) }));
    },
    addFile(f) {
      if (!aiAllowed()) return promptLogin();
      set((s) => ({ files: [...s.files.filter((x) => !(x.hostId === f.hostId && x.path === f.path)), f] }));
    },
    removeFile(index) {
      set((s) => ({ files: s.files.filter((_, i) => i !== index) }));
    },
    addAttachment(a) {
      set((s) => ({ attachments: [...s.attachments.filter((x) => x.path !== a.path), a] }));
    },
    removeAttachment(path) {
      set((s) => ({ attachments: s.attachments.filter((x) => x.path !== path) }));
    },
    addImages(images) {
      set((s) => ({ images: [...s.images, ...images].slice(0, 5) }));
    },
    removeImage(index) {
      set((s) => ({ images: s.images.filter((_, i) => i !== index) }));
    },
    clearOneShot() {
      set({ files: [], attachments: [], images: [] });
    },
    ask(text, mode) {
      // 离线使用（Guest）不能用 AI：终端 # 提问、「让 AI 解释」等入口改为提示登录（第十二轮）
      if (!aiAllowed()) return promptLogin();
      set((s) => ({ pending: { text, mode, seq: (s.pending?.seq ?? 0) + 1 } }));
    },
    quote(text) {
      if (!aiAllowed()) return promptLogin();
      set((s) => ({ quoted: { text, seq: (s.quoted?.seq ?? 0) + 1 } }));
    },
    setUsage(usage) {
      set({ usage });
    },
  }));
  return store;
}

export const useAgent = makeAgentStore('main');
export type AgentStore = typeof useAgent;
/** SQL 工作台的 AI 对话（第二十九轮） */
export const useDbAgent: AgentStore = makeAgentStore('db');
const STORES: AgentStore[] = [useAgent, useDbAgent];

/** AI 面板用哪个对话：默认是终端页 / AI 对话的那个；SQL 工作台的面板包一层 Provider 换成 useDbAgent */
export const AgentStoreContext = createContext<AgentStore>(useAgent);
export function useAgentStore(): AgentStore {
  return useContext(AgentStoreContext);
}

function loadThinking(): Record<string, ThinkingChoice> {
  return loadRecord<ThinkingChoice>(THINKING_KEY);
}
function loadRecord<T>(key: string): Record<string, T> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, T>) : {};
  } catch {
    return {};
  }
}

/** 按会话记的开关只保留最近 200 个会话，存不下就只留在内存里 */
function saveRecent<T>(key: string, v: Record<string, T>): Record<string, T> {
  const keys = Object.keys(v);
  if (keys.length > 200) keys.slice(0, keys.length - 200).forEach((k) => delete v[k]);
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // 忽略
  }
  return v;
}

/**
 * 「联网」开关的状态（文档一 6.39）：搜索服务不能用时关闭并给出原因；否则按会话里的开关 → 新对话默认（默认关闭）。
 * 命中敏感数据规则的对话由主进程关掉。
 */
export function effectiveWeb(conversationId: string | null | undefined, store: AgentStore = useAgent): { on: boolean; available: boolean; label: string | null; reason: string | null } {
  const setting = useApp.getState().settings['ai.webSearch'] ?? DEFAULT_SETTINGS['ai.webSearch'];
  const st = store.getState().webStatus;
  if (!st) return { on: false, available: false, label: null, reason: '正在读取联网搜索的配置…' };
  if (!st.available) return { on: false, available: false, label: null, reason: st.reason };
  return { on: (conversationId ? store.getState().web[conversationId] : undefined) ?? setting.defaultOn, available: true, label: st.label, reason: null };
}

/** 设置里拖拽的顺序（ai.providerOrder），没排过的按原来的顺序放在后面 */
export function orderProviders(providers: AiProvider[], order: readonly string[] | undefined): AiProvider[] {
  const rank = new Map((order ?? []).map((id, i) => [id, i]));
  return providers
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (rank.get(a.p.id) ?? 10_000 + a.i) - (rank.get(b.p.id) ?? 10_000 + b.i))
    .map((x) => x.p);
}

/** 当前模型配置 */
export function modelConfig(providers: AiProvider[], ref: ModelRef | null): AiModelConfig | null {
  if (!ref) return null;
  return providers.find((p) => p.id === ref.providerId)?.models.find((m) => m.id === ref.modelId) ?? null;
}

/**
 * 会话实际使用的思考设置：不支持思考的模型始终关闭、始终思考的模型始终开启；
 * 其余按会话里的开关 → 模型默认 → 全局默认。
 */
export function effectiveThinking(choice: ThinkingChoice | undefined, m: AiModelConfig | null): ThinkingChoice & { locked: 'off' | 'on' | null } {
  const settings = useApp.getState().settings;
  const reasoning = m?.reasoning ?? 'none';
  if (reasoning === 'none') return { enabled: false, effort: null, locked: 'off' };
  const effort = choice?.effort ?? m?.effort ?? settings['ai.thinkingEffort'] ?? null;
  if (reasoning === 'always') return { enabled: true, effort, locked: 'on' };
  return { enabled: choice?.enabled ?? m?.thinkingDefault ?? settings['ai.thinkingDefault'], effort, locked: null };
}

/** 已经提醒过的审批（每个只提醒一次） */
const notified = new Set<string>();

/** 正在发送排队消息的会话（避免同一次结束触发两次） */
const draining = new Set<string>();
function drainQueue(store: AgentStore, id: string): void {
  const next = store.getState().queue[id]?.[0];
  if (!next || draining.has(id)) return;
  draining.add(id);
  store.getState().removeQueued(id, next.qid);
  invoke('agent.send', { id, text: next.text, mode: next.mode, model: next.model, refs: next.refs, thinking: next.thinking, policy: next.policy, web: next.web })
    .catch(() => undefined)
    .finally(() => setTimeout(() => draining.delete(id), 500));
}

onFirstTerminal(() => void useAgent.getState().freshConversation());

// 登录状态、团队策略（服务端的默认联网搜索）变化后重新读取联网搜索的状态
window.itm.on('account.state', () => STORES.forEach((st) => void st.getState().loadWebStatus()));

window.itm.on('agent.update', (view) => {
  for (const store of STORES) {
    const s = store.getState();
    if (s.current?.id === view.id) store.setState({ current: view });
    // 会话列表里的运行状态（第二十六轮）：开始执行时马上转圈，结束时刷新列表（SQL 工作台的对话用到时才读列表）
    if (view.running && !s.conversations.find((c) => c.id === view.id)?.running)
      store.setState({ conversations: s.conversations.map((c) => (c.id === view.id ? { ...c, running: true } : c)) });
    if (!view.running && (store === useAgent || s.conversations.length)) void s.refreshList();
    // 上一条回答结束：发送排队的下一条
    if (!view.running && s.queue[view.id]?.length) drainQueue(store, view.id);
  }
  // 等待审批时，应用不在前台就发系统通知（文档一 6.15.6）
  for (const m of view.messages) {
    if (m.role !== 'assistant') continue;
    for (const st of m.steps) {
      if (st.status !== 'approval' || !st.approvalId || notified.has(st.approvalId)) continue;
      notified.add(st.approvalId);
      if (document.hasFocus() || !useApp.getState().settings['ai.notifyApproval'] || typeof Notification === 'undefined') continue;
      const n = new Notification('iTerminal：等待你批准', { body: `${st.hostName ? `${st.hostName}：` : ''}${st.explanation || st.command}`.slice(0, 200), silent: false });
      n.onclick = () => {
        window.focus();
        void useAgent.getState().open(view.id);
      };
    }
  }
});

/** 可以引用的终端：终端类标签（SSH、本机） */
export function terminalTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((t) => t.kind !== 'sftp');
}

/**
 * 本轮的引用：默认所有已连接的终端（用户移除的除外）+ 额外添加的主机 + 选中的 Skill。
 * terminalLines：每个终端带上的最近输出行数（+ 里的「引用终端最近 N 行」，关闭时为 0）。
 */
export function buildRefs(
  tabs: Tab[],
  hosts: Host[],
  state: Pick<AgentState, 'excludedTabs' | 'extraHostIds' | 'skillIds' | 'folderIds' | 'noteIds' | 'mcpServerIds' | 'files' | 'attachments' | 'images'> & { databaseIds?: string[]; kbCollections?: string[]; sqlContext?: SqlChatContext | null },
  terminalLines?: number,
): AgentRefs {
  const terminals: AgentTerminalRef[] = terminalTabs(tabs)
    .filter((t) => t.status === 'ready' && t.sessionId && !state.excludedTabs.includes(t.id))
    .map((t) => ({ tabId: t.id, kind: t.kind === 'local' ? 'local' : t.kind === 'telnet' ? 'telnet' : t.kind === 'serial' ? 'serial' : 'ssh', title: t.title, sessionId: t.sessionId ?? null, hostId: t.hostId ?? null }));
  for (const hid of state.extraHostIds) {
    const h = hosts.find((x) => x.id === hid);
    if (h && !terminals.some((t) => t.hostId === hid)) {
      terminals.push({ tabId: `host:${hid}`, kind: h.protocol === 'SERIAL' ? 'serial' : h.protocol === 'TELNET' ? 'telnet' : 'ssh', title: h.name, sessionId: null, hostId: hid });
    }
  }
  return {
    terminals,
    skillIds: state.skillIds,
    folderIds: state.folderIds,
    noteIds: state.noteIds,
    mcpServerIds: state.mcpServerIds,
    ...(state.databaseIds?.length ? { databaseIds: state.databaseIds } : {}),
    ...(state.kbCollections?.length ? { kbCollections: state.kbCollections } : {}),
    files: state.files,
    attachments: state.attachments,
    ...(state.images.length ? { images: state.images } : {}),
    ...(terminalLines !== undefined ? { terminalLines } : {}),
    ...(state.sqlContext ? { sqlContext: state.sqlContext } : {}),
  };
}
