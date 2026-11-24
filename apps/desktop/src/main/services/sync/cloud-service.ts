import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { CloudBackupInfo, CloudShareInfo, CloudStatus, ItemCounts, ShareContent, ShareImportPick, ShareLinkCreated, ShareLinkInfo, ShareLinkOptions, SharePreview, ShareSelection, ShareSelectionPreview, SyncGroup, SyncReport } from '@itm/protocol';
import type { Dataset } from '@itm/sync-merge';
import { pickForImport, shareContent } from './share-pick';
import { open as openVault, seal as sealVault } from '../vault/vault';
import { hkdf } from '../../util/kdf';
import { UserError } from '../../util/errors';
import { envelopeError, OLD_SERVER } from '../../util/envelope';

/** 第二十二轮新增了 Skill 分组：还没升级的服务端会拒绝，换成能看懂的提示 */
function skillGroupError(msg: string): string {
  return /分组不正确：SKILLS/.test(msg) ? '服务端版本较旧，还不支持备份 / 分享 Skill：请联系管理员升级服务端，或者这次先不选 Skill' : msg;
}
import type { ServerLink } from '../server/server-link';
import type { SyncService } from './sync-service';
import { pack, readHeader, unpack } from './itmbak';
import { createCdk, formatShareCode, generateShareCode, normalizeShareCode, openWith, resetWithRecovery, rewrapCdk, sealWith, shareKeys, unwrapCdk, type WrappedCdk } from './e2e-crypto';

interface E2eKeyResponse extends WrappedCdk {
  etag: string;
}

interface ShareResponse {
  codeE2e?: string;
  e2eKeyVersion?: number;
  dataGroups: SyncGroup[];
  enabled: boolean;
  content: { groups: SyncGroup[]; counts: ItemCounts; size: number; updatedAt: number | null } | null;
  pullCount: number;
  lastPulledAt: number | null;
  createdAt: number | null;
}

const CODE_AAD = 'itm-share-code';
/** 拉取时下载解密的明文在内存里保留多久 */
const OPEN_TTL_MS = 10 * 60_000;

interface LinkResponse {
  id: string;
  title: string;
  groups: SyncGroup[];
  counts: Partial<ItemCounts>;
  expiresAt: number | null;
  maxPulls: number;
  pullCount: number;
  lastPulledAt: number | null;
  expired: boolean;
  exhausted: boolean;
  size: number;
  createdAt: number;
  codeE2e?: string;
  e2eKeyVersion?: number;
}
const PLATFORM: Record<string, string> = { darwin: 'macos', win32: 'windows', linux: 'linux' };

/**
 * 云备份和个人分享码（文档一 6.10）。所有加密都在客户端：
 * - 同步密码 → 解开托管的 CDK，CDK 按版本加密缓存在档案目录（cdk.bin），这台设备之后不用再输入；
 * - 云备份：选定分组打包成 .itmbak（CDK 加密）上传；恢复时下载、解密，按 6.10.7 合并或覆盖；
 * - 分享码：客户端生成，CDK 加密后托管；分享包用分享码派生的 shareKey 加密；拉取方只需要分享码。
 */
export class CloudService {
  /** 拉取时解密好的分享内容（规范化的分享码 → 数据），10 分钟后或者关闭对话框时清除 */
  private opened = new Map<string, { data: Dataset; preview: SharePreview; at: number }>();

  constructor(
    private readonly d: {
      link: Pick<ServerLink, 'rawRequest'>;
      sync: SyncService;
      dir: string;
      vaultKey: Buffer;
      clientVersion: string;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  // ---------------------------------------------------------------- HTTP

  /** JSON 请求：服务端统一响应 {code, message, data}，出错时用服务端的提示 */
  private async json<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ data: T; etag: string | null }> {
    const res = await this.d.link.rawRequest(method, path, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    });
    const text = await res.text();
    type Envelope = { message?: string; msg?: string; data?: T };
    let j: Envelope | null;
    try {
      j = text ? (JSON.parse(text) as Envelope) : null;
    } catch {
      j = null;
    }
    const err = envelopeError(res.status, j);
    if (err) throw new UserError(skillGroupError(err));
    return { data: (j?.data ?? null) as T, etag: res.headers.get('etag') };
  }

  private async download(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Buffer> {
    const res = await this.d.link.rawRequest(method, path, {
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      timeoutMs: 300_000,
    });
    // 失败，或者旧版服务端没有这个接口（若依返回 HTTP 200 + JSON 错误）
    if (!res.ok || /application\/json/i.test(res.headers.get('content-type') ?? '')) {
      const text = await res.text();
      let j: unknown = null;
      try {
        j = JSON.parse(text);
      } catch {
        // 不是 JSON
      }
      throw new UserError(envelopeError(res.ok ? 500 : res.status, j) ?? `服务端返回 ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async uploadFile<T>(method: 'POST' | 'PUT', path: string, meta: Record<string, unknown>, file: Buffer): Promise<T> {
    const form = new FormData();
    form.append('meta', JSON.stringify({ ...meta, sha256: createHash('sha256').update(file).digest('hex') }));
    form.append('file', new Blob([new Uint8Array(file)]), 'package.itmbak');
    const res = await this.d.link.rawRequest(method, path, { body: form, timeoutMs: 300_000 });
    const text = await res.text();
    type Envelope = { message?: string; data?: T };
    let j: Envelope | null;
    try {
      j = text ? (JSON.parse(text) as Envelope) : null;
    } catch {
      j = null;
    }
    const err = envelopeError(res.status, j);
    if (err) throw new UserError(skillGroupError(err));
    if (j?.data === undefined || j?.data === null) throw new UserError(OLD_SERVER);
    return j.data as T;
  }

  // ---------------------------------------------------------------- CDK 缓存

  private get cdkFile(): string {
    return join(this.d.dir, 'cdk.bin');
  }

  private cacheKey(): Buffer {
    return hkdf(this.d.vaultKey, 'itm-cdk-cache-v1', 'cdk');
  }

  /** 按 keyVersion 缓存的 CDK（轮换后保留旧版本，用来恢复旧备份） */
  private cachedKeys(): Record<string, string> {
    if (!existsSync(this.cdkFile)) return {};
    try {
      return (JSON.parse(openVault(this.cacheKey(), readFileSync(this.cdkFile), 'itm-cdk-cache')) as { keys: Record<string, string> }).keys ?? {};
    } catch {
      return {};
    }
  }

  private saveCdk(version: number, cdk: Buffer): void {
    const keys = { ...this.cachedKeys(), [String(version)]: cdk.toString('base64') };
    writeFileSync(`${this.cdkFile}.tmp`, sealVault(this.cacheKey(), JSON.stringify({ keys }), 'itm-cdk-cache'), { mode: 0o600 });
    renameSync(`${this.cdkFile}.tmp`, this.cdkFile);
  }

  private cdkOf(version: number): Buffer | null {
    const v = this.cachedKeys()[String(version)];
    return v ? Buffer.from(v, 'base64') : null;
  }

  private async e2eKey(): Promise<E2eKeyResponse | null> {
    const r = await this.json<E2eKeyResponse | null>('GET', '/api/v1/sync/e2e-key');
    return r.data ? { ...r.data, etag: r.etag ?? r.data.etag } : null;
  }

  /** 当前版本的 CDK；没设置或这台设备还没解锁时报错 */
  private async currentCdk(): Promise<{ cdk: Buffer; keyVersion: number }> {
    const k = await this.e2eKey();
    if (!k) throw new UserError('请先设置同步密码');
    const cdk = this.cdkOf(k.keyVersion);
    if (!cdk) throw new UserError('请先输入同步密码解锁（这台设备还没有解锁过）');
    return { cdk, keyVersion: k.keyVersion };
  }

  // ---------------------------------------------------------------- 同步密码

  async status(): Promise<CloudStatus> {
    const k = await this.e2eKey();
    return { configured: !!k, unlocked: !!k && !!this.cdkOf(k.keyVersion), keyVersion: k?.keyVersion ?? null };
  }

  /** 首次设置同步密码：生成 CDK 和恢复码（恢复码只返回这一次） */
  async setupPassword(password: string): Promise<{ recoveryCode: string }> {
    if (await this.e2eKey()) throw new UserError('已经设置过同步密码，可以修改或用恢复码重置');
    const { cdk, wrapped, recoveryCode } = await createCdk(password, 1);
    await this.json('PUT', '/api/v1/sync/e2e-key', { wrappedCdk: wrapped.wrappedCdk, recoveryWrappedCdk: wrapped.recoveryWrappedCdk, kdf: wrapped.kdf, keyVersion: 1 });
    this.saveCdk(1, cdk);
    return { recoveryCode };
  }

  /** 新设备：输入同步密码解开 CDK，之后这台设备不用再输入 */
  async unlock(password: string): Promise<CloudStatus> {
    const k = await this.e2eKey();
    if (!k) throw new UserError('还没有设置同步密码');
    this.saveCdk(k.keyVersion, await unwrapCdk(k, password));
    return this.status();
  }

  /** 忘记同步密码：用恢复码重置（同时生成新的恢复码） */
  async recover(recoveryCode: string, newPassword: string): Promise<{ recoveryCode: string }> {
    const k = await this.e2eKey();
    if (!k) throw new UserError('还没有设置同步密码');
    const r = await resetWithRecovery(k, recoveryCode, newPassword);
    await this.json('PUT', '/api/v1/sync/e2e-key', { wrappedCdk: r.wrapped.wrappedCdk, recoveryWrappedCdk: r.wrapped.recoveryWrappedCdk, kdf: r.wrapped.kdf, keyVersion: k.keyVersion }, { 'if-match': k.etag });
    this.saveCdk(k.keyVersion, r.cdk);
    return { recoveryCode: r.recoveryCode };
  }

  /** 修改同步密码：只重新包装 CDK（需要这台设备已经解锁） */
  async changePassword(newPassword: string): Promise<void> {
    const k = await this.e2eKey();
    if (!k) throw new UserError('还没有设置同步密码');
    const cdk = this.cdkOf(k.keyVersion);
    if (!cdk) throw new UserError('请先输入当前的同步密码解锁');
    const w = await rewrapCdk(cdk, newPassword, k.keyVersion);
    await this.json('PUT', '/api/v1/sync/e2e-key', { wrappedCdk: w.wrappedCdk, kdf: w.kdf, keyVersion: k.keyVersion }, { 'if-match': k.etag });
  }

  // ---------------------------------------------------------------- 云备份

  private header(kind: 'backup' | 'share', groups: SyncGroup[], counts: ItemCounts) {
    return {
      createdAt: this.now(),
      deviceName: hostname().slice(0, 64),
      platform: PLATFORM[process.platform] ?? process.platform,
      clientVersion: this.d.clientVersion,
      groups,
      counts,
      kind,
    };
  }

  async listBackups(): Promise<CloudBackupInfo[]> {
    const { data } = await this.json<(Omit<CloudBackupInfo, 'id' | 'keyMissing'> & { id: number | string })[]>('GET', '/api/v1/backups');
    return (data ?? []).map((b) => ({ ...b, id: String(b.id), keyMissing: !this.cdkOf(b.keyVersion) }));
  }

  /** 上传备份；开启了分享码时顺带刷新分享包（失败不影响备份） */
  async upload(groups: SyncGroup[], remark?: string): Promise<CloudBackupInfo> {
    const { cdk, keyVersion } = await this.currentCdk();
    const pkg = this.d.sync.packageData(groups);
    const h = this.header('backup', pkg.groups, pkg.counts);
    const file = pack({ ...h, keyVersion, enc: { alg: 'AES-256-GCM', key: 'cdk', keyVersion } }, pkg.body, cdk);
    const b = await this.uploadFile<Omit<CloudBackupInfo, 'id' | 'keyMissing'> & { id: number }>('POST', '/api/v1/backups', { formatVersion: 2, ...h, keyVersion, remark: (remark ?? '').slice(0, 200) }, file);
    this.d.sync.markBackedUp(h.createdAt);
    await this.refreshShare().catch(() => undefined);
    return { ...b, id: String(b.id), keyMissing: false };
  }

  async restore(id: string, groups: SyncGroup[], mode: 'merge' | 'replace', dryRun: boolean): Promise<SyncReport> {
    const buf = await this.download('GET', `/api/v1/backups/${encodeURIComponent(id)}/content`);
    const { header } = readHeader(buf);
    if (header.kind !== 'backup' || header.enc?.key !== 'cdk') throw new UserError('这不是云备份文件');
    const cdk = this.cdkOf(header.enc.keyVersion);
    if (!cdk) throw new UserError(`这份备份用的是旧密钥（版本 ${header.enc.keyVersion}），这台设备上没有，无法恢复`);
    const { body } = unpack(buf, cdk, '备份无法解密（密钥不对或文件已损坏）');
    const g = groups.filter((x) => header.groups.includes(x));
    if (!g.length) throw new UserError('这份备份里没有选中的分组');
    return this.d.sync.importDataset(body, g, mode, dryRun, `从云端备份恢复之前`);
  }

  async updateBackup(id: string, p: { remark?: string; pinned?: boolean }): Promise<CloudBackupInfo> {
    const { data } = await this.json<Omit<CloudBackupInfo, 'id' | 'keyMissing'> & { id: number }>('PATCH', `/api/v1/backups/${encodeURIComponent(id)}`, p);
    return { ...data, id: String(data.id), keyMissing: !this.cdkOf(data.keyVersion) };
  }

  async deleteBackup(id: string): Promise<void> {
    await this.json('DELETE', `/api/v1/backups/${encodeURIComponent(id)}`);
  }

  // ---------------------------------------------------------------- 我的分享码

  private async myShareRaw(): Promise<ShareResponse | null> {
    return (await this.json<ShareResponse | null>('GET', '/api/v1/shares/me')).data;
  }

  /** 解开托管的分享码（需要 CDK） */
  private codeOf(s: ShareResponse): string | null {
    if (!s.codeE2e || !s.e2eKeyVersion) return null;
    const cdk = this.cdkOf(s.e2eKeyVersion);
    if (!cdk) return null;
    try {
      return openWith(cdk, Buffer.from(s.codeE2e, 'base64'), CODE_AAD).toString('utf8');
    } catch {
      return null;
    }
  }

  private view(s: ShareResponse | null): CloudShareInfo | null {
    if (!s) return null;
    const code = this.codeOf(s);
    const norm = code ? normalizeShareCode(code) : null;
    return {
      enabled: s.enabled,
      dataGroups: s.dataGroups,
      maskedCode: norm ? `ITM-${norm.slice(0, 5)}-•••••-•••••-•••••-${norm.slice(20)}` : null,
      content: s.content ? { groups: s.content.groups, counts: s.content.counts, size: s.content.size, updatedAt: s.content.updatedAt } : null,
      pullCount: s.pullCount ?? 0,
      lastPulledAt: s.lastPulledAt ?? null,
      createdAt: s.createdAt ?? null,
    };
  }

  async share(): Promise<CloudShareInfo | null> {
    return this.view(await this.myShareRaw());
  }

  /** 开启（或重置）分享码：生成新码、用 CDK 托管，然后上传分享包 */
  private async setShare(groups: SyncGroup[], code: string): Promise<CloudShareInfo> {
    const { cdk, keyVersion } = await this.currentCdk();
    const { lookupToken } = shareKeys(code);
    await this.json('PUT', '/api/v1/shares/me', { lookupToken, codeE2e: sealWith(cdk, Buffer.from(code, 'utf8'), CODE_AAD).toString('base64'), e2eKeyVersion: keyVersion, dataGroups: groups });
    return this.refreshShare();
  }

  async enableShare(groups: SyncGroup[]): Promise<CloudShareInfo> {
    if (!groups.length) throw new UserError('请至少选择一个分享范围');
    const cur = await this.myShareRaw();
    const code = cur ? this.codeOf(cur) : null;
    return this.setShare(groups, code ?? generateShareCode());
  }

  async resetShare(): Promise<CloudShareInfo> {
    const cur = await this.myShareRaw();
    if (!cur) throw new UserError('还没有开启分享码');
    return this.setShare(cur.dataGroups, generateShareCode());
  }

  async updateShare(p: { groups?: SyncGroup[]; enabled?: boolean }): Promise<CloudShareInfo> {
    await this.json('PATCH', '/api/v1/shares/me', { ...(p.groups ? { dataGroups: p.groups } : {}), ...(p.enabled === undefined ? {} : { enabled: p.enabled }) });
    // 改了范围或者恢复分享：重新上传分享包
    if (p.groups || p.enabled) return this.refreshShare();
    return (await this.share())!;
  }

  async revealShare(): Promise<string> {
    const cur = await this.myShareRaw();
    if (!cur) throw new UserError('还没有开启分享码');
    const code = this.codeOf(cur);
    if (!code) throw new UserError('请先输入同步密码解锁，才能查看分享码');
    return formatShareCode(normalizeShareCode(code)!);
  }

  async closeShare(): Promise<void> {
    await this.json('DELETE', '/api/v1/shares/me');
  }

  /** 上传最新的分享包（只含分享范围；用分享码派生的 shareKey 加密） */
  async refreshShare(): Promise<CloudShareInfo> {
    const cur = await this.myShareRaw();
    if (!cur) throw new UserError('还没有开启分享码');
    const code = this.codeOf(cur);
    if (!code) throw new UserError('请先输入同步密码解锁');
    if (!cur.enabled) return this.view(cur)!;
    const { lookupToken, shareKey } = shareKeys(code);
    const pkg = this.d.sync.packageData(cur.dataGroups);
    const h = this.header('share', pkg.groups, pkg.counts);
    const file = pack({ ...h, enc: { alg: 'AES-256-GCM', key: 'share' } }, pkg.body, shareKey);
    await this.uploadFile('PUT', '/api/v1/shares/me/content', { formatVersion: 2, ...h, lookupToken }, file);
    return (await this.share())!;
  }

  // ---------------------------------------------------------------- 从分享码拉取

  async lookupShare(code: string): Promise<SharePreview> {
    const { lookupToken } = shareKeys(code);
    const { data } = await this.json<SharePreview>('POST', '/api/v1/shares:lookup', { lookupToken });
    return data;
  }

  async pullShare(code: string, groups: SyncGroup[], dryRun: boolean): Promise<SyncReport> {
    const { lookupToken, shareKey } = shareKeys(code);
    const preview = await this.lookupShare(code);
    const buf = await this.download('POST', '/api/v1/shares:download', { lookupToken });
    const { header, body } = unpack(buf, shareKey, '分享内容无法解密（分享码不对或内容已损坏）');
    const g = groups.filter((x) => header.groups.includes(x));
    if (!g.length) throw new UserError('分享内容里没有选中的分组');
    // 按分享者区分以前导入过的条目（share_import_map.owner_id）
    return this.d.sync.importDataset(body, g, 'merge', dryRun, `从 ${preview.ownerDisplayName || preview.ownerUsername} 的分享码合并之前`, `user:${preview.ownerUsername}`);
  }

  // ---------------------------------------------------------------- 拉取时勾选内容（第十三轮，文档一 6.27.3）

  private openKey(code: string): string {
    const n = normalizeShareCode(code);
    if (!n) throw new UserError('分享码格式不正确');
    return n;
  }

  /** 下载并解密分享包，列出全部条目（计一次拉取）；明文只在内存里保留 10 分钟 */
  async shareOpen(code: string): Promise<ShareContent> {
    const key = this.openKey(code);
    const { lookupToken, shareKey } = shareKeys(code);
    const preview = await this.lookupShare(code);
    const buf = await this.download('POST', '/api/v1/shares:download', { lookupToken });
    const { header, body } = unpack(buf, shareKey, '分享内容无法解密（分享码不对或内容已损坏）');
    const data = this.d.sync.parseIncoming(body, header.groups);
    const now = this.now();
    for (const [k, v] of this.opened) if (now - v.at > OPEN_TTL_MS) this.opened.delete(k);
    this.opened.set(key, { data, preview, at: now });
    return shareContent(data, preview);
  }

  /** 按勾选的条目合并（规则见 6.10.7）；确认合并后清除内存里的明文 */
  shareImport(code: string, pick: ShareImportPick, dryRun: boolean): SyncReport {
    const key = this.openKey(code);
    const cur = this.opened.get(key);
    if (!cur || this.now() - cur.at > OPEN_TTL_MS) {
      this.opened.delete(key);
      throw new UserError('分享内容已经过期（超过 10 分钟），请重新获取');
    }
    const { data, groups } = pickForImport(cur.data, pick);
    if (!groups.length) throw new UserError('请至少勾选一项要获取的内容');
    const owner = cur.preview.ownerDisplayName || cur.preview.ownerUsername;
    const report = this.d.sync.importDataset(data, groups, 'merge', dryRun, `从 ${owner} 的分享合并之前`, `user:${cur.preview.ownerUsername}`);
    if (!dryRun) this.opened.delete(key);
    return report;
  }

  shareForget(code: string): void {
    const n = normalizeShareCode(code);
    if (n) this.opened.delete(n);
  }

  // ---------------------------------------------------------------- 单项分享（第十三轮，文档一 6.27.4）

  private get linksFile(): string {
    return join(this.d.dir, 'share-links.bin');
  }

  private linksKey(): Buffer {
    return hkdf(this.d.vaultKey, 'itm-share-links-v1', 'codes');
  }

  /** 本机保存的单项分享码（分享 id → 分享码） */
  private localCodes(): Record<string, string> {
    if (!existsSync(this.linksFile)) return {};
    try {
      return (JSON.parse(openVault(this.linksKey(), readFileSync(this.linksFile), 'itm-share-links')) as { codes: Record<string, string> }).codes ?? {};
    } catch {
      return {};
    }
  }

  private saveLocalCodes(codes: Record<string, string>): void {
    writeFileSync(`${this.linksFile}.tmp`, sealVault(this.linksKey(), JSON.stringify({ codes }), 'itm-share-links'), { mode: 0o600 });
    renameSync(`${this.linksFile}.tmp`, this.linksFile);
  }

  private linkCode(l: LinkResponse, local = this.localCodes()): string | null {
    if (local[l.id]) return local[l.id];
    if (!l.codeE2e || !l.e2eKeyVersion) return null;
    const cdk = this.cdkOf(l.e2eKeyVersion);
    if (!cdk) return null;
    try {
      return openWith(cdk, Buffer.from(l.codeE2e, 'base64'), CODE_AAD).toString('utf8');
    } catch {
      return null;
    }
  }

  private linkView(l: LinkResponse, local = this.localCodes()): ShareLinkInfo {
    const { codeE2e: _c, e2eKeyVersion: _v, ...rest } = l;
    return { ...rest, id: String(l.id), codeAvailable: !!this.linkCode(l, local) };
  }

  /** 分享前预览：列出要分享的条目和自动带上的依赖 */
  sharePreview(sel: ShareSelection): ShareSelectionPreview {
    return this.d.sync.shareData(sel, true).preview;
  }

  /** 创建单项分享：生成分享码、打包加密上传；分享码保存在本机（解锁了同步密码时同时用 CDK 托管） */
  async createLink(sel: ShareSelection, o: ShareLinkOptions): Promise<ShareLinkCreated> {
    const includeCredentials = o?.includeCredentials !== false;
    const pkg = this.d.sync.shareData(sel, includeCredentials);
    const days = o?.expiresDays === null || o?.expiresDays === undefined ? null : Number(o.expiresDays);
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 365)) throw new UserError('有效期需要在 1–365 天之间');
    const maxPulls = Number(o?.maxPulls ?? 0);
    if (!Number.isInteger(maxPulls) || maxPulls < 0 || maxPulls > 1000) throw new UserError('可拉取次数需要在 0–1000 之间（0 表示不限）');
    const title = String(o?.title ?? '').trim().slice(0, 100) || pkg.preview.title;
    const code = generateShareCode();
    const { lookupToken, shareKey } = shareKeys(code);
    let escrow: { codeE2e: string; e2eKeyVersion: number } | Record<string, never> = {};
    try {
      const { cdk, keyVersion } = await this.currentCdk();
      escrow = { codeE2e: sealWith(cdk, Buffer.from(code, 'utf8'), CODE_AAD).toString('base64'), e2eKeyVersion: keyVersion };
    } catch {
      // 没有设置或没有解锁同步密码：只保存在这台设备上
    }
    const h = this.header('share', pkg.groups, pkg.counts as ItemCounts);
    const file = pack({ ...h, enc: { alg: 'AES-256-GCM', key: 'share' } }, pkg.body, shareKey);
    const created = await this.uploadFile<LinkResponse>('POST', '/api/v1/share-links', {
      formatVersion: 2,
      ...h,
      lookupToken,
      title,
      expiresAt: days === null ? null : this.now() + days * 86_400_000,
      maxPulls,
      ...escrow,
    }, file);
    const codes = this.localCodes();
    codes[String(created.id)] = code;
    this.saveLocalCodes(codes);
    return { ...this.linkView(created, codes), code: formatShareCode(normalizeShareCode(code)!) };
  }

  async links(): Promise<ShareLinkInfo[]> {
    const { data } = await this.json<LinkResponse[]>('GET', '/api/v1/share-links');
    const local = this.localCodes();
    return (data ?? []).map((l) => this.linkView(l, local));
  }

  async revealLink(id: string): Promise<string> {
    const local = this.localCodes();
    if (local[id]) return formatShareCode(normalizeShareCode(local[id])!);
    const { data } = await this.json<LinkResponse[]>('GET', '/api/v1/share-links');
    const l = (data ?? []).find((x) => String(x.id) === String(id));
    if (!l) throw new UserError('分享不存在或已撤销');
    const code = this.linkCode(l, local);
    if (!code) throw new UserError('这个分享码是在其他设备上创建的：输入同步密码解锁后可以查看（创建时那台设备解锁了同步密码才会托管）');
    return formatShareCode(normalizeShareCode(code)!);
  }

  async revokeLink(id: string): Promise<void> {
    await this.json('DELETE', `/api/v1/share-links/${encodeURIComponent(id)}`);
    const codes = this.localCodes();
    if (codes[id]) {
      delete codes[id];
      this.saveLocalCodes(codes);
    }
  }
}
