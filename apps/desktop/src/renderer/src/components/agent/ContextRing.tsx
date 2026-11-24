import { Button, Popover, Tooltip, Typography } from 'antd';
import { CompressOutlined } from '@ant-design/icons';
import type { ContextUsage } from '@itm/protocol';

export const CATEGORY_META: { key: keyof ContextUsage['categories']; label: string; color: string }[] = [
  { key: 'messages', label: '消息', color: '#0a84ff' },
  { key: 'terminals', label: '终端主机', color: '#36cfc9' },
  { key: 'skills', label: 'Skill', color: '#b37feb' },
  { key: 'kb', label: '知识库', color: '#faad14' },
  { key: 'system', label: '系统提示与工具', color: '#8c8c8c' },
];

const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

/** 上下文占用环：按类别分段，中间是占用百分比 */
export function ContextRing({
  usage,
  threshold,
  onCompress,
  compressing,
  disabled,
}: {
  usage: ContextUsage | null;
  threshold: number;
  onCompress(): void;
  compressing: boolean;
  disabled: boolean;
}): React.JSX.Element {
  const size = 30;
  const stroke = 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const segments = usage
    ? CATEGORY_META.map((m) => {
        const frac = usage.window > 0 ? usage.categories[m.key] / usage.window : 0;
        const len = Math.min(frac, 1) * c;
        const seg = { ...m, len, offset };
        offset += len;
        return seg;
      }).filter((s) => s.len > 0)
    : [];
  const pct = usage?.percent ?? 0;
  const warn = pct >= threshold ? '#ff4d4f' : pct >= threshold * 0.8 ? '#faad14' : undefined;

  const content = usage ? (
    <div style={{ width: 260 }} data-testid="context-breakdown">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <Typography.Text strong>上下文占用</Typography.Text>
        <Typography.Text>{`${fmt(usage.used)} / ${fmt(usage.window)}（${usage.used > 0 && pct < 1 ? '<1' : pct}%）`}</Typography.Text>
      </div>
      {CATEGORY_META.map((m) => (
        <div key={m.key} className="ctx-row">
          <span className="ctx-dot" style={{ background: m.color }} />
          <span>{m.label}</span>
          <span style={{ marginLeft: 'auto' }} className="mono">
            {m.key === 'kb' && usage.categories.kb === 0 ? '未连接' : fmt(usage.categories[m.key])}
          </span>
        </div>
      ))}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0' }}>
        {usage.calibrated ? '已按模型返回的真实用量校准。' : '按字符估算，首次回答后会按真实用量校准。'}
        {`达到 ${threshold}% 时自动压缩：把之前的对话总结成摘要，之后从摘要继续。`}
      </Typography.Paragraph>
      <Button block size="small" icon={<CompressOutlined />} loading={compressing} disabled={disabled} onClick={onCompress} data-testid="compress">
        立即压缩
      </Button>
    </div>
  ) : (
    <Typography.Text type="secondary">选择模型后显示</Typography.Text>
  );

  return (
    <Popover content={content} trigger="click" placement="topRight">
      <Tooltip title="上下文占用（点击查看明细、压缩）" mouseEnterDelay={0.5}>
      <span className="ctx-ring" data-testid="context-ring">
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--itm-hover)" strokeWidth={stroke} />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {segments.map((s) => (
              <circle
                key={s.key}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={stroke}
                strokeDasharray={`${s.len} ${c - s.len}`}
                strokeDashoffset={-s.offset}
              />
            ))}
          </g>
        </svg>
        {/* 百分比放在圆环中间 */}
        <span className="ctx-ring-pct mono" style={{ color: warn }} data-testid="context-pct">
          {usage && usage.used > 0 && pct < 1 ? '<1' : pct}
          <small>%</small>
        </span>
      </span>
      </Tooltip>
    </Popover>
  );
}
