import { randomUUID } from 'node:crypto';
import type { AuthMethod, CredentialType, ItemCounts, SyncGroup } from '@itm/protocol';
import {
  emptyDataset,
  GROUP_TYPES,
  type Dataset,
  type DsCredential,
  type DsFolder,
  type DsGroup,
  type DsHost,
  type DsNote,
  type DsPortForward,
  type DsSkill,
  type DsSnippet,
  type ItemType,
  type MergeOp,
  type ReplacePlan,
} from '@itm/sync-merge';
import type { Db } from '../db/database';
import { open, seal } from '../vault/vault';
import { describePrivateKey, type CredentialRepo, type CredentialSecrets } from '../vault/credential-repo';
import { normalizeTags, type TagRepo } from '../hosts/tag-repo';
import { MAX_JUMPS } from '../hosts/host-repo';
import type { SkillStore } from '../ai/skills';

const json = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const jsonOrNull = (v: unknown): string | null =>
  v === null || v === undefined || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Object.keys(v as object).length) ? null : JSON.stringify(v);

const KEY_TYPES: CredentialType[] = ['SSH_KEY', 'CERT'];

/** 凭证的「秘密」在包里是一个字段，在库里按类型存成不同的键 */
function secretsOfCredential(type: string, secret: string | null, passphrase: string | null): CredentialSecrets {
  if (!secret) return {};
  if (KEY_TYPES.includes(type as CredentialType)) return { privateKey: secret, ...(passphrase ? { passphrase } : {}) };
  if (type === 'CLOUD_AK') return { secretKey: secret };
  return { password: secret };
}

/**
 * 本地库 ⇄ 备份包数据（文档一 6.10.5）。只处理个人范围的 7 类数据；主机的专属凭证（在主机编辑框里填的密码 / 私钥）
 * 作为主机的 password / privateKey 字段，只在包含「凭证」分组时导出。所有写操作由调用方放在一个事务里。
 */
export class DatasetStore {
  constructor(
    private readonly db: Db,
    private readonly vaultKey: Buffer,
    private readonly deps: { credentials: CredentialRepo; tags: TagRepo; skills?: SkillStore },
    private readonly now: () => number = Date.now,
  ) {}

  counts(): ItemCounts {
    const n = (sql: string): number => (this.db.prepare<[], { n: number }>(sql).get()?.n ?? 0);
    return {
      hosts: n('SELECT count(*) AS n FROM host WHERE deleted = 0'),
      hostGroups: n(`SELECT count(*) AS n FROM folder WHERE deleted = 0 AND scope = 'PERSONAL'`),
      snippets: n(`SELECT count(*) AS n FROM snippet WHERE deleted = 0 AND scope = 'PERSONAL'`),
      snippetGroups: n('SELECT count(*) AS n FROM snippet_group WHERE deleted = 0'),
      notes: n('SELECT count(*) AS n FROM note WHERE deleted = 0'),
      noteGroups: n('SELECT count(*) AS n FROM note_group WHERE deleted = 0'),
      credentials: n(`SELECT count(*) AS n FROM credential WHERE deleted = 0 AND scope = 'PERSONAL' AND owner_host_id IS NULL`),
      skills: this.loadSkills().length,
    };
  }

  /** Skill 是文件（不在数据库里） */
  private loadSkills(): DsSkill[] {
    if (!this.deps.skills) return [];
    try {
      return this.deps.skills.list().map((s) => ({ id: s.id, content: s.content, updatedAt: this.now() }));
    } catch {
      return [];
    }
  }

  /** Skill 文件的写入 / 删除：在数据库事务提交以后由调用方执行（flushFiles） */
  private pendingFiles: (() => void)[] = [];

  /** 执行排队的 Skill 文件写入（数据库事务成功之后调用）；返回失败的原因 */
  flushFiles(): string[] {
    const jobs = this.pendingFiles;
    this.pendingFiles = [];
    const errors: string[] = [];
    for (const j of jobs) {
      try {
        j();
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    return errors;
  }

  /** 数据库事务失败：丢掉排队的文件操作 */
  discardFiles(): void {
    this.pendingFiles = [];
  }

  /** 读出选中分组的数据；withSecrets = false 时不解密任何秘密 */
  load(groups: SyncGroup[], withSecrets: boolean): Dataset {
    const types = new Set(groups.flatMap((g) => GROUP_TYPES[g]));
    const d = emptyDataset();
    if (types.has('hostGroups')) d.hostGroups = this.loadFolders();
    if (types.has('hosts')) d.hosts = this.loadHosts(withSecrets);
    if (types.has('snippetGroups')) d.snippetGroups = this.loadGroups('snippet_group');
    if (types.has('snippets')) d.snippets = this.loadSnippets();
    if (types.has('noteGroups')) d.noteGroups = this.loadGroups('note_group');
    if (types.has('notes')) d.notes = this.loadNotes();
    if (types.has('credentials')) d.credentials = this.loadCredentials(withSecrets);
    if (types.has('skills')) d.skills = this.loadSkills();
    return d;
  }

  private loadFolders(): DsFolder[] {
    type R = { id: string; parent_id: string | null; name: string; sort: number; default_credential_id: string | null; default_jump_host_id: string | null;
      agent_policy: string | null; ai_note: string | null; default_skills: string | null; production: number; updated_at: number };
    return this.db
      .prepare<[], R>(
        `SELECT id, parent_id, name, sort, default_credential_id, default_jump_host_id, agent_policy, ai_note, default_skills, production, updated_at
           FROM folder WHERE deleted = 0 AND scope = 'PERSONAL' ORDER BY path`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        name: r.name,
        sort: r.sort,
        defaultCredentialId: r.default_credential_id,
        defaultJumpHostId: r.default_jump_host_id,
        agentPolicy: r.agent_policy,
        aiNote: r.ai_note,
        defaultSkills: json<string[]>(r.default_skills, []),
        production: !!r.production,
        updatedAt: r.updated_at,
      }));
  }

  private loadHosts(withSecrets: boolean): DsHost[] {
    type R = { id: string; folder_id: string | null; name: string; protocol: string; address: string | null; port: number | null; username: string | null;
      auth_method: string; credential_id: string | null; serial_opts: string | null; proxy: string | null; proxy_password_enc: Buffer | null; encoding: string | null;
      term_type: string | null; env: string | null; startup_script: string | null; keepalive_sec: number | null; agent_policy: string | null; cmd_denylist: string | null;
      note: string | null; record_session: number; jump_inherit: number; monitor_script: string | null; file_transfer: string | null; updated_at: number };
    const jumps = new Map<string, string[]>();
    this.db
      .prepare<[], { host_id: string; jump_host_id: string }>('SELECT host_id, jump_host_id FROM host_jump ORDER BY host_id, seq')
      .all()
      .forEach((r) => jumps.set(r.host_id, [...(jumps.get(r.host_id) ?? []), r.jump_host_id]));
    const tags = this.deps.tags.tagsByHost();
    const favs = new Set(this.db.prepare<[], { host_id: string }>('SELECT host_id FROM favorite WHERE deleted = 0').all().map((r) => r.host_id));
    const forwards = new Map<string, DsPortForward[]>();
    this.db
      .prepare<[], { host_id: string; type: string; bind_addr: string; bind_port: number; target_addr: string | null; target_port: number | null; auto_start: number }>(
        'SELECT host_id, type, bind_addr, bind_port, target_addr, target_port, auto_start FROM port_forward WHERE deleted = 0 ORDER BY rowid',
      )
      .all()
      .forEach((r) =>
        forwards.set(r.host_id, [
          ...(forwards.get(r.host_id) ?? []),
          { type: r.type, bindAddr: r.bind_addr, bindPort: r.bind_port, targetAddr: r.target_addr, targetPort: r.target_port, autoStart: !!r.auto_start },
        ]),
      );
    return this.db
      .prepare<[], R>('SELECT * FROM host WHERE deleted = 0 ORDER BY name COLLATE NOCASE')
      .all()
      .map((r) => {
        const own = r.auth_method === 'PASSWORD' || r.auth_method === 'KEY';
        const h: DsHost = {
          id: r.id,
          folderId: r.folder_id,
          name: r.name,
          protocol: r.protocol,
          address: r.address ?? '',
          port: r.port ?? 0,
          username: r.username ?? '',
          authMethod: r.auth_method,
          credentialId: r.auth_method === 'CREDENTIAL' ? r.credential_id : null,
          jumpHostIds: jumps.get(r.id) ?? [],
          jumpInherit: r.jump_inherit !== 0,
          proxy: json<unknown>(r.proxy, null),
          encoding: r.encoding ?? 'UTF-8',
          termType: r.term_type ?? 'xterm-256color',
          env: json<Record<string, string>>(r.env, {}),
          startupScript: r.startup_script,
          keepaliveSec: r.keepalive_sec ?? 30,
          serialOpts: json<unknown>(r.serial_opts, null),
          agentPolicy: r.agent_policy,
          cmdDenylist: json<string[]>(r.cmd_denylist, []),
          tags: tags.get(r.id) ?? [],
          favorite: favs.has(r.id),
          note: r.note,
          monitorScript: r.monitor_script,
          fileTransfer: r.file_transfer ? (JSON.parse(r.file_transfer) as DsHost['fileTransfer']) : null,
          recordSession: r.record_session !== 0,
          portForwards: forwards.get(r.id) ?? [],
          updatedAt: r.updated_at,
        };
        if (withSecrets) {
          const s = own && r.credential_id ? this.ownSecrets(r.id, r.credential_id) : {};
          h.password = s.password ?? null;
          h.privateKey = s.privateKey ?? null;
          h.passphrase = s.passphrase ?? null;
          h.proxyPassword = r.proxy_password_enc ? open(this.vaultKey, r.proxy_password_enc, `host_proxy:${r.id}`) : null;
        }
        return h;
      });
  }

  private ownSecrets(hostId: string, credentialId: string): CredentialSecrets {
    const row = this.db
      .prepare<[string, string], { secret_enc: Buffer | null }>('SELECT secret_enc FROM credential WHERE id = ? AND owner_host_id = ? AND deleted = 0')
      .get(credentialId, hostId);
    return row?.secret_enc ? (JSON.parse(open(this.vaultKey, row.secret_enc, `credential:${credentialId}`)) as CredentialSecrets) : {};
  }

  private ownCredentialId(hostId: string): string | null {
    return this.db.prepare<[string], { id: string }>('SELECT id FROM credential WHERE owner_host_id = ? AND deleted = 0 ORDER BY updated_at DESC').get(hostId)?.id ?? null;
  }

  private loadGroups(table: 'snippet_group' | 'note_group'): DsGroup[] {
    return this.db
      .prepare<[], { id: string; name: string; sort: number; updated_at: number }>(`SELECT id, name, sort, updated_at FROM ${table} WHERE deleted = 0 ORDER BY sort`)
      .all()
      .map((r) => ({ id: r.id, name: r.name, sort: r.sort, updatedAt: r.updated_at }));
  }

  private loadSnippets(): DsSnippet[] {
    type R = { id: string; group_id: string | null; name: string; content: string; description: string | null; tags: string | null; sort: number; updated_at: number };
    return this.db
      .prepare<[], R>(`SELECT id, group_id, name, content, description, tags, sort, updated_at FROM snippet WHERE deleted = 0 AND scope = 'PERSONAL' ORDER BY sort`)
      .all()
      .map((r) => ({ id: r.id, groupId: r.group_id, name: r.name, content: r.content, description: r.description, tags: json<string[]>(r.tags, []), sort: r.sort, updatedAt: r.updated_at }));
  }

  private loadNotes(): DsNote[] {
    type R = { id: string; group_id: string | null; title: string; content: string; format: string; pinned: number; sort: number; updated_at: number };
    return this.db
      .prepare<[], R>('SELECT id, group_id, title, content, format, pinned, sort, updated_at FROM note WHERE deleted = 0 ORDER BY sort')
      .all()
      .map((r) => ({ id: r.id, groupId: r.group_id, title: r.title, content: r.content, format: r.format, pinned: !!r.pinned, sort: r.sort, updatedAt: r.updated_at }));
  }

  private loadCredentials(withSecrets: boolean): DsCredential[] {
    type R = { id: string; type: string; name: string; username: string | null; secret_enc: Buffer | null; public_key: string | null; fingerprint: string | null;
      otp_seed_enc: Buffer | null; ai_access: string; rotate_days: number | null; expires_at: number | null; note: string | null; updated_at: number };
    return this.db
      .prepare<[], R>(
        `SELECT id, type, name, username, secret_enc, public_key, fingerprint, otp_seed_enc, ai_access, rotate_days, expires_at, note, updated_at
           FROM credential WHERE deleted = 0 AND scope = 'PERSONAL' AND owner_host_id IS NULL ORDER BY name COLLATE NOCASE`,
      )
      .all()
      .map((r) => {
        const s: CredentialSecrets = withSecrets && r.secret_enc ? (JSON.parse(open(this.vaultKey, r.secret_enc, `credential:${r.id}`)) as CredentialSecrets) : {};
        return {
          id: r.id,
          type: r.type,
          name: r.name,
          username: r.username,
          secret: s.password ?? s.privateKey ?? s.secretKey ?? null,
          passphrase: s.passphrase ?? null,
          publicKey: r.public_key,
          fingerprint: r.fingerprint,
          otpSeed: withSecrets && r.otp_seed_enc ? open(this.vaultKey, r.otp_seed_enc, `credential_otp:${r.id}`) : null,
          aiAccess: r.ai_access,
          rotateDays: r.rotate_days,
          expiresAt: r.expires_at,
          note: r.note,
          updatedAt: r.updated_at,
        };
      });
  }

  // ---------------------------------------------------------------- 写入（调用方负责事务）

  /** 执行合并方案。withSecrets：包里带了凭证分组（主机的密码 / 私钥才会写入） */
  applyMerge(ops: MergeOp[], withSecrets: boolean, shareOwner: string | null): void {
    for (const op of ops) {
      if (op.op === 'add') this.upsert(op.type, op.item, withSecrets);
      else if (op.op === 'fill') this.fill(op.type, op.localId, op.patch);
      else if (shareOwner)
        this.db
          .prepare('INSERT OR REPLACE INTO share_import_map (owner_id, entity, remote_id, local_id, imported_at) VALUES (?, ?, ?, ?, ?)')
          .run(shareOwner, op.type, op.remoteId, op.localId, this.now());
    }
  }

  /** 执行覆盖方案：先删（释放同名分组），再按拓扑顺序写入，最后断开没选分组里指向已删除条目的引用 */
  applyReplace(plan: ReplacePlan, withSecrets: boolean): void {
    for (const r of plan.removes) this.remove(r.type, r.id);
    for (const u of plan.upserts) this.upsert(u.type, u.item, withSecrets);
    for (const d of plan.detach) {
      if (d.type === 'hosts') this.db.prepare(`UPDATE host SET credential_id = NULL, updated_at = ? WHERE id = ? AND auth_method = 'CREDENTIAL'`).run(this.now(), d.id);
      if (d.type === 'hostGroups') this.db.prepare('UPDATE folder SET default_credential_id = NULL, updated_at = ? WHERE id = ?').run(this.now(), d.id);
    }
  }

  private upsert(type: ItemType, item: Dataset[ItemType][number], withSecrets: boolean): void {
    switch (type) {
      case 'credentials':
        return this.upsertCredential(item as DsCredential);
      case 'hostGroups':
        return this.upsertFolder(item as DsFolder);
      case 'hosts':
        return this.upsertHost(item as DsHost, withSecrets);
      case 'snippetGroups':
        return this.upsertGroup('snippet_group', item as DsGroup);
      case 'noteGroups':
        return this.upsertGroup('note_group', item as DsGroup);
      case 'snippets':
        return this.upsertSnippet(item as DsSnippet);
      case 'notes':
        return this.upsertNote(item as DsNote);
      case 'skills': {
        const s = item as DsSkill;
        const store = this.deps.skills;
        if (store) this.pendingFiles.push(() => store.writeRaw(s.id, s.content));
        return;
      }
    }
  }

  private remove(type: ItemType, id: string): void {
    const now = this.now();
    const tomb = (table: string, extra = ''): void => void this.db.prepare(`UPDATE ${table} SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0${extra}`).run(now, id);
    switch (type) {
      case 'credentials':
        return tomb('credential', ' AND owner_host_id IS NULL');
      case 'hostGroups':
        return tomb('folder');
      case 'hosts':
        this.deps.credentials.deleteDedicatedOf([id]);
        this.db.prepare('DELETE FROM host_jump WHERE host_id = ?').run(id);
        this.deps.tags.setHostTags(id, []);
        this.db.prepare('UPDATE favorite SET deleted = 1, updated_at = ? WHERE host_id = ? AND deleted = 0').run(now, id);
        this.db.prepare('UPDATE port_forward SET deleted = 1, updated_at = ? WHERE host_id = ? AND deleted = 0').run(now, id);
        return tomb('host');
      case 'snippetGroups':
        return tomb('snippet_group');
      case 'noteGroups':
        return tomb('note_group');
      case 'snippets':
        return tomb('snippet');
      case 'notes':
        return tomb('note');
      case 'skills': {
        const store = this.deps.skills;
        if (store) this.pendingFiles.push(() => store.removeForRestore(id));
        return;
      }
    }
  }

  private upsertCredential(c: DsCredential): void {
    const now = this.now();
    const secrets = secretsOfCredential(c.type, c.secret, c.passphrase);
    const info = KEY_TYPES.includes(c.type as CredentialType) && secrets.privateKey ? describePrivateKey(secrets.privateKey, secrets.passphrase) : null;
    const sealed = Object.keys(secrets).length ? seal(this.vaultKey, JSON.stringify(secrets), `credential:${c.id}`) : null;
    const otp = c.otpSeed ? seal(this.vaultKey, c.otpSeed, `credential_otp:${c.id}`) : null;
    this.db
      .prepare(
        `INSERT INTO credential (id, scope, type, name, username, secret_enc, public_key, fingerprint, key_type, otp_seed_enc, ai_access, rotate_days, expires_at,
                                 note, owner_host_id, rotated_at, deleted, updated_at)
         VALUES (?, 'PERSONAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET type = excluded.type, name = excluded.name, username = excluded.username, secret_enc = excluded.secret_enc,
           public_key = excluded.public_key, fingerprint = excluded.fingerprint, key_type = excluded.key_type, otp_seed_enc = excluded.otp_seed_enc,
           ai_access = excluded.ai_access, rotate_days = excluded.rotate_days, expires_at = excluded.expires_at, note = excluded.note,
           owner_host_id = NULL, deleted = 0, updated_at = excluded.updated_at`,
      )
      .run(
        c.id, c.type, c.name, c.username, sealed, info?.publicKey ?? c.publicKey, info?.fingerprint ?? c.fingerprint, info?.keyType ?? null, otp,
        c.aiAccess, c.rotateDays, c.expiresAt, c.note, now, now,
      );
  }

  private upsertFolder(f: DsFolder): void {
    const parent = f.parentId ? this.db.prepare<[string], { path: string }>('SELECT path FROM folder WHERE id = ?').get(f.parentId) : undefined;
    const parentId = parent ? f.parentId : null;
    const name = this.availableFolderName(parentId, f.name, f.id);
    this.db
      .prepare(
        `INSERT INTO folder (id, parent_id, name, path, sort, scope, default_credential_id, default_jump_host_id, agent_policy, ai_note, default_skills, production, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, 'PERSONAL', ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name, path = excluded.path, sort = excluded.sort,
           default_credential_id = excluded.default_credential_id, default_jump_host_id = excluded.default_jump_host_id, agent_policy = excluded.agent_policy,
           ai_note = excluded.ai_note, default_skills = excluded.default_skills, production = excluded.production, deleted = 0, updated_at = excluded.updated_at`,
      )
      .run(
        f.id, parentId, name, `${parent?.path ?? '/'}${f.id}/`, f.sort, f.defaultCredentialId, f.defaultJumpHostId, f.agentPolicy, f.aiNote,
        jsonOrNull(f.defaultSkills), f.production ? 1 : 0, this.now(),
      );
  }

  private availableFolderName(parentId: string | null, name: string, selfId: string): string {
    const taken = (n: string): boolean =>
      !!this.db.prepare('SELECT 1 FROM folder WHERE parent_id IS ? AND lower(name) = lower(?) AND id != ? AND deleted = 0').get(parentId, n, selfId);
    let candidate = name;
    for (let i = 2; taken(candidate); i++) candidate = `${name} (${i})`;
    return candidate;
  }

  private upsertHost(h: DsHost, withSecrets: boolean): void {
    const now = this.now();
    const method = h.authMethod as AuthMethod;
    const ownMethod = method === 'PASSWORD' || method === 'KEY';
    this.db
      .prepare(
        `INSERT INTO host (id, folder_id, name, protocol, address, port, username, auth_method, credential_id, serial_opts, proxy, encoding, term_type, env,
                           startup_script, keepalive_sec, agent_policy, cmd_denylist, note, record_session, jump_inherit, monitor_script, file_transfer, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET folder_id = excluded.folder_id, name = excluded.name, protocol = excluded.protocol, address = excluded.address,
           port = excluded.port, username = excluded.username, auth_method = excluded.auth_method, credential_id = excluded.credential_id,
           serial_opts = excluded.serial_opts, proxy = excluded.proxy, encoding = excluded.encoding, term_type = excluded.term_type, env = excluded.env,
           startup_script = excluded.startup_script, keepalive_sec = excluded.keepalive_sec, agent_policy = excluded.agent_policy,
           cmd_denylist = excluded.cmd_denylist, note = excluded.note, record_session = excluded.record_session, jump_inherit = excluded.jump_inherit,
           monitor_script = excluded.monitor_script, file_transfer = excluded.file_transfer, deleted = 0, updated_at = excluded.updated_at`,
      )
      .run(
        h.id, h.folderId, h.name, h.protocol, h.address, h.port, h.username || null, method, method === 'CREDENTIAL' ? h.credentialId : null,
        jsonOrNull(h.serialOpts), jsonOrNull(h.proxy), h.encoding, h.termType, jsonOrNull(h.env), h.startupScript, h.keepaliveSec, h.agentPolicy,
        jsonOrNull(h.cmdDenylist), h.note, h.recordSession ? 1 : 0, h.jumpInherit ? 1 : 0, h.monitorScript, jsonOrNull(h.fileTransfer ?? null), now,
      );
    // 专属凭证：包里带了秘密就按包写；没带（没选凭证分组）时保留本机原有的
    const ownId = this.ownCredentialId(h.id);
    let credentialId: string | null = method === 'CREDENTIAL' ? h.credentialId : null;
    if (ownMethod) {
      credentialId = withSecrets
        ? this.deps.credentials.saveDedicated(ownId, h.id, h.name, h.username, method, { password: h.password ?? undefined, privateKey: h.privateKey ?? undefined, passphrase: h.passphrase ?? undefined })
        : ownId;
    } else if (withSecrets && ownId) {
      this.deps.credentials.deleteDedicatedOf([h.id]);
    }
    if (ownMethod) this.db.prepare('UPDATE host SET credential_id = ? WHERE id = ?').run(credentialId, h.id);
    if (withSecrets || !h.proxy) {
      const enc = h.proxy && h.proxyPassword ? seal(this.vaultKey, h.proxyPassword, `host_proxy:${h.id}`) : null;
      this.db.prepare('UPDATE host SET proxy_password_enc = ? WHERE id = ?').run(enc, h.id);
    }
    this.saveJumps(h.id, h.jumpHostIds);
    this.deps.tags.setHostTags(h.id, normalizeTags(h.tags));
    this.setFavorite(h.id, h.favorite);
    this.syncForwards(h.id, h.portForwards, true);
  }

  private saveJumps(hostId: string, ids: string[]): void {
    const clean = [...new Set(ids)].filter((x) => x !== hostId).slice(0, MAX_JUMPS);
    this.db.prepare('DELETE FROM host_jump WHERE host_id = ?').run(hostId);
    const stmt = this.db.prepare('INSERT INTO host_jump (host_id, seq, jump_host_id) VALUES (?, ?, ?)');
    clean.forEach((j, i) => stmt.run(hostId, i, j));
  }

  private setFavorite(hostId: string, on: boolean): void {
    const now = this.now();
    if (on)
      this.db
        .prepare(
          `INSERT INTO favorite (host_id, created_at, deleted, updated_at) VALUES (?, ?, 0, ?)
           ON CONFLICT (host_id) DO UPDATE SET deleted = 0, updated_at = excluded.updated_at WHERE favorite.deleted = 1`,
        )
        .run(hostId, now, now);
    else this.db.prepare('UPDATE favorite SET deleted = 1, updated_at = ? WHERE host_id = ? AND deleted = 0').run(now, hostId);
  }

  /** 端口转发按「类型 + 绑定地址 + 绑定端口」对齐：已有的更新（id 不变），新的插入；exact = true 时删除多出的 */
  private syncForwards(hostId: string, list: DsPortForward[], exact: boolean): void {
    const now = this.now();
    const cur = this.db
      .prepare<[string], { id: string; type: string; bind_addr: string; bind_port: number }>('SELECT id, type, bind_addr, bind_port FROM port_forward WHERE host_id = ? AND deleted = 0')
      .all(hostId);
    const key = (t: string, a: string, p: number): string => `${t}|${a}|${p}`;
    const byKey = new Map(cur.map((c) => [key(c.type, c.bind_addr, c.bind_port), c.id]));
    const seen = new Set<string>();
    for (const f of list) {
      const k = key(f.type, f.bindAddr, f.bindPort);
      if (seen.has(k)) continue;
      seen.add(k);
      const id = byKey.get(k);
      if (id)
        this.db
          .prepare('UPDATE port_forward SET target_addr = ?, target_port = ?, auto_start = ?, updated_at = ? WHERE id = ?')
          .run(f.targetAddr, f.targetPort, f.autoStart ? 1 : 0, now, id);
      else
        this.db
          .prepare('INSERT INTO port_forward (id, host_id, type, bind_addr, bind_port, target_addr, target_port, auto_start, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), hostId, f.type, f.bindAddr, f.bindPort, f.targetAddr, f.targetPort, f.autoStart ? 1 : 0, now);
    }
    if (exact) for (const [k, id] of byKey) if (!seen.has(k)) this.db.prepare('UPDATE port_forward SET deleted = 1, updated_at = ? WHERE id = ?').run(now, id);
  }

  private upsertGroup(table: 'snippet_group' | 'note_group', g: DsGroup): void {
    this.db
      .prepare(
        `INSERT INTO ${table} (id, name, sort, deleted, updated_at) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, sort = excluded.sort, deleted = 0, updated_at = excluded.updated_at`,
      )
      .run(g.id, g.name, g.sort, this.now());
  }

  private upsertSnippet(s: DsSnippet): void {
    this.db
      .prepare(
        `INSERT INTO snippet (id, scope, group_id, name, content, description, tags, sort, deleted, updated_at) VALUES (?, 'PERSONAL', ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, name = excluded.name, content = excluded.content, description = excluded.description,
           tags = excluded.tags, sort = excluded.sort, deleted = 0, updated_at = excluded.updated_at`,
      )
      .run(s.id, s.groupId, s.name, s.content, s.description, jsonOrNull(s.tags), s.sort, this.now());
  }

  private upsertNote(n: DsNote): void {
    this.db
      .prepare(
        `INSERT INTO note (id, group_id, title, content, format, pinned, sort, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, title = excluded.title, content = excluded.content, format = excluded.format,
           pinned = excluded.pinned, sort = excluded.sort, deleted = 0, updated_at = excluded.updated_at`,
      )
      .run(n.id, n.groupId, n.title, n.content, n.format, n.pinned ? 1 : 0, n.sort, this.now());
  }

  /** 命中同一条目：只写补充的字段 */
  private fill(type: ItemType, id: string, patch: Record<string, unknown>): void {
    const now = this.now();
    const set = (table: string, cols: Record<string, unknown>): void => {
      const keys = Object.keys(cols);
      if (!keys.length) return;
      this.db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => cols[k]), now, id);
    };
    const pick = (map: Record<string, string>, enc: Record<string, (v: unknown) => unknown> = {}): Record<string, unknown> =>
      Object.fromEntries(Object.entries(patch).filter(([k]) => k in map).map(([k, v]) => [map[k], enc[k] ? enc[k](v) : v]));
    switch (type) {
      case 'hostGroups':
        return set(
          'folder',
          pick(
            { defaultCredentialId: 'default_credential_id', defaultJumpHostId: 'default_jump_host_id', agentPolicy: 'agent_policy', aiNote: 'ai_note', defaultSkills: 'default_skills' },
            { defaultSkills: jsonOrNull },
          ),
        );
      case 'snippets':
        return set('snippet', pick({ description: 'description', tags: 'tags' }, { tags: jsonOrNull }));
      case 'notes':
        return set('note', pick({ content: 'content' }));
      case 'snippetGroups':
      case 'noteGroups':
      case 'skills':
        return;
      case 'credentials': {
        set('credential', pick({ username: 'username', publicKey: 'public_key', rotateDays: 'rotate_days', expiresAt: 'expires_at', note: 'note' }));
        if ('secret' in patch || 'passphrase' in patch) {
          const row = this.db.prepare<[string], { type: string; secret_enc: Buffer | null }>('SELECT type, secret_enc FROM credential WHERE id = ?').get(id)!;
          const cur = row.secret_enc ? (JSON.parse(open(this.vaultKey, row.secret_enc, `credential:${id}`)) as CredentialSecrets) : {};
          const add = secretsOfCredential(row.type, (patch.secret as string) ?? null, (patch.passphrase as string) ?? null);
          if (!add.privateKey && patch.passphrase && !cur.passphrase) add.passphrase = patch.passphrase as string;
          const next = { ...add, ...Object.fromEntries(Object.entries(cur).filter(([, v]) => !!v)) };
          const info = next.privateKey && KEY_TYPES.includes(row.type as CredentialType) ? describePrivateKey(next.privateKey, next.passphrase) : null;
          this.db
            .prepare('UPDATE credential SET secret_enc = ?, key_type = COALESCE(key_type, ?), rotated_at = ?, updated_at = ? WHERE id = ?')
            .run(seal(this.vaultKey, JSON.stringify(next), `credential:${id}`), info?.keyType ?? null, now, now, id);
        }
        if (typeof patch.otpSeed === 'string')
          this.db.prepare('UPDATE credential SET otp_seed_enc = ?, updated_at = ? WHERE id = ? AND otp_seed_enc IS NULL').run(seal(this.vaultKey, patch.otpSeed, `credential_otp:${id}`), now, id);
        return;
      }
      case 'hosts': {
        set(
          'host',
          pick(
            {
              username: 'username', credentialId: 'credential_id', proxy: 'proxy', startupScript: 'startup_script', env: 'env', agentPolicy: 'agent_policy',
              cmdDenylist: 'cmd_denylist', note: 'note', monitorScript: 'monitor_script', fileTransfer: 'file_transfer',
            },
            { proxy: jsonOrNull, env: jsonOrNull, cmdDenylist: jsonOrNull, fileTransfer: jsonOrNull },
          ),
        );
        if (Array.isArray(patch.jumpHostIds)) this.saveJumps(id, patch.jumpHostIds as string[]);
        if (Array.isArray(patch.tags)) this.deps.tags.setHostTags(id, normalizeTags(patch.tags));
        if (Array.isArray(patch.portForwards)) this.syncForwards(id, patch.portForwards as DsPortForward[], false);
        if (patch.password || patch.privateKey || patch.passphrase) {
          const h = this.db.prepare<[string], { name: string; username: string | null; auth_method: AuthMethod }>('SELECT name, username, auth_method FROM host WHERE id = ?').get(id)!;
          const ownId = this.ownCredentialId(id);
          const cur = ownId ? this.ownSecrets(id, ownId) : {};
          const next: CredentialSecrets = { ...cur };
          if (patch.password && !cur.password) next.password = patch.password as string;
          if (patch.privateKey && !cur.privateKey) next.privateKey = patch.privateKey as string;
          if (patch.passphrase && !cur.passphrase) next.passphrase = patch.passphrase as string;
          const cid = this.deps.credentials.saveDedicated(ownId, id, h.name, h.username ?? '', h.auth_method, next);
          this.db.prepare('UPDATE host SET credential_id = ? WHERE id = ?').run(cid, id);
        }
        if (typeof patch.proxyPassword === 'string')
          this.db.prepare('UPDATE host SET proxy_password_enc = ? WHERE id = ? AND proxy IS NOT NULL').run(seal(this.vaultKey, patch.proxyPassword, `host_proxy:${id}`), id);
        return;
      }
    }
  }
}
