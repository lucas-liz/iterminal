import { DISK_WARN_DAYS, usageLevel, type DiskForecast, type MetricsSnapshot, type MonitorAlert, type MonitorAlertConfig } from '@itm/protocol';
import { formatRate, formatUptime, pct } from './metrics';

/** 卡片整体状态：严重 / 注意 / 正常 / 连不上 / 不支持 / 正在连接 */
export type CardLevel = 'crit' | 'warn' | 'ok' | 'offline' | 'unsupported' | 'pending';

export interface AttentionItem {
  level: 'crit' | 'warn';
  kind: 'cpu' | 'mem' | 'disk' | 'forecast' | 'load' | 'iowait' | 'swap' | 'reboot' | 'offline';
  text: string;
}

/** 刚重启：运行时间少于这个值时提示 */
const REBOOT_SEC = 3600;

/**
 * 监控卡片上「需要注意」的内容（第二十七轮）：按告警阈值判断 CPU、内存、每个分区，加上磁盘写满预测、负载、IO 等待、
 * swap、刚重启；常驻主机持续超过阈值的告警（主进程算的）在文字后面带上持续时间。严重的排在前面。
 */
export function attentionOf(snap: MetricsSnapshot | undefined, cfg: MonitorAlertConfig, forecast: DiskForecast[] = [], alerts: MonitorAlert[] = [], now = Date.now()): { level: CardLevel; items: AttentionItem[] } {
  if (!snap) return { level: 'pending', items: [] };
  if (snap.state !== 'ok') return snap.state === 'unsupported' ? { level: 'unsupported', items: [] } : { level: 'offline', items: [{ level: 'crit', kind: 'offline', text: snap.message }] };
  const items: AttentionItem[] = [];
  const lasting = (kind: MonitorAlert['kind']): string => {
    const a = alerts.find((x) => x.hostId === snap.hostId && x.kind === kind);
    const min = a ? Math.floor((now - a.since) / 60_000) : 0;
    return a && min >= 1 ? `，已持续 ${min} 分钟` : '';
  };
  if (snap.cpu) {
    const lv = usageLevel(snap.cpu.usage, cfg.cpu);
    if (lv !== 'ok') items.push({ level: lv, kind: 'cpu', text: `CPU ${snap.cpu.usage.toFixed(0)}%${lasting('cpu')}` });
    if (snap.cpu.iowait >= 30) items.push({ level: 'warn', kind: 'iowait', text: `IO 等待 ${snap.cpu.iowait.toFixed(0)}%` });
  }
  const memPct = pct(snap.mem.used, snap.mem.total);
  const memLv = usageLevel(memPct, cfg.mem);
  if (memLv !== 'ok') items.push({ level: memLv, kind: 'mem', text: `内存 ${memPct.toFixed(0)}%${lasting('mem')}` });
  if (snap.mem.swapTotal > 0 && pct(snap.mem.swapUsed, snap.mem.swapTotal) >= 50) items.push({ level: 'warn', kind: 'swap', text: `swap ${pct(snap.mem.swapUsed, snap.mem.swapTotal).toFixed(0)}%` });
  for (const d of [...snap.disks].sort((a, b) => b.usePct - a.usePct)) {
    const lv = usageLevel(d.usePct, cfg.disk);
    if (lv !== 'ok') items.push({ level: lv, kind: 'disk', text: `${d.mount} ${d.usePct.toFixed(0)}%` });
  }
  for (const f of forecast) {
    if (f.daysToFull !== null && f.daysToFull < DISK_WARN_DAYS) items.push({ level: f.daysToFull < 2 ? 'crit' : 'warn', kind: 'forecast', text: `${f.mount} 约 ${f.daysToFull.toFixed(1)} 天写满` });
  }
  const cores = snap.cpu?.cores ?? 0;
  if (cores > 0 && snap.load[0] / cores >= 1.5) items.push({ level: snap.load[0] / cores >= 3 ? 'crit' : 'warn', kind: 'load', text: `负载 ${snap.load[0].toFixed(1)}（${cores} 核）` });
  if (snap.uptimeSec > 0 && snap.uptimeSec < REBOOT_SEC) items.push({ level: 'warn', kind: 'reboot', text: `刚重启（运行 ${formatUptime(snap.uptimeSec)}）` });
  items.sort((a, b) => (a.level === b.level ? 0 : a.level === 'crit' ? -1 : 1));
  return { level: items.some((i) => i.level === 'crit') ? 'crit' : items.length ? 'warn' : 'ok', items };
}

/** 排序用的权重：严重 > 连不上 > 注意 > 正在连接 > 正常 > 不支持 */
export const LEVEL_RANK: Record<CardLevel, number> = { crit: 0, offline: 1, warn: 2, pending: 3, ok: 4, unsupported: 5 };

/** 按名称、地址、备注、标签、系统信息搜索（空格分开的多个词都要命中） */
export function hostMatches(h: { name: string; address: string; note: string | null; tags: string[]; osInfo: string | null; username: string }, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${h.name} ${h.address} ${h.username}@${h.address} ${h.note ?? ''} ${h.tags.join(' ')} ${h.osInfo ?? ''}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** 运行时长筛选 */
export type UptimeFilter = '' | 'recent' | 'month' | 'half';
export function uptimeMatches(uptimeSec: number | null, f: UptimeFilter): boolean {
  if (!f) return true;
  if (uptimeSec === null) return false;
  if (f === 'recent') return uptimeSec < 86_400;
  if (f === 'month') return uptimeSec >= 30 * 86_400;
  return uptimeSec >= 180 * 86_400;
}

/**
 * 监控卡片「引用当前状态到 AI」放进输入框的文字（第三十轮）：主机、需要注意的地方、CPU / 内存 / 各分区 / 网络 / 运行时长；
 * AI 面板把它作为代码块加到输入框，用户在后面补充问题再发送
 */
export function cardQuoteText(host: { name: string; address: string }, snap: MetricsSnapshot | undefined, items: AttentionItem[]): string {
  const lines = [`主机「${host.name}」（${host.address}）当前监控状态：`];
  if (!snap) lines.push('- 还没有采集到数据（正在连接）');
  else if (snap.state !== 'ok') lines.push(`- ${snap.state === 'unsupported' ? '不支持采集' : '连不上'}：${snap.message}`);
  else {
    if (snap.cpu) lines.push(`- CPU ${snap.cpu.usage.toFixed(1)}%（${snap.cpu.cores} 核，IO 等待 ${snap.cpu.iowait.toFixed(0)}%），负载 ${snap.load.map((l) => l.toFixed(2)).join(' ')}`);
    lines.push(`- 内存 ${pct(snap.mem.used, snap.mem.total).toFixed(0)}%${snap.mem.swapTotal > 0 ? `，swap ${pct(snap.mem.swapUsed, snap.mem.swapTotal).toFixed(0)}%` : ''}`);
    if (snap.disks.length) lines.push(`- 分区：${[...snap.disks].sort((a, b) => b.usePct - a.usePct).map((d) => `${d.mount} ${d.usePct.toFixed(0)}%`).join('，')}`);
    if (snap.net.length) lines.push(`- 网络：下行 ${formatRate(snap.net.reduce((a, n) => a + n.rxBps, 0))}，上行 ${formatRate(snap.net.reduce((a, n) => a + n.txBps, 0))}`);
    if (snap.uptimeSec > 0) lines.push(`- 已运行 ${formatUptime(snap.uptimeSec)}`);
  }
  const issues = items.filter((i) => i.kind !== 'offline');
  if (issues.length) lines.push(`需要注意：${issues.map((i) => i.text).join('；')}`);
  return lines.join('\n');
}
