import { useEffect, useRef } from 'react';
import { ClockCircleOutlined, CodeOutlined, ThunderboltOutlined } from '@ant-design/icons';

export interface SuggestItem {
  command: string;
  description?: string;
  source: 'history' | 'library' | 'snippet';
}

export interface SuggestState {
  items: SuggestItem[];
  /** 一页显示几条，超出的滚动查看 */
  rows: number;
  active: number;
  left: number;
  top?: number;
  bottom?: number;
  prefix: string;
  /** 显示时光标所在的行：换行后提示框自动关闭 */
  cursorY: number;
}

const ICON = { history: <ClockCircleOutlined />, library: <CodeOutlined />, snippet: <ThunderboltOutlined /> };
const TIP = { history: '历史命令', library: '常用命令', snippet: '快捷命令' };

/**
 * 终端命令提示（参考 iShell）：内置命令库（带中文说明）、快捷命令在前，这台主机的历史命令在后。
 * ↑↓ 选择（超出一页时自动滚动），回车补全（不执行），Esc 关闭；Tab 留给 shell 自己的补全。
 */
export function TermSuggest({ state, onPick, onHover }: { state: SuggestState; onPick(item: SuggestItem): void; onHover(i: number): void }): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.children[state.active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [state.active, state.items]);
  return (
    <div className="term-suggest" style={{ left: state.left, top: state.top, bottom: state.bottom }} data-testid="term-suggest" onMouseDown={(e) => e.preventDefault()}>
      <div className="term-suggest-list" role="listbox" ref={listRef} style={{ '--sug-rows': Math.max(1, state.rows) } as React.CSSProperties}>
        {state.items.map((it, i) => (
          <div
            key={`${it.source}:${it.command}`}
            role="option"
            aria-selected={i === state.active}
            className={`term-suggest-row ${i === state.active ? 'on' : ''}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(it)}
            title={TIP[it.source]}
            data-testid="term-suggest-row"
            data-source={it.source}
          >
            <span className={`term-suggest-icon ${it.source}`}>{ICON[it.source]}</span>
            <span className="term-suggest-cmd mono">
              <b>{it.command.slice(0, state.prefix.length)}</b>
              {it.command.slice(state.prefix.length)}
            </span>
            {it.description && <span className="term-suggest-desc">— {it.description}</span>}
          </div>
        ))}
      </div>
      <div className="term-suggest-foot">↑↓ 选择 · 回车 补全 · Esc 关闭{state.items.length > state.rows ? ` · 共 ${state.items.length} 条` : ''}</div>
    </div>
  );
}
