import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Input, Modal, Space, Spin, Typography } from 'antd';
import { ExportOutlined, SaveOutlined } from '@ant-design/icons';
import { errorMessage, invoke, isMac } from '../../api';
import { useEdits } from '../../store/edits';
import { formatSize } from '../../util/format';
import { matchShortcut } from '../../util/shortcuts';

/**
 * 内置编辑器（文档一 6.3）：直接编辑远端文本文件（最多 2MB）。保存前比较远端的修改时间，别人改过时让用户决定是否覆盖。
 */
export function RemoteEditor(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const target = useEdits((s) => s.editor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [size, setSize] = useState(0);
  const [saving, setSaving] = useState(false);
  const mtime = useRef<number | null>(null);
  const dirty = content !== original;

  useEffect(() => {
    if (!target) return;
    setLoading(true);
    setError(null);
    invoke('sftp.readText', target)
      .then((r) => {
        setContent(r.content);
        setOriginal(r.content);
        setSize(r.size);
        mtime.current = r.mtime;
      })
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [target?.sftpId, target?.path]);

  const save = async (force = false): Promise<void> => {
    if (!target) return;
    setSaving(true);
    try {
      const r = await invoke('sftp.writeText', { ...target, content, expectMtime: force ? null : mtime.current });
      if (!r.ok) {
        modal.confirm({
          title: '远端文件已被修改',
          content: '你打开之后，这个文件在服务器上被其他人或程序修改过。仍然用你的内容覆盖吗？',
          okText: '仍然覆盖',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => save(true),
        });
        return;
      }
      mtime.current = r.mtime;
      setOriginal(content);
      message.success('已保存到远端');
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const close = (): void => {
    if (!dirty) return useEdits.getState().closeEditor();
    modal.confirm({
      title: '放弃没有保存的修改？',
      okText: '放弃',
      okButtonProps: { danger: true },
      cancelText: '继续编辑',
      onOk: () => useEdits.getState().closeEditor(),
    });
  };

  return (
    <Modal
      open={!!target}
      title={
        <Space>
          <span>编辑远端文件</span>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
            {target?.path}
          </Typography.Text>
          {dirty && <Typography.Text type="warning">（未保存）</Typography.Text>}
        </Space>
      }
      width="min(1100px, 90vw)"
      onCancel={close}
      maskClosable={false}
      destroyOnHidden
      footer={
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`${formatSize(size)} · UTF-8 · ${isMac ? '⌘' : 'Ctrl'}+S 保存`}
          </Typography.Text>
          <Space style={{ marginLeft: 'auto' }}>
            <Button
              icon={<ExportOutlined />}
              disabled={!target}
              onClick={() => {
                if (!target) return;
                useEdits
                  .getState()
                  .editExternal(target.sftpId, target.path)
                  .then(() => useEdits.getState().closeEditor())
                  .catch((e) => message.error(errorMessage(e)));
              }}
            >
              用默认程序编辑
            </Button>
            <Button onClick={close} data-testid="editor-close">
              关闭
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} disabled={!dirty || !!error} onClick={() => void save()} data-testid="editor-save">
              保存
            </Button>
          </Space>
        </div>
      }
    >
      {loading ? (
        <div className="empty-workspace" style={{ height: 300 }}>
          <Spin />
        </div>
      ) : error ? (
        <Alert type="error" showIcon message={error} />
      ) : (
        <Input.TextArea
          className="remote-editor mono"
          value={content}
          spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if (matchShortcut(e, 'editorSave')) {
              e.preventDefault();
              if (dirty) void save();
            }
          }}
          data-testid="remote-editor"
        />
      )}
    </Modal>
  );
}
