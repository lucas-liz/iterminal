import { createHash, randomUUID } from 'node:crypto';
import { utils } from 'ssh2';
import type { AiAccess, AuthMethod, Credential, CredentialInput, CredentialSecretView, CredentialType, TotpCode } from '@itm/protocol';
import type { Db } from '../db/database';
import { open, seal } from './vault';
import { UserError } from '../../util/errors';
import { normalizeOtpSeed, totp } from '../../util/totp';

const TYPES: readonly CredentialType[] = ['PASSWORD', 'SSH_KEY', 'CERT', 'OTP', 'CLOUD_AK', 'DB'];
/** 查看明文后多少秒自动隐藏（文档一 6.6） */
export const REVEAL_TTL_SEC = 30;

/** 保存在 secret_enc 里的秘密（加密后的 JSON）。主机专属凭证只用 password / privateKey / passphrase。 */
export interface CredentialSecrets {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** CLOUD_AK 的 Secret Key */
  secretKey?: string;
}

interface Row {
  id: string;
  type: CredentialType;
  name: string;
  username: string | null;
  owner_host_id: string | null;
  secret_enc: Buffer | null;
  public_key: string | null;
  fingerprint: string | null;
  key_type: string | null;
  otp_seed_enc: Buffer | null;
  ai_access: AiAccess;
  rotate_days: number | null;
  expires_at: number | null;
  rotated_at: number | null;
  last_used_at: number | null;
  note: string | null;
  updated_at: number;
  used_hosts: number;
  used_folders: number;
}

const SELECT = `
  SELECT c.id, c.type, c.name, c.username, c.owner_host_id, c.secret_enc, c.public_key, c.fingerprint, c.key_type, c.otp_seed_enc,
         c.ai_access, c.rotate_days, c.expires_at, c.rotated_at, c.last_used_at, c.note, c.updated_at,
         (SELECT count(*) FROM host h WHERE h.deleted = 0 AND h.auth_method = 'CREDENTIAL' AND h.credential_id = c.id) AS used_hosts,
         (SELECT count(*) FROM folder f WHERE f.deleted = 0 AND f.default_credential_id = c.id) AS used_folders
    FROM credential c
   WHERE c.deleted = 0 AND c.scope = 'PERSONAL'`;

/** OpenSSH 风格的指纹：SHA256:base64（去掉末尾的 =） */
export function sha256Fingerprint(publicKey: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '');
}

export interface KeyInfo {
  publicKey: string;
  fingerprint: string;
  keyType: string;
}

/** 解析私钥得到公钥和指纹；加密私钥没给口令时返回 null（只能连接时再问） */
export function describePrivateKey(privateKey: string, passphrase?: string): KeyInfo | null {
  const parsed = utils.parseKey(privateKey, passphrase);
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) return null;
  const pub = key.getPublicSSH();
  return { publicKey: `${key.type} ${pub.toString('base64')}${key.comment ? ` ${key.comment}` : ''}`, fingerprint: sha256Fingerprint(pub), keyType: key.type };
}

/** 公钥行（ssh-ed25519 AAAA... comment）的指纹 */
export function describePublicKey(line: string): KeyInfo | null {
  const parsed = utils.parseKey(line.trim());
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key instanceof Error) return null;
  const pub = key.getPublicSSH();
  return { publicKey: `${key.type} ${pub.toString('base64')}${key.comment ? ` ${key.comment}` : ''}`, fingerprint: sha256Fingerprint(pub), keyType: key.type };
}

/** 私钥认证必须有私钥，格式必须能解析；加密私钥没保存口令时允许，连接时再询问。 */
export function checkPrivateKey(privateKey: string | undefined, passphrase: string | undefined): void {
  if (!privateKey) throw new UserError('请提供私钥');
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) {
    if (!passphrase && /encrypted|passphrase/i.test(parsed.message)) return;
    throw new UserError(passphrase && /decrypt|passphrase|bad/i.test(parsed.message) ? '私钥口令不正确' : `私钥格式不正确：${parsed.message}`);
  }
}

/**
 * 生成密钥对。ssh2 生成 ed25519 时约有 0.2% 的概率得到它自己解析不了的私钥（上游问题），生成后校验，失败重试。
 */
export function generateKeyPair(algorithm: 'ed25519' | 'rsa', opts: { bits?: number; comment?: string; passphrase?: string }): { privateKey: string; info: KeyInfo } {
  const common = {
    comment: opts.comment || 'iterminal',
    ...(opts.passphrase ? { passphrase: opts.passphrase, cipher: 'aes256-ctr' } : {}),
  };
  for (let i = 0; i < 20; i++) {
    const keys = algorithm === 'rsa' ? utils.generateKeyPairSync('rsa', { bits: opts.bits ?? 4096, ...common }) : utils.generateKeyPairSync('ed25519', common);
    const info = describePrivateKey(keys.private, opts.passphrase);
    if (info) return { privateKey: keys.private, info };
  }
  throw new Error('生成密钥失败，请重试');
}

/**
 * 个人凭证（文档一 6.6）。秘密字段在整库加密之上再用保险库密钥 AES-256-GCM 加密一层（AAD 绑定凭证 ID）。
 * 主机专属凭证（owner_host_id 不为空）由 HostRepo 维护，凭证页默认隐藏。
 */
export class CredentialRepo {
  constructor(
    private readonly db: Db,
    private readonly vaultKey: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  list(): Credential[] {
    return this.db
      .prepare<[], Row>(`${SELECT} ORDER BY c.owner_host_id IS NOT NULL, c.name COLLATE NOCASE`)
      .all()
      .map((r) => toCredential(r, !!this.secretsOf(r).passphrase));
  }

  get(id: string): Credential | null {
    const row = this.db.prepare<[string], Row>(`${SELECT} AND c.id = ?`).get(id);
    return row ? toCredential(row, !!this.secretsOf(row).passphrase) : null;
  }

  require(id: string): Credential {
    const c = this.get(id);
    if (!c) throw new UserError('凭证不存在或已被删除');
    return c;
  }

  /** 共享凭证（可以被多台主机、分组引用）必须存在且不是某台主机的专属凭证 */
  requireShared(id: string): Credential {
    const c = this.require(id);
    if (c.ownerHostId) throw new UserError('不能引用其他主机的专属凭证，请在「凭证」页新建共享凭证');
    return c;
  }

  save(id: string | null, input: CredentialInput): Credential {
    const v = validate(input);
    const now = this.now();
    const current = id ? this.db.prepare<[string], Row>(`${SELECT} AND c.id = ?`).get(id) : undefined;
    if (id && !current) throw new UserError('凭证不存在或已被删除');
    if (current?.owner_host_id) throw new UserError('这是主机专属凭证，请在主机的编辑框里修改');
    if (current && current.type !== v.type) throw new UserError('不能修改凭证类型，请新建一个凭证');
    const cid = id ?? randomUUID();
    const prev = current ? this.secretsOf(current) : {};
    const prevOtp = current?.otp_seed_enc ? open(this.vaultKey, current.otp_seed_enc, `credential_otp:${cid}`) : undefined;

    // 秘密：undefined 保持不变，null / 空串清除
    const pick = (next: string | null | undefined, old: string | undefined): string | undefined => (next === undefined ? old : next || undefined);
    const secrets: CredentialSecrets = {};
    let publicKey = v.publicKey === undefined ? (current?.public_key ?? null) : v.publicKey;
    let keyInfo: KeyInfo | null = null;
    if (input.generate) {
      if (v.type !== 'SSH_KEY') throw new UserError('只有 SSH 密钥可以生成');
      const g = generateKeyPair(input.generate.algorithm, input.generate);
      secrets.privateKey = g.privateKey;
      if (input.generate.passphrase) secrets.passphrase = input.generate.passphrase;
      keyInfo = g.info;
      publicKey = g.info.publicKey;
    } else if (v.type === 'PASSWORD' || v.type === 'DB') {
      secrets.password = pick(input.secret, prev.password);
    } else if (v.type === 'SSH_KEY' || v.type === 'CERT') {
      secrets.privateKey = pick(input.secret, prev.privateKey);
      secrets.passphrase = pick(input.passphrase, prev.passphrase);
      if (secrets.privateKey) {
        checkPrivateKey(secrets.privateKey, secrets.passphrase);
        keyInfo = describePrivateKey(secrets.privateKey, secrets.passphrase);
        if (keyInfo && v.type === 'SSH_KEY') publicKey = keyInfo.publicKey;
      } else if (v.type === 'SSH_KEY') {
        if (!publicKey) throw new UserError('请提供私钥，或者至少提供公钥');
        keyInfo = describePublicKey(publicKey);
        if (!keyInfo) throw new UserError('公钥格式不正确');
        publicKey = keyInfo.publicKey;
      }
    } else if (v.type === 'CLOUD_AK') {
      secrets.secretKey = pick(input.secret, prev.secretKey);
      if (!secrets.secretKey) throw new UserError('请填写 Secret Key');
    }
    if ((v.type === 'PASSWORD' || v.type === 'DB') && !secrets.password && !id) {
      // 允许只保存用户名（例如只用 TOTP 的堡垒机），但给出明确的类型提示
      if (v.type === 'DB') throw new UserError('请填写数据库密码');
    }
    let otpSeed = input.otpSeed === undefined ? prevOtp : input.otpSeed ? normalizeSeed(input.otpSeed) : undefined;
    if (v.type === 'OTP' && !otpSeed) throw new UserError('请填写 TOTP 种子（Base32 或 otpauth:// 链接）');
    if (v.type !== 'OTP' && v.type !== 'PASSWORD') otpSeed = undefined;

    const changedSecret =
      !current ||
      JSON.stringify(stripUndefined(prev)) !== JSON.stringify(stripUndefined(secrets)) ||
      prevOtp !== otpSeed;
    const hasAny = Object.values(secrets).some(Boolean);
    const sealed = hasAny ? seal(this.vaultKey, JSON.stringify(stripUndefined(secrets)), `credential:${cid}`) : null;
    const otpSealed = otpSeed ? seal(this.vaultKey, otpSeed, `credential_otp:${cid}`) : null;
    const fingerprint = keyInfo?.fingerprint ?? (v.type === 'SSH_KEY' || v.type === 'CERT' ? (current?.fingerprint ?? null) : null);
    const keyType = keyInfo?.keyType ?? (v.type === 'SSH_KEY' || v.type === 'CERT' ? (current?.key_type ?? null) : null);
    const rotatedAt = changedSecret ? now : (current?.rotated_at ?? now);
    if (current) {
      this.db
        .prepare(
          `UPDATE credential SET name = ?, username = ?, secret_enc = ?, public_key = ?, fingerprint = ?, key_type = ?, otp_seed_enc = ?,
                                 ai_access = ?, rotate_days = ?, expires_at = ?, note = ?, rotated_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(v.name, v.username, sealed, publicKey, fingerprint, keyType, otpSealed, v.aiAccess, v.rotateDays, v.expiresAt, v.note, rotatedAt, now, cid);
    } else {
      this.db
        .prepare(
          `INSERT INTO credential (id, scope, type, name, username, secret_enc, public_key, fingerprint, key_type, otp_seed_enc,
                                   ai_access, rotate_days, expires_at, note, rotated_at, updated_at)
           VALUES (?, 'PERSONAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(cid, v.type, v.name, v.username, sealed, publicKey, fingerprint, keyType, otpSealed, v.aiAccess, v.rotateDays, v.expiresAt, v.note, now, now);
    }
    return this.require(cid);
  }

  /** 正在被主机或分组引用的凭证不能删除，避免主机悄悄变成「每次询问」 */
  delete(id: string): void {
    const c = this.require(id);
    if (c.ownerHostId) throw new UserError('这是主机专属凭证，删除主机时会一起删除');
    if (c.usedByHosts > 0 || c.usedByFolders > 0) {
      const parts = [c.usedByHosts ? `${c.usedByHosts} 台主机` : '', c.usedByFolders ? `${c.usedByFolders} 个分组` : ''].filter(Boolean);
      throw new UserError(`「${c.name}」正被 ${parts.join('和')}使用，请先修改它们的凭证设置`);
    }
    this.db.prepare('UPDATE credential SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** 解密后的秘密，只在主进程内使用 */
  secrets(id: string): CredentialSecrets & { otpSeed?: string } {
    const row = this.db.prepare<[string], Row>(`${SELECT} AND c.id = ?`).get(id);
    if (!row) return {};
    const s: CredentialSecrets & { otpSeed?: string } = this.secretsOf(row);
    if (row.otp_seed_enc) s.otpSeed = open(this.vaultKey, row.otp_seed_enc, `credential_otp:${id}`);
    return s;
  }

  reveal(id: string): CredentialSecretView {
    const c = this.require(id);
    const s = this.secrets(id);
    const secret = c.type === 'SSH_KEY' || c.type === 'CERT' ? s.privateKey : c.type === 'CLOUD_AK' ? s.secretKey : s.password;
    return { secret: secret ?? null, passphrase: s.passphrase ?? null, otpSeed: s.otpSeed ?? null, ttlSec: REVEAL_TTL_SEC };
  }

  totp(id: string): TotpCode {
    const seed = this.secrets(id).otpSeed;
    if (!seed) throw new UserError('这个凭证没有设置 TOTP');
    return totp(seed, this.now());
  }

  markUsed(id: string): void {
    this.db.prepare('UPDATE credential SET last_used_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** 轮换：换成新私钥（指纹、公钥一起更新） */
  replaceKey(id: string, privateKey: string, passphrase: string | undefined): void {
    const c = this.require(id);
    const info = describePrivateKey(privateKey, passphrase);
    if (!info) throw new Error('新私钥无法解析');
    const secrets: CredentialSecrets = stripUndefined({ privateKey, passphrase });
    const now = this.now();
    this.db
      .prepare('UPDATE credential SET secret_enc = ?, public_key = ?, fingerprint = ?, key_type = ?, rotated_at = ?, updated_at = ? WHERE id = ?')
      .run(seal(this.vaultKey, JSON.stringify(secrets), `credential:${c.id}`), info.publicKey, info.fingerprint, info.keyType, now, now, c.id);
  }

  // ---------------------------------------------------------------- 主机专属凭证（由 HostRepo 在事务里调用）

  /**
   * 写入（或清除）主机专属凭证，返回凭证 ID；没有任何秘密时删除凭证并返回 null。
   */
  saveDedicated(credentialId: string | null, hostId: string, name: string, username: string, method: AuthMethod, secrets: CredentialSecrets): string | null {
    const now = this.now();
    const empty = !secrets.password && !secrets.privateKey;
    if (empty) {
      if (credentialId) this.db.prepare('UPDATE credential SET deleted = 1, updated_at = ? WHERE id = ? AND owner_host_id = ?').run(now, credentialId, hostId);
      return null;
    }
    const id = credentialId ?? randomUUID();
    const type: CredentialType = method === 'KEY' ? 'SSH_KEY' : 'PASSWORD';
    const info = method === 'KEY' && secrets.privateKey ? describePrivateKey(secrets.privateKey, secrets.passphrase) : null;
    const clean = stripUndefined({ password: secrets.password, privateKey: secrets.privateKey, passphrase: secrets.passphrase });
    const sealed = seal(this.vaultKey, JSON.stringify(clean), `credential:${id}`);
    if (credentialId) {
      const old = this.db.prepare<[string], Row>(`${SELECT} AND c.id = ?`).get(credentialId);
      const changed = !old || JSON.stringify(stripUndefined(this.secretsOf(old))) !== JSON.stringify(clean);
      this.db
        .prepare(
          `UPDATE credential SET type = ?, name = ?, username = ?, secret_enc = ?, public_key = ?, fingerprint = ?, key_type = ?,
                                 owner_host_id = ?, deleted = 0, rotated_at = CASE WHEN ? THEN ? ELSE rotated_at END, updated_at = ? WHERE id = ?`,
        )
        .run(type, name, username, sealed, info?.publicKey ?? null, info?.fingerprint ?? null, info?.keyType ?? null, hostId, changed ? 1 : 0, now, now, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO credential (id, scope, type, name, username, secret_enc, public_key, fingerprint, key_type, owner_host_id, rotated_at, updated_at)
           VALUES (?, 'PERSONAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, type, name, username, sealed, info?.publicKey ?? null, info?.fingerprint ?? null, info?.keyType ?? null, hostId, now, now);
    }
    return id;
  }

  /** 删除主机时一并删除它的专属凭证 */
  deleteDedicatedOf(hostIds: string[]): void {
    const now = this.now();
    const stmt = this.db.prepare('UPDATE credential SET deleted = 1, updated_at = ? WHERE owner_host_id = ? AND deleted = 0');
    hostIds.forEach((h) => stmt.run(now, h));
  }

  private secretsOf(row: Pick<Row, 'id' | 'secret_enc'>): CredentialSecrets {
    if (!row.secret_enc) return {};
    return JSON.parse(open(this.vaultKey, row.secret_enc, `credential:${row.id}`)) as CredentialSecrets;
  }
}

function normalizeSeed(s: string): string {
  try {
    return normalizeOtpSeed(s);
  } catch (e) {
    throw new UserError((e as Error).message);
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

function validate(input: CredentialInput): Omit<CredentialInput, 'secret' | 'passphrase' | 'otpSeed' | 'generate'> {
  if (!TYPES.includes(input.type)) throw new UserError('不支持的凭证类型');
  const name = (input.name ?? '').trim();
  if (!name) throw new UserError('请填写凭证名称');
  if (name.length > 64) throw new UserError('名称不能超过 64 个字符');
  const username = (input.username ?? '').trim() || null;
  if (username && username.length > 128) throw new UserError('用户名太长');
  if (input.aiAccess !== 'REFERENCE' && input.aiAccess !== 'DENY') throw new UserError('AI 访问设置不合法');
  const rotateDays = input.rotateDays == null ? null : Math.floor(Number(input.rotateDays));
  if (rotateDays !== null && !(rotateDays >= 1 && rotateDays <= 3650)) throw new UserError('轮换周期必须是 1–3650 天');
  const expiresAt = input.expiresAt == null ? null : Number(input.expiresAt);
  if (expiresAt !== null && !Number.isFinite(expiresAt)) throw new UserError('到期时间不合法');
  const note = (input.note ?? '').trim() || null;
  if (note && note.length > 1000) throw new UserError('备注不能超过 1000 个字符');
  const publicKey = input.publicKey === undefined ? undefined : (input.publicKey ?? '').trim() || null;
  return { type: input.type, name, username, aiAccess: input.aiAccess, rotateDays, expiresAt, note, publicKey };
}

function toCredential(r: Row, hasPassphrase: boolean): Credential {
  return {
    id: r.id,
    type: r.type,
    name: r.name,
    username: r.username,
    ownerHostId: r.owner_host_id,
    publicKey: r.public_key,
    fingerprint: r.fingerprint,
    keyType: r.key_type,
    hasSecret: !!r.secret_enc,
    hasPassphrase,
    hasOtp: !!r.otp_seed_enc,
    aiAccess: r.ai_access,
    rotateDays: r.rotate_days,
    expiresAt: r.expires_at,
    rotatedAt: r.rotated_at ?? r.updated_at,
    lastUsedAt: r.last_used_at,
    note: r.note,
    usedByHosts: r.used_hosts,
    usedByFolders: r.used_folders,
    updatedAt: r.updated_at,
  };
}
