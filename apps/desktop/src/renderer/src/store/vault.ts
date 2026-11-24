import { create } from 'zustand';
import type { Credential, CredentialType } from '@itm/protocol';
import { invoke } from '../api';

const DAY = 86_400_000;
/** 提前多少天提醒 */
export const REMIND_DAYS = 7;

interface VaultState {
  credentials: Credential[];
  reload(): Promise<void>;
}

export const useVault = create<VaultState>((set) => ({
  credentials: [],
  async reload() {
    set({ credentials: await invoke('credential.list') });
  },
}));

export const CREDENTIAL_TYPES: { value: CredentialType; label: string }[] = [
  { value: 'PASSWORD', label: '密码' },
  { value: 'SSH_KEY', label: 'SSH 密钥' },
  { value: 'OTP', label: 'TOTP 验证码' },
  { value: 'CLOUD_AK', label: '云厂商 AK' },
  { value: 'DB', label: '数据库账号' },
  { value: 'CERT', label: '证书' },
];

export const typeLabel = (t: CredentialType): string => CREDENTIAL_TYPES.find((x) => x.value === t)?.label ?? t;

export type CredentialHealth = { kind: 'ok' } | { kind: 'soon' | 'overdue'; reason: 'rotate' | 'expire'; days: number };

/** 轮换 / 到期提醒（文档一 6.6） */
export function credentialHealth(c: Credential, now = Date.now()): CredentialHealth {
  const checks: { reason: 'rotate' | 'expire'; at: number }[] = [];
  if (c.rotateDays) checks.push({ reason: 'rotate', at: c.rotatedAt + c.rotateDays * DAY });
  if (c.expiresAt) checks.push({ reason: 'expire', at: c.expiresAt });
  if (checks.length === 0) return { kind: 'ok' };
  const first = checks.reduce((a, b) => (a.at <= b.at ? a : b));
  const days = Math.ceil((first.at - now) / DAY);
  if (days <= 0) return { kind: 'overdue', reason: first.reason, days: -days };
  if (days <= REMIND_DAYS) return { kind: 'soon', reason: first.reason, days };
  return { kind: 'ok' };
}

/** 需要提醒的共享凭证（主机专属凭证没有轮换设置） */
export function dueCredentials(list: Credential[]): Credential[] {
  return list.filter((c) => !c.ownerHostId && credentialHealth(c).kind !== 'ok');
}
