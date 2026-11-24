import { useEffect, useRef } from 'react';
import { App } from 'antd';
import { errorMessage, invoke } from '../../api';
import { useEdits } from '../../store/edits';

const nameOf = (p: string): string => p.split('/').pop() ?? p;

/**
 * 外部编辑的状态提示：回传成功时提示；远端在编辑期间被改过时让用户选择覆盖远端还是放弃本机修改。
 */
export function EditWatcher(): null {
  const { message, modal } = App.useApp();
  const edits = useEdits((s) => s.edits);
  const last = useRef<Record<string, string>>({});

  useEffect(() => {
    for (const e of Object.values(edits)) {
      const prev = last.current[e.editId];
      last.current[e.editId] = `${e.state}:${e.savedAt ?? ''}`;
      if (prev === last.current[e.editId]) continue;
      if (e.state === 'uploaded') message.success({ key: e.editId, content: `已保存到远端：${nameOf(e.path)}` });
      if (e.state === 'error') message.error({ key: e.editId, content: `${nameOf(e.path)}：${e.message}` });
      if (e.state === 'conflict') {
        modal.confirm({
          title: `「${nameOf(e.path)}」在远端被修改过`,
          content: '你用默认程序编辑期间，这个文件在服务器上被其他人或程序改过。要用你的内容覆盖远端，还是放弃你的修改、重新载入远端的内容？',
          okText: '覆盖远端',
          okButtonProps: { danger: true },
          cancelText: '放弃我的修改',
          onOk: () => invoke('sftp.editResolve', { editId: e.editId, action: 'overwrite' }).catch((err) => message.error(errorMessage(err))),
          onCancel: () => invoke('sftp.editResolve', { editId: e.editId, action: 'discard' }).catch((err) => message.error(errorMessage(err))),
        });
      }
    }
    for (const id of Object.keys(last.current)) if (!edits[id]) delete last.current[id];
  }, [edits]);

  return null;
}
