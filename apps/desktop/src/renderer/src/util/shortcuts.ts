import { SHORTCUTS, type ShortcutId } from '@itm/protocol';
import { isMac } from '../api';
import { useApp } from '../store/app';

/** 标点键按物理键位换算（Shift 不影响），和 Electron 的写法一致 */
const CODE_KEYS: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
};

/** 按键事件 → 组合键（Mod+Shift+A）；只按了修饰键时返回 null */
export function eventCombo(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  if (['Control', 'Meta', 'Alt', 'Shift', 'CapsLock', 'Fn'].includes(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods: string[] = [];
  // macOS：⌘ 是 Mod，Ctrl 单独写；其他系统：Ctrl 是 Mod，Win 键写成 Meta
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('Mod');
  if (isMac ? e.ctrlKey : false) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!isMac && e.metaKey) mods.push('Meta');
  return [...mods, key].join('+');
}

/** 统一修饰键顺序后比较（Ctrl 在其他系统等同于 Mod） */
function normalize(combo: string): string {
  if (!combo) return '';
  const parts = combo.split('+').map((p, i, a) => (p === '' && i === a.length - 1 ? '+' : p)).filter(Boolean);
  const key = parts.pop()!;
  const mods = new Set(parts.map((m) => (!isMac && m === 'Ctrl' ? 'Mod' : m)));
  return [...['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => mods.has(m)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

export function defaultShortcut(id: ShortcutId): string {
  const d = SHORTCUTS.find((s) => s.id === id)!;
  return isMac ? d.mac : d.other;
}

/** 当前生效的组合键（用户改过的优先） */
export function shortcutOf(id: ShortcutId): string {
  const custom = useApp.getState().settings['ui.shortcuts']?.[id];
  return custom ?? defaultShortcut(id);
}

/** 这个按键事件是不是某个快捷键 */
export function matchShortcut(e: KeyboardEvent | React.KeyboardEvent, id: ShortcutId): boolean {
  const combo = shortcutOf(id);
  if (!combo) return false;
  const got = eventCombo('nativeEvent' in e ? e.nativeEvent : e);
  return !!got && normalize(got) === normalize(combo);
}

/** 显示用：macOS 用 ⌘⇧⌥⌃ 符号，其他系统用 Ctrl+Shift+A */
export function formatCombo(combo: string): string {
  if (!combo) return '';
  const parts = combo.split('+').map((p, i, a) => (p === '' && i === a.length - 1 ? '+' : p)).filter(Boolean);
  if (isMac) {
    const sym: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘', Enter: '↩', Tab: '⇥', Escape: '⎋', Backspace: '⌫', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    return parts.map((p) => sym[p] ?? p).join('');
  }
  return parts.map((p) => (p === 'Mod' ? 'Ctrl' : p === 'Meta' ? 'Win' : p)).join('+');
}

/** 某个快捷键的显示文字（没有设置时返回空字符串） */
export function shortcutLabel(id: ShortcutId): string {
  return formatCombo(shortcutOf(id));
}

/** 和其他快捷键冲突的（同一个组合键） */
export function conflictsOf(id: ShortcutId, combo: string): ShortcutId[] {
  if (!combo) return [];
  const n = normalize(combo);
  return SHORTCUTS.filter((s) => s.id !== id && normalize(shortcutOf(s.id)) === n).map((s) => s.id);
}

/** 组件里显示快捷键（设置改了会刷新） */
export function useShortcutLabel(id: ShortcutId): string {
  const custom = useApp((s) => s.settings['ui.shortcuts']?.[id]);
  return formatCombo(custom ?? defaultShortcut(id));
}
