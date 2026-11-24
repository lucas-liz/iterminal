import { SYSTEM_PROMPT } from './prompt';
import { TOOLS, WEB_TOOLS } from './tools';

/**
 * 系统提示词泄露兜底（第三十二轮）：提示词里已经要求模型不透露内部配置，这里再兜一层——
 * 回答或思考里大段照抄系统提示词、工具说明时，界面和导出里换成固定说明。换了说法的转述查不出来，只能靠提示词约束。
 */
const GRAM = 16;
/** 照抄的字数（只算文字和数字）达到这个数就算泄露：大约两三句原文 */
const LEAK_CHARS = 100;

export const LEAK_REPLY = '这部分是 iTerminal 的内部配置，不便透露。有具体的运维问题可以直接告诉我，比如排查某台主机的磁盘、服务或日志。';
export const LEAK_THINKING = '（思考内容涉及内部配置，已隐藏）';

let grams: Set<string> | null = null;

/** 只留文字和数字：换行、Markdown 符号、标点和大小写的差别都不影响判断 */
function normalize(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();
}

/** 工具定义里的说明文字（工具本身和各参数的 description） */
function descriptions(v: unknown, out: string[]): string[] {
  if (Array.isArray(v)) for (const x of v) descriptions(x, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string') {
        if (k === 'description') out.push(x);
      } else descriptions(x, out);
    }
  }
  return out;
}

function buildGrams(): Set<string> {
  const set = new Set<string>();
  for (const src of [SYSTEM_PROMPT, ...descriptions([...TOOLS, ...WEB_TOOLS], [])]) {
    const s = normalize(src);
    for (let i = 0; i + GRAM <= s.length; i++) set.add(s.slice(i, i + GRAM));
  }
  return set;
}

/** 文本里是否大段照抄了系统提示词或工具说明 */
export function leaksPrompt(text: string): boolean {
  const s = normalize(text);
  if (s.length < LEAK_CHARS) return false;
  const set = (grams ??= buildGrams());
  let covered = 0;
  let end = 0;
  for (let i = 0; i + GRAM <= s.length; i++) {
    if (!set.has(s.slice(i, i + GRAM))) continue;
    covered += i + GRAM - Math.max(i, end);
    end = i + GRAM;
    if (covered >= LEAK_CHARS) return true;
  }
  return false;
}
