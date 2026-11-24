import { useLayoutEffect, useRef } from 'react';

/**
 * 分屏时终端窗格的 DOM 容器。每个终端（TerminalView）通过 Portal 渲染进一个固定的容器，
 * 布局变化（分屏、关闭窗格）时只是把容器移到新的位置，终端组件本身不会重新挂载，会话不会断开。
 */
const elements = new Map<string, HTMLDivElement>();
let poolEl: HTMLDivElement | null = null;

/** 暂时没有放进布局的容器放在这里（隐藏） */
function pool(): HTMLDivElement {
  if (!poolEl) {
    poolEl = document.createElement('div');
    poolEl.className = 'pane-pool';
    document.body.appendChild(poolEl);
  }
  return poolEl;
}

export function paneElement(id: string): HTMLDivElement {
  let el = elements.get(id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'pane-el';
    pool().appendChild(el);
    elements.set(id, el);
  }
  return el;
}

/** 终端关闭后释放容器 */
export function releasePane(id: string): void {
  elements.get(id)?.remove();
  elements.delete(id);
}

/** 布局里的一个位置：挂载时把窗格的容器放进来，卸载时放回隐藏的池子 */
export function PaneSlot({ id }: { id: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const slot = ref.current!;
    const el = paneElement(id);
    slot.appendChild(el);
    return () => {
      if (el.parentNode === slot) pool().appendChild(el);
    };
  }, [id]);
  return <div ref={ref} className="pane-slot" />;
}
