import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { compareVersions, type PresetConfig, type UpdateChannel, type UpdateState } from '@itm/protocol';
import { UserError } from '../../util/errors';
import { redactServers } from '../../util/redact-server';
import type { DirectInstaller } from './mac-direct';
import { downloadFile, fileNameOf, fileUrl, pickFile, type ReleaseFile } from './package-download';

/** electron-updater 的 AppUpdater 里用到的部分（便于测试时替换） */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  forceDevUpdateConfig: boolean;
  setFeedURL(options: { provider: 'generic'; url: string; channel?: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

interface UpdateInfoLike {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | { version: string; note: string | null }[] | null;
  files?: { url?: string; sha512?: string; size?: number }[];
  /** 旧格式：只有一个文件 */
  path?: string;
  sha512?: string;
  /** 服务端写在 yml 里的最低支持版本 */
  minimumSupportedVersion?: string;
}

interface Config {
  channel: UpdateChannel;
  autoCheck: boolean;
}

const OS: Record<string, string> = { darwin: 'mac', win32: 'win', linux: 'linux' };
/** 「手动下载安装包」用哪种安装包（按优先顺序） */
const INSTALLERS: Record<string, string[]> = { darwin: ['.dmg', '.zip'], win32: ['.exe', '.msi'], linux: ['.AppImage', '.deb', '.rpm'] };
const CHECK_INTERVAL = 6 * 3600_000;

/** 更新源：GET {server}/api/v1/releases/{channel}/{os}/{arch}/latest(-mac|-linux).yml（文档一 11.5） */
export function feedUrlOf(server: string, channel: UpdateChannel, platform = process.platform, arch = process.arch): string {
  return `${server.replace(/\/+$/, '')}/api/v1/releases/${channel}/${OS[platform] ?? platform}/${arch}`;
}

function filesOf(info: UpdateInfoLike): ReleaseFile[] {
  const files = (info.files ?? []).filter((f): f is ReleaseFile => !!f.url);
  return files.length ? files : info.path ? [{ url: info.path, sha512: info.sha512 }] : [];
}

/** 同名文件已经存在时加上 (1)、(2)… */
function freePath(file: string): string {
  const ext = extname(file);
  const base = file.slice(0, file.length - ext.length);
  let p = file;
  for (let i = 1; existsSync(p); i++) p = `${base} (${i})${ext}`;
  return p;
}

function notesOf(n: UpdateInfoLike['releaseNotes']): string | null {
  if (!n) return null;
  if (typeof n === 'string') return n.replace(/<[^>]+>/g, '').trim() || null;
  return n.map((x) => `${x.version}：${(x.note ?? '').replace(/<[^>]+>/g, '').trim()}`).join('\n') || null;
}

/**
 * 自动更新（文档一 11.5）。整个应用一个（不属于档案，解锁前也能检查）；配置保存在 {userData}/update.json。
 * 渠道 stable / beta 可以在「关于」里切换，管理员可以用预置配置锁定；低于最低支持版本时强制升级。
 */
export class UpdaterService {
  private state: UpdateState;
  private config: Config;
  private timer: NodeJS.Timeout | null = null;
  /** 正在试前面的更新源：它们失败时的 error 事件不显示（第十六轮） */
  private probing = false;
  /** 最近一次检查到的新版本：文件列表和当时的更新源（自己下载、手动下载时用） */
  private release: { version: string; feed: string; files: ReleaseFile[] } | null = null;
  /** 自己下载好的更新（第十九轮：macOS ad-hoc 签名的包）；安装时由它替换程序 */
  private prepared: DirectInstaller | null = null;

  constructor(
    private readonly d: {
      updater: UpdaterLike;
      preset: PresetConfig;
      version: string;
      configDir: string;
      emit(state: UpdateState): void;
      /** 测试用：覆盖服务端地址（ITM_UPDATE_SERVER） */
      serverOverride?: string | null;
      /** 管理员在隐藏设置里改的服务端地址（优先于预置和登录账号的地址） */
      adminServer?: () => string | null;
      /** 当前登录账号的服务端地址（没有预置服务端地址时用它） */
      accountServer?: () => string | null;
      /** 默认的服务端地址（第十二轮：没有预置、也没有登录时用默认后台的发布服务） */
      defaultServer?: string | null;
      /** 开发模式下也检查（ITM_UPDATE_FORCE_DEV） */
      forceDev?: boolean;
      now?: () => number;
      /** 不用 electron-updater 下载安装时的替代（第十九轮：macOS ad-hoc 签名，Squirrel.Mac 装不了）；返回 null = 用 electron-updater */
      direct?: () => Promise<DirectInstaller | null>;
      /** 「手动下载安装包」（自动安装不了时的兜底）：保存到哪个目录、怎么下载、保存后打开 */
      manual?: { dir(): string; fetch(url: string): Promise<Response>; open(file: string): void };
      /** 自己安装时退出应用 */
      quit?: () => void;
      platform?: string;
    },
  ) {
    this.config = this.loadConfig();
    const u = d.updater;
    u.autoDownload = false;
    u.autoInstallOnAppQuit = true;
    u.allowDowngrade = false;
    if (d.forceDev) u.forceDevUpdateConfig = true;
    this.state = {
      status: 'idle',
      currentVersion: d.version,
      channel: this.channel(),
      channelLocked: !!d.preset.updateChannel,
      autoCheck: this.config.autoCheck,
      feedUrl: null,
      available: null,
      progress: null,
      error: null,
      forced: false,
      minimumVersion: null,
      lastCheckAt: null,
      savedFile: null,
    };
    this.applyFeed();
    u.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    u.on('update-available', ((info: UpdateInfoLike) => this.onInfo(info, true)) as never);
    u.on('update-not-available', ((info: UpdateInfoLike) => this.onInfo(info, false)) as never);
    u.on('download-progress', ((p: { percent: number; bytesPerSecond: number; transferred: number; total: number }) =>
      this.set({ status: 'downloading', progress: { percent: p.percent, bytesPerSecond: p.bytesPerSecond, transferred: p.transferred, total: p.total } })) as never);
    u.on('update-downloaded', () => this.set({ status: 'downloaded', progress: null }));
    u.on('error', ((e: Error) => {
      if (!this.probing) this.set({ status: 'error', error: describe(e) });
    }) as never);
  }

  get(): UpdateState {
    return { ...this.state };
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private channel(): UpdateChannel {
    return this.d.preset.updateChannel ?? this.config.channel;
  }

  private loadConfig(): Config {
    const file = join(this.d.configDir, 'update.json');
    const fallback: Config = { channel: 'stable', autoCheck: true };
    if (!existsSync(file)) return fallback;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>;
      // 旧版本保存的自定义更新源（customFeed）不再使用（第十二轮去掉了这个设置）
      return { channel: raw.channel === 'beta' ? 'beta' : 'stable', autoCheck: raw.autoCheck !== false };
    } catch {
      return fallback;
    }
  }

  private saveConfig(): void {
    const file = join(this.d.configDir, 'update.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(this.config, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  /** 切换档案（登录 / 退出登录）后重新确定更新源 */
  refreshFeed(): void {
    this.applyFeed();
  }

  /**
   * 候选的更新源，按优先级：测试覆盖 > 管理员设置的地址 > 预置服务端地址 > 登录账号的服务端 > 默认后台（去重）。
   * 检查时前面的连不上或者没有这个渠道 / 平台的版本信息，就换下一个（第十六轮：例如管理员把地址改成了本机开发后端，
   * 它没在运行时仍然能从默认后台检查更新）。
   */
  feeds(): string[] {
    const servers = [this.d.serverOverride, this.d.adminServer?.(), this.d.preset.serverUrl, this.d.accountServer?.(), this.d.defaultServer];
    return [...new Set(servers.filter((x): x is string => !!x).map((x) => feedUrlOf(x, this.channel())))];
  }

  private useFeed(url: string): void {
    this.d.updater.setFeedURL({ provider: 'generic', url });
    this.state = { ...this.state, feedUrl: url };
  }

  private applyFeed(): void {
    const url = this.feeds()[0] ?? null;
    if (url) this.d.updater.setFeedURL({ provider: 'generic', url });
    this.set({ feedUrl: url, channel: this.channel(), status: url ? (this.state.status === 'disabled' ? 'idle' : this.state.status) : 'disabled' });
  }

  private onInfo(info: UpdateInfoLike, available: boolean): void {
    const min = info.minimumSupportedVersion ?? null;
    const forced = !!min && compareVersions(this.d.version, min) < 0;
    const feed = this.state.feedUrl;
    if (!available || !feed) {
      this.release = null;
      this.prepared = null;
    } else if (this.release?.version !== info.version || this.release.feed !== feed) {
      this.release = { version: info.version, feed, files: filesOf(info) };
      this.prepared = null;
      this.state = { ...this.state, savedFile: null };
    }
    // 自己下载好的同一个版本：定时检查不要把「已下载」改回「有新版本」
    const ready = available && !!this.prepared;
    this.set({
      status: ready ? 'downloaded' : available ? 'available' : 'not-available',
      lastCheckAt: this.now(),
      minimumVersion: min,
      forced: forced && available,
      available: available
        ? { version: info.version, releaseDate: info.releaseDate ?? null, notes: notesOf(info.releaseNotes), size: info.files?.reduce((a, f) => a + (f.size ?? 0), 0) || null }
        : null,
    });
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.d.emit(this.get());
  }

  async check(): Promise<UpdateState> {
    if (!this.state.feedUrl) return this.get();
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.get();
    const feeds = this.feeds();
    for (let i = 0; i < feeds.length; i++) {
      const last = i === feeds.length - 1;
      this.useFeed(feeds[i]);
      this.probing = !last;
      try {
        const r = await this.d.updater.checkForUpdates();
        this.probing = false;
        // 开发模式（没打包、也没强制）时 electron-updater 直接返回 null
        if (r === null) this.set({ status: 'idle', error: '开发模式下不检查更新' });
        return this.get();
      } catch (e) {
        this.probing = false;
        // 连不上、或者这个更新源上没有版本信息：换下一个；其他错误（例如签名、格式）直接显示
        if (last || !fallbackable(e as Error)) {
          this.set({ status: 'error', error: describe(e as Error), lastCheckAt: this.now() });
          return this.get();
        }
      }
    }
    return this.get();
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available' && this.state.status !== 'error') throw new UserError('没有可以下载的更新');
    this.set({ status: 'downloading', progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: this.state.available?.size ?? 0 }, error: null });
    try {
      const r = this.release;
      const direct = r ? ((await this.d.direct?.()) ?? null) : null;
      if (r && direct) {
        const f = pickFile(r.files, direct.exts);
        if (!f) throw new UserError(`更新服务上没有 ${direct.exts.join(' / ')} 格式的安装包`);
        this.prepared = null;
        await direct.prepare({ url: fileUrl(r.feed, f.url), sha512: f.sha512, size: f.size, version: r.version, onProgress: (p) => this.set({ status: 'downloading', progress: p }) });
        this.prepared = direct;
        this.set({ status: 'downloaded', progress: null });
      } else {
        await this.d.updater.downloadUpdate();
      }
    } catch (e) {
      this.set({ status: 'error', error: describe(e as Error), progress: null });
    }
    return this.get();
  }

  install(): void {
    if (this.state.status !== 'downloaded') throw new UserError('更新还没有下载完成');
    if (this.prepared) {
      this.prepared.install(true);
      this.d.quit?.();
      return;
    }
    this.d.updater.quitAndInstall(false, true);
  }

  /** 应用退出时安装自己下载好的更新（和 electron-updater 的 autoInstallOnAppQuit 一样，不重新打开） */
  installOnQuit(): void {
    if (this.state.status === 'downloaded') this.prepared?.install(false);
  }

  /**
   * 手动下载安装包（第十九轮）：自动安装不了时（例如签名校验不过），把这个系统的安装包下载到「下载」目录（校验 SHA-512）并打开，
   * 由用户自己安装。界面上不显示下载地址。
   */
  async saveInstaller(): Promise<UpdateState> {
    const m = this.d.manual;
    const r = this.release;
    if (!m || !r) throw new UserError('没有可以下载的更新，请先检查更新');
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.get();
    const f = pickFile(r.files, INSTALLERS[this.d.platform ?? process.platform] ?? []);
    if (!f) throw new UserError('更新服务上没有这个系统的安装包');
    const before = { status: this.state.status, error: this.state.error };
    this.set({ status: 'downloading', progress: { percent: 0, bytesPerSecond: 0, transferred: 0, total: f.size ?? 0 }, error: null });
    try {
      const dest = freePath(join(m.dir(), fileNameOf(f.url)));
      await downloadFile({ url: fileUrl(r.feed, f.url), dest, sha512: f.sha512, size: f.size, fetch: m.fetch, onProgress: (p) => this.set({ progress: p }) });
      this.set({ ...before, progress: null, savedFile: dest });
      m.open(dest);
    } catch (e) {
      this.set({ status: 'error', error: describe(e as Error), progress: null });
    }
    return this.get();
  }

  configure(p: { channel?: UpdateChannel; autoCheck?: boolean }): UpdateState {
    if (p.channel !== undefined) {
      if (this.d.preset.updateChannel) throw new UserError('更新渠道已由管理员锁定');
      if (p.channel !== 'stable' && p.channel !== 'beta') throw new UserError('渠道不正确');
      this.config.channel = p.channel;
    }
    if (p.autoCheck !== undefined) this.config.autoCheck = !!p.autoCheck;
    this.saveConfig();
    // 换了渠道，之前的检查结果作废
    this.state = { ...this.state, autoCheck: this.config.autoCheck, available: null, forced: false, status: 'idle', error: null };
    this.applyFeed();
    this.schedule();
    return this.get();
  }

  /** 启动后延迟检查一次，之后每 6 小时检查（自动检查开启时） */
  start(delayMs = 10_000): void {
    this.schedule(delayMs);
  }

  private schedule(firstDelay = CHECK_INTERVAL): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.config.autoCheck || !this.state.feedUrl) return;
    this.timer = setTimeout(() => {
      void this.check().finally(() => this.schedule());
    }, firstDelay);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** 换下一个更新源也许能好的错误：连不上、超时、域名解析失败、404（这个服务端没有发布版本） */
function fallbackable(e: Error): boolean {
  return /ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_TIMED_OUT|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|\b404\b|\b502\b|\b503\b|\b504\b/i.test(e?.message ?? String(e));
}

function describe(e: Error): string {
  if (e instanceof UserError) return e.message;
  // 错误信息里常带着更新地址：界面上不显示服务端地址
  const msg = redactServers(e?.message ?? String(e));
  // Windows：app-update.yml 里有 publisherName，新版本没签名或者证书不同（第十九轮）
  if (/is not signed by the application owner/i.test(msg)) return '新版本安装包的签名和当前程序的发布者不一致，不能自动安装，请点「手动下载安装包」安装';
  // macOS：Squirrel.Mac 校验新版本的代码签名不满足当前程序的要求（ad-hoc 签名的包每次构建都不一样）
  if (/did not pass validation|failed to satisfy|代码未能满足/i.test(msg)) return '新版本的代码签名和当前程序不一致，macOS 拒绝自动安装，请点「手动下载安装包」安装';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(msg)) return `无法连接到更新服务：${msg.split('\n')[0]}`;
  if (/404/.test(msg)) return '更新服务上没有这个渠道 / 平台的版本信息（404）';
  if (/sha512 checksum mismatch/i.test(msg)) return '下载的安装包校验失败，请重试';
  if (/code signature|signature/i.test(msg)) return `安装包签名校验失败：${msg.split('\n')[0]}`;
  return msg.split('\n')[0];
}
