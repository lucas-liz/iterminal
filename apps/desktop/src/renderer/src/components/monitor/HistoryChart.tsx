import { useEffect, useMemo, useRef, useState } from 'react';
import { useResolvedTheme } from '../../util/theme';

/**
 * 分类色（前三个槽位，按固定顺序分配，不循环；已用 dataviz 的校验脚本验证过深色 / 浅色两种底色）。
 * 超过三条线时多出来的不画（调用方负责合并或拆成小图）。
 */
export const SERIES_COLORS = {
  dark: ['#3987e5', '#d95926', '#199e70'],
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
} as const;

const CHROME = {
  dark: { grid: '#2c2c2a', axis: '#383835', muted: '#898781', ink: '#ffffff', secondary: '#c3c2b7', surface: '#1e1e20' },
  light: { grid: '#e1e0d9', axis: '#c3c2b7', muted: '#898781', ink: '#0b0b0b', secondary: '#52514e', surface: '#ffffff' },
} as const;

export interface ChartSeries {
  name: string;
  values: (number | null)[];
}

const fmtTime = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
};

/** 「好看」的纵轴上限：1、2、5 × 10ⁿ */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

export interface ChartOptions {
  height?: number;
  /** 纵轴上限；'auto' 按数据取整（速率等没有固定上限的指标） */
  max?: number | 'auto';
  /** 坐标轴和末端标注的数值格式（默认百分比取整） */
  format?: (v: number) => string;
  /** 提示框里的数值格式（默认百分比一位小数） */
  formatTip?: (v: number) => string;
  /** 横轴时间格式 */
  time?: (ts: number) => string;
  /** 横轴标注几个时间点 */
  ticks?: number;
  /** 在线的末端标注当前值（窄的面板里关掉，省出右边距） */
  endLabels?: boolean;
  /** 显示纵轴刻度文字 */
  yLabels?: boolean;
}

/**
 * 折线图（单一 Y 轴）：2px 线、细网格；悬停时竖线对准最近的时间点，提示框列出所有序列的值。
 * 两条以上时有图例；默认是 0–100 的百分比，并在线的末端直接标注数值。
 */
export function HistoryChart({ ts, series, testId, ...o }: { ts: number[]; series: ChartSeries[]; testId?: string } & ChartOptions): React.JSX.Element {
  const HEIGHT = o.height ?? 150;
  const fmt = o.format ?? ((v: number) => `${v.toFixed(0)}%`);
  const fmtTip = o.formatTip ?? ((v: number) => `${v.toFixed(1)}%`);
  const fmtT = o.time ?? fmtTime;
  const endLabels = o.endLabels ?? true;
  const yLabels = o.yLabels ?? true;
  const PAD = { top: 10, right: endLabels ? 52 : 10, bottom: 22, left: yLabels ? 36 : 8 };
  const mode = useResolvedTheme();
  const c = CHROME[mode];
  const colors = SERIES_COLORS[mode];
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [hover, setHover] = useState<number | null>(null);
  const shown = series.slice(0, 3);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const top =
    o.max === 'auto' ? niceMax(Math.max(0, ...shown.flatMap((s) => s.values.filter((v): v is number => v !== null))) * 1.1) : (o.max ?? 100);
  const t0 = ts[0] ?? 0;
  const t1 = ts.at(-1) ?? 1;
  const x = (t: number): number => PAD.left + (t1 > t0 ? ((t - t0) / (t1 - t0)) * innerW : innerW / 2);
  const y = (v: number): number => PAD.top + innerH - (Math.min(top, Math.max(0, v)) / top) * innerH;

  /** 有缺口（null）时断开线段 */
  const paths = useMemo(
    () =>
      shown.map((s) => {
        let d = '';
        let pen = false;
        s.values.forEach((v, i) => {
          if (v === null) {
            pen = false;
            return;
          }
          d += `${pen ? 'L' : 'M'}${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}`;
          pen = true;
        });
        return d;
      }),
    [shown, ts, width, top],
  );

  const onMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (ts.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    for (let i = 1; i < ts.length; i++) if (Math.abs(x(ts[i]) - px) < Math.abs(x(ts[best]) - px)) best = i;
    setHover(best);
  };

  const lastIdx = (vals: (number | null)[]): number => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] !== null) return i;
    return -1;
  };
  const nTicks = Math.max(2, o.ticks ?? 3);
  const xTicks = ts.length > 1 ? [...new Set(Array.from({ length: nTicks }, (_, k) => Math.round((k * (ts.length - 1)) / (nTicks - 1))))] : ts.length ? [0] : [];
  // 时间跨度很短时刻度会挤在一起或文字相同：和上一个标出的刻度太近（< 60px）或文字相同就不标
  const labelTicks: number[] = [];
  for (const i of xTicks) {
    const prev = labelTicks.at(-1);
    if (prev === undefined || (x(ts[i]) - x(ts[prev]) >= 60 && fmtT(ts[i]) !== fmtT(ts[prev]))) labelTicks.push(i);
  }

  return (
    <div className="history-chart" ref={wrap} data-testid={testId}>
      {shown.length > 1 && (
        <div className="chart-legend">
          {shown.map((s, i) => (
            <span key={s.name} className="chart-legend-item">
              <span className="chart-key" style={{ background: colors[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`${shown.map((s) => s.name).join('、')} 最近的变化`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        style={{ display: 'block', touchAction: 'none' }}
      >
        {[0, top / 2, top].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + innerW} y1={y(v)} y2={y(v)} stroke={v === 0 ? c.axis : c.grid} strokeWidth={1} strokeDasharray={v === 0 ? undefined : '3 4'} />
            {yLabels && (
              <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill={c.muted} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmt(v)}
              </text>
            )}
          </g>
        ))}
        {labelTicks.map((i) => (
          <text key={i} x={x(ts[i])} y={HEIGHT - 6} textAnchor={i === 0 ? 'start' : i === ts.length - 1 ? 'end' : 'middle'} fontSize={10} fill={c.muted}>
            {fmtT(ts[i])}
          </text>
        ))}
        {paths.map((d, i) => (
          <path key={shown[i].name} d={d} fill="none" stroke={colors[i]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* 末端：带底色描边的圆点 + 数值（文字用文字色，不用序列色） */}
        {shown.map((s, i) => {
          const li = endLabels ? lastIdx(s.values) : -1;
          if (li < 0) return null;
          const v = s.values[li]!;
          return (
            <g key={s.name}>
              <circle cx={x(ts[li])} cy={y(v)} r={4} fill={colors[i]} stroke={c.surface} strokeWidth={2} />
              <text x={x(ts[li]) + 8} y={y(v) + 4} fontSize={11} fill={c.secondary} style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmt(v)}
              </text>
            </g>
          );
        })}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(ts[hover])} x2={x(ts[hover])} y1={PAD.top} y2={PAD.top + innerH} stroke={c.muted} strokeWidth={1} />
            {shown.map((s, i) =>
              s.values[hover] === null ? null : <circle key={s.name} cx={x(ts[hover])} cy={y(s.values[hover]!)} r={4} fill={colors[i]} stroke={c.surface} strokeWidth={2} />,
            )}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="chart-tooltip"
          style={{ left: Math.min(Math.max(x(ts[hover]) + 10, 0), width - 150), top: PAD.top }}
          data-testid={testId ? `${testId}-tooltip` : undefined}
        >
          <div className="chart-tooltip-time">{fmtT(ts[hover])}</div>
          {shown.map((s, i) => (
            <div key={s.name} className="chart-tooltip-row">
              <span className="chart-line-key" style={{ background: colors[i] }} />
              <strong>{s.values[hover] === null ? '—' : fmtTip(s.values[hover]!)}</strong>
              <span className="chart-tooltip-name">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
