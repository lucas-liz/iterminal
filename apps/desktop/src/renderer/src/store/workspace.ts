import { create } from 'zustand';

export type RightMode = 'files' | 'monitor' | 'ai';
/** 监控详情的分类标签 */
export type MonitorTab = 'overview' | 'cpu' | 'gpu' | 'mem' | 'disk' | 'net';

interface WorkspaceUi {
  /** 右侧面板显示的内容 */
  rightMode: RightMode;
  /** 右侧面板是否展开 */
  rightOpen: boolean;
  /** 每次打开 AI 面板时加一，AI 面板据此把焦点放到输入框 */
  aiFocusSeq: number;
  /** 右侧「监控」面板当前的分类 */
  monitorTab: MonitorTab;
  setMonitorTab(tab: MonitorTab): void;
  /** 底部监控条：打开右侧的监控面板并切到对应分类 */
  openMonitor(tab?: MonitorTab): void;
  setRightMode(mode: RightMode): void;
  openRight(mode?: RightMode): void;
  closeRight(): void;
  /** 终端底部的 AI 按钮：AI 面板没打开时打开并聚焦输入框，已经打开时收起 */
  toggleAi(): void;
  /** 打开 AI 面板并聚焦输入框 */
  focusAi(): void;
  /** 打开「连接主机」对话框（侧栏收起时左上角的新增按钮）；每次加一 */
  connectSeq: number;
  requestConnect(): void;
}

export const useWorkspaceUi = create<WorkspaceUi>((set) => ({
  rightMode: 'files',
  rightOpen: true,
  aiFocusSeq: 0,
  connectSeq: 0,
  requestConnect() {
    set((s) => ({ connectSeq: s.connectSeq + 1 }));
  },
  monitorTab: 'overview',
  setMonitorTab(tab) {
    set({ monitorTab: tab });
  },
  openMonitor(tab) {
    set((s) => ({ rightOpen: true, rightMode: 'monitor', monitorTab: tab ?? s.monitorTab }));
  },
  setRightMode(mode) {
    set({ rightMode: mode });
  },
  openRight(mode) {
    set((s) => ({ rightOpen: true, rightMode: mode ?? s.rightMode }));
  },
  closeRight() {
    set({ rightOpen: false });
  },
  toggleAi() {
    set((s) => (s.rightOpen && s.rightMode === 'ai' ? { rightOpen: false } : { rightOpen: true, rightMode: 'ai', aiFocusSeq: s.aiFocusSeq + 1 }));
  },
  focusAi() {
    set((s) => ({ rightOpen: true, rightMode: 'ai', aiFocusSeq: s.aiFocusSeq + 1 }));
  },
}));
