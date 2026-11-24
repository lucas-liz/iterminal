import { useEffect, useMemo, useState } from 'react';
import type { ITheme } from '@xterm/xterm';
import { appThemeScheme, terminalSchemeFor, TERMINAL_SCHEMES, type TerminalScheme } from '@itm/protocol';
import { useApp } from '../store/app';

/** 设置里的 dark / light / system 解析成实际使用的深浅色 */
export function useResolvedTheme(): 'dark' | 'light' {
  const mode = useApp((s) => s.settings['ui.theme']);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = (e: MediaQueryListEvent): void => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
}

/** 配色方案 → xterm 的主题 */
export function schemeToTheme(s: TerminalScheme): ITheme {
  // 终端自己的滚动条（xterm 6 自绘）用配色里的蓝色，和整体的主题色一致
  const blue = s.colors.brightBlue;
  return { ...s.colors, cursorAccent: s.colors.background, scrollbarSliderBackground: `${blue}55`, scrollbarSliderHoverBackground: `${blue}88`, scrollbarSliderActiveBackground: `${blue}aa` };
}

/** 兼容旧代码：内置的 iTerminal 深色 / 浅色 */
export const TERMINAL_THEMES: Record<'dark' | 'light', ITheme> = {
  dark: schemeToTheme(TERMINAL_SCHEMES.find((x) => x.id === 'itm-dark')!),
  light: schemeToTheme(TERMINAL_SCHEMES.find((x) => x.id === 'itm-light')!),
};

/** 当前界面模式下的应用主题（设置 → 外观 → 主题）：决定整个界面的配色 */
export function useAppScheme(): TerminalScheme {
  const resolved = useResolvedTheme();
  const cfg = useApp((s) => s.settings['terminal.colors']);
  const id = useApp((s) => s.settings[resolved === 'dark' ? 'ui.themeDark' : 'ui.themeLight']);
  return useMemo(() => appThemeScheme(cfg, id, resolved), [cfg, id, resolved]);
}

/** 终端使用的配色方案：默认跟随应用主题，也可以在 设置 → 终端 → 终端配色 里单独设置 */
export function useTerminalScheme(): TerminalScheme {
  const resolved = useResolvedTheme();
  const cfg = useApp((s) => s.settings['terminal.colors']);
  const id = useApp((s) => s.settings[resolved === 'dark' ? 'ui.themeDark' : 'ui.themeLight']);
  return useMemo(() => terminalSchemeFor(cfg, id, resolved), [cfg, id, resolved]);
}

export function useTerminalTheme(): ITheme {
  const scheme = useTerminalScheme();
  return useMemo(() => schemeToTheme(scheme), [scheme]);
}
