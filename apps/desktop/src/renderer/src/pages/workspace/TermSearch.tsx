import { useEffect, useRef, useState } from 'react';
import { Button, Input, Tooltip, type InputRef } from 'antd';
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined } from '@ant-design/icons';
import type { Terminal } from '@xterm/xterm';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { useApp } from '../../store/app';

/**
 * 终端搜索（⌘F / Ctrl+Shift+F）：在回滚缓冲里查找，所有命中和当前命中用不同颜色标出，滚动条旁边的标尺显示命中位置；
 * 支持区分大小写、正则、整词。颜色可以在 设置 → 终端 → 搜索与智能 里修改。
 */
export function TermSearch({ term, search, onClose }: { term: Terminal; search: SearchAddon; onClose(): void }): React.JSX.Element {
  const colors = useApp((s) => s.settings['terminal.search']);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState({ caseSensitive: false, regex: false, wholeWord: false });
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<InputRef>(null);

  const options = (incremental = false): ISearchOptions => ({
    ...opts,
    incremental,
    decorations: {
      matchBackground: colors.matchBg,
      matchBorder: colors.matchBorder,
      matchOverviewRuler: colors.matchRuler,
      activeMatchBackground: colors.activeBg,
      activeMatchBorder: colors.activeBorder,
      activeMatchColorOverviewRuler: colors.activeRuler,
    },
  });

  useEffect(() => {
    inputRef.current?.focus();
    // 搜索时显示滚动条旁边的命中标尺
    term.options.overviewRuler = { width: 8 };
    const sub = search.onDidChangeResults((r) => setResult(r.resultCount ? { index: r.resultIndex, count: r.resultCount } : { index: -1, count: 0 }));
    return () => {
      sub.dispose();
      search.clearDecorations();
      term.options.overviewRuler = {};
    };
  }, [term, search]);

  useEffect(() => {
    if (!q) {
      search.clearDecorations();
      setResult(null);
      return;
    }
    try {
      search.findNext(q, options(true));
    } catch {
      setResult({ index: -1, count: 0 });
    }
  }, [q, opts, colors]);

  const next = (): boolean => !!q && search.findNext(q, options());
  const prev = (): boolean => !!q && search.findPrevious(q, options());
  const toggle = (k: keyof typeof opts, label: string, title: string): React.JSX.Element => (
    <Tooltip title={title}>
      <button type="button" className={`term-search-opt ${opts[k] ? 'on' : ''}`} onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))} aria-pressed={opts[k]} data-testid={`term-search-${k}`}>
        {label}
      </button>
    </Tooltip>
  );

  return (
    <div className="term-search" data-testid="term-search">
      <Input
        ref={inputRef}
        size="small"
        placeholder="搜索终端输出"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void (e.shiftKey ? prev() : next());
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        suffix={
          <span className="term-search-count" data-testid="term-search-count">
            {result ? (result.count ? `${result.index + 1}/${result.count}` : '无结果') : ''}
          </span>
        }
        data-testid="term-search-input"
      />
      {toggle('caseSensitive', 'Aa', '区分大小写')}
      {toggle('regex', '.*', '正则表达式')}
      {toggle('wholeWord', 'ab', '整词匹配')}
      <Tooltip title="上一个（Shift+Enter）">
        <Button size="small" type="text" icon={<ArrowUpOutlined />} onClick={() => void prev()} aria-label="上一个" />
      </Tooltip>
      <Tooltip title="下一个（Enter）">
        <Button size="small" type="text" icon={<ArrowDownOutlined />} onClick={() => void next()} aria-label="下一个" data-testid="term-search-next" />
      </Tooltip>
      <Tooltip title="关闭（Esc）">
        <Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="关闭搜索" />
      </Tooltip>
    </div>
  );
}
