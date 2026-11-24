import defaultRulesJson from './default-rules.json';
import type { ParsedShell, ShellParser } from './parse';
import type { Classification, CommandRule, Level, RuleLevel, SegmentResult } from './types';

export const DEFAULT_RULES = defaultRulesJson as CommandRule[];

const RANK: Record<RuleLevel, number> = { L0: 0, L1: 1, L2: 2, DENY: 3 };
export const maxLevel = (a: RuleLevel, b: RuleLevel): RuleLevel => (RANK[a] >= RANK[b] ? a : b);
export const rankOf = (l: RuleLevel): number => RANK[l];

interface CompiledRule {
  rule: CommandRule;
  test: (text: string) => boolean;
}

/** 服务端规则是 Java 正则：开头的 (?i) 转成 JS 的 i 标志；编译失败的规则跳过 */
export function compileRules(rules: CommandRule[]): CompiledRule[] {
  const out: CompiledRule[] = [];
  for (const rule of [...rules].filter((r) => r.enabled !== false).sort((a, b) => a.priority - b.priority)) {
    if (rule.matchType === 'EXACT') out.push({ rule, test: (t) => t === rule.pattern.trim() });
    else if (rule.matchType === 'PREFIX') out.push({ rule, test: (t) => t.startsWith(rule.pattern) });
    else {
      let src = rule.pattern;
      let flags = '';
      if (src.startsWith('(?i)')) {
        src = src.slice(4);
        flags = 'i';
      }
      try {
        const re = new RegExp(src, flags);
        out.push({ rule, test: (t) => re.test(t) });
      } catch {
        // 不兼容的正则：忽略这条规则（服务端保存时已经校验过 Java 语法）
      }
    }
  }
  return out;
}

/** 选项后面跟一个值的包装命令选项 */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']),
  doas: new Set(['-u', '-C']),
  nice: new Set(['-n']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
  stdbuf: new Set(['-i', '-o', '-e']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  env: new Set(['-u', '-C', '--unset', '--chdir']),
  xargs: new Set(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-E', '-e', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']),
  watch: new Set(['-n', '--interval', '-d']),
  chronic: new Set(),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  setsid: new Set(),
  unbuffer: new Set(),
  flock: new Set(['-w', '-E', '--timeout']),
};

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
/**
 * 会把数据发到外部的命令（第三十二轮）：配合命令替换或输入重定向时，等于把本机 / 服务器上的内容发出去，
 * 按写操作处理（要审批）。单纯的 curl / ping 照常是只读；管道的情况由「复杂命令」交给 AI 复核。
 */
const NET_CMDS = new Set(['curl', 'wget', 'telnet', 'nc', 'ncat', 'netcat', 'openssl', 'dig', 'nslookup', 'host', 'ping', 'ping6', 'traceroute', 'tracepath', 'mtr', 'arping', 'iperf', 'iperf3', 'ftp', 'sftp', 'scp', 'rsync', 'socat']);
const SSH_VALUE_OPTS = new Set(['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I']);

/** 去掉 sudo、nohup、timeout 这类包装，返回真正执行的 argv */
export function unwrap(argv: string[]): { argv: string[]; sudo: boolean; wrappers: string[] } {
  let rest = [...argv];
  let sudo = false;
  const wrappers: string[] = [];
  // 前置的环境变量赋值 FOO=bar cmd
  while (rest.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
  for (let guard = 0; guard < 10 && rest.length > 0; guard++) {
    const name = rest[0].replace(/^.*\//, '');
    // command -v / -V 是查找命令（相当于 which），不是执行
    if (name === 'command' && /^-[vV]$/.test(rest[1] ?? '')) return { argv: ['which', ...rest.slice(2)], sudo, wrappers };
    const valueOpts = WRAPPER_VALUE_OPTS[name];
    if (!valueOpts) break;
    wrappers.push(name);
    if (name === 'sudo' || name === 'doas') sudo = true;
    let i = 1;
    while (i < rest.length) {
      const a = rest[i];
      if (a === '--') {
        i++;
        break;
      }
      if (name === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        i++;
        continue;
      }
      if (name === 'nice' && /^-\d+$/.test(a)) {
        i++;
        continue;
      }
      if (!a.startsWith('-') || a === '-') break;
      i += valueOpts.has(a) ? 2 : 1;
    }
    // timeout 的第一个非选项参数是时长
    if (name === 'timeout' && i < rest.length) i++;
    // 包装后面没有命令（单独的 env、sudo -i、time）：按包装命令本身判定
    if (i >= rest.length) break;
    rest = rest.slice(i);
    while (rest.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0])) rest = rest.slice(1);
  }
  return { argv: rest, sudo, wrappers };
}

function hasOpt(args: string[], re: RegExp): boolean {
  return args.some((a) => re.test(a));
}

/** 第一个不是选项的参数（选项的值用 valueOpts 跳过） */
function firstOperand(args: string[], valueOpts: RegExp): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args[i + 1] ?? null;
    if (!a.startsWith('-') || a === '-') return a;
    if (valueOpts.test(a) && !a.includes('=')) i++;
  }
  return null;
}

/** 不是选项的参数（文件名、子命令） */
function operands(args: string[], valueOpts: RegExp): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return [...out, ...args.slice(i + 1)];
    if (!a.startsWith('-') || a === '-') out.push(a);
    else if (valueOpts.test(a) && !a.includes('=')) i++;
  }
  return out;
}

/**
 * sed 脚本里只读的命令：打印、删除、保持空间、分支、追加文本、读文件。
 * 故意不包含 w / W（写文件）、e（执行命令）、v，不认识的字母一律当成写操作。
 */
const SED_SAFE_CMDS = new Set([...'pdqQnNPDhHgGxzlL=F{}!,aicrRbtT:']);
/** 后面跟文本或标签、要跳到行尾的 sed 命令 */
const SED_TEXT_CMDS = new Set([...'aicrRbtT:']);

/**
 * 逐字符扫描 sed 脚本：跳过地址、正则和替换文本，检查每个命令字母是不是只读的。
 * 返回 false 表示脚本会写文件或执行命令（也包括解析不了的情况）。
 */
export function sedScriptSafe(script: string): boolean {
  let i = 0;
  const n = script.length;
  /** 从当前位置扫到下一个没有转义的 delim（含），没找到返回 false */
  const skipTo = (delim: string): boolean => {
    while (i < n) {
      if (script[i] === '\\') {
        i += 2;
        continue;
      }
      if (script[i] === delim) {
        i++;
        return true;
      }
      i++;
    }
    return false;
  };
  while (i < n) {
    const c = script[i];
    if (/[\s;{}!]/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && script[i] !== '\n') i++;
      continue;
    }
    // 地址：行号、$、步长、范围
    if (/[0-9$,~+]/.test(c)) {
      i++;
      continue;
    }
    // 地址正则 /re/ 或 \cREc
    if (c === '/' || c === '\\') {
      const delim = c === '/' ? '/' : script[i + 1];
      if (!delim) return false;
      i += c === '/' ? 1 : 2;
      if (!skipTo(delim)) return false;
      while (i < n && /[IM]/.test(script[i])) i++;
      continue;
    }
    // s/…/…/标志、y/…/…/
    if (c === 's' || c === 'y') {
      const delim = script[i + 1];
      if (!delim || /[\s\\\n]/.test(delim)) return false;
      i += 2;
      if (!skipTo(delim) || !skipTo(delim)) return false;
      while (i < n && /[a-zA-Z0-9]/.test(script[i])) {
        // w = 把结果写进文件，e = 把结果当命令执行
        if (c === 's' && (script[i] === 'w' || script[i] === 'e')) return false;
        i++;
      }
      continue;
    }
    if (!SED_SAFE_CMDS.has(c)) return false;
    i++;
    // a text / r file / b label：后面到行尾都是参数，不要当成命令字母
    if (SED_TEXT_CMDS.has(c)) while (i < n && script[i] !== '\n' && script[i] !== ';') i++;
  }
  return true;
}

/** sed 的脚本（-e / --expression / 第一个非选项参数）；fromFile 表示脚本来自 -f 文件，看不到内容 */
export function sedScripts(args: string[]): { scripts: string[]; fromFile: boolean } {
  const scripts: string[] = [];
  let fromFile = false;
  let explicit = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === '-e' || a === '--expression') {
      explicit = true;
      const v = args[++i];
      if (v === undefined) fromFile = true;
      else scripts.push(v);
      continue;
    }
    if (a.startsWith('--expression=')) {
      explicit = true;
      scripts.push(a.slice('--expression='.length));
      continue;
    }
    if (a === '-f' || a === '--file' || a.startsWith('--file=')) {
      explicit = true;
      fromFile = true;
      if (a === '-f' || a === '--file') i++;
      continue;
    }
    if (!a.startsWith('-') || a === '-') {
      rest.push(a);
      continue;
    }
    if (a.startsWith('--')) continue;
    // 合并的短选项：-ne '脚本'、-nf 文件、-e'脚本'
    const m = /^-[a-zA-Z]*?([ef])(.*)$/.exec(a);
    if (!m) continue;
    explicit = true;
    if (m[1] === 'f') {
      fromFile = true;
      if (!m[2]) i++;
      continue;
    }
    if (m[2]) scripts.push(m[2]);
    else {
      const v = args[++i];
      if (v === undefined) fromFile = true;
      else scripts.push(v);
    }
  }
  if (!explicit && rest.length > 0) scripts.push(rest[0]);
  return { scripts, fromFile };
}

/** redis-cli 只读子命令（其他一律当写操作） */
const REDIS_READONLY = new Set(['info', 'ping', 'dbsize', 'slowlog', 'client', 'config', 'memory', 'latency', 'lastsave', 'time', 'role', 'command', 'cluster', 'exists', 'ttl', 'type', 'get', 'mget', 'strlen', 'llen', 'lrange', 'scard', 'smembers', 'sismember', 'zcard', 'zrange', 'zscore', 'hget', 'hgetall', 'hkeys', 'hvals', 'hlen', 'keys', 'scan', 'hscan', 'sscan', 'zscan', 'randomkey', 'object', 'debug', 'echo', 'select']);
/** redis-cli 子命令里只读的二级子命令 */
const REDIS_SUB_READONLY: Record<string, Set<string>> = {
  config: new Set(['get']),
  client: new Set(['list', 'info', 'id', 'getname', 'no-evict']),
  slowlog: new Set(['get', 'len']),
  memory: new Set(['usage', 'stats', 'doctor']),
  cluster: new Set(['info', 'nodes', 'slots', 'shards', 'myid', 'countkeysinslot']),
  object: new Set(['encoding', 'refcount', 'idletime', 'freq', 'help']),
  debug: new Set(['jmap', 'object']),
};
/** mysqladmin 只读子命令 */
const MYSQLADMIN_READONLY = new Set(['status', 'processlist', 'variables', 'ping', 'version', 'extended-status', 'debug']);

/**
 * 白名单命令的「写」用法（规则判成 L0 之后再检查）：sed -i、find -exec、curl -o 等。返回原因，没有则返回 null。
 */
export function writeUsage(name: string, args: string[]): string | null {
  switch (name) {
    case 'sed': {
      if (hasOpt(args, /^(-[a-zA-Z]*i|--in-place)/)) return 'sed -i 会修改文件';
      // --sandbox 本身就禁用了 e / r / w
      if (hasOpt(args, /^--sandbox$/)) return null;
      const { scripts, fromFile } = sedScripts(args);
      if (fromFile) return 'sed 的脚本来自文件，看不到内容';
      const bad = scripts.find((s) => !sedScriptSafe(s));
      return bad === undefined ? null : 'sed 脚本里有写文件（w）或执行命令（e）的动作';
    }
    case 'sort':
      return hasOpt(args, /^(-o|--output)/) ? 'sort -o 会写文件' : null;
    case 'uniq':
      // uniq 的第二个文件参数是输出文件
      return operands(args, /^(-f|-s|-w|--skip-fields|--skip-chars|--check-chars|--group|--all-repeated)$/).length > 1 ? 'uniq 的第二个参数是输出文件' : null;
    case 'tree':
      return hasOpt(args, /^(-o|--output)/) ? 'tree -o 会写文件' : null;
    case 'base64':
    case 'numfmt':
    case 'fold':
      return hasOpt(args, /^(-o|--output)/) ? `${name} -o 会写文件` : null;
    case 'journalctl':
      return hasOpt(args, /^--(vacuum-(size|time|files)|rotate|flush|sync|relinquish-var|setup-keys|update-catalog)/) ? 'journalctl 会清理 / 轮转日志' : null;
    case 'yq':
      return hasOpt(args, /^(-i|--inplace|--in-place|-[a-zA-Z]*i)$/) ? 'yq -i 会修改文件' : null;
    case 'redis-cli': {
      const ops = operands(args, /^(-h|-p|-n|-a|-u|-s|--user|--pass|--cluster|-t|--timeout|--scan|--pattern|--rdb)$/);
      const sub = ops[0]?.toLowerCase();
      if (!sub) return null;
      if (!REDIS_READONLY.has(sub)) return `redis-cli ${sub} 不是只读命令`;
      const allowed = REDIS_SUB_READONLY[sub];
      if (allowed && ops[1] && !allowed.has(ops[1].toLowerCase())) return `redis-cli ${sub} ${ops[1]} 不是只读命令`;
      return null;
    }
    case 'mysqladmin': {
      // -p 的密码只能贴着写（-pPASS），裸 -p 不吃下一个参数
      const ops = operands(args, /^(-u|-h|-P|-S|-r|-i|--user|--host|--port|--socket|--sleep|--count)$/);
      const sub = ops.find((o) => !/^\d+$/.test(o))?.toLowerCase();
      if (!sub) return null;
      return MYSQLADMIN_READONLY.has(sub) ? null : `mysqladmin ${sub} 不是只读命令`;
    }
    case 'find':
      return hasOpt(args, /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/) ? 'find 带执行 / 删除 / 写文件的动作' : null;
    case 'awk':
    case 'gawk':
      return args.some((a) => /system\s*\(|\|\s*getline|print[f]?\s[^;]*>\s*\S|"\s*\|/.test(a)) ? 'awk 里执行命令或写文件' : null;
    case 'mount':
      return args.length > 0 && !args.every((a) => /^(-l|--list|-v)$/.test(a)) ? '挂载文件系统' : null;
    case 'sysctl':
      return args.some((a) => /^(-w|--write|-p|--load|--system)$/.test(a) || a.includes('=')) ? '修改内核参数' : null;
    case 'history':
      return hasOpt(args, /^-[a-zA-Z]*[cdwarns]/) ? '修改命令历史' : null;
    case 'curl': {
      if (hasOpt(args, /^(-[a-zA-Z]*[oOTFd]|--output|--remote-name|--upload-file|--form|--data.*|--json)$/)) return 'curl 写文件或提交数据';
      const x = args.findIndex((a) => a === '-X' || a === '--request' || /^-X./.test(a));
      if (x >= 0) {
        const method = (args[x].length > 2 && args[x].startsWith('-X') ? args[x].slice(2) : (args[x + 1] ?? '')).toUpperCase();
        if (method && method !== 'GET' && method !== 'HEAD') return `curl ${method} 请求`;
      }
      return null;
    }
    case 'wget':
      // 带请求体 = 往外发数据，不是下载
      if (hasOpt(args, /^--(post-data|post-file|body-data|body-file)(=|$)/)) return 'wget 提交数据';
      if (hasOpt(args, /^--method(=|$)/)) {
        const m = args.find((a) => a.startsWith('--method='))?.slice('--method='.length) ?? args[args.findIndex((a) => a === '--method') + 1] ?? '';
        if (m && !/^(GET|HEAD)$/i.test(m)) return `wget ${m.toUpperCase()} 请求`;
      }
      return args.some((a, i) => (a === '-O' && args[i + 1] === '-') || /^(-[a-zA-Z]*O-|--spider|--output-document=-)$/.test(a)) ? null : 'wget 下载文件';
    case 'date':
      return hasOpt(args, /^(-s|--set)/) ? '修改系统时间' : null;
    case 'hostname':
      return args.some((a) => !a.startsWith('-')) || hasOpt(args, /^(-F|--file|-b|--boot)$/) ? '修改主机名' : null;
    case 'timedatectl':
    case 'hostnamectl':
    case 'localectl':
      return args.some((a) => /^set-/.test(a)) ? '修改系统配置' : null;
    case 'git': {
      // git diff / show / log --output=文件
      if (hasOpt(args, /^(--output|-o)(=|$)/)) return 'git --output 会写文件';
      const ops = operands(args, /^(-C|-c|--git-dir|--work-tree|--namespace|--exec-path)$/);
      const sub = ops[0];
      if (sub === 'branch' && hasOpt(args, /^(-[a-zA-Z]*[dDmMf]|--delete|--move|--copy|--force|--edit-description|--set-upstream-to|-u)/)) return 'git branch 会删除 / 改名分支';
      // git tag 只有 -l / --list / -n 是只读的，其他都是新建或删除标签
      if (sub === 'tag' && (ops.length > 1 || hasOpt(args, /^(-[a-zA-Z]*[dDfas]|--delete|--force|--annotate|--sign)/))) return 'git tag 会新建 / 删除标签';
      return null;
    }
    case 'ifconfig':
      return args.length > 1 && !args.every((a) => a.startsWith('-')) ? '修改网卡配置' : null;
    case 'route':
      return args.some((a) => /^(add|del|delete|flush|change)$/.test(a)) ? '修改路由' : null;
    case 'arp':
      return hasOpt(args, /^(-s|-d|--set|--delete)$/) ? '修改 ARP 表' : null;
    case 'crontab':
      return args.some((a) => a !== '-l' && !a.startsWith('-u')) && !args.includes('-l') ? '修改定时任务' : null;
    case 'ulimit':
      return args.some((a) => /^\d+$|^unlimited$/.test(a)) ? '修改资源限制' : null;
    case 'cd':
    case 'echo':
    case 'printf':
    default:
      return null;
  }
}

export interface ClassifyOptions {
  rules: CompiledRule[];
  parser: ShellParser;
}

const MAX_DEPTH = 4;

function classifyArgv(argv0: string[], o: ClassifyOptions, depth: number): SegmentResult & { nested: boolean; unknown?: boolean } {
  const { argv, sudo, wrappers } = unwrap(argv0);
  const reasons: string[] = [];
  let level: RuleLevel = 'L0';
  let ruleId: number | string | undefined;
  let nested = false;
  const finish = (l: RuleLevel, text: string): SegmentResult & { nested: boolean } => {
    let lv = l;
    if (sudo && rankOf(lv) < 1) lv = 'L1';
    if (sudo) reasons.push('使用 sudo');
    return { text, level: lv, reasons: [...new Set(reasons)], ruleId, nested };
  };
  if (argv.length === 0) {
    reasons.push(sudo ? 'sudo 后面没有命令（交互式 root shell）' : '空命令');
    return finish('L1', argv0.join(' '));
  }
  const name = argv[0].replace(/^.*\//, '');
  const args = argv.slice(1);
  const text = [name, ...args].join(' ');

  if (name.startsWith('$') || name.includes('$(') || name.includes('`')) {
    reasons.push('命令名来自变量，无法判断');
    return finish('L1', text);
  }
  // sh -c '...'、eval、ssh host 'cmd'：继续解析里面的命令
  const nestedText =
    SHELLS.has(name) && args.includes('-c')
      ? args[args.indexOf('-c') + 1]
      : name === 'eval'
        ? args.join(' ')
        : name === 'busybox' && SHELLS.has(args[0] ?? '') && args.includes('-c')
          ? args[args.indexOf('-c') + 1]
          : undefined;
  if (nestedText !== undefined) {
    nested = true;
    if (depth >= MAX_DEPTH) {
      reasons.push('嵌套太深');
      return finish('L1', text);
    }
    const inner = classifyText(nestedText ?? '', o, depth + 1);
    reasons.push(name === 'eval' ? '通过 eval 执行' : `通过 ${name} -c 执行`, ...inner.reasons);
    ruleId = inner.matchedRules[0];
    return finish(inner.level, text);
  }
  if (name === 'ssh') {
    nested = true;
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += SSH_VALUE_OPTS.has(args[i]) ? 2 : 1;
    const remote = args.slice(i + 1);
    if (remote.length === 0) {
      reasons.push('打开交互式 ssh 会话');
      return finish('L1', text);
    }
    const inner = depth >= MAX_DEPTH ? { level: 'L1' as RuleLevel, reasons: ['嵌套太深'], matchedRules: [] } : classifyText(remote.join(' '), o, depth + 1);
    reasons.push(`通过 ssh 在 ${args[i]} 上执行`, ...inner.reasons);
    return finish(maxLevel(inner.level, 'L1'), text);
  }
  if (name === 'source' || name === '.') {
    reasons.push('执行脚本文件，无法判断脚本内容');
    return finish('L1', text);
  }
  if (name === 'tee') {
    if (args.filter((a) => !a.startsWith('-')).every((a) => /^\/dev\/(null|stdout|stderr)$/.test(a))) return finish('L0', text);
    reasons.push('写入文件（tee）');
    return finish('L1', text);
  }

  const hit = o.rules.find((r) => r.test(text));
  if (hit) {
    level = hit.rule.level;
    ruleId = hit.rule.id;
    if (hit.rule.note) reasons.push(hit.rule.note);
    if (level === 'L0') {
      const w = writeUsage(name, args);
      if (w) {
        level = 'L1';
        reasons.length = 0;
        reasons.push(w);
      }
    }
    // xargs 把前面的输出当成参数，配合 L0 命令仍然只读
    if (wrappers.includes('xargs') && level === 'L0') reasons.push('通过 xargs 执行');
    return finish(level, text);
  }
  reasons.push(`「${name}」不在只读命令白名单里`);
  return { ...finish('L1', text), unknown: true };
}

function classifyParsed(parsed: ParsedShell, o: ClassifyOptions, depth: number): Classification {
  const reasons: string[] = [];
  const matchedRules: (number | string)[] = [];
  const segments: SegmentResult[] = [];
  let level: RuleLevel = 'L0';
  let complex = parsed.commands.length > 1 || parsed.substitution;
  if (parsed.parseError) {
    level = maxLevel(level, 'L1');
    reasons.push('命令没能完整解析');
  }
  if (parsed.forkBomb) {
    level = 'L2';
    reasons.push('递归调用自身的函数（fork 炸弹）');
  }
  for (const w of parsed.writes) {
    if (/^\/dev\/(sd|nvme|vd|xvd|hd|mmcblk|disk|dm-|md)/.test(w.target)) {
      level = maxLevel(level, 'L2');
      reasons.push(`直接写磁盘设备 ${w.target}`);
    } else if (/^\/proc\/sysrq-trigger/.test(w.target)) {
      level = maxLevel(level, 'L2');
      reasons.push('触发内核 SysRq 操作');
    } else {
      level = maxLevel(level, 'L1');
      reasons.push(`写入文件（重定向到 ${w.target}）`);
    }
  }
  for (const c of parsed.commands) {
    const seg = classifyArgv(c.argv, o, depth);
    if (seg.nested) complex = true;
    segments.push({ text: seg.text, level: seg.level, reasons: seg.reasons, ruleId: seg.ruleId, ...(seg.unknown ? { unknown: true } : {}) });
    level = maxLevel(level, seg.level);
    if (seg.ruleId !== undefined) matchedRules.push(seg.ruleId);
    if (seg.level !== 'L0') reasons.push(...seg.reasons);
  }
  // 网络命令 + 命令替换 / 输入重定向：可能把内容发到外部
  if (level === 'L0' && (parsed.substitution || parsed.inputs.length > 0)) {
    const net = parsed.commands.map((c) => unwrap(c.argv).argv[0]?.replace(/^.*\//, '')).find((x) => x && NET_CMDS.has(x));
    if (net) {
      level = 'L1';
      reasons.push(`${net} 带${parsed.substitution ? '命令替换' : '输入重定向'}，可能把本机 / 服务器上的内容发到外部`);
    }
  }
  if (parsed.commands.length === 0 && !parsed.parseError && parsed.writes.length === 0) {
    level = maxLevel(level, 'L1');
    reasons.push('没有可执行的命令');
  }
  if (level === 'L0') reasons.push('只读命令');
  return { level, reasons: [...new Set(reasons)], matchedRules: [...new Set(matchedRules)], segments, complex, parseError: parsed.parseError };
}

export function classifyText(command: string, o: ClassifyOptions, depth = 0): Classification {
  const raw = command.trim();
  if (!raw) return { level: 'L1', reasons: ['空命令'], matchedRules: [], segments: [], complex: false, parseError: false };
  if (raw.length > 64 * 1024) return { level: 'L1', reasons: ['命令太长'], matchedRules: [], segments: [], complex: true, parseError: true };
  return classifyParsed(o.parser.parse(raw), o, depth);
}

export type { Level };
