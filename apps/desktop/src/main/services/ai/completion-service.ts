import { Masker } from '@itm/masking';
import { stripAnsi, tailLines } from '@itm/agent-core';
import type { Db } from '../db/database';
import type { HostRepo } from '../hosts/host-repo';
import type { SettingsRepo } from '../settings/settings-repo';
import type { SessionManager } from '../connection/session-manager';
import type { AiProviderRepo } from './provider-repo';
import type { AgentRuntime } from './runtime';
import type { SnippetRepo } from '../library/snippet-repo';
import type { ShellHistory, ShellHistoryService } from './shell-history';

const MAX_PER_SCOPE = 2000;
const MAX_COMMAND = 500;
/** 补全模型的超时：补全只在输入停顿时请求，慢了就没有意义 */
const AI_TIMEOUT_MS = 4000;

/** 输入提示时最多等远端历史这么久（第一次读取；之后用缓存） */
const SHELL_WAIT_MS = 1500;

/** 历史命令面板的一行：shell 自己的历史（history 命令看到的），或者 iTerminal 记录的 */
export interface HistoryItem {
  command: string;
  source: 'shell' | 'app';
  /** iTerminal 记录过的才有 */
  count?: number;
  lastUsed?: number;
}

export interface HistoryPage {
  items: HistoryItem[];
  /** 符合搜索条件的总条数 */
  total: number;
  /** shell 历史的读取情况；null = 没有读（不是 SSH 主机） */
  shell: { files: string[]; error?: string } | null;
}

interface AppRow {
  command: string;
  count: number;
  lastUsed: number;
}

/**
 * 合并两份历史：先放 iTerminal 记录里比历史文件新的（bash 退出时才写历史文件，当前会话执行的还不在文件里），
 * 再按 shell 历史的顺序（最近的在前），最后是只在 iTerminal 里记录过的旧命令。同一条命令只出现一次。
 */
export function mergeHistory(app: AppRow[], shell: string[] | null, shellMtime: number | null): HistoryItem[] {
  const meta = new Map(app.map((a) => [a.command, a]));
  const seen = new Set<string>();
  const out: HistoryItem[] = [];
  const push = (command: string, source: HistoryItem['source']): void => {
    if (seen.has(command)) return;
    seen.add(command);
    const m = meta.get(command);
    out.push(m ? { command, source, count: m.count, lastUsed: m.lastUsed } : { command, source });
  };
  if (shell?.length) {
    for (const a of app) if (shellMtime === null || a.lastUsed > shellMtime) push(a.command, 'app');
    for (const c of shell) push(c, 'shell');
  }
  for (const a of app) push(a.command, 'app');
  return out;
}

export interface Suggestion {
  /** 补全后的整行命令（以已输入的内容开头） */
  suggestion: string | null;
  source: 'history' | 'snippet' | 'ai' | null;
}

/**
 * 终端行内补全（文档一 6.1）：输入停顿时先在本地历史命令里按前缀匹配（使用次数和最近使用排序），再匹配快捷命令，
 * 没有命中且开启了 AI 补全时再请求补全模型（快速模型）。历史命令只存在本地加密库里；看起来带密码的命令不记录。
 */
export class CompletionService {
  private readonly masker = new Masker({ maskIps: false, maskPii: false });
  /** shell 历史去掉带密码的命令后的结果（每份读取结果算一次） */
  private readonly safeShell = new WeakMap<ShellHistory, string[]>();

  constructor(
    private readonly db: Db,
    private readonly hosts: HostRepo,
    private readonly sessions: SessionManager,
    private readonly settings: SettingsRepo,
    private readonly providers: AiProviderRepo,
    private readonly runtime: AgentRuntime,
    private readonly now: () => number = Date.now,
    private readonly snippets?: SnippetRepo,
    private readonly shell?: ShellHistoryService,
  ) {}

  /** shell 历史里能显示的命令：带密码、令牌的（脱敏规则命中）不显示，和 iTerminal 自己不记录这类命令一致 */
  private shellEntries(h: ShellHistory | null): string[] | null {
    if (!h || h.error) return null;
    let safe = this.safeShell.get(h);
    if (!safe) {
      safe = h.entries.filter((c) => !c.startsWith('#') && Object.keys(this.masker.mask(c).hits).length === 0);
      this.safeShell.set(h, safe);
    }
    return safe;
  }

  private appRows(hostId: string | null): AppRow[] {
    return this.db
      .prepare<[string], { command: string; count: number; last_used: number }>('SELECT command, count, last_used FROM cmd_history WHERE scope = ? ORDER BY last_used DESC')
      .all(this.scope(hostId))
      .map((r) => ({ command: r.command, count: r.count, lastUsed: r.last_used }));
  }

  private merged(hostId: string | null, h: ShellHistory | null): HistoryItem[] {
    return mergeHistory(this.appRows(hostId), this.shellEntries(h), h?.mtime ?? null);
  }

  private scope(hostId: string | null): string {
    return hostId ? `host:${hostId}` : 'local';
  }

  /** 记录一条执行过的命令（终端里回车时） */
  record(hostId: string | null, command: string): void {
    // 空格开头的命令不进历史（和 bash 的 HISTCONTROL=ignorespace 一致）
    if (/^\s/.test(command)) return;
    const cmd = command.trim();
    if (!cmd || cmd.length > MAX_COMMAND || cmd.startsWith('#')) return;
    // 命令里有密码、令牌（脱敏规则命中）就不记录
    if (Object.keys(this.masker.mask(cmd).hits).length > 0) return;
    const scope = this.scope(hostId);
    this.db
      .prepare(
        `INSERT INTO cmd_history (scope, command, count, last_used) VALUES (?, ?, 1, ?)
         ON CONFLICT (scope, command) DO UPDATE SET count = count + 1, last_used = excluded.last_used`,
      )
      .run(scope, cmd, this.now());
    const n = this.db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM cmd_history WHERE scope = ?').get(scope)!.n;
    if (n > MAX_PER_SCOPE) {
      this.db
        .prepare('DELETE FROM cmd_history WHERE scope = ? AND command IN (SELECT command FROM cmd_history WHERE scope = ? ORDER BY last_used LIMIT ?)')
        .run(scope, scope, n - MAX_PER_SCOPE);
    }
  }

  /**
   * 某台主机（或本机）的历史命令，分页：shell 自己的历史（~/.bash_history 等，history 命令看到的）和 iTerminal 记录的合在一起，最近的在前。
   * refresh 时重新读 shell 历史（否则用 30 秒内的缓存）。
   */
  async history(owner: number, hostId: string | null, opts: { q?: string; offset?: number; limit?: number; refresh?: boolean } = {}): Promise<HistoryPage> {
    let h: ShellHistory | null = null;
    if (this.shell && (!hostId || this.hosts.get(hostId)?.protocol === 'SSH')) h = await this.shell.load(owner, hostId, !!opts.refresh);
    const q = (opts.q ?? '').trim().toLowerCase();
    const all = this.merged(hostId, h).filter((i) => !q || i.command.toLowerCase().includes(q));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 500));
    return { items: all.slice(offset, offset + limit), total: all.length, shell: h ? { files: h.files, ...(h.error ? { error: h.error } : {}) } : null };
  }

  deleteHistory(hostId: string | null, command: string): void {
    this.db.prepare('DELETE FROM cmd_history WHERE scope = ? AND command = ?').run(this.scope(hostId), command);
  }

  clearHistory(hostId: string | null): void {
    this.db.prepare('DELETE FROM cmd_history WHERE scope = ?').run(this.scope(hostId));
  }

  /**
   * 命令提示的候选（终端里输入时弹出的列表）：按前缀匹配历史命令——shell 自己的历史优先（最近的在前），再加上 iTerminal 的记录；
   * 快捷命令按前缀匹配。内置命令库在界面上匹配（带中文说明）。不请求 AI。
   */
  async matches(owner: number, hostId: string | null, prefix: string, limit = 8): Promise<{ history: string[]; snippets: string[] }> {
    if (!prefix.trim() || prefix.length > MAX_COMMAND) return { history: [], snippets: [] };
    const n = Math.max(1, Math.min(limit, 30));
    return { history: await this.prefixed(owner, hostId, prefix, n), snippets: this.snippets?.completions(prefix, n) ?? [] };
  }

  /** 以 prefix 开头（不等于 prefix）的历史命令，shell 历史优先 */
  private async prefixed(owner: number, hostId: string | null, prefix: string, n: number): Promise<string[]> {
    const h = this.shell && (!hostId || this.hosts.get(hostId)?.protocol === 'SSH') ? await this.shell.quick(owner, hostId, SHELL_WAIT_MS) : null;
    const out: string[] = [];
    for (const i of this.merged(hostId, h)) {
      if (i.command !== prefix && i.command.startsWith(prefix)) out.push(i.command);
      if (out.length >= n) break;
    }
    return out;
  }

  async suggest(owner: number, hostId: string | null, sessionId: string | null, prefix: string, signal: AbortSignal): Promise<Suggestion> {
    const mode = this.settings.get('ai.inlineCompletion');
    if (mode === 'off' || prefix.trim().length < 2 || prefix.length > MAX_COMMAND) return { suggestion: null, source: null };
    const hit = (await this.prefixed(owner, hostId, prefix, 1))[0];
    if (hit) return { suggestion: hit, source: 'history' };
    // 快捷命令也是候选（单行、不带变量的命令）
    const snip = this.snippets?.completions(prefix, 1)[0];
    if (snip) return { suggestion: snip, source: 'snippet' };
    if (mode !== 'ai') return { suggestion: null, source: null };
    const ref = this.settings.get('ai.fastModel') ?? this.settings.get('ai.defaultModel');
    if (!ref) return { suggestion: null, source: null };
    let resolved;
    try {
      resolved = this.providers.resolve(ref);
    } catch {
      return { suggestion: null, source: null };
    }
    const host = hostId ? this.hosts.get(hostId) : null;
    const out = sessionId ? this.sessions.recentOutput(sessionId, null) : null;
    const history = this.db
      .prepare<[string], { command: string }>('SELECT command FROM cmd_history WHERE scope = ? ORDER BY last_used DESC LIMIT 10')
      .all(this.scope(hostId))
      .map((r) => r.command)
      .reverse();
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(AI_TIMEOUT_MS)]);
    try {
      const line = await this.runtime.complete(
        resolved,
        {
          prefix,
          host: host ? `${host.name}（${host.osInfo ?? '系统未知'}）` : '本机',
          recentOutput: this.masker.mask(tailLines(stripAnsi(out?.raw ?? ''), 30)).text,
          history: history.map((h) => this.masker.mask(h).text),
        },
        timeout,
      );
      return line ? { suggestion: line, source: 'ai' } : { suggestion: null, source: null };
    } catch {
      return { suggestion: null, source: null };
    }
  }
}
