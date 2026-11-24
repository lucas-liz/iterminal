import type { ClientChannel } from 'ssh2';
import type { BigFile, MetricsSnapshot, MonitorConfig, MonitorStatic, NetDetail, ProcDetail } from '@itm/protocol';
import { UserError } from '../../util/errors';
import { shQuote } from '../../util/shell';
import type { Emit } from '../connection/emitter';
import { execCommand } from '../connection/exec';
import type { PooledConnection, SshPool } from '../connection/ssh-pool';
import { MONITOR_SCRIPT, parseSample, toSnapshot, type RawSample } from './monitor-script';
import { parseCustomSample, type MetricStore } from './metric-store';
import { bigFilesCommand, checkScanPaths, NET_COMMAND, parseBigFiles, parseNet, parseProcs, parseStatic, procsCommand, STATIC_COMMAND } from './monitor-detail';

/** 自定义采集脚本的执行间隔 */
const CUSTOM_INTERVAL_MS = 5000;

interface HostMonitor {
  hostId: string;
  /** 订阅的窗口 → 次数（同一窗口多个标签会重复订阅） */
  owners: Map<number, number>;
  conn: PooledConnection | null;
  stream: ClientChannel | null;
  starting: boolean;
  buffer: string;
  prev: RawSample | null;
  last: MetricsSnapshot | null;
  /** 自定义采集脚本的定时器 */
  timer: NodeJS.Timeout | null;
}

/** SessionManager 中和监控相关的部分 */
export interface ShellSessions {
  sshSessionsOf(hostId: string): { id: string; owner: number }[];
}

/**
 * 主机监控（文档一 6.4）：每台主机一条长驻 exec 通道运行采集脚本，复用终端所在的 SSH 连接。
 * 顺带把每个终端会话对应到远端的 shell 进程，推送当前目录（右侧文件面板跟随终端目录）。
 */
export class MonitorService {
  private readonly monitors = new Map<string, HostMonitor>();
  /** 会话 → 远端 shell 的 pid 和当前目录 */
  private readonly shells = new Map<string, { hostId: string; pid: number; cwd: string | null }>();

  constructor(
    private readonly pool: SshPool,
    private readonly emit: Emit,
    private readonly sessions: ShellSessions,
    private readonly now: () => number = Date.now,
    /** 采集脚本（测试时可以替换成输出固定数据的脚本） */
    private readonly script: string = MONITOR_SCRIPT,
  ) {}

  /** 历史采样存储 */
  private store: MetricStore | null = null;
  /** 主机的自定义采集脚本（非 Linux 设备） */
  private customScript: (hostId: string) => string | null = () => null;

  /** 监控配置（设置 → 终端 → 监控）：是否运行远程采集、隐藏哪些分区 / 网卡 */
  private config: () => MonitorConfig | null = () => null;

  /** 每次新快照的监听（常驻监控的告警，第二十七轮） */
  private readonly listeners = new Set<(snap: MetricsSnapshot) => void>();
  onSnapshot(fn: (snap: MetricsSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attach(o: { store?: MetricStore; customScript?: (hostId: string) => string | null; config?: () => MonitorConfig }): void {
    if (o.store) this.store = o.store;
    if (o.customScript) this.customScript = o.customScript;
    if (o.config) this.config = o.config;
  }

  subscribe(owner: number, hostId: string): void {
    let m = this.monitors.get(hostId);
    if (!m) {
      m = { hostId, owners: new Map(), conn: null, stream: null, starting: false, buffer: '', prev: null, last: null, timer: null };
      this.monitors.set(hostId, m);
    }
    m.owners.set(owner, (m.owners.get(owner) ?? 0) + 1);
    if (m.last) {
      this.emit(owner, 'monitor.update', m.last);
    }
    if (this.config()?.enabled === false) {
      // 堡垒机等受限环境：不在服务器上运行任何采集命令
      this.publish(m, { hostId, ts: this.now(), state: 'error', message: '远程监控已在设置里关闭（设置 → 终端 → 监控）' });
      return;
    }
    if (!m.stream && !m.starting) {
      void this.start(m, owner);
    }
  }

  /** 有订阅但采集已经断开（连接失败、监控断开）时重新连接；返回是否重新开始了 */
  restart(hostId: string): boolean {
    const m = this.monitors.get(hostId);
    if (!m || m.owners.size === 0 || m.stream || m.starting || m.timer || this.config()?.enabled === false) return false;
    void this.start(m, [...m.owners.keys()].find((o) => o >= 0) ?? [...m.owners.keys()][0]);
    return true;
  }

  /** 正在采集的主机（有订阅的） */
  isWatching(hostId: string): boolean {
    return !!this.monitors.get(hostId)?.owners.size;
  }

  unsubscribe(owner: number, hostId: string): void {
    const m = this.monitors.get(hostId);
    if (!m) return;
    const n = (m.owners.get(owner) ?? 0) - 1;
    if (n > 0) m.owners.set(owner, n);
    else m.owners.delete(owner);
    if (m.owners.size === 0) this.stop(m);
  }

  closeAllOf(owner: number): void {
    for (const m of [...this.monitors.values()]) {
      if (m.owners.delete(owner) && m.owners.size === 0) this.stop(m);
    }
  }

  stopAll(): void {
    [...this.monitors.values()].forEach((m) => this.stop(m));
  }

  /** 最近一次快照（Agent 的 get_metrics 工具使用） */
  latest(hostId: string): MetricsSnapshot | null {
    return this.monitors.get(hostId)?.last ?? null;
  }

  /** 结束远端进程：以登录用户的身份执行 kill，没有权限时返回远端的错误信息 */
  async kill(owner: number, hostId: string, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 1) {
      throw new UserError('进程号不合法');
    }
    const conn = await this.pool.acquire(hostId, owner);
    try {
      const r = await execCommand(conn.client, `kill -${signal === 'KILL' ? 'KILL' : 'TERM'} ${pid}`, { timeoutMs: 10_000 });
      if (r.code !== 0) {
        throw new UserError(`结束进程失败：${(r.stderr || r.stdout).trim() || `退出码 ${r.code}`}`);
      }
    } finally {
      this.pool.release(conn);
    }
  }

  /** 在这台主机上执行一条只读的详情命令（复用终端所在的 SSH 连接） */
  private async detail(owner: number, hostId: string, command: string, timeoutMs: number, maxBytes = 512 * 1024): Promise<string> {
    if (this.monitors.get(hostId)?.last?.state === 'unsupported') throw new UserError('这台主机不是 Linux，没有详细监控');
    const conn = await this.pool.acquire(hostId, owner);
    try {
      const r = await execCommand(conn.client, command, { timeoutMs, maxBytes });
      if (r.timedOut) throw new UserError(`执行超时（${Math.round(timeoutMs / 1000)} 秒）`);
      return r.stdout;
    } finally {
      this.pool.release(conn);
    }
  }

  /** 进程排行（按 CPU 或内存） */
  async procs(owner: number, hostId: string, sort: 'cpu' | 'mem', limit = 20): Promise<ProcDetail[]> {
    const list = parseProcs(await this.detail(owner, hostId, procsCommand(sort, limit), 15_000));
    if (!list.length) throw new UserError('没有拿到进程列表（远端的 ps 可能不支持 --sort，例如 busybox）');
    return list;
  }

  /** 系统版本、CPU 型号、显卡型号 */
  async staticInfo(owner: number, hostId: string): Promise<MonitorStatic> {
    return parseStatic(await this.detail(owner, hostId, STATIC_COMMAND, 15_000));
  }

  /** 连接统计、文件句柄、监听端口 */
  async net(owner: number, hostId: string): Promise<NetDetail> {
    return parseNet(await this.detail(owner, hostId, NET_COMMAND, 20_000));
  }

  /** 大文件扫描：find -xdev，按占用空间从大到小 */
  async bigFiles(owner: number, hostId: string, paths: string[], minMb: number, limit: number): Promise<{ files: BigFile[]; elapsedMs: number }> {
    const ok = checkScanPaths(paths);
    if (!ok.length) throw new UserError('请填写要扫描的绝对路径，例如 /home /var');
    if (!Number.isFinite(minMb) || minMb < 1) throw new UserError('最小大小至少 1 MB');
    const t0 = this.now();
    const out = await this.detail(owner, hostId, bigFilesCommand(ok, minMb, limit), 180_000);
    return { files: parseBigFiles(out), elapsedMs: this.now() - t0 };
  }

  private async start(m: HostMonitor, owner: number): Promise<void> {
    m.starting = true;
    try {
      m.conn = await this.pool.acquire(m.hostId, owner);
    } catch (e) {
      m.starting = false;
      this.publish(m, { hostId: m.hostId, ts: this.now(), state: 'error', message: `监控连接失败：${(e as Error).message}` });
      return;
    }
    if (m.owners.size === 0) {
      m.starting = false;
      this.pool.release(m.conn);
      m.conn = null;
      return;
    }
    const conn = m.conn;
    const custom = this.customScript(m.hostId);
    if (custom) {
      this.startCustom(m, conn, custom);
      return;
    }
    const failed = (err: Error): void => {
      m.starting = false;
      this.pool.release(conn);
      m.conn = null;
      this.publish(m, { hostId: m.hostId, ts: this.now(), state: 'error', message: `无法启动监控：${err.message}` });
    };
    // exec：替换掉登录 shell，保证脚本的父进程就是这条连接的 sshd（用来找到同连接下的交互 shell）
    // 连接已经断开时 ssh2 会同步抛出 Not connected：交还引用，否则这条死连接会一直留在连接池里
    try {
      conn.client.exec(`exec sh -c ${shQuote(this.script)}`, (err, stream) => {
        m.starting = false;
        if (err) {
          failed(err);
          return;
        }
        if (m.owners.size === 0) {
          stream.close();
          return;
        }
        m.stream = stream;
        m.buffer = '';
        stream.on('data', (b: Buffer) => this.onData(m, b.toString('utf8')));
        stream.stderr.on('data', () => undefined);
        stream.on('close', () => {
          m.stream = null;
          m.prev = null;
          if (m.conn === conn) {
            m.conn = null;
            this.pool.release(conn);
          }
          if (m.owners.size > 0 && m.last?.state === 'ok') {
            this.publish(m, { hostId: m.hostId, ts: this.now(), state: 'error', message: '监控已断开' });
          }
        });
      });
    } catch (e) {
      failed(e as Error);
    }
  }

  /**
   * 自定义采集：每 5 秒单独执行一次脚本（不包一层 sh 循环，交换机等没有 sh 的设备也能用），按 key=value 解析输出。
   */
  private startCustom(m: HostMonitor, conn: PooledConnection, script: string): void {
    m.starting = false;
    let running = false;
    const tick = async (): Promise<void> => {
      if (running || m.conn !== conn || conn.closed) return;
      running = true;
      try {
        const r = await execCommand(conn.client, script, { timeoutMs: 10_000 });
        const snap = parseCustomSample(m.hostId, `${r.stdout}\n${r.stderr}`, this.now());
        this.publish(
          m,
          snap ?? { hostId: m.hostId, ts: this.now(), state: 'error', message: '自定义采集脚本的输出里没有认出指标（需要 cpu=…、mem=…、disk./=… 这样的行）' },
        );
      } catch (e) {
        this.publish(m, { hostId: m.hostId, ts: this.now(), state: 'error', message: `自定义采集脚本执行失败：${(e as Error).message}` });
      } finally {
        running = false;
      }
    };
    m.timer = setInterval(() => void tick(), CUSTOM_INTERVAL_MS);
    void tick();
  }

  private stop(m: HostMonitor): void {
    this.monitors.delete(m.hostId);
    if (m.timer) clearInterval(m.timer);
    m.timer = null;
    this.store?.flushHost(m.hostId);
    m.stream?.close();
    m.stream = null;
    if (m.conn) {
      this.pool.release(m.conn);
      m.conn = null;
    }
  }

  private onData(m: HostMonitor, chunk: string): void {
    m.buffer += chunk;
    const unsupported = /@@UNSUPPORTED ?(.*)/.exec(m.buffer);
    if (unsupported) {
      m.buffer = '';
      const os = unsupported[1].trim();
      this.publish(m, {
        hostId: m.hostId,
        ts: this.now(),
        state: 'unsupported',
        message: `内置监控只支持 Linux 主机${os ? `（这台是 ${os}）` : ''}，可以在主机设置里配置自定义采集脚本`,
      });
      return;
    }
    for (;;) {
      const begin = m.buffer.indexOf('@@BEGIN');
      const end = m.buffer.indexOf('@@END', begin);
      if (begin < 0 || end < 0) break;
      const block = m.buffer.slice(begin + 7, end);
      m.buffer = m.buffer.slice(end + 5);
      const sample = parseSample(block, this.now());
      this.publish(m, toSnapshot(m.hostId, m.prev, sample));
      m.prev = sample;
      this.trackShells(m.hostId, sample);
    }
    if (m.buffer.length > 1024 * 1024) m.buffer = ''; // 防御：异常输出不无限增长
  }

  private publish(m: HostMonitor, raw: MetricsSnapshot): void {
    const snap = applyMonitorFilters(raw, this.config());
    m.last = snap;
    this.store?.record(snap);
    for (const owner of m.owners.keys()) if (owner >= 0) this.emit(owner, 'monitor.update', snap);
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch {
        // 监听方的错误不影响采集
      }
    }
  }

  /**
   * 把远端的交互 shell 对应到本地会话：已经对应上的保持不变；新出现的 shell 按 pid 从小到大，
   * 依次分给还没有对应的会话（按打开顺序）。目录变化时推送 session.cwd。
   */
  private trackShells(hostId: string, sample: RawSample): void {
    const sessions = this.sessions.sshSessionsOf(hostId);
    const open = new Set(sessions.map((s) => s.id));
    for (const [id, v] of this.shells) {
      if (v.hostId === hostId && !open.has(id)) this.shells.delete(id);
    }
    const alive = new Map(sample.shells.map((s) => [s.pid, s.cwd]));
    const taken = new Set<number>();
    for (const s of sessions) {
      const known = this.shells.get(s.id);
      if (known && alive.has(known.pid)) taken.add(known.pid);
      else this.shells.delete(s.id);
    }
    const free = [...alive.keys()].filter((pid) => !taken.has(pid)).sort((a, b) => a - b);
    for (const s of sessions) {
      if (!this.shells.has(s.id) && free.length > 0) {
        this.shells.set(s.id, { hostId, pid: free.shift()!, cwd: null });
      }
    }
    for (const s of sessions) {
      const known = this.shells.get(s.id);
      if (!known) continue;
      const cwd = alive.get(known.pid) ?? null;
      if (cwd && cwd !== known.cwd) {
        known.cwd = cwd;
        this.emit(s.owner, 'session.cwd', { sessionId: s.id, cwd });
      }
    }
  }
}

const SPECIAL_FS = /^\/(boot\/efi|efi|run|snap|var\/snap|dev|sys|proc)(\/|$)/;
const DOCKER_FS = /^\/(var\/lib\/(docker|containers|kubelet|containerd)|run\/(docker|containerd|k3s))(\/|$)/;
const VIRTUAL_NIC = /^(lo|docker\d*|br-|veth|virbr|vnet|cni|flannel|cali|tunl|kube-|weave|vxlan|genev|podman)/;
const list = (s: string): string[] =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/** 按监控配置隐藏分区和网卡（只影响显示和 Agent 看到的数据，不影响采集） */
export function applyMonitorFilters(snap: MetricsSnapshot, cfg: MonitorConfig | null): MetricsSnapshot {
  if (!cfg || snap.state !== 'ok') return snap;
  const mounts = list(cfg.mounts);
  const nics = list(cfg.nics);
  const disks = snap.disks.filter((d) => {
    if (mounts.length) return mounts.includes(d.mount);
    if (cfg.hideSpecialFs && (SPECIAL_FS.test(d.mount) || (d.size > 0 && d.size < 200 * 1024 * 1024 && d.mount !== '/'))) return false;
    if (cfg.hideDockerFs && DOCKER_FS.test(d.mount)) return false;
    return true;
  });
  const net = snap.net.filter((n) => (nics.length ? nics.includes(n.name) : !(cfg.hideVirtualNics && VIRTUAL_NIC.test(n.name))));
  return { ...snap, disks, net };
}
