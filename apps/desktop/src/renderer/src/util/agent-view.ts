import type { AgentViewMessage, ThinkingChoice } from '@itm/protocol';

/** AI 对话界面里不依赖 React / 窗口的小工具（第二十六轮，单元测试也用） */

/** 一次提问：问题和它后面的回答（定位条的悬停卡片里显示） */
export interface RailEntry {
  id: string;
  question: string;
  answer: string;
}

/** 消息列表 → 每个用户提问一项；回答取到下一个提问之前的所有回答文字 */
export function railEntries(messages: AgentViewMessage[]): RailEntry[] {
  const out: RailEntry[] = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ id: m.id, question: m.text, answer: '' });
    else if (m.role === 'assistant' && out.length) {
      const last = out[out.length - 1];
      const text = m.text || m.skillRun?.summary || '';
      if (text && last.answer.length < 400) last.answer = `${last.answer}${last.answer ? '\n' : ''}${text}`.slice(0, 400);
    }
  }
  return out;
}

/** 当前思考设置在菜单里对应的一项：auto = 跟随模型默认 */
export function thinkingKey(choice: ThinkingChoice | undefined): string {
  if (!choice) return 'auto';
  if (!choice.enabled) return 'off';
  return choice.effort ?? 'on';
}

