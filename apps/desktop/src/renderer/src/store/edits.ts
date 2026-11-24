import { create } from 'zustand';
import type { RemoteEditState } from '@itm/protocol';
import { invoke } from '../api';

interface EditsState {
  /** 用系统默认程序编辑中的远端文件 */
  edits: Record<string, RemoteEditState>;
  /** 内置编辑器打开的文件 */
  editor: { sftpId: string; path: string } | null;
  openEditor(sftpId: string, path: string): void;
  closeEditor(): void;
  /** 下载到临时目录并用系统默认程序打开，保存后自动回传 */
  editExternal(sftpId: string, path: string): Promise<RemoteEditState>;
}

export const useEdits = create<EditsState>((set) => ({
  edits: {},
  editor: null,
  openEditor(sftpId, path) {
    set({ editor: { sftpId, path } });
  },
  closeEditor() {
    set({ editor: null });
  },
  async editExternal(sftpId, path) {
    const st = await invoke('sftp.editExternal', { sftpId, path });
    set((s) => ({ edits: { ...s.edits, [st.editId]: st } }));
    return st;
  },
}));

window.itm.on('sftp.edit', (st) =>
  useEdits.setState((s) => {
    const edits = { ...s.edits };
    if (st.state === 'stopped') delete edits[st.editId];
    else edits[st.editId] = st;
    return { edits };
  }),
);
