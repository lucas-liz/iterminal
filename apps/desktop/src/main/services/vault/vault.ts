import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * AES-256-GCM 加密，输出 iv(12) | ciphertext | tag(16)（和云端端到端加密的密文格式一致）。
 * aad 绑定记录身份（例如 credential:{id}），防止密文在不同记录之间被调换。
 */
export function seal(key: Buffer, plaintext: string, aad: string): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): string {
  if (sealed.length < IV_LEN + TAG_LEN) {
    throw new Error('密文长度不合法');
  }
  const iv = sealed.subarray(0, IV_LEN);
  const tag = sealed.subarray(sealed.length - TAG_LEN);
  const body = sealed.subarray(IV_LEN, sealed.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
