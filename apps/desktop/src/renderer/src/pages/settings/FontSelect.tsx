import { useMemo, useState } from 'react';
import { Select, Tag } from 'antd';

/** 终端字体（等宽）：前面是常见的编程字体，后面是中文等宽字体 */
export const TERMINAL_FONTS = [
  'Menlo',
  'SF Mono',
  'Monaco',
  'JetBrains Mono',
  'Fira Code',
  'Cascadia Code',
  'Cascadia Mono',
  'Consolas',
  'Source Code Pro',
  'Hack',
  'IBM Plex Mono',
  'Roboto Mono',
  'Ubuntu Mono',
  'DejaVu Sans Mono',
  'Noto Sans Mono',
  'Inconsolata',
  'Victor Mono',
  'Maple Mono',
  'MesloLGS NF',
  'Sarasa Mono SC',
  'LXGW WenKai Mono',
  'Courier New',
];
export const TERMINAL_FALLBACK = 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", "PingFang SC", "Microsoft YaHei", monospace';

/** 界面字体：空字符串表示跟随系统 */
export const UI_FONTS = ['PingFang SC', 'Microsoft YaHei', 'HarmonyOS Sans SC', 'Source Han Sans SC', 'Noto Sans SC', 'Inter', 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', 'LXGW WenKai'];
export const UI_FALLBACK = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif';

/** 字体是否装在本机：和通用字体族比较文字宽度（同时比较等宽和衬线两种回退，避免恰好同宽） */
const cache = new Map<string, boolean>();
export function fontInstalled(name: string): boolean {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return true;
  const sample = 'mmmmmmmmmmlli10OOWW汉字';
  const width = (font: string): number => {
    ctx.font = `32px ${font}`;
    return ctx.measureText(sample).width;
  };
  const ok = ['monospace', 'serif', 'sans-serif'].some((base) => width(`"${name}", ${base}`) !== width(base));
  cache.set(name, ok);
  return ok;
}

/** 取 font-family 列表里的第一个字体名 */
export function firstFamily(value: string): string {
  return (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

/**
 * 字体下拉框：列出常见字体（用字体本身预览，标出本机是否安装），也可以输入列表里没有的字体名。
 * 保存时在选中的字体后面补上回退字体，保证中文和缺字时能正常显示。
 */
export function FontSelect({
  value,
  fonts,
  fallback,
  onChange,
  systemOption,
  testId,
}: {
  value: string;
  fonts: string[];
  fallback: string;
  onChange(v: string): void;
  /** 有「跟随系统」选项（值为空字符串） */
  systemOption?: boolean;
  testId?: string;
}): React.JSX.Element {
  const [search, setSearch] = useState('');
  const current = value ? firstFamily(value) : '';
  const options = useMemo(() => {
    const names = [...fonts];
    if (current && !names.includes(current)) names.unshift(current);
    const typed = search.trim().replace(/["';{}<>]/g, '');
    if (typed && !names.some((n) => n.toLowerCase() === typed.toLowerCase())) names.unshift(typed);
    const list = names.map((n) => {
      const installed = fontInstalled(n);
      return {
        value: n,
        installed,
        label: (
          <span className="font-option">
            <span style={{ fontFamily: `"${n}", ${fallback}` }}>{n}</span>
            {n === typed && !fonts.includes(n) ? <Tag bordered={false}>自定义</Tag> : !installed && <span className="font-missing">未安装</span>}
          </span>
        ),
      };
    });
    // 已安装的排在前面
    list.sort((a, b) => Number(b.installed) - Number(a.installed));
    return [...(systemOption ? [{ value: '', installed: true, label: <span className="font-option">跟随系统</span> }] : []), ...list];
  }, [fonts, current, search, fallback, systemOption]);

  return (
    <Select
      showSearch
      value={current}
      onSearch={setSearch}
      onChange={(name: string) => {
        setSearch('');
        onChange(name ? `"${name}", ${fallback}` : '');
      }}
      filterOption={(input, opt) => !input || String(opt?.value ?? '').toLowerCase().includes(input.toLowerCase())}
      options={options}
      optionLabelProp="value"
      labelRender={({ value: v }) => <span style={{ fontFamily: v ? `"${String(v)}", ${fallback}` : undefined }}>{v ? String(v) : '跟随系统'}</span>}
      placeholder="选择或输入字体名"
      style={{ width: 280 }}
      popupMatchSelectWidth={320}
      data-testid={testId}
    />
  );
}
