import { hkdfSync, randomBytes } from 'node:crypto';
import { argon2id } from 'hash-wasm';

/**
 * Argon2id 参数（文档一 6.10.4：64MB、t=3）。Electron 的 Node 基于 BoringSSL，不支持 crypto.argon2，
 * 这里用 hash-wasm 的 WASM 实现（约 100ms）。
 */
export interface Argon2Params {
  /** base64 */
  salt: string;
  memKiB: number;
  iterations: number;
  parallelism: number;
}

export const DEFAULT_ARGON2: Omit<Argon2Params, 'salt'> = { memKiB: 64 * 1024, iterations: 3, parallelism: 1 };

export function newArgon2Params(): Argon2Params {
  return { salt: randomBytes(16).toString('base64'), ...DEFAULT_ARGON2 };
}

/** 参数来自本地文件或服务端托管的数据，限制范围，防止被篡改成耗尽内存的值 */
export function checkArgon2Params(p: Argon2Params): void {
  const ok =
    typeof p?.salt === 'string' &&
    Buffer.from(p.salt, 'base64').length >= 16 &&
    Number.isInteger(p.memKiB) && p.memKiB >= 8 * 1024 && p.memKiB <= 1024 * 1024 &&
    Number.isInteger(p.iterations) && p.iterations >= 1 && p.iterations <= 20 &&
    Number.isInteger(p.parallelism) && p.parallelism >= 1 && p.parallelism <= 8;
  if (!ok) throw new Error('密钥派生参数不合法');
}

export async function deriveArgon2(password: string, p: Argon2Params): Promise<Buffer> {
  checkArgon2Params(p);
  const out = await argon2id({
    password: password.normalize('NFKC'),
    salt: Buffer.from(p.salt, 'base64'),
    parallelism: p.parallelism,
    iterations: p.iterations,
    memorySize: p.memKiB,
    hashLength: 32,
    outputType: 'binary',
  });
  return Buffer.from(out);
}

export function hkdf(ikm: Buffer | string, salt: string, info: string, length = 32): Buffer {
  return Buffer.from(hkdfSync('sha256', typeof ikm === 'string' ? Buffer.from(ikm, 'utf8') : ikm, Buffer.from(salt, 'utf8'), Buffer.from(info, 'utf8'), length));
}
