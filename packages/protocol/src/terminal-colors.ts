/**
 * 终端配色方案（第四轮）：内置方案 + 自定义方案；深色界面和浅色界面各选一个。
 * 默认深色界面用 iTerminal 深色（之前的样子），浅色界面参考 MobaXterm：黑底、高亮的绿 / 洋红 / 青色。
 */

export const TERMINAL_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
] as const;

export type TerminalColorKey = (typeof TERMINAL_COLOR_KEYS)[number];
export type TerminalColors = Record<TerminalColorKey, string>;

export interface TerminalScheme {
  id: string;
  name: string;
  colors: TerminalColors;
}

export interface TerminalColorSettings {
  /**
   * 终端配色跟随应用主题（第十二轮，默认）：外观里选的主题同时决定界面和终端的配色；
   * false 时按下面的 dark / light 单独设置（没有这个字段的旧设置按 true 处理）
   */
  follow?: boolean;
  /** 单独设置时，深色界面使用的方案 ID */
  dark: string;
  /** 单独设置时，浅色界面使用的方案 ID */
  light: string;
  /** 自定义方案（ID 以 custom- 开头） */
  custom: TerminalScheme[];
}

export const TERMINAL_COLOR_LABEL: Record<TerminalColorKey, string> = {
  background: '背景',
  foreground: '文字',
  cursor: '光标',
  selectionBackground: '选中背景',
  black: '黑',
  red: '红',
  green: '绿',
  yellow: '黄',
  blue: '蓝',
  magenta: '洋红',
  cyan: '青',
  white: '白',
  brightBlack: '亮黑（灰）',
  brightRed: '亮红',
  brightGreen: '亮绿',
  brightYellow: '亮黄',
  brightBlue: '亮蓝',
  brightMagenta: '亮洋红',
  brightCyan: '亮青',
  brightWhite: '亮白',
};

const scheme = (id: string, name: string, c: string[]): TerminalScheme => ({
  id,
  name,
  colors: Object.fromEntries(TERMINAL_COLOR_KEYS.map((k, i) => [k, c[i]])) as TerminalColors,
});

/** 内置方案（顺序：背景、文字、光标、选中背景，然后 16 个 ANSI 颜色）；外观设置里按背景深浅分成深色主题和浅色主题 */
export const TERMINAL_SCHEMES: TerminalScheme[] = [
  // prettier-ignore
  scheme('itm-dark', 'iTerminal 深色', ['#161617', '#e4e4e7', '#4da3ff', '#264f78', '#2c2c2e', '#ff6961', '#4cd964', '#ffd60a', '#4da3ff', '#d17bf6', '#64d2ff', '#e4e4e7', '#6e6e73', '#ff8a80', '#6ee787', '#ffe066', '#7cbaff', '#e0a3ff', '#8ee2ff', '#ffffff']),
  // prettier-ignore
  scheme('itm-light', 'iTerminal 浅色', ['#faf9f6', '#1c1c1e', '#007aff', '#b4d5fe', '#1c1c1e', '#d70015', '#248a3d', '#a05a00', '#0040dd', '#8944ab', '#0071a4', '#c7c7cc', '#6e6e73', '#ff3b30', '#2e9e4b', '#b25000', '#007aff', '#af52de', '#1d8fbf', '#8e8e93']),
  // prettier-ignore
  scheme('mobaxterm', 'MobaXterm', ['#0c0c0c', '#ececec', '#ececec', '#4a4a4a', '#000000', '#d63a3a', '#3cc43c', '#d0c33a', '#3d7eff', '#cf45cf', '#2fc1c1', '#c8c8c8', '#6a6a6a', '#ff5c5c', '#5cff5c', '#ffff5c', '#6b9bff', '#ff5cff', '#5cffff', '#ffffff']),
  // prettier-ignore
  scheme('tokyo-night', 'Tokyo Night', ['#1a1b26', '#c0caf5', '#c0caf5', '#33467c', '#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6', '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  // prettier-ignore
  scheme('dracula', 'Dracula', ['#282a36', '#f8f8f2', '#f8f8f2', '#44475a', '#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2', '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  // prettier-ignore
  scheme('one-dark', 'One Dark', ['#282c34', '#abb2bf', '#528bff', '#3e4451', '#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf', '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  // prettier-ignore
  scheme('nord', 'Nord', ['#2e3440', '#d8dee9', '#d8dee9', '#434c5e', '#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0', '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  // prettier-ignore
  scheme('catppuccin-mocha', 'Catppuccin Mocha', ['#1e1e2e', '#cdd6f4', '#f5e0dc', '#585b70', '#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de', '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  // prettier-ignore
  scheme('kanagawa-wave', 'Kanagawa Wave', ['#1f1f28', '#dcd7ba', '#c8c093', '#2d4f67', '#16161d', '#c34043', '#76946a', '#c0a36e', '#7e9cd8', '#957fb8', '#6a9589', '#c8c093', '#727169', '#e82424', '#98bb6c', '#e6c384', '#7fb4ca', '#938aa9', '#7aa89f', '#dcd7ba']),
  // prettier-ignore
  scheme('everforest', 'Everforest', ['#2d353b', '#d3c6aa', '#d3c6aa', '#475258', '#343f44', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa', '#859289', '#e67e80', '#a7c080', '#dbbc7f', '#7fbbb3', '#d699b6', '#83c092', '#d3c6aa']),
  // prettier-ignore
  scheme('cyber-punk', 'Cyber Punk', ['#000000', '#e0e0f0', '#05d9e8', '#3a1f5d', '#000000', '#ff2a6d', '#05ffa1', '#f9f002', '#00b3ff', '#d300c4', '#05d9e8', '#f8f8f2', '#5a5a7a', '#ff5c8a', '#4dffbf', '#fffb5c', '#4dc9ff', '#ff4df0', '#5ee8f2', '#ffffff']),
  // prettier-ignore
  scheme('term-dark', 'Term Dark', ['#0d0d0d', '#d4d4d4', '#d4d4d4', '#3a3d41', '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']),
  // prettier-ignore
  scheme('monokai', 'Monokai', ['#272822', '#f8f8f2', '#f8f8f0', '#49483e', '#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2', '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
  // prettier-ignore
  scheme('solarized-dark', 'Solarized Dark', ['#002b36', '#839496', '#93a1a1', '#073642', '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5', '#586e75', '#cb4b16', '#93a1a1', '#b58900', '#839496', '#6c71c4', '#2aa198', '#fdf6e3']),
  // prettier-ignore
  scheme('tango', 'Tango（Ubuntu）', ['#300a24', '#eeeeec', '#eeeeec', '#5c3566', '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec']),
  // prettier-ignore
  scheme('gruvbox-dark', 'Gruvbox Dark', ['#282828', '#ebdbb2', '#ebdbb2', '#504945', '#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984', '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  // prettier-ignore
  scheme('catppuccin-latte', 'Catppuccin Latte', ['#eff1f5', '#4c4f69', '#dc8a78', '#acb0be', '#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be', '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc']),
  // prettier-ignore
  scheme('nord-light', 'Nord Light', ['#eceff4', '#2e3440', '#5e81ac', '#d8dee9', '#3b4252', '#bf616a', '#6f8f53', '#b8892f', '#5e81ac', '#9a6e94', '#4c8a99', '#d8dee9', '#4c566a', '#d08770', '#8fac74', '#d0a14d', '#81a1c1', '#b48ead', '#6ea2b0', '#e5e9f0']),
  // prettier-ignore
  scheme('material-light', 'Material Light', ['#ffffff', '#263238', '#272727', '#cfd8dc', '#263238', '#e53935', '#43a047', '#f6a434', '#1e88e5', '#8e24aa', '#00acc1', '#b0bec5', '#546e7a', '#ff5370', '#66bb6a', '#ffb62c', '#42a5f5', '#ab47bc', '#26c6da', '#eceff1']),
  // prettier-ignore
  scheme('solarized-light', 'Solarized Light', ['#fdf6e3', '#586e75', '#586e75', '#eee8d5', '#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#93a1a1', '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#2aa198', '#fdf6e3']),
  // prettier-ignore
  scheme('github-light', 'GitHub Light', ['#ffffff', '#24292f', '#0969da', '#c8e1ff', '#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781', '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
  // prettier-ignore
  scheme('one-light', 'One Light', ['#fafafa', '#383a42', '#526fff', '#e5e5e6', '#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7', '#4f525e', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
];

export const DEFAULT_TERMINAL_COLORS: TerminalColorSettings = { follow: true, dark: 'itm-dark', light: 'mobaxterm', custom: [] };

/** 应用主题（设置 → 外观 → 主题）的默认值：深色界面、浅色界面各一个，取值是配色方案的 ID */
export const DEFAULT_APP_THEME = { dark: 'itm-dark', light: 'itm-light' } as const;

/** 应用主题配套的终端配色：iTerminal 浅色界面的终端沿用 MobaXterm 风格（黑底，第四轮），其他主题就是同名的配色方案 */
export const APP_THEME_TERMINAL: Record<string, string> = { 'itm-light': 'mobaxterm' };

/** 按 ID 找方案（内置 + 自定义） */
export function findScheme(cfg: TerminalColorSettings | undefined, id: string | undefined | null): TerminalScheme | undefined {
  if (!id) return undefined;
  return TERMINAL_SCHEMES.find((s) => s.id === id) ?? cfg?.custom?.find((s) => s.id === id);
}

/** 应用主题对应的方案；找不到（自定义方案被删掉）或者深浅和界面模式对不上时用这个模式的默认主题 */
export function appThemeScheme(cfg: TerminalColorSettings | undefined, id: string | undefined | null, mode: 'dark' | 'light'): TerminalScheme {
  const s = findScheme(cfg, id);
  if (s && isDarkColor(s.colors.background) === (mode === 'dark')) return s;
  return findScheme(cfg, DEFAULT_APP_THEME[mode])!;
}

/** 终端实际使用的配色：跟随应用主题时用主题配套的方案，单独设置时按界面模式取 dark / light */
export function terminalSchemeFor(cfg: TerminalColorSettings, appThemeId: string | undefined | null, mode: 'dark' | 'light'): TerminalScheme {
  if (cfg?.follow === false) return resolveTerminalScheme(cfg, mode);
  const app = appThemeScheme(cfg, appThemeId, mode);
  return findScheme(cfg, APP_THEME_TERMINAL[app.id]) ?? app;
}

/** 按 ID 找方案（内置 + 自定义）；找不到时用对应模式的默认方案 */
export function resolveTerminalScheme(cfg: TerminalColorSettings, mode: 'dark' | 'light'): TerminalScheme {
  const all = [...TERMINAL_SCHEMES, ...(cfg?.custom ?? [])];
  const id = cfg?.[mode] ?? DEFAULT_TERMINAL_COLORS[mode];
  return all.find((s) => s.id === id) ?? all.find((s) => s.id === DEFAULT_TERMINAL_COLORS[mode])!;
}

/** 背景是不是深色（决定光标文字颜色、选中文字颜色等） */
export function isDarkColor(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return true;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}
