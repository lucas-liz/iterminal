import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SERVER_URL, LEGACY_SERVER_URLS } from '@itm/protocol';

/**
 * 档案（文档一第 8 章开头）：本地模式和每个登录账号各有一个独立的目录和加密库，数据互不可见。
 * 清单保存在 {userData}/profiles/profiles.json（不含敏感信息）。
 */
export interface ProfileEntry {
  id: string;
  kind: 'local' | 'account';
  /** 账号档案：服务端用户 ID、登录名、显示名、服务端地址 */
  userId?: string;
  username?: string;
  displayName?: string;
  serverUrl?: string;
  /** 邮箱、头像（data URL，登录时从服务端取回） */
  email?: string;
  avatar?: string;
  createdAt: number;
}

interface Manifest {
  current: string;
  profiles: ProfileEntry[];
}

export const LOCAL_PROFILE = 'local';

export class ProfileStore {
  constructor(
    readonly root: string,
    private readonly now: () => number = Date.now,
    private readonly migration: { defaultUrl?: string | null; legacyUrls?: readonly string[] } = {},
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private get file(): string {
    return join(this.root, 'profiles.json');
  }

  private read(): Manifest {
    const fallback: Manifest = { current: LOCAL_PROFILE, profiles: [{ id: LOCAL_PROFILE, kind: 'local', createdAt: this.now() }] };
    if (!existsSync(this.file)) return fallback;
    try {
      const m = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Manifest>;
      const profiles = Array.isArray(m.profiles) ? m.profiles.filter((p) => p && typeof p.id === 'string' && /^[\w-]+$/.test(p.id)) : [];
      if (!profiles.some((p) => p.id === LOCAL_PROFILE)) profiles.unshift(fallback.profiles[0]);
      const current = profiles.some((p) => p.id === m.current) ? m.current! : LOCAL_PROFILE;
      // 以前的默认地址换成现在的默认地址；档案 ID（目录）不变
      const targetUrl = (this.migration.defaultUrl ?? DEFAULT_SERVER_URL) || null;
      const legacyUrls = this.migration.legacyUrls ?? LEGACY_SERVER_URLS;
      const migrate = (p: ProfileEntry): ProfileEntry =>
        targetUrl && p.serverUrl && legacyUrls.includes(p.serverUrl) ? { ...p, serverUrl: targetUrl } : p;
      return { current, profiles: profiles.map((p) => migrate({ ...p, createdAt: p.createdAt ?? this.now() })) };
    } catch {
      return fallback;
    }
  }

  private write(m: Manifest): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, this.file);
  }

  list(): ProfileEntry[] {
    return this.read().profiles;
  }

  get(id: string): ProfileEntry | null {
    return this.read().profiles.find((p) => p.id === id) ?? null;
  }

  current(): ProfileEntry {
    const m = this.read();
    if (!existsSync(this.file)) this.write(m);
    return m.profiles.find((p) => p.id === m.current)!;
  }

  setCurrent(id: string): void {
    const m = this.read();
    if (!m.profiles.some((p) => p.id === id)) throw new Error(`档案不存在：${id}`);
    this.write({ ...m, current: id });
  }

  /**
   * 账号档案：同一个账号（服务端地址 + 用户 ID）始终对应同一个目录 u_{userId}_{地址摘要}。
   * 不同服务端的用户 ID 会重复（例如管理员都是 1），所以目录名里带上服务端地址的摘要。
   */
  ensureAccount(a: { userId: string; username: string; displayName: string; serverUrl: string; email?: string; avatar?: string }): ProfileEntry {
    const m = this.read();
    const server = createHash('sha256').update(a.serverUrl.toLowerCase()).digest('hex').slice(0, 8);
    const computed = `u_${a.userId.replace(/[^\w-]/g, '').slice(0, 32)}_${server}`;
    // 地址迁移过的档案（目录名是按旧地址算的）：同一个服务端的同一个用户仍然用原来的档案
    const existing =
      m.profiles.find((p) => p.id === computed) ??
      m.profiles.find((p) => p.kind === 'account' && p.userId === a.userId && p.serverUrl?.toLowerCase() === a.serverUrl.toLowerCase());
    const id = existing?.id ?? computed;
    const entry: ProfileEntry = { ...(existing ?? { createdAt: this.now() }), id, kind: 'account', ...a };
    this.write({ ...m, profiles: [...m.profiles.filter((p) => p.id !== id), entry] });
    return entry;
  }

  dir(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error('档案 ID 不合法');
    const d = join(this.root, id);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  /** 删除档案目录（退出登录并清除本机数据），本地档案不能删除 */
  remove(id: string): void {
    if (id === LOCAL_PROFILE) throw new Error('不能删除本地档案');
    const m = this.read();
    rmSync(join(this.root, id), { recursive: true, force: true });
    this.write({ current: m.current === id ? LOCAL_PROFILE : m.current, profiles: m.profiles.filter((p) => p.id !== id) });
  }

  /** 密钥解不开时，把档案目录改名留档后重新开始（用户在启动失败的对话框里确认） */
  quarantine(id: string): string {
    const from = join(this.root, id);
    const to = join(this.root, `${id}.broken-${this.now()}`);
    if (existsSync(from)) renameSync(from, to);
    return to;
  }
}
