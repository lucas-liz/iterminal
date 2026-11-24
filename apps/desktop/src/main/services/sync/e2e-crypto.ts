import { createCipheriv, createDecipheriv, randomBytes, randomInt } from 'node:crypto';
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveArgon2, hkdf, newArgon2Params, type Argon2Params } from '../../util/kdf';
import { UserError } from '../../util/errors';

/**
 * 端到端加密（文档一 6.10.4 / 6.10.6），全部在客户端完成，服务端只拿到密文和 lookupToken：
 * - 同步密码 ──Argon2id──> WK；恢复码（32 字节，展示为 24 个单词）──HKDF──> RK；两者分别包装 CDK；
 * - 分享码 ITM-XXXXX-…（125 bit）──HKDF──> lookupToken（上传查找）/ shareKey（加密分享包）；
 * - 密文格式 iv(12) | ciphertext | tag(16)，AAD 为 {实体类型}:{clientId}。
 */

const IV_LEN = 12;
const TAG_LEN = 16;
export const MIN_SYNC_PASSWORD = 10;

export function sealWith(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([iv, c.update(plaintext), c.final(), c.getAuthTag()]);
}

export function openWith(key: Buffer, sealed: Buffer, aad: string): Buffer {
  if (sealed.length < IV_LEN + TAG_LEN) throw new Error('密文长度不正确');
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, IV_LEN));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
  return Buffer.concat([d.update(sealed.subarray(IV_LEN, sealed.length - TAG_LEN)), d.final()]);
}

/** 同步中的实体密文（凭证、笔记整条记录） */
export const sealEntity = (cdk: Buffer, entity: string, clientId: string, json: unknown): Buffer =>
  sealWith(cdk, Buffer.from(JSON.stringify(json), 'utf8'), `${entity}:${clientId}`);
export const openEntity = (cdk: Buffer, entity: string, clientId: string, sealed: Buffer): unknown =>
  JSON.parse(openWith(cdk, sealed, `${entity}:${clientId}`).toString('utf8')) as unknown;

// ------------------------------------------------------------------ 分享码

/** Crockford Base32（不含 I L O U） */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 25;

/** 生成分享码：25 位 Crockford Base32 = 125 bit 随机数，按 5 位一组展示 */
export function generateShareCode(): string {
  const chars = Array.from({ length: CODE_LEN }, () => CROCKFORD[randomInt(32)]);
  return formatShareCode(chars.join(''));
}

export function formatShareCode(code: string): string {
  return `ITM-${code.match(/.{5}/g)!.join('-')}`;
}

/** 规范化：去掉 ITM- 前缀、连字符和空白，转大写，O→0，I / L→1；不合法时返回 null */
export function normalizeShareCode(input: string): string | null {
  let s = (input ?? '').toUpperCase().replace(/[\s\-_]/g, '');
  if (s.startsWith('ITM')) s = s.slice(3);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_LEN) return null;
  for (const ch of s) if (!CROCKFORD.includes(ch)) return null;
  return s;
}

/** 分享码派生：lookupToken 上传给服务端用于查找；shareKey 只留在客户端 */
export function shareKeys(input: string): { code: string; lookupToken: string; shareKey: Buffer } {
  const code = normalizeShareCode(input);
  if (!code) throw new UserError('分享码格式不正确，应为 ITM- 开头的 25 位字母数字');
  return {
    code,
    lookupToken: hkdf(code, 'itm-share-v1', 'lookup').toString('base64url'),
    shareKey: hkdf(code, 'itm-share-v1', 'enc'),
  };
}

// ------------------------------------------------------------------ CDK 与同步密码、恢复码

export interface WrappedCdk {
  /** base64(iv | AES-256-GCM(WK, CDK) | tag) */
  wrappedCdk: string;
  kdf: Argon2Params;
  /** base64(iv | AES-256-GCM(RK, CDK) | tag) */
  recoveryWrappedCdk: string;
  keyVersion: number;
}

const CDK_AAD = (v: number) => `itm-cdk:v${v}`;

export function checkSyncPassword(pw: string): void {
  if (typeof pw !== 'string' || pw.length < MIN_SYNC_PASSWORD) throw new UserError(`同步密码至少 ${MIN_SYNC_PASSWORD} 位`);
}

function recoveryKeyOf(entropy: Uint8Array): Buffer {
  return hkdf(Buffer.from(entropy), 'itm-recovery-v1', 'rk');
}

export function recoveryKey(words: string): Buffer {
  const m = words.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(m, wordlist)) throw new UserError('恢复码不正确，请检查 24 个单词的拼写和顺序');
  return recoveryKeyOf(mnemonicToEntropy(m, wordlist));
}

/** 首次设置 / 轮换：新 CDK + 新恢复码（恢复码只返回这一次） */
export async function createCdk(syncPassword: string, keyVersion = 1): Promise<{ cdk: Buffer; wrapped: WrappedCdk; recoveryCode: string }> {
  checkSyncPassword(syncPassword);
  const cdk = randomBytes(32);
  const entropy = randomBytes(32);
  const recoveryCode = entropyToMnemonic(entropy, wordlist);
  const kdf = newArgon2Params();
  const wk = await deriveArgon2(syncPassword, kdf);
  return {
    cdk,
    recoveryCode,
    wrapped: {
      wrappedCdk: sealWith(wk, cdk, CDK_AAD(keyVersion)).toString('base64'),
      kdf,
      recoveryWrappedCdk: sealWith(recoveryKeyOf(entropy), cdk, CDK_AAD(keyVersion)).toString('base64'),
      keyVersion,
    },
  };
}

export async function unwrapCdk(w: Pick<WrappedCdk, 'wrappedCdk' | 'kdf' | 'keyVersion'>, syncPassword: string): Promise<Buffer> {
  const wk = await deriveArgon2(syncPassword, w.kdf);
  try {
    return openWith(wk, Buffer.from(w.wrappedCdk, 'base64'), CDK_AAD(w.keyVersion));
  } catch {
    throw new UserError('同步密码不正确');
  }
}

export function unwrapCdkWithRecovery(w: Pick<WrappedCdk, 'recoveryWrappedCdk' | 'keyVersion'>, words: string): Buffer {
  try {
    return openWith(recoveryKey(words), Buffer.from(w.recoveryWrappedCdk, 'base64'), CDK_AAD(w.keyVersion));
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError('恢复码不正确');
  }
}

/** 修改同步密码：只重新包装 CDK，数据不用重新加密 */
export async function rewrapCdk(cdk: Buffer, newPassword: string, keyVersion: number): Promise<Pick<WrappedCdk, 'wrappedCdk' | 'kdf'>> {
  checkSyncPassword(newPassword);
  const kdf = newArgon2Params();
  return { wrappedCdk: sealWith(await deriveArgon2(newPassword, kdf), cdk, CDK_AAD(keyVersion)).toString('base64'), kdf };
}

/** 用恢复码重置：新恢复码 + 新同步密码，CDK 不变 */
export async function resetWithRecovery(w: WrappedCdk, words: string, newPassword: string): Promise<{ cdk: Buffer; wrapped: WrappedCdk; recoveryCode: string }> {
  const cdk = unwrapCdkWithRecovery(w, words);
  const entropy = randomBytes(32);
  const re = await rewrapCdk(cdk, newPassword, w.keyVersion);
  return {
    cdk,
    recoveryCode: entropyToMnemonic(entropy, wordlist),
    wrapped: { ...re, recoveryWrappedCdk: sealWith(recoveryKeyOf(entropy), cdk, CDK_AAD(w.keyVersion)).toString('base64'), keyVersion: w.keyVersion },
  };
}
