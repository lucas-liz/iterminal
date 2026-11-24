import { randomUUID } from 'node:crypto';
import type {
  FileTransfer,
  FileTransferMode,
  AgentPolicy,
  AuthMethod,
  EffectiveHostPolicy,
  Host,
  HostAgentMemory,
  HostInput,
  HostProtocol,
  ProxyConfig,
  SerialOptions,
} from '@itm/protocol';
import { AGENT_POLICIES as POLICIES } from '@itm/protocol';
import type { Db } from '../db/database';
import { open, seal } from '../vault/vault';
import { checkPrivateKey, type CredentialRepo, type CredentialSecrets } from '../vault/credential-repo';
import { UserError } from '../../util/errors';
import type { FolderRepo } from './folder-repo';
import { resolveHostPolicy } from './policy';
import { normalizeTags, type TagRepo } from './tag-repo';

const PROTOCOLS: readonly HostProtocol[] = ['SSH', 'TELNET', 'SERIAL'];
const AUTH_METHODS: readonly AuthMethod[] = ['PASSWORD', 'KEY', 'AGENT', 'INTERACTIVE', 'CREDENTIAL'];
/** 支持的终端编码（解码用 TextDecoder，编码用 iconv-lite） */
export const ENCODINGS = ['UTF-8', 'GBK', 'GB18030', 'BIG5', 'SHIFT_JIS', 'EUC-JP', 'EUC-KR', 'ISO-8859-1', 'WINDOWS-1252'] as const;
/** 跳板链最多几跳 */
export const MAX_JUMPS = 5;

/** 连接时解析出的认证信息（主进程内部使用，**不能**发给渲染进程） */
export interface ResolvedAuth {
  method: 'PASSWORD' | 'KEY' | 'AGENT' | 'INTERACTIVE';
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** 两步验证的堡垒机：keyboard-interactive 要验证码时自动填写 */
  otpSeed?: string;
  /** 用户在提示框里输入的密码 / 口令可以记住到主机自己的凭证里（共享凭证不能被改写） */
  rememberable: boolean;
  /** 使用的共享凭证（用于记录最近使用时间） */
  credentialId: string | null;
}

/** 主进程内部使用：连接时需要的完整信息 */
export interface ConnectInfo {
  host: Host;
  auth: ResolvedAuth;
  /** 继承后的跳板链 */
  jumpHostIds: string[];
  proxy: (Omit<ProxyConfig, 'hasPassword'> & { password?: string }) | null;
}

interface HostRow {
  team_reveal: number | null;
  id: string;
  folder_id: string | null;
  name: string;
  protocol: HostProtocol;
  address: string;
  port: number;
  username: string | null;
  auth_method: AuthMethod;
  credential_id: string | null;
  serial_opts: string | null;
  proxy: string | null;
  proxy_password_enc: Buffer | null;
  encoding: string | null;
  term_type: string | null;
  env: string | null;
  keepalive_sec: number;
  startup_script: string | null;
  monitor_script: string | null;
  file_transfer: string | null;
  agent_policy: AgentPolicy | null;
  cmd_denylist: string | null;
  ai_memory: string | null;
  os_info: string | null;
  note: string | null;
  record_session: number;
  jump_inherit: number;
  last_connected_at: number | null;
  updated_at: number;
  own_type: string | null;
  own_has_secret: number | null;
  fav: number | null;
}

const SELECT_HOST = `
  SELECT h.id, h.folder_id, h.name, h.protocol, h.address, h.port, h.username, h.auth_method, h.credential_id, h.serial_opts,
         h.proxy, h.proxy_password_enc, h.encoding, h.term_type, h.env, h.keepalive_sec, h.startup_script, h.agent_policy,
         h.cmd_denylist, h.ai_memory, h.os_info, h.note, h.record_session, h.jump_inherit, h.last_connected_at, h.updated_at, h.monitor_script, h.file_transfer, h.team_reveal,
         c.type AS own_type, (c.secret_enc IS NOT NULL) AS own_has_secret,
         (SELECT 1 FROM favorite f WHERE f.host_id = h.id AND f.deleted = 0) AS fav
    FROM host h
    LEFT JOIN credential c ON c.id = h.credential_id AND c.deleted = 0 AND c.owner_host_id = h.id
   WHERE h.deleted = 0`;

/** 规范化后的非秘密字段 */
type Normalized = Omit<Host, 'id' | 'hasPassword' | 'hasPrivateKey' | 'osInfo' | 'lastConnectedAt' | 'updatedAt' | 'proxy'> & {
  proxy: Omit<ProxyConfig, 'hasPassword'> | null;
};

export interface HostRepoDeps {
  credentials: CredentialRepo;
  tags: TagRepo;
  /** 由 index 在构造 FolderRepo 后注入（FolderRepo 的删除检查又依赖 HostRepo） */
  folders?: FolderRepo;
  /** 全局默认 Agent 权限（设置） */
  globalAgentPolicy?: () => AgentPolicy;
}

/**
 * 主机。认证方式为 PASSWORD / KEY 时，密码 / 私钥保存在这台主机的专属凭证里（credential.owner_host_id = host.id）；
 * CREDENTIAL 时引用保险库里的共享凭证，或者继承分组的默认凭证。
 */
export class HostRepo {
  private folders: FolderRepo | null;

  constructor(
    private readonly db: Db,
    private readonly vaultKey: Buffer,
    private readonly deps: HostRepoDeps,
    private readonly now: () => number = Date.now,
  ) {
    this.folders = deps.folders ?? null;
  }

  attachFolders(folders: FolderRepo): void {
    this.folders = folders;
  }

  list(): Host[] {
    const jumps = this.allJumps();
    const tags = this.deps.tags.tagsByHost();
    return this.db
      .prepare<[], HostRow>(`${SELECT_HOST} ORDER BY h.name COLLATE NOCASE`)
      .all()
      .map((r) => toHost(r, jumps.get(r.id) ?? [], tags.get(r.id) ?? []));
  }

  get(id: string): Host | null {
    const row = this.db.prepare<[string], HostRow>(`${SELECT_HOST} AND h.id = ?`).get(id);
    return row ? toHost(row, this.jumpsOf(id), this.deps.tags.tagsByHost().get(id) ?? []) : null;
  }

  jumpsOf(id: string): string[] {
    return this.db
      .prepare<[string], { jump_host_id: string }>('SELECT jump_host_id FROM host_jump WHERE host_id = ? ORDER BY seq')
      .all(id)
      .map((r) => r.jump_host_id);
  }

  require(id: string): Host {
    const h = this.get(id);
    if (!h) {
      throw new UserError('主机不存在或已被删除');
    }
    return h;
  }

  create(input: HostInput): Host {
    const v = this.normalize(input, null);
    const secrets = mergeSecrets({}, input, v.authMethod);
    if (v.authMethod === 'KEY') checkPrivateKey(secrets.privateKey, secrets.passphrase);
    const id = randomUUID();
    this.validateJumps(id, v.jumpHostIds);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO host (id, folder_id, name, protocol, address, port, username, auth_method, credential_id, keepalive_sec,
                             startup_script, note, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
        )
        .run(id, v.folderId, v.name, v.protocol, v.address, v.port, v.username, v.authMethod, v.keepaliveSec, v.startupScript, v.note, this.now());
      this.write(id, v, input, secrets, null);
    })();
    return this.require(id);
  }

  update(id: string, input: HostInput): Host {
    const current = this.require(id);
    const v = this.normalize(input, current);
    const ownId = this.ownCredentialId(id);
    const secrets = mergeSecrets(this.ownSecrets(ownId), input, v.authMethod);
    if (v.authMethod === 'KEY') checkPrivateKey(secrets.privateKey, secrets.passphrase);
    this.validateJumps(id, v.jumpHostIds);
    this.db.transaction(() => this.write(id, v, input, secrets, ownId))();
    return this.require(id);
  }

  duplicate(id: string): Host {
    const src = this.require(id);
    const secrets = this.ownSecrets(this.ownCredentialId(id));
    const row = this.db.prepare<[string], { proxy_password_enc: Buffer | null }>('SELECT proxy_password_enc FROM host WHERE id = ?').get(id);
    const proxyPassword = row?.proxy_password_enc ? open(this.vaultKey, row.proxy_password_enc, `host_proxy:${id}`) : null;
    const input: HostInput = {
      ...src,
      name: `${src.name} (副本)`,
      proxy: src.proxy ? { type: src.proxy.type, host: src.proxy.host, port: src.proxy.port, username: src.proxy.username } : null,
      proxyPassword,
      password: secrets.password ?? null,
      privateKey: secrets.privateKey ?? null,
      passphrase: secrets.passphrase ?? null,
      favorite: false,
    };
    return this.create(input);
  }

  delete(ids: string[]): void {
    this.ensureNotUsedAsJump(ids);
    const now = this.now();
    this.db.transaction(() => {
      this.deps.credentials.deleteDedicatedOf(ids);
      for (const id of ids) {
        this.db.prepare('UPDATE host SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0').run(now, id);
        this.db.prepare('DELETE FROM host_jump WHERE host_id = ?').run(id);
        this.db.prepare('UPDATE host_tag SET deleted = 1, updated_at = ? WHERE host_id = ? AND deleted = 0').run(now, id);
        this.db.prepare('UPDATE favorite SET deleted = 1, updated_at = ? WHERE host_id = ? AND deleted = 0').run(now, id);
      }
    })();
  }

  /**
   * 被其他主机用作跳板、或者是某个分组默认跳板机的主机不能直接删除：删掉后那些主机会悄悄变成直连，可能连到错误的网络。
   * deletingFolderPath：连带删除整个分组时，分组子树里的分组设置不算引用。
   */
  ensureNotUsedAsJump(ids: string[], deletingFolderPath: string | null = null): void {
    if (ids.length === 0) {
      return;
    }
    const removing = new Set(ids);
    const rows = this.db
      .prepare<[], { host_id: string; jump_host_id: string; name: string; jump_name: string }>(
        `SELECT j.host_id, j.jump_host_id, h.name, jh.name AS jump_name
           FROM host_jump j
           JOIN host h ON h.id = j.host_id AND h.deleted = 0
           JOIN host jh ON jh.id = j.jump_host_id`,
      )
      .all()
      .filter((r) => removing.has(r.jump_host_id) && !removing.has(r.host_id));
    if (rows.length > 0) {
      const jump = rows[0].jump_name;
      const users = [...new Set(rows.filter((r) => r.jump_name === jump).map((r) => r.name))];
      throw new UserError(`「${jump}」是「${users.slice(0, 3).join('、')}${users.length > 3 ? ' 等' : ''}」的跳板机，请先修改这些主机的跳板设置`);
    }
    const folder = this.db
      .prepare<[], { name: string; jump_id: string; jump_name: string; path: string }>(
        `SELECT f.name, f.default_jump_host_id AS jump_id, h.name AS jump_name, f.path FROM folder f
           JOIN host h ON h.id = f.default_jump_host_id WHERE f.deleted = 0`,
      )
      .all()
      .find((r) => removing.has(r.jump_id) && !(deletingFolderPath && r.path.startsWith(deletingFolderPath)));
    if (folder) throw new UserError(`「${folder.jump_name}」是分组「${folder.name}」的默认跳板机，请先修改分组设置`);
  }

  move(hostIds: string[], folderId: string | null): void {
    this.requireFolder(folderId);
    const now = this.now();
    const stmt = this.db.prepare('UPDATE host SET folder_id = ?, updated_at = ? WHERE id = ? AND deleted = 0');
    this.db.transaction(() => hostIds.forEach((id) => stmt.run(folderId, now, id)))();
  }

  setFavorite(id: string, on: boolean): void {
    this.require(id);
    this.writeFavorite(id, on);
  }

  // ---------------------------------------------------------------- 继承与连接

  /** 有效配置（文档一 6.5）；id 为空时按新建主机计算（只继承分组） */
  effective(id: string | null, folderId: string | null): EffectiveHostPolicy {
    const host = id ? this.require(id) : null;
    const draft = host ?? { id: '__new__', authMethod: 'CREDENTIAL' as AuthMethod, credentialId: null, jumpHostIds: [], jumpInherit: true, agentPolicy: null };
    return resolveHostPolicy(draft, this.folders?.chain(host ? host.folderId : folderId) ?? [], this.globalPolicy());
  }

  /** 连接用：带解密后的秘密和继承后的跳板链，只在主进程内使用。 */
  connectInfo(id: string): ConnectInfo {
    const host = this.require(id);
    const row = this.db.prepare<[string], { proxy_password_enc: Buffer | null }>('SELECT proxy_password_enc FROM host WHERE id = ?').get(id);
    const proxyPassword = row?.proxy_password_enc ? open(this.vaultKey, row.proxy_password_enc, `host_proxy:${id}`) : undefined;
    return this.resolve(host, this.ownSecrets(this.ownCredentialId(id)), proxyPassword);
  }

  /**
   * 测试连接用：按表单内容构造一个临时的连接目标（不保存）。修改已有主机时，留空的秘密沿用已保存的。
   */
  testTarget(id: string | null, input: HostInput): ConnectInfo {
    const current = id ? this.require(id) : null;
    const v = this.normalize(input, current);
    const secrets = mergeSecrets(id ? this.ownSecrets(this.ownCredentialId(id)) : {}, input, v.authMethod);
    if (v.authMethod === 'KEY') checkPrivateKey(secrets.privateKey, secrets.passphrase);
    this.validateJumps(id ?? '__test__', v.jumpHostIds);
    let proxyPassword: string | undefined;
    if (input.proxyPassword !== undefined) proxyPassword = input.proxyPassword || undefined;
    else if (id) {
      const row = this.db.prepare<[string], { proxy_password_enc: Buffer | null }>('SELECT proxy_password_enc FROM host WHERE id = ?').get(id);
      proxyPassword = row?.proxy_password_enc ? open(this.vaultKey, row.proxy_password_enc, `host_proxy:${id}`) : undefined;
    }
    const host: Host = {
      ...v,
      id: id ?? '__test__',
      proxy: v.proxy ? { ...v.proxy, hasPassword: !!proxyPassword } : null,
      hasPassword: !!secrets.password,
      hasPrivateKey: !!secrets.privateKey,
      osInfo: null,
      lastConnectedAt: null,
      updatedAt: this.now(),
    };
    return this.resolve(host, secrets, proxyPassword);
  }

  private resolve(host: Host, own: CredentialSecrets, proxyPassword: string | undefined): ConnectInfo {
    const eff = resolveHostPolicy(host, this.folders?.chain(host.folderId) ?? [], this.globalPolicy());
    let auth: ResolvedAuth;
    switch (host.authMethod) {
      case 'PASSWORD':
        auth = { method: 'PASSWORD', username: host.username, password: own.password, rememberable: true, credentialId: null };
        break;
      case 'KEY':
        auth = { method: 'KEY', username: host.username, privateKey: own.privateKey, passphrase: own.passphrase, rememberable: true, credentialId: null };
        break;
      case 'AGENT':
        auth = { method: 'AGENT', username: host.username, rememberable: false, credentialId: null };
        break;
      case 'INTERACTIVE':
        auth = { method: 'INTERACTIVE', username: host.username, rememberable: true, credentialId: null };
        break;
      case 'CREDENTIAL': {
        const cred = eff.credentialId ? this.deps.credentials.get(eff.credentialId) : null;
        const s = cred ? this.deps.credentials.secrets(cred.id) : {};
        const username = host.username || cred?.username || '';
        if (cred?.type === 'SSH_KEY' && s.privateKey) {
          auth = { method: 'KEY', username, privateKey: s.privateKey, passphrase: s.passphrase, otpSeed: s.otpSeed, rememberable: false, credentialId: cred.id };
        } else if ((cred?.type === 'PASSWORD' || cred?.type === 'DB') && s.password) {
          auth = { method: 'PASSWORD', username, password: s.password, otpSeed: s.otpSeed, rememberable: false, credentialId: cred.id };
        } else {
          // 没有可用的凭证（被删除、只有 TOTP 等）：连接时询问密码
          auth = { method: 'INTERACTIVE', username, otpSeed: s.otpSeed, rememberable: false, credentialId: cred?.id ?? null };
        }
        break;
      }
    }
    if (host.protocol === 'SSH' && !auth.username) {
      throw new UserError(`「${host.name}」没有设置用户名：请在主机或它使用的凭证里填写`);
    }
    return {
      host,
      auth,
      jumpHostIds: eff.jumpHostIds,
      proxy: host.proxy ? { type: host.proxy.type, host: host.proxy.host, port: host.proxy.port, username: host.proxy.username, password: proxyPassword } : null,
    };
  }

  /**
   * 跳板链校验：跳板主机必须存在、不能是自己、不能重复、最多 MAX_JUMPS 跳；
   * 第一跳会按它自己的跳板设置连接，所以还要沿着「第一跳的第一跳……」检查有没有绕回自己。
   */
  private validateJumps(selfId: string, jumpIds: string[]): void {
    if (jumpIds.length > MAX_JUMPS) {
      throw new UserError(`跳板机最多 ${MAX_JUMPS} 个`);
    }
    if (new Set(jumpIds).size !== jumpIds.length) {
      throw new UserError('跳板机不能重复');
    }
    for (const jid of jumpIds) {
      if (jid === selfId) {
        throw new UserError('不能把主机自己设为跳板机');
      }
      const j = this.get(jid);
      if (!j) {
        throw new UserError('选择的跳板机不存在或已被删除');
      }
      if (j.protocol !== 'SSH') throw new UserError(`「${j.name}」不是 SSH 主机，不能作为跳板机`);
    }
    const seen = new Set<string>();
    for (let cur = jumpIds[0]; cur; cur = this.jumpsOf(cur)[0]) {
      if (cur === selfId || seen.has(cur)) {
        throw new UserError('跳板设置形成了循环（跳板机最终又经过这台主机）');
      }
      seen.add(cur);
    }
  }

  private saveJumps(hostId: string, jumpIds: string[]): void {
    this.db.prepare('DELETE FROM host_jump WHERE host_id = ?').run(hostId);
    const stmt = this.db.prepare('INSERT INTO host_jump (host_id, seq, jump_host_id) VALUES (?, ?, ?)');
    jumpIds.forEach((jid, i) => stmt.run(hostId, i, jid));
  }

  private allJumps(): Map<string, string[]> {
    const jumps = new Map<string, string[]>();
    this.db
      .prepare<[], { host_id: string; jump_host_id: string }>('SELECT host_id, jump_host_id FROM host_jump ORDER BY host_id, seq')
      .all()
      .forEach((r) => jumps.set(r.host_id, [...(jumps.get(r.host_id) ?? []), r.jump_host_id]));
    return jumps;
  }

  /**
   * 连接时用户在密码框里勾选了「记住」：保存密码（交互式认证的主机改为密码认证），或者保存私钥口令。
   * 使用共享凭证的主机不会走到这里（rememberable = false）。
   */
  remember(id: string, kind: 'password' | 'passphrase', value: string): void {
    const host = this.require(id);
    const credentialId = this.ownCredentialId(id);
    const secrets = this.ownSecrets(credentialId);
    let method = host.authMethod;
    if (kind === 'password') {
      if (method !== 'PASSWORD' && method !== 'INTERACTIVE') {
        return;
      }
      method = 'PASSWORD';
      secrets.password = value;
    } else {
      if (method !== 'KEY') {
        return;
      }
      secrets.passphrase = value;
    }
    this.db.transaction(() => {
      const newCredentialId = this.deps.credentials.saveDedicated(credentialId, id, host.name, host.username, method, secrets);
      this.db
        .prepare('UPDATE host SET auth_method = ?, credential_id = ?, updated_at = ? WHERE id = ?')
        .run(method, newCredentialId, this.now(), id);
    })();
  }

  touchConnected(id: string): void {
    this.db.prepare('UPDATE host SET last_connected_at = ? WHERE id = ?').run(this.now(), id);
  }

  setOsInfo(id: string, os: string): void {
    this.db.prepare('UPDATE host SET os_info = ? WHERE id = ?').run(os.slice(0, 200), id);
  }

  // ---------------------------------------------------------------- Agent 记下的主机记忆（第二十六轮，按条目）

  agentMemories(hostId: string): HostAgentMemory[] {
    return this.db
      .prepare<[string], { id: string; host_id: string; content: string; conversation_id: string | null; created_at: number; updated_at: number }>(
        'SELECT * FROM host_agent_memory WHERE host_id = ? ORDER BY created_at',
      )
      .all(hostId)
      .map((r) => ({ id: r.id, hostId: r.host_id, content: r.content, conversationId: r.conversation_id, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** 新增（id 为空）或修改一条；每台主机最多 50 条，每条最多 2000 字 */
  saveAgentMemory(id: string | null, hostId: string, content: string, conversationId: string | null = null): HostAgentMemory {
    this.require(hostId);
    const text = content.trim();
    if (!text) throw new UserError('记忆内容不能为空');
    if (text.length > 2000) throw new UserError('每条记忆不能超过 2000 个字');
    const now = this.now();
    if (id) {
      const r = this.db.prepare('UPDATE host_agent_memory SET content = ?, updated_at = ? WHERE id = ? AND host_id = ?').run(text, now, id, hostId);
      if (!r.changes) throw new UserError('这条记忆不存在');
    } else {
      const n = this.db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM host_agent_memory WHERE host_id = ?').get(hostId)?.n ?? 0;
      if (n >= 50) throw new UserError('这台主机的 Agent 记忆已经有 50 条，请先删除一些');
      id = randomUUID();
      this.db.prepare('INSERT INTO host_agent_memory (id, host_id, content, conversation_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, hostId, text, conversationId, now, now);
    }
    return this.agentMemories(hostId).find((m) => m.id === id)!;
  }

  deleteAgentMemory(id: string): void {
    this.db.prepare('DELETE FROM host_agent_memory WHERE id = ?').run(id);
  }

  /** 手工填写的主机记忆（主机编辑框里的「主机记忆」） */
  setAiMemory(id: string, memory: string | null): void {
    this.require(id);
    this.db.prepare('UPDATE host SET ai_memory = ?, updated_at = ? WHERE id = ?').run(memory?.slice(0, 8000) || null, this.now(), id);
  }

  // ---------------------------------------------------------------- 主机指纹

  knownFingerprint(address: string, port: number, keyType: string): string | null {
    const row = this.db
      .prepare<[string, number, string], { fingerprint: string }>(
        'SELECT fingerprint FROM known_host WHERE host = ? AND port = ? AND key_type = ?',
      )
      .get(address, port, keyType);
    return row?.fingerprint ?? null;
  }

  saveFingerprint(address: string, port: number, keyType: string, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT INTO known_host (host, port, key_type, fingerprint, added_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (host, port, key_type) DO UPDATE SET fingerprint = excluded.fingerprint, added_at = excluded.added_at`,
      )
      .run(address, port, keyType, fingerprint, this.now());
  }

  // ---------------------------------------------------------------- 内部

  /** 写入除基本列以外的字段、跳板、标签、收藏和专属凭证（调用方负责事务） */
  private write(id: string, v: Normalized, input: HostInput, secrets: CredentialSecrets, ownId: string | null): void {
    const own = v.authMethod === 'PASSWORD' || v.authMethod === 'KEY' ? secrets : {};
    const newOwnId = this.deps.credentials.saveDedicated(ownId, id, v.name, v.username, v.authMethod, own);
    if (!newOwnId && ownId) this.deps.credentials.deleteDedicatedOf([id]);
    const credentialId = v.authMethod === 'CREDENTIAL' ? v.credentialId : newOwnId;
    this.db
      .prepare(
        `UPDATE host SET folder_id = ?, name = ?, protocol = ?, address = ?, port = ?, username = ?, auth_method = ?, credential_id = ?,
                         serial_opts = ?, proxy = ?, encoding = ?, term_type = ?, env = ?, keepalive_sec = ?, startup_script = ?,
                         agent_policy = ?, cmd_denylist = ?, ai_memory = ?, note = ?, record_session = ?, jump_inherit = ?, monitor_script = ?, file_transfer = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        v.folderId, v.name, v.protocol, v.address, v.port, v.username, v.authMethod, credentialId,
        v.serial ? JSON.stringify(v.serial) : null, v.proxy ? JSON.stringify(v.proxy) : null, v.encoding, v.termType,
        Object.keys(v.env).length ? JSON.stringify(v.env) : null, v.keepaliveSec, v.startupScript, v.agentPolicy,
        v.cmdDenylist.length ? JSON.stringify(v.cmdDenylist) : null, v.aiMemory, v.note, v.recordSession ? 1 : 0, v.jumpInherit ? 1 : 0,
        v.monitorScript, v.fileTransfer ? JSON.stringify(v.fileTransfer) : null, this.now(), id,
      );
    // 代理密码：没有代理时清除；undefined 保持不变
    if (!v.proxy || input.proxyPassword !== undefined) {
      const enc = v.proxy && input.proxyPassword ? seal(this.vaultKey, input.proxyPassword, `host_proxy:${id}`) : null;
      this.db.prepare('UPDATE host SET proxy_password_enc = ? WHERE id = ?').run(enc, id);
    }
    this.saveJumps(id, v.jumpHostIds);
    this.deps.tags.setHostTags(id, v.tags);
    this.writeFavorite(id, v.favorite);
  }

  private writeFavorite(id: string, on: boolean): void {
    const now = this.now();
    if (on) {
      this.db
        .prepare(
          `INSERT INTO favorite (host_id, created_at, deleted, updated_at) VALUES (?, ?, 0, ?)
           ON CONFLICT (host_id) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at WHERE favorite.deleted = 1`,
        )
        .run(id, now, now);
    } else {
      this.db.prepare('UPDATE favorite SET deleted = 1, updated_at = ? WHERE host_id = ? AND deleted = 0').run(now, id);
    }
  }

  private ownCredentialId(hostId: string): string | null {
    const row = this.db
      .prepare<[string, string], { id: string }>('SELECT id FROM credential WHERE owner_host_id = ? AND deleted = 0 AND id = (SELECT credential_id FROM host WHERE id = ?)')
      .get(hostId, hostId);
    if (row) return row.id;
    const any = this.db.prepare<[string], { id: string }>('SELECT id FROM credential WHERE owner_host_id = ? AND deleted = 0 ORDER BY updated_at DESC').get(hostId);
    return any?.id ?? null;
  }

  private ownSecrets(credentialId: string | null): CredentialSecrets {
    if (!credentialId) return {};
    const s = this.deps.credentials.secrets(credentialId);
    return { password: s.password, privateKey: s.privateKey, passphrase: s.passphrase };
  }

  private globalPolicy(): AgentPolicy {
    return this.deps.globalAgentPolicy?.() ?? 'APPROVE';
  }

  private requireFolder(folderId: string | null): void {
    if (folderId && !this.db.prepare('SELECT 1 FROM folder WHERE id = ? AND deleted = 0').get(folderId)) {
      throw new UserError('分组不存在或已被删除');
    }
  }

  /** 校验并补齐默认值；current 为修改前的主机（可选字段不传时保持不变） */
  private normalize(input: HostInput, current: Host | null): Normalized {
    const protocol = input.protocol ?? current?.protocol ?? 'SSH';
    if (!PROTOCOLS.includes(protocol)) throw new UserError('不支持的协议');
    const address = (input.address ?? '').trim();
    if (!address) {
      throw new UserError(protocol === 'SERIAL' ? '请选择串口' : '请填写主机地址');
    }
    if (address.length > 255 || /\s/.test(address)) {
      throw new UserError(protocol === 'SERIAL' ? '串口名称不合法' : '主机地址不合法');
    }
    let port = Number(input.port);
    if (protocol === 'SERIAL') port = 0;
    else if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new UserError('端口必须是 1–65535 之间的整数');
    }
    const authMethod: AuthMethod = protocol === 'SERIAL' ? 'INTERACTIVE' : input.authMethod;
    if (!AUTH_METHODS.includes(authMethod)) {
      throw new UserError('不支持的认证方式');
    }
    if (protocol === 'TELNET' && (authMethod === 'KEY' || authMethod === 'AGENT')) throw new UserError('Telnet 只支持密码登录');
    const username = (input.username ?? '').trim();
    if (protocol === 'SSH' && !username && authMethod !== 'CREDENTIAL') {
      throw new UserError('请填写用户名');
    }
    if (username.length > 64) {
      throw new UserError('用户名不能超过 64 个字符');
    }
    const name = (input.name ?? '').trim() || address;
    if (name.length > 64) {
      throw new UserError('名称不能超过 64 个字符');
    }
    const keepaliveSec = Number(input.keepaliveSec ?? 30);
    if (!Number.isInteger(keepaliveSec) || keepaliveSec < 0 || keepaliveSec > 3600) {
      throw new UserError('心跳间隔必须是 0–3600 秒');
    }
    this.requireFolder(input.folderId ?? null);
    const credentialId = authMethod === 'CREDENTIAL' ? (input.credentialId === undefined ? (current?.credentialId ?? null) : input.credentialId || null) : null;
    if (credentialId) this.deps.credentials.requireShared(credentialId);

    const keep = <K extends keyof Host>(k: K, fallback: Host[K]): Host[K] => (current ? current[k] : fallback);
    const proxyIn = input.proxy === undefined ? (current?.proxy ? { type: current.proxy.type, host: current.proxy.host, port: current.proxy.port, username: current.proxy.username } : null) : input.proxy;
    const proxy = protocol === 'SERIAL' || !proxyIn ? null : validateProxy(proxyIn);
    const encoding = (input.encoding ?? keep('encoding', 'UTF-8')).toUpperCase();
    if (!(ENCODINGS as readonly string[]).includes(encoding)) throw new UserError(`不支持的编码 ${encoding}`);
    const termType = (input.termType ?? keep('termType', 'xterm-256color')).trim() || 'xterm-256color';
    if (!/^[\w.+-]{1,64}$/.test(termType)) throw new UserError('终端类型不合法');
    const env = validateEnv(input.env ?? keep('env', {}));
    const serial = protocol === 'SERIAL' ? validateSerial(input.serial ?? keep('serial', null)) : null;
    const agentPolicy = input.agentPolicy === undefined ? keep('agentPolicy', null) : input.agentPolicy || null;
    if (agentPolicy && !POLICIES.includes(agentPolicy)) throw new UserError('Agent 权限不合法');
    const cmdDenylist = validateDenylist(input.cmdDenylist ?? keep('cmdDenylist', []));
    const aiMemory = input.aiMemory === undefined ? keep('aiMemory', null) : (input.aiMemory ?? '').trim() || null;
    if (aiMemory && aiMemory.length > 8000) throw new UserError('主机记忆不能超过 8000 个字符');
    const jumpHostIds = protocol === 'SERIAL' ? [] : Array.isArray(input.jumpHostIds) ? input.jumpHostIds.filter((x) => typeof x === 'string') : [];
    return {
      folderId: input.folderId ?? null,
      name,
      protocol,
      address,
      port,
      username,
      authMethod,
      credentialId,
      keepaliveSec,
      startupScript: blankToNull(input.startupScript),
      note: blankToNull(input.note),
      jumpHostIds,
      jumpInherit: protocol === 'SERIAL' ? false : (input.jumpInherit ?? keep('jumpInherit', true)),
      proxy,
      encoding,
      termType,
      env,
      serial,
      agentPolicy,
      cmdDenylist,
      aiMemory,
      recordSession: input.recordSession ?? keep('recordSession', true),
      monitorScript: input.monitorScript !== undefined ? blankToNull(input.monitorScript)?.slice(0, 8000) ?? null : keep('monitorScript', null),
      fileTransfer: input.fileTransfer !== undefined ? normalizeFileTransfer(input.fileTransfer) : keep('fileTransfer', null),
      tags: normalizeTags(input.tags ?? keep('tags', [])),
      favorite: input.favorite ?? keep('favorite', false),
    };
  }
}

/** 按认证方式合并秘密：undefined 保持不变，null / 空串清除；和当前方式无关的秘密一律丢弃。 */
export function mergeSecrets(current: CredentialSecrets, input: HostInput, method: AuthMethod): CredentialSecrets {
  const pick = (next: string | null | undefined, prev: string | undefined): string | undefined =>
    next === undefined ? prev : next ? next : undefined;
  if (method === 'PASSWORD') {
    return strip({ password: pick(input.password, current.password) });
  }
  if (method === 'KEY') {
    return strip({
      privateKey: pick(input.privateKey, current.privateKey),
      passphrase: pick(input.passphrase, current.passphrase),
    });
  }
  return {};
}

function validateProxy(p: Omit<ProxyConfig, 'hasPassword'>): Omit<ProxyConfig, 'hasPassword'> {
  if (p.type !== 'SOCKS5' && p.type !== 'HTTP') throw new UserError('代理类型只能是 SOCKS5 或 HTTP');
  const host = (p.host ?? '').trim();
  if (!host || /\s/.test(host)) throw new UserError('请填写代理地址');
  const port = Number(p.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('代理端口不合法');
  return { type: p.type, host, port, username: (p.username ?? '').trim() || null };
}

function validateEnv(env: Record<string, string>): Record<string, string> {
  if (!env || typeof env !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new UserError(`环境变量名「${k}」不合法`);
    if (typeof val !== 'string' || val.length > 1024) throw new UserError(`环境变量 ${k} 的值不合法`);
    out[k] = val;
  }
  if (Object.keys(out).length > 50) throw new UserError('环境变量最多 50 个');
  return out;
}

const PARITIES = ['none', 'even', 'odd', 'mark', 'space'];
function validateSerial(s: SerialOptions | null): SerialOptions {
  if (!s) throw new UserError('请填写串口参数');
  const baudRate = Number(s.baudRate);
  if (!Number.isInteger(baudRate) || baudRate < 50 || baudRate > 4_000_000) throw new UserError('波特率不合法');
  if (![5, 6, 7, 8].includes(s.dataBits)) throw new UserError('数据位只能是 5–8');
  if (!PARITIES.includes(s.parity)) throw new UserError('校验位不合法');
  if (![1, 1.5, 2].includes(s.stopBits)) throw new UserError('停止位只能是 1、1.5 或 2');
  if (!['none', 'hardware', 'software'].includes(s.flowControl)) throw new UserError('流控不合法');
  if (!['CR', 'LF', 'CRLF'].includes(s.eol)) throw new UserError('换行符不合法');
  return { baudRate, dataBits: s.dataBits, parity: s.parity, stopBits: s.stopBits, flowControl: s.flowControl, eol: s.eol, localEcho: !!s.localEcho };
}

function validateDenylist(list: string[]): string[] {
  if (!Array.isArray(list)) return [];
  const out = list.map((x) => String(x).trim()).filter(Boolean);
  if (out.length > 100) throw new UserError('命令黑名单最多 100 条');
  for (const re of out) {
    try {
      new RegExp(re);
    } catch {
      throw new UserError(`命令黑名单里的「${re}」不是合法的正则表达式`);
    }
  }
  return out;
}

function strip(s: CredentialSecrets): CredentialSecrets {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as CredentialSecrets;
}

function blankToNull(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t ? t : null;
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function toHost(r: HostRow, jumpHostIds: string[], tags: string[]): Host {
  const hasSecret = !!r.own_has_secret;
  const proxy = parseJson<Omit<ProxyConfig, 'hasPassword'> | null>(r.proxy, null);
  return {
    id: r.id,
    folderId: r.folder_id,
    name: r.name,
    protocol: r.protocol,
    address: r.address,
    port: r.port,
    username: r.username ?? '',
    authMethod: r.auth_method,
    credentialId: r.auth_method === 'CREDENTIAL' ? r.credential_id : null,
    hasPassword: hasSecret && r.own_type === 'PASSWORD',
    hasPrivateKey: hasSecret && r.own_type === 'SSH_KEY',
    keepaliveSec: r.keepalive_sec,
    startupScript: r.startup_script,
    note: r.note,
    jumpHostIds,
    jumpInherit: !!r.jump_inherit,
    proxy: proxy ? { ...proxy, hasPassword: !!r.proxy_password_enc } : null,
    encoding: r.encoding ?? 'UTF-8',
    termType: r.term_type ?? 'xterm-256color',
    env: parseJson<Record<string, string>>(r.env, {}),
    serial: parseJson<SerialOptions | null>(r.serial_opts, null),
    agentPolicy: r.agent_policy,
    cmdDenylist: parseJson<string[]>(r.cmd_denylist, []),
    aiMemory: r.ai_memory,
    recordSession: r.record_session !== 0,
    monitorScript: r.monitor_script ?? null,
    fileTransfer: normalizeFileTransfer(parseJson<FileTransfer | null>(r.file_transfer, null)),
    tags,
    favorite: !!r.fav,
    osInfo: r.os_info,
    lastConnectedAt: r.last_connected_at,
    updatedAt: r.updated_at,
    team: r.team_reveal === null || r.team_reveal === undefined ? null : { allowReveal: r.team_reveal === 1 },
  };
}

const FILE_TRANSFER_MODES: FileTransferMode[] = ['AUTO', 'SFTP', 'SHELL', 'FTP', 'FTPS'];
/** 文件传输方式：自动且默认端口时存 null */
export function normalizeFileTransfer(v: unknown): FileTransfer | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<FileTransfer>;
  const mode = FILE_TRANSFER_MODES.includes(o.mode as FileTransferMode) ? (o.mode as FileTransferMode) : 'AUTO';
  const port = Number(o.ftpPort);
  const ftpPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 21;
  return mode === 'AUTO' && ftpPort === 21 ? null : { mode, ftpPort };
}
