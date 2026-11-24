import type { AgentMode } from '@itm/protocol';
import { COMMAND_TOOLS } from './tools';
import type { LlmCallResult, LlmClient, StoredMessage, ToolCall, ToolResultRecord, ToolSpec } from './llm/types';

/** 循环控制（文档一 7.2）：单个任务最多 N 条命令、N 轮工具调用、总时长；连续同样的失败自动停止 */
export interface LoopLimits {
  maxCommands: number;
  maxRounds: number;
  maxDurationMs: number;
  maxRepeatedFailures: number;
}

export const DEFAULT_LIMITS: LoopLimits = { maxCommands: 30, maxRounds: 40, maxDurationMs: 30 * 60_000, maxRepeatedFailures: 3 };

/** 循环运行的环境：主进程（执行工具、持久化）通过它和 Agent 进程交互 */
export interface LoopHost {
  /** 执行一个工具调用（在主进程里审批、执行、审计） */
  executeTool(call: ToolCall, mode: AgentMode): Promise<ToolResultRecord>;
  /** 追加一条消息（主进程持久化；usage 用于校准上下文估算） */
  append(msg: StoredMessage, usage?: LlmCallResult['usage']): Promise<void>;
  /** 流式输出（界面显示） */
  stream(text: string, thinking: string): void;
  /**
   * 同一轮里的多个工具调用哪些可以并行执行（第三十一轮）：只读、不需要用户审批的调用由主进程判定。
   * 不提供时全部按顺序执行。
   */
  parallelSafe?(calls: ToolCall[], mode: AgentMode): Promise<boolean[]>;
}

/** 同一轮里最多同时执行几个工具调用 */
export const MAX_PARALLEL_TOOLS = 6;

export interface LoopInput {
  client: LlmClient;
  system: string;
  tools: ToolSpec[];
  /** 发给模型的历史（已经包含本轮用户消息） */
  history: StoredMessage[];
  mode: AgentMode;
  modelId: string;
  limits?: Partial<LoopLimits>;
  signal: AbortSignal;
  host: LoopHost;
  now?: () => number;
}

export function errorResult(call: ToolCall, message: string): ToolResultRecord {
  return {
    callId: call.id,
    name: call.name,
    content: message,
    isError: true,
    step: {
      id: call.id,
      tool: call.name,
      hostLabel: String(call.args.host ?? ''),
      hostName: '',
      command: String(call.args.command ?? ''),
      level: null,
      reasons: [],
      status: 'error',
      exitCode: null,
      output: message,
      startedAt: null,
      finishedAt: Date.now(),
    },
  };
}

/**
 * Agent 循环：消息组装 → 流式调用模型 → 解析工具调用 → 交给主进程执行 → 回填结果 → 继续，直到模型给出最终回答。
 * 历史只追加：每一轮的回答和工具结果都追加在后面，不改写之前的消息。
 */
export async function runAgentLoop(o: LoopInput): Promise<void> {
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const now = o.now ?? Date.now;
  const started = now();
  const history = [...o.history];
  let lastFailure: string | null = null;
  let streak = 0;
  let commands = 0;
  let streamText = '';
  let streamThinking = '';

  const append = async (msg: StoredMessage, usage?: LlmCallResult['usage']): Promise<void> => {
    if (msg.role !== 'notice') history.push(msg);
    await o.host.append(msg, usage);
  };

  for (let round = 0; ; round++) {
    if (o.signal.aborted) return;
    if (round >= limits.maxRounds) {
      await append({ role: 'notice', text: `本次任务已经进行了 ${limits.maxRounds} 轮工具调用，达到上限，已停止。可以继续发消息让我接着处理。` });
      return;
    }
    if (now() - started > limits.maxDurationMs) {
      await append({ role: 'notice', text: `本次任务已经运行超过 ${Math.round(limits.maxDurationMs / 60_000)} 分钟，达到上限，已停止。` });
      return;
    }
    streamText = '';
    streamThinking = '';
    let result: LlmCallResult;
    try {
      result = await o.client.call({
        system: o.system,
        messages: history,
        tools: o.tools,
        signal: o.signal,
        onText: (d) => {
          streamText += d;
          o.host.stream(streamText, streamThinking);
        },
        onThinking: (d) => {
          streamThinking += d;
          o.host.stream(streamText, streamThinking);
        },
      });
    } catch (e) {
      if (o.signal.aborted) {
        if (streamText) {
          await append({ role: 'assistant', text: streamText, thinking: streamThinking, toolCalls: [], provider: 'openai', model: o.modelId, notice: '已停止' });
        }
        return;
      }
      throw e;
    }

    let notice: string | undefined;
    if (result.stop === 'refusal') notice = `模型拒绝了这个请求${result.stopDetail ? `（${result.stopDetail}）` : ''}`;
    else if (result.stop === 'max_tokens') notice = '回答达到长度上限被截断';
    await append(
      { role: 'assistant', text: result.text, thinking: result.thinking, toolCalls: result.toolCalls, provider: result.provider, model: o.modelId, raw: result.raw, notice },
      result.usage,
    );
    o.host.stream('', '');
    if (result.toolCalls.length === 0) return;

    // 被截断或被拒绝的回合不执行工具（参数可能不完整），但每个调用都要有结果，历史才合法
    const skipReason = result.stop === 'refusal' || result.stop === 'max_tokens' ? notice! : null;
    const calls = result.toolCalls;
    const results: ToolResultRecord[] = [];
    let stopReason: string | null = null;
    // 互不依赖的只读调用（主进程判定不需要审批）一起执行，按原来的顺序回填结果
    const safe = !skipReason && calls.length > 1 && o.host.parallelSafe ? await o.host.parallelSafe(calls, o.mode).catch(() => null) : null;
    /** 命令条数上限：超过时直接返回错误结果，不执行 */
    const admit = (call: ToolCall): ToolResultRecord | null => {
      if (!COMMAND_TOOLS.has(call.name)) return null;
      if (commands >= limits.maxCommands) return errorResult(call, `本次任务已经执行了 ${limits.maxCommands} 条命令，达到上限，请总结当前结果`);
      commands++;
      return null;
    };
    const settle = (call: ToolCall, r: ToolResultRecord): void => {
      results.push(r);
      // 连续同样的失败（同一个工具、同样的参数）：第 N 次时停下来请人工介入
      if (r.isError && r.step.status !== 'rejected') {
        const sig = `${call.name}\u0000${JSON.stringify(call.args)}`;
        streak = sig === lastFailure ? streak + 1 : 1;
        lastFailure = sig;
        if (streak >= limits.maxRepeatedFailures) stopReason = `同样的操作连续失败 ${streak} 次，已停止`;
      } else if (!r.isError) {
        lastFailure = null;
        streak = 0;
      }
    };
    for (let i = 0; i < calls.length; ) {
      if (skipReason || o.signal.aborted || stopReason) {
        results.push(errorResult(calls[i], skipReason ? `${skipReason}，没有执行` : stopReason ?? '用户已停止执行'));
        i++;
        continue;
      }
      let j = i + 1;
      if (safe?.[i]) while (j < calls.length && safe[j] && j - i < MAX_PARALLEL_TOOLS) j++;
      const group = calls.slice(i, j);
      const limited = group.map(admit);
      const settled = await Promise.allSettled(group.map((c, k) => limited[k] ?? o.host.executeTool(c, o.mode)));
      const failed = settled.find((x): x is PromiseRejectedResult => x.status === 'rejected');
      if (failed) throw failed.reason;
      group.forEach((c, k) => {
        const over = limited[k];
        if (over) results.push(over);
        else settle(c, (settled[k] as PromiseFulfilledResult<ToolResultRecord>).value);
      });
      i = j;
    }
    await append({ role: 'tool_results', results });
    if (stopReason) {
      await append({ role: 'notice', text: `${stopReason}，请检查后告诉我下一步怎么做。` });
      return;
    }
    if (skipReason || o.signal.aborted) return;
  }
}
