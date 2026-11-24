import type { AgentConversationView, AgentStep } from '@itm/protocol';

const TOOL_LABEL: Record<string, string> = {
  run_command: '执行命令',
  ssh_exec_batch: '批量执行',
  read_terminal: '读取终端',
  get_metrics: '读取监控',
  host_list: '查找主机',
  sftp_list: '列出目录',
  sftp_read: '读取文件',
  sftp_write: '写入文件',
  file_upload: '上传文件',
  file_download: '下载文件',
  serial_send: '串口发送',
  kb_search: '检索知识库',
  skill_load: '读取 Skill',
  mcp_call: 'MCP 工具',
  ask_user: '提问',
  memory_propose: '主机记忆',
  schedule_task: '创建定时任务',
  schedule_list: '查看定时任务',
};
const LEVEL: Record<string, string> = { L0: '安全', L1: '需注意', L2: '高危', DENY: '已拒绝' };
const STATUS: Record<string, string> = { done: '完成', error: '失败', rejected: '已拒绝', skipped: '已跳过', canceled: '已取消', running: '执行中', approval: '等待批准', pending: '等待中' };

const time = (t: number): string => {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 代码块：内容里有 ``` 时用更长的围栏 */
function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${text.replace(/\n+$/, '')}\n${f}`;
}

function stepMd(s: AgentStep, maxOutput: number): string {
  const head = [`**${TOOL_LABEL[s.tool] ?? s.tool}**`, s.hostName && `${s.hostName}${s.hostLabel ? `（${s.hostLabel}）` : ''}`, s.level && LEVEL[s.level], STATUS[s.status] ?? s.status, s.exitCode !== null && s.exitCode !== undefined && `退出码 ${s.exitCode}`]
    .filter(Boolean)
    .join(' · ');
  const parts = [head];
  if (s.explanation) parts.push(`> 作用：${s.explanation}`);
  if (s.command) parts.push(fence(s.command, s.tool === 'run_command' || s.tool === 'ssh_exec_batch' ? 'bash' : ''));
  if (s.batch?.length) parts.push(s.batch.map((b) => `- ${b.hostName}：${STATUS[b.status] ?? b.status}${b.exitCode !== null && b.exitCode !== undefined ? `（退出码 ${b.exitCode}）` : ''}`).join('\n'));
  if (s.answer) parts.push(`用户回答：${s.answer}`);
  const out = s.output?.trim();
  if (out && maxOutput > 0) {
    const clipped = out.length > maxOutput ? `${out.slice(0, maxOutput)}\n…（输出共 ${out.length} 个字符，已截断）` : out;
    parts.push(`<details><summary>输出</summary>\n\n${fence(clipped)}\n\n</details>`);
  }
  return parts.join('\n\n');
}

/**
 * 把整个对话转成 Markdown（导出文件、存为笔记）：问题、回答、每一步执行的命令（主机、风险、作用、退出码）和输出（截断）。
 * 思考过程不导出。
 */
export function conversationToMarkdown(v: AgentConversationView, opts: { maxOutput?: number; now?: number } = {}): string {
  const maxOutput = opts.maxOutput ?? 4000;
  const lines: string[] = [`# ${v.title || 'AI 对话'}`, '', `> 导出于 ${time(opts.now ?? Date.now())}${v.model ? ` · 模型 ${v.model.modelId}` : ''}`];
  for (const m of v.messages) {
    if (m.role === 'user') {
      lines.push('', `## 问题 · ${time(m.createdAt)}`, '', m.text.trim());
      if (m.refLabels.length) lines.push('', `*引用：${m.refLabels.join('、')}*`);
    } else if (m.role === 'assistant') {
      lines.push('', `### 回答 · ${time(m.createdAt)}`);
      if (m.text.trim()) lines.push('', m.text.trim());
      if (m.skillRun) lines.push('', `*Skill「${m.skillRun.skillName}」：${m.skillRun.summary ?? ''}*`);
      for (const s of m.steps) lines.push('', stepMd(s, maxOutput));
      if (m.notice) lines.push('', `> ${m.notice}`);
    } else if (m.role === 'summary') {
      lines.push('', '---', '', '*以上对话已压缩成摘要：*', '', m.text.trim(), '', '---');
    } else {
      lines.push('', `> ${m.text}`);
    }
  }
  return `${lines.join('\n').trim()}\n`;
}

/** AI 汇总用的提示词（存为笔记时勾选「使用 AI 进行汇总」） */
export const NOTE_SUMMARY_SYSTEM = [
  '你是运维记录整理助手。把下面这段运维对话整理成一篇简洁的中文笔记（Markdown），方便以后查阅和复用：',
  '- 开头一句话说明要解决的问题和结论；',
  '- 「排查过程」：按顺序列出关键步骤和发现（主机、命令、看到的关键输出），去掉无关的试错；',
  '- 「处理方法」：最终有效的操作，命令放在代码块里，可以直接复制执行；',
  '- 「注意事项」：风险、回滚方法、后续建议（没有就省略）。',
  '不要编造对话里没有的信息；不要输出思考过程；不要再加总标题以外的前言。',
].join('\n');
