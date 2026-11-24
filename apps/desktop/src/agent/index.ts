/**
 * Agent 进程（Electron utilityProcess，文档一 5.1）：运行 Agent 循环、调用模型。
 * 拿不到 SSH 凭证、数据库和连接；执行工具、保存消息都要通过 RPC 请主进程处理（审批在主进程判定，这里无法绕过）。
 */
import {
  RpcPeer,
  completeCommand,
  createLlmClient,
  reviewCommand,
  runAgentLoop,
  summarize,
  type RpcMessage,
  type ToolResultRecord,
} from '@itm/agent-core';
import type { RunRequest, CallInput, CompletionInput } from '../main/services/ai/runtime';
import type { ResolvedModel, StoredMessage } from '@itm/agent-core';

const port = process.parentPort;
const rpc = new RpcPeer((m) => port.postMessage(m));
port.on('message', (e: { data: RpcMessage }) => rpc.receive(e.data));

rpc.handle<RunRequest & { runId: string }, void>('run', async (p, { signal }) => {
  await runAgentLoop({
    client: createLlmClient(p.resolved),
    system: p.system,
    tools: p.tools,
    history: p.history,
    mode: p.mode,
    modelId: p.resolved.model.id,
    limits: p.limits,
    signal,
    host: {
      executeTool: (call, mode) => rpc.request<ToolResultRecord>('tool', { runId: p.runId, call, mode }),
      append: (msg, usage) => rpc.request<void>('append', { runId: p.runId, msg, usage }),
      stream: (text, thinking) => rpc.emit('stream', { runId: p.runId, text, thinking }),
      parallelSafe: (calls, mode) => rpc.request<boolean[]>('parallelSafe', { runId: p.runId, calls, mode }),
    },
  });
});

rpc.handle<{ resolved: ResolvedModel; history: StoredMessage[] }, string>('summarize', (p, { signal }) =>
  summarize(createLlmClient(p.resolved), p.history, p.resolved.model.contextWindow, signal),
);

rpc.handle<{ resolved: ResolvedModel; command: string; level: string; reasons: string[] }, unknown>('review', (p, { signal }) =>
  reviewCommand(createLlmClient(p.resolved), p.command, p.level, p.reasons, signal),
);

rpc.handle<{ resolved: ResolvedModel; input: CompletionInput }, string | null>('complete', (p, { signal }) =>
  completeCommand(createLlmClient(p.resolved), p.input, signal),
);

rpc.handle<{ resolved: ResolvedModel; input: CallInput }, unknown>('call', (p, { signal }) =>
  createLlmClient(p.resolved).call({ ...p.input, signal, onText: () => undefined, onThinking: () => undefined }),
);
