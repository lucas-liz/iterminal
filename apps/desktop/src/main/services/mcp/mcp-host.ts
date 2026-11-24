import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { MCP_SERVER_TOOLS_V2, type Host, type McpHostState } from '@itm/protocol';
import type { HostRepo } from '../hosts/host-repo';
import type { FolderRepo } from '../hosts/folder-repo';
import type { SettingsRepo } from '../settings/settings-repo';
import type { AgentService } from '../ai/agent-service';
import type { SkillStore } from '../ai/skills';
import type { McpRepo } from './mcp-repo';
import { UserError } from '../../util/errors';

const MAX_BODY = 4 * 1024 * 1024;

export interface McpHostDeps {
  hosts: HostRepo;
  folders: FolderRepo;
  skills: SkillStore;
  agent: AgentService;
  settings: SettingsRepo;
  repo: McpRepo;
  /** 用哪个窗口显示审批卡片（没有窗口时为 null） */
  owner: () => number | null;
  /** 应用锁定时拒绝外部调用 */
  locked: () => boolean;
  /** 提醒用户：外部 Agent 正在运行 Skill（只是提示，不需要操作） */
  attention: (owner: number, e: { conversationId: string; title: string; text: string }) => void;
  version: string;
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };
const text = (t: string, isError = false): Result => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

/**
 * 本机 MCP 服务（文档一 6.8 / 6.27.5）：只监听 127.0.0.1，Streamable HTTP（无状态），Bearer 令牌鉴权，校验 Host / Origin 防 DNS 重绑定。
 * 暴露主机、命令、文件、监控、Skill、笔记、知识库类的工具。外部 Agent 的调用不弹审批：只读和安全命令直接执行，
 * 写操作 / 高危指令要用户在设置里勾选「允许写操作」「允许高危指令」，没勾选时直接拒绝（硬性限制照常生效）。
 */
export class McpHostService {
  private server: Server | null = null;
  private error: string | null = null;
  private port = 0;

  constructor(private readonly d: McpHostDeps) {}

  /** 第十三轮新增的工具：以前保存过开放工具列表的，升级后自动加进去（只加一次） */
  private migrateTools(): void {
    if (this.d.settings.get('mcp.server.toolsRev') >= 2) return;
    const cur = this.d.settings.get('mcp.server.tools');
    this.d.settings.set('mcp.server.tools', [...new Set([...cur, ...MCP_SERVER_TOOLS_V2])]);
    this.d.settings.set('mcp.server.toolsRev', 2);
  }

  private perm(): { allowWrite: boolean; allowDanger: boolean } {
    const allowWrite = this.d.settings.get('mcp.server.allowWrite');
    return { allowWrite, allowDanger: allowWrite && this.d.settings.get('mcp.server.allowDanger') };
  }

  state(): McpHostState {
    this.migrateTools();
    const port = this.d.settings.get('mcp.server.port');
    return {
      enabled: this.d.settings.get('mcp.server.enabled'),
      port,
      url: `http://127.0.0.1:${this.server ? this.port : port}/mcp`,
      token: this.d.repo.hostToken(),
      running: !!this.server,
      error: this.error,
      tools: this.d.settings.get('mcp.server.tools'),
      allowWrite: this.d.settings.get('mcp.server.allowWrite'),
      allowDanger: this.d.settings.get('mcp.server.allowDanger'),
    };
  }

  /** 按设置启动或停止 */
  async apply(): Promise<McpHostState> {
    const enabled = this.d.settings.get('mcp.server.enabled');
    const port = this.d.settings.get('mcp.server.port');
    if (this.server && (!enabled || this.port !== port)) await this.stop();
    if (enabled && !this.server) {
      try {
        await this.start(port);
        this.error = null;
      } catch (e) {
        this.error = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : (e as Error).message;
      }
    }
    return this.state();
  }

  resetToken(): McpHostState {
    this.d.repo.hostToken(true);
    return this.state();
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** 测试用：指定端口启动（0 = 随机端口），返回实际端口 */
  async start(port: number): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    server.on('error', () => undefined);
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    return this.port;
  }

  private reply(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  }

  private authorized(req: IncomingMessage): boolean {
    const got = Buffer.from(String(req.headers.authorization ?? ''));
    const want = Buffer.from(`Bearer ${this.d.repo.hostToken()}`);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/mcp') return this.reply(res, 404, 'Not found');
    // DNS 重绑定防护：只接受本机地址；浏览器发起的请求必须来自本机页面
    const host = String(req.headers.host ?? '');
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.reply(res, 403, 'Forbidden host');
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return this.reply(res, 403, 'Forbidden origin');
    if (!this.authorized(req)) return this.reply(res, 401, 'Unauthorized');
    if (this.d.locked()) return this.reply(res, 423, 'iTerminal 已锁定，请先在 iTerminal 里解锁');
    if (req.method !== 'POST') return this.reply(res, 405, 'Method not allowed（无状态模式只接受 POST）');
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > MAX_BODY) return this.reply(res, 413, 'Request too large');
        chunks.push(c as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return this.reply(res, 400, 'Invalid JSON');
    }
    const server = this.build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) this.reply(res, 500, (e as Error).message);
    }
  }

  /** 主机名、地址或 ID → 主机（只接受唯一匹配） */
  private findHost(ref: string): Host {
    const k = ref.trim().toLowerCase();
    const all = this.d.hosts.list();
    const byId = all.find((h) => h.id === ref);
    if (byId) return byId;
    const matches = all.filter((h) => h.name.toLowerCase() === k || h.address.toLowerCase() === k);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new UserError(`有 ${matches.length} 台主机叫「${ref}」，请用 list_hosts 返回的 id`);
    throw new UserError(`找不到主机「${ref}」，请先用 list_hosts 查看`);
  }

  private ownerOrThrow(): number {
    const owner = this.d.owner();
    if (owner === null) throw new UserError('iTerminal 没有打开的窗口，请先打开 iTerminal');
    return owner;
  }

  private async exec(
    tool: 'run_command' | 'sftp_read' | 'sftp_list' | 'sftp_write' | 'get_metrics' | 'note_list' | 'note_read' | 'note_save' | 'skill_save' | 'kb_search',
    hostRef: string | null,
    args: Record<string, unknown>,
  ): Promise<Result> {
    try {
      const host = hostRef === null ? null : this.findHost(hostRef);
      const owner = this.ownerOrThrow();
      const r = await this.d.agent.externalCall(owner, tool, host?.id ?? null, args, this.perm());
      return text(r.content, r.isError);
    } catch (e) {
      return text((e as Error).message, true);
    }
  }

  /** 写操作提示（工具说明里告诉外部 Agent 当前的权限） */
  private permHint(): string {
    const p = this.perm();
    return p.allowWrite ? (p.allowDanger ? '当前已开放写操作和高危指令。' : '当前已开放写操作，没有开放高危指令（rm -rf、reboot 等会被拒绝）。') : '当前只开放了只读和安全命令，写操作会被拒绝。';
  }

  private build(): McpServer {
    const server = new McpServer({ name: 'iTerminal', version: this.d.version }, { capabilities: { tools: {} } });
    // 只注册设置里勾选的工具：没勾选的外部 Agent 既看不到也调不了（每个请求都重新读取设置，改了立即生效）
    const enabled = new Set(this.d.settings.get('mcp.server.tools'));
    const register = ((name: string, ...rest: unknown[]) => {
      if (enabled.has(name)) (server.registerTool as (...a: unknown[]) => unknown)(name, ...rest);
    }) as unknown as McpServer['registerTool'];
    register(
      'list_hosts',
      { description: '列出 iTerminal 里的主机（名称、地址、系统、分组、标签），不含任何密码和密钥。可以按关键字过滤。', inputSchema: { keyword: z.string().optional() } },
      async ({ keyword }) => {
        const k = (keyword ?? '').trim().toLowerCase();
        const folders = this.d.folders.list();
        const rows = this.d.hosts
          .list()
          .filter((h) => !k || [h.name, h.address, ...h.tags].some((v) => v.toLowerCase().includes(k)))
          .slice(0, 500)
          .map((h) => {
            const f = folders.find((x) => x.id === h.folderId);
            return `- ${h.name}（id ${h.id}）${h.protocol} ${h.username ? `${h.username}@` : ''}${h.address}:${h.port}${h.osInfo ? `，${h.osInfo}` : ''}${f ? `，分组 ${f.name}` : ''}${h.tags.length ? `，标签 ${h.tags.join('/')}` : ''}`;
          });
        return text(rows.length ? rows.join('\n') : '没有主机');
      },
    );
    register(
      'ssh_exec',
      {
        description: `在一台 SSH 主机上执行命令并返回输出。不需要审批：只读和安全命令直接执行；写操作、高危指令按用户在 iTerminal 里勾选的权限直接执行或拒绝。${this.permHint()}被拒绝时不要换写法绕过，把原因告诉用户。`,
        inputSchema: { host: z.string().describe('主机名、地址或 list_hosts 返回的 id'), command: z.string(), timeout_sec: z.number().int().min(1).max(600).optional() },
      },
      async ({ host, command, timeout_sec }) => this.exec('run_command', host, { command, ...(timeout_sec ? { timeout_sec } : {}) }),
    );
    register(
      'sftp_read',
      { description: '读取主机上的文本文件（可以只读尾部 N 行）。', inputSchema: { host: z.string(), path: z.string(), tail_lines: z.number().int().min(1).max(5000).optional() } },
      async ({ host, path, tail_lines }) => this.exec('sftp_read', host, { path, ...(tail_lines ? { tail_lines } : {}) }),
    );
    register(
      'sftp_write',
      { description: `写入主机上的文件（先备份原文件）。属于写操作：${this.permHint()}`, inputSchema: { host: z.string(), path: z.string(), content: z.string() } },
      async ({ host, path, content }) => this.exec('sftp_write', host, { path, content }),
    );
    register(
      'get_metrics',
      { description: '读取主机的监控快照（CPU、内存、磁盘、网络、负载、Top 进程）。需要在 iTerminal 里打开过这台主机的终端或监控。', inputSchema: { host: z.string() } },
      async ({ host }) => this.exec('get_metrics', host, {}),
    );
    register(
      'run_skill',
      {
        description: `在 iTerminal 里运行一个 Skill（可以对多台主机并行），等运行结束后返回每台主机的结果和汇总。Skill 里的写操作按用户勾选的权限执行。${this.permHint()}`,
        inputSchema: {
          skill: z.string().describe('Skill 的名称或 ID'),
          hosts: z.array(z.string()).optional().describe('主机名或 id'),
          folder: z.string().optional().describe('分组名称（包含子分组）'),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        },
      },
      async ({ skill, hosts, folder, params }) => {
        try {
          const s = this.d.skills.find(skill);
          if (!s) return text(`找不到 Skill「${skill}」，可用的：${this.d.skills.list().map((x) => x.name).join('、') || '（无）'}`, true);
          const owner = this.ownerOrThrow();
          const folderIds = folder ? this.d.folders.list().filter((f) => f.name === folder).map((f) => f.id) : [];
          if (folder && folderIds.length === 0) return text(`找不到分组「${folder}」`, true);
          const hostIds = (hosts ?? []).map((h) => this.findHost(h).id);
          return text(
            await this.d.agent.externalSkill(owner, s.id, { hostIds, folderIds }, params ?? {}, this.perm(), (conversationId) =>
              this.d.attention(owner, { conversationId, title: '外部 Agent 正在运行 Skill', text: s.title }),
            ),
          );
        } catch (e) {
          return text((e as Error).message, true);
        }
      },
    );
    // ---------------------------------------------------------------- 笔记、Skill、知识库（第十三轮）
    register(
      'note_list',
      { description: '列出或搜索 iTerminal 里的笔记（排障记录、操作手册）：id、标题、分组、更新时间和开头。', inputSchema: { query: z.string().optional().describe('按标题和正文搜索') } },
      async ({ query }) => this.exec('note_list', null, { query: query ?? '' }),
    );
    register(
      'note_read',
      { description: '读取一篇笔记的全文（引用笔记）。', inputSchema: { note: z.string().describe('note_list 返回的 id，或者完整的标题') } },
      async ({ note }) => this.exec('note_read', null, { note }),
    );
    register(
      'note_save',
      {
        description: `新建或修改笔记（Markdown）。修改时传 note（id 或标题），会保留上一个版本，用户可以在笔记页撤回。属于写操作：${this.permHint()}`,
        inputSchema: {
          note: z.string().optional().describe('要修改的笔记 id 或标题；新建时不填'),
          title: z.string().optional(),
          content: z.string().describe('完整的正文（Markdown）'),
          group: z.string().optional().describe('分组名称，没有时自动创建'),
        },
      },
      async ({ note, title, content, group }) => this.exec('note_save', null, { ...(note ? { note } : {}), ...(title ? { title } : {}), content, ...(group ? { group } : {}) }),
    );
    register(
      'skill_list',
      { description: '列出 iTerminal 里的 Skill：id、名称、说明、风险等级、执行方式、参数。', inputSchema: {} },
      async () => {
        const list = this.d.skills.list();
        if (!list.length) return text('还没有 Skill');
        return text(
          list
            .map((x) => `- ${x.id}：${x.title}（${x.risk}，${x.mode === 'parallel' ? '多台并行' : '单个 Agent'}）${x.description ? `——${x.description}` : ''}${x.params.length ? `；参数 ${x.params.map((p) => `${p.name}${p.default !== undefined ? `=${p.default}` : ''}`).join('、')}` : ''}`)
            .join('\n'),
        );
      },
    );
    register(
      'skill_read',
      { description: '读取一个 Skill 的完整 SKILL.md（YAML front matter + Markdown 步骤）。修改 Skill 前先读。', inputSchema: { skill: z.string().describe('Skill 的 id 或名称') } },
      async ({ skill }) => {
        const s = this.d.skills.find(skill);
        if (!s) return text(`找不到 Skill「${skill}」，可以先用 skill_list 查看`, true);
        return text(this.d.skills.read(s.id));
      },
    );
    register(
      'skill_save',
      {
        description:
          `新建或修改 Skill。content 是完整的 SKILL.md：开头用 --- 包起来的 YAML front matter（至少 name、description；可选 title、risk: readonly | write-needs-approval | dangerous、mode: single | parallel、allowed-tools、params），后面是 Markdown 写的步骤和输出要求。修改时传 id（先用 skill_read 读出原文）。属于写操作：${this.permHint()}`,
        inputSchema: { id: z.string().optional().describe('要修改的 Skill id；新建时不填'), content: z.string() },
      },
      async ({ id, content }) => this.exec('skill_save', null, { ...(id ? { id } : {}), content }),
    );
    register(
      'kb_search',
      { description: '检索团队知识库（运维手册、故障复盘），返回相关片段和出处。只有登录了团队账号时可用。', inputSchema: { query: z.string(), top_k: z.number().int().min(1).max(10).optional() } },
      async ({ query, top_k }) => this.exec('kb_search', null, { query, ...(top_k ? { top_k } : {}) }),
    );
    return server;
  }
}
