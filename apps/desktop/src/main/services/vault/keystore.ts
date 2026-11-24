import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deriveArgon2, newArgon2Params, type Argon2Params } from '../../util/kdf';
import { open, seal } from './vault';

/**
 * 把本地密钥交给系统钥匙串保护（生产环境是 Electron safeStorage：macOS 钥匙串 / Windows DPAPI / Linux Secret Service）。
 * safeStorage 只能加密字符串：传入的 plain 必须是 UTF-8 文本（二进制先编码成 base64）。
 */
export interface KeyProtector {
  encrypt(plain: Buffer): Buffer;
  decrypt(sealed: Buffer): Buffer;
  /** weak = 没有系统钥匙串（Linux basic_text），密钥只做了混淆 */
  readonly strength: 'os' | 'weak';
}

/** 档案的本地密钥（文档一 10.2）：整库加密用 dbKey，凭证等秘密字段再用 vaultKey 加密一层。 */
export interface ProfileKeys {
  dbKey: Buffer;
  vaultKey: Buffer;
}

/**
 * {userData}/kek.json。KEK（本地密钥加密密钥）随机生成，保存为：
 * - 未设置主密码：safeStorage(KEK)
 * - 设置了主密码：safeStorage(AES-256-GCM(Argon2id(主密码), KEK))，必须同时拿到钥匙串和主密码才能解开
 * 修改主密码只重新包装 KEK，各档案的密钥文件不用改。
 */
interface KekFile {
  v: 2;
  wrapped: string;
  master: Argon2Params | null;
}

/** 档案密钥文件 v2：AES-256-GCM(KEK, {dbKey, vaultKey})，AAD = profile:{id} */
interface ProfileKeyFileV2 {
  v: 2;
  sealed: string;
}

/** v0.1 / v0.2 的档案密钥文件：safeStorage 直接加密的 JSON */
interface ProfileKeyFileV1 {
  v: 1;
  dbKey: string;
  vaultKey: string;
}

const KEK_AAD = 'itm-kek';

export class WrongPasswordError extends Error {
  constructor() {
    super('主密码不正确');
    this.name = 'WrongPasswordError';
  }
}

function writeAtomic(file: string, content: Buffer | string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // 先写临时文件再改名，避免写一半时崩溃留下损坏的密钥文件
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { mode });
  renameSync(tmp, file);
}

/**
 * 本地密钥层级（文档一 10.2）：系统钥匙串 +（可选）主密码 → KEK → 各档案的 DB Key / Field Key。
 * KEK 只在内存里；界面锁定不会丢掉它（终端会话继续运行），冷启动时开启了主密码就必须重新输入。
 */
export class KeyStore {
  private kek: Buffer | null = null;

  constructor(
    private readonly root: string,
    private readonly protector: KeyProtector,
  ) {}

  get file(): string {
    return join(this.root, 'kek.json');
  }

  private read(): KekFile | null {
    if (!existsSync(this.file)) return null;
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as KekFile;
    if (parsed?.v !== 2 || typeof parsed.wrapped !== 'string') throw new Error(`密钥文件格式不正确：${this.file}`);
    return parsed;
  }

  hasMasterPassword(): boolean {
    return !!this.read()?.master;
  }

  isUnlocked(): boolean {
    return this.kek !== null;
  }

  /**
   * 解开 KEK。第一次运行时生成新的 KEK（没有主密码）；开启了主密码时必须提供，错误时抛 WrongPasswordError。
   */
  async unlock(password?: string): Promise<void> {
    const f = this.read();
    if (!f) {
      const kek = randomBytes(32);
      this.save(kek, null, null);
      this.kek = kek;
      return;
    }
    this.kek = await this.unwrap(f, password);
  }

  /** 校验主密码（查看凭证明文前的重新验证），不改变状态 */
  async verify(password: string): Promise<boolean> {
    const f = this.read();
    if (!f?.master) return false;
    try {
      const kek = await this.unwrap(f, password);
      return !!this.kek && kek.length === this.kek.length && timingSafeEqual(kek, this.kek);
    } catch {
      return false;
    }
  }

  /** 设置或修改主密码。已经设置过时必须提供当前主密码。 */
  async setMasterPassword(newPassword: string, currentPassword?: string): Promise<void> {
    const kek = this.requireKek();
    const f = this.read();
    if (f?.master) {
      if (!currentPassword || !(await this.verify(currentPassword))) throw new WrongPasswordError();
    }
    const params = newArgon2Params();
    const pwKey = await deriveArgon2(newPassword, params);
    this.save(kek, params, pwKey);
  }

  async removeMasterPassword(currentPassword: string): Promise<void> {
    const kek = this.requireKek();
    if (!(await this.verify(currentPassword))) throw new WrongPasswordError();
    this.save(kek, null, null);
  }

  /**
   * 读取档案密钥；档案第一次使用时随机生成。v1 的密钥文件（safeStorage 直接加密）自动迁移为 v2。
   * 解不开时直接报错，**不会**重新生成（重新生成等于丢掉整个本地库）。
   */
  profileKeys(dir: string, profileId: string): ProfileKeys {
    const kek = this.requireKek();
    const file = join(dir, 'keys.bin');
    const aad = `profile:${profileId}`;
    if (!existsSync(file)) {
      const keys: ProfileKeys = { dbKey: randomBytes(32), vaultKey: randomBytes(32) };
      this.writeProfileKeys(file, kek, aad, keys);
      return keys;
    }
    const raw = readFileSync(file);
    let v2: ProfileKeyFileV2 | null = null;
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as ProfileKeyFileV2;
      if (parsed?.v === 2 && typeof parsed.sealed === 'string') v2 = parsed;
    } catch {
      // 不是 JSON：v1 文件（safeStorage 密文）
    }
    if (v2) {
      try {
        const keys = JSON.parse(open(kek, Buffer.from(v2.sealed, 'base64'), aad)) as { dbKey: string; vaultKey: string };
        return { dbKey: Buffer.from(keys.dbKey, 'hex'), vaultKey: Buffer.from(keys.vaultKey, 'hex') };
      } catch (e) {
        throw new Error(`无法解开本地数据密钥（${file}），密钥文件 kek.json 可能被替换或损坏：${(e as Error).message}`);
      }
    }
    let v1: ProfileKeyFileV1;
    try {
      v1 = JSON.parse(this.protector.decrypt(raw).toString('utf8')) as ProfileKeyFileV1;
    } catch (e) {
      throw new Error(`无法解开本地数据密钥（${file}），系统钥匙串可能被重置：${(e as Error).message}`);
    }
    const keys: ProfileKeys = { dbKey: Buffer.from(v1.dbKey, 'hex'), vaultKey: Buffer.from(v1.vaultKey, 'hex') };
    // 保留旧文件，直到确认新文件能打开数据库（confirmMigration）
    renameSync(file, `${file}.v1.bak`);
    this.writeProfileKeys(file, kek, aad, keys);
    return keys;
  }

  /** 数据库用迁移后的密钥打开成功后，删除旧版密钥文件 */
  confirmMigration(dir: string): void {
    rmSync(join(dir, 'keys.bin.v1.bak'), { force: true });
  }

  private writeProfileKeys(file: string, kek: Buffer, aad: string, keys: ProfileKeys): void {
    const content: ProfileKeyFileV2 = {
      v: 2,
      sealed: seal(kek, JSON.stringify({ dbKey: keys.dbKey.toString('hex'), vaultKey: keys.vaultKey.toString('hex') }), aad).toString('base64'),
    };
    writeAtomic(file, JSON.stringify(content));
  }

  private requireKek(): Buffer {
    if (!this.kek) throw new Error('本地密钥尚未解锁');
    return this.kek;
  }

  private async unwrap(f: KekFile, password: string | undefined): Promise<Buffer> {
    let inner: Buffer;
    try {
      inner = Buffer.from(this.protector.decrypt(Buffer.from(f.wrapped, 'base64')).toString('utf8'), 'base64');
    } catch (e) {
      throw new Error(`无法用系统钥匙串解开本地密钥（${this.file}）：${(e as Error).message}`);
    }
    if (!f.master) return inner;
    if (!password) throw new WrongPasswordError();
    const pwKey = await deriveArgon2(password, f.master);
    try {
      return Buffer.from(open(pwKey, inner, KEK_AAD), 'base64');
    } catch {
      throw new WrongPasswordError();
    }
  }

  private save(kek: Buffer, master: Argon2Params | null, pwKey: Buffer | null): void {
    const inner = master && pwKey ? seal(pwKey, kek.toString('base64'), KEK_AAD) : kek;
    const content: KekFile = { v: 2, wrapped: this.protector.encrypt(Buffer.from(inner.toString('base64'), 'utf8')).toString('base64'), master };
    writeAtomic(this.file, JSON.stringify(content, null, 2));
  }
}
