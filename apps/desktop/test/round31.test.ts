/**
 * 第三十一轮：标签拖动换位置、Agent 同一轮里只读调用并行执行（主进程判定哪些可以并行）、思考默认关闭。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@itm/protocol';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { Masker } from '@itm/masking';
import type { ToolCall } from '@itm/agent-core';
import { moveTab, tabDropSlot, useTabs } from '../src/renderer/src/store/tabs';
import { ToolGateway, type ToolContext } from '../src/main/services/ai/tool-gateway';
import type { SettingsRepo } from '../src/main/services/settings/settings-repo';

const t = () => useTabs.getState();

describe('标签拖动换位置', () => {
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeId: null, layouts: {}, focused: {}, broadcast: { on: false, targets: [] } });
  });

  it('放到目标标签的前面 / 后面；分屏窗格跟着自己的标签，不参与排序', () => {
    const a = t().open({ kind: 'ssh', title: 'a' });
    const b = t().open({ kind: 'ssh', title: 'b' });
    const c = t().open({ kind: 'local', title: 'c' });
    const roots = (): string[] => t().tabs.filter((x) => !x.parentId).map((x) => x.title);
    t().move(c, a, false);
    expect(roots()).toEqual(['c', 'a', 'b']);
    t().move(c, b, true);
    expect(roots()).toEqual(['a', 'b', 'c']);
    // 分屏后拖动：窗格还在，所属标签不变
    const p = t().split(a, 'h', { kind: 'local', title: 'pane' });
    t().move(a, c, true);
    expect(roots()).toEqual(['b', 'c', 'a']);
    expect(t().tabs.find((x) => x.id === p)?.parentId).toBe(a);
    // 窗格、不存在的标签、拖到自己：不变
    const before = t().tabs;
    expect(moveTab(before, p, b, false)).toBe(before);
    expect(moveTab(before, a, 'nope', false)).toBe(before);
    expect(moveTab(before, a, a, true)).toBe(before);
  });

  it('放下位置按其他标签的中线算（第三十二轮）：越过邻居中线才换位置，位置不变时不显示竖线', () => {
    // 三个标签宽 100：中线 50 / 150 / 250
    const order = ['a', 'b', 'c'];
    const mids = [50, 150, 250];
    // 把 a 往右拖：没过 b 的中线不变（以前在 b 的左半边会显示「b 左边」的竖线，松手却没动）
    expect(tabDropSlot(order, mids, 'a', 120)).toBeNull();
    expect(tabDropSlot(order, mids, 'a', 160)).toEqual({ id: 'b', after: true });
    // 过了最后一个的中线、或者在最后一个标签右边的空白处：放到最后
    expect(tabDropSlot(order, mids, 'a', 260)).toEqual({ id: 'c', after: true });
    expect(tabDropSlot(order, mids, 'a', 900)).toEqual({ id: 'c', after: true });
    // 中间的 b：往左过 a 的中线放最前，往右过 c 的中线放最后，中间不变
    expect(tabDropSlot(order, mids, 'b', 40)).toEqual({ id: 'a', after: false });
    expect(tabDropSlot(order, mids, 'b', 0)).toEqual({ id: 'a', after: false });
    expect(tabDropSlot(order, mids, 'b', 100)).toBeNull();
    expect(tabDropSlot(order, mids, 'b', 240)).toBeNull();
    expect(tabDropSlot(order, mids, 'b', 251)).toEqual({ id: 'c', after: true });
    // 只有一个标签、拖的标签不在栏里
    expect(tabDropSlot(['a'], [50], 'a', 500)).toBeNull();
    expect(tabDropSlot(order, mids, 'x', 10)).toBeNull();
    // 算出来的位置交给 moveTab，结果就是竖线标的位置
    const tabs = order.map((id) => ({ id, kind: 'local' as const, title: id, status: 'ready' as const }));
    const slot = tabDropSlot(order, mids, 'c', 60)!;
    expect(moveTab(tabs, 'c', slot.id, slot.after).map((x) => x.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('思考默认关闭', () => {
  it('全局默认 ai.thinkingDefault = false', () => {
    expect(DEFAULT_SETTINGS['ai.thinkingDefault']).toBe(false);
  });
});

// ---------------------------------------------------------------- 并行判定

const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
let approval: ApprovalEngine;
beforeAll(async () => {
  approval = await createApprovalEngine(wasm);
});

function gateway(over: Partial<Settings> = {}): ToolGateway {
  const values = { ...DEFAULT_SETTINGS, 'ai.defaultAgentPolicy': 'APPROVE', ...over } as Settings;
  const settings = { get: <K extends keyof Settings>(k: K) => values[k] } as unknown as SettingsRepo;
  return new ToolGateway({
    hosts: {} as never, credentials: {} as never, settings, audit: {} as never, approval, pool: {} as never,
    sessions: {} as never, monitor: {} as never, skills: {} as never, runtime: {} as never,
    emit: () => undefined,
    policy: () => ({ ...DEFAULT_POLICY }),
    runLocal: async () => {
      throw new Error('判定时不应该执行命令');
    },
  });
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  conversationId: 'c1', owner: 1, mode: 'agent',
  targets: { t1: { tabId: 'tab-1', kind: 'local', title: '本机', sessionId: null, hostId: null } },
  databases: {},
  masker: new Masker({ maskIps: false, maskPii: true }),
  signal: new AbortController().signal,
  reviewModel: null,
  ui: { add: () => undefined, update: () => undefined, wait: async () => ({ decision: 'reject' }) },
  ...over,
});

let n = 0;
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c${++n}`, name, args });

describe('Agent 同一轮里哪些调用可以并行（第三十一轮）', () => {
  it('自动执行的只读命令、只读工具可以并行；写操作、需要审批的、ask_user 不并行', async () => {
    const gw = gateway();
    const safe = (c: ToolCall, o?: Partial<ToolContext>): Promise<boolean> => gw.parallelSafe(c, ctx(o));
    expect(await safe(call('run_command', { host: 't1', command: 'df -h', explanation: 'x' }))).toBe(true);
    expect(await safe(call('run_command', { host: 't1', command: 'uptime && free -m', explanation: 'x' }))).toBe(true);
    expect(await safe(call('read_terminal', { host: 't1' }))).toBe(true);
    expect(await safe(call('get_metrics', { host: 't1' }))).toBe(true);
    expect(await safe(call('run_command', { host: 't1', command: 'systemctl restart nginx', explanation: 'x' }))).toBe(false);
    expect(await safe(call('run_command', { host: 't1', command: 'rm -rf /tmp/x', explanation: 'x' }))).toBe(false);
    expect(await safe(call('ask_user', { question: '继续吗？' }))).toBe(false);
    expect(await safe(call('sftp_write', { host: 't1', path: '/tmp/a', content: 'x', explanation: 'x' }))).toBe(false);
    expect(await safe(call('memory_propose', { host: 't1', text: 'x' }))).toBe(false);
    // 马上返回错误的也可以并行：目标不存在、Ask 模式
    expect(await safe(call('run_command', { host: 't9', command: 'rm -rf /', explanation: 'x' }))).toBe(true);
    expect(await safe(call('run_command', { host: 't1', command: 'rm -rf /tmp/x', explanation: 'x' }), { mode: 'ask' })).toBe(true);
  });

  it('只读命令也要等用户批准时（关闭「只读命令自动执行」）不并行', async () => {
    const gw = gateway({ 'ai.autoApproveReadonly': false });
    expect(await gw.parallelSafe(call('run_command', { host: 't1', command: 'df -h', explanation: 'x' }), ctx())).toBe(false);
  });
});
