import { HIGHLIGHT_PRESETS, RAINBOW_COLORS, type HighlightSettings } from '@itm/protocol';

interface CompiledRule {
  re: RegExp;
  /** `\x1b[38;2;r;g;bm` */
  sgr: string;
  priority: number;
}

const sgrOf = (hex: string): string => {
  const n = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`;
};
const RESET_FG = '\x1b[39m';
const RAINBOW = RAINBOW_COLORS.map(sgrOf);
/** 一段文字超过这个长度就不做高亮（大量输出时保证流畅） */
const MAX_RUN = 256 * 1024;

/** 把设置编译成规则（无效的自定义正则直接跳过） */
export interface CompiledHighlight {
  rules: CompiledRule[];
  rainbow: boolean;
  skipAlt: boolean;
  maxRun: number;
}

export function compileHighlight(h: HighlightSettings): CompiledHighlight {
  const skipAlt = h.skipAltScreen ?? true;
  const maxRun = h.maxRun ?? MAX_RUN;
  if (!h.enabled) return { rules: [], rainbow: false, skipAlt, maxRun };
  const rules: CompiledRule[] = [];
  for (const p of HIGHLIGHT_PRESETS) {
    if (!(h.presets[p.id] ?? p.defaultOn)) continue;
    rules.push({ re: new RegExp(p.pattern, `g${p.flags ?? ''}`), sgr: sgrOf(p.color), priority: p.priority });
  }
  // 自定义规则排在所有预设规则前面（用户自己加的更重要）
  h.custom.forEach((r, i) => {
    if (!r.enabled) return;
    try {
      rules.push({ re: new RegExp(r.pattern, r.ignoreCase ? 'gi' : 'g'), sgr: sgrOf(r.color), priority: -100 + i });
    } catch {
      // 跳过无效的正则
    }
  });
  rules.sort((a, b) => a.priority - b.priority);
  return { rules, rainbow: h.rainbow, skipAlt, maxRun };
}

type State = 'text' | 'esc' | 'escInter' | 'csi' | 'osc' | 'oscEsc' | 'str' | 'strEsc';

/**
 * 终端输出高亮：在数据写进 xterm 之前，给普通文字里匹配的内容加上前景色。
 * - 程序自己设置了前景色的文字（ls --color、git diff 等）不动；
 * - 备用屏幕（vim、top、less、htop）里不处理；
 * - 转义序列跨数据块时保持解析状态，不会把序列拆坏；
 * - 一个词恰好被拆在两个数据块里时可能不上色（不为此延迟输出）。
 */
export class Highlighter {
  private rules: CompiledRule[] = [];
  private rainbow = false;
  private skipAlt = true;
  private maxRun = MAX_RUN;
  private state: State = 'text';
  private csi = '';
  private alt = false;
  /** 程序设置了前景色 */
  private colored = false;
  /** 彩虹括号的嵌套层级（换行时清零） */
  private depth = 0;

  configure(c: CompiledHighlight): void {
    this.rules = c.rules;
    this.rainbow = c.rainbow;
    this.skipAlt = c.skipAlt;
    this.maxRun = c.maxRun;
  }

  get active(): boolean {
    return this.rules.length > 0 || this.rainbow;
  }

  process(data: string): string {
    if (!this.active) {
      // 不高亮时也要跟踪状态（之后打开高亮时状态是对的）
      this.scan(data, null);
      return data;
    }
    const out: string[] = [];
    this.scan(data, out);
    return out.join('');
  }

  /** 解析一块数据：普通文字交给 colorize，转义序列原样输出并更新状态；out 为 null 时只更新状态 */
  private scan(data: string, out: string[] | null): void {
    let i = 0;
    while (i < data.length) {
      if (this.state !== 'text') {
        // 上一块里没结束的转义序列
        const j = this.consumeSeq(data, i);
        out?.push(data.slice(i, j));
        i = j;
        continue;
      }
      const esc = data.indexOf('\x1b', i);
      const end = esc < 0 ? data.length : esc;
      if (end > i) {
        const text = data.slice(i, end);
        if (out) out.push(this.colorize(text));
        else if (this.rainbow) this.trackDepth(text);
      }
      if (esc < 0) break;
      this.state = 'esc';
      const j = this.consumeSeq(data, esc + 1);
      out?.push(data.slice(esc, j));
      i = j;
    }
  }

  /** 从 i 开始继续解析转义序列，返回序列结束后的位置（没结束时返回数据末尾，状态留到下一块） */
  private consumeSeq(data: string, i: number): number {
    for (; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      switch (this.state) {
        case 'esc':
          if (ch === 0x5b) {
            this.state = 'csi';
            this.csi = '';
          } else if (ch === 0x5d) this.state = 'osc';
          else if (ch === 0x50 || ch === 0x58 || ch === 0x5e || ch === 0x5f) this.state = 'str'; // DCS / SOS / PM / APC
          else if (ch >= 0x20 && ch <= 0x2f) this.state = 'escInter';
          else return this.endSeq(i);
          break;
        case 'escInter':
          if (ch >= 0x30 && ch <= 0x7e) return this.endSeq(i);
          break;
        case 'csi':
          if (ch >= 0x40 && ch <= 0x7e) {
            this.onCsi(this.csi, String.fromCharCode(ch));
            return this.endSeq(i);
          }
          this.csi += data[i];
          break;
        case 'osc':
          if (ch === 0x07) return this.endSeq(i);
          if (ch === 0x1b) this.state = 'oscEsc';
          break;
        case 'oscEsc':
          if (ch === 0x5c) return this.endSeq(i);
          this.state = 'osc';
          break;
        case 'str':
          if (ch === 0x1b) this.state = 'strEsc';
          break;
        case 'strEsc':
          if (ch === 0x5c) return this.endSeq(i);
          this.state = 'str';
          break;
        default:
          return i;
      }
    }
    return data.length;
  }

  private endSeq(i: number): number {
    this.state = 'text';
    return i + 1;
  }

  private onCsi(params: string, final: string): void {
    if (final === 'm') {
      const p = params === '' ? ['0'] : params.split(/[;:]/);
      for (let k = 0; k < p.length; k++) {
        const n = Number(p[k] || '0');
        if (n === 0 || n === 39) this.colored = false;
        else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) this.colored = true;
        else if (n === 38) {
          this.colored = true;
          k += p[k + 1] === '5' ? 2 : 4;
        } else if (n === 48 || n === 58) k += p[k + 1] === '5' ? 2 : 4;
      }
    } else if ((final === 'h' || final === 'l') && params.startsWith('?')) {
      const modes = params.slice(1).split(';');
      if (modes.some((m) => m === '1049' || m === '47' || m === '1047')) this.alt = final === 'h';
    }
  }

  private colorize(text: string): string {
    if ((this.alt && this.skipAlt) || this.colored || text.length > this.maxRun) {
      if (this.rainbow) this.trackDepth(text);
      return text;
    }
    const taken = new Uint8Array(text.length);
    const marks: { start: number; end: number; sgr: string }[] = [];
    for (const r of this.rules) {
      r.re.lastIndex = 0;
      for (let m = r.re.exec(text); m; m = r.re.exec(text)) {
        if (m[0] === '') {
          r.re.lastIndex++;
          continue;
        }
        const start = m.index;
        const end = start + m[0].length;
        let free = true;
        for (let k = start; k < end; k++) {
          if (taken[k]) {
            free = false;
            break;
          }
        }
        if (!free) continue;
        taken.fill(1, start, end);
        marks.push({ start, end, sgr: r.sgr });
      }
    }
    if (!marks.length && !this.rainbow) return text;
    marks.sort((a, b) => a.start - b.start);
    const out: string[] = [];
    let pos = 0;
    const plain = (s: string): void => {
      if (!this.rainbow) {
        out.push(s);
        return;
      }
      for (const c of s) {
        if (c === '\n') this.depth = 0;
        if (c === '(' || c === '[' || c === '{') {
          out.push(RAINBOW[this.depth % RAINBOW.length], c, RESET_FG);
          this.depth++;
        } else if (c === ')' || c === ']' || c === '}') {
          this.depth = Math.max(0, this.depth - 1);
          out.push(RAINBOW[this.depth % RAINBOW.length], c, RESET_FG);
        } else out.push(c);
      }
    };
    for (const mk of marks) {
      if (mk.start > pos) plain(text.slice(pos, mk.start));
      out.push(mk.sgr, text.slice(mk.start, mk.end), RESET_FG);
      pos = mk.end;
    }
    if (pos < text.length) plain(text.slice(pos));
    return out.join('');
  }

  private trackDepth(text: string): void {
    for (const c of text) {
      if (c === '\n') this.depth = 0;
      else if (c === '(' || c === '[' || c === '{') this.depth++;
      else if (c === ')' || c === ']' || c === '}') this.depth = Math.max(0, this.depth - 1);
    }
  }
}
