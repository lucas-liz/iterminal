import { useEffect, useRef } from 'react';
import { CheckOutlined } from '@ant-design/icons';

/** 弹窗里的一项：主机、分组、终端、Skill、笔记、MCP，或者 / 命令 */
export interface PopupItem {
  key: string;
  group: string;
  label: string;
  sub?: string;
  icon: React.ReactNode;
  /** 已经引用 */
  selected?: boolean;
  run(): void;
}

/**
 * 输入框里打 @ 或 / 弹出的选择列表（文档一 6.15.8）：分类显示、搜索过滤、↑↓ 选择、回车 / Tab 确认、Esc 关闭。
 * 键盘事件由输入框转交（输入框保持焦点）。
 */
export function MentionPopup({
  title,
  items,
  active,
  onHover,
  onPick,
  categories,
  category,
  onCategory,
  empty,
}: {
  /** 没有结果时的提示（例如知识库要登录） */
  empty?: string;
  title: string;
  items: PopupItem[];
  active: number;
  onHover(i: number): void;
  onPick(item: PopupItem): void;
  categories?: string[];
  category?: string;
  onCategory?(c: string): void;
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const catsRef = useRef<HTMLDivElement>(null);
  // 窄面板里分类放不下时左右滚动：切换分类（Tab）后把当前分类滚到可见处
  useEffect(() => {
    catsRef.current?.querySelector<HTMLElement>('.mention-cat.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [category]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  let lastGroup = '';
  return (
    <div className="mention-popup" data-testid="mention-popup" onMouseDown={(e) => e.preventDefault()}>
      <div className="mention-head">
        <span className="mention-title">{title}</span>
        {categories && (
          <div className="mention-cats" ref={catsRef}>
            {categories.map((c) => (
              <span key={c} className={`mention-cat ${c === category ? 'active' : ''}`} onClick={() => onCategory?.(c)} data-testid={`mention-cat-${c}`} data-active={c === category ? '1' : '0'}>
                {c}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="mention-list" ref={listRef}>
        {items.length === 0 && <div className="mention-empty">{empty ?? '没有匹配的项目'}</div>}
        {items.map((it, i) => {
          const header = it.group !== lastGroup ? it.group : null;
          lastGroup = it.group;
          return (
            <div key={it.key}>
              {header && <div className="mention-group">{header}</div>}
              <div
                className={`mention-item ${i === active ? 'active' : ''}`}
                data-index={i}
                data-testid="mention-item"
                onMouseEnter={() => onHover(i)}
                onClick={() => onPick(it)}
              >
                <span className="mention-icon">{it.icon}</span>
                <span className="mention-label">{it.label}</span>
                {it.sub && <span className="mention-sub">{it.sub}</span>}
                {it.selected && <CheckOutlined className="mention-check" />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mention-foot">↑↓ 选择 · 回车确认 · {categories ? 'Tab 切换分类 · ' : ''}Esc 关闭</div>
    </div>
  );
}
