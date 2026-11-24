// ------------------------------------------------------------------ 监控（通过 SSH 采集，无需在目标机安装 Agent）

export interface CpuStats {
  /** 总使用率 0-100 */
  usage: number;
  user: number;
  system: number;
  iowait: number;
  cores: number;
  /** 每个核心的使用率 0-100（按 cpu0、cpu1… 的顺序） */
  perCore?: number[];
}

export interface MemStats {
  /** 字节 */
  total: number;
  used: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
  /** 内存分项（/proc/meminfo 的 MemFree、Buffers、Cached；自定义采集脚本没有） */
  free?: number;
  buffers?: number;
  cached?: number;
}

export interface DiskUsage {
  mount: string;
  fs: string;
  /** 字节 */
  size: number;
  used: number;
  usePct: number;
}

export interface NetIface {
  name: string;
  ip: string | null;
  /** 字节 / 秒 */
  rxBps: number;
  txBps: number;
  rxTotal: number;
  txTotal: number;
}

export interface GpuStats {
  name: string;
  util: number;
  /** MiB */
  memUsed: number;
  memTotal: number;
  tempC: number | null;
  powerW: number | null;
  /** 风扇转速百分比 */
  fanPct?: number | null;
}

export interface ProcStat {
  pid: number;
  user: string;
  /** ps 的 %CPU（进程生命周期内的平均值） */
  cpu: number;
  mem: number;
  /** KiB */
  rss: number;
  command: string;
}

/** 每小时一条的历史采样（文档一 6.4，本地保留 30 天） */
export interface MetricSample {
  /** 整点（毫秒） */
  ts: number;
  cpu: number | null;
  /** 内存使用率 0-100 */
  mem: number | null;
  load1: number | null;
  /** 挂载点 → 使用率 0-100 */
  disk: Record<string, number>;
  /** 字节 / 秒 */
  netRx: number | null;
  netTx: number | null;
}

/** 磁盘写满预测：最近 7 天的使用率做线性回归 */
export interface DiskForecast {
  mount: string;
  usedPct: number;
  /** 每天增长的百分点 */
  slopePerDay: number;
  /** 预计多少天后写满；不在增长或数据不够时为 null */
  daysToFull: number | null;
  /** 参与计算的采样数 */
  samples: number;
}

/** 少于这么多天会写满时告警 */
export const DISK_WARN_DAYS = 5;

/**
 * 常驻监控的告警阈值（第二十七轮）：常驻主机在后台持续采集，超过阈值持续一段时间、或连不上时发系统通知。
 * 监控卡片上的「需要注意」也用这套阈值。
 */
export interface MonitorAlertConfig {
  /** 后台告警（系统通知）；关闭后卡片上仍然标出需要注意的地方 */
  notify: boolean;
  /** 使用率阈值（%）：达到时卡片标红，持续 sustainMin 分钟后通知 */
  cpu: number;
  mem: number;
  disk: number;
  /** 持续多少分钟才告警（避免瞬时尖峰） */
  sustainMin: number;
  /** 同一台主机同一类告警的最短间隔（分钟） */
  cooldownMin: number;
  /** 连不上超过 2 分钟算告警（第二十八轮） */
  offline?: boolean;
  /** 告警时发邮件到当前登录账号的邮箱（第二十八轮）；告警一律记录告警日志并由 AI 自动只读排查 */
  email?: boolean;
}

export const DEFAULT_MONITOR_ALERT: MonitorAlertConfig = { notify: true, cpu: 90, mem: 90, disk: 90, sustainMin: 3, cooldownMin: 60, offline: true, email: true };

/** 一条正在发生的告警（常驻主机，主进程计算） */
export interface MonitorAlert {
  hostId: string;
  kind: 'cpu' | 'mem' | 'disk' | 'offline';
  text: string;
  /** 开始时间 */
  since: number;
  /** 已经发过通知 */
  notified: boolean;
}

/** 卡片「需要注意」的等级：使用率达到阈值 = 严重；比阈值低 10 个百分点以内（至少 50%）= 注意 */
export function usageLevel(pct: number, threshold: number): 'ok' | 'warn' | 'crit' {
  if (pct >= threshold) return 'crit';
  if (pct >= Math.max(50, threshold - 10)) return 'warn';
  return 'ok';
}

export type MetricsSnapshot =
  | { hostId: string; ts: number; state: 'unsupported' | 'error'; message: string }
  | {
      hostId: string;
      ts: number;
      state: 'ok';
      /** builtin = 内置的 Linux 采集脚本；custom = 主机设置里的自定义脚本（只有部分指标） */
      source?: 'builtin' | 'custom';
      hostname: string;
      kernel: string;
      uptimeSec: number;
      load: [number, number, number];
      /** 第一次采样没有差值，为 null */
      cpu: CpuStats | null;
      tempC: number | null;
      mem: MemStats;
      disks: DiskUsage[];
      diskIo: { readBps: number; writeBps: number } | null;
      net: NetIface[];
      /** 默认网关 */
      gateway?: string | null;
      gpus: GpuStats[];
      procs: ProcStat[];
    };

// ------------------------------------------------------------------ 监控详情（打开对应标签时按需执行的只读命令）

/** 进程排行里的一行 */
export interface ProcDetail {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  /** KiB */
  rss: number;
  /** 程序名（命令行第一段的文件名） */
  name: string;
  /** 完整命令行 */
  args: string;
}

/** 不常变化的主机信息 */
export interface MonitorStatic {
  /** /etc/os-release 的 PRETTY_NAME */
  os: string | null;
  cpuModel: string | null;
  /** lspci 识别出的显卡（没有 nvidia-smi 时也能显示型号） */
  gpus: string[];
}

export interface ListenPort {
  proto: 'tcp' | 'udp';
  port: number;
  address: string;
  process: string | null;
  pid: number | null;
}

/** 网络连接统计和监听端口 */
export interface NetDetail {
  /** /proc/net/sockstat 的 sockets used */
  sockets: number | null;
  tcp: number;
  /** TCP 连接按状态计数（ESTABLISHED、TIME_WAIT、LISTEN…） */
  tcpStates: Record<string, number>;
  udp: number;
  fileHandles: { allocated: number; max: number } | null;
  ports: ListenPort[];
}

export interface BigFile {
  path: string;
  /** 字节（du -k 的占用空间） */
  size: number;
}
