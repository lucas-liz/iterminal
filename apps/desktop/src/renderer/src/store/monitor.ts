import { useEffect } from 'react';
import { create } from 'zustand';
import type { MetricsSnapshot, MonitorAlert } from '@itm/protocol';
import { invoke } from '../api';

/** 趋势图保留的采样点数（2 秒一个，15 分钟） */
export const HISTORY_POINTS = 450;

export interface HistoryPoint {
  ts: number;
  cpu: number;
  user: number;
  sys: number;
  mem: number;
  rx: number;
  tx: number;
}

interface MonitorState {
  latest: Record<string, MetricsSnapshot>;
  history: Record<string, HistoryPoint[]>;
  /** 常驻主机正在发生的告警（主进程计算，第二十七轮） */
  alerts: MonitorAlert[];
  apply(s: MetricsSnapshot): void;
  loadAlerts(): Promise<void>;
}

export const useMonitor = create<MonitorState>((set) => ({
  latest: {},
  history: {},
  alerts: [],
  async loadAlerts() {
    set({ alerts: await invoke('monitor.alerts') });
  },
  apply(snap) {
    set((st) => {
      const latest = { ...st.latest, [snap.hostId]: snap };
      if (snap.state !== 'ok' || !snap.cpu) return { latest };
      const net = snap.net.reduce((acc, n) => ({ rx: acc.rx + n.rxBps, tx: acc.tx + n.txBps }), { rx: 0, tx: 0 });
      const point: HistoryPoint = {
        ts: snap.ts,
        cpu: snap.cpu.usage,
        user: snap.cpu.user,
        sys: snap.cpu.system,
        mem: snap.mem.total ? (snap.mem.used / snap.mem.total) * 100 : 0,
        ...net,
      };
      const prev = st.history[snap.hostId] ?? [];
      return { latest, history: { ...st.history, [snap.hostId]: [...prev, point].slice(-HISTORY_POINTS) } };
    });
  },
}));

window.itm.on('monitor.update', (snap) => useMonitor.getState().apply(snap));
window.itm.on('monitor.alerts', (alerts) => useMonitor.setState({ alerts }));

/** 组件挂载期间订阅主机监控（enabled 为 false 时不订阅，例如会话还没连上） */
export function useMonitorSubscription(hostId: string | undefined, enabled: boolean): void {
  useEffect(() => {
    if (!hostId || !enabled) return;
    void invoke('monitor.subscribe', { hostId });
    return () => {
      void invoke('monitor.unsubscribe', { hostId });
    };
  }, [hostId, enabled]);
}
