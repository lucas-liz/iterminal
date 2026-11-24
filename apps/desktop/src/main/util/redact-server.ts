/**
 * 界面上不显示服务端地址：发给界面的错误提示、诊断信息里出现的服务端地址统一换成「服务端」。
 * 地址来源（默认地址、企业预置、各个账号档案）由主进程启动时登记。
 */
const LABEL = '服务端';

let source: () => (string | null | undefined)[] = () => [];
let cache: { key: string; patterns: RegExp[] } | null = null;

export function setServerSource(fn: () => (string | null | undefined)[]): void {
  source = fn;
  cache = null;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isLoopback = (h: string): boolean => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h);
const isIp = (h: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith('[');

function patternsOf(urls: string[]): RegExp[] {
  const full: string[] = [];
  const hostPort: string[] = [];
  const bare: string[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const hosts = [`${u.hostname}:${port}`, ...(u.port ? [] : [u.hostname])];
    // 完整地址（http / https / ws / wss，后面跟着的路径一起换掉）
    for (const h of hosts) full.push(`(?:https?|wss?)://${esc(h)}(?:/[^\\s'"<>，。；（）()\\[\\]]*)?`);
    // 「主机:端口」（连接失败的系统错误里常见，例如 connect ECONNREFUSED 1.2.3.4:51115）
    hostPort.push(esc(`${u.hostname}:${port}`));
    // 只有主机名（DNS 失败：getaddrinfo ENOTFOUND ops.example.com）；IP 和本机地址不单独换，免得误伤同一台机器上的 SSH 主机
    if (!isIp(u.hostname) && !isLoopback(u.hostname)) bare.push(esc(u.hostname));
  }
  const out: RegExp[] = [];
  if (full.length) out.push(new RegExp(full.join('|'), 'gi'));
  if (hostPort.length) out.push(new RegExp(`(?<![\\w.-])(?:${hostPort.join('|')})(?![\\d])`, 'gi'));
  if (bare.length) out.push(new RegExp(`(?<![\\w.-])(?:${bare.join('|')})(?![\\w-])`, 'gi'));
  return out;
}

/** 把文字里的服务端地址换成「服务端」 */
export function redactServers(text: string): string {
  if (!text) return text;
  const urls = [...new Set(source().filter((u): u is string => !!u && /^https?:\/\//i.test(u)))];
  if (!urls.length) return text;
  const key = urls.join('\n');
  if (cache?.key !== key) cache = { key, patterns: patternsOf(urls) };
  let out = text;
  for (const re of cache.patterns) out = out.replace(re, LABEL);
  // 「服务端 服务端」「连不上服务端 服务端」这类重复说法合并
  return out.replace(/服务端[\s:：]*服务端/g, LABEL);
}
