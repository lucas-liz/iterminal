import { useEffect, useRef } from 'react';
import { CheckOutlined, CloseOutlined, LoadingOutlined } from '@ant-design/icons';
import type { ConnLogEntry, ConnStep, ConnStepStatus } from '@itm/protocol';

/** 连接步骤的名称（Telnet 没有「打开通道」，第二步叫「协商」） */
export const SSH_STEPS: { key: ConnStep; label: string }[] = [
  { key: 'connect', label: '建立连接' },
  { key: 'auth', label: '身份验证' },
  { key: 'channel', label: '打开通道' },
  { key: 'ready', label: '连接就绪' },
];
export const TELNET_STEPS: { key: ConnStep; label: string }[] = [
  { key: 'connect', label: '建立连接' },
  { key: 'auth', label: '协商' },
  { key: 'ready', label: '就绪' },
];
const STEP_NAME: Record<ConnStep, string> = { connect: '建立连接', auth: '身份验证', channel: '打开通道', ready: '连接就绪' };

/** 步骤条：完成绿色对勾、进行中蓝色转圈、未开始灰色序号、失败红色叉（文档一 6.15.3） */
export function ConnStepper({ steps, items = SSH_STEPS }: { steps: Record<ConnStep, ConnStepStatus>; items?: { key: ConnStep; label: string }[] }): React.JSX.Element {
  return (
    <div className="conn-stepper" data-testid="conn-stepper">
      {items.map((it, i) => {
        const st = steps[it.key];
        return (
          <div key={it.key} className={`conn-step ${st}`} data-testid={`conn-step-${it.key}`} data-status={st}>
            {i > 0 && <span className={`conn-step-line ${steps[items[i - 1].key] === 'done' ? 'done' : ''}`} />}
            <span className="conn-step-dot">
              {st === 'done' ? <CheckOutlined /> : st === 'active' ? <LoadingOutlined /> : st === 'error' ? <CloseOutlined /> : i + 1}
            </span>
            <span className="conn-step-label">{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}

const time = (t: number): string => {
  const d = new Date(t);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

/** 连接日志：信息蓝、成功绿、警告 / 重试黄、错误红；每行带步骤前缀 */
export function ConnLogList({ entries, showTime, maxHeight = 220, autoScroll = true }: { entries: ConnLogEntry[]; showTime?: boolean; maxHeight?: number; autoScroll?: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length, autoScroll]);
  return (
    <div className="conn-log mono selectable" style={{ maxHeight }} ref={ref} data-testid="conn-log">
      {entries.length === 0 && <div className="conn-log-line info">等待连接…</div>}
      {entries.map((e, i) => (
        <div key={i} className={`conn-log-line ${e.level}`}>
          {showTime && <span className="conn-log-time">{time(e.t)}</span>}
          <span className="conn-log-step">[{STEP_NAME[e.step]}]</span>
          <span className="conn-log-text">
            {e.tag ? `[${e.tag}] ` : ''}
            {e.text}
          </span>
        </div>
      ))}
    </div>
  );
}
