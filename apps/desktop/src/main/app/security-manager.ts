import type { SecurityState } from '@itm/protocol';
import { UserError } from '../util/errors';
import { WrongPasswordError, type KeyStore } from '../services/vault/keystore';

export interface SecurityDeps {
  keystore: KeyStore;
  /** Linux 没有系统钥匙串：必须设置主密码 */
  forceMaster: boolean;
  touchIdAvailable: () => boolean;
  promptTouchId: (reason: string) => Promise<void>;
  /** KEK 解开后打开当前档案（数据库、服务） */
  openProfile: () => void;
  broadcast: (state: SecurityState) => void;
  /** 当前档案的设置：自动锁定分钟数、是否允许 Touch ID（档案还没打开时返回 null） */
  lockSettings: () => { autoLockMin: number; touchId: boolean } | null;
  /** 系统空闲秒数（Electron powerMonitor） */
  idleSeconds: () => number;
}

const MIN_PASSWORD = 8;
/** 连续输错主密码后的等待（毫秒），防止暴力尝试 */
const BACKOFF_MS = [0, 0, 0, 1000, 3000, 10_000, 30_000];

/**
 * 本地密钥与锁定（文档一 10.2）：
 * - 没有主密码：启动时用系统钥匙串解开 KEK，直接进入；
 * - 有主密码：启动时必须输入；无操作 N 分钟、系统锁屏或睡眠时锁定界面（档案保持打开，终端会话继续运行）；
 * - Linux 没有 Secret Service 时强制先设置主密码。
 */
export class SecurityManager {
  private ready = false;
  private locked = false;
  private failures = 0;
  private lastFailure = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: SecurityDeps) {}

  state(): SecurityState {
    return {
      ready: this.ready,
      locked: this.locked,
      masterPassword: this.d.keystore.hasMasterPassword(),
      needsSetup: this.needsSetup(),
      touchIdAvailable: this.d.touchIdAvailable(),
    };
  }

  isReady(): boolean {
    return this.ready;
  }

  isLocked(): boolean {
    return this.locked;
  }

  private needsSetup(): boolean {
    return this.d.forceMaster && !this.d.keystore.hasMasterPassword();
  }

  /** 启动：不需要主密码时直接打开档案 */
  async start(): Promise<void> {
    if (this.needsSetup() || this.d.keystore.hasMasterPassword()) {
      this.emit();
      return;
    }
    await this.d.keystore.unlock();
    this.open();
  }

  /** 冷启动输入主密码，或者锁定后解锁 */
  async unlock(password: string): Promise<void> {
    await this.throttle();
    if (!this.ready) {
      try {
        await this.d.keystore.unlock(password);
      } catch (e) {
        if (e instanceof WrongPasswordError) this.fail();
        throw e instanceof WrongPasswordError ? new UserError(e.message) : e;
      }
      this.failures = 0;
      this.open();
      return;
    }
    if (!(await this.d.keystore.verify(password))) {
      this.fail();
      throw new UserError('主密码不正确');
    }
    this.failures = 0;
    this.locked = false;
    this.emit();
  }

  async unlockTouchId(): Promise<void> {
    if (!this.ready || !this.locked) return;
    if (!this.d.touchIdAvailable() || !this.d.lockSettings()?.touchId) throw new UserError('没有开启 Touch ID 解锁');
    try {
      await this.d.promptTouchId('解锁 iTerminal');
    } catch {
      throw new UserError('Touch ID 验证没有通过');
    }
    this.locked = false;
    this.emit();
  }

  lock(): void {
    if (!this.ready || this.locked) return;
    if (!this.d.keystore.hasMasterPassword()) throw new UserError('请先在「设置 → 安全」里设置主密码，才能锁定');
    this.locked = true;
    this.emit();
  }

  /** 第一次使用前设置主密码（没有系统钥匙串时） */
  async setup(password: string): Promise<void> {
    if (!this.needsSetup()) throw new UserError('已经设置过主密码');
    checkStrength(password);
    await this.d.keystore.unlock();
    await this.d.keystore.setMasterPassword(password);
    this.open();
  }

  async setMasterPassword(newPassword: string, currentPassword?: string): Promise<void> {
    checkStrength(newPassword);
    try {
      await this.d.keystore.setMasterPassword(newPassword, currentPassword);
    } catch (e) {
      throw e instanceof WrongPasswordError ? new UserError('当前主密码不正确') : e;
    }
    this.emit();
  }

  async removeMasterPassword(currentPassword: string): Promise<void> {
    if (this.d.forceMaster) throw new UserError('这台电脑没有可用的系统钥匙串，必须使用主密码');
    try {
      await this.d.keystore.removeMasterPassword(currentPassword);
    } catch (e) {
      throw e instanceof WrongPasswordError ? new UserError('当前主密码不正确') : e;
    }
    this.emit();
  }

  /**
   * 敏感操作前的重新验证（查看凭证明文）：有主密码时校验主密码；没有时在支持的电脑上用 Touch ID；
   * 两者都没有时由界面上的二次确认把关。
   */
  async reauth(password: string | undefined, reason: string): Promise<void> {
    if (this.d.keystore.hasMasterPassword()) {
      await this.throttle();
      if (!password || !(await this.d.keystore.verify(password))) {
        this.fail();
        throw new UserError('主密码不正确');
      }
      this.failures = 0;
      return;
    }
    if (this.d.touchIdAvailable()) {
      try {
        await this.d.promptTouchId(reason);
      } catch {
        throw new UserError('Touch ID 验证没有通过');
      }
    }
  }

  /** 系统锁屏 / 睡眠 */
  onSystemLock(): void {
    if (this.d.keystore.hasMasterPassword()) this.lock();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private open(): void {
    this.d.openProfile();
    this.ready = true;
    this.locked = false;
    this.emit();
    this.timer ??= setInterval(() => this.checkIdle(), 20_000);
  }

  private checkIdle(): void {
    if (!this.ready || this.locked || !this.d.keystore.hasMasterPassword()) return;
    const min = this.d.lockSettings()?.autoLockMin ?? 0;
    if (min > 0 && this.d.idleSeconds() >= min * 60) this.lock();
  }

  private fail(): void {
    this.failures++;
    this.lastFailure = Date.now();
  }

  private async throttle(): Promise<void> {
    const wait = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)] - (Date.now() - this.lastFailure);
    if (wait > 0) throw new UserError(`尝试次数过多，请 ${Math.ceil(wait / 1000)} 秒后再试`);
  }

  private emit(): void {
    this.d.broadcast(this.state());
  }
}

function checkStrength(p: string): void {
  if (typeof p !== 'string' || p.length < MIN_PASSWORD) throw new UserError(`主密码至少 ${MIN_PASSWORD} 位`);
  if (p.length > 256) throw new UserError('主密码太长');
}
