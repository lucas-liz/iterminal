import type { CpuStats, DiskUsage, GpuStats, MemStats, MetricsSnapshot, NetIface, ProcStat } from '@itm/protocol';

/** 采样间隔（秒） */
export const SAMPLE_INTERVAL_SEC = 2;

/**
 * 在目标机上长驻的采集脚本（文档一 6.4：不装 Agent，通过 SSH 采集）。
 * 跑在一个独立的 exec 通道里，每隔几秒输出一个以 @@BEGIN / @@END 包起来的数据块。
 * 只用 POSIX sh 和 /proc，兼容 bash / dash / busybox；不是 Linux 时输出 @@UNSUPPORTED 后退出。
 *
 * @shells：列出同一条 SSH 连接下带终端的兄弟进程（即各个交互 shell）和它们的当前目录，
 * 用来让右侧文件面板跟随终端目录，不需要往用户的 shell 里注入任何东西。
 */
export const MONITOR_SCRIPT = `
[ "$(uname -s 2>/dev/null)" = Linux ] || { echo "@@UNSUPPORTED $(uname -s 2>/dev/null)"; exit 0; }
P=$PPID
while :; do
  echo '@@BEGIN'
  echo "@host $(hostname 2>/dev/null) $(uname -r 2>/dev/null)"
  echo '@stat'; grep '^cpu' /proc/stat
  echo "@cores $(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
  echo '@mem'; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo
  echo "@load $(cat /proc/loadavg)"
  echo "@uptime $(cat /proc/uptime)"
  echo '@net'; tail -n +3 /proc/net/dev
  echo '@ip'; ip -o -4 addr show 2>/dev/null | awk '{print $2, $4}'
  echo '@route'; cat /proc/net/route 2>/dev/null
  echo '@diskstats'; cat /proc/diskstats 2>/dev/null
  echo '@df'; df -P -k 2>/dev/null | tail -n +2
  echo '@temp'; cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null
  echo '@ps'; ps -eo pid=,user=,pcpu=,pmem=,rss=,comm= --sort=-pcpu 2>/dev/null | head -n 15
  echo '@gpu'; command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed --format=csv,noheader,nounits 2>/dev/null
  echo '@shells'
  for p in $(ps -o pid= --ppid "$P" 2>/dev/null); do
    t=$(ps -o tty= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$t" ] && [ "$t" != "?" ] && echo "$p $t $(readlink "/proc/$p/cwd" 2>/dev/null)"
  done
  echo '@@END'
  sleep ${SAMPLE_INTERVAL_SEC}
done
`;

/** 一次采样的原始数据（计算速率需要和上一次比较） */
export interface RawSample {
  ts: number;
  hostname: string;
  kernel: string;
  cpuTicks: number[] | null;
  /** cpu0、cpu1… 各自的时间片计数 */
  coreTicks: number[][];
  cores: number;
  mem: Record<string, number>;
  load: [number, number, number];
  uptimeSec: number;
  net: Map<string, { rx: number; tx: number }>;
  ips: Map<string, string>;
  gateway: string | null;
  diskio: { read: number; write: number } | null;
  disks: DiskUsage[];
  tempC: number | null;
  procs: ProcStat[];
  gpus: GpuStats[];
  shells: { pid: number; tty: string; cwd: string | null }[];
}

/** 整块磁盘（不含分区），用于汇总磁盘 IO */
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

/** df 里只保留真实磁盘和网络文件系统，排除 tmpfs / overlay 等 */
function realFilesystem(fs: string, mount: string): boolean {
  if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount)) return false;
  return fs.startsWith('/dev/') || /^[^/]+:\//.test(fs) || fs.startsWith('//');
}

const num = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/** 解析一个 @@BEGIN…@@END 之间的数据块 */
export function parseSample(block: string, ts: number): RawSample {
  const sample: RawSample = {
    ts,
    hostname: '',
    kernel: '',
    cpuTicks: null,
    coreTicks: [],
    cores: 0,
    mem: {},
    load: [0, 0, 0],
    uptimeSec: 0,
    net: new Map(),
    ips: new Map(),
    gateway: null,
    diskio: null,
    disks: [],
    tempC: null,
    procs: [],
    gpus: [],
    shells: [],
  };
  let section = '';
  let diskRead = 0;
  let diskWrite = 0;
  let sawDisk = false;
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('@host ')) {
      const [, hostname = '', kernel = ''] = line.split(/\s+/);
      sample.hostname = hostname;
      sample.kernel = kernel;
      continue;
    }
    if (line.startsWith('@cores ')) {
      sample.cores = num(line.slice(7));
      continue;
    }
    if (line.startsWith('@load ')) {
      const p = line.slice(6).split(/\s+/);
      sample.load = [num(p[0]), num(p[1]), num(p[2])];
      continue;
    }
    if (line.startsWith('@uptime ')) {
      sample.uptimeSec = num(line.slice(8).split(/\s+/)[0]);
      continue;
    }
    if (line.startsWith('@')) {
      section = line.slice(1);
      continue;
    }
    switch (section) {
      case 'stat':
        if (line.startsWith('cpu ')) {
          sample.cpuTicks = line.split(/\s+/).slice(1).map(num);
        } else if (/^cpu\d+ /.test(line)) {
          sample.coreTicks.push(line.split(/\s+/).slice(1).map(num));
        }
        break;
      case 'route': {
        // Iface Destination Gateway Flags …：目的地址 00000000 是默认路由，网关是小端序的十六进制
        const f = line.split(/\s+/);
        if (!sample.gateway && f[1] === '00000000' && /^[0-9A-Fa-f]{8}$/.test(f[2] ?? '') && f[2] !== '00000000') {
          const n = parseInt(f[2], 16);
          sample.gateway = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
        }
        break;
      }
      case 'mem': {
        const m = /^(\w+):\s+(\d+)/.exec(line);
        if (m) sample.mem[m[1]] = Number(m[2]) * 1024;
        break;
      }
      case 'net': {
        const m = /^([^:\s]+):\s*(.*)$/.exec(line);
        if (m && m[1] !== 'lo') {
          const f = m[2].split(/\s+/).map(num);
          sample.net.set(m[1], { rx: f[0], tx: f[8] });
        }
        break;
      }
      case 'ip': {
        const [iface, cidr] = line.split(/\s+/);
        if (iface && cidr && !sample.ips.has(iface)) sample.ips.set(iface, cidr.split('/')[0]);
        break;
      }
      case 'diskstats': {
        const f = line.split(/\s+/);
        if (f.length >= 10 && WHOLE_DISK.test(f[2])) {
          sawDisk = true;
          diskRead += num(f[5]) * 512;
          diskWrite += num(f[9]) * 512;
        }
        break;
      }
      case 'df': {
        const f = line.split(/\s+/);
        if (f.length >= 6) {
          const fs = f[0];
          const mount = f.slice(5).join(' ');
          const size = num(f[1]) * 1024;
          const used = num(f[2]) * 1024;
          if (size > 0 && realFilesystem(fs, mount) && !sample.disks.some((d) => d.mount === mount)) {
            sample.disks.push({ mount, fs, size, used, usePct: Math.round((used / size) * 1000) / 10 });
          }
        }
        break;
      }
      case 'temp': {
        const t = num(line) / 1000;
        if (t > 0 && t < 150) sample.tempC = Math.max(sample.tempC ?? 0, t);
        break;
      }
      case 'ps': {
        const f = line.split(/\s+/);
        if (f.length >= 6) {
          sample.procs.push({
            pid: num(f[0]),
            user: f[1],
            cpu: num(f[2]),
            mem: num(f[3]),
            rss: num(f[4]),
            command: f.slice(5).join(' '),
          });
        }
        break;
      }
      case 'gpu': {
        const f = line.split(',').map((x) => x.trim());
        if (f.length >= 6) {
          const opt = (s: string): number | null => (/^[\d.]+$/.test(s) ? Number(s) : null);
          sample.gpus.push({
            name: f[0],
            util: num(f[1]),
            memUsed: num(f[2]),
            memTotal: num(f[3]),
            tempC: opt(f[4]),
            powerW: opt(f[5]),
            fanPct: opt(f[6] ?? ''),
          });
        }
        break;
      }
      case 'shells': {
        const m = /^(\d+)\s+(\S+)\s*(.*)$/.exec(line);
        if (m) sample.shells.push({ pid: Number(m[1]), tty: m[2], cwd: m[3] || null });
        break;
      }
      default:
        break;
    }
  }
  if (sawDisk) sample.diskio = { read: diskRead, write: diskWrite };
  return sample;
}

/** 两次采样之间的使用率（百分比，一位小数）；没有变化时为 null */
function usageOf(prev: number[], cur: number[]): number | null {
  const d = cur.map((v, i) => v - (prev[i] ?? 0));
  const total = d.slice(0, 8).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return Math.round(((total - (d[3] ?? 0) - (d[4] ?? 0)) / total) * 1000) / 10;
}

function cpuStats(prev: number[], cur: number[], cores: number, perCore: number[]): CpuStats | null {
  // user nice system idle iowait irq softirq steal
  const d = cur.map((v, i) => v - (prev[i] ?? 0));
  const total = d.slice(0, 8).reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const pct = (v: number): number => Math.round((v / total) * 1000) / 10;
  const idle = (d[3] ?? 0) + (d[4] ?? 0);
  return {
    usage: pct(total - idle),
    user: pct((d[0] ?? 0) + (d[1] ?? 0)),
    system: pct((d[2] ?? 0) + (d[5] ?? 0) + (d[6] ?? 0)),
    iowait: pct(d[4] ?? 0),
    cores,
    ...(perCore.length ? { perCore } : {}),
  };
}

/** 两次采样之差 → 速率；计数器回绕或重启时按 0 处理 */
const rate = (cur: number, prev: number, sec: number): number => (sec > 0 && cur >= prev ? Math.round((cur - prev) / sec) : 0);

export function toSnapshot(hostId: string, prev: RawSample | null, cur: RawSample): MetricsSnapshot {
  const sec = prev ? (cur.ts - prev.ts) / 1000 : 0;
  const m = cur.mem;
  const available = m.MemAvailable ?? (m.MemFree ?? 0) + (m.Buffers ?? 0) + (m.Cached ?? 0);
  const mem: MemStats = {
    total: m.MemTotal ?? 0,
    available,
    used: Math.max(0, (m.MemTotal ?? 0) - available),
    swapTotal: m.SwapTotal ?? 0,
    swapUsed: Math.max(0, (m.SwapTotal ?? 0) - (m.SwapFree ?? 0)),
    ...(m.MemFree !== undefined ? { free: m.MemFree, buffers: m.Buffers ?? 0, cached: m.Cached ?? 0 } : {}),
  };
  const perCore = prev ? cur.coreTicks.map((t, i) => (prev.coreTicks[i] ? (usageOf(prev.coreTicks[i], t) ?? 0) : 0)) : [];
  const net: NetIface[] = [...cur.net.entries()].map(([name, v]) => {
    const p = prev?.net.get(name);
    return {
      name,
      ip: cur.ips.get(name) ?? null,
      rxBps: p ? rate(v.rx, p.rx, sec) : 0,
      txBps: p ? rate(v.tx, p.tx, sec) : 0,
      rxTotal: v.rx,
      txTotal: v.tx,
    };
  });
  return {
    hostId,
    ts: cur.ts,
    state: 'ok',
    hostname: cur.hostname,
    kernel: cur.kernel,
    uptimeSec: cur.uptimeSec,
    load: cur.load,
    cpu: prev?.cpuTicks && cur.cpuTicks ? cpuStats(prev.cpuTicks, cur.cpuTicks, cur.cores, perCore) : null,
    tempC: cur.tempC === null ? null : Math.round(cur.tempC * 10) / 10,
    mem,
    disks: cur.disks,
    diskIo:
      prev?.diskio && cur.diskio
        ? { readBps: rate(cur.diskio.read, prev.diskio.read, sec), writeBps: rate(cur.diskio.write, prev.diskio.write, sec) }
        : null,
    net,
    gateway: cur.gateway,
    gpus: cur.gpus,
    procs: cur.procs,
  };
}
