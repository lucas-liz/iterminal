import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApprovalEngine, DEFAULT_POLICY, type ApprovalEngine } from '@itm/approval';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { CommandRuleRepo, normalizePattern } from '../src/main/services/ai/command-rule-repo';

const wasm = {
  bashWasm: join(__dirname, '..', '..', '..', 'node_modules', 'tree-sitter-bash', 'tree-sitter-bash.wasm'),
  treeSitterWasm: join(__dirname, '..', '..', '..', 'node_modules', 'web-tree-sitter', 'web-tree-sitter.wasm'),
};

let dir: string;
let db: Db;
let repo: CommandRuleRepo;
let engine: ApprovalEngine;

beforeAll(async () => {
  engine = await createApprovalEngine(wasm);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-cmdrule-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  repo = new CommandRuleRepo(db);
});
afterEach(() => {
  engine.setUserRules([]);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const ctx = { agentPolicy: 'APPROVE' as const, production: false, policy: DEFAULT_POLICY };

describe('用户命令规则（文档一 6.15.7）', () => {
  it('快捷名单：去掉 sudo、合并空白、去重；黑名单优先于白名单', async () => {
    expect(normalizePattern('  sudo   systemctl   restart ')).toBe('systemctl restart');
    repo.setList('WHITE', ['kubectl get', 'kubectl get', 'systemctl restart nginx']);
    repo.setList('BLACK', ['systemctl restart']);
    expect(repo.list().filter((r) => r.list === 'WHITE').map((r) => r.pattern)).toEqual(['kubectl get', 'systemctl restart nginx']);
    engine.setUserRules(repo.toEngineRules());
    expect(engine.classify('kubectl get pods -A').level).toBe('L0');
    expect(engine.classify('kubectl getx').level).toBe('L1');
    // 同一个前缀同时在白名单和黑名单：更严格的先匹配
    expect(engine.classify('systemctl restart nginx').level).toBe('DENY');
    expect((await engine.evaluate('sudo systemctl restart nginx', ctx)).decision).toBe('DENY');
  });

  it('自定义规则：正则校验、停用、顺序', () => {
    expect(() => repo.save(null, { level: 'L2', matchType: 'REGEX', pattern: '^(kubectl' })).toThrow('正则表达式不合法');
    const a = repo.save(null, { level: 'L2', matchType: 'REGEX', pattern: '^mytool\\s+purge(\\s|$)', note: '清空缓存' });
    repo.save(null, { level: 'L0', matchType: 'EXACT', pattern: 'deploy.sh --dry-run', priority: 5 });
    engine.setUserRules(repo.toEngineRules());
    expect(engine.classify('mytool purge --all').level).toBe('L2');
    expect(engine.classify('deploy.sh --dry-run').level).toBe('L0');
    repo.save(a.id, { level: 'L2', matchType: 'REGEX', pattern: a.pattern, enabled: false });
    engine.setUserRules(repo.toEngineRules());
    expect(engine.classify('mytool purge --all').level).toBe('L1');
    expect(() => repo.save(repo.setList('DANGER', ['rm'])[0].id, { level: 'L0', matchType: 'PREFIX', pattern: 'rm' })).toThrow('名单里的条目');
  });
});
