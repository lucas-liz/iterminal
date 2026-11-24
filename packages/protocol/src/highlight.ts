/**
 * 终端输出高亮（参考 iShell 的「高亮设置」）：预设规则 + 自定义规则 + 彩虹括号。
 * 只给程序没有自己上色的普通文字加颜色；全屏程序（vim、top、less 等使用备用屏幕）里不生效。
 */

export type HighlightIcon = 'link' | 'globe' | 'mail' | 'calendar' | 'clock' | 'hash' | 'alert' | 'file' | 'table';

export interface HighlightPreset {
  id: string;
  name: string;
  icon: HighlightIcon;
  color: string;
  pattern: string;
  /** 额外的正则标志（g 总是加上） */
  flags?: string;
  /** 默认开启 */
  defaultOn: boolean;
  /** 重叠时的优先级：数字小的先占位置（例如 URL 里的 IP、路径不再单独着色） */
  priority: number;
}

export interface HighlightRule {
  id: string;
  name: string;
  pattern: string;
  color: string;
  /** 忽略大小写 */
  ignoreCase: boolean;
  enabled: boolean;
}

export interface HighlightSettings {
  /** 总开关 */
  enabled: boolean;
  /** 预设规则的开关（没有记录的按 defaultOn） */
  presets: Record<string, boolean>;
  custom: HighlightRule[];
  /** 彩虹括号：()[]{} 按嵌套层级着色 */
  rainbow: boolean;
  /** 备用屏幕（vim、less、top）里不高亮（默认开） */
  skipAltScreen?: boolean;
  /** 一段输出超过这么多字符就不高亮（默认 256K） */
  maxRun?: number;
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const H4 = '[0-9a-fA-F]{1,4}';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';

/** 预设规则（显示顺序）；颜色在深色和白色终端背景上都能看清 */
export const HIGHLIGHT_PRESETS: HighlightPreset[] = [
  { id: 'url', name: 'URL/URI', icon: 'link', color: '#3b82f6', priority: 1, defaultOn: true, pattern: '\\b(?:https?|ftp|sftp|ssh|file|wss?):\\/\\/[^\\s<>"\'`]*[^\\s<>"\'`.,;:!?)\\]}]' },
  { id: 'ipv4', name: 'IPv4', icon: 'globe', color: '#22c55e', priority: 5, defaultOn: true, pattern: `(?<![\\w.])(?:${OCTET}\\.){3}${OCTET}(?::\\d{1,5}|\\/\\d{1,2})?(?![\\w.])` },
  {
    id: 'ipv6',
    name: 'IPv6',
    icon: 'globe',
    color: '#14b8a6',
    priority: 4,
    defaultOn: true,
    pattern: `(?<![\\w:])(?:(?:${H4}:){7}${H4}|(?:${H4}(?::${H4}){0,6})?::(?:${H4}(?::${H4}){0,6})?)(?:\\/\\d{1,3})?(?![\\w:])`,
  },
  { id: 'email', name: 'Email', icon: 'mail', color: '#a855f7', priority: 2, defaultOn: true, pattern: '\\b[\\w.%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b' },
  {
    id: 'isoDate',
    name: 'ISO 日期（YYYY-MM-DD）',
    icon: 'calendar',
    color: '#f97316',
    priority: 7,
    defaultOn: true,
    pattern: '\\b\\d{4}([-/])(?:0[1-9]|1[0-2])\\1(?:0[1-9]|[12]\\d|3[01])(?:[T ](?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:[.,]\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?\\b',
  },
  {
    id: 'unixDate',
    name: 'Unix 日期（Mon Jan 01）',
    icon: 'calendar',
    color: '#eab308',
    priority: 8,
    defaultOn: true,
    pattern: `\\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\\s+${MONTH}\\s+\\d{1,2}(?:\\s+(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d)?(?:\\s+[A-Z]{2,5})?(?:\\s+\\d{4})?\\b`,
  },
  { id: 'time', name: '时间（HH:MM:SS）', icon: 'clock', color: '#06b6d4', priority: 10, defaultOn: true, pattern: '(?<![\\w:.])(?:[01]?\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?(?:[.,]\\d{1,9})?(?![\\w:])' },
  { id: 'syslogDate', name: 'Syslog 日期', icon: 'calendar', color: '#ec4899', priority: 9, defaultOn: true, pattern: `\\b${MONTH}\\s+(?:[12]\\d|3[01]|0?[1-9])\\s+(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\b` },
  { id: 'uuid', name: 'UUID', icon: 'hash', color: '#ef4444', priority: 6, defaultOn: true, pattern: '\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b' },
  {
    id: 'error',
    name: '错误（Error / Failed）',
    icon: 'alert',
    color: '#ef4444',
    priority: 13,
    defaultOn: true,
    flags: 'i',
    pattern: '\\b(?:errors?|err|failed|failure|fail|exception|fatal|critical|crit|panic|emerg|denied|refused|unreachable)\\b',
  },
  { id: 'warning', name: '警告（Warning）', icon: 'alert', color: '#eab308', priority: 14, defaultOn: true, flags: 'i', pattern: '\\b(?:warnings?|warn|caution|deprecated)\\b' },
  { id: 'info', name: '信息（Info）', icon: 'alert', color: '#0ea5e9', priority: 15, defaultOn: true, flags: 'i', pattern: '\\b(?:info|information|notice)\\b' },
  { id: 'debug', name: '调试（Debug / Trace）', icon: 'alert', color: '#94a3b8', priority: 16, defaultOn: true, flags: 'i', pattern: '\\b(?:debug|trace|verbose)\\b' },
  {
    id: 'success',
    name: '成功（Success / OK）',
    icon: 'alert',
    color: '#22c55e',
    priority: 17,
    defaultOn: true,
    flags: 'i',
    pattern: '\\b(?:success|successful|successfully|succeeded|ok|passed|done|complete|completed|active|running)\\b',
  },
  { id: 'number', name: '数字', icon: 'hash', color: '#06b6d4', priority: 19, defaultOn: false, pattern: '(?<![\\w.])\\d+(?:\\.\\d+)?(?![\\w.])' },
  { id: 'path', name: '文件路径', icon: 'file', color: '#a855f7', priority: 11, defaultOn: true, pattern: '(?<![\\w.~\\/:-])(?:~|\\.{1,2})?(?:\\/[\\w.@+-]+)+\\/?' },
  {
    id: 'size',
    name: '容量大小（KB / MB / GiB）',
    icon: 'hash',
    color: '#8b5cf6',
    priority: 12,
    defaultOn: true,
    pattern: '(?<![\\w.])\\d+(?:\\.\\d+)?\\s?(?:[KMGTPE]i?B|[KMGTPE]i|[KMGTPE]|bytes)(?![\\w])',
  },
  { id: 'table', name: '表格分隔线', icon: 'table', color: '#64748b', priority: 18, defaultOn: true, pattern: '(?:\\+[-=]{2,})+\\+|[-=]{4,}|[─━┄┈═]{2,}|[│┃║┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬]+' },
  { id: 'mac', name: 'MAC 地址', icon: 'globe', color: '#14b8a6', priority: 3, defaultOn: true, pattern: '\\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\\b' },
];

export const DEFAULT_HIGHLIGHT: HighlightSettings = { enabled: true, presets: {}, custom: [], rainbow: false };

/** 自定义规则可选的颜色 */
export const HIGHLIGHT_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#94a3b8',
];

/** 彩虹括号的层级颜色 */
export const RAINBOW_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#a855f7'];

/** 正则能否编译、是否会匹配空字符串（匹配空串会让高亮死循环） */
export function checkHighlightPattern(pattern: string, ignoreCase = false): string | null {
  if (!pattern.trim()) return '请填写正则表达式';
  if (pattern.length > 500) return '正则表达式太长（最多 500 个字符）';
  try {
    const re = new RegExp(pattern, ignoreCase ? 'gi' : 'g');
    if (re.test('')) return '这个正则会匹配空字符串，请修改';
  } catch (e) {
    return `正则表达式不正确：${(e as Error).message}`;
  }
  return null;
}

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
