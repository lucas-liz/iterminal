import { create } from 'zustand';
import { DEFAULT_SETTINGS, type AppInfo, type SecurityState, type Settings } from '@itm/protocol';
import { invoke } from '../api';
import { pushNavHistory, type AiView, type AppMode, type NavEntry, type Page } from '../util/nav';
import { normalizeSection, type SettingsSectionKey } from '../util/settings-sections';
export type { AiView, AppMode, NavEntry, Page, SettingsSectionKey };

const SIDER_KEY = 'itm.ui.siderCollapsed';

interface AppState {
  info: AppInfo | null;
  security: SecurityState | null;
  settings: Settings;
  /** 当前工作模式：终端模式 / AI 模式（决定左侧第一个图标和是否隐藏主机） */
  mode: AppMode;
  page: Page;
  /** AI 对话模式里打开的子视图（保留兼容） */
  aiView: AiView;
  setAiView(v: AiView): void;
  /** 切换终端 / AI 模式 */
  setMode(mode: AppMode): void;
  /** 离开 AI 对话模式：切回终端模式并回到指定页面或上次在终端模式里看的页面 */
  leaveAi(to?: Page): void;
  /** 终端模式里最后打开的页面 */
  termPage: Page;
  /** 导航历史栈：支持顶部栏返回上一级 / 前进 */
  navHistory: NavEntry[];
  navIndex: number;
  goBack(): void;
  goForward(): void;
  /** 页面次级侧边栏收起状态（AI 会话列表、主机分组树、数据库对象树、指令集/笔记分组、设置目录等），记在本机 */
  siderCollapsed: boolean;
  toggleSider(): void;
  setSiderCollapsed(v: boolean): void;
  settingsSection: SettingsSectionKey;
  /** 凭证管理小窗 */
  vaultOpen: boolean;
  setVaultOpen(open: boolean): void;
  /** 读取应用信息和安全状态（档案还没解锁时也能调用） */
  loadInfo(): Promise<AppInfo>;
  /** 档案解锁后读取设置 */
  load(): Promise<void>;
  setPage(page: Page): void;
  /** 打开设置页的某个模块 */
  openSettings(section: SettingsSectionKey): void;
  updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
}

export const useApp = create<AppState>((set) => ({
  info: null,
  security: null,
  settings: DEFAULT_SETTINGS,
  mode: 'terminal',
  page: 'workspace',
  aiView: 'chat',
  termPage: 'workspace',
  navHistory: [{ mode: 'terminal', page: 'workspace', aiView: 'chat' }],
  navIndex: 0,
  siderCollapsed: localStorage.getItem(SIDER_KEY) === '1',
  toggleSider() {
    set((s) => {
      const next = !s.siderCollapsed;
      localStorage.setItem(SIDER_KEY, next ? '1' : '0');
      return { siderCollapsed: next };
    });
  },
  setSiderCollapsed(v) {
    localStorage.setItem(SIDER_KEY, v ? '1' : '0');
    set({ siderCollapsed: v });
  },
  settingsSection: 'appearance',
  vaultOpen: false,
  setVaultOpen(open) {
    set({ vaultOpen: open });
  },
  async loadInfo() {
    const info = await invoke('app.info');
    set({ info, security: info.security });
    return info;
  },
  async load() {
    const [info, settings] = await Promise.all([invoke('app.info'), invoke('setting.getAll')]);
    set({ info, security: info.security, settings });
  },
  setMode(mode) {
    set((s) => {
      if (mode === 'ai') {
        const nextEntry: NavEntry = { mode: 'ai', page: 'ai', aiView: 'chat' };
        return { mode: 'ai', page: 'ai', aiView: 'chat', ...pushNavHistory(s.navHistory, s.navIndex, nextEntry) };
      }
      const nextPage = s.termPage === 'ai' ? 'workspace' : s.termPage;
      const nextEntry: NavEntry =
        nextPage === 'settings'
          ? { mode: 'terminal', page: nextPage, aiView: 'chat', settingsSection: s.settingsSection }
          : { mode: 'terminal', page: nextPage, aiView: 'chat' };
      return { mode: 'terminal', page: nextPage, aiView: 'chat', termPage: nextPage, ...pushNavHistory(s.navHistory, s.navIndex, nextEntry) };
    });
  },
  setPage(page) {
    set((s) => {
      const nextMode: AppMode = page === 'ai' ? 'ai' : page === 'workspace' || page === 'hosts' ? 'terminal' : s.mode;
      const nextEntry: NavEntry =
        page === 'settings'
          ? { mode: nextMode, page, aiView: 'chat', settingsSection: s.settingsSection }
          : { mode: nextMode, page, aiView: 'chat' };
      const hist = pushNavHistory(s.navHistory, s.navIndex, nextEntry);
      return {
        mode: nextMode,
        page,
        aiView: 'chat',
        ...(nextMode === 'terminal' && page !== 'ai' ? { termPage: page } : {}),
        ...hist,
      };
    });
  },
  setAiView(aiView) {
    set((s) => {
      if (aiView !== 'chat') {
        const nextPage = aiView as Page;
        const nextEntry: NavEntry =
          nextPage === 'settings'
            ? { mode: s.mode, page: nextPage, aiView: 'chat', settingsSection: s.settingsSection }
            : { mode: s.mode, page: nextPage, aiView: 'chat' };
        return { page: nextPage, aiView: 'chat', ...pushNavHistory(s.navHistory, s.navIndex, nextEntry) };
      }
      return { aiView: 'chat' };
    });
  },
  leaveAi(to) {
    set((s) => {
      const page = !to || to === 'ai' ? (s.termPage === 'ai' ? 'workspace' : s.termPage) : to;
      const nextEntry: NavEntry =
        page === 'settings'
          ? { mode: 'terminal', page, aiView: 'chat', settingsSection: s.settingsSection }
          : { mode: 'terminal', page, aiView: 'chat' };
      return { mode: 'terminal', page, aiView: 'chat', termPage: page, ...pushNavHistory(s.navHistory, s.navIndex, nextEntry) };
    });
  },
  openSettings(section) {
    section = normalizeSection(section);
    set((s) => ({
      page: 'settings',
      aiView: 'chat',
      ...(s.mode === 'terminal' ? { termPage: 'settings' as Page } : {}),
      settingsSection: section,
      ...pushNavHistory(s.navHistory, s.navIndex, { mode: s.mode, page: 'settings', aiView: 'chat', settingsSection: section }),
    }));
  },
  goBack() {
    set((s) => {
      if (s.navIndex <= 0) return {};
      const navIndex = s.navIndex - 1;
      const entry = s.navHistory[navIndex];
      return {
        navIndex,
        mode: entry.mode,
        page: entry.page,
        aiView: entry.aiView,
        ...(entry.mode === 'terminal' && entry.page !== 'ai' ? { termPage: entry.page } : {}),
        ...(entry.settingsSection ? { settingsSection: entry.settingsSection } : {}),
      };
    });
  },
  goForward() {
    set((s) => {
      if (s.navIndex >= s.navHistory.length - 1) return {};
      const navIndex = s.navIndex + 1;
      const entry = s.navHistory[navIndex];
      return {
        navIndex,
        mode: entry.mode,
        page: entry.page,
        aiView: entry.aiView,
        ...(entry.mode === 'terminal' && entry.page !== 'ai' ? { termPage: entry.page } : {}),
        ...(entry.settingsSection ? { settingsSection: entry.settingsSection } : {}),
      };
    });
  },
  async updateSetting(key, value) {
    await invoke('setting.set', { key, value });
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
  },
}));

window.itm.on('security.state', (security) => useApp.setState((s) => ({ security, info: s.info ? { ...s.info, security } : s.info })));
