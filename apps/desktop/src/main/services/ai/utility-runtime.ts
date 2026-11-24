import { randomUUID } from 'node:crypto';
import { utilityProcess, type UtilityProcess } from 'electron';
import { RpcPeer, UserError, type LlmCallResult, type LoopHost, type ResolvedModel, type RpcMessage, type StoredMessage, type ToolCall } from '@itm/agent-core';
import type { AgentMode } from '@itm/protocol';
import type { AgentRuntime, CallInput, CompletionInput, RunRequest } from './runtime';

/**
 * 在独立的 utilityProcess 里运行 Agent（文档一 5.1）：长时间的推理和流式输出不占用主进程；
 * Agent 进程拿不到 SSH 凭证、也不能直接执行命令，只能通过 RPC 请主进程执行（审批在主进程判定）。
 * 进程崩溃时自动在下一次请求时重启，正在进行的任务以错误结束。
 */
export class UtilityRuntime implements AgentRuntime {
  private child: UtilityProcess | null = null;
  private rpc: RpcPeer | null = null;
  private readonly runs = new Map<string, LoopHost>();

  constructor(private readonly entry: string) {}

  private ensure(): RpcPeer {
    if (this.rpc) return this.rpc;
    const child = utilityProcess.fork(this.entry, [], { serviceName: 'iTerminal Agent', stdio: 'pipe' });
    const rpc = new RpcPeer((m) => child.postMessage(m));
    child.on('message', (m: RpcMessage) => rpc.receive(m));
    child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[agent] ${b.toString()}`));
    child.on('exit', (code) => {
      rpc.close(new UserError(`Agent 进程异常退出（退出码 ${code}），请重新发送`));
      if (this.child === child) {
        this.child = null;
        this.rpc = null;
      }
    });
    rpc.handle<{ runId: string; call: ToolCall; mode: AgentMode }, unknown>('tool', (p) => this.host(p.runId).executeTool(p.call, p.mode));
    rpc.handle<{ runId: string; calls: ToolCall[]; mode: AgentMode }, boolean[]>('parallelSafe', (p) => this.host(p.runId).parallelSafe?.(p.calls, p.mode) ?? p.calls.map(() => false));
    rpc.handle<{ runId: string; msg: StoredMessage; usage?: LlmCallResult['usage'] }, unknown>('append', (p) => this.host(p.runId).append(p.msg, p.usage));
    rpc.on<{ runId: string; text: string; thinking: string }>('stream', (p) => this.runs.get(p.runId)?.stream(p.text, p.thinking));
    this.child = child;
    this.rpc = rpc;
    return rpc;
  }

  private host(runId: string): LoopHost {
    const h = this.runs.get(runId);
    if (!h) throw new Error('任务已结束');
    return h;
  }

  async run(req: RunRequest, host: LoopHost, signal: AbortSignal): Promise<void> {
    const runId = randomUUID();
    this.runs.set(runId, host);
    try {
      await this.ensure().request('run', { runId, ...req }, signal);
    } finally {
      this.runs.delete(runId);
    }
  }

  summarize(resolved: ResolvedModel, history: StoredMessage[], signal: AbortSignal): Promise<string> {
    return this.ensure().request('summarize', { resolved, history }, signal);
  }

  review(resolved: ResolvedModel, command: string, level: string, reasons: string[]): Promise<{ level: 'L0' | 'L1' | 'L2'; reason: string } | null> {
    return this.ensure().request('review', { resolved, command, level, reasons }, AbortSignal.timeout(30_000));
  }

  complete(resolved: ResolvedModel, input: CompletionInput, signal: AbortSignal): Promise<string | null> {
    return this.ensure().request('complete', { resolved, input }, signal);
  }

  call(resolved: ResolvedModel, input: CallInput, signal: AbortSignal): Promise<LlmCallResult> {
    return this.ensure().request('call', { resolved, input }, signal);
  }

  dispose(): void {
    this.rpc?.close(new UserError('Agent 进程已关闭'));
    this.child?.kill();
    this.child = null;
    this.rpc = null;
  }
}
