import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApprovalEngine, DEFAULT_POLICY, type ApprovalEngine } from '@itm/approval';
import type { AgentConversationView, AgentStep, IpcEventName, IpcEvents, ModelRef, PromptRequest } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SessionManager } from '../src/main/services/connection/session-manager';
import { MonitorService } from '../src/main/services/monitor/monitor-service';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import { SkillStore } from '../src/main/services/ai/skills';
import { AgentService } from '../src/main/services/ai/agent-service';
import { InlineRuntime } from '../src/main/services/ai/runtime';
import { McpRepo } from '../src/main/services/mcp/mcp-repo';
import { contentToText, McpClientManager } from '../src/main/services/mcp/mcp-client';
import { McpHostService } from '../src/main/services/mcp/mcp-host';
import { NoteRepo } from '../src/main/services/library/note-repo';
import type { SettingsRepo } from '../src/main/services/settings/settings-repo';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import type { FolderRepo } from '../src/main/services/hosts/folder-repo';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';
import { startLlmMock, type LlmMock } from './support/llm-mock';

const OWNER = 4;
const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
/** 用 Electron 自带的 Node 启动测试 MCP Server（stdio） */
const STDIO = { command: process.execPath, args: [join(__dirname, 'support', 'mcp-test-server.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };

let approval: ApprovalEngine;
let dir: string;
let db: Db;
let key: Buffer;
let repo: McpRepo;
let hosts: HostRepo;
let settings: SettingsRepo;
let folders: FolderRepo;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-mcp-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  key = randomBytes(32);
  ({ hosts, settings, folders } = createRepos(db, key));
  repo = new McpRepo(db, key);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MCP 配置', () => {
  it('环境变量和请求头加密保存，只返回键名；不填时保持不变；校验名称、命令和地址', () => {
    const s = repo.save(null, { name: 'github', transport: 'STDIO', command: 'npx', args: ['-y', 'server'], env: { GITHUB_TOKEN: 'ghp_secret123' }, defaultPermission: 'APPROVE', enabled: true });
    expect(s).toMatchObject({ name: 'github', envKeys: ['GITHUB_TOKEN'], args: ['-y', 'server'], defaultPermission: 'APPROVE' });
    const raw = JSON.stringify(db.prepare('SELECT * FROM mcp_server').all());
    expect(raw).not.toContain('ghp_secret123');
    expect(repo.secrets(s.id).env).toEqual({ GITHUB_TOKEN: 'ghp_secret123' });
    repo.save(s.id, { name: 'github', transport: 'STDIO', command: 'npx', defaultPermission: 'AUTO', toolPolicies: { delete_repo: 'DISABLED' }, enabled: true });
    expect(repo.secrets(s.id).env).toEqual({ GITHUB_TOKEN: 'ghp_secret123' });
    expect(repo.permission(repo.get(s.id)!, 'delete_repo')).toBe('DISABLED');
    expect(repo.permission(repo.get(s.id)!, 'search')).toBe('AUTO');
    expect(() => repo.save(null, { name: 'GitHub', transport: 'STDIO', command: 'x', defaultPermission: 'AUTO', enabled: true })).toThrow('已经有名为');
    expect(() => repo.save(null, { name: 'a b', transport: 'STDIO', command: 'x', defaultPermission: 'AUTO', enabled: true })).toThrow('名称只能');
    expect(() => repo.save(null, { name: 'web', transport: 'HTTP', url: 'ftp://x', defaultPermission: 'AUTO', enabled: true })).toThrow('http(s)');
    expect(() => repo.save(null, { name: 'cli', transport: 'STDIO', command: ' ', defaultPermission: 'AUTO', enabled: true })).toThrow('启动命令');
  });

  it('本机 MCP 服务的令牌：生成后保持不变，可以重置，不出现在设置里', () => {
    const t = repo.hostToken();
    expect(t).toMatch(/^itm_/);
    expect(repo.hostToken()).toBe(t);
    expect(repo.hostToken(true)).not.toBe(t);
    expect(JSON.stringify(settings.getAll())).not.toContain('itm_');
  });

  it('工具结果转文字', () => {
    expect(contentToText([{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png' }])).toBe('a\n[图片 image/png]');
  });
});

describe('MCP Client（stdio）', () => {
  it('连接、列出工具、调用；环境变量传给子进程；工具返回错误；命令不存在时给出错误', async () => {
    const s = repo.save(null, { name: 'local', transport: 'STDIO', ...STDIO, env: { ...STDIO.env, MCP_TOKEN: 'tok-1' }, defaultPermission: 'AUTO', enabled: true });
    const mgr = new McpClientManager(repo);
    try {
      const tools = await mgr.tools(s.id);
      expect(tools.map((t) => t.name).sort()).toEqual(['add', 'echo', 'env', 'fail']);
      expect(tools.find((t) => t.name === 'add')?.inputSchema).toMatchObject({ properties: { a: { type: 'number' } } });
      expect(await mgr.call(s.id, 'echo', { text: 'hi' }, AbortSignal.timeout(10_000))).toEqual({ content: 'echo:hi', isError: false });
      expect(await mgr.call(s.id, 'add', { a: 2, b: 3 }, AbortSignal.timeout(10_000))).toEqual({ content: '5', isError: false });
      expect(await mgr.call(s.id, 'env', {}, AbortSignal.timeout(10_000))).toEqual({ content: 'tok-1', isError: false });
      expect((await mgr.call(s.id, 'fail', {}, AbortSignal.timeout(10_000))).isError).toBe(true);
      expect(mgr.status(s.id).state).toBe('connected');
    } finally {
      mgr.closeAll();
    }
    const bad = repo.save(null, { name: 'bad', transport: 'STDIO', command: '/nonexistent/mcp-server', defaultPermission: 'AUTO', enabled: true });
    const st = await new McpClientManager(repo).test(bad.id);
    expect(st.state).toBe('error');
  }, 30_000);
});

describe('本机 MCP 服务 + Agent', () => {
  let server: TestSshServer;
  let mock: LlmMock;
  let pool: SshPool;
  let agent: AgentService;
  let host: McpHostService;
  let audit: AuditRepo;
  let views: AgentConversationView[];
  let attention: { conversationId: string; title: string }[];
  let claude: ModelRef;
  let mgr: McpClientManager;
  let notes: NoteRepo;
  let skills: SkillStore;
  let locked = false;

  beforeEach(async () => {
    mkdirSync(join(dir, 'remote'));
    settings.set('ai.llmReview', false);
    approval ??= await createApprovalEngine(wasm);
    views = [];
    attention = [];
    let broker: PromptBroker;
    const emit = <E extends IpcEventName>(_o: number, event: E, payload: IpcEvents[E]): void => {
      if (event === 'agent.update') views.push(payload as AgentConversationView);
      if (event === 'prompt.request') setTimeout(() => broker.answer(OWNER, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true }), 1);
    };
    broker = new PromptBroker(emit);
    pool = new SshPool(hosts, broker, 5000);
    const sessions = new SessionManager(pool, hosts, emit, (f, a, o) => pty.spawn(f, a, { name: 'xterm-256color', ...o }));
    const providers = new AiProviderRepo(db, key);
    skills = new SkillStore(join(dir, 'skills'));
    server = await startTestSshServer({ root: join(dir, 'remote'), sftpRealPaths: true });
    mock = await startLlmMock();
    hosts.create({ folderId: null, name: 'web-01', address: '127.0.0.1', port: server.port, username: 'tester', authMethod: 'PASSWORD', password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });
    audit = new AuditRepo(db);
    mgr = new McpClientManager(repo);
    notes = new NoteRepo(db);
    agent = new AgentService({
      db, providers, sessions, pool, hosts, folders, skills, settings, approval, emit, audit, notes,
      credentials: createRepos(db, key).credentials,
      monitor: new MonitorService(pool, emit, sessions),
      runtime: new InlineRuntime(),
      policy: () => ({ ...DEFAULT_POLICY, nightWindow: settings.get('ai.nightWindow'), allowLlmReview: false }),
      mcp: {
        permission: async (name, tool) => {
          const cfg = repo.byName(name);
          if (!cfg) return `没有名为「${name}」的 MCP Server`;
          return (await mgr.tools(cfg.id)).some((t) => t.name === tool) ? repo.permission(cfg, tool) : `没有工具 ${tool}`;
        },
        call: (name, tool, args, signal) => mgr.call(repo.byName(name)!.id, tool, args, signal),
        catalog: async (ids) =>
          Promise.all(ids.map(async (id) => ({ server: repo.get(id)!.name, tools: (await mgr.tools(id)).map((t) => ({ ...t, permission: repo.permission(repo.get(id)!, t.name) })) }))),
      },
    });
    const cp = providers.save(null, { name: 'Claude', type: 'ANTHROPIC', baseUrl: mock.url, apiKey: 'k', enabled: true, models: [{ id: 'claude-opus-5-5', contextWindow: 200_000, maxOutput: 8000 }] });
    claude = { providerId: cp.id, modelId: 'claude-opus-5-5' };
    host = new McpHostService({ hosts, folders, skills, agent, settings, repo, owner: () => OWNER, locked: () => locked, attention: (_o, e) => attention.push(e), version: 'test' });
  });

  afterEach(async () => {
    mgr.closeAll();
    await host.stop();
    pool.closeAll();
    await server.close();
    await mock.close();
  });

  const lastView = (id: string): AgentConversationView | undefined => views.filter((v) => v.id === id).at(-1);
  async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('外部 Agent（第十三轮）：令牌和 Host 校验；不审批——只读直接执行，写操作 / 高危指令按勾选的权限执行或拒绝；审计来源是 MCP_EXTERNAL', async () => {
    const port = await host.start(0);
    const url = `http://127.0.0.1:${port}/mcp`;
    const token = repo.hostToken();
    const rpc = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: 'Bearer wrong-token-xxxxxxxxxxxxxxxxxxx' })).status).toBe(401);
    locked = true;
    expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { authorization: `Bearer ${token}` })).status).toBe(423);
    locked = false;

    // 用 iTerminal 自己的 MCP Client（HTTP）连上去：默认开放全部 13 个工具
    const self = repo.save(null, { name: 'iterminal', transport: 'HTTP', url, headers: { Authorization: `Bearer ${token}` }, defaultPermission: 'AUTO', enabled: true });
    const tools = await mgr.tools(self.id);
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['get_metrics', 'kb_search', 'list_hosts', 'note_list', 'note_read', 'note_save', 'run_skill', 'sftp_read', 'sftp_write', 'skill_list', 'skill_read', 'skill_save', 'ssh_exec'].sort(),
    );
    expect(host.state()).toMatchObject({ allowWrite: false, allowDanger: false });
    expect((await mgr.call(self.id, 'list_hosts', {}, AbortSignal.timeout(10_000))).content).toContain('web-01');

    const call = (tool: string, args: Record<string, unknown>) => mgr.call(self.id, tool, args, AbortSignal.timeout(30_000));
    const ro = await call('ssh_exec', { host: 'web-01', command: 'echo from-mcp' });
    expect(ro.isError).toBe(false);
    expect(ro.content).toContain('from-mcp');

    // 默认只读：写操作直接拒绝（不弹审批），告诉外部 Agent 去勾选权限
    const w1 = await call('ssh_exec', { host: 'web-01', command: 'touch /tmp/itm-mcp-flag' });
    expect(w1.isError).toBe(true);
    expect(w1.content).toContain('允许写操作');
    expect(server.execs).not.toContain('touch /tmp/itm-mcp-flag');
    expect(attention).toEqual([]);

    // 勾选「允许写操作」：写操作直接执行；高危指令仍然拒绝
    settings.set('mcp.server.allowWrite', true);
    const w2 = await call('ssh_exec', { host: 'web-01', command: 'touch /tmp/itm-mcp-flag' });
    expect(w2.isError).toBe(false);
    expect(server.execs).toContain('touch /tmp/itm-mcp-flag');
    const danger = 'rm -rf /tmp/itm-mcp-nonexistent-dir';
    const d1 = await call('ssh_exec', { host: 'web-01', command: danger });
    expect(d1.isError).toBe(true);
    expect(d1.content).toContain('允许高危指令');
    expect(server.execs).not.toContain(danger);
    // 再勾选「允许高危指令」：直接执行
    settings.set('mcp.server.allowDanger', true);
    expect((await call('ssh_exec', { host: 'web-01', command: danger })).isError).toBe(false);
    expect(server.execs).toContain(danger);
    // 没有勾选写操作时，高危权限不生效
    settings.set('mcp.server.allowWrite', false);
    expect(host.state().allowWrite).toBe(false);
    expect((await call('ssh_exec', { host: 'web-01', command: 'rm -rf /tmp/itm-mcp-other' })).content).toContain('允许高危指令');

    // 全程没有出现过审批
    const conv = agent.list().find((c) => c.title === '外部 Agent（MCP）')!;
    const steps = agent.view(conv.id).messages.flatMap((m) => (m.role === 'assistant' ? m.steps : []));
    expect(steps.some((x: AgentStep) => x.status === 'approval')).toBe(false);
    const audits = db.prepare<[], { source: string; command: string; decision: string }>("SELECT source, command, decision FROM audit_log WHERE kind = 'COMMAND'").all();
    const ext = audits.filter((r) => r.source === 'MCP_EXTERNAL');
    expect(ext.map((r) => r.command)).toEqual(expect.arrayContaining(['echo from-mcp', 'touch /tmp/itm-mcp-flag', danger]));
    expect(ext.find((r) => r.command === 'touch /tmp/itm-mcp-flag' && r.decision === 'DENIED')).toBeTruthy();
    expect(ext.find((r) => r.command === 'touch /tmp/itm-mcp-flag' && r.decision === 'AUTO')).toBeTruthy();

    // 笔记：引用、创建 / 修改（写操作，受权限约束）
    const n0 = await call('note_save', { title: '外部笔记', content: '# 外部笔记\n第一版' });
    expect(n0.isError).toBe(true);
    expect(n0.content).toContain('允许写操作');
    settings.set('mcp.server.allowWrite', true);
    expect((await call('note_save', { title: '外部笔记', content: '# 外部笔记\n第一版', group: '排障' })).isError).toBe(false);
    expect((await call('note_save', { note: '外部笔记', content: '# 外部笔记\n第二版' })).isError).toBe(false);
    expect((await call('note_list', { query: '外部' })).content).toContain('外部笔记');
    expect((await call('note_read', { note: '外部笔记' })).content).toContain('第二版');
    expect(notes.list().find((n) => n.title === '外部笔记')?.content).toContain('第二版');

    // Skill：列出、读取、新建 / 修改（保存前校验 front matter）
    skills.save(null, '---\nname: disk-report\ndescription: 磁盘报告\n---\n# 步骤\n1. df -h\n');
    expect((await call('skill_list', {})).content).toContain('disk-report');
    expect((await call('skill_read', { skill: 'disk-report' })).content).toContain('name: disk-report');
    const skillMd = '---\nname: mcp-made\ndescription: 外部 Agent 新建的 Skill\n---\n# 步骤\n1. uptime\n';
    expect((await call('skill_save', { content: skillMd })).isError).toBe(false);
    expect(skills.find('mcp-made')?.description).toBe('外部 Agent 新建的 Skill');
    const bad = await call('skill_save', { content: '没有 front matter' });
    expect(bad.isError).toBe(true);
    settings.set('mcp.server.allowWrite', false);
    expect((await call('skill_save', { id: 'mcp-made', content: skillMd.replace('新建', '修改') })).content).toContain('允许写操作');
    expect(skills.find('mcp-made')?.description).toBe('外部 Agent 新建的 Skill');

    // 知识库：本地档案没有（登录后才有）
    const kb = await call('kb_search', { query: 'nginx 502' });
    expect(kb.isError).toBe(true);
    expect(kb.content).toContain('登录');

    // 找不到主机
    expect((await call('ssh_exec', { host: 'nope', command: 'ls' })).isError).toBe(true);

    // 只开放勾选的工具：其他 Agent 看不到、也调用不了没勾选的
    settings.set('mcp.server.tools', ['list_hosts', 'get_metrics']);
    expect(host.state().tools).toEqual(['list_hosts', 'get_metrics']);
    const limited = repo.save(null, { name: 'iterminal-ro', transport: 'HTTP', url, headers: { Authorization: `Bearer ${token}` }, defaultPermission: 'AUTO', enabled: true });
    expect((await mgr.tools(limited.id)).map((t) => t.name).sort()).toEqual(['get_metrics', 'list_hosts']);
    const denied = await mgr.call(limited.id, 'ssh_exec', { host: 'web-01', command: 'echo no' }, AbortSignal.timeout(10_000)).catch((e: Error) => ({ isError: true, content: e.message }));
    expect(denied.isError).toBe(true);
    expect(server.execs).not.toContain('echo no');
  }, 90_000);

  it('升级：以前保存过开放工具列表的，新工具自动加进去（只加一次）', () => {
    settings.set('mcp.server.tools', ['list_hosts', 'ssh_exec']);
    settings.set('mcp.server.toolsRev', 1);
    expect(host.state().tools.sort()).toEqual(['kb_search', 'list_hosts', 'note_list', 'note_read', 'note_save', 'skill_list', 'skill_read', 'skill_save', 'ssh_exec'].sort());
    // 之后用户取消勾选的不会再被加回来
    settings.set('mcp.server.tools', ['list_hosts']);
    expect(host.state().tools).toEqual(['list_hosts']);
  });

  it('Agent 的 mcp_call：上下文列出引用的 Server 的工具；AUTO 直接调用，APPROVE 要批准，DISABLED 拒绝', async () => {
    const s = repo.save(null, { name: 'tools', transport: 'STDIO', ...STDIO, defaultPermission: 'AUTO', toolPolicies: { add: 'APPROVE', fail: 'DISABLED' }, enabled: true });
    mock.enqueue(
      { toolCalls: [{ id: 'm1', name: 'mcp_call', input: { server: 'tools', tool: 'echo', arguments: { text: 'yo' } } }] },
      { toolCalls: [{ id: 'm2', name: 'mcp_call', input: { server: 'tools', tool: 'fail', arguments: {} } }] },
      { toolCalls: [{ id: 'm3', name: 'mcp_call', input: { server: 'tools', tool: 'add', arguments: { a: 1, b: 2 } } }] },
      { text: '算完了：3' },
    );
    const id = agent.create(claude).id;
    agent.send(OWNER, id, '用 MCP 工具试一下', 'agent', claude, { terminals: [], skillIds: [], mcpServerIds: [s.id] });
    const step = await waitFor(() => lastView(id)?.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : [])).find((x) => x.status === 'approval'));
    expect(step.command).toContain('add');
    agent.approve(OWNER, id, step.approvalId!, { decision: 'approve' });
    const done = await waitFor(() => {
      const v = lastView(id);
      return v && !v.running && v.messages.some((m) => m.role === 'assistant' && m.text === '算完了：3') ? v : null;
    });
    const steps = done.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : []));
    expect(steps.map((x) => [x.command.split(' ')[0], x.status])).toEqual([
      ['echo', 'done'],
      ['fail', 'rejected'],
      ['add', 'done'],
    ]);
    // 第一轮请求的上下文里列出了工具（被禁用的不列）
    const first = JSON.stringify(mock.requests[0].body.messages);
    expect(first).toContain('tools/echo');
    expect(first).toContain('tools/add');
    expect(first).not.toContain('tools/fail');
    // 第三次调用的结果回给了模型
    expect(JSON.stringify(mock.requests[3].body.messages)).toContain('<untrusted');
  }, 60_000);
});
