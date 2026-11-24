/**
 * 快捷键（第八轮）：默认值就是原来写死的那几个，用户可以在「设置 → 快捷键」里改。
 * 组合键写法：修饰键 + 键，用 + 连接，例如 Mod+Shift+A。Mod 在 macOS 是 ⌘，其他系统是 Ctrl；
 * 字母、数字按物理键位（不受输入法和 Shift 影响），其余按键名（Enter、Tab、F1、,）。空字符串表示不使用。
 */
export type ShortcutId =
  | 'toggleMode'
  | 'toggleSider'
  | 'openSettings'
  | 'newLocalTerminal'
  | 'nextTab'
  | 'prevTab'
  | 'termSearch'
  | 'termCopy'
  | 'termPaste'
  | 'aiNewConversation'
  | 'focusAiInput'
  | 'approveStep'
  | 'editorSave';

export interface ShortcutDef {
  id: ShortcutId;
  group: '全局' | '终端' | 'AI' | '编辑';
  label: string;
  description?: string;
  mac: string;
  other: string;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: 'toggleMode', group: '全局', label: '切换终端 / AI 对话模式', mac: 'Mod+Shift+A', other: 'Mod+Shift+A' },
  { id: 'toggleSider', group: '全局', label: '收起 / 展开左侧栏', mac: 'Mod+B', other: 'Ctrl+Shift+B' },
  { id: 'openSettings', group: '全局', label: '打开设置', mac: 'Mod+,', other: '' },
  { id: 'newLocalTerminal', group: '终端', label: '新建本地终端', mac: '', other: '' },
  { id: 'nextTab', group: '终端', label: '下一个标签', mac: '', other: '' },
  { id: 'prevTab', group: '终端', label: '上一个标签', mac: '', other: '' },
  { id: 'termSearch', group: '终端', label: '在终端中搜索', mac: 'Mod+F', other: 'Ctrl+Shift+F', description: '其他系统默认不用 Ctrl+F，留给 shell' },
  { id: 'termCopy', group: '终端', label: '复制选中的文字', mac: '', other: 'Ctrl+Shift+C', description: 'macOS 由菜单的 ⌘C 处理；其他系统 Ctrl+C 留给远端中断' },
  { id: 'termPaste', group: '终端', label: '粘贴', mac: '', other: 'Ctrl+Shift+V', description: 'macOS 由菜单的 ⌘V 处理' },
  { id: 'aiNewConversation', group: 'AI', label: '新的 AI 对话', mac: '', other: '' },
  { id: 'focusAiInput', group: 'AI', label: '聚焦 AI 输入框', mac: '', other: '' },
  { id: 'approveStep', group: 'AI', label: '批准当前的审批卡片', description: '焦点在审批卡片的命令输入框里时', mac: 'Mod+Enter', other: 'Mod+Enter' },
  { id: 'editorSave', group: '编辑', label: '保存远程文件', description: '内置编辑器里', mac: 'Mod+S', other: 'Mod+S' },
];

/** 用户改过的快捷键（没改的不在里面） */
export type ShortcutMap = Partial<Record<ShortcutId, string>>;

const MODS = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'];

/** 组合键是否合法：至少有一个修饰键（F1–F12 等功能键可以单独用），最后是一个键 */
export function isValidCombo(combo: string): boolean {
  if (combo === '') return true;
  if (combo.length > 40) return false;
  const parts = combo.split('+').map((p, i, a) => (p === '' && i === a.length - 1 ? '+' : p)).filter(Boolean);
  if (!parts.length) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (MODS.includes(key) || mods.some((m) => !MODS.includes(m)) || new Set(mods).size !== mods.length) return false;
  return mods.length > 0 || /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

export function isShortcutMap(v: unknown): v is ShortcutMap {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([k, c]) => SHORTCUTS.some((s) => s.id === k) && typeof c === 'string' && isValidCombo(c));
}
