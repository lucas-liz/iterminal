import { formatSize } from './format';

export const formatRate = (bps: number): string => `${formatSize(bps)}/s`;

export function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  return `${m}分钟`;
}

export const pct = (used: number, total: number): number => (total > 0 ? (used / total) * 100 : 0);
