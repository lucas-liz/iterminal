import { COMPLETION_PROMPT } from './prompt';
import type { LlmClient } from './llm/types';

/**
 * 终端行内补全（文档一 6.1）：本地候选没有命中时请求补全模型。返回补全后的整行命令（必须以已输入的内容开头），没有时返回 null。
 */
export async function completeCommand(
  client: LlmClient,
  input: { prefix: string; host: string; recentOutput: string; history: string[] },
  signal: AbortSignal,
): Promise<string | null> {
  const result = await client.call({
    system: COMPLETION_PROMPT,
    messages: [
      {
        role: 'user',
        mode: 'ask',
        blocks: [
          {
            kind: 'question',
            text:
              `主机：${input.host}\n最近执行过的命令：\n${input.history.slice(-10).join('\n') || '（无）'}\n\n` +
              `最近的终端输出：\n${input.recentOutput.slice(-1500)}\n\n已经输入：${input.prefix}`,
          },
        ],
      },
    ],
    tools: [],
    signal,
    onText: () => undefined,
    onThinking: () => undefined,
  });
  const line = result.text.split('\n').map((l) => l.replace(/^`+|`+$/g, '').trim()).find(Boolean) ?? '';
  if (!line || !line.startsWith(input.prefix) || line === input.prefix || line.length > 500) return null;
  return line;
}
