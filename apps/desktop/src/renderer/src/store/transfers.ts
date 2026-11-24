import { create } from 'zustand';
import type { TransferState } from '@itm/protocol';

/** 传输记录：主进程推来的状态 + 所属批次（同一个文件面板里连续发起、中间没有空闲的算一批，进度条上显示「第几个 / 共几个」） */
export interface TransferView extends TransferState {
  batch: number;
}

interface TransfersState {
  /** 按开始顺序 */
  items: TransferView[];
  upsert(t: TransferState): void;
  clearFinished(sftpId: string): void;
  /** 从历史记录里删掉一条（不删文件） */
  remove(transferId: string): void;
}

export const isActive = (t: TransferState): boolean => t.status === 'queued' || t.status === 'running' || t.status === 'paused';

let batchSeq = 0;

export const useTransfers = create<TransfersState>((set) => ({
  items: [],
  upsert(t) {
    set((s) => {
      const i = s.items.findIndex((x) => x.transferId === t.transferId);
      if (i < 0) {
        // 这个会话里没有进行中的传输：开始新的一批
        const busy = s.items.some((x) => x.sftpId === t.sftpId && isActive(x));
        const last = [...s.items].reverse().find((x) => x.sftpId === t.sftpId);
        const batch = busy && last ? last.batch : ++batchSeq;
        return { items: [...s.items, { ...t, batch }] };
      }
      const items = s.items.slice();
      items[i] = { ...t, batch: items[i].batch };
      return { items };
    });
  },
  clearFinished(sftpId) {
    set((s) => ({ items: s.items.filter((t) => t.sftpId !== sftpId || isActive(t)) }));
  },
  remove(transferId) {
    set((s) => ({ items: s.items.filter((t) => t.transferId !== transferId || isActive(t)) }));
  },
}));

window.itm.on('transfer.progress', (t) => useTransfers.getState().upsert(t));
