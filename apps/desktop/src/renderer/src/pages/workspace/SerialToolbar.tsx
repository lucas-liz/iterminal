import { App, Button, Checkbox, Dropdown, Input, Progress, Switch, Tooltip } from 'antd';
import { CloseOutlined, UploadOutlined } from '@ant-design/icons';
import type { SerialSessionState } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';

/**
 * 串口终端上方的工具条（文档一 6.2）：十六进制显示、时间戳、DTR / RTS、发送十六进制字节、XMODEM / YMODEM 发送文件。
 */
export function SerialToolbar({ sessionId, state }: { sessionId: string | null; state: SerialSessionState | null }): React.JSX.Element {
  const { message } = App.useApp();
  const disabled = !sessionId || !state;
  const set = (patch: Partial<Pick<SerialSessionState, 'hex' | 'timestamp' | 'dtr' | 'rts'>>): void => {
    if (!sessionId) return;
    invoke('session.serialSet', { sessionId, ...patch }).catch((e) => message.error(errorMessage(e)));
  };
  const sendFile = async (protocol: 'xmodem' | 'ymodem'): Promise<void> => {
    if (!sessionId) return;
    const path = await invoke('dialog.openFile', { title: `选择要用 ${protocol.toUpperCase()} 发送的文件` });
    if (!path) return;
    try {
      await invoke('session.serialSendFile', { sessionId, path, protocol });
      message.success('文件发送完成');
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  const t = state?.transferring;

  return (
    <div className="serial-bar" data-testid="serial-bar">
      <Checkbox checked={!!state?.hex} disabled={disabled} onChange={(e) => set({ hex: e.target.checked })} data-testid="serial-hex">
        HEX 显示
      </Checkbox>
      <Checkbox checked={!!state?.timestamp} disabled={disabled} onChange={(e) => set({ timestamp: e.target.checked })} data-testid="serial-timestamp">
        时间戳
      </Checkbox>
      <span className="serial-sep" />
      <Tooltip title="数据终端就绪（很多开发板用它复位）">
        <span className="serial-line">
          DTR <Switch size="small" checked={!!state?.dtr} disabled={disabled} onChange={(v) => set({ dtr: v })} data-testid="serial-dtr" />
        </span>
      </Tooltip>
      <Tooltip title="请求发送">
        <span className="serial-line">
          RTS <Switch size="small" checked={!!state?.rts} disabled={disabled} onChange={(v) => set({ rts: v })} data-testid="serial-rts" />
        </span>
      </Tooltip>
      <span className="serial-sep" />
      <Input.Search
        size="small"
        className="serial-hex-input mono"
        placeholder="发送十六进制，例如 AA 55 01"
        enterButton="发送"
        disabled={disabled}
        onSearch={(v, _e, info) => {
          if (info?.source === 'clear' || !sessionId || !v.trim()) return;
          invoke('session.serialSendHex', { sessionId, hex: v }).catch((e) => message.error(errorMessage(e)));
        }}
        data-testid="serial-hex-input"
      />
      {t ? (
        <span className="serial-transfer" data-testid="serial-transfer">
          <span className="ellipsis" style={{ maxWidth: 140 }}>{`${t.protocol.toUpperCase()} ${t.name}`}</span>
          <Progress percent={t.total ? Math.floor((t.sent / t.total) * 100) : 0} size="small" style={{ width: 100, margin: 0 }} />
          <Tooltip title="取消发送">
            <Button size="small" type="text" danger icon={<CloseOutlined />} onClick={() => sessionId && void invoke('session.serialCancel', { sessionId })} />
          </Tooltip>
        </span>
      ) : (
        <Dropdown
          disabled={disabled}
          menu={{
            items: [
              { key: 'xmodem', label: 'XMODEM 发送…' },
              { key: 'ymodem', label: 'YMODEM 发送…' },
            ],
            onClick: ({ key }) => void sendFile(key as 'xmodem' | 'ymodem'),
          }}
        >
          <Button size="small" icon={<UploadOutlined />} disabled={disabled}>
            发送文件
          </Button>
        </Dropdown>
      )}
    </div>
  );
}
