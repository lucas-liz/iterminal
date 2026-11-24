import { create } from 'zustand';
import type { RemoteApproval, ServerState, TaskRunView } from '@itm/protocol';
import { invoke } from '../api';

interface ServerStore {
  state: ServerState | null;
  /** 等我审批的命令（文档一 6.11 远程审批：审批人侧） */
  approvals: RemoteApproval[];
  /** 本设备执行的任务有变化时递增（审计页据此刷新） */
  runVersion: number;
  lastRun: TaskRunView | null;
  load(): Promise<void>;
  decide(approvalId: string, decision: 'APPROVED' | 'REJECTED', comment?: string): Promise<void>;
}

/** 服务端连接、远程审批和定时任务（只在账号模式下有内容），主进程用事件推送变化 */
export const useServer = create<ServerStore>((set) => ({
  state: null,
  approvals: [],
  runVersion: 0,
  lastRun: null,
  async load() {
    const [state, approvals] = await Promise.all([invoke('server.state'), invoke('approval.pending')]);
    set({ state, approvals });
  },
  async decide(approvalId, decision, comment) {
    await invoke('approval.decide', { approvalId, decision, comment });
    set((s) => ({ approvals: s.approvals.filter((a) => a.approvalId !== approvalId) }));
  },
}));

window.itm.on('server.state', (state) => useServer.setState({ state }));
window.itm.on('approval.pending', (approvals) => useServer.setState({ approvals }));
window.itm.on('task.run', (run) => useServer.setState((s) => ({ lastRun: run, runVersion: s.runVersion + 1 })));
