import { useMemo, useState } from 'react';
import { Button, Input, Popover, Tooltip, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, CloudServerOutlined, CodeOutlined, DownOutlined, SearchOutlined } from '@ant-design/icons';
import type { AgentTerminalRef } from '@itm/protocol';
import { currentTerminal } from '../../store/library';

/** 引用的终端 / 主机超过这么多个时，引用行里合成一个「N 台主机」标签 */
export const HOST_CHIP_MAX = 3;

/**
 * 引用的主机多了以后（第三十三轮）：引用行里只显示一个「N 台主机」标签，点开是可以多选的列表——
 * 勾选几台一起移除、只保留当前终端、全部移除，也可以点每一行的 × 单独移除；标签上的 × 移除全部主机。
 */
export function HostRefsChip({ terminals, onRemove }: { terminals: AgentTerminalRef[]; onRemove(refs: AgentTerminalRef[]): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [anchor, setAnchor] = useState<string | null>(null);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? terminals.filter((t) => t.title.toLowerCase().includes(k)) : terminals;
  }, [terminals, q]);
  const live = picked.filter((id) => terminals.some((t) => t.tabId === id));
  const cur = currentTerminal();
  const keepCurrent = cur && terminals.some((t) => t.tabId === cur.id) ? cur : null;
  const allShown = shown.length > 0 && shown.every((t) => live.includes(t.tabId));

  const remove = (refs: AgentTerminalRef[]): void => {
    if (!refs.length) return;
    onRemove(refs);
    setPicked((p) => p.filter((id) => !refs.some((r) => r.tabId === id)));
    if (refs.length >= terminals.length) setOpen(false);
  };
  /** 点击勾选；按住 Shift 点击把上一次点的到这一行之间都设成同样的状态 */
  const toggle = (t: AgentTerminalRef, shift: boolean): void => {
    const on = !live.includes(t.tabId);
    let ids = [t.tabId];
    if (shift && anchor) {
      const a = shown.findIndex((x) => x.tabId === anchor);
      const b = shown.findIndex((x) => x.tabId === t.tabId);
      if (a >= 0 && b >= 0) ids = shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.tabId);
    }
    setPicked(on ? [...new Set([...live, ...ids])] : live.filter((id) => !ids.includes(id)));
    setAnchor(t.tabId);
  };

  const content = (
    <div className="host-refs" data-testid="host-refs-panel">
      <div className="host-refs-head">
        <span>已引用 {terminals.length} 台主机 / 终端</span>
        {live.length > 0 && <span className="host-refs-picked">已选 {live.length}</span>}
      </div>
      {terminals.length > 6 && <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索" value={q} onChange={(e) => setQ(e.target.value)} className="host-refs-search" data-testid="host-refs-search" />}
      <div className="host-refs-rows">
        {shown.map((t) => {
          const on = live.includes(t.tabId);
          return (
            <div
              key={t.tabId}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              className={`refs-row ${on ? 'on' : ''}`}
              onClick={(e) => toggle(t, e.shiftKey)}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), toggle(t, e.shiftKey))}
              data-testid="host-refs-row"
            >
              <span className="refs-check">{on && <CheckOutlined />}</span>
              {t.kind === 'local' ? <CodeOutlined /> : <CloudServerOutlined />}
              <div className="refs-row-main">
                <div className="refs-row-title">{t.title}</div>
                <div className="refs-row-sub">{t.sessionId ? (t.tabId === cur?.id ? '当前终端' : '已连接的终端') : '未打开终端（执行命令时连接）'}</div>
              </div>
              <Tooltip title="移除">
                <Button size="small" type="text" icon={<CloseOutlined />} onClick={(e) => (e.stopPropagation(), remove([t]))} aria-label="移除" data-testid="host-refs-x" />
              </Tooltip>
            </div>
          );
        })}
        {shown.length === 0 && <Typography.Text type="secondary">没有匹配的主机</Typography.Text>}
      </div>
      <div className="host-refs-foot">
        <Button size="small" type="text" onClick={() => setPicked(allShown ? live.filter((id) => !shown.some((t) => t.tabId === id)) : [...new Set([...live, ...shown.map((t) => t.tabId)])])} data-testid="host-refs-all">
          {allShown ? '取消全选' : q.trim() ? '全选搜索结果' : '全选'}
        </Button>
        <Button size="small" type="text" disabled={!live.length || live.length === terminals.length} onClick={() => setPicked(terminals.filter((t) => !live.includes(t.tabId)).map((t) => t.tabId))}>
          反选
        </Button>
        <span className="host-refs-gap" />
        {keepCurrent && (
          <Tooltip title={`只保留「${keepCurrent.title}」`}>
            <Button size="small" onClick={() => remove(terminals.filter((t) => t.tabId !== keepCurrent.id))} disabled={terminals.length <= 1} data-testid="host-refs-keep">
              只留当前
            </Button>
          </Tooltip>
        )}
        <Button size="small" danger type="primary" ghost={!live.length} disabled={!live.length} onClick={() => remove(terminals.filter((t) => live.includes(t.tabId)))} data-testid="host-refs-remove">
          移除选中{live.length ? `（${live.length}）` : ''}
        </Button>
        <Button size="small" danger onClick={() => remove(terminals)} data-testid="host-refs-clear">
          全部移除
        </Button>
      </div>
    </div>
  );

  return (
    <Popover open={open} onOpenChange={setOpen} trigger="click" placement="topLeft" arrow={false} overlayClassName="refs-popover" content={content} destroyOnHidden>
      <span className={`ref-chip hosts ${open ? 'on' : ''}`} role="button" tabIndex={0} title="点击管理引用的主机：多选移除、只保留当前终端" data-testid="ref-chip-hosts">
        <CloudServerOutlined />
        <span className="ref-chip-text">{terminals.length} 台主机</span>
        <DownOutlined className="ref-caret" />
        <Tooltip title="移除全部主机">
          <CloseOutlined
            className="ref-x"
            onClick={(e) => {
              e.stopPropagation();
              remove(terminals);
            }}
            data-testid="ref-chip-hosts-x"
          />
        </Tooltip>
      </span>
    </Popover>
  );
}
