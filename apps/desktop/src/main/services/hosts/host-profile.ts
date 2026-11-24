import type { AlertEvent, DiskForecast, Host, HostAgentMemory, MetricSample, TaskRunView } from '@itm/protocol';

/**
 * 主机资料（第三十轮）：主机列表「导出主机记忆」生成 Markdown 文件，「AI 汇总为笔记」把一台或多台主机的资料拼成发给模型的文字。
 * 只用到主机的非秘密字段（不含密码、私钥）。
 */

/** 一台主机和它的记忆 */
export interface HostMemoryEntry {
  host: Host;
  /** 分组路径，例如「生产 / 数据库」；不在分组里为空 */
  folderPath: string;
  memories: HostAgentMemory[];
}

/** AI 汇总时一台主机的全部资料 */
export interface HostProfileEntry extends HostMemoryEntry {
  /** 跳板机名称（按顺序） */
  jumpNames: string[];
  /** 最近 7 天的整点采样 */
  samples: MetricSample[];
  forecast: DiskForecast[];
  alerts: AlertEvent[];
  runs: TaskRunView[];
  commands: { command: string; source: string | null; exitCode: number | null; createdAt: number }[];
}

const time = (ts: number): string => new Date(ts).toLocaleString('zh-CN', { hour12: false });

export function hostAddress(h: Host): string {
  if (h.protocol === 'SERIAL') return h.address;
  const def = h.protocol === 'TELNET' ? 23 : 22;
  return `${h.username ? `${h.username}@` : ''}${h.address}${h.port === def ? '' : `:${h.port}`}`;
}

/** 导出文件的默认文件名：一台主机用主机名，多台用「主机记忆-日期」 */
export function memoryFileName(hosts: Host[], now: number): string {
  const d = new Date(now);
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const base = hosts.length === 1 ? `${hosts[0].name}-主机记忆` : `主机记忆-${day}`;
  return `${base.replace(/[\\/:*?"<>|\s]+/g, '_')}.md`;
}

/** 多行文字原样放进 Markdown：每行前面加引用符号，避免里面的 # 被当成标题 */
const quoteBlock = (text: string): string =>
  text
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');

/**
 * 主机记忆导出成 Markdown：每台主机一节，基本信息、手工填写的主机记忆、Agent 记下的记忆（带时间）。
 * withEmpty = false 时跳过两种记忆都没有的主机（全部都没有时仍然列出，并注明）。
 */
export function hostMemoryMarkdown(entries: HostMemoryEntry[], now: number, withEmpty = false): string {
  const has = (e: HostMemoryEntry): boolean => !!e.host.aiMemory?.trim() || e.memories.length > 0;
  const list = withEmpty || !entries.some(has) ? entries : entries.filter(has);
  const out: string[] = [entries.length === 1 ? `# ${entries[0].host.name} · 主机记忆` : '# 主机记忆', '', `> 导出时间：${time(now)} · 共 ${list.length} 台主机`, ''];
  for (const e of list) {
    const h = e.host;
    if (entries.length > 1) out.push(`## ${h.name}`, '');
    const meta = [`- 地址：\`${hostAddress(h)}\`${h.protocol === 'SSH' ? '' : `（${h.protocol === 'TELNET' ? 'Telnet' : '串口'}）`}`];
    if (e.folderPath) meta.push(`- 分组：${e.folderPath}`);
    if (h.tags.length) meta.push(`- 标签：${h.tags.join('、')}`);
    if (h.osInfo) meta.push(`- 系统：${h.osInfo}`);
    if (h.note?.trim()) meta.push(`- 备注：${h.note.trim().replace(/\s*\n\s*/g, ' ')}`);
    out.push(...meta, '');
    const sub = entries.length > 1 ? '###' : '##';
    out.push(`${sub} 主机记忆（手工填写）`, '', h.aiMemory?.trim() ? quoteBlock(h.aiMemory) : '_（无）_', '');
    out.push(`${sub} Agent 记忆`, '');
    if (e.memories.length === 0) out.push('_（无）_', '');
    else {
      for (const m of e.memories) out.push(`- ${m.content.trim().replace(/\r?\n/g, '\n  ')}  \n  <sub>${time(m.updatedAt)}</sub>`);
      out.push('');
    }
  }
  if (!entries.some(has)) out.push('_这些主机都还没有记忆。_', '');
  return `${out.join('\n').trimEnd()}\n`;
}

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const nums = (xs: (number | null)[]): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

/** 最近 7 天监控的概况：CPU / 内存 平均和最高、最高负载、每个分区现在和 7 天前的使用率、写满预测 */
export function metricsSummary(samples: MetricSample[], forecast: DiskForecast[]): string[] {
  if (samples.length === 0) return [];
  const lines: string[] = [`采样 ${samples.length} 个整点（${time(samples[0].ts)} ~ ${time(samples[samples.length - 1].ts)}）`];
  const cpu = nums(samples.map((s) => s.cpu));
  if (cpu.length) lines.push(`CPU 平均 ${avg(cpu).toFixed(1)}%，最高 ${Math.max(...cpu).toFixed(1)}%`);
  const mem = nums(samples.map((s) => s.mem));
  if (mem.length) lines.push(`内存 平均 ${avg(mem).toFixed(1)}%，最高 ${Math.max(...mem).toFixed(1)}%`);
  const load = nums(samples.map((s) => s.load1));
  if (load.length) lines.push(`1 分钟负载 平均 ${avg(load).toFixed(2)}，最高 ${Math.max(...load).toFixed(2)}`);
  const first = samples[0].disk;
  const last = samples[samples.length - 1].disk;
  const mounts = Object.keys(last);
  if (mounts.length) lines.push(`分区：${mounts.map((m) => `${m} ${last[m].toFixed(0)}%${first[m] !== undefined && Math.abs(last[m] - first[m]) >= 1 ? `（7 天前 ${first[m].toFixed(0)}%）` : ''}`).join('，')}`);
  for (const f of forecast) if (f.daysToFull !== null) lines.push(`${f.mount} 每天增长约 ${f.slopePerDay.toFixed(1)} 个百分点，预计 ${f.daysToFull.toFixed(1)} 天后写满`);
  return lines;
}

/** 发给模型的一台主机的资料（之后统一脱敏） */
export function hostProfileText(e: HostProfileEntry): string {
  const h = e.host;
  const out: string[] = [`## 主机：${h.name}`, '', '### 基本信息'];
  out.push(`- 协议：${h.protocol}；地址：${hostAddress(h)}`);
  if (e.folderPath) out.push(`- 分组：${e.folderPath}`);
  if (h.tags.length) out.push(`- 标签：${h.tags.join('、')}`);
  if (h.osInfo) out.push(`- 系统：${h.osInfo}`);
  if (h.note?.trim()) out.push(`- 备注：${h.note.trim()}`);
  if (e.jumpNames.length) out.push(`- 经跳板机：${e.jumpNames.join(' → ')}`);
  if (h.proxy) out.push(`- 代理：${h.proxy.type}`);
  if (h.team) out.push('- 团队主机（管理员维护）');
  out.push(`- 最近连接：${h.lastConnectedAt ? time(h.lastConnectedAt) : '从未'}`);
  if (h.aiMemory?.trim()) out.push('', '### 主机记忆（手工填写）', h.aiMemory.trim().slice(0, 6000));
  if (e.memories.length) out.push('', '### Agent 记忆', ...e.memories.slice(0, 50).map((m) => `- ${m.content.trim().slice(0, 800)}`));
  const metrics = metricsSummary(e.samples, e.forecast);
  if (metrics.length) out.push('', '### 最近 7 天监控', ...metrics.map((l) => `- ${l}`));
  if (e.alerts.length) {
    out.push('', '### 最近 30 天告警');
    for (const a of e.alerts.slice(0, 20)) {
      const diag = a.diagnosis?.report?.trim() ? `；AI 排查：${a.diagnosis.report.trim().replace(/\s+/g, ' ').slice(0, 300)}` : '';
      out.push(`- ${time(a.createdAt)} [${a.level}] ${a.title}${a.count > 1 ? `（${a.count} 次）` : ''}，${a.status === 'FIRING' ? '告警中' : '已恢复'}${diag}`);
    }
  }
  if (e.runs.length) {
    out.push('', '### 最近的定时任务');
    for (const r of e.runs.slice(0, 8)) {
      const mine = r.hosts.find((x) => x.hostId === h.id);
      const report = r.summary?.trim() ? `：${r.summary.trim().replace(/\s+/g, ' ').slice(0, 400)}` : mine?.message ? `：${mine.message.slice(0, 200)}` : '';
      out.push(`- ${time(r.startedAt)} ${r.taskName ?? '定时任务'} · ${r.status}${r.reportLevel ? ` · 结论 ${r.reportLevel}` : ''}${report}`);
    }
  }
  if (e.commands.length) {
    out.push('', '### 最近执行过的命令（去重，新的在前）');
    for (const c of e.commands) out.push(`- \`${c.command.replace(/\s+/g, ' ').slice(0, 300)}\`${c.source && c.source !== 'USER' ? ` (${c.source})` : ''}${c.exitCode ? ` 退出码 ${c.exitCode}` : ''}`);
  }
  return out.join('\n');
}
