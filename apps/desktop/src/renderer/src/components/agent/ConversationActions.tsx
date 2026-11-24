import { useState } from 'react';
import { App, Button, Checkbox, Input, Modal, Tooltip, Typography } from 'antd';
import { BookOutlined, ExportOutlined } from '@ant-design/icons';
import type { ModelRef } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useLibrary } from '../../store/library';

/** 文件名里不能用的字符 */
const safeName = (s: string): string => s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || 'AI 对话';

/**
 * 整个对话的操作（对话标题栏右侧）：存为笔记（默认用 AI 汇总成排查过程 / 处理方法 / 注意事项）、导出为 Markdown。
 */
export function ConversationActions({ id, title, model, empty }: { id: string; title: string; model: ModelRef | null; empty: boolean }): React.JSX.Element {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [useAi, setUseAi] = useState(true);
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const body = useAi ? await invoke('agent.summarizeNote', { id, model }) : await invoke('agent.markdown', { id });
      const note = await useLibrary.getState().saveAsNote(name.trim() || title, body);
      setOpen(false);
      message.success({
        key: 'conv-note',
        content: (
          <span>
            已存为笔记{useAi ? '（AI 汇总）' : ''}
            <Button type="link" size="small" onClick={() => useLibrary.getState().openNote(note.id)}>
              查看
            </Button>
          </span>
        ),
      });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportMd = async (): Promise<void> => {
    const path = await invoke('dialog.saveFile', { title: '导出对话', defaultName: `${safeName(title)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (!path) return;
    try {
      await invoke('agent.export', { id, path });
      message.success(`已导出到 ${path}`);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  return (
    <>
      <Tooltip title="整个对话存为笔记">
        <Button
          size="small"
          type="text"
          icon={<BookOutlined />}
          disabled={empty}
          onClick={() => {
            setName(title);
            setOpen(true);
          }}
          data-testid="conv-save-note"
          aria-label="整个对话存为笔记"
        />
      </Tooltip>
      <Tooltip title="导出整个对话（Markdown）">
        <Button size="small" type="text" icon={<ExportOutlined />} disabled={empty} onClick={() => void exportMd()} data-testid="conv-export" aria-label="导出整个对话" />
      </Tooltip>
      <Modal
        open={open}
        title="对话存为笔记"
        okText={busy && useAi ? 'AI 汇总中…' : '保存'}
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void save()}
        onCancel={() => !busy && setOpen(false)}
        destroyOnHidden
        width={460}
      >
        <div className="conv-note-form">
          <Typography.Text type="secondary">笔记标题</Typography.Text>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-testid="conv-note-title" />
          <Checkbox checked={useAi} onChange={(e) => setUseAi(e.target.checked)} data-testid="conv-note-ai">
            使用 AI 进行汇总
          </Checkbox>
          <Typography.Text type="secondary" className="conv-note-hint">
            {useAi
              ? '用快速模型把问题、排查过程、处理方法（命令）和注意事项整理成一篇笔记；发送前会脱敏密码、密钥等信息。'
              : '保存完整对话：问题、回答、每一步执行的命令和输出（过长的输出会截断）。'}
          </Typography.Text>
        </div>
      </Modal>
    </>
  );
}
