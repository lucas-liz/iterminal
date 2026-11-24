// ------------------------------------------------------------------ 凭证管理（文档一 6.6）

export type CredentialType = 'PASSWORD' | 'SSH_KEY' | 'CERT' | 'OTP' | 'CLOUD_AK' | 'DB';

/** REFERENCE：Agent 可以通过引用使用（永远拿不到明文）；DENY：连引用都不能用 */
export type AiAccess = 'REFERENCE' | 'DENY';

export interface Credential {
  id: string;
  type: CredentialType;
  name: string;
  username: string | null;
  /** 主机专属凭证（在主机编辑框里直接填写的密码 / 私钥），凭证页默认不显示 */
  ownerHostId: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  /** 密钥算法，例如 ssh-ed25519、ssh-rsa */
  keyType: string | null;
  hasSecret: boolean;
  hasPassphrase: boolean;
  /** 带 TOTP 种子（两步验证的堡垒机：连接时自动填写验证码） */
  hasOtp: boolean;
  aiAccess: AiAccess;
  /** 建议轮换周期（天），到期提醒 */
  rotateDays: number | null;
  expiresAt: number | null;
  /** 最近一次修改秘密的时间（用于计算轮换到期） */
  rotatedAt: number;
  lastUsedAt: number | null;
  note: string | null;
  /** 引用这个凭证的主机和分组 */
  usedByHosts: number;
  usedByFolders: number;
  updatedAt: number;
}

/**
 * 新建 / 修改凭证。秘密字段：undefined = 不修改，null / 空串 = 清除，字符串 = 覆盖。
 * generate：由主进程生成密钥对（私钥不经过渲染进程）。
 */
export interface CredentialInput {
  type: CredentialType;
  name: string;
  username: string | null;
  /** PASSWORD / DB：密码；SSH_KEY / CERT：私钥；CLOUD_AK：Secret Key；OTP：不用 */
  secret?: string | null;
  passphrase?: string | null;
  /** TOTP 种子（Base32），OTP 类型必填，PASSWORD 类型可选 */
  otpSeed?: string | null;
  /** CERT：证书内容；SSH_KEY：可以只保存公钥 */
  publicKey?: string | null;
  generate?: { algorithm: 'ed25519' | 'rsa'; bits?: 2048 | 3072 | 4096; comment?: string; passphrase?: string };
  aiAccess: AiAccess;
  rotateDays: number | null;
  expiresAt: number | null;
  note: string | null;
}

/** 查看明文的结果，界面显示 ttlSec 秒后自动隐藏 */
export interface CredentialSecretView {
  secret: string | null;
  passphrase: string | null;
  otpSeed: string | null;
  ttlSec: number;
}

export interface TotpCode {
  code: string;
  /** 当前验证码剩余有效秒数 */
  remainingSec: number;
}

/** 批量部署公钥（ssh-copy-id）/ 轮换时每台主机的结果 */
export interface DeployResult {
  hostId: string;
  hostName: string;
  status: 'ok' | 'skipped' | 'error';
  message: string;
}

export interface RotateReport {
  credentialId: string;
  /** 新公钥指纹 */
  fingerprint: string;
  steps: { hostId: string; hostName: string; deploy: DeployResult['status']; verify: DeployResult['status']; revoke: DeployResult['status']; message: string }[];
  /** 所有主机都验证通过后才替换凭证；否则保留旧密钥，新公钥已部署的主机需要手动处理 */
  replaced: boolean;
}

export interface RotateProgress {
  credentialId: string;
  hostId: string;
  stage: 'deploy' | 'verify' | 'revoke';
  status: 'running' | 'ok' | 'error';
  message?: string;
}

// ------------------------------------------------------------------ 本地密钥与锁定（文档一 10.2）

export interface SecurityState {
  /** 档案已经打开，可以使用 */
  ready: boolean;
  /** 界面已锁定（档案仍然打开，终端会话继续运行） */
  locked: boolean;
  masterPassword: boolean;
  /** Linux 没有系统钥匙串：必须先设置主密码 */
  needsSetup: boolean;
  /** 这台电脑支持 Touch ID */
  touchIdAvailable: boolean;
}
