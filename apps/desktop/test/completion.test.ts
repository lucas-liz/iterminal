import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { CompletionService } from '../src/main/services/ai/completion-service';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import type { AgentRuntime } from '../src/main/services/ai/runtime';
import type { SessionManager } from '../src/main/services/connection/session-manager';
import { createRepos } from './support/repos';

let dir: string;
let db: Db;
let repos: ReturnType<typeof createRepos>;
let svc: CompletionService;
let now = 1_000_000_000_000;
const calls: { prefix: string; recentOutput: string }[] = [];
let aiReply: string | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-comp-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  const key = randomBytes(32);
  repos = createRepos(db, key);
  const providers = new AiProviderRepo(db, key);
  const p = providers.save(null, { name: 'fast', type: 'OPENAI_COMPAT', baseUrl: 'http://127.0.0.1:1', apiKey: null, enabled: true, models: [{ id: 'small', contextWindow: 8000, maxOutput: 512 }] });
  repos.settings.set('ai.fastModel', { providerId: p.id, modelId: 'small' });
  const runtime = {
    complete: async (_r: unknown, input: { prefix: string; recentOutput: string }) => {
      calls.push(input);
      return aiReply;
    },
  } as unknown as AgentRuntime;
  const sessions = { recentOutput: () => ({ raw: 'token=abcdef123456 at 10.0.0.1\n$ ', cursor: 1 }) } as unknown as SessionManager;
  calls.length = 0;
  aiReply = null;
  svc = new CompletionService(db, repos.hosts, sessions, repos.settings, providers, runtime, () => now);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('终端行内补全', () => {
  it('按前缀匹配本机历史：常用、最近的优先；按主机分开', async () => {
    svc.record('h1', 'systemctl status nginx');
    now += 86_400_000 * 30;
    svc.record('h1', 'systemctl restart php-fpm');
    svc.record('h1', 'systemctl restart php-fpm');
    svc.record('h2', 'systemctl stop mysql');
    const ac = new AbortController().signal;
    expect(await svc.suggest(1, 'h1', null, 'systemctl ', ac)).toEqual({ suggestion: 'systemctl restart php-fpm', source: 'history' });
    expect((await svc.suggest(1, 'h1', null, 'systemctl st', ac)).suggestion).toBe('systemctl status nginx');
    expect((await svc.suggest(1, 'h2', null, 'systemctl ', ac)).suggestion).toBe('systemctl stop mysql');
    // LIKE 通配符按字面匹配
    svc.record(null, 'echo 100%_done');
    expect((await svc.suggest(1, null, null, 'echo 100%', ac)).suggestion).toBe('echo 100%_done');
    expect((await svc.suggest(1, null, null, 'echo 1_', ac)).suggestion).toBeNull();
  });

  it('不记录带密码的命令、空格开头的命令', async () => {
    svc.record('h1', 'mysql -uroot -pSecret123 -h db');
    svc.record('h1', 'export DB_PASSWORD=abc123');
    svc.record('h1', ' history -c');
    expect(db.prepare('SELECT count(*) AS n FROM cmd_history').get()).toEqual({ n: 0 });
  });

  it('本地没有命中时请求 AI 补全（发送前脱敏）；结果必须以已输入的内容开头', async () => {
    const ac = new AbortController().signal;
    repos.settings.set('ai.inlineCompletion', 'ai');
    aiReply = 'docker ps -a';
    expect(await svc.suggest(1, 'h1', 's1', 'docker p', ac)).toEqual({ suggestion: 'docker ps -a', source: 'ai' });
    expect(calls[0].recentOutput).toContain('token=****');
    repos.settings.set('ai.inlineCompletion', 'local');
    expect((await svc.suggest(1, 'h1', 's1', 'docker p', ac)).suggestion).toBeNull();
    repos.settings.set('ai.inlineCompletion', 'off');
    svc.record('h1', 'docker ps');
    expect((await svc.suggest(1, 'h1', 's1', 'docker p', ac)).suggestion).toBeNull();
  });

  it('主机的历史命令：最近用过的在前、可搜索、分页、可删除和清空；命令提示的候选不含已输入的完整命令', async () => {
    svc.record('h1', 'df -h');
    now += 1000;
    svc.record('h1', 'docker ps');
    now += 1000;
    svc.record('h1', 'docker logs -f web');
    svc.record('h2', 'docker images');
    const cmds = async (hostId: string, q = '', offset = 0, limit = 100): Promise<string[]> => (await svc.history(1, hostId, { q, offset, limit })).items.map((h) => h.command);
    expect(await cmds('h1')).toEqual(['docker logs -f web', 'docker ps', 'df -h']);
    expect(await cmds('h1', 'docker')).toEqual(['docker logs -f web', 'docker ps']);
    expect(await cmds('h1', '%')).toEqual([]);
    expect(await cmds('h1', '', 1, 1)).toEqual(['docker ps']);
    expect((await svc.history(1, 'h1', { limit: 1 })).total).toBe(3);
    expect((await svc.matches(1, 'h1', 'docker')).history.sort()).toEqual(['docker logs -f web', 'docker ps']);
    expect((await svc.matches(1, 'h1', 'docker ps')).history).toEqual([]);
    expect((await svc.matches(1, 'h1', '  ')).history).toEqual([]);
    svc.deleteHistory('h1', 'docker ps');
    expect(await cmds('h1')).toEqual(['docker logs -f web', 'df -h']);
    svc.clearHistory('h1');
    expect(await cmds('h1')).toEqual([]);
    expect(await cmds('h2')).toEqual(['docker images']);
  });
});
