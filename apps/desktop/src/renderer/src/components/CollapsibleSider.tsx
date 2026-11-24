/**
 * 可平滑收起 / 展开的次级侧边栏容器：
 * 外层做 width + opacity + margin 过渡，内层保持固定宽度并配合轻微位移，
 * 收起 / 展开全程不触发内部文字换行抖动，且保留滚动位置。
 */
export function CollapsibleSider({
  collapsed,
  width,
  gapOffset = 0,
  className = '',
  children,
}: {
  collapsed: boolean;
  width: number;
  /** 父容器存在水平 gap（如 hosts-body 的 10px）时，收起态用负边距平滑抵消 */
  gapOffset?: number;
  className?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={`collapsible-sider ${collapsed ? 'is-collapsed' : ''} ${className}`}
      style={{
        ['--cs-w' as string]: `${width}px`,
        ['--cs-gap' as string]: `${gapOffset}px`,
      }}
      aria-hidden={collapsed || undefined}
    >
      <div className="collapsible-sider-inner">{children}</div>
    </div>
  );
}
