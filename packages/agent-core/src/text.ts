/** 去掉 ANSI 转义序列，处理回车覆盖（进度条），得到适合放进上下文的纯文本 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g, '')
    .split('\n')
    .map((line) => {
      const t = line.replace(/\r+$/, '');
      const i = t.lastIndexOf('\r');
      return i >= 0 ? t.slice(i + 1) : t;
    })
    .join('\n');
}

/**
 * token 估算：中日韩字符约 1 个 token / 字，其余约 3.5 个字符 / token。
 * 只用于占用展示和自动压缩判断；收到接口返回的真实用量后会按比例校准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 3.5);
}

/** 保留最后 maxLines 行 */
export function tailLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  return lines.length <= maxLines ? text : lines.slice(-maxLines).join('\n');
}

/** 截断到 maxChars，保留头尾，中间注明省略 */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.3);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n…（中间省略 ${text.length - maxChars} 个字符）…\n${text.slice(-tail)}`;
}
