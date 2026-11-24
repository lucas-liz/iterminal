import { stripAnsi } from '@itm/agent-core';
import type { RecordingCommand, RecordingData } from '@itm/protocol';

/** 终端输出 → 纯文本：去掉转义序列，按回车覆盖、退格删除（够 AI 阅读，不追求和屏幕完全一致） */
export function terminalText(raw: string): string {
  // 退格先处理（去转义序列时会把退格一起去掉）：删掉它前面的那个字符
  let s = raw;
  // eslint-disable-next-line no-control-regex
  for (let i = 0; i < 1000 && /[^\x08\n]\x08/.test(s); i++) s = s.replace(/[^\x08\n]\x08/g, '');
  const lines = stripAnsi(s).replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of lines) {
    // 回车回到行首：只保留最后一段（进度条等）
    const l = line.includes('\r') ? line.slice(line.lastIndexOf('\r') + 1) || line.split('\r').filter(Boolean).pop() || '' : line;
    // eslint-disable-next-line no-control-regex
    out.push(l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd());
  }
  // 连续的空行压成一行
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * 交给 AI 汇总的录像内容：基本信息、执行过的命令（带时间）、终端输出节选（太长时保留开头和结尾）。
 * 调用方负责脱敏。
 */
export function recordingTranscript(data: RecordingData, commands: RecordingCommand[], maxOutput = 60_000): string {
  const output = terminalText(data.events.filter((e) => e[1] === 'o').map((e) => e[2]).join(''));
  const clipped =
    output.length <= maxOutput ? output : `${output.slice(0, Math.floor(maxOutput * 0.25))}\n\n…（中间省略 ${output.length - maxOutput} 个字符）…\n\n${output.slice(-Math.floor(maxOutput * 0.75))}`;
  const info = data.info;
  return [
    `主机：${info.hostName}（${info.kind}）`,
    `开始时间：${new Date(info.startedAt).toLocaleString('zh-CN', { hour12: false })}，时长 ${mmss(info.durationMs)}`,
    '',
    '## 执行的命令',
    commands.length ? commands.map((c, i) => `${i + 1}. [${mmss(c.offsetMs)}]${c.source && c.source !== 'USER' ? `（${c.source}）` : ''} ${c.command}`).join('\n') : '（没有记录到命令）',
    '',
    '## 终端输出',
    '```',
    clipped || '（没有输出）',
    '```',
  ].join('\n');
}
