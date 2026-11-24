import { isDarkColor, type TerminalScheme } from '@itm/protocol';

/**
 * 界面配色（参考 Codex 的中性石墨灰和 iOS 的系统色）：从下到上依次是页面底色 → 侧栏 / 面板 → 卡片 → 弹出层，
 * 每层只差一点亮度，用细分隔线区分；强调色用 iOS 的系统蓝，成功 / 警告 / 错误用 iOS 的系统绿、黄、红。
 * 圆角按 iOS 的习惯放大：控件 8px、卡片 12px、对话框 14px，分段控件和标签用胶囊形。
 */
const ITM_PALETTE = {
  dark: {
    '--itm-bg': '#141415',
    '--itm-sider-bg': '#19191b',
    '--itm-panel-bg': '#171718',
    '--itm-card-bg': '#1e1e20',
    '--itm-elevated-bg': '#242426',
    '--itm-input-bg': '#1a1a1c',
    '--itm-section-bg': '#1c1c1e',
    '--itm-border': '#2a2a2d',
    '--itm-border-strong': '#3a3a3d',
    '--itm-hover': '#262628',
    '--itm-active': '#2c2c2f',
    '--itm-text': '#ececee',
    '--itm-text-secondary': '#98989f',
    '--itm-primary': '#0a84ff',
    '--itm-primary-soft': 'rgba(10, 132, 255, 0.16)',
    // 滚动条：主题蓝色调，悬停时更明显
    '--itm-scroll-thumb': 'rgba(10, 132, 255, 0.34)',
    '--itm-scroll-thumb-hover': 'rgba(10, 132, 255, 0.58)',
    // 连接日志的配色（信息蓝、成功绿、警告黄、错误红）
    '--itm-log-bg': '#0f0f10',
    '--itm-log-info': '#5eb1ff',
    '--itm-log-success': '#30d158',
    '--itm-log-warn': '#ffd60a',
    '--itm-log-error': '#ff453a',
    // 监控的指标分类色（dataviz 校验脚本按状态栏顺序验证过相邻色）；深色背景上文字直接用同一个颜色
    '--mon-cpu': '#3987e5',
    '--mon-mem': '#d55181',
    '--mon-gpu': '#9085e9',
    '--mon-disk': '#c98500',
    '--mon-net': '#199e70',
    '--mon-net-soft': '#3987e5',
    '--mon-cpu-ink': '#6aa6ff',
    '--mon-mem-ink': '#ef7fa8',
    '--mon-gpu-ink': '#aaa2f2',
    '--mon-disk-ink': '#e3a72a',
    '--mon-net-ink': '#3cc48f',
  },
  light: {
    // 浅色参考 Claude：接近白色的中性底色，卡片和输入框是白色，层次之间只差一点点，分隔线很淡；正文接近黑色
    '--itm-bg': '#fcfbfa',
    '--itm-sider-bg': '#f8f8f6',
    '--itm-panel-bg': '#f9f8f6',
    '--itm-card-bg': '#ffffff',
    '--itm-elevated-bg': '#ffffff',
    '--itm-input-bg': '#ffffff',
    '--itm-section-bg': '#f7f6f3',
    '--itm-border': '#ebeae6',
    '--itm-border-strong': '#dedcd7',
    '--itm-hover': '#f3f2ef',
    '--itm-active': '#efedeb',
    '--itm-text': '#141413',
    '--itm-text-secondary': '#87867f',
    '--itm-primary': '#007aff',
    '--itm-primary-soft': 'rgba(0, 122, 255, 0.1)',
    '--itm-scroll-thumb': 'rgba(0, 122, 255, 0.26)',
    '--itm-scroll-thumb-hover': 'rgba(0, 122, 255, 0.48)',
    '--itm-log-bg': '#f5f4f1',
    '--itm-log-info': '#0064d1',
    '--itm-log-success': '#248a3d',
    '--itm-log-warn': '#a05a00',
    '--itm-log-error': '#d70015',
    // 浅色背景上这几个颜色做文字对比度不够，数字改用更深的一级（进度条和图标仍用分类色）
    '--mon-cpu': '#2a78d6',
    '--mon-mem': '#e87ba4',
    '--mon-gpu': '#4a3aa7',
    '--mon-disk': '#eda100',
    '--mon-net': '#1baf7a',
    '--mon-net-soft': '#2a78d6',
    '--mon-cpu-ink': '#1c5cab',
    '--mon-mem-ink': '#a8305e',
    '--mon-gpu-ink': '#4a3aa7',
    '--mon-disk-ink': '#8a5a00',
    '--mon-net-ink': '#0e7a52',
  },
} as const;

type Vars = Record<keyof (typeof ITM_PALETTE)['dark'], string>;

/** 组件级的颜色（antd 主题里用到的，不是 CSS 变量） */
export interface PaletteTokens {
  success: string;
  warning: string;
  error: string;
  buttonBg: string;
  buttonHoverBg: string;
  segmentTrack: string;
  segmentSelected: string;
  segmentSelectedText: string;
  tooltipBg: string;
  placeholder: string;
  /** 主色按钮上的文字（主色很浅时用深色） */
  solidText: string;
}

export interface AppPalette {
  dark: boolean;
  vars: Vars;
  tokens: PaletteTokens;
}

const ITM_TOKENS: Record<'dark' | 'light', PaletteTokens> = {
  dark: {
    success: '#30d158',
    warning: '#ff9f0a',
    error: '#ff453a',
    buttonBg: '#2a2a2c',
    buttonHoverBg: '#323235',
    segmentTrack: '#202022',
    segmentSelected: '#3a3a3d',
    segmentSelectedText: '#ffffff',
    tooltipBg: '#3a3a3d',
    placeholder: '#6c6c70',
    solidText: '#ffffff',
  },
  light: {
    success: '#34c759',
    warning: '#ff9500',
    error: '#ff3b30',
    buttonBg: '#ffffff',
    buttonHoverBg: '#f3f2ef',
    segmentTrack: '#efedeb',
    segmentSelected: '#ffffff',
    segmentSelectedText: '#141413',
    tooltipBg: 'rgba(28, 28, 30, 0.92)',
    placeholder: '#a9a8a2',
    solidText: '#ffffff',
  },
};

// ---------------------------------------------------------------- 颜色计算

const rgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
};
const hex = (c: number[]): string => `#${c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('')}`;
/** a 和 b 按 t 混合（t = 0 是 a，1 是 b） */
export const mix = (a: string, b: string, t: number): string => {
  const x = rgb(a);
  const y = rgb(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};
const alpha = (c: string, a: number): string => {
  const [r, g, b] = rgb(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};
/** WCAG 相对亮度 */
const luminance = (c: string): number => {
  const [r, g, b] = rgb(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/**
 * 优先用普通色；在背景上看不清（对比度 < 2.5）时才换亮色。
 * 不能直接取对比度最高的：有的方案（Solarized）的「亮色」其实是灰色
 */
const readable = (bg: string, normal: string, bright: string): string => (contrast(normal, bg) >= 2.5 || contrast(normal, bg) >= contrast(bright, bg) ? normal : bright);

/**
 * 应用主题 → 界面配色（第十二轮）：iTerminal 深色 / 浅色用原来精调过的配色；其他主题从配色方案推导——
 * 层次（侧栏、面板、卡片、弹出层、边框、悬停）按背景向文字色混合一点点，强调色用方案里的蓝色，
 * 成功 / 警告 / 错误用方案里的绿 / 黄 / 红（取在背景上更清楚的那个）。监控图表的分类色沿用同一模式的默认值。
 */
export function appPalette(scheme: TerminalScheme): AppPalette {
  if (scheme.id === 'itm-dark' || scheme.id === 'itm-light') {
    const m = scheme.id === 'itm-dark' ? 'dark' : 'light';
    return { dark: m === 'dark', vars: { ...ITM_PALETTE[m] }, tokens: ITM_TOKENS[m] };
  }
  const c = scheme.colors;
  const dark = isDarkColor(c.background);
  const base = ITM_PALETTE[dark ? 'dark' : 'light'];
  const bg = c.background;
  const fg = c.foreground;
  const layer = (t: number): string => mix(bg, fg, t);
  // 浅色主题的卡片、输入框更接近白色；深色主题往文字色方向提亮
  const raised = (t: number, white: number): string => (dark ? layer(t) : mix(bg, '#ffffff', white));
  const primary = readable(bg, c.blue, c.brightBlue);
  const success = readable(bg, c.green, c.brightGreen);
  const warning = readable(bg, c.yellow, c.brightYellow);
  const error = readable(bg, c.red, c.brightRed);
  const vars: Vars = {
    ...base,
    '--itm-bg': bg,
    '--itm-sider-bg': dark ? layer(0.02) : mix(bg, '#000000', 0.02),
    '--itm-panel-bg': dark ? layer(0.012) : mix(bg, '#000000', 0.012),
    '--itm-card-bg': raised(0.04, 0.6),
    '--itm-elevated-bg': raised(0.065, 0.75),
    '--itm-input-bg': raised(0.025, 0.6),
    '--itm-section-bg': dark ? layer(0.035) : mix(bg, '#000000', 0.025),
    '--itm-border': layer(dark ? 0.1 : 0.09),
    '--itm-border-strong': layer(dark ? 0.18 : 0.16),
    '--itm-hover': layer(dark ? 0.07 : 0.045),
    '--itm-active': layer(dark ? 0.1 : 0.07),
    '--itm-text': fg,
    '--itm-text-secondary': mix(fg, bg, 0.42),
    '--itm-primary': primary,
    '--itm-primary-soft': alpha(primary, dark ? 0.18 : 0.12),
    '--itm-scroll-thumb': alpha(primary, dark ? 0.34 : 0.26),
    '--itm-scroll-thumb-hover': alpha(primary, dark ? 0.58 : 0.48),
    '--itm-log-bg': dark ? mix(bg, '#000000', 0.25) : layer(0.03),
    '--itm-log-info': primary,
    '--itm-log-success': success,
    '--itm-log-warn': warning,
    '--itm-log-error': error,
  };
  return {
    dark,
    vars,
    tokens: {
      success,
      warning,
      error,
      buttonBg: raised(0.06, 0.7),
      buttonHoverBg: layer(dark ? 0.1 : 0.05),
      segmentTrack: dark ? mix(bg, '#000000', 0.18) : layer(0.06),
      segmentSelected: dark ? layer(0.16) : mix(bg, '#ffffff', 0.85),
      segmentSelectedText: fg,
      tooltipBg: dark ? layer(0.18) : alpha(mix(fg, '#000000', 0.2), 0.92),
      placeholder: mix(fg, bg, 0.55),
      solidText: luminance(primary) > 0.45 ? mix(bg, '#000000', 0.4) : '#ffffff',
    },
  };
}
