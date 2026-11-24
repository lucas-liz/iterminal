import { useEffect, useState } from 'react';
import { Segmented, Tooltip } from 'antd';
import type { MetricsSnapshot, MonitorStatic } from '@itm/protocol';
import { invoke } from '../../api';
import type { HistoryPoint } from '../../store/monitor';

export type OkSnapshot = Extract<MetricsSnapshot, { state: 'ok' }>;

/** 主机信息（系统版本、CPU 和显卡型号）：每台主机只查一次 */
const staticCache = new Map<string, Promise<MonitorStatic>>();
export function useStaticInfo(hostId: string): MonitorStatic | null {
  const [info, setInfo] = useState<MonitorStatic | null>(null);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    let p = staticCache.get(hostId);
    if (!p) {
      p = invoke('monitor.static', { hostId });
      staticCache.set(hostId, p);
      p.catch(() => staticCache.delete(hostId));
    }
    p.then((v) => alive && setInfo(v)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [hostId]);
  return info;
}

/** 各类指标的颜色（CSS 变量在 App.tsx 的 PALETTE 里，深色 / 浅色各一套） */
export const MON_COLOR = {
  cpu: 'var(--mon-cpu)',
  mem: 'var(--mon-mem)',
  disk: 'var(--mon-disk)',
  net: 'var(--mon-net)',
  gpu: 'var(--mon-gpu)',
  ok: 'var(--itm-log-success)',
  warn: 'var(--itm-log-warn)',
  bad: 'var(--itm-log-error)',
} as const;

/** 用作文字时的颜色（浅色主题下更深一级，保证对比度） */
export const MON_INK = {
  cpu: 'var(--mon-cpu-ink)',
  mem: 'var(--mon-mem-ink)',
  disk: 'var(--mon-disk-ink)',
  net: 'var(--mon-net-ink)',
  gpu: 'var(--mon-gpu-ink)',
} as const;
export const ink = (c: string | undefined): string | undefined => (c?.startsWith('var(--mon-') ? c.replace(/\)$/, '-ink)') : c);

/** 使用率越高越醒目：≥90% 红色，≥75% 黄色，否则用指标自己的颜色 */
export const levelColor = (p: number, base: string): string => (p >= 90 ? MON_COLOR.bad : p >= 75 ? MON_COLOR.warn : base);

export const timeOf = (ts: number): string => {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
};

/** 细进度条 */
export function Bar({ percent, color, height = 6, gradient = false }: { percent: number; color: string; height?: number; gradient?: boolean }): React.JSX.Element {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <div className="mx-bar" style={{ height }}>
      <div className="mx-bar-fill" style={{ width: `${p}%`, background: gradient ? `linear-gradient(90deg, var(--mon-net-soft), ${color})` : color }} />
    </div>
  );
}

/** 卡片：标题（带图标）+ 右上角大数字 + 内容 */
export function MonCard({
  icon,
  title,
  value,
  color,
  children,
  className,
  testId,
  extra,
  small,
  onClick,
  clickTip,
}: {
  /** 整张卡片可以点击（例如跳到对应的分类） */
  onClick?: () => void;
  clickTip?: string;
  /** 数值是一段较长的文字（例如 193 MB / 2.0 GB）时用小一号的字 */
  small?: boolean;
  icon?: React.ReactNode;
  title: React.ReactNode;
  value?: React.ReactNode;
  color?: string;
  children?: React.ReactNode;
  className?: string;
  testId?: string;
  extra?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={`mx-card ${small ? 'mx-card-sm' : ''} ${onClick ? 'mx-card-link' : ''} ${className ?? ''}`}
      data-testid={testId}
      onClick={onClick}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={clickTip}
    >
      <div className="mx-card-head">
        {icon && (
          <span className="mx-card-icon" style={{ color }}>
            {icon}
          </span>
        )}
        <span className="mx-card-title">{title}</span>
        {extra}
        {value !== undefined && (
          <span className="mx-card-value" style={{ color: ink(color) }}>
            {value}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

/** 小方块统计：标签、大数字、说明 */
export function StatTile({ label, value, sub, color, icon, tip, testId }: { label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string; icon?: React.ReactNode; tip?: string; testId?: string }): React.JSX.Element {
  const body = (
    <div className="mx-tile" data-testid={testId}>
      <div className="mx-tile-label">
        {label}
        {icon && (
          <span className="mx-tile-icon" style={{ color }}>
            {icon}
          </span>
        )}
      </div>
      <div className="mx-tile-value" style={{ color: ink(color) }}>
        {value}
      </div>
      {sub !== undefined && <div className="mx-tile-sub">{sub}</div>}
    </div>
  );
  return tip ? <Tooltip title={tip}>{body}</Tooltip> : body;
}

export function SectionTitle({ icon, color, children, extra }: { icon: React.ReactNode; color: string; children: React.ReactNode; extra?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="mx-section-title">
      <span style={{ color }}>{icon}</span>
      <span>{children}</span>
      {extra && <span style={{ marginLeft: 'auto' }}>{extra}</span>}
    </div>
  );
}

/** 趋势图的时间范围：1 / 5 / 15 分钟（采样 2 秒一个） */
export type Range = 30 | 150 | 450;
export function useRange(): [Range, React.JSX.Element, (h: HistoryPoint[]) => HistoryPoint[]] {
  const [range, setRange] = useState<Range>(450);
  const el = (
    <Segmented
      size="small"
      value={range}
      onChange={(v) => setRange(v as Range)}
      options={[
        { value: 30, label: '1分钟' },
        { value: 150, label: '5分钟' },
        { value: 450, label: '15分钟' },
      ]}
    />
  );
  return [range, el, (h) => h.slice(-range)];
}

/** 环形图：按顺序画各段（总和超过 100% 时截断），中间显示主要数值 */
export function Donut({ segments, size = 168, thickness = 22, children }: { segments: { value: number; color: string; name: string }[]; size?: number; thickness?: number; children?: React.ReactNode }): React.JSX.Element {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const gap = 2;
  let acc = 0;
  return (
    <div className="mx-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={segments.map((s) => `${s.name} ${s.value.toFixed(0)}%`).join('，')}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--itm-hover)" strokeWidth={thickness} />
        {segments.map((s) => {
          const v = Math.max(0, Math.min(s.value, 100 - acc));
          const len = (v / 100) * c;
          const el =
            len > gap ? (
              <circle
                key={s.name}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${len - gap} ${c - len + gap}`}
                strokeDashoffset={-(acc / 100) * c}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              >
                <title>{`${s.name} ${s.value.toFixed(1)}%`}</title>
              </circle>
            ) : null;
          acc += v;
          return el;
        })}
      </svg>
      <div className="mx-donut-center">{children}</div>
    </div>
  );
}
