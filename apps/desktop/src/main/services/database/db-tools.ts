import type { DbColumnInfo, DbObjectList, DbResultTable, DbType } from '@itm/protocol';
import type { SqlDialect } from '@itm/approval';
import { pgIdent, type RunResult } from './drivers';
import type { DbSession } from './db-service';

/** 卡片里保存的单元格、发给模型的单元格最多 500 字符 */
export const MAX_CELL = 500;
/** 卡片里保存的整张表大约不超过 256 KB */
const MAX_TABLE_BYTES = 256 * 1024;
const META_ROWS = 500;

export const dialectOf = (t: DbType): SqlDialect => (t === 'MYSQL' ? 'mysql' : t === 'POSTGRES' ? 'postgres' : 'sqlite');

/** 数据库返回的值 → 显示用的文本；NULL 为 null。二进制显示为 0x…（超过 64 字节截断） */
export function cellText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    const b = Buffer.from(v);
    return b.length > 64 ? `0x${b.subarray(0, 64).toString('hex')}…（${b.length} 字节）` : `0x${b.toString('hex')}`;
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x));
  } catch {
    return String(v);
  }
}

const clipCell = (s: string | null, max = MAX_CELL): string | null => (s !== null && s.length > max ? `${s.slice(0, max)}…` : s);

/** 执行卡片里的表格：单元格最多 500 字符，整张表大约不超过 256 KB（超出时减少行数并标注） */
export function toTable(r: RunResult): DbResultTable {
  const rows: (string | null)[][] = [];
  let bytes = r.columns.join(',').length;
  let cut = false;
  for (const row of r.rows) {
    const cells = row.map((v) => clipCell(cellText(v)));
    bytes += cells.reduce((n, c) => n + (c?.length ?? 4) + 3, 0);
    if (bytes > MAX_TABLE_BYTES) {
      cut = true;
      break;
    }
    rows.push(cells);
  }
  return { columns: r.columns, rows, rowCount: rows.length, truncated: r.truncated || cut, durationMs: r.durationMs, ...(r.affected !== null ? { affected: r.affected } : {}) };
}

/** 列名拆成词：created_at、userPhone、USER_ID → [created, at] / [user, phone] / [user, id] */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter(Boolean);
}

const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'pass', 'secret', 'token', 'salt', 'credential', 'credentials', 'apikey', 'privatekey', 'secretkey', 'accesskey']);
const SECRET_PAIRS = ['api_key', 'access_key', 'secret_key', 'private_key', 'auth_key', 'app_secret', 'client_secret'];
const PII_WORDS = new Set(['phone', 'mobile', 'tel', 'telephone', 'cellphone', 'email', 'mail', 'idcard', 'ssn', 'passport', 'bankcard', 'cardno', 'identity']);
const PII_PAIRS = ['id_card', 'id_no', 'id_number', 'card_no', 'card_number', 'bank_card', 'bank_account'];
const PII_ZH = /手机|电话|邮箱|身份证|银行卡|证件/;

/** 按列名判断要不要脱敏（文档一 6.31.6）：secret → ****，pii → [PII] */
export function columnKind(name: string): 'secret' | 'pii' | null {
  const words = nameWords(name);
  const joined = words.join('_');
  if (words.some((w) => SECRET_WORDS.has(w)) || SECRET_PAIRS.some((p) => joined.includes(p))) return 'secret';
  if (words.some((w) => PII_WORDS.has(w)) || PII_PAIRS.some((p) => joined.includes(p)) || PII_ZH.test(name)) return 'pii';
  return null;
}

/** 单元格里的换行、竖线会打乱表格 */
const flat = (s: string): string => s.replace(/\r?\n/g, '\\n').replace(/\|/g, '\\|');

/**
 * 发给模型的结果：表头 + 每行一条（| 分隔），按列名脱敏，单元格最多 500 字符，总长不超过 max；
 * 放不下时减少行数并说明。之后由调用方再做通用脱敏、放进 <untrusted>。
 */
export function tableForModel(t: DbResultTable, maskColumns: boolean, max: number): { text: string; shown: number; masked: string[] } {
  if (t.columns.length === 0) return { text: t.affected !== undefined && t.affected !== null ? `影响 ${t.affected} 行` : '（没有返回结果）', shown: 0, masked: [] };
  const kinds = t.columns.map((c) => (maskColumns ? columnKind(c) : null));
  const masked = t.columns.filter((_c, i) => kinds[i]);
  const head = t.columns.map(flat).join(' | ');
  const lines: string[] = [];
  let size = head.length + 200;
  for (const row of t.rows) {
    const line = row
      .map((v, i) => (v === null ? 'NULL' : kinds[i] === 'secret' ? '****' : kinds[i] === 'pii' ? '[PII]' : flat(clipCell(v)!)))
      .join(' | ');
    if (size + line.length + 1 > max) break;
    size += line.length + 1;
    lines.push(line);
  }
  const notes: string[] = [];
  if (lines.length < t.rows.length) notes.push(`结果太长，只给出前 ${lines.length} 行（共读取 ${t.rows.length} 行）`);
  if (t.truncated) notes.push(`达到行数上限，后面还有更多行没有读取；需要统计时请用 COUNT / GROUP BY 让数据库汇总`);
  if (masked.length) notes.push(`这些列按列名脱敏：${masked.join('、')}`);
  return { text: [`${t.rowCount} 行`, head, ...lines, ...notes.map((n) => `（${n}）`)].join('\n'), shown: lines.length, masked };
}

/** CSV（RFC 4180）：UTF-8 带 BOM，Excel 直接打开不乱码 */
export function toCsv(columns: string[], rows: (string | null)[][]): string {
  const q = (v: string | null): string => (v === null ? '' : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return `﻿${[columns, ...rows].map((r) => r.map(q).join(',')).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- 元数据（db_schema / db_describe）

const META = { readOnly: true, maxRows: META_ROWS, timeoutMs: 15_000 } as const;

const mysqlIdent = (s: string): string => `\`${s.replace(/`/g, '``')}\``;

interface MetaOpts {
  database?: string;
  schema?: string;
  signal?: AbortSignal;
}

const rowsOf = (r: RunResult): string[][] => r.rows.map((row) => row.map((v) => cellText(v) ?? ''));

/** db_schema：没有库时列出所有库，否则列出库（PostgreSQL：schema）里的表和视图 */
export async function listSchema(s: DbSession, o: MetaOpts): Promise<{ title: string; text: string; table: DbResultTable }> {
  const type = s.asset.type;
  const run = (sql: string, params: unknown[] = []): Promise<RunResult> => s.run(sql, { ...META, params, signal: o.signal });
  if (type === 'MYSQL') {
    const db = o.database || s.database;
    if (!db) {
      const r = await run('SELECT schema_name AS `库` FROM information_schema.schemata ORDER BY schema_name');
      const names = rowsOf(r).map((x) => x[0]);
      return { title: '列出所有库', text: `库（共 ${names.length} 个）：\n${names.join('\n')}\n（用 database 参数指定库后再列出表）`, table: toTable(r) };
    }
    const r = await run(
      'SELECT table_name AS `表`, table_type AS `类型`, table_rows AS `估算行数`, table_comment AS `注释` FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name LIMIT 501',
      [db],
    );
    return metaTables(`列出库 ${db} 里的表`, db, r);
  }
  if (type === 'POSTGRES') {
    const schema = o.schema || 'public';
    const dbs = await run('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname');
    const schemas = await run("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname");
    const r = await run(
      `SELECT c.relname AS "表", CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'PARTITIONED TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' END AS "类型",
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS "估算行数", obj_description(c.oid, 'pg_class') AS "注释"
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
        ORDER BY c.relname LIMIT 501`,
      [schema],
    );
    const t = metaTables(`列出 ${s.database}.${schema} 里的表`, `${s.database}.${schema}`, r);
    const head = `当前库：${s.database}（其他库：${rowsOf(dbs).map((x) => x[0]).filter((x) => x !== s.database).join('、') || '无'}；用 database 参数切换）\nschema：${rowsOf(schemas).map((x) => x[0]).join('、')}（用 schema 参数切换，默认 public）\n`;
    return { ...t, text: head + t.text };
  }
  const r = await run("SELECT name AS \"表\", type AS \"类型\" FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name LIMIT 501");
  return metaTables('列出表', 'SQLite', r);
}

function metaTables(title: string, where: string, r: RunResult): { title: string; text: string; table: DbResultTable } {
  const rows = rowsOf(r);
  const more = rows.length > 500;
  const shown = rows.slice(0, 500);
  const lines = shown.map((x) => [x[0], x[1] && x[1] !== 'BASE TABLE' && x[1] !== 'TABLE' && x[1] !== 'table' ? `（${x[1]}）` : '', x[2] ? ` 约 ${x[2]} 行` : '', x[3] ? ` — ${x[3]}` : ''].join(''));
  const text = shown.length ? `${where} 的表和视图（共 ${shown.length}${more ? '+' : ''} 个）：\n${lines.join('\n')}${more ? '\n（只列出前 500 个）' : ''}` : `${where} 里没有表`;
  return { title, text, table: toTable({ ...r, rows: r.rows.slice(0, 500), truncated: more }) };
}

/** db_describe：列、主键、索引、外键、注释；MySQL 附 SHOW CREATE TABLE。表不存在时返回 null */
export async function describeTable(s: DbSession, table: string, o: MetaOpts): Promise<{ text: string; table: DbResultTable } | null> {
  const type = s.asset.type;
  const run = (sql: string, params: unknown[] = []): Promise<RunResult> => s.run(sql, { ...META, params, signal: o.signal });
  const parts: string[] = [];
  let cols: RunResult;
  if (type === 'MYSQL') {
    const db = o.database || s.database;
    if (!db) throw new Error('没有指定库：请用 database 参数指定（或在数据库设置里填写默认库）');
    cols = await run(
      'SELECT column_name AS `列`, column_type AS `类型`, is_nullable AS `可空`, column_default AS `默认值`, column_key AS `键`, extra AS `其他`, column_comment AS `注释` FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
      [db, table],
    );
    if (cols.rows.length === 0) return null;
    const info = rowsOf(await run('SELECT table_type, table_rows, table_comment FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [db, table]))[0] ?? [];
    parts.push(`表 ${db}.${table}${info[0] === 'VIEW' ? '（视图）' : ''}${info[1] ? `，估算 ${info[1]} 行` : ''}${info[2] ? `，注释：${info[2]}` : ''}`);
    parts.push(columnsText(cols));
    const idx = rowsOf(
      await run(
        'SELECT index_name, MAX(non_unique), GROUP_CONCAT(column_name ORDER BY seq_in_index) FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? GROUP BY index_name ORDER BY index_name = \'PRIMARY\' DESC, index_name',
        [db, table],
      ),
    );
    if (idx.length) parts.push(`索引：\n${idx.map((x) => `- ${x[0]}${x[1] === '0' ? '（唯一）' : ''}：${x[2]}`).join('\n')}`);
    const fks = rowsOf(
      await run(
        'SELECT column_name, referenced_table_schema, referenced_table_name, referenced_column_name FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL',
        [db, table],
      ),
    );
    if (fks.length) parts.push(`外键：\n${fks.map((x) => `- ${x[0]} → ${x[1] === db ? '' : `${x[1]}.`}${x[2]}.${x[3]}`).join('\n')}`);
    // 表已经确认存在，名称加反引号转义
    const ddl = await run(`SHOW CREATE TABLE ${mysqlIdent(db)}.${mysqlIdent(table)}`).catch(() => null);
    const create = ddl?.rows[0]?.[1];
    if (create) parts.push(`建表语句：\n${cellText(create)}`);
  } else if (type === 'POSTGRES') {
    const schema = o.schema || 'public';
    cols = await run(
      `SELECT a.attname AS "列", format_type(a.atttypid, a.atttypmod) AS "类型", CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS "可空",
              pg_get_expr(d.adbin, d.adrelid) AS "默认值", col_description(c.oid, a.attnum) AS "注释"
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [schema, table],
    );
    if (cols.rows.length === 0) return null;
    const info = rowsOf(
      await run(
        `SELECT c.relkind, CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      ),
    )[0] ?? [];
    parts.push(`表 ${schema}.${table}${info[0] === 'v' ? '（视图）' : info[0] === 'm' ? '（物化视图）' : ''}${info[1] ? `，估算 ${info[1]} 行` : ''}${info[2] ? `，注释：${info[2]}` : ''}`);
    parts.push(columnsText(cols));
    const cons = rowsOf(
      await run(
        `SELECT con.conname, con.contype, pg_get_constraintdef(con.oid) FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 ORDER BY con.contype = 'p' DESC, con.conname`,
        [schema, table],
      ),
    );
    const kind: Record<string, string> = { p: '主键', u: '唯一', f: '外键', c: '检查', x: '排他' };
    if (cons.length) parts.push(`约束：\n${cons.map((x) => `- ${kind[x[1]] ?? x[1]} ${x[0]}：${x[2]}`).join('\n')}`);
    const idx = rowsOf(await run('SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname', [schema, table]));
    if (idx.length) parts.push(`索引：\n${idx.map((x) => `- ${x[1]}`).join('\n')}`);
  } else {
    cols = await run('SELECT name AS "列", type AS "类型", CASE WHEN "notnull" THEN \'NO\' ELSE \'YES\' END AS "可空", dflt_value AS "默认值", CASE WHEN pk > 0 THEN \'PRI\' ELSE \'\' END AS "键" FROM pragma_table_info(?)', [table]);
    if (cols.rows.length === 0) return null;
    parts.push(`表 ${table}`);
    parts.push(columnsText(cols));
    const idx = rowsOf(await run('SELECT l.name, l."unique", (SELECT group_concat(i.name, \',\') FROM pragma_index_info(l.name) i) FROM pragma_index_list(?) l', [table]));
    if (idx.length) parts.push(`索引：\n${idx.map((x) => `- ${x[0]}${x[1] === '1' ? '（唯一）' : ''}：${x[2]}`).join('\n')}`);
    const fks = rowsOf(await run('SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)', [table]));
    if (fks.length) parts.push(`外键：\n${fks.map((x) => `- ${x[0]} → ${x[1]}.${x[2]}`).join('\n')}`);
    const ddl = rowsOf(await run('SELECT sql FROM sqlite_master WHERE name = ?', [table]))[0]?.[0];
    if (ddl) parts.push(`建表语句：\n${ddl}`);
  }
  return { text: parts.join('\n\n'), table: toTable(cols) };
}

function columnsText(r: RunResult): string {
  const rows = rowsOf(r);
  return `列（${rows.length}）：\n${r.columns.join(' | ')}\n${rows.map((x) => x.map((v) => flat(v)).join(' | ')).join('\n')}`;
}

/** db_execute 审批前：用 EXPLAIN 估算 UPDATE / DELETE 影响的行数（不执行语句；SQLite 不估算） */
export async function estimateRows(s: DbSession, statement: string, o: MetaOpts): Promise<number | null> {
  if (s.asset.type === 'SQLITE') return null;
  // EXPLAIN 不执行语句；MySQL 不允许在只读事务里 EXPLAIN UPDATE，所以用普通事务并且总是回滚
  const mysql = s.asset.type === 'MYSQL';
  const r = await s.run(`EXPLAIN ${statement}`, { readOnly: !mysql, rollback: true, maxRows: 50, timeoutMs: 5_000, signal: o.signal, ...(o.schema ? { schema: o.schema } : {}) });
  if (s.asset.type === 'MYSQL') {
    const ri = r.columns.findIndex((c) => c.toLowerCase() === 'rows');
    const fi = r.columns.findIndex((c) => c.toLowerCase() === 'filtered');
    const first = r.rows[0];
    if (ri < 0 || !first) return null;
    const rows = Number(cellText(first[ri]));
    const filtered = fi >= 0 ? Number(cellText(first[fi])) : 100;
    return Number.isFinite(rows) ? Math.round((rows * (Number.isFinite(filtered) ? filtered : 100)) / 100) : null;
  }
  // PostgreSQL：顶层的 Update / Delete 节点是 rows=0，取下面第一个扫描节点的估算
  for (const row of r.rows) {
    const line = cellText(row[0]) ?? '';
    if (/^\s*(Update|Delete|Merge|Insert) on /.test(line)) continue;
    const m = /rows=(\d+)/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

export { pgIdent };

// ---------------------------------------------------------------- SQL 工作台（第十八轮，文档一 6.32）

const TREE_ROWS = 1000;

/** 库表树的一层：不带库 = 列出库；PostgreSQL 带库不带 schema = 列出 schema；否则列出表和视图 */
export async function objectsOf(s: DbSession, o: MetaOpts & { listDatabases: boolean }): Promise<DbObjectList> {
  const run = (sql: string, params: unknown[] = []): Promise<RunResult> => s.run(sql, { ...META, maxRows: TREE_ROWS + 1, params, signal: o.signal });
  const pack = (kind: 'databases' | 'schemas' | 'tables', r: RunResult, current: string | null): DbObjectList => {
    const rows = rowsOf(r);
    return {
      kind,
      current,
      truncated: rows.length > TREE_ROWS,
      items: rows.slice(0, TREE_ROWS).map((x) => ({ name: x[0], type: x[1] || null, rows: x[2] || null, comment: x[3] || null })),
    };
  };
  const type = s.asset.type;
  if (type === 'SQLITE') {
    return pack('tables', await run("SELECT name, upper(type), NULL, NULL FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"), 'main');
  }
  if (type === 'MYSQL') {
    if (o.listDatabases) return pack('databases', await run('SELECT schema_name FROM information_schema.schemata ORDER BY schema_name'), s.database || null);
    const db = o.database || s.database;
    return pack(
      'tables',
      await run('SELECT table_name, table_type, table_rows, table_comment FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [db]),
      db,
    );
  }
  if (o.listDatabases) return pack('databases', await run('SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname'), s.database);
  if (!o.schema) return pack('schemas', await run("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname = 'public' DESC, nspname"), s.database);
  return pack(
    'tables',
    await run(
      `SELECT c.relname, CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'PARTITIONED TABLE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' END,
              CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END, obj_description(c.oid, 'pg_class')
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition ORDER BY c.relname`,
      [o.schema],
    ),
    `${s.database}.${o.schema}`,
  );
}

/** 表的列（最多 50 张表） */
export async function columnsOf(s: DbSession, tables: string[], o: MetaOpts): Promise<DbColumnInfo[]> {
  const list = [...new Set(tables.map(String).filter(Boolean))].slice(0, 50);
  if (!list.length) return [];
  const run = (sql: string, params: unknown[] = []): Promise<RunResult> => s.run(sql, { ...META, maxRows: 5000, params, signal: o.signal });
  const out: DbColumnInfo[] = [];
  const add = (r: RunResult): void => {
    for (const x of rowsOf(r)) out.push({ table: x[0], name: x[1], type: x[2], nullable: x[3] === 'YES' || x[3] === 'true' || x[3] === '1', key: x[4] || null, comment: x[5] || null });
  };
  if (s.asset.type === 'MYSQL') {
    const db = o.database || s.database;
    add(
      await run(
        `SELECT table_name, column_name, column_type, is_nullable, column_key, column_comment FROM information_schema.columns
          WHERE table_schema = ? AND table_name IN (${list.map(() => '?').join(', ')}) ORDER BY table_name, ordinal_position`,
        [db, ...list],
      ),
    );
  } else if (s.asset.type === 'POSTGRES') {
    add(
      await run(
        `SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
                CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY (i.indkey)) THEN 'PRI' END,
                col_description(c.oid, a.attnum)
           FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY ($2) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`,
        [o.schema || 'public', list],
      ),
    );
  } else {
    for (const t of list) add(await run("SELECT ?, name, type, CASE WHEN \"notnull\" THEN 'NO' ELSE 'YES' END, CASE WHEN pk > 0 THEN 'PRI' END, NULL FROM pragma_table_info(?)", [t, t]));
  }
  return out;
}

/** 工作台的结果：单元格最多 4000 字符（界面上省略显示，悬停看全文） */
export function toWorkbenchRows(rows: unknown[][]): (string | null)[][] {
  return rows.map((row) => row.map((v) => clipCell(cellText(v), 4000)));
}

/** 给 AI 的一行表结构：t_order(id bigint PK, user_id int, …) -- 订单 */
export function schemaLine(table: string, cols: DbColumnInfo[], comment: string | null): string {
  const c = cols.map((x) => `${x.name} ${x.type}${x.key === 'PRI' ? ' PK' : ''}${x.comment ? ` /*${x.comment.replace(/\s+/g, ' ').slice(0, 40)}*/` : ''}`).join(', ');
  return `${table}(${c})${comment ? ` -- ${comment.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`;
}
