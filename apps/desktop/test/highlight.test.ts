import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGHLIGHT, HIGHLIGHT_PRESETS, checkHighlightPattern, type HighlightSettings } from '@itm/protocol';
import { compileHighlight, Highlighter } from '../src/renderer/src/util/highlight';

const ESC = '\x1b';
const make = (h: Partial<HighlightSettings> = {}): Highlighter => {
  const hl = new Highlighter();
  hl.configure(compileHighlight({ ...DEFAULT_HIGHLIGHT, ...h }));
  return hl;
};
/** 去掉高亮加上的颜色，应该和原文一模一样 */
const strip = (s: string): string => s.replace(/\x1b\[38;2;\d+;\d+;\d+m|\x1b\[39m/g, '');
/** 被某个颜色包住的文字 */
const colored = (s: string): string[] => [...s.matchAll(/\x1b\[38;2;\d+;\d+;\d+m(.*?)\x1b\[39m/g)].map((m) => m[1]);

describe('终端输出高亮', () => {
  it('预设规则：IP、URL、日期、时间、错误级别、UUID、路径、容量、MAC；不改变文字本身', () => {
    const hl = make();
    const input =
      'ERROR 2026-10-15 09:30:12 connect 10.10.0.91:22 failed, see https://example.com/doc?id=1 ' +
      'id=3f2b8c1e-9d4a-4b7e-8f00-1a2b3c4d5e6f file /var/log/app.log size 512MB mac aa:bb:cc:dd:ee:ff warning ok\r\n';
    const out = hl.process(input);
    expect(strip(out)).toBe(input);
    const hits = colored(out);
    expect(hits).toEqual(
      expect.arrayContaining(['ERROR', '2026-10-15 09:30:12', '10.10.0.91:22', 'failed', 'https://example.com/doc?id=1', '3f2b8c1e-9d4a-4b7e-8f00-1a2b3c4d5e6f', '/var/log/app.log', '512MB', 'aa:bb:cc:dd:ee:ff', 'warning', 'ok']),
    );
    // 重叠时优先级高的占位置：URL 里的路径不再单独着色
    expect(hits).not.toContain('/doc');
  });

  it('程序自己上色的文字、备用屏幕（vim / top）里不处理', () => {
    const hl = make();
    const lsColor = `${ESC}[01;34mfailed-dir${ESC}[0m error\r\n`;
    const out = hl.process(lsColor);
    expect(colored(out)).toEqual(['error']);
    expect(out.startsWith(`${ESC}[01;34mfailed-dir${ESC}[0m`)).toBe(true);
    // 进入备用屏幕后不处理，退出后恢复
    expect(hl.process(`${ESC}[?1049h error 10.0.0.1`)).toBe(`${ESC}[?1049h error 10.0.0.1`);
    expect(colored(hl.process(`${ESC}[?1049l error`))).toEqual(['error']);
  });

  it('转义序列拆在两个数据块里也能正确解析', () => {
    const hl = make();
    const a = hl.process(`warning ${ESC}[3`);
    const b = hl.process(`1mred-text failed${ESC}[0m then error`);
    expect(colored(a)).toEqual(['warning']);
    // 第二块开头是 SGR 31（红色）的剩余部分：之后的 failed 是程序上的色，不再处理；SGR 0 之后的 error 照常着色
    expect(colored(b)).toEqual(['error']);
    expect(strip(a + b)).toBe(`warning ${ESC}[31mred-text failed${ESC}[0m then error`);
    // OSC（窗口标题）里的文字不处理
    const t = hl.process(`${ESC}]0;error 10.0.0.1${ESC}\\ ok`);
    expect(t.startsWith(`${ESC}]0;error 10.0.0.1${ESC}\\`)).toBe(true);
    expect(colored(t)).toEqual(['ok']);
  });

  it('总开关、单个预设开关、自定义规则（优先于预设）和彩虹括号', () => {
    expect(make({ enabled: false }).process('error 10.0.0.1')).toBe('error 10.0.0.1');
    expect(colored(make({ presets: { error: false } }).process('error warning'))).toEqual(['warning']);
    // 数字默认关闭
    expect(colored(make().process('count 42'))).toEqual([]);
    const custom = make({ custom: [{ id: 'c1', name: '订单号', pattern: 'ORD-\\d+', color: '#ff0000', ignoreCase: false, enabled: true }] });
    const out = custom.process('order ORD-1234 failed');
    expect(colored(out)).toEqual(['ORD-1234', 'failed']);
    expect(out).toContain(`${ESC}[38;2;255;0;0mORD-1234`);
    const rb = make({ enabled: true, presets: Object.fromEntries(HIGHLIGHT_PRESETS.map((p) => [p.id, false])), rainbow: true });
    expect(colored(rb.process('f(a[b{c}])'))).toEqual(['(', '[', '{', '}', ']', ')']);
  });

  it('自定义正则的校验：不能为空、不能匹配空字符串、语法错误给出原因', () => {
    expect(checkHighlightPattern('')).toBe('请填写正则表达式');
    expect(checkHighlightPattern('a*')).toBe('这个正则会匹配空字符串，请修改');
    expect(checkHighlightPattern('(abc')).toMatch(/^正则表达式不正确/);
    expect(checkHighlightPattern('ORD-\\d+')).toBeNull();
    // 所有预设规则都能编译，且不会匹配空字符串
    for (const p of HIGHLIGHT_PRESETS) expect(checkHighlightPattern(p.pattern, p.flags === 'i'), p.id).toBeNull();
  });
});
