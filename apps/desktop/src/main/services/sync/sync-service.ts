import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { GROUP_ITEM_TYPES, SYNC_GROUPS, type AutoBackupInfo, type BackupFileInfo, type LocalStats, type SyncGroup, type SyncReport } from '@itm/protocol';
import { countDataset, pickGroups, planMerge, planReplace, type Dataset } from '@itm/sync-merge';
import type { Db } from '../db/database';
import type { SettingsRepo } from '../settings/settings-repo';
import { deriveArgon2, hkdf, newArgon2Params } from '../../util/kdf';
import { UserError } from '../../util/errors';
import type { DatasetStore } from './dataset-store';
import { pack, readHeader, unpack, type ItmbakHeader } from './itmbak';
import { bodyOf, sanitizeDataset } from './sanitize';
import { pickForShare } from './share-pick';
import type { ShareSelection, ShareSelectionPreview } from '@itm/protocol';

export const MIN_EXPORT_PASSWORD = 8;
const MAX_FILE = 200 * 1024 * 1024;
const KEEP_AUTO = 5;
const AUTO_RE = /^auto-[\d-]+\.itmbak$/;

export interface SyncServiceDeps {
  db: Db;
  store: DatasetStore;
  settings: SettingsRepo;
  vaultKey: Buffer;
  /** 档案目录（自动备份放在 backups/ 下） */
  dir: string;
  clientVersion: string;
  now?: () => number;
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
function stamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

function validGroups(groups: SyncGroup[]): SyncGroup[] {
  const g = SYNC_GROUPS.filter((x) => groups?.includes(x));
  if (!g.length) throw new UserError('请至少选择一个分组');
  return g;
}

/**
 * 本地数据统计、本地文件导出 / 导入、自动备份与撤回（文档一 6.10.2 / 6.10.5 / 6.10.7）。
 * 合并和覆盖之前都先做 dry-run 给用户确认；真正写入前自动生成一份本地备份（保留最近 5 份），然后在一个事务里执行。
 */
export class SyncService {
  private readonly now: () => number;

  constructor(private readonly d: SyncServiceDeps) {
    this.now = d.now ?? Date.now;
  }

  private get backupDir(): string {
    const dir = join(this.d.dir, 'backups');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** 自动备份用本机档案的密钥加密，只能在这个档案里恢复 */
  private get profileKey(): Buffer {
    return hkdf(this.d.vaultKey, 'itm-auto-backup-v1', 'enc');
  }

  stats(): LocalStats {
    return { counts: this.d.store.counts(), lastBackupAt: this.d.settings.get('sync.lastBackupAt') };
  }

  private headerBase(kind: ItmbakHeader['kind'], groups: SyncGroup[], data: Dataset): Omit<ItmbakHeader, 'format' | 'formatVersion' | 'enc'> {
    return {
      kind,
      createdAt: this.now(),
      deviceName: hostname().slice(0, 64),
      platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform,
      clientVersion: this.d.clientVersion,
      groups,
      counts: countDataset(data),
    };
  }

  private info(header: ItmbakHeader, size: number): BackupFileInfo {
    const { kind, formatVersion, createdAt, deviceName, platform, clientVersion, groups, counts } = header;
    return { kind, formatVersion, createdAt, deviceName, platform, clientVersion, groups, counts, size };
  }

  private writeAtomic(path: string, buf: Buffer): void {
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, path);
  }

  // ---------------------------------------------------------------- 导出 / 导入

  async export(groups: SyncGroup[], filePath: string, password: string): Promise<BackupFileInfo> {
    const g = validGroups(groups);
    if (typeof password !== 'string' || password.length < MIN_EXPORT_PASSWORD) throw new UserError(`导出密码至少 ${MIN_EXPORT_PASSWORD} 位`);
    if (!filePath) throw new UserError('请选择保存位置');
    const kdf = newArgon2Params();
    const key = await deriveArgon2(password, kdf);
    const data = pickGroups(this.d.store.load(g, g.includes('CREDENTIALS')), g);
    const header = { ...this.headerBase('export', g, data), enc: { alg: 'AES-256-GCM' as const, key: 'password' as const, kdf } };
    const buf = pack(header, bodyOf(data, g), key);
    this.writeAtomic(filePath, buf);
    this.d.settings.set('sync.lastBackupAt', header.createdAt);
    return this.info({ format: 'itmbak', formatVersion: 2, ...header }, buf.length);
  }

  private readFile(filePath: string): Buffer {
    let size: number;
    try {
      size = statSync(filePath).size;
    } catch {
      throw new UserError('找不到这个文件');
    }
    if (size > MAX_FILE) throw new UserError('文件太大（超过 200MB），不是有效的备份文件');
    return readFileSync(filePath);
  }

  inspect(filePath: string): BackupFileInfo {
    const buf = this.readFile(filePath);
    return this.info(readHeader(buf).header, buf.length);
  }

  async import(filePath: string, password: string, groups: SyncGroup[], mode: 'merge' | 'replace', dryRun: boolean): Promise<SyncReport> {
    const buf = this.readFile(filePath);
    const { header } = readHeader(buf);
    if (header.enc?.key !== 'password') {
      throw new UserError(
        header.kind === 'auto' ? '这是自动备份，请在「自动备份」列表里撤回' : '这是云端备份或分享包，需要登录后在云同步里恢复',
      );
    }
    const key = await deriveArgon2(password ?? '', header.enc.kdf);
    const { body } = unpack(buf, key, '导出密码不正确，或者文件已损坏');
    const g = validGroups(groups).filter((x) => header.groups.includes(x));
    if (!g.length) throw new UserError('文件里没有选中的分组');
    // 没选凭证分组时，即使文件里带了主机密码也不写入
    return this.applyIncoming(pickGroups(sanitizeDataset(body, g), g), g, mode, dryRun, `导入 ${basename(filePath)} 之前`);
  }

  // ---------------------------------------------------------------- 首次登录导入本地数据（文档一 6.10.8）

  /** 取出本档案的全部数据（含凭证明文，只在内存里传给另一个档案） */
  snapshot(): Dataset {
    return this.d.store.load([...SYNC_GROUPS], true);
  }

  /** 把另一个档案的数据合并进来（按 6.10.7 的规则去重），写入前自动备份 */
  mergeFrom(data: Dataset, reason: string): SyncReport {
    const g = [...SYNC_GROUPS];
    return this.applyIncoming(pickGroups(data, g), g, 'merge', false, reason);
  }

  // ---------------------------------------------------------------- 云备份、分享码（文档一 6.10.5 / 6.10.6）

  /** 记录最近一次备份时间（本地数据统计里显示） */
  markBackedUp(at: number): void {
    this.d.settings.set('sync.lastBackupAt', at);
  }

  /** 打包要上传的数据：云备份带全部选中的分组；凭证分组带密码 / 私钥 */
  packageData(groups: SyncGroup[]): { groups: SyncGroup[]; counts: ReturnType<typeof countDataset>; body: unknown } {
    let g = validGroups(groups);
    const data = pickGroups(this.d.store.load(g, g.includes('CREDENTIALS')), g);
    // 没有要备份的 Skill 时不带 Skill 分组（还没升级的服务端不认识这个分组，避免没有 Skill 的用户也备份失败）
    if (!data.skills.length && g.length > 1) g = g.filter((x) => x !== 'SKILLS');
    // 条数只带所含分组的键（服务端按分组校验键名）
    const keys = new Set<string>(g.flatMap((x) => GROUP_ITEM_TYPES[x]));
    const counts = Object.fromEntries(Object.entries(countDataset(data)).filter(([k]) => keys.has(k))) as ReturnType<typeof countDataset>;
    return { groups: g, counts, body: bodyOf(data, g) };
  }

  /**
   * 单项分享（第十三轮，文档一 6.27.4）：选中的条目和依赖（跳板机、分组路径、凭证）；团队主机跳过。
   * includeCredentials 时带主机自己的密码 / 私钥和引用的凭证。
   */
  shareData(sel: ShareSelection, includeCredentials: boolean): { groups: SyncGroup[]; counts: Partial<ReturnType<typeof countDataset>>; body: unknown; preview: ShareSelectionPreview } {
    const all = this.d.store.load([...SYNC_GROUPS], includeCredentials);
    const teamFolderIds = new Set(this.d.db.prepare<[], { id: string }>("SELECT id FROM folder WHERE scope = 'TEAM'").all().map((r) => r.id));
    const r = pickForShare(all, sel ?? {}, { includeCredentials, teamFolderIds });
    if (!r.groups.length) throw new UserError(r.preview.skippedTeam ? '团队主机由管理员维护，不能分享' : '没有可以分享的内容');
    const keys = new Set<string>(r.groups.flatMap((x) => GROUP_ITEM_TYPES[x]));
    const counts = Object.fromEntries(Object.entries(countDataset(r.data)).filter(([k]) => keys.has(k)));
    return { groups: r.groups, counts, body: bodyOf(r.data, r.groups), preview: r.preview };
  }

  /** 分享包 / 备份包的 body 校验成数据集（拉取前列出内容用） */
  parseIncoming(body: unknown, groups: SyncGroup[]): Dataset {
    return pickGroups(sanitizeDataset(body, groups), groups);
  }

  /**
   * 从云备份恢复（合并或覆盖）、从分享码拉取（只合并；按 share_import_map 识别以前导入过的条目，新增的条目用新 id）。
   * 写入前同样自动备份。
   */
  importDataset(incoming: unknown, groups: SyncGroup[], mode: 'merge' | 'replace', dryRun: boolean, reason: string, shareOwner: string | null = null): SyncReport {
    const g = validGroups(groups);
    if (shareOwner && mode !== 'merge') throw new UserError('分享码拉取只能合并');
    return this.applyIncoming(pickGroups(sanitizeDataset(incoming, g), g), g, mode, dryRun, reason, shareOwner);
  }

  private importMap(owner: string): Map<string, string> {
    return new Map(
      this.d.db
        .prepare<[string], { entity: string; remote_id: string; local_id: string }>('SELECT entity, remote_id, local_id FROM share_import_map WHERE owner_id = ?')
        .all(owner)
        .map((r) => [`${r.entity}:${r.remote_id}`, r.local_id]),
    );
  }

  private applyIncoming(incoming: Dataset, groups: SyncGroup[], mode: 'merge' | 'replace', dryRun: boolean, reason: string, shareOwner: string | null = null): SyncReport {
    const withSecrets = groups.includes('CREDENTIALS');
    // 规划时要看到全部分组：没选的分组里的引用也要能对上
    const local = this.d.store.load([...SYNC_GROUPS], withSecrets);
    if (!withSecrets) local.hosts = pickGroups(local, ['HOSTS']).hosts;
    if (mode === 'merge') {
      const source = shareOwner ? { kind: 'share' as const, ownerId: shareOwner, importMap: this.importMap(shareOwner) } : { kind: 'backup' as const };
      const plan = planMerge(local, incoming, { source, groups });
      const report: SyncReport = { mode: 'merge', ...plan.report, applied: false, autoBackup: null, groups };
      if (dryRun) return report;
      report.autoBackup = this.autoBackup(groups, reason);
      this.commit(() => this.d.store.applyMerge(plan.ops, withSecrets, shareOwner));
      return { ...report, applied: true };
    }
    const plan = planReplace(local, incoming, groups);
    const report: SyncReport = { mode: 'replace', ...plan.report, applied: false, autoBackup: null, groups };
    if (dryRun) return report;
    report.autoBackup = this.autoBackup(groups, reason);
    this.commit(() => this.d.store.applyReplace(plan, withSecrets));
    return { ...report, applied: true };
  }

  /** 数据库在一个事务里写；Skill 是文件，事务成功以后再写（事务失败时不动文件） */
  private commit(write: () => void): void {
    try {
      this.d.db.transaction(write)();
    } catch (e) {
      this.d.store.discardFiles();
      throw e;
    }
    const errors = this.d.store.flushFiles();
    if (errors.length) throw new UserError(`其他内容已写入，但有 ${errors.length} 个 Skill 没写成功：${errors.slice(0, 2).join('；')}`);
  }

  // ---------------------------------------------------------------- 自动备份

  /** 写入前的自动备份；覆盖凭证会断开主机对凭证的引用，所以连主机一起备份 */
  private autoBackup(groups: SyncGroup[], reason: string): string {
    const g = SYNC_GROUPS.filter((x) => groups.includes(x) || (x === 'HOSTS' && groups.includes('CREDENTIALS')));
    const data = pickGroups(this.d.store.load(g, g.includes('CREDENTIALS')), g);
    const header = { ...this.headerBase('auto', g, data), enc: { alg: 'AES-256-GCM' as const, key: 'profile' as const }, reason: reason.slice(0, 200) };
    const dir = this.backupDir;
    let name = `auto-${stamp(header.createdAt)}.itmbak`;
    for (let i = 2; this.exists(join(dir, name)); i++) name = `auto-${stamp(header.createdAt)}-${i}.itmbak`;
    this.writeAtomic(join(dir, name), pack(header, bodyOf(data, g), this.profileKey));
    // 保留最近 5 份
    const all = readdirSync(dir).filter((f) => AUTO_RE.test(f)).sort();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP_AUTO))) rmSync(join(dir, old), { force: true });
    return name;
  }

  private exists(p: string): boolean {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }

  autoList(): AutoBackupInfo[] {
    const dir = this.backupDir;
    const out: AutoBackupInfo[] = [];
    for (const name of readdirSync(dir).filter((f) => AUTO_RE.test(f))) {
      try {
        const buf = readFileSync(join(dir, name));
        const { header } = readHeader(buf);
        out.push({ name, createdAt: header.createdAt, groups: header.groups, counts: header.counts, size: buf.length, reason: header.reason ?? '' });
      } catch {
        // 损坏的文件不列出
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 撤回：用自动备份覆盖它包含的分组（撤回之前同样先备份当前数据） */
  autoRestore(name: string, dryRun: boolean): SyncReport {
    if (!AUTO_RE.test(name ?? '')) throw new UserError('自动备份不存在');
    const path = join(this.backupDir, name);
    if (!this.exists(path)) throw new UserError('自动备份不存在');
    const { header, body } = unpack(readFileSync(path), this.profileKey, '自动备份无法解密（可能来自其他档案）');
    if (!header.groups.length) throw new UserError('自动备份是空的');
    return this.applyIncoming(sanitizeDataset(body, header.groups), header.groups, 'replace', dryRun, `撤回到 ${name} 之前`);
  }
}
