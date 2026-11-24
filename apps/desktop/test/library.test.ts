import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fillSnippet, snippetVars } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { SnippetRepo } from '../src/main/services/library/snippet-repo';
import { NoteRepo } from '../src/main/services/library/note-repo';
import { CompletionService } from '../src/main/services/ai/completion-service';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import type { AgentRuntime } from '../src/main/services/ai/runtime';
import type { SessionManager } from '../src/main/services/connection/session-manager';
import { createRepos } from './support/repos';

let dir: string;
let db: Db;
let now = 1_000_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-lib-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('快捷命令的变量', () => {
  it('解析 {{变量}} 和 {{变量:默认值}}，同名只出现一次', () => {
    expect(snippetVars('tail -n {{lines:200}} {{file}} | grep {{ keyword }} && echo {{file}}')).toEqual([
      { name: 'lines', defaultValue: '200' },
      { name: 'file', defaultValue: '' },
      { name: 'keyword', defaultValue: '' },
    ]);
    expect(snippetVars('ls -la')).toEqual([]);
  });

  it('填写变量；没填的用默认值', () => {
    expect(fillSnippet('tail -n {{lines:200}} {{file}} && wc -l {{file}}', { file: '/var/log/app.log' })).toBe('tail -n 200 /var/log/app.log && wc -l /var/log/app.log');
    expect(fillSnippet('echo {{a:x}}', { a: 'y' })).toBe('echo y');
  });
});

describe('快捷命令', () => {
  it('分组：新建、重名、排序；删除分组时命令移到未分组', () => {
    const repo = new SnippetRepo(db, () => now);
    const ops = repo.groups.save(null, '运维');
    const db2 = repo.groups.save(null, '数据库');
    expect(() => repo.groups.save(null, ' 运维 ')).toThrow('已经有名为「运维」的分组');
    expect(repo.groups.list().map((g) => g.name)).toEqual(['运维', '数据库']);
    repo.groups.reorder([db2, ops]);
    expect(repo.groups.list().map((g) => g.name)).toEqual(['数据库', '运维']);

    const s = repo.save(null, { groupId: ops, name: '看日志', content: 'tail -f {{file}}\r\n', description: '跟踪日志', tags: ['log', 'Log', ' ops '] });
    expect(s).toMatchObject({ groupId: ops, name: '看日志', content: 'tail -f {{file}}\n', tags: ['log', 'ops'] });
    expect(repo.groups.list().find((g) => g.id === ops)?.count).toBe(1);

    repo.groups.delete(ops);
    expect(repo.groups.list().map((g) => g.name)).toEqual(['数据库']);
    expect(repo.get(s.id)?.groupId).toBeNull();
    expect(() => repo.save(null, { groupId: ops, name: 'x', content: 'ls' })).toThrow('分组不存在');
  });

  it('校验、修改、移动、删除（墓碑）', () => {
    const repo = new SnippetRepo(db, () => now);
    expect(() => repo.save(null, { groupId: null, name: ' ', content: 'ls' })).toThrow('请填写命令名称');
    expect(() => repo.save(null, { groupId: null, name: 'a', content: '  ' })).toThrow('请填写命令内容');
    const a = repo.save(null, { groupId: null, name: 'a', content: 'ls' });
    now += 1000;
    const updated = repo.save(a.id, { groupId: null, name: 'a2', content: 'ls -la' });
    expect(updated).toMatchObject({ name: 'a2', content: 'ls -la', updatedAt: now });
    const g = repo.groups.save(null, 'g');
    repo.move([a.id], g);
    expect(repo.get(a.id)?.groupId).toBe(g);
    repo.delete([a.id]);
    expect(repo.list()).toEqual([]);
    expect(db.prepare('SELECT deleted FROM snippet WHERE id = ?').get(a.id)).toEqual({ deleted: 1 });
  });

  it('行内补全也会匹配快捷命令（单行、不带变量）', async () => {
    const key = randomBytes(32);
    const repos = createRepos(db, key);
    const snippets = new SnippetRepo(db, () => now);
    snippets.save(null, { groupId: null, name: '重启', content: 'systemctl restart nginx' });
    snippets.save(null, { groupId: null, name: '多行', content: 'systemctl status\nuptime' });
    snippets.save(null, { groupId: null, name: '变量', content: 'systemctl stop {{svc}}' });
    const svc = new CompletionService(
      db,
      repos.hosts,
      {} as SessionManager,
      repos.settings,
      new AiProviderRepo(db, key),
      {} as AgentRuntime,
      () => now,
      snippets,
    );
    const r = await svc.suggest(1, null, null, 'systemctl re', AbortSignal.timeout(1000));
    expect(r).toEqual({ suggestion: 'systemctl restart nginx', source: 'snippet' });
    // 历史命令优先
    svc.record(null, 'systemctl reload nginx');
    expect((await svc.suggest(1, null, null, 'systemctl re', AbortSignal.timeout(1000))).source).toBe('history');
    expect((await svc.suggest(1, null, null, 'systemctl st', AbortSignal.timeout(1000))).suggestion).toBeNull();
  });
});

describe('笔记', () => {
  it('置顶在前、其余按最近修改；分组删除后笔记保留', () => {
    const repo = new NoteRepo(db, () => now);
    const g = repo.groups.save(null, '排障');
    const a = repo.save(null, { groupId: g, title: ' 磁盘满 ', content: '## 步骤\r\n1. df -h' });
    now += 10;
    const b = repo.save(null, { groupId: null, title: '', content: 'x' });
    expect(b.title).toBe('无标题');
    expect(a).toMatchObject({ title: '磁盘满', content: '## 步骤\n1. df -h', format: 'MARKDOWN', pinned: false });
    expect(repo.list().map((n) => n.id)).toEqual([b.id, a.id]);
    repo.pin(a.id, true);
    expect(repo.list().map((n) => n.id)).toEqual([a.id, b.id]);
    // 修改时不传 pinned 保留原值
    now += 10;
    expect(repo.save(a.id, { groupId: g, title: '磁盘满了', content: 'y' }).pinned).toBe(true);
    repo.groups.delete(g);
    expect(repo.get(a.id)?.groupId).toBeNull();
    repo.delete([a.id, b.id]);
    expect(repo.list()).toEqual([]);
  });
});
