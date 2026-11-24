import { REVIEW_PROMPT } from './prompt';
import type { LlmClient } from './llm/types';

export type ReviewLevel = 'L0' | 'L1' | 'L2';

/** 从模型的回答里取出 {"level","reason"}；格式不对时返回 null（不影响规则判定） */
export function parseReview(text: string): { level: ReviewLevel; reason: string } | null {
  const m = /\{[\s\S]*?\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { level?: unknown; reason?: unknown };
    if (o.level !== 'L0' && o.level !== 'L1' && o.level !== 'L2') return null;
    return { level: o.level, reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '' };
  } catch {
    return null;
  }
}

/** LLM 复核一条命令（文档一 7.5 第 4 步）。超时 30 秒。 */
export async function reviewCommand(client: LlmClient, command: string, ruleLevel: string, ruleReasons: string[], signal?: AbortSignal): Promise<{ level: ReviewLevel; reason: string } | null> {
  const result = await client.call({
    system: REVIEW_PROMPT,
    messages: [
      {
        role: 'user',
        mode: 'ask',
        blocks: [{ kind: 'question', text: `命令：\n${command}\n\n规则引擎判定：${ruleLevel}（${ruleReasons.join('；') || '无'}）` }],
      },
    ],
    tools: [],
    signal: signal ?? AbortSignal.timeout(30_000),
    onText: () => undefined,
    onThinking: () => undefined,
  });
  return parseReview(result.text);
}

/** AI 自动审批（第十四轮）：只输出 {"auto": true|false, "reason": "..."} */
export const AUTO_APPROVE_PROMPT = `你是运维命令的审批助手。用户把这次对话的审批交给了你：给你一条 Agent 将要在服务器上执行的 shell 命令、规则引擎的判定和主机信息，
判断它能不能不经过人工确认直接执行。
- 可以直接执行（auto=true）：常规、可预期、影响范围小、容易回滚的操作，例如重启单个业务服务、修改应用配置、清理明确的临时文件、安装常用软件包；
- 需要人工确认（auto=false）：删除或覆盖数据、影响范围大或不可逆、涉及数据库 / 防火墙 / 用户和权限 / 磁盘分区、关机重启主机、批量操作、执行下载的脚本、目的不明确或命令被混淆的情况。
拿不准时选 false。只输出一行 JSON：{"auto":true|false,"reason":"一句话理由"}`;

/** 取出 {"auto","reason"}；格式不对时返回 null（按需要人工确认处理） */
export function parseAutoApprove(text: string): { auto: boolean; reason: string } | null {
  const m = /\{[\s\S]*?\}/.exec(text);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { auto?: unknown; reason?: unknown };
    if (typeof o.auto !== 'boolean') return null;
    return { auto: o.auto, reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '' };
  } catch {
    return null;
  }
}
