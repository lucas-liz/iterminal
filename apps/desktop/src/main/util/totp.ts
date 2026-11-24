import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 解码（忽略空格、连字符和填充，不区分大小写） */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error('TOTP 种子不是合法的 Base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 接受纯 Base32 种子或 otpauth://totp/...?secret=XXX 链接 */
export function normalizeOtpSeed(input: string): string {
  const t = input.trim();
  if (/^otpauth:\/\//i.test(t)) {
    const secret = new URL(t).searchParams.get('secret');
    if (!secret) throw new Error('otpauth 链接里没有 secret');
    return normalizeOtpSeed(secret);
  }
  const seed = t.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (base32Decode(seed).length < 10) throw new Error('TOTP 种子太短');
  return seed;
}

/** RFC 6238 TOTP（HMAC-SHA1、30 秒、6 位），和 Google Authenticator 一致 */
export function totp(seed: string, now = Date.now(), step = 30, digits = 6): { code: string; remainingSec: number } {
  const key = base32Decode(seed);
  const counter = Math.floor(now / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  const code = String(bin % 10 ** digits).padStart(digits, '0');
  return { code, remainingSec: step - (Math.floor(now / 1000) % step) };
}

/** keyboard-interactive 的提示语看起来是在要一次性验证码 */
export function looksLikeOtpPrompt(prompt: string): boolean {
  return /(verification|one[- ]?time|otp|token|mfa|2fa|two[- ]factor|authenticator|code|验证码|动态|口令牌|令牌)/i.test(prompt) && !/password|密码/i.test(prompt);
}
