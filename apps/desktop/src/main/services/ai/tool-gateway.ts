import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import type { Recorder } from '../audit/recording-store';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, posix } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { applyPolicy, classifySql, DEFAULT_SECURITY, MAX_SQL_BYTES, type ApprovalEngine, type Classification, type EvaluateContext, type Evaluation, type PolicyConfig, type SqlClassification } from '@itm/approval';
import { blockingReason } from './command-shape';
import { ASK_TOOLS, AUTO_APPROVE_PROMPT, WEB_TOOL_NAMES, clip, parseAutoApprove, stripAnsi, tailLines, untrusted, type ResolvedModel, type ToolCall, type ToolResultRecord } from '@itm/agent-core';
import type { Masker } from '@itm/masking';
import {
  AGENT_POLICY_STRICTNESS,
  chatAgentPolicy,
  describeSchedule,
  DEFAULT_TASK_ALERT,
  type AgentMode,
  type AgentPolicy,
  type AgentStep,
  type AgentTerminalRef,
  type BatchItem,
  type DbAsset,
  type ChatPolicy,
  type Host,
  type LocalTask,
  type LocalTaskInput,
  type TaskPlan,
  type TaskPlanStep,
  type LibraryGroup,
  type Note,
  type NoteInput,
  type MetricsSnapshot,
  type ScheduleCheck,
  type ScheduleSpec,
  WEB_SEARCH_COUNT,
} from '@itm/protocol';
import type { AuditRepo } from '../audit/audit-repo';
import type { Emit } from '../connection/emitter';
import { execCommand, type ExecResult } from '../connection/exec';
import type { SessionManager } from '../connection/session-manager';
import type { SshPool } from '../connection/ssh-pool';
import type { HostRepo } from '../hosts/host-repo';
import type { MonitorService } from '../monitor/monitor-service';
import type { SettingsRepo } from '../settings/settings-repo';
import { openSftp } from '../sftp/sftp-service';
import type { RemoteFs } from '../sftp/remote-fs';
import { writeRemote } from '../sftp/edit-service';
import { fileTypeOf } from '../sftp/file-mode';
import type { CredentialRepo } from '../vault/credential-repo';
import { shQuote } from '../../util/shell';
import { unifiedDiff } from '../../util/diff';
import type { AgentRuntime } from './runtime';
import type { SkillStore } from './skills';
import { describeTasks } from '../schedule/scheduler';
import type { DbService, DbSession } from '../database/db-service';
import { denyPattern } from '../database/db-asset-repo';
import { DbAbortError, describeDbError } from '../database/drivers';
import { describeTable, dialectOf, estimateRows, listSchema, tableForModel, toTable } from '../database/db-tools';
import { UserError } from '../../util/errors';
import { MAX_QUERY_CHARS, checkPublicUrl, hostTerms, scrubQuery, type WebSearchClient } from './web-search';

/** 发给模型的单条输出上限（文档一 7.3：16KB） */
export const MAX_TOOL_OUTPUT = 16_000;
const BATCH_CONCURRENCY = 6;
const MAX_READ_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 2 * 1024 * 1024;
/** 写这些文件按高危处理 */
const CRITICAL_FILES = /^(\/etc\/(sudoers(\.d\/.*)?|passwd|shadow|group|gshadow|fstab|ssh\/sshd_config|pam\.d\/.*|security\/.*)|.*\/\.ssh\/authorized_keys)$/;
/** 上传这些本机文件按高危处理（私钥、云凭证、密码库等，防止被诱导把秘密传出去） */
const SENSITIVE_LOCAL = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config[\\/]gcloud|Keychains)([\\/]|$)|(id_rsa|id_ed25519|id_ecdsa|\.pem|\.key|\.p12|\.pfx|\.kdbx|credentials|\.env)$/i;
const MAX_TRANSFER_BYTES = 8 * 1024 ** 3;

export interface StepResponse {
  decision: 'approve' | 'reject';
  command?: string;
  confirmText?: string;
  hosts?: string[];
  answer?: string;
  memory?: string;
}

/** 步骤在界面上的展示和等待（由 AgentService 实现） */
export interface StepUi {
  add(step: AgentStep): void;
  update(): void;
  /** 把步骤标记为等待用户处理，直到用户回应（批准 / 拒绝 / 回答）或任务被停止 */
  wait(step: AgentStep): Promise<StepResponse>;
  /** 取消还在等待的步骤（按拒绝处理，例如主机记忆 10 秒没有回应），第二十八轮 */
  cancel?(step: AgentStep): void;
}

/** 不确定的主机记忆等用户确认的时间（测试里可以改短） */
export const MEMORY_CONFIRM = { ms: 10_000 };

export interface ToolContext {
  conversationId: string;
  owner: number;
  mode: AgentMode;
  targets: Record<string, AgentTerminalRef>;
  masker: Masker;
  signal: AbortSignal;
  ui: StepUi;
  /** 复核用的模型（快速模型，没有时用对话模型） */
  reviewModel: ResolvedModel | null;
  /** 权限上限（Skill 声明的 risk）：和主机的有效 Agent 权限取更严格的 */
  policyCap?: AgentPolicy;
  /** 只允许使用这些工具（Skill 的 allowed-tools） */
  allowedTools?: string[];
  /** 审计来源：外部 Agent 通过 MCP 调用时是 MCP_EXTERNAL；定时任务是 SCHEDULE */
  auditSource?: 'AGENT' | 'MCP_EXTERNAL' | 'SCHEDULE';
  /**
   * 无人值守（定时任务，文档一 6.11）：审批引擎只给出自动执行 / 远程审批 / 拒绝；远程审批由这个回调向服务端发起并等待结果。
   */
  unattended?: { approve(step: AgentStep): Promise<boolean>; cap?: AgentPolicy; label?: string };
  /**
   * 外部 Agent（MCP，第十三轮，文档一 6.27.5）：不弹审批。只读和安全命令直接执行；写操作要 allowWrite，高危指令还要 allowDanger，
   * 没勾选时直接拒绝。黑名单、主机的 Agent 权限（禁止 / 只读）、夜间窗口等硬性限制照常生效
   */
  external?: { allowWrite: boolean; allowDanger: boolean };
  /** 对话里临时调整的 Agent 权限（第十四轮，输入框底栏）；无人值守和外部 Agent 不用 */
  chatPolicy?: ChatPolicy;
  /** 本轮引用的数据库：编号（d1…）→ 数据库资产 ID（第十七轮，文档一 6.31.3） */
  databases?: Record<string, string>;
  /** 对话打开了「联网」（第二十四轮，文档一 6.38）：搜索服务和每次的条数；没有时 web_search / web_fetch 返回「没有打开」 */
  web?: { client: WebSearchClient; count: number } | null;
  /** 这一轮（一条用户消息触发的整个 Agent 循环）的状态：拒绝过的主机、执行过的只读命令、记了几条主机记忆 */
  turn?: TurnState;
}

/**
 * 一轮里的状态（第三十三轮，把几条只靠提示词的规则做成程序检查）：
 * - rejected：用户在这一轮拒绝过操作的主机（编号）。之后这台主机上的写操作一律要用户亲自批准，
 *   不再走 AI 自动审批 / 对话里的「自动执行」——防止被拒后换个写法让 AI 审批放行；
 * - reads：执行成功的只读命令和结果。同一轮里同一台主机再执行一模一样的只读命令（中间没有写操作、60 秒内）直接复用结果；
 * - memories：这一轮记了几条主机记忆（上限 MAX_MEMORIES_PER_TURN）。
 */
export interface TurnState {
  rejected: Set<string>;
  reads: Map<string, { content: string; isError: boolean; at: number }>;
  memories: number;
}

export function newTurnState(): TurnState {
  return { rejected: new Set(), reads: new Map(), memories: 0 };
}

/** 只读命令结果复用的时间窗口 */
const READ_REUSE_MS = 60_000;
/** 一轮最多记几条主机记忆 */
const MAX_MEMORIES_PER_TURN = 3;

/** 读取网页时发给模型的正文上限（字符） */
const MAX_WEB_PAGE_CHARS = 12_000;

/** 外部 Agent 没有开放某项权限时的提示（告诉外部 Agent 去让用户勾选，而不是换写法） */
export const EXTERNAL_NO_WRITE = 'iTerminal 没有给外部 Agent 开放写操作：请让用户在 iTerminal 的「设置 → 扩展 → MCP → 本机 MCP 服务」里把权限调到「允许写操作」';
export const EXTERNAL_NO_DANGER = 'iTerminal 没有给外部 Agent 开放高危指令：请让用户在 iTerminal 的「设置 → 扩展 → MCP → 本机 MCP 服务」里把权限调到「允许高危指令」';

/** 回环地址的各种写法：127.x、localhost、::1、十进制 / 十六进制 IP、0.0.0.0 */
const LOOPBACK = /(^|[^\w.-])(localhost|127(\.\d{1,3}){1,3}|2130706433|0x7f[0-9a-f]{6}|\[?::1\]?|\[?::ffff:127(\.\d{1,3}){1,3}\]?|0\.0\.0\.0)([^\w.-]|$)/i;

/** 命令里是否同时出现了本机回环地址和这个端口（第三十二轮，本机 MCP 接口的防护） */
export function referencesLocalPort(command: string, port: number): boolean {
  if (!Number.isInteger(port) || port <= 0) return false;
  if (!new RegExp(`(^|[^0-9])${port}([^0-9]|$)`).test(command)) return false;
  return LOOPBACK.test(command);
}

/** 知识库检索（登录后由服务端提供）；collectionIds 为空时检索全部可见的知识库 */
export type KbSearch = (query: string, topK: number, signal: AbortSignal, collectionIds?: string[]) => Promise<{ title: string; section: string | null; content: string; score: number; source: string }[]>;

/** 知识库命中片段给模型看的格式：编号、标题、章节、相关度、来源，再接正文（kb_search 和引用知识库共用） */
export function formatKbHits(hits: Awaited<ReturnType<KbSearch>>): string {
  return hits.map((h, i) => `[${i + 1}] ${h.title}${h.section ? ` · ${h.section}` : ''}（相关度 ${h.score.toFixed(2)}，来源 ${h.source}）\n${h.content}`).join('\n\n');
}

/** MCP 工具调用（文档一 6.8）：先查权限，再调用 */
export interface McpBridge {
  /** 工具的权限；Server 或工具不存在时返回说明文字 */
  permission(server: string, tool: string): Promise<'AUTO' | 'APPROVE' | 'DISABLED' | string>;
  call(server: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: string; isError: boolean }>;
}
/** 串口会话发送（M3 串口） */
export type SerialSender = (sessionId: string, data: string, waitFor: string | null, timeoutMs: number, signal: AbortSignal) => Promise<string>;

export interface GatewayDeps {
  hosts: HostRepo;
  credentials: CredentialRepo;
  sessions: SessionManager;
  pool: SshPool;
  monitor: MonitorService;
  skills: SkillStore;
  settings: SettingsRepo;
  audit: AuditRepo;
  approval: ApprovalEngine;
  runtime: AgentRuntime;
  emit: Emit;
  policy: () => PolicyConfig;
  runLocal: (command: string, timeoutMs: number, signal: AbortSignal, idleTimeoutMs?: number) => Promise<ExecResult>;
  kbSearch?: KbSearch;
  mcp?: McpBridge;
  serialSend?: SerialSender;
  /** 打开主机的文件通道（SFTP → SSH 命令通道 → FTP 自动兼容，和文件面板一样）；没有时只用 SFTP */
  files?: (owner: number, hostId: string) => Promise<{ remote: RemoteFs; protocol: string; close(): void }>;
  /** 本机的「下载」目录（file_download 保存到这里） */
  downloadsDir?: () => string;
  /** 本机定时任务（schedule_task / schedule_list） */
  schedule?: {
    validate(input: LocalTaskInput): LocalTaskInput;
    check(command: string, hostIds: string[], createdBy: 'AGENT'): Promise<ScheduleCheck[]>;
    save(id: null, input: LocalTaskInput, createdBy: 'AGENT'): LocalTask;
    list(): LocalTask[];
  };
  /** 数据库资产（第十七轮，文档一 6.31）：db_* 工具 */
  databases?: DbService;
  /** 本机笔记（note_list / note_read / note_save） */
  notes?: {
    list(): Note[];
    find(idOrTitle: string): Note | null;
    save(id: string | null, input: NoteInput): Note;
    groups: { list(): LibraryGroup[]; save(id: string | null, name: string): string };
  };
  /**
   * 后台录像（第二十六轮）：没有打开终端时 Agent 在独立通道执行的命令，按「对话 + 主机」录进一段 kind=agent 的录像，
   * 在「审计&回放」里可以回放和 AI 汇总。返回 null 表示不录（关闭了录像，或者这台主机关闭了录像）
   */
  recordings?: { start(meta: { sessionId: string; kind: 'agent'; hostId: string | null; hostName: string; username?: string | null; cols: number; rows: number }): Recorder | null };
  now?: () => number;
}

/** 后台录像空闲多久后结束（之后再执行命令会开一段新的） */
const BG_RECORDING_IDLE_MS = 10 * 60_000;

interface Target {
  label: string;
  ref: AgentTerminalRef;
  host: Host | null;
  name: string;
}

/**
 * 工具网关（文档一 5.2）：Agent 的所有工具调用都在主进程里经过这里——风险判定和策略（审批引擎）、
 * 用户审批、执行、审计。模型给出的参数里的 HOST_IP_n 在这里还原；返回给模型的内容先脱敏，再放进 <untrusted>。
 */
/**
 * ask_user 的选项（第二十六轮）：字符串或 {label, description}，最多 8 个，去掉空的和重复的。
 * 返回选项文字和对应的说明（没有说明是空字符串）
 */
export function askOptions(raw: unknown): { options: string[]; details: string[] } {
  const options: string[] = [];
  const details: string[] = [];
  for (const o of Array.isArray(raw) ? raw : []) {
    const label = (typeof o === 'string' ? o : o && typeof o === 'object' ? String((o as { label?: unknown }).label ?? '') : String(o ?? '')).trim();
    if (!label || options.includes(label)) continue;
    const desc = o && typeof o === 'object' ? String((o as { description?: unknown }).description ?? '').trim() : '';
    options.push(label.slice(0, 200));
    details.push(desc.slice(0, 300));
    if (options.length >= 8) break;
  }
  return { options, details };
}

/** 不需要审批、只读的工具：同一轮里可以和其他调用并行执行 */
const PARALLEL_READ_TOOLS = new Set(['read_terminal', 'get_metrics', 'host_list', 'kb_search', 'skill_load', 'schedule_list', 'note_list', 'note_read', 'web_search', 'web_fetch']);

export class ToolGateway {
  /** AI 自动审批的结论（同一个对话里同样的命令只问一次） */
  private readonly aiVerdicts = new Map<string, { v: { auto: boolean; reason: string } | null; at: number }>();
  /** 每个对话里联网搜索返回过（或用户批准过）的网址和域名：自己拼出来的网址要先批准（第三十二轮） */
  private readonly webSeen = new Map<string, { urls: Set<string>; domains: Set<string> }>();
  private readonly now: () => number;

  constructor(private readonly d: GatewayDeps) {
    this.now = d.now ?? Date.now;
  }

  /**
   * 这个调用能不能和同一轮里的其他调用并行执行（第三十一轮）：按规则判定是只读、不需要等用户（审批 / 确认 / 远程审批）的调用才并行；
   * 参数错误、目标不存在、被策略直接拒绝这些马上返回错误的也算。
   */
  async parallelSafe(rawCall: ToolCall, ctx: ToolContext): Promise<boolean> {
    if (rawCall.argsError || (ctx.allowedTools && !ctx.allowedTools.includes(rawCall.name)) || (ctx.mode === 'ask' && !ASK_TOOLS.has(rawCall.name))) return true;
    if (PARALLEL_READ_TOOLS.has(rawCall.name)) return true;
    const call: ToolCall = { ...rawCall, args: ctx.masker.restoreArgs(rawCall.args) };
    const noWait = (ev: Evaluation): boolean => ev.decision === 'AUTO' || ev.decision === 'DENY';
    if (call.name === 'sftp_list' || call.name === 'sftp_read') {
      const t = this.target(call, ctx);
      if (typeof t === 'string' || ctx.mode === 'ask') return true;
      return noWait(this.evaluateFixed('L0', '读取', t, ctx));
    }
    if (call.name !== 'run_command') return false;
    const t = this.target(call, ctx);
    const command = String(call.args.command ?? '').trim();
    if (typeof t === 'string' || ctx.mode === 'ask' || !command) return true;
    if (t.ref.kind !== 'local' && t.host?.protocol !== 'SSH') return true;
    // 只按规则判定（不调用 AI 复核）。复杂的只读命令执行时仍会复核，万一被提高成写操作，只是这一条单独等用户批准
    const base = this.policyContext(t, ctx.policyCap, ctx.unattended, ctx.external ? undefined : ctx.chatPolicy);
    if (this.d.approval.classify(command).level !== 'L0') return false;
    if (this.aiDenied(t)) return true;
    const ev = await this.d.approval.evaluate(command, base, { autoReadonly: this.d.settings.get('ai.autoApproveReadonly') });
    return noWait(this.externalDecision(ev, ctx));
  }

  async execute(rawCall: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    if (rawCall.argsError) return this.error(rawCall, rawCall.argsError);
    // 联网工具的参数要发到外面：不还原 HOST_IP_n（见 webSearch）
    const call: ToolCall = WEB_TOOL_NAMES.has(rawCall.name) ? rawCall : { ...rawCall, args: ctx.masker.restoreArgs(rawCall.args) };
    if (ctx.allowedTools && !ctx.allowedTools.includes(call.name)) return this.error(call, `这个 Skill 不允许使用工具 ${call.name}`);
    // Ask 模式按白名单拦截（Ask 轮次本来就只把这些工具发给模型；模型自己编出别的工具名也执行不了）
    if (ctx.mode === 'ask' && !ASK_TOOLS.has(call.name))
      return this.error(
        call,
        call.name.startsWith('db_') ? 'Ask 模式不能执行 SQL。请把 SQL 作为建议告诉用户（放在 ```sql 代码块里）。' : `当前是 Ask 模式，不能使用 ${call.name}（只能读取上下文）。需要执行的命令请作为建议告诉用户。`,
      );
    try {
      switch (call.name) {
        case 'run_command':
          return await this.runCommand(call, ctx);
        case 'ssh_exec_batch':
          return await this.batch(call, ctx);
        case 'read_terminal':
          return this.readTerminal(call, ctx);
        case 'get_metrics':
          return this.metrics(call, ctx);
        case 'host_list':
          return this.hostList(call, ctx);
        case 'sftp_list':
        case 'sftp_read':
          return await this.sftpRead(call, ctx);
        case 'sftp_write':
          return await this.sftpWrite(call, ctx);
        case 'file_upload':
          return await this.fileUpload(call, ctx);
        case 'file_download':
          return await this.fileDownload(call, ctx);
        case 'serial_send':
          return await this.serial(call, ctx);
        case 'kb_search':
          return await this.kb(call, ctx);
        case 'skill_load':
          return this.skillLoad(call);
        case 'mcp_call':
          return await this.mcp(call, ctx);
        case 'ask_user':
          return await this.askUser(call, ctx);
        case 'memory_propose':
          return await this.memory(call, ctx);
        case 'schedule_task':
          return await this.scheduleTask(call, ctx);
        case 'schedule_list':
          return this.scheduleList(call);
        case 'note_list':
          return this.noteList(call);
        case 'note_read':
          return this.noteRead(call, ctx);
        case 'note_save':
          return this.noteSave(call, ctx);
        case 'skill_save':
          return await this.skillSave(call, ctx);
        case 'db_schema':
        case 'db_describe':
        case 'db_query':
        case 'db_explain':
        case 'db_execute':
          return await this.database(call, ctx);
        case 'web_search':
          return await this.webSearch(call, ctx);
        case 'web_fetch':
          return await this.webFetch(call, ctx);
        default:
          return this.error(call, `未知的工具 ${call.name}`);
      }
    } catch (e) {
      return this.error(call, `执行失败：${(e as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- 通用

  private step(call: ToolCall, label: string, hostName: string, command: string): AgentStep {
    const explanation = typeof call.args.explanation === 'string' ? call.args.explanation.trim().slice(0, 500) : '';
    return {
      id: call.id,
      tool: call.name,
      hostLabel: label,
      hostName,
      command,
      ...(explanation ? { explanation } : {}),
      level: null,
      reasons: [],
      status: 'running',
      exitCode: null,
      output: '',
      startedAt: this.now(),
      finishedAt: null,
    };
  }

  private error(call: ToolCall, message: string, step?: Partial<AgentStep>): ToolResultRecord {
    return {
      callId: call.id,
      name: call.name,
      content: message,
      isError: true,
      step: {
        ...this.step(call, String(call.args.host ?? call.args.db ?? ''), '', String(call.args.command ?? call.args.path ?? call.args.sql ?? '')),
        status: 'error',
        output: message,
        startedAt: null,
        finishedAt: this.now(),
        ...step,
      },
    };
  }

  private result(call: ToolCall, step: AgentStep, content: string, isError = false): ToolResultRecord {
    return { callId: call.id, name: call.name, content, isError, step: { ...step } };
  }

  private target(call: ToolCall, ctx: ToolContext, label = String(call.args.host ?? '').trim()): Target | string {
    const ref = ctx.targets[label];
    if (!ref) return `目标「${label}」不在本轮的引用里，可用的编号：${Object.keys(ctx.targets).join('、') || '（无）'}`;
    const host = ref.hostId ? this.d.hosts.get(ref.hostId) : null;
    if (ref.hostId && !host) return `主机 ${label} 已被删除`;
    return { label, ref, host, name: ref.kind === 'local' ? '本机' : (host?.name ?? ref.title) };
  }

  /**
   * 主机的策略上下文（有效 Agent 权限、生产环境、命令黑名单）。
   * 对话里调整了权限（chat）时替换主机的 Agent 权限——团队主机只能收紧；Skill 的上限、黑名单、生产环境等照常生效
   */
  private policyContext(t: Target, cap?: AgentPolicy, un?: ToolContext['unattended'], chat?: ChatPolicy): EvaluateContext {
    const base = this.d.policy();
    // 无人值守：任务的权限上限作为 unattendedCap（超出上限的写操作转为远程审批）
    const policy = un?.cap && AGENT_POLICY_STRICTNESS[un.cap] > AGENT_POLICY_STRICTNESS[base.unattendedCap] ? { ...base, unattendedCap: un.cap } : base;
    const unattended = !!un;
    const strictest = (p: AgentPolicy): AgentPolicy => (cap && AGENT_POLICY_STRICTNESS[cap] > AGENT_POLICY_STRICTNESS[p] ? cap : p);
    const own = un ? null : chatAgentPolicy(chat);
    const withChat = (p: AgentPolicy, team: boolean): AgentPolicy => (!own ? p : team && AGENT_POLICY_STRICTNESS[p] > AGENT_POLICY_STRICTNESS[own] ? p : own);
    if (!t.host) return { agentPolicy: strictest(withChat(this.d.settings.get('ai.defaultAgentPolicy'), false)), production: false, policy, ...(unattended ? { unattended } : {}) };
    const eff = this.d.hosts.effective(t.host.id, null);
    return {
      hostDenylist: t.host.cmdDenylist,
      agentPolicy: strictest(withChat(eff.agentPolicy, !!t.host.team)),
      production: eff.production,
      folderNames: eff.folderPath ? eff.folderPath.split(' / ') : [],
      policy,
      ...(unattended ? { unattended } : {}),
    };
  }

  /** 凭证设置了「禁止 AI 引用」的主机，Agent 不能使用（文档一 6.6） */
  private aiDenied(t: Target): string | null {
    if (!t.host) return null;
    const eff = this.d.hosts.effective(t.host.id, null);
    const cred = eff.credentialId ? this.d.credentials.get(eff.credentialId) : null;
    if (cred?.aiAccess === 'DENY') return `「${t.name}」使用的凭证「${cred.name}」禁止 AI 引用，Agent 不能在这台主机上操作`;
    return null;
  }

  /**
   * 本机终端不能访问 iTerminal 自己的本机 MCP 接口（第三十二轮）：那个接口上的工具按设置里的权限执行，
   * 不走对话里的审批卡片，令牌又可能明文存在外部 Agent 的配置文件里——一条命令就能绕开本轮的引用范围和审批。
   * 只在 MCP 服务开着的时候拦（没开时端口可能是用户自己的服务）。
   */
  private localControlDenied(t: Target, command: string): string | null {
    if (t.ref.kind !== 'local') return null;
    if (!this.d.settings.get('mcp.server.enabled')) return null;
    const port = this.d.settings.get('mcp.server.port');
    if (!referencesLocalPort(command, port)) return null;
    return `这条命令访问了 iTerminal 自己的本机 MCP 接口（端口 ${port}）。那个接口不走对话里的审批，不能从命令里调用；需要在别的主机上操作时，请让用户先把主机引用进来`;
  }

  /**
   * 外部 Agent（MCP）：审批类的决定换成按勾选的权限直接执行或拒绝。只看命令本身的风险（生产环境把只读提到写操作只影响审批），
   * 被禁止的（黑名单、主机权限、夜间窗口…）照旧拒绝；命中黑名单但设置成「输入主机名确认」的，外部 Agent 没法确认，也拒绝。
   */
  private externalDecision(ev: Evaluation, ctx: ToolContext): Evaluation {
    const ext = ctx.external;
    if (!ext || ev.decision === 'DENY') return ev;
    const deny = (reason: string): Evaluation => ({ ...ev, effectiveLevel: 'DENY', decision: 'DENY', reasons: [...ev.reasons, reason] });
    if (ev.level === 'DENY') return deny('命中命令黑名单，外部 Agent 不能执行');
    if (ev.level === 'L2' && !(ext.allowWrite && ext.allowDanger)) return deny(EXTERNAL_NO_DANGER);
    if (ev.level === 'L1' && !ext.allowWrite) return deny(EXTERNAL_NO_WRITE);
    return { ...ev, decision: 'AUTO', reasons: [...ev.reasons, ev.level === 'L0' ? '外部 Agent：只读命令直接执行' : '外部 Agent：已在设置里开放这个权限，直接执行'] };
  }

  private async evaluate(command: string, t: Target, ctx: ToolContext): Promise<Evaluation> {
    const base = this.policyContext(t, ctx.policyCap, ctx.unattended, ctx.external ? undefined : ctx.chatPolicy);
    // 外部 Agent：高危命令按「允许高危指令」决定，不按自己 Agent 的「高危命令直接拒绝」设置
    const pctx = ctx.external ? { ...base, policy: { ...base.policy, security: { ...(base.policy.security ?? DEFAULT_SECURITY), l2Decision: 'APPROVE' as const } } } : base;
    const reviewer =
      this.d.settings.get('ai.llmReview') && ctx.reviewModel
        ? (cmd: string, c: Classification) => this.d.runtime.review(ctx.reviewModel!, cmd, c.level, c.reasons)
        : undefined;
    const denied = this.aiDenied(t) ?? this.localControlDenied(t, command);
    const ev = await this.d.approval.evaluate(command, pctx, { autoReadonly: this.d.settings.get('ai.autoApproveReadonly'), reviewer });
    if (denied) return this.externalDecision({ ...ev, effectiveLevel: 'DENY', decision: 'DENY', reasons: [...ev.reasons, denied] }, ctx);
    return this.afterReject(this.externalDecision(await this.aiApprove(command, t.host ? `主机：${t.name}（${t.host.osInfo ?? '系统未知'}）` : '主机：本机', ev, pctx, ctx), ctx), t, ctx);
  }

  /**
   * AI 自动审批（第十四轮；有效 Agent 权限是「AI 自动审批」——对话里选的，或者主机 / 分组 / 设置里的）：规则引擎要人工批准 / 确认的命令
   * 先交给快速模型判断，判断安全时直接执行，有风险、判断失败或超时时照常请用户批准。命中黑名单（需要输入主机名确认）和生产环境的命令不交给 AI。
   */
  private async aiApprove(command: string, subject: string, ev: Evaluation, pctx: EvaluateContext, ctx: ToolContext, kind = '命令'): Promise<Evaluation> {
    if (pctx.agentPolicy !== 'AI_REVIEW' || ctx.unattended || ctx.external) return ev;
    if (ev.decision !== 'APPROVE' && ev.decision !== 'CONFIRM') return ev;
    const production = pctx.production || (pctx.folderNames ?? []).some((n) => pctx.policy.prodFolderNames.includes(n));
    if (ev.level === 'DENY') return { ...ev, reasons: [...ev.reasons, 'AI 审批：命中黑名单的命令需要你亲自确认'] };
    if (production) return { ...ev, reasons: [...ev.reasons, 'AI 审批：生产环境的写操作需要你亲自批准'] };
    if (!ctx.reviewModel) return { ...ev, reasons: [...ev.reasons, 'AI 审批：没有可用的模型，需要你批准'] };
    const text = `${subject}\n${kind}：\n${ctx.masker.mask(command).text}\n\n规则引擎判定：${ev.effectiveLevel}（${ev.reasons.join('；') || '无'}）`;
    // 同一个对话里同样的命令（批量执行的多台主机、改了又改回来）只问一次
    const key = `${ctx.conversationId}\u0000${ev.effectiveLevel}\u0000${command}`;
    const hit = this.aiVerdicts.get(key);
    try {
      let v = hit && hit.at > this.now() - 10 * 60_000 ? hit.v : undefined;
      if (v === undefined) {
        const r = await this.d.runtime.call(
          ctx.reviewModel,
          { system: AUTO_APPROVE_PROMPT, messages: [{ role: 'user', mode: 'ask', blocks: [{ kind: 'question', text }] }], tools: [] },
          AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
        );
        v = parseAutoApprove(r.text);
        if (this.aiVerdicts.size > 500) this.aiVerdicts.clear();
        this.aiVerdicts.set(key, { v, at: this.now() });
      }
      if (v?.auto) return { ...ev, decision: 'AUTO', reasons: [...ev.reasons, `AI 自动审批通过：${v.reason || '判断为常规操作'}`] };
      return { ...ev, reasons: [...ev.reasons, v ? `AI 判断需要你批准：${v.reason || '有风险'}` : 'AI 审批没有给出明确结论，需要你批准'] };
    } catch (e) {
      return { ...ev, reasons: [...ev.reasons, `AI 审批失败（${(e as Error).message.slice(0, 80)}），需要你批准`] };
    }
  }

  /** 非命令类操作（读写文件）按固定等级走策略 */
  private evaluateFixed(level: 'L0' | 'L1' | 'L2', reason: string, t: Target, ctx: ToolContext): Evaluation {
    const c: Classification = { level, reasons: [reason], matchedRules: [], segments: [], complex: false, parseError: false };
    // 文件读写：「AI 自动审批」按「需要审批」处理（applyPolicy 把 AI_REVIEW 当作 APPROVE，这里不交给 AI 判断）
    const base = this.policyContext(t, ctx.policyCap, ctx.unattended, ctx.external ? undefined : ctx.chatPolicy);
    const pctx = ctx.external ? { ...base, policy: { ...base.policy, security: { ...(base.policy.security ?? DEFAULT_SECURITY), l2Decision: 'APPROVE' as const } } } : base;
    const ev = applyPolicy(c, '', pctx, this.d.settings.get('ai.autoApproveReadonly'));
    const denied = this.aiDenied(t);
    return this.afterReject(this.externalDecision(denied ? { ...ev, effectiveLevel: 'DENY', decision: 'DENY', reasons: [...ev.reasons, denied] } : ev, ctx), t, ctx);
  }

  /** 这一轮被拒绝过的主机：自动执行的写操作改成要用户亲自批准 */
  private afterReject(ev: Evaluation, t: Target, ctx: ToolContext): Evaluation {
    if (!ctx.turn?.rejected.has(t.label) || ev.decision !== 'AUTO' || ev.effectiveLevel === 'L0') return ev;
    return { ...ev, decision: 'APPROVE', reasons: [...ev.reasons, '这一轮你拒绝过这台主机上的操作：之后的写操作都需要你亲自批准'] };
  }

  /** 这台主机执行了写操作：之前缓存的只读结果作废 */
  private touched(t: Target, ctx: ToolContext): void {
    if (!ctx.turn) return;
    for (const k of [...ctx.turn.reads.keys()]) if (k.startsWith(`${t.label}\u0000`)) ctx.turn.reads.delete(k);
  }

  private applyEval(step: AgentStep, ev: Evaluation): void {
    step.level = ev.effectiveLevel;
    step.reasons = ev.reasons;
    step.decision = ev.decision;
    step.reviewed = ev.reviewed ? `AI 复核把风险从 ${ev.reviewed.from} 提高到 ${ev.reviewed.to}：${ev.reviewed.reason}` : undefined;
  }

  /**
   * 按决定等待用户：AUTO 直接通过；APPROVE 单击批准；CONFIRM 输入确认文字；DENY / REMOTE 拒绝。
   * 返回 null 表示可以执行，否则是拒绝的原因（已写入 step）。
   */
  private async gate(step: AgentStep, ctx: ToolContext, confirmText: string, reevaluate?: (cmd: string) => Promise<Evaluation>): Promise<string | null> {
    for (;;) {
      // 无人值守：写操作向服务端发起远程审批，等审批人处理
      if (step.decision === 'REMOTE' && ctx.unattended) {
        const label = ctx.unattended.label ?? '远程审批';
        // 本机定时任务：审批引擎给出的「需要远程审批」改成实际的说法
        if (ctx.unattended.label) step.reasons = step.reasons.map((r) => r.replace(/远程审批/g, label));
        step.status = 'approval';
        step.output = `等待${label}…`;
        ctx.ui.update();
        const ok = await ctx.unattended.approve(step).catch(() => false);
        if (ok && !ctx.signal.aborted) {
          step.output = '';
          step.status = 'running';
          return null;
        }
        step.status = 'rejected';
        step.finishedAt = this.now();
        step.output = `${label}没有通过（被拒绝或已过期）`;
        return `${label}没有通过，这条命令没有执行。不要换一种写法绕过；继续做能做的部分，并在最后的总结里写明这一步没有执行、需要人工处理。`;
      }
      if (step.decision === 'DENY' || step.decision === 'REMOTE') {
        step.status = 'rejected';
        step.finishedAt = this.now();
        step.output = `被策略拒绝：${step.reasons.join('；')}`;
        return `${step.output}。不要换一种写法绕过，请把原因告诉用户。`;
      }
      if (step.decision === 'AUTO') return null;
      step.confirmText = step.decision === 'CONFIRM' ? confirmText : undefined;
      const resp = await ctx.ui.wait(step);
      step.approvalId = undefined;
      if (resp.decision === 'reject' || ctx.signal.aborted) {
        if (!ctx.signal.aborted) ctx.turn?.rejected.add(step.hostLabel);
        step.status = 'rejected';
        step.finishedAt = this.now();
        step.output = '用户拒绝执行';
        return '用户拒绝执行。不要换一种写法重试，请用 ask_user 询问用户下一步怎么做。';
      }
      const edited = resp.command?.trim();
      if (reevaluate && edited && edited !== step.command) {
        // 用户修改了命令：按新命令重新判定；变得更严格（需要确认 / 被禁止）时重新走一遍
        const before = step.decision;
        step.command = edited;
        this.applyEval(step, await reevaluate(edited));
        const after = step.decision as AgentStep['decision'];
        if (after === 'DENY' || (after === 'CONFIRM' && before !== 'CONFIRM')) continue;
      }
      if (step.decision === 'CONFIRM' && resp.confirmText?.trim() !== confirmText) {
        step.status = 'rejected';
        step.finishedAt = this.now();
        step.output = '高危操作没有通过确认';
        return '高危操作没有通过用户确认，已取消。';
      }
      return null;
    }
  }

  /**
   * 执行 Agent 的命令：标准输入立即关闭（等待输入的命令马上结束，不会卡到超时）；连续 idleTimeoutMs 没有输出就终止；
   * 停止时立即返回（第十三轮）
   */
  private async exec(t: Target, command: string, timeoutMs: number, ctx: ToolContext, idleTimeoutMs = 0): Promise<ExecResult> {
    if (t.ref.kind === 'local') return this.d.runLocal(command, timeoutMs, ctx.signal, idleTimeoutMs);
    if (!t.host || t.host.protocol !== 'SSH') throw new Error(`${t.name} 不是 SSH 主机，不能执行命令${t.host?.protocol === 'SERIAL' || t.host?.protocol === 'TELNET' ? '（串口 / Telnet 设备请用 serial_send）' : ''}`);
    const conn = await this.d.pool.acquire(t.host.id, ctx.owner);
    try {
      return await execCommand(conn.client, command, { timeoutMs, maxBytes: 256 * 1024, signal: ctx.signal, idleTimeoutMs, closeStdin: true });
    } finally {
      this.d.pool.release(conn);
    }
  }

  /** 在对应的终端里显示一行提示（只在本机界面上显示，不发给远端） */
  private echo(t: Target, ctx: ToolContext, text: string, tone: 'info' | 'ok' | 'fail' = 'info'): void {
    if (!t.ref.sessionId || !this.d.settings.get('ai.echoToTerminal')) return;
    const info = this.d.sessions.info(t.ref.sessionId);
    if (!info || info.owner !== ctx.owner) return;
    const color = tone === 'ok' ? '2;32' : tone === 'fail' ? '2;31' : '2;35';
    // 结果行紧跟在「执行：」后面，不再空一行
    const lead = tone === 'info' ? '\r\n' : '';
    this.d.emit(ctx.owner, 'session.data', { sessionId: t.ref.sessionId, data: `${lead}\x1b[${color}m✦ Agent ${text}\x1b[0m\r\n` });
  }

  /**
   * 把 Agent 执行的命令和输出写进这台主机已打开终端的会话录像（只写录像，不显示在终端里）：
   * 引用的终端优先，否则用这台主机最近有输出的终端；没有打开终端时不记录。
   */
  private record(t: Target, ctx: ToolContext, command: string, r: ExecResult): void {
    const sessionId = t.ref.sessionId ?? (t.host ? this.d.sessions.sessionForHost(t.host.id, ctx.owner) : null);
    const time = new Date(this.now()).toLocaleTimeString('zh-CN', { hour12: false });
    const out = clip(r.stdout + (r.stderr ? `${r.stdout && !r.stdout.endsWith('\n') ? '\n' : ''}${r.stderr}` : ''), 64 * 1024).replace(/\r?\n/g, '\r\n');
    const result = r.code === 0 ? '执行成功' : r.timedOut ? '超时被终止' : `执行失败（退出码 ${r.code ?? '无'}）`;
    const text = `\r\n\x1b[1;35m✦ Agent\x1b[0m\x1b[2m ${time} · ${t.name}\x1b[0m\r\n\x1b[1m$ ${command.replace(/\r?\n/g, '\r\n  ')}\x1b[0m\r\n${out}${out && !out.endsWith('\r\n') ? '\r\n' : ''}\x1b[2m[${result}]\x1b[0m\r\n`;
    if (sessionId) {
      this.d.sessions.appendRecording(sessionId, text);
      return;
    }
    // 没有打开终端：录进这个对话在这台主机上的后台录像（第二十六轮）
    this.background(t, ctx)?.rec.output(text);
  }

  /** 对话 + 主机 → 正在录的后台录像 */
  private readonly bg = new Map<string, { rec: Recorder; timer: ReturnType<typeof setTimeout> }>();
  private bgKey(t: Target, ctx: ToolContext): string | null {
    return t.host && ctx.conversationId ? `agent:${ctx.conversationId}:${t.host.id}` : null;
  }
  /** 取得（没有时开始）后台录像；空闲 10 分钟后结束 */
  private background(t: Target, ctx: ToolContext): { rec: Recorder } | null {
    const key = this.bgKey(t, ctx);
    if (!key || !t.host || !this.d.recordings) return null;
    let b = this.bg.get(key);
    if (!b) {
      const rec = this.d.recordings.start({ sessionId: key, kind: 'agent', hostId: t.host.id, hostName: t.host.name, username: t.host.username || null, cols: 120, rows: 32 });
      if (!rec) return null;
      rec.output(`\x1b[2m[Agent 后台会话：没有打开终端时 Agent 通过独立通道在 ${t.host.name} 上执行的命令]\x1b[0m\r\n`);
      b = { rec, timer: setTimeout(() => undefined, 0) };
      this.bg.set(key, b);
    }
    clearTimeout(b.timer);
    b.timer = setTimeout(() => this.endBackground(key), BG_RECORDING_IDLE_MS);
    b.timer.unref?.();
    return b;
  }
  private endBackground(key: string): void {
    const b = this.bg.get(key);
    if (!b) return;
    clearTimeout(b.timer);
    b.rec.end();
    this.bg.delete(key);
  }
  /** 结束一个对话的后台录像（删除对话、退出时） */
  endBackgroundRecordings(conversationId?: string): void {
    for (const key of [...this.bg.keys()]) if (!conversationId || key.startsWith(`agent:${conversationId}:`)) this.endBackground(key);
  }

  private audit(t: Target, command: string, step: AgentStep, decision: 'AUTO' | 'APPROVED' | 'REJECTED' | 'DENIED', ctx: ToolContext, exitCode?: number | null): void {
    this.d.audit.command({
      source: ctx.auditSource ?? 'AGENT',
      hostId: t.host?.id ?? null,
      hostName: t.name,
      // 后台执行的命令记在后台录像的会话上，回放时右侧的命令列表能列出来
      sessionId: t.ref.sessionId ?? (this.bg.has(this.bgKey(t, ctx) ?? '') ? this.bgKey(t, ctx) : null),
      command,
      risk: step.level,
      decision,
      exitCode: exitCode ?? null,
      detail: { conversationId: ctx.conversationId, tool: step.tool, reasons: step.reasons, ...(step.explanation ? { explanation: step.explanation } : {}) },
    });
  }

  private format(output: string, ctx: ToolContext, max = MAX_TOOL_OUTPUT): string {
    const text = stripAnsi(output).trim();
    return text ? untrusted(ctx.masker.mask(clip(text, max)).text) : '（没有输出）';
  }

  // ---------------------------------------------------------------- 执行命令

  private async runCommand(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能执行命令。请把命令作为建议告诉用户。', { hostName: t.name });
    const command = String(call.args.command ?? '').trim();
    if (!command) return this.error(call, '命令为空', { hostName: t.name });
    // 交互式 / 不会结束的命令：执行前直接退回并给出改法，不用等到 30 秒没输出才被终止
    const stuck = t.ref.kind === 'ssh' || t.ref.kind === 'local' ? blockingReason(command) : null;
    if (stuck) return this.error(call, `没有执行：${stuck}。`, { hostName: t.name });
    const timeoutSec = Math.min(Math.max(Number(call.args.timeout_sec) || 60, 1), 600);
    const idleSec = idleSecOf(call, timeoutSec);
    const step: AgentStep = { ...this.step(call, t.label, t.name, command), status: 'pending' };
    ctx.ui.add(step);
    this.applyEval(step, await this.evaluate(command, t, ctx));
    ctx.ui.update();
    // 同一轮里已经执行过的只读命令（中间没有写操作）：直接复用结果
    const readKey = `${t.label}\u0000${command}`;
    const prev = step.level === 'L0' && step.decision === 'AUTO' ? ctx.turn?.reads.get(readKey) : undefined;
    if (prev && this.now() - prev.at < READ_REUSE_MS) {
      const secs = Math.max(1, Math.round((this.now() - prev.at) / 1000));
      step.status = prev.isError ? 'error' : 'done';
      step.finishedAt = this.now();
      step.output = `这一轮 ${secs} 秒前已经执行过，复用当时的结果（没有重新执行）`;
      ctx.ui.update();
      return this.result(call, step, `（这条命令这一轮 ${secs} 秒前已经执行过，主机上也没有执行过写操作，下面是当时的结果，没有重新执行。要等待状态变化后再看，用 sleep 秒数 && 命令。）\n${prev.content}`, prev.isError);
    }
    const blocked = await this.gate(step, ctx, t.name, (cmd) => this.evaluate(cmd, t, ctx));
    const approvedBy = step.decision === 'AUTO' ? 'AUTO' : 'APPROVED';
    if (blocked) {
      this.audit(t, step.command, step, step.output === '用户拒绝执行' || step.output === '高危操作没有通过确认' ? 'REJECTED' : 'DENIED', ctx);
      ctx.ui.update();
      return this.result(call, step, blocked, true);
    }
    const cmd = step.command;
    step.status = 'running';
    step.startedAt = this.now();
    ctx.ui.update();
    this.echo(t, ctx, `执行：${cmd}`);
    let r: ExecResult;
    try {
      r = await this.exec(t, cmd, timeoutSec * 1000, ctx, idleSec * 1000);
    } catch (e) {
      step.status = 'error';
      step.finishedAt = this.now();
      step.output = (e as Error).message;
      this.audit(t, cmd, step, approvedBy, ctx);
      return this.result(call, step, `执行失败：${(e as Error).message}`, true);
    }
    const why = endReason(r, timeoutSec, idleSec);
    this.record(t, ctx, cmd, r);
    const combined = r.stdout + (r.stderr ? `${r.stdout ? '\n' : ''}[stderr]\n${r.stderr}` : '');
    step.status = r.code === 0 ? 'done' : 'error';
    step.exitCode = r.code;
    step.finishedAt = this.now();
    step.output = clip(stripAnsi(combined), 20_000) + (why ? `\n（${why}）` : '');
    this.audit(t, cmd, step, approvedBy, ctx, r.code);
    // 终端里只显示一行结果（第二十六轮）：成功 / 失败（原因）· 耗时；输出在对话里
    const secs = `${((step.finishedAt - (step.startedAt ?? step.finishedAt)) / 1000).toFixed(1)}s`;
    if (r.code === 0) this.echo(t, ctx, `执行成功 · ${secs}`, 'ok');
    else this.echo(t, ctx, `${r.aborted ? '已停止' : `执行失败（${why ?? `退出码 ${r.code ?? '无'}`}）`} · ${secs}`, 'fail');
    const content =
      `主机 ${t.label}（${t.name}）执行：${cmd}\n退出码：${r.code ?? '无（被终止）'}${why ? `（${why}）` : ''}${r.truncated ? '（输出过长已截断）' : ''}\n` +
      (r.idle ? `${IDLE_HINT}\n` : '') +
      this.format(combined, ctx);
    if (ctx.turn) {
      if (step.level === 'L0' && cmd === command && !r.idle && !r.timedOut && !r.aborted) ctx.turn.reads.set(readKey, { content, isError: r.code !== 0, at: this.now() });
      else if (step.level !== 'L0') this.touched(t, ctx);
    }
    return this.result(call, step, content, r.code !== 0);
  }

  /** 多台主机并行执行同一条命令：写操作合并成一张审批卡片，可以逐台勾选（文档一 7.6） */
  private async batch(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能执行命令。');
    const labels = Array.isArray(call.args.hosts) ? [...new Set(call.args.hosts.map(String))] : [];
    const command = String(call.args.command ?? '').trim();
    if (labels.length === 0 || !command) return this.error(call, '需要 hosts 和 command');
    const stuck = blockingReason(command);
    if (stuck) return this.error(call, `没有执行：${stuck}。`);
    if (labels.length > 100) return this.error(call, '一次最多 100 台主机');
    const timeoutSec = Math.min(Math.max(Number(call.args.timeout_sec) || 60, 1), 600);
    const targets: Target[] = [];
    const items: BatchItem[] = [];
    for (const label of labels) {
      const t = this.target(call, ctx, label);
      if (typeof t === 'string') {
        items.push({ label, hostName: label, level: null, decision: 'DENY', reasons: [t], selected: false, status: 'skipped', exitCode: null, output: t });
        continue;
      }
      targets.push(t);
      const ev = await this.evaluate(command, t, ctx);
      items.push({
        label,
        hostName: t.name,
        level: ev.effectiveLevel,
        decision: ev.decision,
        reasons: ev.reasons,
        selected: ev.decision !== 'DENY' && ev.decision !== 'REMOTE',
        status: ev.decision === 'DENY' || ev.decision === 'REMOTE' ? 'skipped' : 'pending',
        exitCode: null,
        output: ev.decision === 'DENY' || ev.decision === 'REMOTE' ? `被策略拒绝：${ev.reasons.join('；')}` : '',
      });
    }
    const step: AgentStep = { ...this.step(call, labels.join(','), `${labels.length} 台主机`, command), status: 'pending', batch: items };
    const runnable = items.filter((i) => i.selected);
    const rank = { L0: 0, L1: 1, L2: 2, DENY: 3 } as const;
    step.level = runnable.reduce<AgentStep['level']>((acc, i) => (i.level && (!acc || rank[i.level] > rank[acc]) ? i.level : acc), null);
    step.decision = runnable.some((i) => i.decision === 'CONFIRM') ? 'CONFIRM' : runnable.some((i) => i.decision === 'APPROVE') ? 'APPROVE' : runnable.length ? 'AUTO' : 'DENY';
    step.reasons = [...new Set(runnable.flatMap((i) => i.reasons))];
    ctx.ui.add(step);
    if (runnable.length === 0) {
      step.status = 'rejected';
      step.output = '所有主机都被策略拒绝';
      step.finishedAt = this.now();
      ctx.ui.update();
      return this.result(call, step, `没有可以执行的主机：\n${items.map((i) => `${i.label}：${i.output}`).join('\n')}`, true);
    }
    if (step.decision !== 'AUTO') {
      step.confirmText = step.decision === 'CONFIRM' ? '确认执行' : undefined;
      const resp = await ctx.ui.wait(step);
      step.approvalId = undefined;
      if (resp.decision === 'reject' || ctx.signal.aborted || (step.decision === 'CONFIRM' && resp.confirmText?.trim() !== '确认执行')) {
        step.status = 'rejected';
        step.output = '用户拒绝执行';
        step.finishedAt = this.now();
        for (const i of items) if (i.status === 'pending') i.status = 'skipped';
        for (const t of targets) this.audit(t, command, step, 'REJECTED', ctx);
        if (!ctx.signal.aborted) for (const t of targets) ctx.turn?.rejected.add(t.label);
        ctx.ui.update();
        return this.result(call, step, '用户拒绝执行这次批量操作。请询问用户下一步怎么做。', true);
      }
      if (resp.hosts) {
        const chosen = new Set(resp.hosts);
        for (const i of items) {
          if (i.status === 'pending' && !chosen.has(i.label)) {
            i.selected = false;
            i.status = 'skipped';
            i.output = '用户没有勾选';
          }
        }
      }
    }
    step.status = 'running';
    step.startedAt = this.now();
    ctx.ui.update();
    const queue = items.filter((i) => i.status === 'pending');
    const worker = async (): Promise<void> => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const t = targets.find((x) => x.label === item!.label)!;
        if (ctx.signal.aborted) {
          item.status = 'skipped';
          item.output = '用户已停止';
          continue;
        }
        item.status = 'running';
        ctx.ui.update();
        try {
          const r = await this.exec(t, command, timeoutSec * 1000, ctx, idleSecOf(call, timeoutSec) * 1000);
          this.record(t, ctx, command, r);
          const why = endReason(r, timeoutSec, idleSecOf(call, timeoutSec));
          item.exitCode = r.code;
          item.status = r.code === 0 ? 'done' : 'error';
          item.output = clip(stripAnsi(r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')), 8000) + (why ? `\n（${why}）` : '');
          this.audit(t, command, step, item.decision === 'AUTO' ? 'AUTO' : 'APPROVED', ctx, r.code);
        } catch (e) {
          item.status = 'error';
          item.output = (e as Error).message;
        }
        ctx.ui.update();
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, worker));
    step.finishedAt = this.now();
    const failed = items.filter((i) => i.status === 'error').length;
    step.status = failed ? 'error' : 'done';
    step.output = `${items.filter((i) => i.status === 'done').length} 台成功，${failed} 台失败，${items.filter((i) => i.status === 'skipped').length} 台跳过`;
    const per = Math.max(1000, Math.floor(MAX_TOOL_OUTPUT / items.length));
    const content =
      `批量执行：${command}\n${step.output}\n\n` +
      items.map((i) => `== ${i.label}（${i.hostName}）${i.status === 'skipped' ? `跳过：${i.output}` : `退出码 ${i.exitCode ?? '无'}`} ==\n${i.status === 'skipped' ? '' : this.format(i.output, ctx, per)}`).join('\n');
    return this.result(call, step, content, failed > 0);
  }

  // ---------------------------------------------------------------- 数据库（第十七轮，文档一 6.31）

  private dbTarget(call: ToolCall, ctx: ToolContext): { label: string; asset: DbAsset } | string {
    const label = String(call.args.db ?? '').trim();
    const refs = ctx.databases ?? {};
    const id = refs[label];
    if (!id) {
      const avail = Object.keys(refs);
      return `数据库「${label}」不在本轮的引用里${avail.length ? `，可用的编号：${avail.join('、')}` : '。请让用户在输入框里用 @ 引用要操作的数据库'}`;
    }
    const asset = this.d.databases?.get(id);
    if (!asset) return `数据库 ${label} 已被删除`;
    return { label, asset };
  }

  /**
   * 数据库的策略上下文：数据库的 Agent 权限（没有设置时用全局默认）或对话里选的权限、生产环境；
   * Skill 的权限上限照常生效。SQL 最长 50 KB（不用 shell 命令的长度上限）
   */
  private dbPolicy(asset: DbAsset, ctx: ToolContext, metadata: boolean): EvaluateContext {
    const base = this.d.policy();
    const policy = { ...base, security: { ...(base.security ?? DEFAULT_SECURITY), maxLength: MAX_SQL_BYTES * 2 } };
    const own = ctx.external || ctx.unattended ? null : chatAgentPolicy(ctx.chatPolicy);
    let agentPolicy = own ?? asset.agentPolicy ?? this.d.settings.get('ai.defaultAgentPolicy');
    if (ctx.policyCap && AGENT_POLICY_STRICTNESS[ctx.policyCap] > AGENT_POLICY_STRICTNESS[agentPolicy]) agentPolicy = ctx.policyCap;
    // 元数据不交给 AI 判断（按「需要审批」处理）
    if (metadata && agentPolicy === 'AI_REVIEW') agentPolicy = 'APPROVE';
    // 列出库表、查看表结构不返回数据，生产环境也不用每次批准
    return { agentPolicy, production: asset.production && !metadata, folderNames: [], policy, ...(ctx.unattended ? { unattended: true } : {}) };
  }

  /** SQL 黑名单、凭证「禁止 AI 引用」：命中时拒绝的原因 */
  private dbDenied(asset: DbAsset, sql: string): string | null {
    const cred = this.d.databases?.credentialOf(asset);
    if (cred?.aiAccess === 'DENY') return `「${asset.name}」使用的凭证「${cred.name}」禁止 AI 引用，Agent 不能操作这个数据库`;
    for (const p of asset.sqlDenylist) if (denyPattern(p)?.test(sql)) return `命中这个数据库的 SQL 黑名单（${p}）`;
    return null;
  }

  private async evaluateSql(c: Classification, sql: string, asset: DbAsset, ctx: ToolContext, metadata = false): Promise<Evaluation> {
    const pctx = this.dbPolicy(asset, ctx, metadata);
    const ev = applyPolicy(c, sql, pctx, this.d.settings.get('ai.autoApproveReadonly'));
    const denied = this.dbDenied(asset, sql);
    if (denied) return this.externalDecision({ ...ev, effectiveLevel: 'DENY', decision: 'DENY', reasons: [...ev.reasons, denied] }, ctx);
    if (metadata) return this.externalDecision(ev, ctx);
    const subject = `数据库：${asset.name}（${asset.type === 'MYSQL' ? 'MySQL' : asset.type === 'POSTGRES' ? 'PostgreSQL' : 'SQLite'}${asset.production ? '，生产环境' : ''}）`;
    return this.externalDecision(await this.aiApprove(sql, subject, ev, pctx, ctx, 'SQL'), ctx);
  }

  private dbAudit(asset: DbAsset, sql: string, step: AgentStep, decision: 'AUTO' | 'APPROVED' | 'REJECTED' | 'DENIED', ctx: ToolContext, extra: Record<string, unknown> = {}): void {
    this.d.audit.command({
      source: ctx.auditSource ?? 'AGENT',
      hostId: null,
      hostName: `数据库 · ${asset.name}`,
      sessionId: null,
      command: sql,
      risk: step.level,
      decision,
      exitCode: step.status === 'done' ? 0 : step.status === 'error' ? 1 : null,
      detail: { conversationId: ctx.conversationId, tool: step.tool, dbId: asset.id, dbType: asset.type, reasons: step.reasons, ...(step.explanation ? { explanation: step.explanation } : {}), ...extra },
    });
  }

  private async database(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    if (!this.d.databases) return this.error(call, '当前环境不支持数据库工具');
    const tgt = this.dbTarget(call, ctx);
    if (typeof tgt === 'string') return this.error(call, tgt, { hostLabel: String(call.args.db ?? '') });
    const { label, asset } = tgt;
    const at = { hostLabel: label, hostName: asset.name };
    if (ctx.mode === 'ask' && call.name !== 'db_schema' && call.name !== 'db_describe') return this.error(call, 'Ask 模式不能执行 SQL。请把 SQL 作为建议告诉用户（放在 ```sql 代码块里）。', at);
    const database = typeof call.args.database === 'string' && call.args.database.trim() ? call.args.database.trim() : undefined;
    const schema = typeof call.args.schema === 'string' && call.args.schema.trim() ? call.args.schema.trim() : undefined;
    if (call.name === 'db_schema' || call.name === 'db_describe') return this.dbMeta(call, ctx, label, asset, database, schema);
    return this.dbSql(call, ctx, label, asset, database, schema);
  }

  /** db_schema / db_describe：固定按只读处理（生产环境也不用批准；权限「禁止」时拒绝） */
  private async dbMeta(call: ToolCall, ctx: ToolContext, label: string, asset: DbAsset, database: string | undefined, schema: string | undefined): Promise<ToolResultRecord> {
    const table = String(call.args.table ?? '').trim();
    if (call.name === 'db_describe' && !table) return this.error(call, '需要 table（表名）', { hostLabel: label, hostName: asset.name });
    const where = [database, schema].filter(Boolean).join('.');
    const desc = call.name === 'db_schema' ? `列出${where ? ` ${where} ` : ''}库表` : `查看表结构：${where ? `${where}.` : ''}${table}`;
    const step: AgentStep = { ...this.step(call, label, asset.name, desc), status: 'pending' };
    ctx.ui.add(step);
    const c: Classification = { level: 'L0', reasons: [call.name === 'db_schema' ? '只读：列出库和表' : '只读：查看表结构'], matchedRules: [], segments: [], complex: false, parseError: false };
    this.applyEval(step, await this.evaluateSql(c, table || where, asset, ctx, true));
    ctx.ui.update();
    const blocked = await this.gate(step, ctx, asset.name);
    if (blocked) {
      ctx.ui.update();
      return this.result(call, step, blocked, true);
    }
    step.status = 'running';
    step.startedAt = this.now();
    ctx.ui.update();
    let s: DbSession | null = null;
    try {
      s = await this.d.databases!.open(ctx.owner, asset.id, database);
      let text: string;
      if (call.name === 'db_schema') {
        text = (await listSchema(s, { database, schema, signal: ctx.signal })).text;
      } else {
        const r = await describeTable(s, table, { database, schema, signal: ctx.signal });
        if (!r) throw new UserError(`表 ${table} 不存在${asset.type === 'POSTGRES' ? `（schema ${schema ?? 'public'}）` : ''}，请先用 db_schema 查看有哪些表`);
        text = r.text;
      }
      step.status = 'done';
      step.exitCode = 0;
      step.finishedAt = this.now();
      step.output = clip(text, 20_000);
      return this.result(call, step, `数据库 ${label}（${asset.name}）${desc}：\n${this.format(text, ctx)}`);
    } catch (e) {
      const msg = e instanceof UserError ? e.message : describeDbError(e);
      step.status = 'error';
      step.finishedAt = this.now();
      step.output = msg;
      return this.result(call, step, `失败：${msg}`, true);
    } finally {
      await s?.close();
    }
  }

  /** db_query / db_explain / db_execute：SQL 分级 → 策略 → 审批 → 执行（只读的在只读事务里）→ 结果表格 + 审计 */
  private async dbSql(call: ToolCall, ctx: ToolContext, label: string, asset: DbAsset, database: string | undefined, schema: string | undefined): Promise<ToolResultRecord> {
    const tool = call.name;
    const raw = String(call.args.sql ?? '').trim();
    if (!raw) return this.error(call, 'SQL 为空', { hostLabel: label, hostName: asset.name });
    const dialect = dialectOf(asset.type);
    const classify = (sql: string): SqlClassification => {
      const c = classifySql(sql, dialect);
      if (c.level === 'DENY') return c;
      if (tool === 'db_explain') {
        // 只看执行计划：模型给的是要分析的语句（也可以自己带 EXPLAIN，但不能带 ANALYZE）
        const inner = c.verb === 'EXPLAIN' ? c : null;
        if (inner && /\banaly[sz]e\b/i.test(c.statement)) return { ...c, level: 'DENY', reasons: ['db_explain 不执行语句；EXPLAIN ANALYZE 会真的执行，请改用 db_query（只读查询）'] };
        const statement = inner ? c.statement : `${asset.type === 'SQLITE' ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'} ${c.statement}`;
        return { ...c, level: 'L0', reasons: ['只查看执行计划，不执行语句'], statement, cursorable: false, estimable: false, segments: [{ text: statement.slice(0, 200), level: 'L0', reasons: [] }] };
      }
      if (tool === 'db_query' && c.level !== 'L0') return { ...c, level: 'DENY', reasons: [...c.reasons, 'db_query 只能执行只读 SQL；需要修改数据时用 db_execute（会请用户批准）'] };
      return c;
    };
    let c = classify(raw);
    const step: AgentStep = { ...this.step(call, label, asset.name, raw), status: 'pending' };
    ctx.ui.add(step);
    this.applyEval(step, await this.evaluateSql(c, c.statement, asset, ctx));
    ctx.ui.update();
    // UPDATE / DELETE：审批前用 EXPLAIN 估算影响的行数（连不上时在这里就报错，不用先批准）
    if (tool === 'db_execute' && c.estimable && step.decision !== 'DENY' && step.decision !== 'AUTO') {
      let s: DbSession | null = null;
      try {
        s = await this.d.databases!.open(ctx.owner, asset.id, database);
        const n = await estimateRows(s, c.statement, { schema, signal: ctx.signal }).catch(() => null);
        if (n !== null) step.reasons = [...step.reasons, `预计影响约 ${n.toLocaleString('en-US')} 行（EXPLAIN 估算）`];
      } catch (e) {
        step.status = 'error';
        step.finishedAt = this.now();
        step.output = e instanceof UserError ? e.message : describeDbError(e);
        ctx.ui.update();
        return this.result(call, step, `失败：${step.output}`, true);
      } finally {
        await s?.close();
      }
      ctx.ui.update();
    }
    const blocked = await this.gate(step, ctx, asset.name, async (sql) => {
      c = classify(sql);
      return this.evaluateSql(c, c.statement, asset, ctx);
    });
    const approvedBy = step.decision === 'AUTO' ? 'AUTO' : 'APPROVED';
    if (blocked) {
      this.dbAudit(asset, step.command, step, step.output === '用户拒绝执行' || step.output === '高危操作没有通过确认' ? 'REJECTED' : 'DENIED', ctx, database ? { database } : {});
      ctx.ui.update();
      return this.result(call, step, blocked, true);
    }
    const maxRows = Math.min(Math.max(Math.round(Number(call.args.max_rows)) || this.d.settings.get('db.maxRows'), 1), 1000);
    const timeoutMs = this.d.settings.get('db.timeoutSec') * 1000;
    step.status = 'running';
    step.startedAt = this.now();
    ctx.ui.update();
    let s: DbSession | null = null;
    try {
      s = await this.d.databases!.open(ctx.owner, asset.id, database);
      const r = await s.run(c.statement, { readOnly: c.level === 'L0', maxRows, timeoutMs, signal: ctx.signal, cursorable: c.cursorable, ...(schema ? { schema } : {}) });
      const table = toTable(r);
      const summary =
        table.columns.length > 0
          ? `返回 ${table.rowCount} 行${r.truncated ? `（达到上限 ${maxRows} 行，后面还有）` : ''}，耗时 ${r.durationMs} ms`
          : `执行成功${r.affected !== null ? `，影响 ${r.affected} 行` : ''}，耗时 ${r.durationMs} ms`;
      step.status = 'done';
      step.exitCode = 0;
      step.finishedAt = this.now();
      step.table = table;
      step.output = summary;
      this.dbAudit(asset, c.statement, step, approvedBy, ctx, { database: s.database, rows: table.rowCount, affected: r.affected, durationMs: r.durationMs });
      const forModel = tableForModel(table, this.d.settings.get('db.maskColumns'), MAX_TOOL_OUTPUT - 1000);
      const content = `数据库 ${label}（${asset.name}${s.database ? ` / ${s.database}` : ''}）执行：${c.statement}\n${summary}\n${this.format(forModel.text, ctx)}`;
      return this.result(call, step, content);
    } catch (e) {
      const msg = e instanceof UserError ? e.message : describeDbError(e);
      step.status = 'error';
      step.exitCode = 1;
      step.finishedAt = this.now();
      step.output = msg;
      this.dbAudit(asset, c.statement, step, approvedBy, ctx, { ...(database ? { database } : {}), error: msg.slice(0, 500) });
      return this.result(call, step, `执行失败：${msg}${c.level !== 'L0' && !(e instanceof DbAbortError) ? '\n（这次的修改已回滚）' : ''}`, true);
    } finally {
      await s?.close();
    }
  }

  // ---------------------------------------------------------------- 只读工具

  private readTerminal(call: ToolCall, ctx: ToolContext): ToolResultRecord {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    const lines = Math.min(Math.max(Number(call.args.lines) || 100, 1), 500);
    const out = t.ref.sessionId ? this.d.sessions.recentOutput(t.ref.sessionId, null) : null;
    if (!out) return this.error(call, `终端 ${t.label} 没有连接`, { hostName: t.name });
    const text = tailLines(stripAnsi(out.raw), lines);
    const step = { ...this.step(call, t.label, t.name, `读取最近 ${lines} 行输出`), status: 'done' as const, output: text, finishedAt: this.now() };
    return this.result(call, step, this.format(text, ctx));
  }

  private metrics(call: ToolCall, ctx: ToolContext): ToolResultRecord {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    const snap = t.host ? this.d.monitor.latest(t.host.id) : null;
    if (!snap) return this.error(call, `主机 ${t.label} 没有监控数据（本机终端不支持，SSH 终端需要保持连接）`, { hostName: t.name });
    const summary = summarizeMetrics(snap);
    const step = { ...this.step(call, t.label, t.name, '读取监控快照'), status: 'done' as const, output: summary, finishedAt: this.now() };
    return this.result(call, step, untrusted(ctx.masker.mask(summary).text));
  }

  private hostList(call: ToolCall, ctx: ToolContext): ToolResultRecord {
    const q = String(call.args.query ?? '').trim().toLowerCase();
    const folder = String(call.args.folder ?? '').trim().toLowerCase();
    const tag = String(call.args.tag ?? '').trim().toLowerCase();
    const referenced = new Map(Object.entries(ctx.targets).filter(([, r]) => r.hostId).map(([l, r]) => [r.hostId!, l]));
    const rows = this.d.hosts
      .list()
      .map((h) => ({ h, path: this.d.hosts.effective(h.id, null).folderPath }))
      .filter(({ h, path }) => (!q || [h.name, h.address, h.note ?? ''].some((v) => v.toLowerCase().includes(q))) && (!folder || path.toLowerCase().includes(folder)) && (!tag || h.tags.some((x) => x.toLowerCase() === tag)))
      .slice(0, 50)
      .map(({ h, path }) => `${referenced.get(h.id) ?? '-'} | ${h.name} | ${h.protocol} ${h.username ? `${h.username}@` : ''}${h.address}${h.port ? `:${h.port}` : ''} | ${path || '未分组'} | ${h.tags.join(',') || '-'} | ${h.osInfo ?? '-'}`);
    const text = rows.length ? `编号 | 名称 | 地址 | 分组 | 标签 | 系统\n${rows.join('\n')}${rows.length === 50 ? '\n（只列出前 50 台）' : ''}\n编号为 - 的主机不在本轮引用里，要操作它请让用户添加引用。` : '没有匹配的主机';
    const step = { ...this.step(call, '', '主机列表', [q, folder && `分组 ${folder}`, tag && `标签 ${tag}`].filter(Boolean).join(' ') || '全部主机'), status: 'done' as const, output: text, finishedAt: this.now() };
    return this.result(call, step, ctx.masker.mask(text).text);
  }

  // ---------------------------------------------------------------- 文件

  /** 用这台主机的文件通道做一件事（服务器没有 SFTP 时自动用 SSH 命令通道或 FTP） */
  private async withSftp<T>(t: Target, ctx: ToolContext, fn: (r: RemoteFs) => Promise<T>): Promise<T> {
    if (!t.host || t.host.protocol !== 'SSH') throw new Error(`${t.name} 不是 SSH 主机`);
    if (this.d.files) {
      const f = await this.d.files(ctx.owner, t.host.id);
      try {
        return await fn(f.remote);
      } finally {
        f.close();
      }
    }
    const conn = await this.d.pool.acquire(t.host.id, ctx.owner);
    let remote: RemoteFs | null = null;
    try {
      remote = await openSftp(conn.client);
      return await fn(remote);
    } finally {
      remote?.end();
      this.d.pool.release(conn);
    }
  }

  private async sftpRead(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    if (ctx.mode === 'ask') return this.error(call, 'Ask 模式不能读取远端文件，请让用户在 SFTP 里打开或引用这个文件。', { hostName: t.name });
    const path = String(call.args.path ?? '');
    if (!path.startsWith('/')) return this.error(call, '路径必须是绝对路径', { hostName: t.name });
    const list = call.name === 'sftp_list';
    const step: AgentStep = { ...this.step(call, t.label, t.name, `${list ? '列出' : '读取'} ${path}`), status: 'pending' };
    ctx.ui.add(step);
    this.applyEval(step, this.evaluateFixed('L0', list ? '列出目录' : '读取文件', t, ctx));
    const blocked = await this.gate(step, ctx, t.name);
    if (blocked) return this.result(call, step, blocked, true);
    step.status = 'running';
    ctx.ui.update();
    const tail = Number(call.args.tail_lines) || 0;
    const text = await this.withSftp(t, ctx, async (r) => {
      const st = await r.stat(posix.normalize(path));
      if (list) {
        if (fileTypeOf(st.mode) !== 'dir') throw new Error('不是目录');
        const items = (await r.readdir(posix.normalize(path))).sort((a, b) => a.filename.localeCompare(b.filename));
        return items
          .slice(0, 500)
          .map((i) => `${fileTypeOf(i.attrs.mode) === 'dir' ? 'd' : '-'} ${String(i.attrs.size).padStart(10)} ${new Date(i.attrs.mtime * 1000).toISOString().slice(0, 16).replace('T', ' ')} ${i.filename}`)
          .join('\n') + (items.length > 500 ? `\n（共 ${items.length} 项，只列出前 500 项）` : '');
      }
      if (fileTypeOf(st.mode) !== 'file') throw new Error('不是普通文件');
      const chunk = tail > 0 ? Math.min(st.size, 512 * 1024) : Math.min(st.size, MAX_READ_BYTES);
      const buf = await readRange(r, posix.normalize(path), tail > 0 ? st.size - chunk : 0, chunk);
      if (buf.subarray(0, 8192).includes(0)) throw new Error('这是二进制文件，不能作为文本读取');
      const s = buf.toString('utf8');
      return tail > 0 ? tailLines(s, Math.min(tail, 5000)) : s + (st.size > MAX_READ_BYTES ? `\n（文件共 ${st.size} 字节，只读了前 ${MAX_READ_BYTES} 字节，可以用 tail_lines 读尾部）` : '');
    });
    step.status = 'done';
    step.output = clip(text, 20_000);
    step.finishedAt = this.now();
    return this.result(call, step, `${t.label}:${path}\n${this.format(text, ctx)}`);
  }

  private async sftpWrite(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能写文件。', { hostName: t.name });
    const path = posix.normalize(String(call.args.path ?? ''));
    if (!path.startsWith('/')) return this.error(call, '路径必须是绝对路径', { hostName: t.name });
    const content = String(call.args.content ?? '');
    const append = call.args.append === true;
    if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return this.error(call, '内容太大（最多 2MB）', { hostName: t.name });
    const step: AgentStep = { ...this.step(call, t.label, t.name, `${append ? '追加写入' : '写入'} ${path}`), status: 'pending' };
    ctx.ui.add(step);
    const before = await this.withSftp(t, ctx, async (r) => {
      const st = await r.exists(path);
      if (!st) return '';
      if (fileTypeOf(st.mode) !== 'file') throw new Error('目标不是普通文件');
      if (st.size > MAX_WRITE_BYTES) throw new Error('原文件太大（超过 2MB），不能通过 Agent 修改');
      const buf = await readRange(r, path, 0, st.size);
      if (buf.subarray(0, 8192).includes(0)) throw new Error('原文件是二进制文件');
      return buf.toString('utf8');
    });
    const after = append ? before + content : content;
    step.diff = unifiedDiff(before, after, { label: path });
    this.applyEval(step, this.evaluateFixed(CRITICAL_FILES.test(path) ? 'L2' : 'L1', CRITICAL_FILES.test(path) ? `修改关键系统文件 ${path}` : `写入文件 ${path}`, t, ctx));
    ctx.ui.update();
    const blocked = await this.gate(step, ctx, t.name);
    if (blocked) {
      this.audit(t, step.command, step, step.decision === 'DENY' ? 'DENIED' : 'REJECTED', ctx);
      return this.result(call, step, blocked, true);
    }
    step.status = 'running';
    ctx.ui.update();
    const backup = before ? `~/.iterminal/backup/${posix.basename(path)}.${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}` : null;
    if (backup) {
      const r = await this.exec(t, `mkdir -p ~/.iterminal/backup && cp -p -- ${shQuote(path)} ${backup}`, 30_000, ctx);
      if (r.code !== 0) throw new Error(`备份原文件失败：${(r.stderr || r.stdout).trim()}`);
    }
    await this.withSftp(t, ctx, async (r) => {
      const st = await r.exists(path);
      await writeRemote(r, path, Buffer.from(after, 'utf8'), st ? st.mode & 0o777 : undefined);
    });
    this.touched(t, ctx);
    step.status = 'done';
    step.output = `已写入 ${path}${backup ? `，原文件备份在 ${backup}` : '（新文件）'}`;
    step.finishedAt = this.now();
    this.audit(t, `sftp_write ${path}`, step, step.decision === 'AUTO' ? 'AUTO' : 'APPROVED', ctx, 0);
    return this.result(call, step, step.output);
  }

  /** 传输时每秒把进度写到步骤卡片上 */
  private progressMeter(step: AgentStep, ctx: ToolContext, total: number, verb: string): PassThrough {
    let done = 0;
    let last = 0;
    const meter = new PassThrough();
    meter.on('data', (c: Buffer) => {
      done += c.length;
      const now = this.now();
      if (now - last > 1000 || done === total) {
        last = now;
        step.output = `${verb} ${human(done)} / ${human(total)}（${total ? Math.floor((done / total) * 100) : 100}%）`;
        ctx.ui.update();
      }
    });
    return meter;
  }

  private async fileUpload(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能上传文件。', { hostName: t.name });
    const raw = String(call.args.local_path ?? '').trim();
    const local = raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
    if (!isAbsolute(local)) return this.error(call, '本机路径必须是绝对路径', { hostName: t.name });
    const st = (() => {
      try {
        return statSync(local);
      } catch {
        return null;
      }
    })();
    if (!st) return this.error(call, `本机文件不存在：${local}`, { hostName: t.name });
    if (!st.isFile()) return this.error(call, '只能上传单个文件（目录请先打包）', { hostName: t.name });
    if (st.size > MAX_TRANSFER_BYTES) return this.error(call, '文件太大（最多 8GB）', { hostName: t.name });
    let remotePath = String(call.args.remote_path ?? '').trim();
    if (!remotePath.startsWith('/')) return this.error(call, '服务器路径必须是绝对路径', { hostName: t.name });
    const step: AgentStep = { ...this.step(call, t.label, t.name, `上传 ${local} → ${remotePath}`), status: 'pending' };
    ctx.ui.add(step);
    const sensitive = SENSITIVE_LOCAL.test(local);
    this.applyEval(step, this.evaluateFixed(sensitive ? 'L2' : 'L1', sensitive ? `上传本机的敏感文件 ${basename(local)}（可能是私钥或凭证）` : `上传本机文件到服务器（${human(st.size)}）`, t, ctx));
    ctx.ui.update();
    const blocked = await this.gate(step, ctx, t.name);
    if (blocked) {
      this.audit(t, step.command, step, step.decision === 'DENY' ? 'DENIED' : 'REJECTED', ctx);
      return this.result(call, step, blocked, true);
    }
    step.status = 'running';
    ctx.ui.update();
    const via = await this.withSftp(t, ctx, async (r) => {
      remotePath = posix.normalize(remotePath);
      const target = remotePath.endsWith('/') ? null : await r.exists(remotePath);
      if (remotePath.endsWith('/') || (target && fileTypeOf(target.mode) === 'dir')) remotePath = posix.join(remotePath, basename(local));
      await pipeline(createReadStream(local), this.progressMeter(step, ctx, st.size, '已上传'), r.createWriteStream(remotePath, { flags: 'w', mode: st.mode & 0o777 }));
      return r.kind;
    });
    step.status = 'done';
    step.output = `已上传到 ${remotePath}（${human(st.size)}${via === 'sftp' ? '' : via === 'shell' ? '，通过 SSH 命令通道' : '，通过 FTP'}）`;
    step.finishedAt = this.now();
    this.audit(t, `file_upload ${local} -> ${remotePath}`, step, step.decision === 'AUTO' ? 'AUTO' : 'APPROVED', ctx, 0);
    return this.result(call, step, step.output);
  }

  private async fileDownload(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能下载文件。', { hostName: t.name });
    if (!this.d.downloadsDir) return this.error(call, '这个环境没有本机下载目录', { hostName: t.name });
    const remotePath = posix.normalize(String(call.args.remote_path ?? '').trim());
    if (!remotePath.startsWith('/')) return this.error(call, '服务器路径必须是绝对路径', { hostName: t.name });
    const step: AgentStep = { ...this.step(call, t.label, t.name, `下载 ${remotePath} → 本机「下载」目录`), status: 'pending' };
    ctx.ui.add(step);
    this.applyEval(step, this.evaluateFixed('L0', '下载文件到本机的「下载」目录（不覆盖已有文件）', t, ctx));
    const blocked = await this.gate(step, ctx, t.name);
    if (blocked) return this.result(call, step, blocked, true);
    step.status = 'running';
    ctx.ui.update();
    const dir = this.d.downloadsDir();
    const saved = await this.withSftp(t, ctx, async (r) => {
      const st = await r.stat(remotePath);
      if (fileTypeOf(st.mode) !== 'file') throw new Error('只能下载单个文件（目录请先在服务器上打包）');
      if (st.size > MAX_TRANSFER_BYTES) throw new Error('文件太大（最多 8GB）');
      const local = freeLocalPath(dir, posix.basename(remotePath));
      try {
        await pipeline(r.createReadStream(remotePath), this.progressMeter(step, ctx, st.size, '已下载'), createWriteStream(local, { flags: 'wx' }));
      } catch (e) {
        // 没下载完的文件删掉，避免留下半个文件
        await rm(local, { force: true });
        throw e;
      }
      return { local, size: st.size, via: r.kind };
    });
    step.status = 'done';
    step.output = `已下载到 ${saved.local}（${human(saved.size)}${saved.via === 'sftp' ? '' : saved.via === 'shell' ? '，通过 SSH 命令通道' : '，通过 FTP'}）`;
    step.finishedAt = this.now();
    this.audit(t, `file_download ${remotePath} -> ${saved.local}`, step, 'AUTO', ctx, 0);
    return this.result(call, step, step.output);
  }

  // ---------------------------------------------------------------- 其他

  private async serial(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能发送命令。', { hostName: t.name });
    if ((t.ref.kind !== 'serial' && t.ref.kind !== 'telnet') || !t.ref.sessionId || !this.d.serialSend) return this.error(call, `${t.label} 不是已连接的串口或 Telnet 会话`, { hostName: t.name });
    const data = String(call.args.data ?? '');
    const step: AgentStep = { ...this.step(call, t.label, t.name, data), status: 'pending' };
    ctx.ui.add(step);
    // 串口 / Telnet 写入默认按 L1 处理（文档一 6.2）；规则判定为只读的命令（show / display）按 L0
    const ev = await this.evaluate(data, t, ctx);
    this.applyEval(step, ev.level === 'L0' ? ev : { ...ev, effectiveLevel: ev.effectiveLevel === 'DENY' ? 'DENY' : 'L1' });
    const blocked = await this.gate(step, ctx, t.name, (cmd) => this.evaluate(cmd, t, ctx));
    if (blocked) return this.result(call, step, blocked, true);
    step.status = 'running';
    ctx.ui.update();
    const out = await this.d.serialSend(t.ref.sessionId, step.command, call.args.wait_for ? String(call.args.wait_for) : null, Math.min(Number(call.args.timeout_sec) || 10, 120) * 1000, ctx.signal);
    step.status = 'done';
    step.output = clip(stripAnsi(out), 20_000);
    step.finishedAt = this.now();
    this.audit(t, step.command, step, step.decision === 'AUTO' ? 'AUTO' : 'APPROVED', ctx);
    return this.result(call, step, this.format(out, ctx));
  }

  private async kb(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const query = String(call.args.query ?? '').trim();
    if (!query) return this.error(call, '请提供检索内容');
    if (!this.d.kbSearch) return this.error(call, '知识库在服务端，登录后才能使用（当前是本地模式）');
    const topK = Math.min(Math.max(Number(call.args.top_k) || 5, 1), 10);
    const hits = await this.d.kbSearch(query, topK, ctx.signal);
    const text = hits.length ? formatKbHits(hits) : '知识库里没有找到相关内容';
    const step = { ...this.step(call, '', '知识库', query), status: 'done' as const, output: text, finishedAt: this.now() };
    return this.result(call, step, untrusted(ctx.masker.mask(clip(text, MAX_TOOL_OUTPUT)).text));
  }

  /**
   * web_search（第二十四轮，文档一 6.38）：只在对话打开「联网」时可用，不碰主机所以不需要审批。查询词发出去之前先脱敏——
   * 不还原 HOST_IP_n、按脱敏规则替换密码和密钥、内网地址换成占位符；每次搜索写一条审计事件。结果放进 <untrusted>。
   */
  private async webSearch(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const web = ctx.web;
    if (!web) return this.error(call, '联网搜索没有打开。需要搜索时请告诉用户在输入框打开「联网」后再发送', { hostName: '' });
    const refHosts = Object.values(ctx.targets)
      .map((r) => (r.hostId ? this.d.hosts.get(r.hostId) : null))
      .filter((h): h is NonNullable<typeof h> => !!h);
    const query = scrubQuery(ctx.masker.mask(String(call.args.query ?? '')).text, hostTerms(refHosts)).slice(0, MAX_QUERY_CHARS);
    if (!query) return this.error(call, '请提供搜索词', { hostName: '' });
    const n = Math.floor(Number(call.args.count));
    const count = Number.isFinite(n) && n >= 1 ? Math.min(n, WEB_SEARCH_COUNT.max) : web.count;
    // 卡片标题：搜索服务名 + 「联网搜索」
    const step: AgentStep = { ...this.step(call, '', web.client.label, query), status: 'running' };
    ctx.ui.add(step);
    try {
      const results = await web.client.search(query, count, ctx.signal);
      // 搜索结果里的网址算「用户可见的来源」，之后 web_fetch 读它们不用再批准
      const seen = this.webSeenFor(ctx.conversationId);
      for (const r of results) {
        seen.urls.add(r.url);
        try {
          seen.domains.add(new URL(r.url).hostname.toLowerCase());
        } catch {
          // 结果里的网址不合法：忽略
        }
      }
      this.d.audit.event('AGENT_WEB_SEARCH', { conversationId: ctx.conversationId, service: web.client.label, query, results: results.length }, ctx.auditSource ?? 'AGENT');
      Object.assign(step, {
        status: 'done',
        output: results.length ? `找到 ${results.length} 条结果` : '没有找到相关网页',
        web: { results: results.map((r) => ({ title: r.title, url: r.url, site: r.site, date: r.date, snippet: r.snippet.slice(0, 300) })) },
        finishedAt: this.now(),
      });
      const text = results.length
        ? results.map((r, i) => `[${i + 1}] ${r.title}\n链接：${r.url}${r.site || r.date ? `\n来源：${[r.site, r.date?.slice(0, 10)].filter(Boolean).join(' · ')}` : ''}\n摘要：${r.summary}`).join('\n\n')
        : '没有找到相关网页，可以换几个关键词再搜。';
      return this.result(call, step, untrusted(ctx.masker.mask(clip(`联网搜索「${query}」的结果：\n\n${text}`, MAX_TOOL_OUTPUT)).text));
    } catch (e) {
      const message = (e as Error).message;
      Object.assign(step, { status: 'error', output: message, finishedAt: this.now() });
      return this.result(call, step, message, true);
    }
  }

  private webSeenFor(id: string): { urls: Set<string>; domains: Set<string> } {
    let s = this.webSeen.get(id);
    if (!s) {
      if (this.webSeen.size > 100) this.webSeen.clear();
      s = { urls: new Set(), domains: new Set() };
      this.webSeen.set(id, s);
    }
    return s;
  }

  /** web_fetch：只读公网网页（内网地址、HOST_IP_n、带账号密码的网址直接拒绝），正文截断后放进 <untrusted> */
  private async webFetch(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const web = ctx.web;
    if (!web) return this.error(call, '联网搜索没有打开。需要读取网页时请告诉用户在输入框打开「联网」后再发送', { hostName: '' });
    const url = String(call.args.url ?? '').trim();
    const bad = checkPublicUrl(url);
    // 模型看到的内容已经脱敏过，网址里最多出现占位符；HOST_IP_n 不还原（checkPublicUrl 直接拒绝）
    if (bad) return this.error(call, bad, { command: url.slice(0, 500) });
    // 自己拼出来的网址（带查询参数、或者域名没在本轮搜索结果里出现过）先请用户批准：
    // 网址的路径和参数可以带任意内容，等于一条往外发数据的通道（第三十二轮）
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const seen = this.webSeenFor(ctx.conversationId);
    const needApproval = !seen.urls.has(url) && (!!u.search || !seen.domains.has(host));
    const step: AgentStep = { ...this.step(call, '', host, url), status: needApproval ? 'pending' : 'running' };
    if (needApproval) {
      step.level = 'L1';
      step.decision = 'APPROVE';
      step.reasons = [u.search ? '网址带查询参数，内容由 Agent 自己拼出来' : '这个网站没有出现在本轮的搜索结果里'];
    }
    ctx.ui.add(step);
    if (needApproval) {
      const auditTarget = { host: null, name: host, ref: { sessionId: null } } as unknown as Target;
      if (ctx.unattended || ctx.external) {
        step.status = 'rejected';
        step.level = 'DENY';
        step.output = '无人值守时不能读取自己拼出来的网址';
        step.finishedAt = this.now();
        this.audit(auditTarget, url, step, 'DENIED', ctx);
        return this.result(call, step, '无人值守执行时只能读取搜索结果里的网址，这次没有读取。', true);
      }
      const resp = await ctx.ui.wait(step);
      step.approvalId = undefined;
      if (resp.decision !== 'approve') {
        step.status = 'rejected';
        step.output = '用户拒绝了这次读取';
        step.finishedAt = this.now();
        this.audit(auditTarget, url, step, 'REJECTED', ctx);
        return this.result(call, step, '用户拒绝读取这个网址。不要换个写法再试，可以先用 web_search 找到来源链接。', true);
      }
      // 批准过的域名之后不再追问
      seen.domains.add(host);
      seen.urls.add(url);
      step.status = 'running';
      ctx.ui.update();
    }
    try {
      const page = await web.client.fetchPage(url, ctx.signal);
      this.d.audit.event('AGENT_WEB_FETCH', { conversationId: ctx.conversationId, service: web.client.label, url, chars: page.content.length }, ctx.auditSource ?? 'AGENT');
      const site = step.hostName;
      Object.assign(step, {
        status: 'done',
        output: page.content ? `${page.title || site}（${page.content.length} 字）` : '这个网页没有可读的正文',
        web: { results: [{ title: page.title || url, url, site }] },
        finishedAt: this.now(),
      });
      const body = page.content.length > MAX_WEB_PAGE_CHARS ? `${page.content.slice(0, MAX_WEB_PAGE_CHARS)}\n\n（正文较长，只保留了前 ${MAX_WEB_PAGE_CHARS} 个字符）` : page.content || '（没有可读的正文）';
      return this.result(call, step, untrusted(ctx.masker.mask(`网页：${page.title || site}\n链接：${url}\n\n${body}`).text));
    } catch (e) {
      const message = (e as Error).message;
      Object.assign(step, { status: 'error', output: message, finishedAt: this.now() });
      return this.result(call, step, message, true);
    }
  }

  private skillLoad(call: ToolCall): ToolResultRecord {
    const name = String(call.args.name ?? '').trim();
    const skill = this.d.skills.find(name);
    if (!skill) return this.error(call, `没有找到 Skill「${name}」，可用的 Skill 见上下文里的列表`);
    const step = { ...this.step(call, '', 'Skill', `读取 ${skill.name}`), status: 'done' as const, output: skill.description, finishedAt: this.now() };
    return this.result(call, step, `【Skill：${skill.name}】\n${skill.content}`);
  }

  /**
   * mcp_call（文档一 6.8）：按工具权限处理——DISABLED 拒绝，APPROVE 每次请用户批准（L1），AUTO 直接调用；
   * 返回内容先脱敏、截断，再放进 <untrusted>。
   */
  private async mcp(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能调用 MCP 工具。');
    if (!this.d.mcp) return this.error(call, '没有配置 MCP Server');
    const server = String(call.args.server ?? '').trim();
    const tool = String(call.args.tool ?? '').trim();
    const args = call.args.arguments && typeof call.args.arguments === 'object' ? (call.args.arguments as Record<string, unknown>) : {};
    const step: AgentStep = { ...this.step(call, '', `MCP · ${server}`, `${tool} ${JSON.stringify(args).slice(0, 2000)}`), status: 'pending' };
    const permission = await this.d.mcp.permission(server, tool);
    if (permission !== 'AUTO' && permission !== 'APPROVE' && permission !== 'DISABLED') return this.error(call, permission, { hostName: `MCP · ${server}` });
    ctx.ui.add(step);
    const auditTarget = { host: null, name: `MCP · ${server}`, ref: { sessionId: null } } as unknown as Target;
    if (permission === 'DISABLED') {
      step.status = 'rejected';
      step.level = 'DENY';
      step.output = `MCP 工具 ${server}/${tool} 被禁用`;
      step.finishedAt = this.now();
      this.audit(auditTarget, `mcp ${tool}`, step, 'DENIED', ctx);
      return this.result(call, step, `${step.output}，不要再调用它。`, true);
    }
    step.level = permission === 'APPROVE' ? 'L1' : 'L0';
    step.reasons = permission === 'APPROVE' ? ['这个 MCP 工具设置为每次调用前需要批准'] : [];
    step.decision = permission === 'APPROVE' ? 'APPROVE' : 'AUTO';
    // 外部 Agent（MCP）经过 Skill 调用到需要批准的 MCP 工具：不审批，按「允许写操作」决定
    if (permission === 'APPROVE' && ctx.external && !ctx.external.allowWrite) {
      step.status = 'rejected';
      step.level = 'DENY';
      step.output = EXTERNAL_NO_WRITE;
      step.finishedAt = this.now();
      this.audit(auditTarget, `mcp ${tool}`, step, 'DENIED', ctx);
      return this.result(call, step, `${EXTERNAL_NO_WRITE}。`, true);
    }
    if (permission === 'APPROVE' && !ctx.external) {
      const resp = await ctx.ui.wait(step);
      step.approvalId = undefined;
      if (resp.decision !== 'approve') {
        step.status = 'rejected';
        step.output = '用户拒绝了这次调用';
        step.finishedAt = this.now();
        this.audit(auditTarget, `mcp ${tool}`, step, 'REJECTED', ctx);
        return this.result(call, step, '用户拒绝了这次 MCP 调用。', true);
      }
    }
    step.status = 'running';
    ctx.ui.update();
    const r = await this.d.mcp.call(server, tool, args, ctx.signal);
    step.status = r.isError ? 'error' : 'done';
    step.output = clip(r.content, 20_000);
    step.finishedAt = this.now();
    this.audit(auditTarget, `mcp ${tool} ${JSON.stringify(args).slice(0, 2000)}`, step, permission === 'AUTO' ? 'AUTO' : 'APPROVED', ctx);
    return this.result(call, step, untrusted(ctx.masker.mask(clip(r.content, MAX_TOOL_OUTPUT)).text), r.isError);
  }

  private async askUser(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const question = String(call.args.question ?? '').trim();
    if (!question) return this.error(call, '问题为空');
    const { options, details } = askOptions(call.args.options);
    const rec = Number(call.args.recommended);
    const recommended = Number.isInteger(rec) && rec >= 0 && rec < options.length ? rec : null;
    const multi = call.args.multi_select === true && options.length > 1;
    const step: AgentStep = {
      ...this.step(call, '', '提问', question),
      status: 'pending',
      question: { text: question, options, ...(details.some(Boolean) ? { details } : {}), recommended, multi },
    };
    ctx.ui.add(step);
    const resp = await ctx.ui.wait(step);
    step.approvalId = undefined;
    step.finishedAt = this.now();
    if (resp.decision === 'reject' || !resp.answer?.trim()) {
      step.status = 'rejected';
      step.output = '用户没有回答';
      return this.result(call, step, '用户没有回答这个问题。', true);
    }
    step.status = 'done';
    step.answer = resp.answer.trim();
    step.output = step.answer;
    return this.result(call, step, `用户回答：${step.answer}`);
  }

  // ---------------------------------------------------------------- 定时任务

  /** 模型给的计划参数 → ScheduleSpec */
  private scheduleSpec(raw: unknown): ScheduleSpec | string {
    const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const kind = String(a.kind ?? '') as ScheduleSpec['kind'];
    if (!['interval', 'daily', 'weekly', 'monthly', 'once', 'cron'].includes(kind)) return 'schedule.kind 需要是 interval / daily / weekly / monthly / once / cron';
    const num = (v: unknown): number | undefined => (v === undefined || v === null || v === '' ? undefined : Number(v));
    const spec: ScheduleSpec = { kind };
    if (kind === 'interval') spec.everyMin = num(a.every_min);
    if (kind === 'daily' || kind === 'weekly' || kind === 'monthly') spec.time = String(a.time ?? '');
    if (kind === 'weekly') spec.weekdays = Array.isArray(a.weekdays) ? a.weekdays.map(Number) : [];
    if (kind === 'monthly') spec.monthDay = num(a.month_day);
    if (kind === 'cron') spec.cron = String(a.cron ?? '');
    if (kind === 'once') {
      const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(a.at ?? ''));
      if (!m) return 'schedule.at 的格式是 YYYY-MM-DD HH:mm';
      spec.at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
    }
    return spec;
  }

  /** 编号（t1、h1）或主机名 → 主机 */
  private scheduleHosts(raw: unknown, ctx: ToolContext): Host[] | string {
    const labels = Array.isArray(raw) ? [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))] : [];
    if (!labels.length) return '需要 hosts（本轮的编号或主机名）';
    const out: Host[] = [];
    for (const label of labels) {
      const ref = ctx.targets[label];
      const host = ref?.hostId ? this.d.hosts.get(ref.hostId) : this.d.hosts.list().find((h) => h.name.toLowerCase() === label.toLowerCase());
      if (!host) return `找不到主机「${label}」（本机终端不能创建定时任务）`;
      if (!out.some((h) => h.id === host.id)) out.push(host);
    }
    return out;
  }

  private async scheduleTask(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    if (!this.d.schedule) return this.error(call, '这里不支持创建定时任务');
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能创建定时任务。请把计划作为建议告诉用户。');
    if (ctx.unattended) return this.error(call, '无人值守执行时不能创建定时任务');
    if (ctx.external) return this.error(call, '外部 Agent（MCP）不能创建定时任务，请让用户在 iTerminal 里创建');
    const spec = this.scheduleSpec(call.args.schedule);
    if (typeof spec === 'string') return this.error(call, spec);
    if (typeof call.args.sql === 'string' && call.args.sql.trim()) return this.scheduleSqlReport(call, ctx, spec);
    const hosts = this.scheduleHosts(call.args.hosts, ctx);
    if (typeof hosts === 'string') return this.error(call, hosts);
    const command = typeof call.args.command === 'string' ? call.args.command.trim() : '';
    const prompt = typeof call.args.prompt === 'string' ? call.args.prompt.trim() : '';
    if (!command && !prompt) return this.error(call, '需要 command（命令任务）或 prompt（AI 任务）');
    const policy = ['READONLY', 'AI_REVIEW', 'APPROVE', 'AUTO'].includes(String(call.args.ai_policy)) ? (String(call.args.ai_policy) as LocalTaskInput['aiPolicy']) : 'AI_REVIEW';
    // AI 任务的执行方案（第二十七轮）：Agent 在对话里验证过的命令清单
    const planSteps: TaskPlanStep[] = [];
    if (!command && Array.isArray(call.args.steps)) {
      for (const raw of call.args.steps.slice(0, 30) as { host?: unknown; command?: unknown; purpose?: unknown }[]) {
        const cmd = typeof raw?.command === 'string' ? raw.command.trim() : '';
        if (!cmd) continue;
        const label = typeof raw.host === 'string' ? raw.host.trim() : '*';
        let hostId: string | null = null;
        if (label && label !== '*') {
          const one = this.scheduleHosts([label], ctx);
          if (typeof one === 'string') return this.error(call, one);
          if (!hosts.some((h) => h.id === one[0].id)) return this.error(call, `steps 里的主机「${label}」不在 hosts 里`);
          hostId = one[0].id;
        }
        planSteps.push({ hostId, command: cmd, purpose: typeof raw.purpose === 'string' ? raw.purpose.trim().slice(0, 60) : '' });
      }
    }
    const plan: TaskPlan | null = planSteps.length ? { steps: planSteps, report: typeof call.args.report === 'string' ? call.args.report.trim().slice(0, 2000) : '', generatedAt: this.now(), conversationId: ctx.conversationId ?? null } : null;
    let input: LocalTaskInput;
    try {
      input = this.d.schedule.validate({
        name: String(call.args.name ?? ''),
        enabled: true,
        type: command ? 'COMMAND' : 'AGENT_PROMPT',
        command: command || null,
        prompt: command ? null : prompt,
        hostIds: hosts.map((h) => h.id),
        schedule: spec,
        aiAssist: !!command && call.args.ai_assist === true,
        goal: typeof call.args.goal === 'string' ? call.args.goal : null,
        aiPolicy: policy,
        timeoutMin: 30,
        notifyOnFailure: true,
        alert: DEFAULT_TASK_ALERT,
        plan,
      });
    } catch (e) {
      return this.error(call, (e as Error).message);
    }
    const checks = input.command
      ? await this.d.schedule.check(input.command, input.hostIds, 'AGENT')
      : (await Promise.all((input.plan?.steps ?? []).map((st) => this.d.schedule!.check(st.command, st.hostId ? [st.hostId] : input.hostIds, 'AGENT')))).flat();
    const denied = checks.find((c) => c.decision === 'DENY');
    if (denied) return this.error(call, `这条命令在「${denied.hostName}」上会被拒绝：${denied.reasons.join('；')}`);
    const rank: Record<string, number> = { L0: 0, L1: 1, L2: 2 };
    const level = checks.reduce<'L1' | 'L2'>((acc, c) => ((rank[c.level] ?? 0) > rank[acc] ? (c.level as 'L2') : acc), 'L1');
    const names = hosts.map((h) => h.name);
    const POLICY = { READONLY: '只读', AI_REVIEW: 'AI 审批', APPROVE: input.plan ? '方案里的写操作按你确认的执行' : '写操作需批准', AUTO: '普通写操作自动执行' } as const;
    const summary = [
      `创建定时任务「${input.name}」`,
      `计划：${describeSchedule(input.schedule)}`,
      `主机：${names.join('、')}`,
      input.command ? `命令：\n${input.command}` : `AI 任务：${input.prompt}`,
      input.plan
        ? `执行方案（每次只执行这些命令，再由 AI 写报告）：\n${input.plan.steps.map((st, n) => `${n + 1}. ${st.hostId ? `[${hosts.find((h) => h.id === st.hostId)?.name}] ` : ''}${st.command}${st.purpose ? `    # ${st.purpose}` : ''}`).join('\n')}${input.plan.report ? `\n汇总要求：${input.plan.report}` : ''}`
        : '',
      input.aiAssist ? `失败时 Agent 介入处理（${POLICY[input.aiPolicy]}）` : input.type === 'AGENT_PROMPT' ? `Agent 权限：${POLICY[input.aiPolicy]}` : '',
      input.goal ? `最终目的：${input.goal}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const step: AgentStep = { ...this.step(call, '', names.length > 3 ? `${names.slice(0, 3).join('、')} 等 ${names.length} 台` : names.join('、'), summary), status: 'pending' };
    step.level = level;
    step.reasons = ['定时任务会在之后按计划自动执行', ...new Set(checks.flatMap((c) => c.reasons))];
    // 持久的自动执行：总是要用户批准；包含高危命令时输入任务名称确认
    step.decision = level === 'L2' ? 'CONFIRM' : 'APPROVE';
    ctx.ui.add(step);
    ctx.ui.update();
    const blocked = await this.gate(step, ctx, input.name);
    if (blocked) {
      ctx.ui.update();
      return this.result(call, step, blocked.replace('这条命令', '这个定时任务'), true);
    }
    const task = this.d.schedule.save(null, input, 'AGENT');
    const next = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '—';
    step.status = 'done';
    step.finishedAt = this.now();
    step.output = `已创建，下次执行：${next}`;
    ctx.ui.update();
    return this.result(call, step, `已创建定时任务「${task.name}」：${describeSchedule(task.schedule)}，下次执行 ${next}。用户可以在左侧「定时任务」页查看、修改、停用或立即执行。`);
  }

  /** schedule_task 的 SQL 报表（第十八轮，文档一 6.32.3）：引用的数据库 + 只读 SQL；总是要用户批准，默认只发系统通知 */
  private async scheduleSqlReport(call: ToolCall, ctx: ToolContext, spec: ScheduleSpec): Promise<ToolResultRecord> {
    const label = String(call.args.db ?? '').trim();
    const tgt = this.dbTarget({ ...call, args: { ...call.args, db: label } }, ctx);
    if (typeof tgt === 'string') return this.error(call, tgt);
    const { asset } = tgt;
    const policy = this.dbPolicy(asset, ctx, true);
    if (policy.agentPolicy === 'DENY') return this.error(call, `数据库「${asset.name}」的 Agent 权限是禁止，不能创建 SQL 报表`);
    const denied = this.dbDenied(asset, String(call.args.sql));
    if (denied) return this.error(call, denied);
    let input: LocalTaskInput;
    try {
      input = this.d.schedule!.validate({
        name: String(call.args.name ?? ''),
        enabled: true,
        type: 'SQL',
        command: String(call.args.sql),
        prompt: null,
        hostIds: [],
        schedule: spec,
        aiAssist: false,
        goal: null,
        aiPolicy: 'READONLY',
        timeoutMin: 10,
        notifyOnFailure: true,
        alert: DEFAULT_TASK_ALERT,
        dbId: asset.id,
        database: typeof call.args.database === 'string' ? call.args.database : null,
        report: { when: call.args.report_when === 'rows' ? 'ROWS' : 'ALWAYS', maxRows: 20, aiSummary: call.args.ai_summary === true, maskColumns: true, systemNotify: true, webhooks: [] },
      });
    } catch (e) {
      return this.error(call, (e as Error).message);
    }
    const summary = [
      `创建 SQL 报表「${input.name}」`,
      `计划：${describeSchedule(input.schedule)}`,
      `数据库：${asset.name}${input.database ? ` / ${input.database}` : ''}`,
      `SQL：\n${input.command}`,
      `发送：${input.report!.when === 'ROWS' ? '查询有结果时才发' : '每次都发'}，系统通知${input.report!.aiSummary ? '，带 AI 总结' : ''}（机器人 / Webhook 可以在定时任务页里添加）`,
    ].join('\n');
    const step: AgentStep = { ...this.step(call, label, asset.name, summary), status: 'pending', level: 'L1', reasons: ['定时任务会在之后按计划自动执行（只读 SQL）'], decision: 'APPROVE' };
    ctx.ui.add(step);
    ctx.ui.update();
    const blocked = await this.gate(step, ctx, input.name);
    if (blocked) {
      ctx.ui.update();
      return this.result(call, step, blocked.replace('这条命令', '这个定时任务'), true);
    }
    const task = this.d.schedule!.save(null, input, 'AGENT');
    const next = task.nextRunAt ? new Date(task.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '—';
    step.status = 'done';
    step.finishedAt = this.now();
    step.output = `已创建，下次执行：${next}`;
    ctx.ui.update();
    return this.result(call, step, `已创建 SQL 报表「${task.name}」：${describeSchedule(task.schedule)}，下次执行 ${next}。用户可以在「定时任务」页添加钉钉 / 企业微信 / 飞书机器人、修改或立即执行。`);
  }

  private scheduleList(call: ToolCall): ToolResultRecord {
    if (!this.d.schedule) return this.error(call, '这里不支持定时任务');
    const list = this.d.schedule.list();
    const text = describeTasks(list, (id) => this.d.hosts.get(id)?.name ?? '（已删除）', (id) => this.d.databases?.get(id)?.name);
    const step = { ...this.step(call, '', '定时任务', `列出定时任务（${list.length} 个）`), status: 'done' as const, output: text, finishedAt: this.now() };
    return this.result(call, step, text);
  }

  // ---------------------------------------------------------------- 笔记 / Skill

  private noteList(call: ToolCall): ToolResultRecord {
    if (!this.d.notes) return this.error(call, '这里不支持笔记');
    const q = String(call.args.query ?? '').trim().toLowerCase();
    const groups = new Map(this.d.notes.groups.list().map((g) => [g.id, g.name]));
    const list = this.d.notes.list().filter((n) => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
    const text = list.length
      ? list
          .slice(0, 50)
          .map((n) => `- [${n.id}] ${n.title}（${n.groupId ? (groups.get(n.groupId) ?? '未分组') : '未分组'}，${new Date(n.updatedAt).toLocaleString('zh-CN', { hour12: false })}）${n.content ? `：${n.content.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`)
          .join('\n') + (list.length > 50 ? `\n（共 ${list.length} 篇，只列出前 50 篇）` : '')
      : q
        ? `没有包含「${q}」的笔记`
        : '还没有笔记';
    const step = { ...this.step(call, '', '笔记', q ? `搜索笔记「${q}」` : '列出笔记'), status: 'done' as const, output: text, finishedAt: this.now() };
    return this.result(call, step, text);
  }

  private noteRead(call: ToolCall, ctx: ToolContext): ToolResultRecord {
    if (!this.d.notes) return this.error(call, '这里不支持笔记');
    const key = String(call.args.note ?? '').trim();
    const note = this.d.notes.find(key);
    if (!note) return this.error(call, `没有找到笔记「${key}」，可以先用 note_list 查找`);
    const step = { ...this.step(call, '', '笔记', `读取「${note.title}」`), status: 'done' as const, output: clip(note.content, 20_000), finishedAt: this.now() };
    // 笔记可能是从别处粘贴来的内容：脱敏后按不可信数据处理
    return this.result(call, step, `笔记 [${note.id}] ${note.title}\n${untrusted(ctx.masker.mask(clip(note.content, MAX_TOOL_OUTPUT)).text)}`);
  }

  /** 新建 / 修改笔记：直接保存（修改会保留上一个版本，用户可以在笔记页撤回），卡片上展示改动对比 */
  private noteSave(call: ToolCall, ctx: ToolContext): ToolResultRecord {
    const notes = this.d.notes;
    if (!notes) return this.error(call, '这里不支持笔记');
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能保存笔记。请把内容直接回答给用户。');
    if (ctx.unattended) return this.error(call, '无人值守执行时不能修改笔记');
    if (ctx.external && !ctx.external.allowWrite) return this.error(call, EXTERNAL_NO_WRITE);
    const key = String(call.args.note ?? '').trim();
    const content = String(call.args.content ?? '');
    if (!content.trim()) return this.error(call, '笔记正文为空');
    const cur = key ? notes.find(key) : null;
    if (key && !cur) return this.error(call, `没有找到笔记「${key}」，新建时不要填 note`);
    const title = String(call.args.title ?? '').trim() || cur?.title || content.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').trim().slice(0, 60) || 'AI 笔记';
    let groupId = cur?.groupId ?? null;
    const groupName = String(call.args.group ?? '').trim();
    if (groupName) {
      const g = notes.groups.list().find((x) => x.name.toLowerCase() === groupName.toLowerCase());
      groupId = g ? g.id : notes.groups.save(null, groupName.slice(0, 64));
    }
    const saved = notes.save(cur?.id ?? null, { groupId, title, content, snapshot: true });
    const step: AgentStep = {
      ...this.step(call, '', '笔记', `${cur ? '修改' : '新建'}笔记「${saved.title}」`),
      status: 'done',
      diff: unifiedDiff(cur ? `# ${cur.title}\n\n${cur.content}` : '', `# ${saved.title}\n\n${saved.content}`, { label: saved.title }),
      output: cur ? '已保存，上一个版本可以在笔记页撤回' : '已新建',
      finishedAt: this.now(),
    };
    this.d.emit(ctx.owner, 'library.changed', { kind: 'note', id: saved.id });
    return this.result(call, step, `已${cur ? '修改' : '新建'}笔记 [${saved.id}]「${saved.title}」。用户可以在左侧「笔记」页查看${cur ? '，也可以撤回到修改前的版本' : ''}。`);
  }

  /** 新建 / 修改 Skill：之后会影响 Agent 的操作步骤，需要用户批准；卡片上展示改动对比 */
  private async skillSave(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    if (ctx.mode === 'ask') return this.error(call, '当前是 Ask 模式，不能保存 Skill。请把 SKILL.md 内容直接回答给用户。');
    if (ctx.unattended) return this.error(call, '无人值守执行时不能修改 Skill');
    const key = String(call.args.id ?? '').trim();
    const content = String(call.args.content ?? '');
    const cur = key ? this.d.skills.find(key) : null;
    if (key && !cur) return this.error(call, `没有找到 Skill「${key}」，新建时不要填 id`);
    const name = /^---\s*\r?\n[\s\S]*?^name:\s*["']?([^"'\n]+)/m.exec(content)?.[1]?.trim() ?? cur?.name ?? '';
    const step: AgentStep = {
      ...this.step(call, '', 'Skill', `${cur ? '修改' : '新建'} Skill「${cur?.name ?? name}」`),
      status: 'pending',
      diff: unifiedDiff(cur?.content ?? '', content, { label: 'SKILL.md' }),
    };
    step.level = 'L1';
    step.reasons = [cur ? '修改后 Agent 会按新的步骤执行这个 Skill' : '新建的 Skill 之后会被 Agent 使用'];
    step.decision = 'APPROVE';
    // 外部 Agent（MCP）：不审批，按「允许写操作」直接保存或拒绝
    if (ctx.external) {
      step.decision = ctx.external.allowWrite ? 'AUTO' : 'DENY';
      if (!ctx.external.allowWrite) step.reasons = [...step.reasons, EXTERNAL_NO_WRITE];
    }
    ctx.ui.add(step);
    ctx.ui.update();
    const blocked = await this.gate(step, ctx, name);
    if (blocked) {
      ctx.ui.update();
      return this.result(call, step, blocked.replace('这条命令', '这个 Skill'), true);
    }
    try {
      const saved = this.d.skills.save(cur?.id ?? null, content);
      step.status = 'done';
      step.output = `已保存 Skill「${saved.title}」`;
      step.finishedAt = this.now();
      this.d.emit(ctx.owner, 'library.changed', { kind: 'skill', id: saved.id });
      return this.result(call, step, `已${cur ? '修改' : '新建'} Skill「${saved.name}」（${saved.description}）。用户可以在「设置 → Skill」里查看和编辑。`);
    } catch (e) {
      step.status = 'error';
      step.output = (e as Error).message;
      step.finishedAt = this.now();
      return this.result(call, step, `保存失败：${(e as Error).message}。修正后重新调用 skill_save。`, true);
    }
  }

  /**
   * 主机记忆（第二十八轮的策略）：验证过的结论（confirmed，含纠正之前错误的记忆）直接记录；不确定的请用户确认，
   * 10 秒没有回应就跳过不记；和已有记忆重复的不再记录。无人值守时只记录 confirmed。设置 ai.memoryPolicy 可以改成每条都问或者关闭。
   */
  private async memory(call: ToolCall, ctx: ToolContext): Promise<ToolResultRecord> {
    const t = this.target(call, ctx);
    if (typeof t === 'string') return this.error(call, t);
    if (!t.host) return this.error(call, '本机终端没有主机记忆');
    const policy = this.d.settings.get('ai.memoryPolicy') ?? 'auto';
    if (policy === 'off') return this.error(call, '用户在设置里关闭了主机记忆，不要再记录');
    const proposed = String(call.args.memory ?? '').trim().slice(0, 2000);
    if (!proposed) return this.error(call, '记忆内容为空');
    if (ctx.turn && ctx.turn.memories >= MAX_MEMORIES_PER_TURN) return this.error(call, `这一轮已经记了 ${MAX_MEMORIES_PER_TURN} 条主机记忆，不再记录；其余结论写在最后的总结里`);
    const certain = call.args.certainty === 'confirmed';
    const existing = this.d.hosts.agentMemories(t.host.id);
    const before = existing.map((m, i) => `${i + 1}. ${m.content}`).join('\n');
    const n = Number(call.args.replace);
    const replaced = Number.isInteger(n) && n >= 1 && n <= existing.length ? existing[n - 1] : null;
    const norm = (x: string): string => x.replace(/[\s，。,.；;：:！!、]/g, '').toLowerCase();
    if (!replaced && existing.some((m) => norm(m.content) === norm(proposed) || norm(m.content).includes(norm(proposed)))) {
      return this.error(call, '主机记忆里已经有这条内容，不用再记录');
    }
    const save = (step: AgentStep, content: string, auto: boolean): ToolResultRecord => {
      try {
        this.d.hosts.saveAgentMemory(replaced?.id ?? null, t.host!.id, content, ctx.conversationId || null);
      } catch (e) {
        step.status = 'error';
        step.output = (e as Error).message;
        return this.result(call, step, `保存失败：${(e as Error).message}`, true);
      }
      if (ctx.turn) ctx.turn.memories++;
      step.status = 'done';
      step.finishedAt = this.now();
      step.memory = { before, after: content, auto, replaced: replaced?.content ?? null };
      step.output = auto ? (replaced ? '已自动更正主机记忆（本次已验证）' : '已自动记录主机记忆（本次已验证）') : '已保存主机记忆';
      ctx.ui.update();
      return this.result(call, step, replaced ? '已用新的结论替换之前那条记忆。' : '已保存到主机记忆，之后引用这台主机时会看到。');
    };
    const title = replaced ? '更正一条主机记忆' : '新增一条主机记忆';
    // 验证过的结论：直接记录，不打扰用户
    if (certain && policy === 'auto') {
      const step: AgentStep = { ...this.step(call, t.label, t.name, title), status: 'running', memory: { before, after: proposed, auto: true, replaced: replaced?.content ?? null } };
      ctx.ui.add(step);
      return save(step, proposed, true);
    }
    // 不确定的：无人值守时不记录；有人时问一下，10 秒没有回应就跳过
    if (ctx.unattended || ctx.external) return this.error(call, '无人值守时只记录验证过的结论，这条没有保存');
    const step: AgentStep = { ...this.step(call, t.label, t.name, title), status: 'pending', memory: { before, after: proposed, replaced: replaced?.content ?? null }, expiresAt: this.now() + MEMORY_CONFIRM.ms };
    ctx.ui.add(step);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctx.ui.cancel?.(step);
    }, MEMORY_CONFIRM.ms);
    const resp = await ctx.ui.wait(step);
    clearTimeout(timer);
    step.approvalId = undefined;
    step.expiresAt = undefined;
    step.finishedAt = this.now();
    if (resp.decision === 'reject') {
      step.status = 'rejected';
      step.output = timedOut ? '10 秒内没有确认，已跳过（没有保存）' : '用户没有采纳';
      return this.result(call, step, timedOut ? '用户没有确认，这条记忆没有保存。不要再提议同样的内容。' : '用户没有采纳这条主机记忆。', true);
    }
    const content = (resp.memory ?? proposed).trim();
    if (!content) {
      step.status = 'rejected';
      step.output = '记忆内容为空，没有保存';
      return this.result(call, step, '用户清空了内容，没有保存。', true);
    }
    return save(step, content, false);
  }
}

/** 按偏移读取一段（SFTP） */
/** 从 offset 开始读 length 个字节（够了就停止读取） */
async function readRange(r: RemoteFs, path: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const s = r.createReadStream(path, { start: offset });
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const c of s) {
      chunks.push(c as Buffer);
      n += (c as Buffer).length;
      if (n >= length) break;
    }
  } finally {
    s.destroy();
  }
  return Buffer.concat(chunks).subarray(0, length);
}

const human = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

/** 本机目录里不冲突的文件名：name.ext → name (1).ext */
function freeLocalPath(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length) || name;
  let p = join(dir, name);
  for (let i = 1; existsSync(p); i++) p = join(dir, `${stem} (${i})${ext}`);
  return p;
}

export function summarizeMetrics(s: MetricsSnapshot): string {
  if (s.state !== 'ok') return s.message;
  const gib = (n: number): string => `${(n / 1024 ** 3).toFixed(1)}G`;
  return [
    `主机 ${s.hostname}（内核 ${s.kernel}），运行 ${Math.floor(s.uptimeSec / 86400)} 天，负载 ${s.load.join(' / ')}`,
    s.cpu ? `CPU ${s.cpu.usage}%（用户 ${s.cpu.user}% 系统 ${s.cpu.system}% IO等待 ${s.cpu.iowait}%，${s.cpu.cores} 核）` : 'CPU 采样中',
    `内存 已用 ${gib(s.mem.used)} / ${gib(s.mem.total)}，交换 ${gib(s.mem.swapUsed)} / ${gib(s.mem.swapTotal)}`,
    `磁盘：${s.disks.map((d) => `${d.mount} ${d.usePct}%（${gib(d.used)}/${gib(d.size)}）`).join('，')}`,
    `网络：${s.net.map((n) => `${n.name} ↓${(n.rxBps / 1024).toFixed(1)}KB/s ↑${(n.txBps / 1024).toFixed(1)}KB/s`).join('，')}`,
    s.gpus.length ? `GPU：${s.gpus.map((g) => `${g.name} ${g.util}% 显存 ${g.memUsed}/${g.memTotal}MiB`).join('，')}` : '',
    `进程 Top：\n${s.procs.slice(0, 10).map((p) => `${p.pid} ${p.user} CPU ${p.cpu}% MEM ${p.mem}% ${p.command}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 没有输出的超时：默认 30 秒，不超过总超时（第十三轮） */
export const DEFAULT_IDLE_SEC = 30;
function idleSecOf(call: ToolCall, timeoutSec: number): number {
  const v = Number(call.args.idle_timeout_sec);
  return Math.min(Math.max(Number.isFinite(v) && v > 0 ? Math.round(v) : DEFAULT_IDLE_SEC, 5), timeoutSec);
}

/** 命令为什么提前结束（显示在步骤卡片上、告诉模型） */
function endReason(r: ExecResult, timeoutSec: number, idleSec: number): string | null {
  if (r.aborted) return '用户已停止';
  if (r.idle) return `${idleSec} 秒没有任何输出，已终止`;
  if (r.timedOut) return `超过 ${timeoutSec} 秒，已终止`;
  return null;
}

const IDLE_HINT =
  '提示：命令长时间没有输出，可能在等待输入（交互式命令、确认提示、要密码）或者一直在运行（tail -f、top 等）。' +
  '标准输入已经关闭，请改用非交互的写法（-y、--no-pager、-b -n 1、tail -n 等）；确实需要长时间没有输出的命令（例如大文件打包）时调大 idle_timeout_sec。';

