/**
 * ssh 命令 ⇄ 端口转发（第五轮）：从 `ssh -p 2222 -L 8848:10.20.0.39:8848 … root@10.10.0.90` 导入转发规则，
 * 也可以把一台主机的转发配置生成这样的命令（在别的电脑上用 OpenSSH 直接执行）。
 */
import type { PortForwardInput } from './core';

export interface SshForwardCommand {
  /** 目标主机（命令里的 [user@]host、-p、-l） */
  host: { address: string; port: number; username: string | null } | null;
  /** -J 跳板机（只用于提示和匹配，不导入） */
  jumps: string[];
  forwards: PortForwardInput[];
  /** 不支持或忽略的部分（中文说明） */
  warnings: string[];
}

/** 按 shell 规则切分（支持引号、反斜杠续行） */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const src = cmd.replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < src.length) cur += src[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < src.length) {
      cur += src[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** 拆分 a:b:c，方括号里的 IPv6 地址作为一段 */
function splitSpec(spec: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let bracket = false;
  for (const ch of spec) {
    if (ch === '[') bracket = true;
    else if (ch === ']') bracket = false;
    else if (ch === ':' && !bracket) {
      parts.push(cur);
      cur = '';
      continue;
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

const port = (s: string | undefined): number | null => {
  if (!s || !/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 65535 ? n : null;
};

/** 监听地址：没写是本机回环；* 或空表示所有地址 */
const bindOf = (s: string | undefined): string => (s === undefined ? '127.0.0.1' : s === '' || s === '*' ? '0.0.0.0' : s === 'localhost' ? '127.0.0.1' : s);

function parseForward(flag: 'L' | 'R' | 'D', spec: string, warnings: string[]): PortForwardInput | null {
  const p = splitSpec(spec);
  if (flag === 'D') {
    const bindPort = port(p.at(-1));
    if (p.length > 2 || bindPort === null) {
      warnings.push(`-D ${spec} 写法不对，已跳过`);
      return null;
    }
    return { type: 'DYNAMIC', bindAddr: bindOf(p.length === 2 ? p[0] : undefined), bindPort, targetAddr: null, targetPort: null, autoStart: false };
  }
  if (p.length < 3 || p.length > 4) {
    warnings.push(p.length <= 2 && flag === 'R' ? `-R ${spec} 是远程动态转发，暂不支持，已跳过` : `-${flag} ${spec} 写法不对（Unix 套接字转发不支持），已跳过`);
    return null;
  }
  const [bind, lp, host, hp] = p.length === 4 ? p : [undefined, ...p];
  const bindPort = port(lp);
  const targetPort = port(hp);
  if (bindPort === null || targetPort === null || targetPort === 0 || !host) {
    warnings.push(`-${flag} ${spec} 端口或地址不对，已跳过`);
    return null;
  }
  return { type: flag === 'L' ? 'LOCAL' : 'REMOTE', bindAddr: bindOf(bind), bindPort, targetAddr: host, targetPort, autoStart: false };
}

/** 不带参数的选项（可以合在一起写，例如 -NfC） */
const BOOL_FLAGS = new Set('46AaCfGgKkMNnqsTtVvXxYy');
/** 带参数但不影响转发的选项 */
const ARG_FLAGS = new Set('BbcEeFIiLlmOoPpQRSWwDJ');

export function parseSshForwardCommand(cmd: string): SshForwardCommand {
  const t = tokenize(cmd.trim());
  const warnings: string[] = [];
  const forwards: PortForwardInput[] = [];
  const jumps: string[] = [];
  let i = 0;
  // 允许前面带 sudo、autossh 等；从 ssh 开始
  const at = t.findIndex((x) => /(^|\/)(auto)?ssh$/.test(x));
  if (at >= 0) i = at + 1;
  // autossh 自己的 -M 端口 带参数（ssh 的 -M 是不带参数的主连接模式）
  const auto = at >= 0 && /autossh$/.test(t[at]);
  let sshPort: number | null = null;
  let user: string | null = null;
  let dest: string | null = null;
  for (; i < t.length; i++) {
    const tok = t[i];
    if (tok === '--') {
      dest = t[i + 1] ?? null;
      break;
    }
    if (!tok.startsWith('-') || tok === '-') {
      dest = tok;
      break;
    }
    // 依次处理合在一起的选项：-NfL 8080:a:80
    for (let k = 1; k < tok.length; k++) {
      const f = tok[k];
      if (auto && f === 'M') {
        if (!tok.slice(k + 1)) i++;
        break;
      }
      if (BOOL_FLAGS.has(f)) continue;
      if (!ARG_FLAGS.has(f)) {
        warnings.push(`不认识的选项 -${f}，已忽略`);
        continue;
      }
      const rest = tok.slice(k + 1);
      const arg = rest || t[++i];
      if (arg === undefined) {
        warnings.push(`选项 -${f} 缺少参数`);
        break;
      }
      if (f === 'L' || f === 'R' || f === 'D') {
        const fw = parseForward(f, arg, warnings);
        if (fw) forwards.push(fw);
      } else if (f === 'p') sshPort = port(arg);
      else if (f === 'l') user = arg;
      else if (f === 'J') jumps.push(...arg.split(',').filter(Boolean));
      else if (f === 'o') {
        const m = /^(\w+)\s*[= ]\s*(.+)$/.exec(arg);
        if (m && /^port$/i.test(m[1])) sshPort = port(m[2]);
        else if (m && /^user$/i.test(m[1])) user = m[2];
        else if (m && /^(localforward|remoteforward|dynamicforward)$/i.test(m[1])) {
          const kind = m[1].toLowerCase()[0] === 'l' ? 'L' : m[1].toLowerCase()[0] === 'r' ? 'R' : 'D';
          const spec = m[2].trim().replace(/\s+/, ':');
          const fw = parseForward(kind, spec, warnings);
          if (fw) forwards.push(fw);
        }
      } else if (f === 'i') warnings.push(`私钥 ${arg} 不会导入，请在主机设置里选择认证方式`);
      break;
    }
  }
  let host: SshForwardCommand['host'] = null;
  if (dest) {
    let d = dest;
    const url = /^ssh:\/\/(?:([^@]+)@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?\/?$/.exec(d);
    if (url) {
      if (url[1]) user = url[1];
      d = url[2].replace(/^\[|\]$/g, '');
      if (url[3]) sshPort = port(url[3]);
    } else {
      const m = /^(?:(.+)@)?(.+)$/.exec(d)!;
      if (m[1]) user = m[1];
      d = m[2];
    }
    host = { address: d, port: sshPort ?? 22, username: user };
  } else warnings.push('命令里没有目标主机（[用户@]地址）');
  if (!forwards.length) warnings.push('命令里没有 -L / -R / -D 转发');
  return { host, jumps, forwards, warnings };
}

/** IPv6 地址在转发规格里要加方括号 */
const addr = (a: string): string => (a.includes(':') ? `[${a}]` : a);

/**
 * 生成 OpenSSH 命令：ssh [-N] [-p 端口] [-J 跳板] -L … -R … -D … 用户@地址。
 * 监听地址是 127.0.0.1（ssh 的默认值）时省略。
 */
export function buildSshForwardCommand(
  host: { address: string; port: number | null; username: string | null },
  forwards: Pick<PortForwardInput, 'type' | 'bindAddr' | 'bindPort' | 'targetAddr' | 'targetPort'>[],
  opts: { jumps?: string[]; noShell?: boolean } = {},
): string {
  const parts = ['ssh'];
  if (opts.noShell) parts.push('-N');
  if (host.port && host.port !== 22) parts.push('-p', String(host.port));
  if (opts.jumps?.length) parts.push('-J', opts.jumps.join(','));
  const bind = (b: string): string => (!b || b === '127.0.0.1' || b === 'localhost' ? '' : `${b === '0.0.0.0' ? '*' : addr(b)}:`);
  for (const f of forwards) {
    if (f.type === 'DYNAMIC') parts.push('-D', `${bind(f.bindAddr)}${f.bindPort}`);
    else parts.push(f.type === 'LOCAL' ? '-L' : '-R', `${bind(f.bindAddr)}${f.bindPort}:${addr(f.targetAddr ?? '')}:${f.targetPort}`);
  }
  parts.push(`${host.username ? `${host.username}@` : ''}${host.address}`);
  return parts.join(' ');
}

/** 同一台主机上的同一条转发（类型 + 监听地址 + 端口相同） */
export const sameForward = (a: Pick<PortForwardInput, 'type' | 'bindAddr' | 'bindPort'>, b: Pick<PortForwardInput, 'type' | 'bindAddr' | 'bindPort'>): boolean =>
  a.type === b.type && a.bindPort === b.bindPort && (a.bindAddr || '127.0.0.1') === (b.bindAddr || '127.0.0.1');
