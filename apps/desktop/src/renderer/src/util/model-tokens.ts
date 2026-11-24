/**
 * 上下文窗口 / 最大输出的输入（第二十五轮，模型设置弹窗）：纯数字按 k 处理，也支持 k、M（例如 128、128k、1M、1.5m），最大 10M。
 * 空串返回 null（留空），格式不对返回 NaN。
 */
export const MAX_TOKENS_INPUT = 10_000_000;

export function parseTokens(input: string): number | null {
  const t = input.trim().replace(/,/g, '').toLowerCase();
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([km]?)$/.exec(t);
  if (!m) return NaN;
  const n = Number(m[1]) * (m[2] === 'm' ? 1_000_000 : 1000);
  if (!Number.isFinite(n) || n < 1000 || n > MAX_TOKENS_INPUT) return NaN;
  return Math.round(n);
}

/** 显示成 128K、1M、256K（262144）、1.05M；整千 / 整百万、2 的整数次幂（1024 进制）都不带小数 */
export function formatTokens(n: number | null | undefined): string {
  if (!n || !Number.isFinite(n)) return '';
  if (n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n % 1_048_576 === 0) return `${n / 1_048_576}M`;
  if (n < 1_000_000 && n % 1000 === 0) return `${n / 1000}K`;
  if (n < 1_048_576 && n % 1024 === 0) return `${n / 1024}K`;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}K`;
  return String(n);
}
