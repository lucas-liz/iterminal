import { describe, expect, it } from 'vitest';
import type { AgentViewMessage } from '@itm/protocol';
import { TOOLS } from '@itm/agent-core';
import { askOptions } from '../src/main/services/ai/tool-gateway';
import { railEntries, thinkingKey } from '../src/renderer/src/util/agent-view';
import { groupOfSection, normalizeSection, SETTINGS_GROUPS, type SettingsSectionKey } from '../src/renderer/src/util/settings-sections';

describe('第二十六轮：AI 反问的选项', () => {
  it('选项可以是字符串或 {label, description}；去掉空的和重复的，最多 8 个', () => {
    const r = askOptions(['reload', { label: 'restart', description: '会断开连接' }, '', '  ', 'reload', { description: '没有名字' }, 42]);
    expect(r.options).toEqual(['reload', 'restart', '42']);
    expect(r.details).toEqual(['', '会断开连接', '']);
    expect(askOptions(Array.from({ length: 12 }, (_, i) => `o${i}`)).options).toHaveLength(8);
    expect(askOptions(undefined)).toEqual({ options: [], details: [] });
  });

  it('ask_user 工具要求给出选项，支持推荐和多选', () => {
    const t = TOOLS.find((x) => x.name === 'ask_user')!;
    expect(t.description).toContain('选项');
    expect(Object.keys((t.parameters as { properties: Record<string, unknown> }).properties)).toEqual(['question', 'options', 'recommended', 'multi_select']);
  });
});

describe('第二十六轮：对话定位条', () => {
  const user = (id: string, text: string): AgentViewMessage => ({ id, role: 'user', text, refLabels: [], mode: 'agent', createdAt: 0, compacted: false });
  const bot = (id: string, text: string): AgentViewMessage => ({ id, role: 'assistant', text, thinking: '', steps: [], model: 'm', createdAt: 0, compacted: false });
  it('每个提问一项，回答取到下一个提问之前的所有回答文字', () => {
    const r = railEntries([bot('0', '开场白'), user('u1', '问题一'), bot('a1', '先看看'), bot('a2', '结论是 A'), { id: 'n', role: 'notice', text: '提示', createdAt: 0 }, user('u2', '问题二')]);
    expect(r).toEqual([
      { id: 'u1', question: '问题一', answer: '先看看\n结论是 A' },
      { id: 'u2', question: '问题二', answer: '' },
    ]);
  });
  it('回答摘要最多 400 字', () => {
    expect(railEntries([user('u', 'q'), bot('a', 'x'.repeat(1000))])[0].answer).toHaveLength(400);
  });
});

describe('第二十六轮：设置分组', () => {
  it('15 个分区合并成 9 个分组，每个分区只属于一个分组（「数据与账号」并入账户）', () => {
    expect(SETTINGS_GROUPS).toHaveLength(9);
    const all = SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.key));
    expect(new Set(all).size).toBe(all.length);
    const keys: SettingsSectionKey[] = ['appearance', 'terminal', 'transfer', 'security', 'shortcuts', 'storage', 'models', 'agent', 'skills', 'cmdsec', 'mcp', 'sync', 'feedback', 'about'];
    expect([...all].sort()).toEqual([...keys].sort());
    expect(normalizeSection('data')).toBe('sync');
    expect(groupOfSection('data').key).toBe('account');
    expect(groupOfSection('cmdsec').key).toBe('agent');
    expect(groupOfSection('mcp').key).toBe('ext');
    expect(groupOfSection('feedback').key).toBe('about');
    expect(SETTINGS_GROUPS.filter((g) => g.ai).map((g) => g.key)).toEqual(['models', 'agent', 'ext']);
  });
});

describe('第二十六轮：模型选择里的思考档位', () => {
  it('没选过 = 自动；关闭；开启但没选档位；具体档位', () => {
    expect(thinkingKey(undefined)).toBe('auto');
    expect(thinkingKey({ enabled: false, effort: 'high' })).toBe('off');
    expect(thinkingKey({ enabled: true, effort: null })).toBe('on');
    expect(thinkingKey({ enabled: true, effort: 'medium' })).toBe('medium');
  });
});

describe('第二十六轮（二）：笔记导入 Word', () => {
  it('.docx 转成 Markdown：标题、粗体、表格保留；标题取一级标题', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { makeDocx } = await import('./support/docx');
    const { docxToMarkdown, importNoteFiles } = await import('../src/main/services/library/note-import');
    const dir = mkdtempSync(join(tmpdir(), 'itm-docx-'));
    try {
      const file = join(dir, '手册.docx');
      writeFileSync(file, await makeDocx());
      const md = await docxToMarkdown(file);
      expect(md).toContain('# 发布手册');
      expect(md).toContain('先执行 **备份**');
      expect(md).toMatch(/\| 主机 \| 端口 \|/);
      expect(md).toMatch(/\| web-01 \| 22 \|/);
      const saved: { title: string; content: string; format: string }[] = [];
      const repo = { save: (_id: null, input: { title: string; content: string; format: string }) => (saved.push(input), { id: String(saved.length), ...input }) };
      const r = await importNoteFiles(repo as never, [file, join(dir, '坏的.docx')], null);
      expect(saved.map((x) => [x.title, x.format])).toEqual([['发布手册', 'MARKDOWN']]);
      expect(r.skipped.map((x) => x.name)).toEqual(['坏的.docx']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('第二十六轮（三）：意外退出后的录像、Agent 记忆', () => {
  it('上次没有正常结束的录像：打开档案时补成已结束（时长用最后一次落盘的值），可以正常回放', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomBytes } = await import('node:crypto');
    const { openDatabase } = await import('../src/main/services/db/database');
    const { RecordingStore } = await import('../src/main/services/audit/recording-store');
    const dir = mkdtempSync(join(tmpdir(), 'itm-rec-crash-'));
    const db = openDatabase(join(dir, 'db'), randomBytes(32));
    const key = randomBytes(32);
    try {
      let now = 1_800_000_000_000;
      const store = new RecordingStore(db, dir, key, () => now);
      const rec = store.start({ sessionId: 's1', kind: 'ssh', hostId: 'h1', hostName: 'web-01', cols: 80, rows: 24 });
      rec.output('before crash\r\n');
      now += 3000;
      // 数据量到了就会落盘：这里直接输出一大段触发落盘，然后「崩溃」（不调用 end）
      rec.output('x'.repeat(70 * 1024));
      expect(store.list().items[0].endedAt).toBeNull();
      // 重新打开档案
      const again = new RecordingStore(db, dir, key, () => now + 60_000);
      const info = again.list().items[0];
      expect(info.endedAt).toBe(info.startedAt + info.durationMs);
      expect(info.durationMs).toBe(3000);
      expect(again.read(info.id).events.map((e) => e[2]).join('')).toContain('before crash');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Agent 记忆按条目保存：新增、修改、删除，每条不超过 2000 字', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { randomBytes } = await import('node:crypto');
    const { openDatabase } = await import('../src/main/services/db/database');
    const { createRepos } = await import('./support/repos');
    const dir = mkdtempSync(join(tmpdir(), 'itm-mem-'));
    const db = openDatabase(join(dir, 'db'), randomBytes(32));
    try {
      const { hosts } = createRepos(db, randomBytes(32));
      const h = hosts.create({ folderId: null, name: 'web', address: '10.0.0.1', port: 22, username: 'root', authMethod: 'PASSWORD', password: 'x', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] });
      const a = hosts.saveAgentMemory(null, h.id, '  nginx 只能 reload  ', 'conv-1');
      hosts.saveAgentMemory(null, h.id, 'MySQL 主库');
      expect(hosts.agentMemories(h.id).map((m) => m.content)).toEqual(['nginx 只能 reload', 'MySQL 主库']);
      expect(a.conversationId).toBe('conv-1');
      hosts.saveAgentMemory(a.id, h.id, 'nginx 只能 reload，不要 restart');
      expect(hosts.agentMemories(h.id)[0].content).toBe('nginx 只能 reload，不要 restart');
      hosts.deleteAgentMemory(a.id);
      expect(hosts.agentMemories(h.id).map((m) => m.content)).toEqual(['MySQL 主库']);
      expect(() => hosts.saveAgentMemory(null, h.id, 'x'.repeat(2001))).toThrow('2000');
      expect(() => hosts.saveAgentMemory(null, h.id, '   ')).toThrow('不能为空');
      // 手工填写的主机记忆不受影响
      expect(hosts.get(h.id)!.aiMemory ?? null).toBeNull();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
