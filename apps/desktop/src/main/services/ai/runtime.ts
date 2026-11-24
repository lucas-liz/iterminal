import {
  completeCommand,
  createLlmClient,
  reviewCommand,
  runAgentLoop,
  summarize,
  type LlmCallInput,
  type LlmCallResult,
  type LlmClient,
  type LoopHost,
  type LoopLimits,
  type ResolvedModel,
  type StoredMessage,
  type ToolSpec,
} from '@itm/agent-core';
import type { AgentMode } from '@itm/protocol';

export interface RunRequest {
  resolved: ResolvedModel;
  system: string;
  tools: ToolSpec[];
  history: StoredMessage[];
  mode: AgentMode;
  limits: Partial<LoopLimits>;
}

export type CallInput = Pick<LlmCallInput, 'system' | 'messages' | 'tools'>;
export interface CompletionInput {
  prefix: string;
  host: string;
  recentOutput: string;
  history: string[];
}

/**
 * Agent 推理的运行环境（文档一 5.1）：生产环境是独立的 utilityProcess（UtilityRuntime），
 * 单元测试里直接在当前进程运行（InlineRuntime）。审批、执行、持久化都在主进程，通过 LoopHost 回调。
 */
export interface AgentRuntime {
  run(req: RunRequest, host: LoopHost, signal: AbortSignal): Promise<void>;
  summarize(resolved: ResolvedModel, history: StoredMessage[], signal: AbortSignal): Promise<string>;
  review(resolved: ResolvedModel, command: string, level: string, reasons: string[]): Promise<{ level: 'L0' | 'L1' | 'L2'; reason: string } | null>;
  complete(resolved: ResolvedModel, input: CompletionInput, signal: AbortSignal): Promise<string | null>;
  call(resolved: ResolvedModel, input: CallInput, signal: AbortSignal): Promise<LlmCallResult>;
  dispose(): void;
}

export class InlineRuntime implements AgentRuntime {
  constructor(private readonly createClient: (r: ResolvedModel) => LlmClient = createLlmClient) {}

  run(req: RunRequest, host: LoopHost, signal: AbortSignal): Promise<void> {
    return runAgentLoop({
      client: this.createClient(req.resolved),
      system: req.system,
      tools: req.tools,
      history: req.history,
      mode: req.mode,
      modelId: req.resolved.model.id,
      limits: req.limits,
      signal,
      host,
    });
  }

  summarize(resolved: ResolvedModel, history: StoredMessage[], signal: AbortSignal): Promise<string> {
    return summarize(this.createClient(resolved), history, resolved.model.contextWindow, signal);
  }

  review(resolved: ResolvedModel, command: string, level: string, reasons: string[]) {
    return reviewCommand(this.createClient(resolved), command, level, reasons);
  }

  complete(resolved: ResolvedModel, input: CompletionInput, signal: AbortSignal): Promise<string | null> {
    return completeCommand(this.createClient(resolved), input, signal);
  }

  call(resolved: ResolvedModel, input: CallInput, signal: AbortSignal): Promise<LlmCallResult> {
    return this.createClient(resolved).call({ ...input, signal, onText: () => undefined, onThinking: () => undefined });
  }

  dispose(): void {
    // 没有需要释放的资源
  }
}
