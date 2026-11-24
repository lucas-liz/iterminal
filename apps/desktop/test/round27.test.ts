/**
 * 第二十七轮：定时任务的执行方案（试运行 → 固化命令 → 执行 → AI 报告 / 录像 / 筛选）、无人值守时不给交互类工具、
 * 常驻监控的告警、监控卡片的「需要注意」、数据库产品。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MONITOR_ALERT,
  dbProductOf,
  type DbAssetInput,
  type IpcEventName,
  type IpcEvents,
  type LocalTaskInput,
  type MetricsSnapshot,
  type MonitorAlert,
  type PromptRequest,
  type TaskRunView,
} from '@itm/protocol';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { SettingsRepo } from '../src/main/services/settings/settings-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { SessionManager } from '../src/main/services/connection/session-manager';
import { MonitorService } from '../src/main/services/monitor/monitor-service';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import { SkillStore } from '../src/main/services/ai/skills';
import { AgentService } from '../src/main/services/ai/agent-service';
import { InlineRuntime } from '../src/main/services/ai/runtime';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { LocalScheduler } from '../src/main/services/schedule/scheduler';
import { levelFromHosts, normalizePlan, parseReportLevel, parseTrialAnswer, reportInput, runNoteInput } from '../src/main/services/schedule/plan';
import { normalizeWebhook } from '../src/main/services/schedule/sql-report';
import { BACKGROUND_OWNER, ResidentMonitor } from '../src/main/services/monitor/resident';
import { normalizeDbInput } from '../src/main/services/database/db-asset-repo';
import { attentionOf, hostMatches, uptimeMatches } from '../src/renderer/src/util/monitor-attention';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';
import { startLlmMock, type LlmMock } from './support/llm-mock';

const HOSTS = [
  { id: 'h-a', name: 'web-01' },
  { id: 'h-b', name: 'web-02' },
];

describe('执行方案：解析和报告', () => {
  it('从试运行的回答里取出最后一个 json 方案，主机名换成 ID，正文去掉方案', () => {
    const text = ['检查完成，容器都在运行。', '```json', '{"steps":[{"host":"*","command":"docker ps -a","purpose":"容器状态"},{"host":"web-02","command":"df -h /data"}],"report":"磁盘超过 85% 算需要注意"}', '```'].join('\n');
    const r = parseTrialAnswer(text, HOSTS, []);
    expect(r.fromSteps).toBe(false);
    expect(r.steps).toEqual([
      { hostId: null, command: 'docker ps -a', purpose: '容器状态' },
      { hostId: 'h-b', command: 'df -h /data', purpose: '' },
    ]);
    expect(r.report).toBe('磁盘超过 85% 算需要注意');
    expect(r.body).toBe('检查完成，容器都在运行。');
  });

  it('没有按格式给方案时，用试运行里成功执行的只读命令兜底：所有主机都执行过的合并成一条', () => {
    const steps = [
      { command: 'uptime', hostName: 'web-01', status: 'done' as const, level: 'L0' as const, exitCode: 0 },
      { command: 'uptime', hostName: 'web-02', status: 'done' as const, level: 'L0' as const, exitCode: 0 },
      { command: 'free -m', hostName: 'web-02', status: 'done' as const, level: 'L0' as const, exitCode: 0 },
      { command: 'rm -f /tmp/x', hostName: 'web-01', status: 'done' as const, level: 'L1' as const, exitCode: 0 },
      { command: 'cat /nope', hostName: 'web-01', status: 'done' as const, level: 'L0' as const, exitCode: 1 },
    ];
    const r = parseTrialAnswer('都正常', HOSTS, steps);
    expect(r.fromSteps).toBe(true);
    expect(r.steps).toEqual([
      { hostId: null, command: 'uptime', purpose: '' },
      { hostId: 'h-b', command: 'free -m', purpose: '' },
    ]);
  });

  it('整理方案：去掉空命令和重复命令，不在目标主机里的主机改成所有主机，推送只在有机器人时保留', () => {
    const p = normalizePlan(
      {
        steps: [
          { hostId: null, command: ' uptime ', purpose: '负载' },
          { hostId: null, command: 'uptime', purpose: '重复' },
          { hostId: 'gone', command: 'df -h', purpose: '' },
          { hostId: 'h-a', command: '  ', purpose: '' },
        ],
        report: '  关注磁盘  ',
        push: { when: 'ISSUES', webhooks: [] },
      },
      ['h-a'],
      normalizeWebhook,
    )!;
    expect(p.steps).toEqual([
      { hostId: null, command: 'uptime', purpose: '负载' },
      { hostId: null, command: 'df -h', purpose: '' },
    ]);
    expect(p.report).toBe('关注磁盘');
    expect(p.push).toBeNull();
    expect(() => normalizePlan({ steps: Array.from({ length: 31 }, (_, i) => ({ hostId: null, command: `echo ${i}`, purpose: '' })) }, [], normalizeWebhook)).toThrow('最多 30 条');
  });

  it('报告结论和兜底结论；报告输入按主机列出每条命令（被跳过的写原因）', () => {
    expect(parseReportLevel('结论：正常\n## 概览')).toBe('OK');
    expect(parseReportLevel('**结论：需要注意**')).toBe('WARN');
    expect(parseReportLevel('结论: 异常')).toBe('ERROR');
    expect(parseReportLevel('## 概览\n一切正常')).toBeNull();
    const hosts: TaskRunView['hosts'] = [
      { hostId: 'h-a', hostName: 'web-01', status: 'SUCCESS', exitCode: 0, output: '', message: null, steps: [{ command: 'uptime', purpose: '负载', exitCode: 0, output: 'load 0.1', durationMs: 5 }] },
      { hostId: 'h-b', hostName: 'web-02', status: 'SUCCESS', exitCode: 0, output: '', message: null, steps: [{ command: 'rm x', purpose: '', exitCode: null, output: '', skipped: 'AI 审批没有放行', durationMs: 0 }] },
    ];
    expect(levelFromHosts(hosts)).toBe('WARN');
    expect(levelFromHosts([{ ...hosts[0], status: 'FAILED' }])).toBe('ERROR');
    const input = reportInput({ name: '巡检', prompt: '看负载', goal: null, rule: '负载高于 5 算异常', hosts });
    expect(input).toContain('汇总要求：负载高于 5 算异常');
    expect(input).toContain('$ uptime    # 负载');
    expect(input).toContain('load 0.1');
    expect(input).toContain('（没有执行：AI 审批没有放行）');
  });
});

describe('定时任务：试运行 → 执行方案 → 报告', () => {
  const OWNER = 3;
  let dir: string;
  let db: Db;
  let hosts: HostRepo;
  let settings: SettingsRepo;
  let broker: PromptBroker;
  let pool: SshPool;
  let audit: AuditRepo;
  let server: TestSshServer;
  let mock: LlmMock;
  let scheduler: LocalScheduler;
  let hostId: string;
  let runs: TaskRunView[];
  let notices: string[];
  let recorded: { sessionId: string; text: string; ended: boolean }[];
  let raised: { key: string; level: string; diagnose: boolean; email: boolean; hosts: string[]; title: string }[];
  let resolved: string[];
  let approval: ApprovalEngine;
  const require = createRequire(import.meta.url);
  const wasm = {
    bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
    treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
  };

  function emit<E extends IpcEventName>(_owner: number, event: E, payload: IpcEvents[E]): void {
    if (event === 'prompt.request') setTimeout(() => broker.answer(OWNER, (payload as PromptRequest).promptId, { kind: 'hostKey', accept: true }), 1);
  }
  async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) throw new Error('等待超时');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const finished = (runId: string): Promise<TaskRunView> => waitFor(() => runs.filter((r) => r.runId === runId && r.status !== 'RUNNING').at(-1));
  const task = (p: Partial<LocalTaskInput> = {}): LocalTaskInput => ({
    name: '容器巡检',
    enabled: true,
    type: 'AGENT_PROMPT',
    command: null,
    prompt: '检查服务是否正常',
    hostIds: [hostId],
    schedule: { kind: 'daily', time: '08:00' },
    aiAssist: false,
    goal: null,
    aiPolicy: 'AI_REVIEW',
    timeoutMin: 5,
    notifyOnFailure: true,
    ...p,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'itm-r27-'));
    mkdirSync(join(dir, 'remote'));
    db = openDatabase(join(dir, 'db'), randomBytes(32));
    const vaultKey = randomBytes(32);
    const repos = createRepos(db, vaultKey);
    ({ hosts, settings } = repos);
    settings.set('ai.llmReview', false);
    audit = new AuditRepo(db);
    approval ??= await createApprovalEngine(wasm);
    broker = new PromptBroker(emit);
    pool = new SshPool(hosts, broker, 5000);
    const sessions = new SessionManager(pool, hosts, emit, (f, a, o) => pty.spawn(f, a, { name: 'xterm-256color', ...o }));
    const providers = new AiProviderRepo(db, vaultKey);
    server = await startTestSshServer({ root: join(dir, 'remote') });
    mock = await startLlmMock();
    hostId = hosts.create({
      folderId: null, name: 'web-01', address: '127.0.0.1', port: server.port, username: 'tester', authMethod: 'PASSWORD',
      password: 'pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [],
    }).id;
    const p = providers.save(null, { name: 'mock', type: 'OPENAI_COMPAT', baseUrl: mock.url, apiKey: null, enabled: true, models: [{ id: 'qwen-max', contextWindow: 32_000, maxOutput: 4000 }] });
    settings.set('ai.defaultModel', { providerId: p.id, modelId: 'qwen-max' });
    const policy = () => ({ ...DEFAULT_POLICY, unattendedCap: 'AUTO' as const, allowLlmReview: false });
    const agent = new AgentService({
      db, providers, sessions, pool, hosts, folders: repos.folders, credentials: repos.credentials, monitor: new MonitorService(pool, emit, sessions),
      skills: new SkillStore(join(dir, 'skills')), settings, audit, approval, emit, runtime: new InlineRuntime(), policy,
    });
    runs = [];
    notices = [];
    recorded = [];
    raised = [];
    resolved = [];
    scheduler = new LocalScheduler({
      db, hosts, pool, approval, policy, audit, agent,
      owner: () => OWNER,
      emitRun: (r) => runs.push(r),
      emitTasks: () => undefined,
      emitApprovals: () => undefined,
      notify: (title) => notices.push(title),
      alerts: {
        raise: (i) => void raised.push({ key: i.key, level: i.level, diagnose: i.diagnose, email: i.email, hosts: i.hosts.map((h) => h.name), title: i.title }),
        resolvePrefix: (p) => void resolved.push(p),
      },
      ask: (system, text, timeoutMs) => agent.ask(system, text, timeoutMs),
      recordings: {
        start: (meta) => {
          const r = { sessionId: meta.sessionId, text: '', ended: false };
          recorded.push(r);
          return { id: `rec-${recorded.length}`, output: (t: string) => void (r.text += t), resize: () => undefined, end: () => void (r.ended = true) };
        },
      },
    });
  });

  afterEach(async () => {
    scheduler.stop();
    pool.closeAll();
    await server.close();
    await mock.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('试运行：只读、不给提问 / 主机记忆等交互工具；回答里的方案变成命令清单', async () => {
    mock.enqueue(
      { toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 'h1', command: 'echo trial-ok', explanation: '看看' } }] },
      { text: '一切正常。\n```json\n{"steps":[{"host":"*","command":"echo plan-a","purpose":"服务状态"}],"report":"有 FAIL 算异常"}\n```' },
    );
    const r = await scheduler.trial(OWNER, 'tk-1', task({ name: '' }));
    expect(r.plan.steps).toEqual([{ hostId: null, command: 'echo plan-a', purpose: '服务状态' }]);
    expect(r.plan.report).toBe('有 FAIL 算异常');
    expect(r.plan.conversationId).toBe(r.conversationId);
    expect(r.report).toBe('一切正常。');
    const tools = (mock.requests[0].body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(tools).toContain('run_command');
    for (const name of ['ask_user', 'schedule_task', 'note_save', 'skill_save']) expect(tools).not.toContain(name);
    expect(JSON.stringify(mock.requests[0].body)).toContain('试运行');
  });

  it('保存：只读权限下方案不能有写操作；按方案执行，写操作由 AI 审批，执行完 AI 写报告，命令录像并记审计', async () => {
    const plan = { steps: [{ hostId: null, command: 'echo plan-a', purpose: '服务状态' }, { hostId: null, command: 'touch plan.flag', purpose: '写标记' }], report: '有 FAIL 算异常', generatedAt: Date.now(), conversationId: null };
    expect(() => scheduler.save(null, task({ aiPolicy: 'READONLY', plan }))).toThrow('只读');
    const t = scheduler.save(null, task({ plan }));
    expect(t.plan?.steps).toHaveLength(2);
    // AI 审批（拒绝写操作）和报告分别回答
    mock.respond((body) => {
      const s = JSON.stringify(body);
      if (s.includes('审批助手')) return { text: '{"auto": false, "reason": "没必要写文件"}' };
      if (s.includes('巡检报告助手')) return { text: '结论：需要注意\n## 概览\n服务正常，写标记被跳过。' };
      return undefined;
    });
    const { runId } = scheduler.runNow(t.id);
    const run = await finished(runId);
    expect(run.status).toBe('SUCCESS');
    expect(run.reportLevel).toBe('WARN');
    expect(run.summary).toContain('写标记被跳过');
    const h = run.hosts[0];
    expect(h.recordingId).toBe('rec-1');
    expect(h.steps?.[0]).toMatchObject({ command: 'echo plan-a', exitCode: 0, purpose: '服务状态' });
    expect(h.steps?.[0].output).toContain('plan-a');
    expect(h.steps?.[1].skipped).toContain('没必要写文件');
    expect(h.message).toContain('1 条没有执行');
    expect(recorded[0].sessionId).toBe(`schedule:${runId}:${hostId}`);
    expect(recorded[0].text).toContain('echo plan-a');
    expect(recorded[0].ended).toBe(true);
    const rows = db.prepare<[], { session_id: string; command: string; decision: string }>("SELECT session_id, command, decision FROM audit_log WHERE kind = 'COMMAND' ORDER BY created_at").all();
    expect(rows.map((r) => [r.command, r.decision])).toEqual([
      ['echo plan-a', 'AUTO'],
      ['touch plan.flag', 'DENIED'],
    ]);
    expect(rows.every((r) => r.session_id === `schedule:${runId}:${hostId}`)).toBe(true);
    // 结论不是正常时发通知
    expect(notices.some((n) => n.includes('需要注意'))).toBe(true);
    // 执行记录按主机、状态、关键字筛选
    expect(scheduler.runs({ hostId }).total).toBe(1);
    expect(scheduler.runs({ hostId: 'other' }).total).toBe(0);
    expect(scheduler.runs({ status: 'ISSUES' }).total).toBe(1);
    expect(scheduler.runs({ status: 'FAILED' }).total).toBe(0);
    expect(scheduler.runs({ q: '写标记被跳过' }).total).toBe(1);
    expect(scheduler.runs({ q: '没有这个词' }).total).toBe(0);
  });

  it('告警设置（第二十八轮）：失败时告警并自动排查失败的主机；之后执行正常时之前的告警恢复；不告警时不记录', async () => {
    const t = scheduler.save(null, task({ type: 'COMMAND', command: 'exit 3', prompt: null, alert: { when: 'ISSUES', email: true } }));
    expect(t.alert).toEqual({ when: 'ISSUES', email: true });
    await finished(scheduler.runNow(t.id).runId);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ level: 'CRIT', diagnose: true, email: true, hosts: ['web-01'] });
    expect(raised[0].title).toContain('失败');
    expect(raised[0].key.startsWith(`schedule:${t.id}:`)).toBe(true);
    scheduler.save(t.id, task({ type: 'COMMAND', command: 'echo ok', prompt: null, alert: { when: 'ISSUES', email: true } }));
    await finished(scheduler.runNow(t.id).runId);
    expect(raised).toHaveLength(1);
    expect(resolved).toContain(`schedule:${t.id}:`);
    // 每次结束都通知：成功也记录，但不排查
    scheduler.save(t.id, task({ type: 'COMMAND', command: 'echo ok', prompt: null, alert: { when: 'ALWAYS', email: false } }));
    await finished(scheduler.runNow(t.id).runId);
    expect(raised[1]).toMatchObject({ level: 'INFO', diagnose: false, email: false });
    const n = scheduler.save(null, task({ name: '不告警', type: 'COMMAND', command: 'exit 1', prompt: null, alert: { when: 'NEVER', email: true } }));
    expect(n.alert).toBeNull();
    await finished(scheduler.runNow(n.id).runId);
    expect(raised).toHaveLength(2);
  });

  it('「保存时我确认」：方案里的写操作照清单执行', async () => {
    const t = scheduler.save(null, task({ aiPolicy: 'APPROVE', plan: { steps: [{ hostId: null, command: 'touch plan.flag', purpose: '' }], report: '', generatedAt: null, conversationId: null } }));
    mock.respond((body) => (JSON.stringify(body).includes('巡检报告助手') ? { text: '结论：正常\n已写入标记。' } : undefined));
    const run = await finished(scheduler.runNow(t.id).runId);
    expect(run.hosts[0].steps?.[0]).toMatchObject({ exitCode: 0, note: '保存执行方案时你已确认' });
    expect(run.reportLevel).toBe('OK');
  });

  // ---------------------------------------------------------------- 第二十九轮：后台生成执行方案、执行结果整理成笔记

  const genAnswer = '检查完成。\n```json\n{"steps":[{"host":"*","command":"echo gen-ok","purpose":"服务状态"},{"host":"*","command":"touch gen.flag","purpose":"写标记"}],"report":"有 FAIL 算异常"}\n```';

  it('后台生成（第二十九轮）：保存后在后台试运行，生成好后自动设置；「保存时我确认」下写操作待确认，执行时跳过，保存后才执行', async () => {
    mock.enqueue({ text: genAnswer });
    const t = scheduler.save(null, task({ aiPolicy: 'APPROVE' }), 'USER', { generatePlan: true });
    expect(t.planGen?.status).toBe('RUNNING');
    expect(() => scheduler.runNow(t.id)).toThrow('还在后台生成');
    const done = await waitFor(() => (scheduler.get(t.id)?.planGen?.status === 'DONE' ? scheduler.get(t.id) : null));
    expect(done!.plan?.steps).toEqual([
      { hostId: null, command: 'echo gen-ok', purpose: '服务状态' },
      { hostId: null, command: 'touch gen.flag', purpose: '写标记', confirm: true },
    ]);
    expect(done!.plan?.report).toBe('有 FAIL 算异常');
    expect(done!.planGen?.message).toContain('1 条写操作等你确认');
    expect(done!.planGen?.report).toBe('检查完成。');
    expect(notices.some((n) => n.includes('执行方案已生成'))).toBe(true);
    // 待确认的写操作不执行
    mock.respond((body) => (JSON.stringify(body).includes('巡检报告助手') ? { text: '结论：需要注意\n写标记没有执行。' } : undefined));
    const run = await finished(scheduler.runNow(t.id).runId);
    expect(run.hosts[0].steps?.[0]).toMatchObject({ command: 'echo gen-ok', exitCode: 0 });
    expect(run.hosts[0].steps?.[1].skipped).toContain('还没有确认');
    // 在编辑框里保存 = 确认
    const { planGen: _g, ...input } = done!;
    const saved = scheduler.save(t.id, { ...input, plan: done!.plan } as LocalTaskInput, 'USER', { generatePlan: true });
    expect(saved.plan?.steps.some((st) => st.confirm)).toBe(false);
    expect(saved.planGen?.status).toBe('DONE');
    // 执行结果整理成笔记的输入：报告和每条命令的输出
    const view = scheduler.run(run.runId)!;
    const note = runNoteInput(view, '2026-10-21 08:00');
    expect(note).toContain('写标记没有执行');
    expect(note).toContain('$ echo gen-ok');
    expect(note).toContain('gen-ok');
  });

  it('后台生成：「只读」权限下去掉写操作；生成失败时记录原因，按计划执行时不让 Agent 自由执行；可以取消', async () => {
    mock.enqueue({ text: genAnswer });
    const t = scheduler.save(null, task({ aiPolicy: 'READONLY' }), 'USER', { generatePlan: true });
    const done = await waitFor(() => (scheduler.get(t.id)?.planGen?.status === 'DONE' ? scheduler.get(t.id) : null));
    expect(done!.plan?.steps.map((st) => st.command)).toEqual(['echo gen-ok']);
    expect(done!.planGen?.message).toContain('去掉了 1 条写操作');

    // 没有给出方案：失败
    mock.enqueue({ text: '我不知道该检查什么。' });
    const f = scheduler.save(null, task({ name: '失败的任务' }), 'USER', { generatePlan: true });
    const failed = await waitFor(() => (scheduler.get(f.id)?.planGen?.status === 'FAILED' ? scheduler.get(f.id) : null));
    expect(failed!.plan).toBeNull();
    const run = await finished(scheduler.runNow(f.id).runId);
    expect(run.status).toBe('FAILED');
    expect(run.summary).toContain('还没有执行方案');

    // 取消
    const c = scheduler.save(null, task({ name: '取消的任务' }), 'USER', { generatePlan: true });
    expect(scheduler.cancelPlanGen(c.id).planGen).toMatchObject({ status: 'FAILED', message: '已取消生成' });
    // 不传 generatePlan：保持原来的行为
    const legacy = scheduler.save(null, task({ name: '旧行为' }));
    expect(legacy.planGen).toBeNull();
  });
});

describe('常驻监控', () => {
  const ok = (hostId: string, cpu: number, mem = 10, disk = 10): MetricsSnapshot => ({
    hostId,
    ts: 0,
    state: 'ok',
    hostname: 'x',
    kernel: 'k',
    uptimeSec: 86_400 * 3,
    load: [0.1, 0.1, 0.1],
    cpu: { usage: cpu, user: cpu, system: 0, iowait: 0, cores: 4 },
    tempC: null,
    mem: { total: 100, used: mem, available: 100 - mem, swapTotal: 0, swapUsed: 0 },
    disks: [{ mount: '/', fs: 'ext4', size: 100, used: disk, usePct: disk }],
    diskIo: null,
    net: [],
    gpus: [],
    procs: [],
  });

  it('后台订阅常驻主机；CPU 超过阈值持续够久才告警并通知一次，恢复后告警消失；连不上超过 2 分钟告警', () => {
    let now = 1_000_000;
    let listener: ((s: MetricsSnapshot) => void) | null = null;
    const subs: string[] = [];
    const latest = new Map<string, MetricsSnapshot>();
    const notices: string[] = [];
    let alerts: MonitorAlert[] = [];
    let ids = ['h1'];
    const r = new ResidentMonitor({
      monitor: {
        subscribe: (owner, id) => void subs.push(`+${owner}:${id}`),
        unsubscribe: (owner, id) => void subs.push(`-${owner}:${id}`),
        restart: () => true,
        latest: (id) => latest.get(id) ?? null,
        onSnapshot: (fn) => {
          listener = fn;
          return () => (listener = null);
        },
      },
      hostIds: () => ids,
      config: () => ({ ...DEFAULT_MONITOR_ALERT, sustainMin: 3 }),
      disabled: () => false,
      hostName: (id) => `主机${id}`,
      notify: (t, b) => void notices.push(`${t}|${b}`),
      emit: (l) => (alerts = l),
      now: () => now,
    });
    r.start();
    expect(subs).toEqual([`+${BACKGROUND_OWNER}:h1`]);
    const push = (s: MetricsSnapshot): void => {
      latest.set(s.hostId, s);
      listener!(s);
    };
    push(ok('h1', 95));
    expect(alerts).toEqual([]);
    now += 3 * 60_000;
    push(ok('h1', 96));
    expect(alerts).toMatchObject([{ hostId: 'h1', kind: 'cpu', notified: true }]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('主机h1');
    now += 60_000;
    push(ok('h1', 97));
    expect(notices).toHaveLength(1);
    push(ok('h1', 20, 10, 95));
    expect(alerts.map((a) => a.kind)).toEqual(['disk']);
    // 连不上
    push({ hostId: 'h1', ts: 0, state: 'error', message: '连接超时' });
    expect(alerts.map((a) => a.kind)).toEqual([]);
    now += 2 * 60_000 + 1;
    r.tick();
    expect(alerts.map((a) => a.kind)).toEqual(['offline']);
    // 从常驻里移除：取消订阅，告警清掉
    ids = [];
    r.sync();
    expect(subs.at(-1)).toBe(`-${BACKGROUND_OWNER}:h1`);
    expect(alerts).toEqual([]);
    r.stop();
  });

  it('后台连接（owner < 0）需要输入密码时直接拒绝，不等超时', async () => {
    const broker = new PromptBroker(() => undefined, 60_000);
    const ans = await broker.ask(BACKGROUND_OWNER, { kind: 'password', hostName: 'x', username: 'u', message: '', forPassphrase: false, rememberable: false } as never);
    expect(ans).toEqual({ kind: 'password', value: null, remember: false });
  });

  it('卡片上需要注意的地方：按阈值分注意 / 告警，带上持续时间；搜索和运行时长筛选', () => {
    const cfg = DEFAULT_MONITOR_ALERT;
    expect(attentionOf(undefined, cfg).level).toBe('pending');
    expect(attentionOf({ hostId: 'h', ts: 0, state: 'error', message: '拒绝连接' }, cfg)).toEqual({ level: 'offline', items: [{ level: 'crit', kind: 'offline', text: '拒绝连接' }] });
    expect(attentionOf(ok('h', 10), cfg)).toEqual({ level: 'ok', items: [] });
    // 内存 74% 不算需要注意（阈值 90，80 起才提醒）
    expect(attentionOf(ok('h', 10, 74), cfg).level).toBe('ok');
    const a = attentionOf(ok('h', 95, 85, 80), cfg, [{ mount: '/', usedPct: 80, slopePerDay: 10, daysToFull: 1.5, samples: 100 }], [{ hostId: 'h', kind: 'cpu', text: '', since: 0, notified: true }], 5 * 60_000);
    expect(a.level).toBe('crit');
    expect(a.items.map((i) => [i.level, i.text])).toEqual([
      ['crit', 'CPU 95%，已持续 5 分钟'],
      ['crit', '/ 约 1.5 天写满'],
      ['warn', '内存 85%'],
      ['warn', '/ 80%'],
    ]);
    const h = { name: 'web-01', address: '10.0.0.8', note: '订单服务', tags: ['prod'], osInfo: null, username: 'root' };
    expect(hostMatches(h, '订单 10.0.0')).toBe(true);
    expect(hostMatches(h, 'prod web')).toBe(true);
    expect(hostMatches(h, 'db')).toBe(false);
    expect(uptimeMatches(3600, 'recent')).toBe(true);
    expect(uptimeMatches(40 * 86_400, 'month')).toBe(true);
    expect(uptimeMatches(40 * 86_400, 'half')).toBe(false);
    expect(uptimeMatches(null, 'recent')).toBe(false);
  });
});

describe('数据库产品', () => {
  const base: DbAssetInput = {
    name: 'tidb', type: 'MYSQL', flavor: 'tidb', host: '10.0.0.1', port: 4000, database: '', username: 'root', credentialId: null, ssl: 'OFF', viaHostId: null, filePath: null,
    agentPolicy: null, production: false, sqlDenylist: [], note: null,
  };
  it('产品必须属于这个类型，旧记录按类型显示', () => {
    expect(normalizeDbInput(base).flavor).toBe('tidb');
    expect(normalizeDbInput({ ...base, flavor: 'greenplum' }).flavor).toBeNull();
    expect(normalizeDbInput({ ...base, flavor: 'redis' }).flavor).toBeNull();
    expect(dbProductOf({ type: 'MYSQL', flavor: 'tidb' }).label).toBe('TiDB');
    expect(dbProductOf({ type: 'POSTGRES' }).id).toBe('postgres');
    expect(dbProductOf({ type: 'MYSQL', flavor: 'cockroach' }).id).toBe('mysql');
  });
});
