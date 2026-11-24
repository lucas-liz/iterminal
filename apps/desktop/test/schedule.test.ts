import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import * as pty from 'node-pty';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cronNext,
  describeSchedule,
  nextRunAt,
  validateSchedule,
  type IpcEventName,
  type IpcEvents,
  type LocalTaskInput,
  type PromptRequest,
  type ScheduleApproval,
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
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';
import { startLlmMock, type LlmMock } from './support/llm-mock';

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();

describe('执行计划', () => {
  const thu = at(2026, 10, 15, 10, 7); // 2026-10-15 是星期四

  it('cron：步长、星期、日和周同时限定时满足其一；写错时给出原因', () => {
    expect(cronNext('*/15 * * * *', thu)).toBe(at(2026, 10, 15, 10, 15));
    expect(cronNext('0 2 * * 1', thu)).toBe(at(2026, 10, 19, 2, 0));
    expect(cronNext('30 9 1-5 * *', thu)).toBe(at(2026, 11, 1, 9, 30));
    expect(cronNext('0 0 1 * 1', thu)).toBe(at(2026, 10, 19, 0, 0));
    expect(cronNext('0 0 * * 7', thu)).toBe(at(2026, 10, 18, 0, 0));
    expect(validateSchedule({ kind: 'cron', cron: '61 * * * *' })).toContain('超出范围');
    expect(validateSchedule({ kind: 'cron', cron: '* * *' })).toContain('5 段');
    expect(validateSchedule({ kind: 'cron', cron: '0 0 30 2 *' }, thu)).toContain('不会触发');
  });

  it('每隔 / 每天 / 每周 / 每月 / 一次；中文说明', () => {
    expect(nextRunAt({ kind: 'interval', everyMin: 30 }, thu)).toBe(thu + 30 * 60_000);
    expect(nextRunAt({ kind: 'daily', time: '02:00' }, thu)).toBe(at(2026, 10, 16, 2, 0));
    expect(nextRunAt({ kind: 'daily', time: '23:30' }, thu)).toBe(at(2026, 10, 15, 23, 30));
    expect(nextRunAt({ kind: 'weekly', time: '09:00', weekdays: [1, 3] }, thu)).toBe(at(2026, 10, 19, 9, 0));
    // 没有 31 号的月份跳过
    expect(nextRunAt({ kind: 'monthly', time: '03:00', monthDay: 31 }, at(2026, 11, 1))).toBe(at(2026, 12, 31, 3, 0));
    expect(nextRunAt({ kind: 'once', at: at(2026, 10, 20, 8, 0) }, thu)).toBe(at(2026, 10, 20, 8, 0));
    expect(nextRunAt({ kind: 'once', at: at(2026, 10, 1) }, thu)).toBeNull();
    expect(validateSchedule({ kind: 'once', at: at(2026, 10, 1) }, thu)).toBe('执行时间已经过去');
    expect(validateSchedule({ kind: 'daily', time: '25:00' })).toContain('HH:mm');
    expect(validateSchedule({ kind: 'weekly', time: '09:00', weekdays: [] })).toBe('请选择星期几');
    expect(describeSchedule({ kind: 'interval', everyMin: 120 })).toBe('每 2 小时');
    expect(describeSchedule({ kind: 'weekly', time: '09:00', weekdays: [3, 1] })).toBe('每周一、三 09:00');
    expect(describeSchedule({ kind: 'monthly', time: '03:00', monthDay: 1 })).toBe('每月 1 日 03:00');
  });
});

describe('本机定时任务', () => {
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
  let approvals: ScheduleApproval[];
  let notices: string[];
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
    name: '巡检',
    enabled: true,
    type: 'COMMAND',
    command: 'echo sched-ok',
    prompt: null,
    hostIds: [hostId],
    schedule: { kind: 'daily', time: '02:00' },
    aiAssist: false,
    goal: null,
    aiPolicy: 'APPROVE',
    timeoutMin: 5,
    notifyOnFailure: true,
    ...p,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'itm-sched-'));
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
    approvals = [];
    notices = [];
    scheduler = new LocalScheduler({
      db, hosts, pool, approval, policy, audit, agent,
      owner: () => OWNER,
      emitRun: (r) => runs.push(r),
      emitTasks: () => undefined,
      emitApprovals: (l) => (approvals = l),
      notify: (title) => notices.push(title),
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

  it('校验输入；立即执行命令任务，记录执行结果和审计', async () => {
    expect(() => scheduler.save(null, task({ hostIds: [] }))).toThrow('请选择目标主机');
    expect(() => scheduler.save(null, task({ command: ' ' }))).toThrow('请填写要执行的命令');
    expect(() => scheduler.save(null, task({ schedule: { kind: 'cron', cron: 'x' } }))).toThrow('5 段');
    const t = scheduler.save(null, task());
    expect(t.nextRunAt).toBeGreaterThan(Date.now());
    expect(t.createdBy).toBe('USER');

    const { runId } = scheduler.runNow(t.id);
    const run = await finished(runId);
    expect(run).toMatchObject({ status: 'SUCCESS', origin: 'LOCAL', taskName: '巡检' });
    expect(run.hosts[0].output).toContain('sched-ok');
    expect(scheduler.get(t.id)?.lastStatus).toBe('SUCCESS');
    expect(scheduler.runs({ limit: 10, offset: 0, taskId: t.id }).items.map((r) => r.runId)).toEqual([runId]);
    const rows = db.prepare<[], { source: string; command: string; decision: string }>("SELECT source, command, decision FROM audit_log WHERE kind = 'COMMAND'").all();
    expect(rows).toEqual([{ source: 'SCHEDULE', command: 'echo sched-ok', decision: 'AUTO' }]);
    const events = db.prepare<[], { event_type: string }>("SELECT event_type FROM audit_log WHERE kind = 'EVENT'").all().map((r) => r.event_type);
    expect(events).toContain('SCHEDULE_CREATE');
  });

  it('到期自动执行并推进计划；只执行一次的任务执行后停用；失败时通知', async () => {
    const t = scheduler.save(null, task({ command: 'exit 3', schedule: { kind: 'interval', everyMin: 10 } }));
    db.prepare('UPDATE schedule_task SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, t.id);
    scheduler.tick();
    const run = await waitFor(() => runs.find((r) => r.taskId === t.id && r.status !== 'RUNNING'));
    expect(run.status).toBe('FAILED');
    expect(run.hosts[0]).toMatchObject({ status: 'FAILED', exitCode: 3, message: '退出码 3' });
    expect(scheduler.get(t.id)!.nextRunAt!).toBeGreaterThan(Date.now() + 9 * 60_000);
    expect(notices).toEqual(['定时任务「巡检」失败']);

    const once = scheduler.save(null, task({ name: '一次', schedule: { kind: 'once', at: Date.now() + 60_000 } }));
    db.prepare('UPDATE schedule_task SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, once.id);
    scheduler.tick();
    await waitFor(() => runs.find((r) => r.taskId === once.id && r.status === 'SUCCESS'));
    expect(scheduler.get(once.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('AI 协助：命令失败时 Agent 朝着目标处理，处理后重新执行验证', async () => {
    // 主机自己的 Agent 权限也是上限：这里允许自动执行
    settings.set('ai.defaultAgentPolicy', 'AUTO');
    const t = scheduler.save(null, task({ name: '检查标记', command: 'test -f fixed.flag', aiAssist: true, goal: '标记文件存在', aiPolicy: 'AUTO' }));
    mock.enqueue(
      { toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 'h1', command: 'touch fixed.flag', explanation: '创建缺少的标记文件' } }] },
      { text: '原因：标记文件不存在；已创建，问题解决。' },
    );
    const { runId } = scheduler.runNow(t.id);
    const run = await finished(runId);
    expect(run.status).toBe('SUCCESS');
    expect(run.hosts[0].message).toBe('Agent 处理后重新执行成功');
    expect(run.summary).toContain('已创建，问题解决');
    expect(run.conversationId).toBeTruthy();
    expect(existsSync(join(dir, 'remote', 'fixed.flag'))).toBe(true);
    // 提示词里带着失败的命令、输出和最终目的
    const prompt = JSON.stringify(mock.requests[0].body);
    expect(prompt).toContain('test -f fixed.flag');
    expect(prompt).toContain('最终目的：标记文件存在');
  });

  it('AI 任务：写操作超出权限上限时等用户批准，拒绝后不执行', async () => {
    const t = scheduler.save(null, task({ type: 'AGENT_PROMPT', command: null, prompt: '创建一个标记文件', aiPolicy: 'APPROVE' }));
    mock.enqueue({ toolCalls: [{ id: 'c1', name: 'run_command', input: { host: 'h1', command: 'touch prompt.flag', explanation: '创建标记' } }] }, { text: '没有获得批准。' });
    const { runId } = scheduler.runNow(t.id);
    const a = await waitFor(() => approvals[0]);
    expect(a).toMatchObject({ taskName: '巡检', command: 'touch prompt.flag', hostName: 'web-01', explanation: '创建标记' });
    expect(notices.some((n) => n.includes('等你批准'))).toBe(true);
    scheduler.approvals.decide(a.id, false);
    const run = await finished(runId);
    expect(run.hosts[0].status).toBe('DENIED');
    expect(existsSync(join(dir, 'remote', 'prompt.flag'))).toBe(false);
    expect(approvals).toEqual([]);
  });
});
