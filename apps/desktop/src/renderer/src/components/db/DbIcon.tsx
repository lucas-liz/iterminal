import { dbProductOf, type DbType } from '@itm/protocol';

/**
 * 数据库产品图标（第二十七轮）：统一的圆角方块 + 品牌色。没有用各家的商标图形，
 * 少数用简单的几何图形示意（Redis 的叠层、MongoDB 的叶子、ClickHouse 的竖条、Oracle 的圆环），其余用缩写。
 */
const MARKS: Record<string, { bg: string; fg?: string; text?: string; glyph?: 'stack' | 'leaf' | 'bars' | 'ring' | 'feather' | 'elephant' | 'dolphin' | 'star' }> = {
  mysql: { bg: 'linear-gradient(135deg, #00758f, #00546b)', glyph: 'dolphin' },
  mariadb: { bg: 'linear-gradient(135deg, #1f305f, #003545)', fg: '#c49a6c', text: 'Ma' },
  tidb: { bg: 'linear-gradient(135deg, #e30c34, #b5082a)', text: 'Ti' },
  oceanbase: { bg: 'linear-gradient(135deg, #0181fd, #0058c7)', text: 'OB' },
  polardb: { bg: 'linear-gradient(135deg, #ff6a00, #e04a00)', text: 'RDS' },
  doris: { bg: 'linear-gradient(135deg, #5b6cf0, #3946c4)', glyph: 'star' },
  postgres: { bg: 'linear-gradient(135deg, #336791, #234a6b)', glyph: 'elephant' },
  greenplum: { bg: 'linear-gradient(135deg, #3fb07c, #1d7a52)', text: 'GP' },
  cockroach: { bg: 'linear-gradient(135deg, #6933ff, #4618c9)', text: 'CR' },
  sqlite: { bg: 'linear-gradient(135deg, #3a9ad9, #0f6aa8)', glyph: 'feather' },
  redis: { bg: 'linear-gradient(135deg, #e0443a, #b52a22)', glyph: 'stack' },
  tdengine: { bg: 'linear-gradient(135deg, #2f6ef6, #1747c4)', text: 'TD' },
  mongodb: { bg: 'linear-gradient(135deg, #13aa52, #0b7a3a)', glyph: 'leaf' },
  clickhouse: { bg: '#1e1e1e', glyph: 'bars' },
  oracle: { bg: 'linear-gradient(135deg, #f0322a, #c4120c)', glyph: 'ring' },
  sqlserver: { bg: 'linear-gradient(135deg, #cc2927, #9b1c1a)', text: 'MS' },
  dameng: { bg: 'linear-gradient(135deg, #1f5ba8, #123d78)', text: 'DM' },
  kingbase: { bg: 'linear-gradient(135deg, #c8102e, #8f0a20)', text: 'KB' },
  elasticsearch: { bg: 'linear-gradient(135deg, #00bfb3, #0a8f87)', text: 'ES' },
  influxdb: { bg: 'linear-gradient(135deg, #9b4dff, #6a28d1)', text: 'Ix' },
};

function Glyph({ kind }: { kind: NonNullable<(typeof MARKS)[string]['glyph']> }): React.JSX.Element {
  const w = '#fff';
  switch (kind) {
    case 'stack':
      return (
        <svg viewBox="0 0 24 24" width="62%" height="62%" aria-hidden>
          <path d="M12 3 21 7l-9 4-9-4z" fill={w} />
          <path d="M3 11.5 12 15.5l9-4" fill="none" stroke={w} strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M3 16 12 20l9-4" fill="none" stroke={w} strokeWidth="1.8" strokeLinejoin="round" opacity="0.8" />
        </svg>
      );
    case 'leaf':
      return (
        <svg viewBox="0 0 24 24" width="62%" height="62%" aria-hidden>
          <path d="M12 2c3.6 3.4 5.4 6.9 5.4 10.4 0 3.5-2.2 6.2-5.4 7.6-3.2-1.4-5.4-4.1-5.4-7.6C6.6 8.9 8.4 5.4 12 2z" fill={w} />
          <path d="M12 6v16" stroke="#0b7a3a" strokeWidth="1.2" />
        </svg>
      );
    case 'bars':
      return (
        <svg viewBox="0 0 24 24" width="62%" height="62%" aria-hidden>
          {[3, 7, 11, 15].map((x) => (
            <rect key={x} x={x} y={4} width="2.6" height="16" rx="0.6" fill="#fc0" />
          ))}
          <rect x={19} y={10} width="2.6" height="4" rx="0.6" fill="#fc0" />
        </svg>
      );
    case 'ring':
      return (
        <svg viewBox="0 0 24 24" width="66%" height="66%" aria-hidden>
          <rect x="3" y="7.5" width="18" height="9" rx="4.5" fill="none" stroke={w} strokeWidth="2.4" />
        </svg>
      );
    case 'feather':
      return (
        <svg viewBox="0 0 24 24" width="62%" height="62%" aria-hidden>
          <path d="M19 3C12 4 7 9 6 17l-2 4 3-2c7-1 11-6 12-16z" fill={w} />
          <path d="M6 17c3-4 6-7 10-10" stroke="#0f6aa8" strokeWidth="1.2" fill="none" />
        </svg>
      );
    case 'elephant':
      return (
        <svg viewBox="0 0 24 24" width="64%" height="64%" aria-hidden>
          <path d="M5 13c0-4.4 3.1-8 7.5-8S20 8.2 20 12.2c0 2.3-1 3.6-2.2 4.4V20h-2.4v-2.6h-2.6V20h-2.4v-3c-1.3-.3-2.3-1.3-2.6-2.5-.4 1.6-.1 3.4.7 4.6-2.3-.8-3.5-3.2-3.5-6.1z" fill={w} />
          <circle cx="15.6" cy="10.4" r="0.9" fill="#234a6b" />
        </svg>
      );
    case 'dolphin':
      return (
        <svg viewBox="0 0 24 24" width="66%" height="66%" aria-hidden>
          <path d="M3 15c3.5-6 9-9 15.5-8.3L21 5l-.6 3.2c.7.9 1 1.9 1 3-2.8-1.6-6-1.6-9 .2 2 .5 3.3 1.7 3.6 3.5-2.4-1.2-5-1.4-7.6-.6L5.5 17z" fill={w} />
          <path d="M5.5 17 3 20" stroke="#f29111" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'star':
      return (
        <svg viewBox="0 0 24 24" width="62%" height="62%" aria-hidden>
          <path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6.1L12 16.6l-5.4 3 1.2-6.1-4.5-4.2 6.1-.7z" fill={w} />
        </svg>
      );
  }
}

/** 按产品 id 画图标 */
export function DbProductIcon({ id, size = 32, muted = false }: { id: string; size?: number; muted?: boolean }): React.JSX.Element {
  const m = MARKS[id] ?? { bg: 'linear-gradient(135deg, #8c8c8c, #595959)', text: id.slice(0, 2).toUpperCase() };
  return (
    <span
      className={`db-icon ${muted ? 'muted' : ''}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.26), background: m.bg, color: m.fg ?? '#fff', fontSize: Math.round(size * (m.text && m.text.length > 2 ? 0.3 : 0.38)) }}
      data-db={id}
    >
      {m.glyph ? <Glyph kind={m.glyph} /> : m.text}
    </span>
  );
}

/** 按数据库记录（类型 + 产品）画图标 */
export function DbIcon({ type, flavor, size = 18 }: { type: DbType; flavor?: string | null; size?: number }): React.JSX.Element {
  return <DbProductIcon id={dbProductOf({ type, flavor }).id} size={size} />;
}
