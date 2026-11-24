import { COMPRESS_INSTRUCTION, COMPRESS_SYSTEM } from './prompt';
import { clip } from './text';
import type { LlmClient, StoredMessage } from './llm/types';
import { UserError } from './errors';

/** 压缩用的对话文本：问题、回答、执行过的命令和结果（输出截短） */
export function renderTranscript(messages: StoredMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      for (const b of m.blocks) {
        if (b.kind === 'question') parts.push(`用户：${b.text}`);
        else if (b.kind === 'summary') parts.push(b.text);
        else if (b.kind === 'context' && b.label === 'terminals') parts.push(b.text);
      }
    } else if (m.role === 'assistant') {
      if (m.text) parts.push(`助手：${m.text}`);
    } else if (m.role === 'tool_results') {
      for (const r of m.results) parts.push(`[${r.step.hostLabel} ${r.step.hostName}] ${r.step.command}\n${clip(r.content, 1500)}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * 简单压缩：让模型把整段历史总结成一份摘要（不回放之前的思考块，符合历史只追加的要求）。
 */
export async function summarize(client: LlmClient, history: StoredMessage[], contextWindow: number, signal: AbortSignal): Promise<string> {
  const budgetChars = Math.floor(contextWindow * 0.5 * 3);
  const transcript = clip(renderTranscript(history), budgetChars);
  const result = await client.call({
    system: COMPRESS_SYSTEM,
    messages: [{ role: 'user', mode: 'ask', blocks: [{ kind: 'question', text: COMPRESS_INSTRUCTION + transcript }] }],
    tools: [],
    signal,
    onText: () => undefined,
    onThinking: () => undefined,
  });
  const summary = result.text.trim();
  if (!summary) throw new UserError('压缩失败：模型没有返回摘要');
  return summary;
}
