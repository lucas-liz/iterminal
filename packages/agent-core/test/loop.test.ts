import { describe, expect, it } from 'vitest';
import { MAX_PARALLEL_TOOLS, RpcPeer, UserError, parseReview, runAgentLoop, type LlmCallInput, type LlmCallResult, type LlmClient, type RpcMessage, type StoredMessage, type ToolCall, type ToolResultRecord } from '../src/index';

/** 按顺序返回预设回答的假模型 */
function fakeClient(replies: Partial<LlmCallResult>[]): LlmClient & { calls: LlmCallInput[] } {
  const calls: LlmCallInput[] = [];
  return {
    calls,
    async call(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const r = replies.shift() ?? { text: '完成' };
      if (r.text) input.onText(r.text);
      return { provider: 'anthropic', text: '', thinking: '', toolCalls: [], stop: r.toolCalls?.length ? 'tool_use' : 'end', ...r };
    },
  };
}

const tool = (id: string, name = 'run_command', args: Record<string, unknown> = { host: 't1', command: 'ls' }): ToolCall => ({ id, name, args });

function host(fail = false) {
  const appended: StoredMessage[] = [];
  const executed: string[] = [];
  return {
    appended,
    executed,
    executeTool: async (call: ToolCall): Promise<ToolResultRecord> => {
      executed.push(call.id);
      return {
        callId: call.id,
        name: call.name,
        content: fail ? 'boom' : 'ok',
        isError: fail,
        step: { id: call.id, tool: call.name, hostLabel: 't1', hostName: 'web', command: 'ls', level: 'L0', reasons: [], status: fail ? 'error' : 'done', exitCode: fail ? 1 : 0, output: '', startedAt: 0, finishedAt: 0 },
      };
    },
    append: async (m: StoredMessage) => {
      appended.push(m);
    },
    stream: () => undefined,
  };
}

const base = { system: 's', tools: [], history: [{ role: 'user', mode: 'agent', blocks: [{ kind: 'question', text: 'hi' }] }] as StoredMessage[], mode: 'agent' as const, modelId: 'm' };

describe('Agent 循环：同一轮里的只读调用并行执行（第三十一轮）', () => {
  /** 记录同时在执行的调用数；parallelSafe 由测试指定 */
  function parallelHost(safe: (c: ToolCall) => boolean, delay = 30) {
    const h = host();
    let running = 0;
    const peak = { n: 0 };
    const started: string[] = [];
    return {
      ...h,
      peak,
      started,
      executeTool: async (call: ToolCall): Promise<ToolResultRecord> => {
        started.push(call.id);
        running++;
        peak.n = Math.max(peak.n, running);
        await new Promise((r) => setTimeout(r, call.id === 'a' ? delay * 2 : delay));
        running--;
        return h.executeTool(call);
      },
      parallelSafe: async (calls: ToolCall[]) => calls.map(safe),
    };
  }

  it('可以并行的调用一起执行，结果按原来的顺序回填', async () => {
    const h = parallelHost(() => true);
    await runAgentLoop({ ...base, client: fakeClient([{ toolCalls: [tool('a'), tool('b'), tool('c')] }, { text: '好' }]), signal: new AbortController().signal, host: h });
    expect(h.peak.n).toBe(3);
    const results = h.appended.find((m) => m.role === 'tool_results') as Extract<StoredMessage, { role: 'tool_results' }>;
    // a 最慢，但结果仍然排在第一个
    expect(results.results.map((r) => r.callId)).toEqual(['a', 'b', 'c']);
  });

  it('需要审批的调用把并行分成几段，按顺序执行；最多同时执行 MAX_PARALLEL_TOOLS 个', async () => {
    const h = parallelHost((c) => c.id !== 'w');
    await runAgentLoop({ ...base, client: fakeClient([{ toolCalls: [tool('a'), tool('b'), tool('w'), tool('c')] }, { text: '好' }]), signal: new AbortController().signal, host: h });
    expect(h.peak.n).toBe(2);
    expect(h.started).toEqual(['a', 'b', 'w', 'c']);

    const many = parallelHost(() => true, 5);
    const calls = Array.from({ length: MAX_PARALLEL_TOOLS + 3 }, (_, i) => tool(`x${i}`));
    await runAgentLoop({ ...base, client: fakeClient([{ toolCalls: calls }, { text: '好' }]), signal: new AbortController().signal, host: many, limits: { maxCommands: 100 } });
    expect(many.peak.n).toBe(MAX_PARALLEL_TOOLS);
  });

  it('并行时命令数上限照样生效；没有 parallelSafe 时按顺序执行', async () => {
    const h = parallelHost(() => true);
    await runAgentLoop({ ...base, client: fakeClient([{ toolCalls: [tool('a'), tool('b'), tool('c')] }, { text: '好' }]), signal: new AbortController().signal, host: h, limits: { maxCommands: 2 } });
    expect(h.started).toEqual(['a', 'b']);
    const results = h.appended.find((m) => m.role === 'tool_results') as Extract<StoredMessage, { role: 'tool_results' }>;
    expect(results.results[2].content).toContain('达到上限');

    const seq = parallelHost(() => true);
    const { parallelSafe: _, ...noParallel } = seq;
    await runAgentLoop({ ...base, client: fakeClient([{ toolCalls: [tool('a'), tool('b')] }, { text: '好' }]), signal: new AbortController().signal, host: noParallel });
    expect(seq.peak.n).toBe(1);
  });
});

describe('Agent 循环', () => {
  it('工具结果追加后继续，直到模型给出最终回答；历史只追加', async () => {
    const client = fakeClient([{ toolCalls: [tool('a')] }, { text: '结论' }]);
    const h = host();
    await runAgentLoop({ ...base, client, signal: new AbortController().signal, host: h });
    expect(h.appended.map((m) => m.role)).toEqual(['assistant', 'tool_results', 'assistant']);
    // 第二次调用的历史 = 第一次的历史 + 回答 + 工具结果
    expect(client.calls[1].messages).toHaveLength(3);
    expect(client.calls[1].messages[0]).toBe(base.history[0]);
  });

  it('命令数上限：超出的调用直接返回错误，不执行', async () => {
    const client = fakeClient([{ toolCalls: [tool('a'), tool('b'), tool('c')] }, { text: '好' }]);
    const h = host();
    await runAgentLoop({ ...base, client, signal: new AbortController().signal, host: h, limits: { maxCommands: 2 } });
    expect(h.executed).toEqual(['a', 'b']);
    const results = h.appended.find((m) => m.role === 'tool_results') as Extract<StoredMessage, { role: 'tool_results' }>;
    expect(results.results[2].content).toContain('达到上限');
  });

  it('轮数上限和总时长上限：停止并留下提示（不发给模型）', async () => {
    const client = fakeClient(Array.from({ length: 10 }, (_, i) => ({ toolCalls: [tool(`t${i}`, 'read_terminal')] })));
    const h = host();
    await runAgentLoop({ ...base, client, signal: new AbortController().signal, host: h, limits: { maxRounds: 2 } });
    expect(client.calls).toHaveLength(2);
    expect(h.appended.at(-1)).toMatchObject({ role: 'notice' });

    let t = 0;
    const h2 = host();
    await runAgentLoop({ ...base, client: fakeClient([{ toolCalls: [tool('x', 'read_terminal')] }, { text: '不会到这里' }]), signal: new AbortController().signal, host: h2, limits: { maxDurationMs: 1000 }, now: () => (t += 800) });
    expect((h2.appended.at(-1) as { text: string }).text).toContain('超过');
  });

  it('被拒绝 / 截断的回合不执行工具，但每个调用都有结果', async () => {
    const h = host();
    await runAgentLoop({ ...base, client: fakeClient([{ toolCalls: [tool('a')], stop: 'max_tokens' }]), signal: new AbortController().signal, host: h });
    expect(h.executed).toEqual([]);
    const results = h.appended.find((m) => m.role === 'tool_results') as Extract<StoredMessage, { role: 'tool_results' }>;
    expect(results.results[0].content).toContain('没有执行');
  });

  it('LLM 复核结果解析', () => {
    expect(parseReview('判断：{"level":"L2","reason":"删除数据"}')).toEqual({ level: 'L2', reason: '删除数据' });
    expect(parseReview('{"level":"L9"}')).toBeNull();
    expect(parseReview('不是 JSON')).toBeNull();
  });
});

describe('进程间 RPC', () => {
  function pair(): [RpcPeer, RpcPeer] {
    let a: RpcPeer;
    let b: RpcPeer;
    // 模拟结构化克隆的异步投递
    a = new RpcPeer((m: RpcMessage) => queueMicrotask(() => b.receive(structuredClone(m))));
    b = new RpcPeer((m: RpcMessage) => queueMicrotask(() => a.receive(structuredClone(m))));
    return [a, b];
  }

  it('双向请求、事件、错误按 UserError 还原', async () => {
    const [main, agent] = pair();
    main.handle<{ x: number }, number>('double', (p) => p.x * 2);
    agent.handle<{ n: number }, number>('run', async (p) => (await agent.request<number>('double', { x: p.n })) + 1);
    agent.handle('fail', () => {
      throw new UserError('API Key 无效');
    });
    const events: unknown[] = [];
    main.on('stream', (p) => events.push(p));
    agent.handle('emit', () => agent.emit('stream', { text: 'hi' }));
    expect(await main.request('run', { n: 20 })).toBe(41);
    await main.request('emit', {});
    expect(events).toEqual([{ text: 'hi' }]);
    const err = await main.request('fail', {}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe('API Key 无效');
  });

  it('取消：请求方的 signal 中止后，处理方收到 abort', async () => {
    const [main, agent] = pair();
    let aborted = false;
    agent.handle('long', (_p, { signal }) => new Promise((resolve) => signal.addEventListener('abort', () => ((aborted = true), resolve('stopped')))));
    const ac = new AbortController();
    const p = main.request('long', {}, ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await p).toBe('stopped');
    expect(aborted).toBe(true);
  });

  it('对方进程退出：等待中的请求全部失败', async () => {
    const [main, agent] = pair();
    agent.handle('hang', () => new Promise(() => undefined));
    const p = main.request('hang', {});
    main.close(new UserError('Agent 进程异常退出'));
    await expect(p).rejects.toThrow('Agent 进程异常退出');
    await expect(main.request('hang', {})).rejects.toThrow('Agent 进程异常退出');
  });
});
