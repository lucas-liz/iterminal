import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { open, seal } from '../vault/vault';
import { hkdf } from '../../util/kdf';
import { UserError } from '../../util/errors';

/** 登录接口返回的用户信息（文档二 6.1） */
export interface LoginUser {
  userId: string | number;
  userName: string;
  nickName?: string | null;
  email?: string | null;
  /** 头像地址（若依的 /profile/avatar/... 相对路径） */
  avatar?: string | null;
  roles?: string[];
  permissions?: string[];
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  /** 访问令牌有效期（秒） */
  expiresIn?: number;
  user: LoginUser;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  savedAt: number;
}

const FILE = 'auth.bin';
const AAD = 'itm-auth-v1';

const keyOf = (vaultKey: Buffer): Buffer => hkdf(vaultKey, 'itm-auth-v1', 'tokens');

/** 服务端地址：补全协议、去掉末尾的 /；允许带路径前缀（例如 Nginx 转发的 /prod-api） */
export function normalizeServerUrl(input: string): string {
  let s = (input ?? '').trim();
  if (!s) throw new UserError('请填写服务端地址');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new UserError('服务端地址格式不正确，例如 https://ops.example.com');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError('服务端地址只支持 http:// 或 https://');
  if (u.username || u.password) throw new UserError('服务端地址里不能带用户名和密码');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

const OS: Record<string, string> = { darwin: 'mac', win32: 'win', linux: 'linux' };

/** 服务端统一响应 {code, message, data}；HTTP 状态码表示成败 */
async function call<T>(
  fetchImpl: typeof fetch,
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  o: { body?: unknown; token?: string | null; deviceId?: string; timeoutMs?: number } = {},
): Promise<{ status: number; data: T | null; message: string }> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.deviceId ? { 'x-device-id': o.deviceId } : {}),
      },
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
    });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const reason = err.name === 'TimeoutError' ? '连接超时' : (err.cause?.code ?? err.cause?.message ?? err.message);
    // 界面上不显示服务端地址（reason 里的地址由 IPC 路由统一替换）
    throw new UserError(`连不上服务端（${reason}）`);
  }
  const text = await res.text();
  type Envelope = { code?: number; message?: string; msg?: string; data?: T };
  let json: Envelope | null;
  try {
    json = text ? (JSON.parse(text) as Envelope) : null;
  } catch {
    json = null;
  }
  return { status: res.status, data: (json?.data ?? null) as T | null, message: json?.message ?? json?.msg ?? (text.startsWith('<') ? '' : text.slice(0, 200)) };
}

/**
 * 账号登录（文档二 6.1）：用户名密码换访问令牌和刷新令牌，同时注册本设备。
 * 密码只用于这次请求，不保存。
 */
export async function accountLogin(o: {
  serverUrl: string;
  username: string;
  password: string;
  deviceId: string;
  clientVersion: string;
  fetchImpl?: typeof fetch;
}): Promise<LoginResult> {
  const r = await call<LoginResult>(o.fetchImpl ?? fetch, o.serverUrl, 'POST', '/api/v1/auth/login', {
    body: {
      username: o.username,
      password: o.password,
      deviceId: o.deviceId,
      deviceName: hostname().slice(0, 100),
      os: OS[process.platform] ?? process.platform,
      arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      clientVersion: o.clientVersion,
    },
  });
  if (r.status === 200 && r.data?.accessToken && r.data.refreshToken && r.data.user) return r.data;
  if (r.status === 404) throw new UserError('这个地址不是 iTerminal 服务端（没有登录接口），请检查地址和路径前缀');
  if (r.status === 401 || r.status === 400 || r.status === 403) throw new UserError(r.message || '用户名或密码不正确');
  throw new UserError(`登录失败（HTTP ${r.status}）${r.message ? `：${r.message}` : ''}`);
}

export type AccountStatus = 'valid' | 'expired' | 'revoked';

/**
 * 账号档案的登录会话：访问令牌和刷新令牌用档案的 vaultKey 加密保存在档案目录（auth.bin），
 * 访问令牌失效（401）时用刷新令牌换新的（单飞，同时只刷新一次），刷新令牌每次使用后轮换。
 * 刷新失败（过期、被吊销）后不再重试，等用户重新输入密码。
 */
export class AccountSession {
  private tokens: Tokens | null;
  private refreshing: Promise<boolean> | null = null;
  private dead: { status: 'expired' | 'revoked'; message: string } | null = null;

  constructor(
    private readonly d: {
      dir: string;
      vaultKey: Buffer;
      baseUrl: string;
      deviceId: string;
      /** 会话失效（需要重新登录）：停止服务端连接、通知界面 */
      onDead(status: 'expired' | 'revoked', message: string): void;
      fetchImpl?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.tokens = AccountSession.read(d.dir, d.vaultKey);
    if (!this.tokens) this.dead = { status: 'expired', message: '请输入密码登录' };
  }

  /** 登录成功后写入令牌（档案还没打开时也能写） */
  static write(dir: string, vaultKey: Buffer, t: { accessToken: string; refreshToken: string }, now = Date.now()): void {
    const tokens: Tokens = { accessToken: t.accessToken, refreshToken: t.refreshToken, savedAt: now };
    const file = join(dir, FILE);
    writeFileSync(`${file}.tmp`, seal(keyOf(vaultKey), JSON.stringify(tokens), AAD), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private static read(dir: string, vaultKey: Buffer): Tokens | null {
    const file = join(dir, FILE);
    if (!existsSync(file)) return null;
    try {
      const t = JSON.parse(open(keyOf(vaultKey), readFileSync(file), AAD)) as Tokens;
      return typeof t.accessToken === 'string' && typeof t.refreshToken === 'string' ? t : null;
    } catch {
      return null;
    }
  }

  private get fetch(): typeof fetch {
    return this.d.fetchImpl ?? fetch;
  }

  state(): { status: AccountStatus; message: string | null } {
    return this.dead ? { status: this.dead.status, message: this.dead.message } : { status: 'valid', message: null };
  }

  async token(): Promise<string | null> {
    return this.currentToken();
  }

  /** 同步取当前的访问令牌（团队模型调用时作为 API Key） */
  currentToken(): string | null {
    return this.dead ? null : (this.tokens?.accessToken ?? null);
  }

  /** 重新登录后换上新令牌（不用重新打开档案） */
  resume(t: { accessToken: string; refreshToken: string }): void {
    AccountSession.write(this.d.dir, this.d.vaultKey, t, (this.d.now ?? Date.now)());
    this.tokens = AccountSession.read(this.d.dir, this.d.vaultKey);
    this.dead = null;
  }

  /** 访问令牌失效时刷新；返回 true 表示已经换上新令牌，可以重试请求 */
  refresh(): Promise<boolean> {
    if (this.dead || !this.tokens) return Promise.resolve(false);
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const old = this.tokens!;
    let r: { status: number; data: { accessToken: string; refreshToken: string } | null; message: string };
    try {
      r = await call<{ accessToken: string; refreshToken: string }>(this.fetch, this.d.baseUrl, 'POST', '/api/v1/auth/refresh', {
        body: { deviceId: this.d.deviceId, refreshToken: old.refreshToken },
      });
    } catch {
      // 网络问题：保留令牌，之后再试
      return false;
    }
    if (r.status === 200 && r.data?.accessToken && r.data.refreshToken) {
      this.resume(r.data);
      return true;
    }
    if (r.status === 401 || r.status === 403) {
      this.kill('expired', r.message || '登录已过期，请重新输入密码');
    }
    return false;
  }

  /** 设备被管理员吊销（device.revoked） */
  revoked(message?: string): void {
    this.kill('revoked', message || '这台设备已被管理员吊销，请重新登录');
  }

  private kill(status: 'expired' | 'revoked', message: string): void {
    if (this.dead) return;
    this.dead = { status, message };
    this.clearFile();
    this.d.onDead(status, message);
  }

  private clearFile(): void {
    this.tokens = null;
    rmSync(join(this.d.dir, FILE), { force: true });
  }

  /** 退出登录：通知服务端注销令牌（失败不影响退出），删除本机令牌 */
  async logout(): Promise<void> {
    const token = this.tokens?.accessToken;
    if (token && !this.dead) {
      await call(this.fetch, this.d.baseUrl, 'POST', '/api/v1/auth/logout', { token, deviceId: this.d.deviceId, timeoutMs: 5000 }).catch(() => undefined);
    }
    this.dead = { status: 'expired', message: '已退出登录' };
    this.clearFile();
  }
}

/**
 * 取回头像缓存成 data URL（侧栏账号卡片显示）：只接受图片、最大 256KB、5 秒超时；失败时返回 null（显示首字母）。
 * 若依的头像是 /profile/... 相对路径，按服务端地址拼接（/profile/** 不需要登录）。
 */
export async function fetchAvatar(serverUrl: string, avatar: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const a = (avatar ?? '').trim();
  if (!a) return null;
  let url: string;
  try {
    url = /^https?:\/\//i.test(a) ? a : `${serverUrl.replace(/\/+$/, '')}/${a.replace(/^\/+/, '')}`;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  try {
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    const type = (r.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!r.ok || !/^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(type)) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length === 0 || buf.length > 256 * 1024) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}
