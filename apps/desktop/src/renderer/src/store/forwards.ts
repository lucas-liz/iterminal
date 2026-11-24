import { create } from 'zustand';
import type { PortForward, PortForwardStatus } from '@itm/protocol';
import { invoke } from '../api';

interface ForwardsState {
  forwards: PortForward[];
  status: Record<string, PortForwardStatus>;
  /** 打开端口转发管理框的主机 */
  editingHostId: string | null;
  reload(): Promise<void>;
  open(hostId: string): void;
  close(): void;
}

export const useForwards = create<ForwardsState>((set) => ({
  forwards: [],
  status: {},
  editingHostId: null,
  async reload() {
    const r = await invoke('portforward.list', { hostId: null });
    set({ forwards: r.forwards, status: Object.fromEntries(r.status.map((s) => [s.id, s])) });
  },
  open(hostId) {
    set({ editingHostId: hostId });
    void useForwards.getState().reload();
  },
  close() {
    set({ editingHostId: null });
  },
}));

window.itm.on('portforward.status', (s) => useForwards.setState((st) => ({ status: { ...st.status, [s.id]: s } })));

/** 某台主机正在运行的转发数 */
export function runningCount(state: Pick<ForwardsState, 'forwards' | 'status'>, hostId: string): number {
  return state.forwards.filter((f) => f.hostId === hostId && state.status[f.id]?.state === 'running').length;
}
