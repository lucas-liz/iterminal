import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { AGENT_POLICIES as POLICIES, DB_PRODUCTS, type AgentPolicy, type DbAsset, type DbAssetInput, type DbSslMode, type DbType } from '@itm/protocol';
import type { Db } from '../db/database';
import { open, seal } from '../vault/vault';
import { UserError } from '../../util/errors';

const TYPES: readonly DbType[] = ['MYSQL', 'POSTGRES', 'SQLITE'];
const SSL: readonly DbSslMode[] = ['OFF', 'REQUIRE', 'VERIFY'];
const MAX_ASSETS = 500;

interface Row {
  id: string;
  name: string;
  type: DbType;
  host: string;
  port: number;
  database_name: string;
  username: string;
  password_enc: Buffer | null;
  credential_id: string | null;
  ssl: DbSslMode;
  via_host_id: string | null;
  file_path: string | null;
  agent_policy: AgentPolicy | null;
  production: number;
  sql_denylist: string;
  note: string | null;
  updated_at: number;
  flavor: string | null;
}

const COLS = 'id, name, type, host, port, database_name, username, password_enc, credential_id, ssl, via_host_id, file_path, agent_policy, production, sql_denylist, note, updated_at, flavor';

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

const toAsset = (r: Row): DbAsset => ({
  id: r.id,
  name: r.name,
  type: r.type,
  flavor: r.flavor ?? null,
  host: r.host,
  port: r.port,
  database: r.database_name,
  username: r.username,
  hasPassword: !!r.password_enc,
  credentialId: r.credential_id,
  ssl: r.ssl,
  viaHostId: r.via_host_id,
  filePath: r.file_path,
  agentPolicy: r.agent_policy,
  production: !!r.production,
  sqlDenylist: parseList(r.sql_denylist),
  note: r.note,
  updatedAt: r.updated_at,
});

/** 编辑框里的正则：去掉开头的 (?i)（JS 不支持内联标志，SQL 黑名单总是不区分大小写） */
export function denyPattern(p: string): RegExp | null {
  try {
    return new RegExp(p.replace(/^\(\?i\)/, ''), 'i');
  } catch {
    return null;
  }
}

/** 校验并整理输入（测试连接时也用，不需要先保存） */
export function normalizeDbInput(input: DbAssetInput): Omit<DbAssetInput, 'password'> {
  const name = String(input.name ?? '').trim();
  if (!name) throw new UserError('请填写名称');
  if (name.length > 100) throw new UserError('名称不能超过 100 个字符');
  if (!TYPES.includes(input.type)) throw new UserError('不支持的数据库类型');
  const ssl = SSL.includes(input.ssl) ? input.ssl : 'OFF';
  if (input.agentPolicy !== null && !POLICIES.includes(input.agentPolicy)) throw new UserError('Agent 权限不正确');
  const sqlDenylist = (Array.isArray(input.sqlDenylist) ? input.sqlDenylist : []).map((p) => String(p).trim()).filter(Boolean);
  if (sqlDenylist.length > 100) throw new UserError('SQL 黑名单最多 100 条');
  for (const p of sqlDenylist) if (!denyPattern(p)) throw new UserError(`SQL 黑名单里的正则不正确：${p}`);
  const note = String(input.note ?? '').trim().slice(0, 4000) || null;
  // 产品必须是这个类型下的（例如 TiDB 只能是 MYSQL）；不认识的丢掉
  const flavor = input.flavor && DB_PRODUCTS.some((p) => p.id === input.flavor && p.engine === input.type) ? input.flavor : null;
  const common = { name, type: input.type, flavor, ssl, agentPolicy: input.agentPolicy ?? null, production: !!input.production, sqlDenylist, note };
  if (input.type === 'SQLITE') {
    const filePath = String(input.filePath ?? '').trim();
    if (!filePath) throw new UserError('请选择 SQLite 数据库文件');
    if (!isAbsolute(filePath)) throw new UserError('SQLite 文件必须是绝对路径');
    return { ...common, host: '', port: 0, database: '', username: '', credentialId: null, viaHostId: null, filePath, ssl: 'OFF' };
  }
  const host = String(input.host ?? '').trim();
  if (!host) throw new UserError('请填写地址');
  if (host.length > 255 || /[\s/]/.test(host)) throw new UserError('地址不正确');
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError('端口必须在 1–65535 之间');
  const database = String(input.database ?? '').trim();
  if (database.length > 128) throw new UserError('库名太长');
  const username = String(input.username ?? '').trim();
  if (username.length > 128) throw new UserError('用户名太长');
  return { ...common, host, port, database, username, credentialId: input.credentialId || null, viaHostId: input.viaHostId || null, filePath: null };
}

/** 数据库资产（文档一 6.31.2）：密码在整库加密之上再用保险库密钥加密一层，主进程之外永远拿不到 */
export class DbAssetRepo {
  constructor(
    private readonly db: Db,
    private readonly vaultKey: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  list(): DbAsset[] {
    return this.db.prepare<[], Row>(`SELECT ${COLS} FROM db_asset WHERE deleted = 0 ORDER BY name COLLATE NOCASE`).all().map(toAsset);
  }

  get(id: string): DbAsset | null {
    const r = this.db.prepare<[string], Row>(`SELECT ${COLS} FROM db_asset WHERE id = ? AND deleted = 0`).get(id);
    return r ? toAsset(r) : null;
  }

  require(id: string): DbAsset {
    const a = this.get(id);
    if (!a) throw new UserError('数据库不存在或已被删除');
    return a;
  }

  /** 本条记录保存的密码（只在主进程内使用） */
  password(id: string): string | null {
    const r = this.db.prepare<[string], { password_enc: Buffer | null }>('SELECT password_enc FROM db_asset WHERE id = ? AND deleted = 0').get(id);
    return r?.password_enc ? open(this.vaultKey, r.password_enc, `db_asset:${id}`) : null;
  }

  save(id: string | null, input: DbAssetInput): DbAsset {
    const v = normalizeDbInput(input);
    const dup = this.db.prepare<[string, string], { id: string }>('SELECT id FROM db_asset WHERE deleted = 0 AND name = ? COLLATE NOCASE AND id != ?').get(v.name, id ?? '');
    if (dup) throw new UserError(`已经有名为「${v.name}」的数据库`);
    const now = this.now();
    const vals = [v.name, v.type, v.host, v.port, v.database, v.username, v.credentialId, v.ssl, v.viaHostId, v.filePath, v.agentPolicy, v.production ? 1 : 0, JSON.stringify(v.sqlDenylist), v.note, now, v.flavor ?? null] as const;
    const targetId = id ?? randomUUID();
    this.db.transaction(() => {
      if (id) {
        const r = this.db
          .prepare(
            `UPDATE db_asset SET name = ?, type = ?, host = ?, port = ?, database_name = ?, username = ?, credential_id = ?, ssl = ?, via_host_id = ?, file_path = ?,
                    agent_policy = ?, production = ?, sql_denylist = ?, note = ?, updated_at = ?, flavor = ? WHERE id = ? AND deleted = 0`,
          )
          .run(...vals, id);
        if (r.changes === 0) throw new UserError('数据库不存在或已被删除');
      } else {
        const n = this.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM db_asset WHERE deleted = 0').get()!.n;
        if (n >= MAX_ASSETS) throw new UserError(`最多 ${MAX_ASSETS} 个数据库`);
        this.db
          .prepare(
            `INSERT INTO db_asset (name, type, host, port, database_name, username, credential_id, ssl, via_host_id, file_path, agent_policy, production, sql_denylist, note, updated_at, flavor, id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(...vals, targetId);
      }
      // SQLite 没有密码；引用凭证时清掉自己保存的密码
      const clear = v.type === 'SQLITE' || !!v.credentialId || input.password === null || input.password === '';
      if (clear) this.db.prepare('UPDATE db_asset SET password_enc = NULL WHERE id = ?').run(targetId);
      else if (typeof input.password === 'string') this.db.prepare('UPDATE db_asset SET password_enc = ? WHERE id = ?').run(seal(this.vaultKey, input.password, `db_asset:${targetId}`), targetId);
    })();
    return this.require(targetId);
  }

  duplicate(id: string): DbAsset {
    const a = this.require(id);
    const names = new Set(this.list().map((x) => x.name.toLowerCase()));
    let name = `${a.name} 副本`;
    for (let i = 2; names.has(name.toLowerCase()); i++) name = `${a.name} 副本 ${i}`;
    const copy = this.save(null, { ...a, name, password: undefined });
    const pw = this.password(id);
    if (pw && !a.credentialId) this.db.prepare('UPDATE db_asset SET password_enc = ? WHERE id = ?').run(seal(this.vaultKey, pw, `db_asset:${copy.id}`), copy.id);
    return this.require(copy.id);
  }

  delete(ids: string[]): void {
    const stmt = this.db.prepare('UPDATE db_asset SET deleted = 1, password_enc = NULL, updated_at = ? WHERE id = ?');
    const now = this.now();
    this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    })();
  }

  /** 引用这个凭证的数据库（删除凭证前检查） */
  usingCredential(credentialId: string): DbAsset[] {
    return this.list().filter((a) => a.credentialId === credentialId);
  }

  /** 经过这台主机连接的数据库（删除主机前检查） */
  usingHost(hostId: string): DbAsset[] {
    return this.list().filter((a) => a.viaHostId === hostId);
  }
}
