import type { NavOptional } from '@itm/protocol';
import type { SettingsSectionKey } from './settings-sections';

export type AppMode = 'terminal' | 'ai';
export type Page = 'ai' | 'hosts' | 'databases' | 'workspace' | 'monitor' | 'snippets' | 'notes' | 'audit' | 'batch' | 'approvals' | 'settings';
/** AI 对话模式里打开的子视图（保留兼容，默认 chat） */
export type AiView = 'chat' | 'notes' | 'audit' | 'batch' | 'settings' | 'snippets';

export type NavPageKey = Exclude<Page, 'ai'>;

/** 全部业务导航页面；required = 固定常驻或在头像菜单中，不在隐藏设置里取消 */
export const NAV_PAGES: { key: NavPageKey; label: string; required?: boolean }[] = [
  { key: 'workspace', label: '终端', required: true },
  { key: 'hosts', label: '主机', required: true },
  { key: 'notes', label: '笔记', required: true },
  { key: 'audit', label: '运维审计', required: true },
  { key: 'batch', label: '批量执行', required: true },
  { key: 'databases', label: '数据库' },
  { key: 'snippets', label: '指令集' },
  { key: 'monitor', label: '监控' },
  { key: 'approvals', label: '审批' },
  { key: 'settings', label: '设置', required: true },
];

/** 终端模式下，最左侧常驻图标栏固定展示的 5 个页面（第三十五轮：定时任务换成批量执行） */
export const PRIMARY_NAV_KEYS: readonly Page[] = ['workspace', 'hosts', 'notes', 'audit', 'batch'];

/** AI 模式下，最左侧常驻图标栏展示的页面：第一个变为 AI 对话，不展示主机 */
export const AI_PRIMARY_NAV_KEYS: readonly Page[] = ['ai', 'notes', 'audit', 'batch'];

/** 收进最左栏 ··· 悬浮菜单里的其余页面（设置已收进左下角头像菜单） */
export const OVERFLOW_NAV_KEYS: readonly NavPageKey[] = ['databases', 'snippets', 'monitor', 'approvals'];

/** 带有可收起次级侧边栏的页面 */
const SECONDARY_SIDER_PAGES = new Set<Page>(['ai', 'hosts', 'databases', 'snippets', 'notes', 'settings']);

export const pageHasSecondarySider = (page: Page): boolean => SECONDARY_SIDER_PAGES.has(page);

export const isOptionalNav = (key: string): key is NavOptional => NAV_PAGES.some((n) => n.key === key && !n.required);

export interface NavEntry {
  mode: AppMode;
  page: Page;
  aiView: AiView;
  settingsSection?: SettingsSectionKey;
}

export const MAX_NAV_HISTORY = 50;

export function sameNavEntry(a: NavEntry, b: NavEntry): boolean {
  if (a.mode !== b.mode || a.page !== b.page || a.aiView !== b.aiView) return false;
  if (a.page === 'settings') return a.settingsSection === b.settingsSection;
  return true;
}

export function pushNavHistory(history: NavEntry[], index: number, next: NavEntry): { navHistory: NavEntry[]; navIndex: number } {
  const cur = history[index];
  if (cur && sameNavEntry(cur, next)) return { navHistory: history, navIndex: index };
  const trimmed = history.slice(0, index + 1);
  trimmed.push(next);
  if (trimmed.length > MAX_NAV_HISTORY) trimmed.shift();
  return { navHistory: trimmed, navIndex: trimmed.length - 1 };
}
