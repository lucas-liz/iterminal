import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { AdminServerConfig, AdminServerTest } from '@itm/protocol';
import { UserError } from '../../util/errors';
import { normalizeServerUrl } from './account-session';

/**
 * 隐藏的服务端地址设置：设置 → 关于里连续点 5 次软件图标，输入管理员密码后可以修改连接的服务端地址。
 * 界面上平时不显示服务端地址；地址保存在应用级的 {userData}/server-config.json（所有档案共用）。
 * 管理员密码只保存 scrypt 哈希，不保存明文；在主进程里校验，连续输错 5 次锁定 5 分钟。
 */
const ADMIN = {
  salt: '750941b2faae982561fae6b1aea875ae',
  hash: '3c1e560647237e8956f0253ba3f28f0212b7df6fe519602e9adb0274dc9acbcc',
};
const TOKEN_MS = 10 * 60_000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60_000;

export class ServerConfigStore {
  private readonly tokens = new Map<string, number>();
  private fails = 0;
  private lockedUntil = 0;

  constructor(
    private readonly d: {
      file: string;
      /** 是否有企业预置的地址（只用来告诉管理员当前用的是哪个） */
      presetUrl: () => string | null;
      /** 测试用：替换管理员密码（只在没有打包时由 ITM_ADMIN_PASSWORD 传入） */
      testPassword?: string | null;
      /** 测试用：替换密码哈希 */
      admin?: { salt: string; hash: string };
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  /** 管理员设置的地址（没有设置时为 null） */
  custom(): string | null {
    if (!existsSync(this.d.file)) return null;
    try {
      const v = (JSON.parse(readFileSync(this.d.file, 'utf8')) as { serverUrl?: unknown }).serverUrl;
      return typeof v === 'string' && v ? normalizeServerUrl(v) : null;
    } catch {
      return null;
    }
  }

  private verify(password: string): boolean {
    if (this.d.testPassword) {
      const a = Buffer.from(password);
      const b = Buffer.from(this.d.testPassword);
      return a.length === b.length && timingSafeEqual(a, b);
    }
    const admin = this.d.admin ?? ADMIN;
    const got = scryptSync(password, Buffer.from(admin.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
    return timingSafeEqual(got, Buffer.from(admin.hash, 'hex'));
  }

  /** 校验管理员密码，换一个 10 分钟有效的令牌（只在主进程内存里） */
  unlock(password: string): { token: string; expiresAt: number } {
    const now = this.now();
    if (now < this.lockedUntil) throw new UserError(`密码错误次数太多，请 ${Math.ceil((this.lockedUntil - now) / 60_000)} 分钟后再试`);
    if (typeof password !== 'string' || !password || !this.verify(password)) {
      this.fails++;
      if (this.fails >= MAX_FAILS) {
        this.fails = 0;
        this.lockedUntil = now + LOCK_MS;
        throw new UserError('密码错误次数太多，请 5 分钟后再试');
      }
      throw new UserError('密码错误');
    }
    this.fails = 0;
    for (const [t, exp] of this.tokens) if (exp <= now) this.tokens.delete(t);
    const token = randomBytes(24).toString('hex');
    const expiresAt = now + TOKEN_MS;
    this.tokens.set(token, expiresAt);
    return { token, expiresAt };
  }

  private check(token: string): void {
    const exp = this.tokens.get(String(token ?? ''));
    if (!exp || exp <= this.now()) throw new UserError('管理员验证已过期，请重新输入密码');
  }

  get(token: string): AdminServerConfig {
    this.check(token);
    return this.state();
  }

  private state(): AdminServerConfig {
    const custom = this.custom();
    return { custom, source: custom ? 'custom' : this.d.presetUrl() ? 'preset' : 'default' };
  }

  /** 保存地址；null / 空字符串 = 恢复默认 */
  set(token: string, url: string | null): AdminServerConfig {
    this.check(token);
    const v = url && url.trim() ? normalizeServerUrl(url) : null;
    const tmp = `${this.d.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(v ? { serverUrl: v } : {}, null, 2), { mode: 0o600 });
    renameSync(tmp, this.d.file);
    return this.state();
  }

  /**
   * 测试连接：调用不用登录的刷新令牌接口（带一个空令牌，不会影响任何账号），
   * 返回 iTerminal 服务端的 JSON 就算成功；连不上、404、不是 JSON 都说明原因。
   */
  async test(token: string, url: string): Promise<AdminServerTest> {
    this.check(token);
    const base = normalizeServerUrl(url);
    const t0 = this.now();
    let res: Response;
    try {
      res = await (this.d.fetchImpl ?? fetch)(`${base}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: '' }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      const reason = err.name === 'TimeoutError' ? '连接超时' : (err.cause?.code ?? err.cause?.message ?? err.message);
      return { ok: false, message: `连不上（${reason}）`, ms: this.now() - t0 };
    }
    const ms = this.now() - t0;
    const text = await res.text().catch(() => '');
    let j: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(text);
      j = v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      j = null;
    }
    const msg = String(j?.message ?? j?.msg ?? '');
    if (res.status === 404 || !j || !('code' in j) || /No static resource|Not Found/i.test(msg)) {
      return { ok: false, message: `这个地址不是 iTerminal 服务端（HTTP ${res.status}），请检查地址和路径前缀（例如 /prod-api）`, ms };
    }
    return { ok: true, message: `连接成功，是 iTerminal 服务端（${ms} ms）`, ms };
  }
}
