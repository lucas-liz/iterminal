import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApprovalEngine, DEFAULT_POLICY, type ApprovalEngine } from '@itm/approval';
import type { AgentConversationView, AgentStep, Folder, Host, IpcEventName, IpcEvents, ModelRef, PromptRequest, SkillRunHost, SkillRunView } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SessionManager } from '../src/main/services/connection/session-manager';
import { MonitorService } from '../src/main/services/monitor/monitor-service';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import { parseSkill, SkillStore } from '../src/main/services/ai/skills';
import { AgentService } from '../src/main/services/ai/agent-service';
import { InlineRuntime } from '../src/main/services/ai/runtime';
import { BatchApprovals, resolveSkillTargets, runSkillJob, type SkillJob } from '../src/main/services/ai/skill-runner';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';
import { startLlmMock, type LlmMock } from './support/llm-mock';

describe('SKILL.md 解析', () => {
  it('读出 front matter 的全部字段；缺失或不合法时用默认值', () => {
    const s = parseSkill(
      'health',
      `---
name: host-health-check
title: 主机健康巡检
description: 一次查完
version: 1.4.0
allowed-tools: [ssh_exec, get_metrics]
risk: write-needs-approval
triggers: [巡检, health]
hosts: ["folder:生产环境", "tag:web"]
mode: parallel
concurrency: 6
on-error: stop
output: raw
params:
  - { name: disk_threshold, type: number, default: 80 }
  - { name: verbose, type: boolean, default: "true" }
---
# 正文`,
    );
    expect(s).toMatchObject({
      id: 'health',
      name: 'host-health-check',
      title: '主机健康巡检',
      version: '1.4.0',
      allowedTools: ['ssh_exec', 'get_metrics'],
      risk: 'write-needs-approval',
      triggers: ['巡检', 'health'],
      hosts: ['folder:生产环境', 'tag:web'],
      mode: 'parallel',
      concurrency: 6,
      onError: 'stop',
      output: 'raw',
      params: [
        { name: 'disk_threshold', type: 'number', default: 80 },
        { name: 'verbose', type: 'boolean', default: true },
      ],
    });
    const d = parseSkill('plain', '# 没有 front matter');
    expect(d).toMatchObject({ name: 'plain', title: 'plain', mode: 'single', risk: 'readonly', concurrency: 4, onError: 'continue', output: 'summary', params: [] });
    expect(parseSkill('bad', '---\nname: [unclosed\nrisk: whatever\n---\n正文')).toMatchObject({ name: 'bad', risk: 'readonly' });
    expect(parseSkill('x', '---\nrisk: nuke\nconcurrency: -3\n---\n')).toMatchObject({ risk: 'readonly', concurrency: 4 });
  });
});

const host = (id: string, name: string, o: Partial<Host> = {}): Host => ({ id, name, protocol: 'SSH', folderId: null, tags: [], address: `10.0.0.${id}`, ...o }) as Host;
const folder = (id: string, name: string, path: string): Folder => ({ id, name, path }) as Folder;

describe('Skill 目标', () => {
  const folders = [folder('f1', '生产环境', '/f1/'), folder('f2', '订单', '/f1/f2/'), folder('f3', '测试', '/f3/')];
  const hosts = [
    host('1', 'web-01', { folderId: 'f1', tags: ['web'] }),
    host('2', 'order-01', { folderId: 'f2' }),
    host('3', 'test-01', { folderId: 'f3', tags: ['Web'] }),
    host('4', 'switch', { folderId: 'f1', protocol: 'TELNET' }),
  ];

  it('主机、分组（含子分组）、标签去重合并；只保留 SSH 主机', () => {
    const r = resolveSkillTargets({ hostIds: ['1'], folderIds: ['f1'], tags: ['WEB'] }, [], hosts, folders);
    expect(r.hosts.map((h) => h.name).sort()).toEqual(['order-01', 'test-01', 'web-01']);
    expect(r.skipped).toBe(1);
  });

  it('没有指定目标时用 Skill 声明的默认目标', () => {
    expect(resolveSkillTargets({}, ['folder:测试', 'order-01'], hosts, folders).hosts.map((h) => h.name).sort()).toEqual(['order-01', 'test-01']);
    expect(resolveSkillTargets({}, ['tag:web'], hosts, folders).hosts).toHaveLength(2);
    // 指定了目标就不再用默认目标
    expect(resolveSkillTargets({ hostIds: ['2'] }, ['tag:web'], hosts, folders).hosts.map((h) => h.name)).toEqual(['order-01']);
  });
});

const step = (hostName: string, command: string): AgentStep => ({
  id: command,
  tool: 'run_command',
  hostLabel: 'h1',
  hostName,
  command,
  level: 'L1',
  reasons: ['写操作'],
  status: 'pending',
  decision: 'APPROVE',
  exitCode: null,
  output: '',
  startedAt: 0,
  finishedAt: null,
});

describe('批量审批', () => {
  it('攒成一张卡片，按勾选的主机批准，其余拒绝', async () => {
    const cards: AgentStep[] = [];
    const b = new BatchApprovals({
      ask: async (card) => {
        cards.push(card);
        return { decision: 'approve', hosts: ['2'] };
      },
      allBlocked: () => false,
      quietMs: 20,
    });
    const [r1, r2] = await Promise.all([b.request('web-01', step('web-01', 'touch a')), b.request('web-02', step('web-02', 'touch b'))]);
    expect(cards).toHaveLength(1);
    expect(cards[0].batch?.map((x) => [x.hostName, x.command])).toEqual([
      ['web-01', 'touch a'],
      ['web-02', 'touch b'],
    ]);
    expect(r1.decision).toBe('reject');
    expect(r2.decision).toBe('approve');
  });

  it('所有子 Agent 都在等审批时立即出卡片；停止时全部拒绝', async () => {
    let asked = 0;
    const b = new BatchApprovals({ ask: async () => (asked++, { decision: 'approve' }), allBlocked: () => true, quietMs: 10_000 });
    expect((await b.request('a', step('a', 'x'))).decision).toBe('approve');
    expect(asked).toBe(1);
    const never = new BatchApprovals({ ask: () => new Promise(() => undefined), allBlocked: () => false, quietMs: 10_000 });
    const p = never.request('a', step('a', 'x'));
    never.rejectAll();
    expect((await p).decision).toBe('reject');
  });
});

function view(names: string[], mode: 'single' | 'parallel' = 'parallel'): SkillRunView {
  return {
    runId: 'r',
    skillId: 's',
    skillName: '巡检',
    mode,
    risk: 'readonly',
    concurrency: 2,
    params: {},
    hosts: names.map((n, i) => ({ hostId: String(i), name: n, status: 'queued', result: '', error: null, commands: [], startedAt: null, finishedAt: null })),
    summary: null,
    status: 'running',
    startedAt: 0,
    finishedAt: null,
  };
}
function job(v: SkillRunView, o: Partial<SkillJob>): SkillJob {
  return {
    view: v,
    hosts: v.hosts.map((h) => host(h.hostId, h.name)),
    concurrency: 2,
    onError: 'continue',
    output: 'summary',
    runOne: async (hs) => `ok:${hs[0].name}`,
    summarize: async (rows) => `汇总 ${rows.filter((r) => r.status === 'done').length} 台`,
    ask: async () => ({ decision: 'reject' }),
    askSingle: async () => ({ decision: 'reject' }),
    update: () => undefined,
    ...o,
  };
}

describe('Skill 执行编排', () => {
  it('并行：同时运行的不超过 concurrency；全部完成后汇总', async () => {
    const v = view(['a', 'b', 'c', 'd', 'e']);
    let running = 0;
    let max = 0;
    await runSkillJob(
      job(v, {
        runOne: async (hs) => {
          running++;
          max = Math.max(max, running);
          await new Promise((r) => setTimeout(r, 20));
          running--;
          return `ok:${hs[0].name}`;
        },
      }),
      new AbortController().signal,
    );
    expect(max).toBe(2);
    expect(v.hosts.every((h) => h.status === 'done')).toBe(true);
    expect(v.hosts[2].result).toBe('ok:c');
    expect(v).toMatchObject({ status: 'done', summary: '汇总 5 台' });
  });

  it('on-error: stop：第一台失败就取消其余；continue 时其余照常执行', async () => {
    const failB = async (hs: Host[]): Promise<string> => {
      await new Promise((r) => setTimeout(r, hs[0].name === 'b' ? 5 : 30));
      if (hs[0].name === 'b') throw new Error('连接失败');
      return 'ok';
    };
    const v = view(['a', 'b', 'c', 'd']);
    await runSkillJob(job(v, { onError: 'stop', runOne: (hs, _ui, _rows, signal) => failB(hs).then((t) => (signal.aborted ? Promise.reject(new Error('已停止')) : t)) }), new AbortController().signal);
    const st = Object.fromEntries(v.hosts.map((h: SkillRunHost) => [h.name, h.status]));
    expect(st.b).toBe('error');
    expect(st.c).toBe('canceled');
    expect(st.d).toBe('canceled');
    expect(v.hosts.find((h) => h.name === 'b')?.error).toBe('连接失败');

    const v2 = view(['a', 'b', 'c']);
    await runSkillJob(job(v2, { runOne: failB }), new AbortController().signal);
    expect(v2.hosts.map((h) => h.status)).toEqual(['done', 'error', 'done']);
    expect(v2.summary).toBe('汇总 2 台');
  });

  it('停止：未完成的标记为已取消，状态为 stopped；raw 输出不调用汇总', async () => {
    const ac = new AbortController();
    const v = view(['a', 'b']);
    const p = runSkillJob(
      job(v, { runOne: (_hs, _ui, _rows, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('已停止')))) }),
      ac.signal,
    );
    setTimeout(() => ac.abort(), 20);
    await p;
    expect(v.status).toBe('stopped');
    expect(v.hosts.map((h) => h.status)).toEqual(['canceled', 'canceled']);

    let summarized = false;
    const v3 = view(['a']);
    await runSkillJob(job(v3, { output: 'raw', summarize: async () => ((summarized = true), '') }), new AbortController().signal);
    expect(summarized).toBe(false);
    expect(v3.status).toBe('done');
  });
});

// ---------------------------------------------------------------- 端到端：真实的 Agent 循环、审批引擎、SSH 执行

const OWNER = 3;
const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
let approval: ApprovalEngine;

describe('Skill 运行（Agent）', () => {
  let dir: string;
  let db: Db;
  let server: TestSshServer;
  let mock: LlmMock;
  let agent: AgentService;
  let views: AgentConversationView[];
  let claude: ModelRef;
  let hostIds: string[];
  let pool: SshPool;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'itm-skill-'));
    mkdirSync(join(dir, 'remote'));
    db = openDatabase(join(dir, 'db'), randomBytes(32));
    const key = randomBytes(32);
    const { hosts, settings, credentials, folders } = createRepos(db, key);
    settings.set('ai.llmReview', false);
    approval ??= await createApprovalEngine(wasm);
    views = [];
    let broker: PromptBroker;
    const emit = <E extends IpcEventName>(_o: number, event: E, payload: IpcEvents[E]): void => {
      if (event === 'agent.update') views.push(payload as AgentConversationView);
      if (event === 'prompt.request') setTimeout(() => broker.answer(OWNER, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true }), 1);
    };
    broker = new PromptBroker(emit);
    pool = new SshPool(hosts, broker, 5000);
    const sessions = new SessionManager(pool, hosts, emit, (f, a, o) => pty.spawn(f, a, { name: 'xterm-256color', ...o }));
    const providers = new AiProviderRepo(db, key);
    const skills = new SkillStore(join(dir, 'skills'));
    server = await startTestSshServer({ root: join(dir, 'remote'), sftpRealPaths: true });
    mock = await startLlmMock();
    const f = folders.create(null, '生产环境');
    hostIds = ['web-01', 'web-02', 'web-03'].map(
      (name) =>
        hosts.create({
          folderId: f.id, name, address: '127.0.0.1', port: server.port, username: 'tester', authMethod: 'PASSWORD',
          password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
        }).id,
    );
    agent = new AgentService({
      db, providers, sessions, pool, hosts, folders, credentials, skills, settings, approval, emit,
      audit: new AuditRepo(db),
      monitor: new MonitorService(pool, emit, sessions),
      runtime: new InlineRuntime(),
      policy: () => ({ ...DEFAULT_POLICY, nightWindow: settings.get('ai.nightWindow'), allowLlmReview: false }),
    });
    const cp = providers.save(null, {
      name: 'Claude', type: 'ANTHROPIC', baseUrl: mock.url, apiKey: 'k', enabled: true,
      models: [{ id: 'claude-opus-5-5', contextWindow: 200_000, maxOutput: 8000 }],
    });
    claude = { providerId: cp.id, modelId: 'claude-opus-5-5' };
    mkdirSync(join(dir, 'skills', 'touch-flag'), { recursive: true });
    writeFileSync(
      join(dir, 'skills', 'touch-flag', 'SKILL.md'),
      `---\nname: touch-flag\ntitle: 打标记\ndescription: 在每台主机上创建标记文件\nmode: parallel\nconcurrency: 3\nrisk: write-needs-approval\nallowed-tools: [ssh_exec]\nparams:\n  - { name: flag, type: string, default: done }\n---\n在 /tmp 下创建 {{flag}} 标记文件。`,
    );
    mkdirSync(join(dir, 'skills', 'readonly-check'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'readonly-check', 'SKILL.md'), `---\nname: readonly-check\ntitle: 只读检查\nmode: parallel\nrisk: readonly\nhosts: ["folder:生产环境"]\n---\n检查即可。`);
  });

  afterEach(async () => {
    pool.closeAll();
    await server.close();
    await mock.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const last = (id: string): AgentConversationView | undefined => views.filter((v) => v.id === id).at(-1);
  async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** 子 Agent：没有工具结果时执行一条命令，有了就给结论；汇总请求返回固定文字 */
  function script(command: (hostName: string) => string): void {
    mock.respond((body) => {
      const sys = JSON.stringify(body.system ?? '');
      if (sys.includes('汇总')) return { text: '整体正常，3 台都已处理。' };
      const msgs = JSON.stringify(body.messages);
      const name = /只处理 h1（([^）]+)）/.exec(msgs)?.[1] ?? '?';
      if (msgs.includes('tool_result')) return { text: `${name} 已完成` };
      return { toolCalls: [{ id: `c-${name}`, name: 'run_command', input: { host: 'h1', command: command(name) } }] };
    });
  }

  it('并行执行、写操作合并成一张批量审批卡片，按勾选执行；结果存进对话', async () => {
    script((name) => `touch /tmp/flag-ok-${name}`);
    const { conversationId: id } = agent.runSkill(OWNER, 'touch-flag', { hostIds }, { flag: 'ok' }, claude);
    const card = await waitFor(() => last(id)?.messages.flatMap((m) => (m.role === 'assistant' ? m.steps : [])).find((s) => s.status === 'approval' && s.batch));
    expect(card.batch?.map((b) => b.hostName).sort()).toEqual(['web-01', 'web-02', 'web-03']);
    expect(card.batch?.[0].command).toMatch(/^touch \/tmp\/flag-ok-web-0\d$/);
    // 只批准第一台和第三台
    const pick = card.batch!.filter((b) => b.hostName !== 'web-02').map((b) => b.label);
    agent.approve(OWNER, id, card.approvalId!, { decision: 'approve', hosts: pick });
    const done = await waitFor(() => {
      const v = last(id);
      return v && !v.running && v.messages.some((m) => m.role === 'assistant' && m.skillRun?.status === 'done') ? v : null;
    });
    expect(server.execs.filter((e) => e.startsWith('touch /tmp/flag-ok-')).sort()).toEqual(['touch /tmp/flag-ok-web-01', 'touch /tmp/flag-ok-web-03']);
    const run = done.messages.find((m) => m.role === 'assistant' && m.skillRun)!;
    if (run.role !== 'assistant') throw new Error('x');
    expect(run.skillRun!.hosts.map((h) => h.status)).toEqual(['done', 'done', 'done']);
    expect(run.skillRun!.summary).toBe('整体正常，3 台都已处理。');
    expect(run.text).toContain('web-02');
    expect(done.title).toBe('Skill：打标记');
    // 子 Agent 只看到 Skill 允许的工具，参数代入了正文
    const firstReq = mock.requests.find((r) => JSON.stringify(r.body.messages).includes('只处理 h1'))!;
    expect((firstReq.body.tools as { name: string }[]).map((t) => t.name)).toEqual(['run_command']);
    expect(JSON.stringify(firstReq.body.messages)).toContain('在 /tmp 下创建 ok 标记文件');
  });

  it('只读 Skill：子 Agent 的写操作被拒绝；默认目标来自 hosts 声明', async () => {
    script((name) => `touch /tmp/should-not-${name}`);
    const { conversationId: id } = agent.runSkill(OWNER, 'readonly-check', {}, {}, claude);
    const done = await waitFor(() => {
      const v = last(id);
      return v && !v.running && v.messages.some((m) => m.role === 'assistant' && m.skillRun) ? v : null;
    });
    expect(server.execs.some((e) => e.includes('should-not'))).toBe(false);
    const run = done.messages.find((m) => m.role === 'assistant' && m.skillRun)!;
    if (run.role !== 'assistant') throw new Error('x');
    expect(run.skillRun!.hosts).toHaveLength(3);
    expect(run.skillRun!.hosts[0].commands[0]).toMatchObject({ status: 'rejected' });
    // 子 Agent 收到的工具结果说明了被拒绝的原因
    expect(JSON.stringify(mock.requests.map((r) => r.body.messages))).toMatch(/只读/);
  });
});
