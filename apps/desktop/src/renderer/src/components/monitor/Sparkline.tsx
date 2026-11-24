/** 极简趋势线（SVG），不引入图表库 */
export function Sparkline({
  values,
  max,
  width = 80,
  height = 18,
  color = 'var(--itm-primary)',
  fill = true,
  fluid = false,
}: {
  values: number[];
  /** 纵轴上限；不传时取数据最大值 */
  max?: number;
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  /** 宽度撑满容器（按 viewBox 拉伸，线宽不变） */
  fluid?: boolean;
}): React.JSX.Element {
  const top = Math.max(max ?? Math.max(...values, 1), 1e-9);
  const n = values.length;
  const pts = values.map((v, i) => {
    const x = n <= 1 ? width : (i / (n - 1)) * width;
    const y = height - (Math.min(v, top) / top) * (height - 1) - 0.5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      width={fluid ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fluid ? 'none' : undefined}
      style={{ display: 'block' }}
    >
      {n > 1 && fill && <polygon points={`0,${height} ${pts.join(' ')} ${width},${height}`} fill={color} opacity={0.15} />}
      {n > 1 && <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

/** 细长进度条 */
export function Meter({ percent, color }: { percent: number; color?: string }): React.JSX.Element {
  const p = Math.max(0, Math.min(100, percent));
  const c = color ?? (p >= 90 ? '#ff4d4f' : p >= 75 ? '#faad14' : 'var(--itm-primary)');
  return (
    <div className="meter">
      <div className="meter-fill" style={{ width: `${p}%`, background: c }} />
    </div>
  );
}
