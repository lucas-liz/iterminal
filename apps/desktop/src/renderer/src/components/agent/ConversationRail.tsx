import { useEffect, useMemo, useState } from 'react';
import type { AgentViewMessage } from '@itm/protocol';
import { railEntries } from '../../util/agent-view';

/** Markdown 简单去掉标记，悬停卡片里只显示纯文字 */
const plain = (s: string): string =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`_|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 对话左侧的定位条（第二十六轮，参考 NewMax）：每个提问一条小横线，当前看到的那条更长更深；
 * 悬停显示问题和回答摘要，点击滚动过去。少于两个提问时不显示。
 */
export function ConversationRail({ messages, listRef }: { messages: AgentViewMessage[]; listRef: React.RefObject<HTMLDivElement | null> }): React.JSX.Element | null {
  const entries = useMemo(() => railEntries(messages), [messages]);
  const [active, setActive] = useState(-1);
  const [hover, setHover] = useState<{ i: number; top: number } | null>(null);

  // 当前看到的提问：最后一个顶部已经进入可视区上半部分的提问
  useEffect(() => {
    const list = listRef.current;
    if (!list || entries.length < 2) return;
    const update = (): void => {
      const mark = list.scrollTop + list.clientHeight * 0.4;
      let idx = 0;
      entries.forEach((e, i) => {
        const el = list.querySelector<HTMLElement>(`[data-msg-id="${e.id}"]`);
        if (el && el.offsetTop <= mark) idx = i;
      });
      // 滚到底时算最后一个
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 4) idx = entries.length - 1;
      setActive(idx);
    };
    update();
    list.addEventListener('scroll', update, { passive: true });
    return () => list.removeEventListener('scroll', update);
  }, [entries, listRef]);

  if (entries.length < 2) return null;
  const go = (i: number): void => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-msg-id="${entries[i].id}"]`);
    if (!list || !el) return;
    list.scrollTo({ top: Math.max(0, el.offsetTop - 16), behavior: 'smooth' });
    setActive(i);
  };
  const h = hover ? entries[hover.i] : null;
  return (
    <div className="conv-rail" data-testid="conv-rail" onMouseLeave={() => setHover(null)}>
      {entries.map((e, i) => (
        <button
          key={e.id}
          type="button"
          className={`conv-rail-tick ${i === active ? 'active' : ''} ${hover?.i === i ? 'hover' : ''}`}
          aria-label={`跳到第 ${i + 1} 个提问`}
          onMouseEnter={(ev) => setHover({ i, top: (ev.currentTarget as HTMLElement).offsetTop })}
          onClick={() => go(i)}
          data-testid="conv-rail-tick"
        >
          <span />
        </button>
      ))}
      {h && hover && (
        <div className="conv-rail-card" style={{ top: hover.top }} data-testid="conv-rail-card">
          <div className="conv-rail-q">{h.question.split('\n')[0]}</div>
          {h.answer && <div className="conv-rail-a">{plain(h.answer)}</div>}
        </div>
      )}
    </div>
  );
}
