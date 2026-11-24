/**
 * 回答里的代码块能不能在终端运行、运行哪几行（第十五轮）。纯函数，单元测试见 test/round15.test.ts。
 */
/** 可以在终端里运行的代码块：shell 类的语言；没写语言的短代码块（10 行以内）也当成命令 */
const SHELL_LANGS = new Set(['sh', 'bash', 'shell', 'zsh', 'fish', 'console', 'shell-session', 'shellsession', 'powershell', 'ps1', 'pwsh', 'cmd', 'bat']);
const MAX_UNTAGGED_LINES = 10;

/** console 风格（带提示符）的代码块只取命令行：去掉开头的 $ / # 提示符，丢掉输出行 */
export function commandOf(code: string, lang: string): string {
  const text = code.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (lang !== 'console' && lang !== 'shell-session' && lang !== 'shellsession' && !/^\s*\$ /.test(text)) return text;
  const cmds = text
    .split('\n')
    .filter((l) => /^\s*[$#] /.test(l))
    .map((l) => l.replace(/^\s*[$#] /, ''));
  return cmds.length ? cmds.join('\n') : text;
}

export function runnable(code: string, lang: string): boolean {
  if (SHELL_LANGS.has(lang)) return true;
  if (lang) return false;
  const lines = code.replace(/\n+$/, '').split('\n');
  return lines.length > 0 && lines.length <= MAX_UNTAGGED_LINES && !!lines[0].trim();
}
