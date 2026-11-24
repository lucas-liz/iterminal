import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SYNC_GROUPS, SYNC_ITEM_TYPES, type ItemCounts, type SyncGroup } from '@itm/protocol';
import { checkArgon2Params, type Argon2Params } from '../../util/kdf';
import { UserError } from '../../util/errors';

/**
 * 备份包 .itmbak（文档一 6.10.5）：云备份、分享包、本地导出共用，只是加密密钥不同。
 *
 *   第一行：header（明文 JSON，单行）\n
 *   之后：  iv(12) | AES-256-GCM(gzip(JSON body)) | tag(16)
 *
 * AAD：分享包为 "itmshare:v1"（6.10.6），其余为 header 这一行的原始字节——改动 header 里的分组、条数都会解密失败。
 */
export const FORMAT_VERSION = 2;
const MAGIC = 'itmbak';
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_HEADER = 64 * 1024;
/** 解压后的 body 上限，防止压缩炸弹 */
const MAX_BODY = 256 * 1024 * 1024;
export const SHARE_AAD = 'itmshare:v1';

export type ItmbakKind = 'backup' | 'share' | 'export' | 'auto';

/** 用什么密钥加密：导出密码（Argon2id）/ 本机档案密钥（自动备份）/ CDK（云备份）/ 分享码派生的 shareKey */
export type ItmbakKey = { key: 'password'; kdf: Argon2Params } | { key: 'profile' } | { key: 'cdk'; keyVersion: number } | { key: 'share' };

export interface ItmbakHeader {
  format: typeof MAGIC;
  formatVersion: number;
  kind: ItmbakKind;
  createdAt: number;
  deviceName: string;
  platform: string;
  clientVersion: string;
  groups: SyncGroup[];
  counts: ItemCounts;
  /** 只在 kind = backup 时有 */
  keyVersion?: number;
  enc: { alg: 'AES-256-GCM' } & ItmbakKey;
  /** 自动备份的生成原因 */
  reason?: string;
}

function aadOf(header: ItmbakHeader, headerBytes: Buffer): Buffer {
  return header.kind === 'share' ? Buffer.from(SHARE_AAD, 'utf8') : headerBytes;
}

export function pack(header: Omit<ItmbakHeader, 'format' | 'formatVersion'>, body: unknown, key: Buffer): Buffer {
  const full: ItmbakHeader = { format: MAGIC, formatVersion: FORMAT_VERSION, ...header };
  const headerBytes = Buffer.from(JSON.stringify(full), 'utf8');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadOf(full, headerBytes));
  const ct = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(body), 'utf8'))), cipher.final()]);
  return Buffer.concat([headerBytes, Buffer.from('\n'), iv, ct, cipher.getAuthTag()]);
}

/** 只解析 header（不需要密钥），格式不对时抛出 UserError */
export function readHeader(buf: Buffer): { header: ItmbakHeader; headerBytes: Buffer; body: Buffer } {
  const nl = buf.subarray(0, MAX_HEADER).indexOf(0x0a);
  if (nl <= 0) throw new UserError('不是 iTerminal 备份文件（.itmbak）');
  const headerBytes = buf.subarray(0, nl);
  let header: ItmbakHeader;
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as ItmbakHeader;
  } catch {
    throw new UserError('不是 iTerminal 备份文件（.itmbak）');
  }
  if (header?.format !== MAGIC) throw new UserError('不是 iTerminal 备份文件（.itmbak）');
  if (!Number.isInteger(header.formatVersion) || header.formatVersion < 1) throw new UserError('备份文件已损坏');
  if (header.formatVersion > FORMAT_VERSION) throw new UserError(`这个备份文件来自更新版本的 iTerminal（格式 V${header.formatVersion}），请先升级客户端`);
  if (header.formatVersion < 2) throw new UserError('暂不支持恢复 V1 格式的旧备份');
  if (!['backup', 'share', 'export', 'auto'].includes(header.kind)) throw new UserError('备份文件已损坏');
  header.groups = (Array.isArray(header.groups) ? header.groups : []).filter((g): g is SyncGroup => SYNC_GROUPS.includes(g));
  const counts = (header.counts ?? {}) as Partial<ItemCounts>;
  header.counts = Object.fromEntries(SYNC_ITEM_TYPES.map((t) => [t, Number.isInteger(counts[t]) && counts[t]! >= 0 ? counts[t] : 0])) as ItemCounts;
  if (header.enc?.key === 'password') checkArgon2Params(header.enc.kdf);
  const body = buf.subarray(nl + 1);
  if (body.length < IV_LEN + TAG_LEN) throw new UserError('备份文件已损坏');
  return { header, headerBytes, body };
}

/** 解密 body；密钥不对或文件被改动时抛出 UserError(wrongKeyMessage) */
export function unpack(buf: Buffer, key: Buffer, wrongKeyMessage = '密码不正确，或者文件已损坏'): { header: ItmbakHeader; body: unknown } {
  const { header, headerBytes, body } = readHeader(buf);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, IV_LEN));
    decipher.setAAD(aadOf(header, headerBytes));
    decipher.setAuthTag(body.subarray(body.length - TAG_LEN));
    plain = Buffer.concat([decipher.update(body.subarray(IV_LEN, body.length - TAG_LEN)), decipher.final()]);
  } catch {
    throw new UserError(wrongKeyMessage);
  }
  try {
    return { header, body: JSON.parse(gunzipSync(plain, { maxOutputLength: MAX_BODY }).toString('utf8')) as unknown };
  } catch {
    throw new UserError('备份文件已损坏');
  }
}
