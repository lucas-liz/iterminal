import { Language, Parser, type Node } from 'web-tree-sitter';

/** 一条简单命令：argv[0] 是命令名（已去掉引号），raw 是原文 */
export interface SimpleCommand {
  argv: string[];
  raw: string;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** 写入文件的重定向（> >> &> 等），目标已去掉引号 */
  writes: { op: string; target: string }[];
  /** 输入重定向读的文件（< 文件），目标已去掉引号 */
  inputs: string[];
  /** 包含 $(...) / `...` / <(...) */
  substitution: boolean;
  /** 定义了递归调用自身的函数（:(){ :|:& };: 这类 fork 炸弹） */
  forkBomb: boolean;
  /** 没能完整解析 */
  parseError: boolean;
}

export interface ShellParser {
  readonly kind: 'tree-sitter' | 'fallback';
  parse(command: string): ParsedShell;
}

/** 不算写文件的重定向目标 */
const HARMLESS_TARGETS = /^(\/dev\/(null|stdout|stderr|tty)|\/dev\/fd\/\d+|&?\d|-)$/;
const WRITE_OPS = new Set(['>', '>>', '&>', '&>>', '>|', '>&']);

function unquote(node: Node): string {
  switch (node.type) {
    case 'raw_string':
      return node.text.replace(/^'|'$/g, '');
    case 'ansi_c_string':
      return node.text.replace(/^\$'|'$/g, '');
    case 'string':
      return node.text.replace(/^"|"$/g, '');
    case 'concatenation':
      return node.namedChildren.filter((c): c is Node => !!c).map(unquote).join('');
    case 'word':
      return node.text.replace(/\\(.)/g, '$1');
    default:
      return node.text;
  }
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const c of node.namedChildren) if (c) walk(c, visit);
}

/**
 * tree-sitter-bash（WASM）解析器：按 | && || ; $() `...` 拆成简单命令（包括 if / for / 函数体 / 命令替换里的命令）。
 * 解析失败时 parseError = true，调用方至少按 L1 处理（文档一 7.5）。
 */
export async function createTreeSitterParser(opts: { bashWasm: string; treeSitterWasm?: string }): Promise<ShellParser> {
  await Parser.init(opts.treeSitterWasm ? { locateFile: () => opts.treeSitterWasm! } : undefined);
  const language = await Language.load(opts.bashWasm);
  const parser = new Parser();
  parser.setLanguage(language);
  return {
    kind: 'tree-sitter',
    parse(command: string): ParsedShell {
      const tree = parser.parse(command);
      if (!tree) return fallbackParser.parse(command);
      try {
        const root = tree.rootNode;
        const result: ParsedShell = { commands: [], writes: [], inputs: [], substitution: false, forkBomb: false, parseError: root.hasError };
        const functions = new Map<string, Node>();
        walk(root, (n) => {
          switch (n.type) {
            case 'command': {
              const name = n.childForFieldName('name');
              if (!name) return;
              const argv = [unquote(name.namedChildren[0] ?? name), ...n.childrenForFieldName('argument').filter((a): a is Node => !!a).map(unquote)];
              result.commands.push({ argv, raw: n.text });
              return;
            }
            case 'declaration_command':
            case 'unset_command': {
              const words = n.children.filter((c): c is Node => !!c).map((c) => (c.isNamed ? unquote(c) : c.text));
              result.commands.push({ argv: words, raw: n.text });
              return;
            }
            case 'test_command':
              result.commands.push({ argv: ['test'], raw: n.text });
              return;
            case 'command_substitution':
            case 'process_substitution':
              result.substitution = true;
              return;
            case 'file_redirect': {
              const op = n.children.find((c) => c && !c.isNamed)?.text ?? '';
              const dest = n.childForFieldName('destination');
              const target = dest ? unquote(dest) : '';
              if (WRITE_OPS.has(op) && !HARMLESS_TARGETS.test(target)) result.writes.push({ op, target });
              else if (op === '<' && target && !HARMLESS_TARGETS.test(target)) result.inputs.push(target);
              return;
            }
            case 'function_definition': {
              const fname = n.childForFieldName('name')?.text;
              if (fname) functions.set(fname, n);
              return;
            }
          }
        });
        for (const [fname, fn] of functions) {
          let recursive = false;
          walk(fn.childForFieldName('body') ?? fn, (n) => {
            if (n.type === 'command' && n.childForFieldName('name')?.text === fname) recursive = true;
          });
          if (recursive && result.commands.some((c) => c.argv[0] === fname)) result.forkBomb = true;
        }
        return result;
      } finally {
        tree.delete();
      }
    },
  };
}

// ---------------------------------------------------------------- 没有 tree-sitter 时的简化解析

/** 按不在引号内的 ; && || | & 换行拆分 */
export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += c + cmd[++i];
    } else if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && cmd[i + 1] === '>') {
        cur += c;
        continue;
      }
      if (c === '&' && /\d?>$/.test(cur)) {
        cur += c;
        continue;
      }
      if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) i++;
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** 按空白分词，处理单双引号和反斜杠 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

/** 引号是否闭合、引号外的括号是否配对 */
function balanced(s: string): boolean {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i++;
      continue;
    }
    if (c === '\\') i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '{') depth++;
    else if (c === ')' || c === '}') depth--;
    if (depth < 0) return false;
  }
  return !quote && depth === 0;
}

export const fallbackParser: ShellParser = {
  kind: 'fallback',
  parse(command: string): ParsedShell {
    const result: ParsedShell = { commands: [], writes: [], inputs: [], substitution: /\$\(|`|<\(|>\(/.test(command), forkBomb: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(command), parseError: false };
    for (const seg of splitCommand(command)) {
      // 去掉重定向部分，单独记录写入目标
      const redirect = /(\d?&?>>?|>\|)\s*("[^"]*"|'[^']*'|\S+)/g;
      let m: RegExpExecArray | null;
      while ((m = redirect.exec(seg))) {
        const target = m[2].replace(/^["']|["']$/g, '');
        const op = m[1].replace(/^\d/, '');
        if (op === '>&' && /^\d$/.test(target)) continue;
        if (!HARMLESS_TARGETS.test(target)) result.writes.push({ op, target });
      }
      // 输入重定向：< 文件（<( 是进程替换，不算）
      const input = /(?<![0-9<>])<(?![<(])\s*("[^"]*"|'[^']*'|\S+)/g;
      while ((m = input.exec(seg))) {
        const target = m[1].replace(/^["']|["']$/g, '');
        if (!HARMLESS_TARGETS.test(target)) result.inputs.push(target);
      }
      const argv = tokenize(seg.replace(/(\d?&?>>?|>\|)\s*("[^"]*"|'[^']*'|\S+)/g, ' ').replace(/\d?>&\d/g, ' ').replace(/(?<![0-9<>])<(?![<(])\s*("[^"]*"|'[^']*'|\S+)/g, ' '));
      if (argv.length > 0) result.commands.push({ argv, raw: seg });
    }
    if (!balanced(command)) result.parseError = true;
    return result;
  },
};
