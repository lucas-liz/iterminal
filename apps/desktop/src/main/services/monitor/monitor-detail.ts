import type { BigFile, ListenPort, MonitorStatic, NetDetail, ProcDetail } from '@itm/protocol';
import { shQuote } from '../../util/shell';

/**
 * 监控详情（文档一 6.4）：打开详情面板的对应标签时才执行的只读命令，不放进每 2 秒一次的常驻采集脚本。
 * 每条命令以 `: @@ITM-DETAIL <种类>` 开头（shell 的空命令，不影响执行），便于测试服务器识别。
 */

const num = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

// ------------------------------------------------------------------ 进程排行

export function procsCommand(sort: 'cpu' | 'mem', limit: number): string {
  const n = Math.min(Math.max(Math.floor(limit) || 20, 1), 100);
  return `: @@ITM-DETAIL procs; ps -eo pid=,user=,pcpu=,pmem=,rss=,args= --sort=${sort === 'mem' ? '-rss' : '-pcpu'} 2>/dev/null | head -n ${n}`;
}

/** 程序名：命令行第一段的文件名（内核线程保留方括号，`nginx: worker` 这类去掉冒号） */
export function procName(args: string): string {
  const a = args.trim();
  if (a.startsWith('[')) return a;
  const first = a.split(/\s+/)[0] ?? '';
  return (first.split('/').pop() ?? first).replace(/:$/, '') || a;
}

export function parseProcs(out: string): ProcDetail[] {
  const list: ProcDetail[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || !/^\d+$/.test(f[0])) continue;
    const args = f.slice(5).join(' ');
    list.push({ pid: num(f[0]), user: f[1], cpu: num(f[2]), mem: num(f[3]), rss: num(f[4]), name: procName(args), args });
  }
  return list;
}

// ------------------------------------------------------------------ 主机信息（系统版本、CPU 型号、显卡型号）

export const STATIC_COMMAND = [
  ': @@ITM-DETAIL static',
  "echo '@os'; (. /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\")",
  "echo '@cpu'; grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2-",
  "echo '@gpu'; lspci 2>/dev/null | grep -iE 'vga|3d controller|display controller'",
].join('\n');

export function parseStatic(out: string): MonitorStatic {
  const r: MonitorStatic = { os: null, cpuModel: null, gpus: [] };
  let section = '';
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^@\w+$/.test(line)) {
      section = line.slice(1);
      continue;
    }
    if (section === 'os' && !r.os) r.os = line.slice(0, 200);
    else if (section === 'cpu' && !r.cpuModel) r.cpuModel = line.replace(/\s+/g, ' ').slice(0, 200);
    else if (section === 'gpu' && r.gpus.length < 8) r.gpus.push(line.slice(0, 300));
  }
  return r;
}

// ------------------------------------------------------------------ 网络：连接统计、文件句柄、监听端口

/** /proc/net/tcp 的 st 字段 */
const TCP_STATE: Record<string, string> = {
  '01': 'ESTABLISHED',
  '02': 'SYN_SENT',
  '03': 'SYN_RECV',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
};

export const NET_COMMAND = [
  ': @@ITM-DETAIL net',
  "echo '@sockstat'; cat /proc/net/sockstat 2>/dev/null",
  "echo '@filenr'; cat /proc/sys/fs/file-nr 2>/dev/null",
  "echo '@tcp'; awk 'FNR>1{print $4}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort | uniq -c",
  "echo '@udp'; awk 'FNR>1' /proc/net/udp /proc/net/udp6 2>/dev/null | wc -l",
  "echo '@listen'; (ss -tulnpH 2>/dev/null || netstat -tulnp 2>/dev/null | tail -n +3) | head -n 300",
].join('\n');

/** `0.0.0.0:22`、`[::]:111`、`*:80`、`127.0.0.53%lo:53`、`[fe80::1]%eth0:546` → 地址和端口 */
function splitAddr(s: string): { address: string; port: number } | null {
  const i = s.lastIndexOf(':');
  if (i <= 0) return null;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { address: s.slice(0, i), port };
}

/** 解析 ss -tulnpH 或 netstat -tulnp 的一行 */
export function parseListenLine(line: string): ListenPort | null {
  const f = line.trim().split(/\s+/);
  if (f.length < 4) return null;
  const proto = f[0].toLowerCase().startsWith('udp') ? 'udp' : f[0].toLowerCase().startsWith('tcp') ? 'tcp' : null;
  if (!proto) return null;
  // ss：Netid State Recv-Q Send-Q Local Peer [Process]
  if (/^(LISTEN|UNCONN)$/i.test(f[1])) {
    const a = splitAddr(f[4] ?? '');
    if (!a) return null;
    const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(f.slice(6).join(' '));
    return { proto, ...a, process: m?.[1] ?? null, pid: m ? Number(m[2]) : null };
  }
  // netstat：Proto Recv-Q Send-Q Local Foreign [State] PID/Program
  const a = splitAddr(f[3]);
  if (!a) return null;
  const last = f[f.length - 1];
  const m = /^(\d+)\/(.+)$/.exec(last);
  if (proto === 'tcp' && !f.includes('LISTEN')) return null;
  return { proto, ...a, process: m?.[2] ?? null, pid: m ? Number(m[1]) : null };
}

export function parseNet(out: string): NetDetail {
  const r: NetDetail = { sockets: null, tcp: 0, tcpStates: {}, udp: 0, fileHandles: null, ports: [] };
  const seen = new Set<string>();
  let section = '';
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^@\w+$/.test(line)) {
      section = line.slice(1);
      continue;
    }
    switch (section) {
      case 'sockstat': {
        const m = /^sockets:\s+used\s+(\d+)/.exec(line);
        if (m) r.sockets = Number(m[1]);
        break;
      }
      case 'filenr': {
        const f = line.split(/\s+/).map(num);
        if (f.length >= 3) r.fileHandles = { allocated: f[0] - f[1], max: f[2] };
        break;
      }
      case 'tcp': {
        const m = /^(\d+)\s+([0-9A-Fa-f]{2})$/.exec(line);
        if (m) {
          const name = TCP_STATE[m[2].toUpperCase()] ?? m[2];
          r.tcpStates[name] = (r.tcpStates[name] ?? 0) + Number(m[1]);
          r.tcp += Number(m[1]);
        }
        break;
      }
      case 'udp':
        r.udp = num(line);
        break;
      case 'listen': {
        const p = parseListenLine(line);
        const key = p && `${p.proto}|${p.address}|${p.port}`;
        if (p && key && !seen.has(key)) {
          seen.add(key);
          r.ports.push(p);
        }
        break;
      }
      default:
        break;
    }
  }
  r.ports.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
  return r;
}

// ------------------------------------------------------------------ 大文件扫描

export function bigFilesCommand(paths: string[], minMb: number, limit: number): string {
  const kb = Math.max(1, Math.floor(minMb)) * 1024;
  const n = Math.min(Math.max(Math.floor(limit) || 20, 1), 200);
  // -xdev 不跨文件系统；du -k 在 GNU 和 busybox 上都能用；nice 降低对业务的影响
  return `: @@ITM-DETAIL bigfiles; N=; command -v nice >/dev/null 2>&1 && N='nice -n 19'; $N find ${paths.map(shQuote).join(' ')} -xdev -type f -size +${kb}k -exec du -k {} + 2>/dev/null | sort -rn | head -n ${n}`;
}

export function parseBigFiles(out: string): BigFile[] {
  const list: BigFile[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+)\s+(.+)$/.exec(line.trim());
    if (m) list.push({ size: Number(m[1]) * 1024, path: m[2] });
  }
  return list;
}

/** 扫描路径：绝对路径、最多 10 个，不能有换行 */
export function checkScanPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return paths
    .map((p) => String(p).trim())
    .filter((p) => p.startsWith('/') && !/[\n\r\0]/.test(p) && p.length <= 1024)
    .slice(0, 10);
}
