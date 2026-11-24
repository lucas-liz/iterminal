import Database from 'better-sqlite3-multiple-ciphers';
import mysql, { type Connection, type FieldPacket } from 'mysql2';
import pg from 'pg';
import type { DbSslMode, DbType } from '@itm/protocol';
import { UserError } from '../../util/errors';

/** 连接一个数据库需要的全部信息（密码已解密，只在主进程内使用） */
export interface DbTarget {
  type: DbType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string | null;
  ssl: DbSslMode;
  filePath: string | null;
}

export interface RunOptions {
  /** 在只读事务里执行（SQLite 以只读方式打开文件） */
  readOnly: boolean;
  /** 最多读取的行数（多读一行判断是否还有更多） */
  maxRows: number;
  timeoutMs: number;
  signal?: AbortSignal;
  /** 参数（MySQL / SQLite 用 ?，PostgreSQL 用 $1） */
  params?: unknown[];
  /** PostgreSQL：可以用游标分批读取（SELECT / VALUES / TABLE） */
  cursorable?: boolean;
  /** PostgreSQL：本次使用的 schema（search_path） */
  schema?: string;
  /** 不管成功与否都回滚（MySQL 的 EXPLAIN UPDATE 不能在只读事务里执行，估算影响行数时用普通事务 + 回滚） */
  rollback?: boolean;
}

export interface RunResult {
  columns: string[];
  rows: unknown[][];
  /** 达到行数上限，后面还有 */
  truncated: boolean;
  /** 写语句影响的行数 */
  affected: number | null;
  durationMs: number;
}

export interface DbDriver {
  readonly type: DbType;
  /** 服务器版本，例如 8.0.36、PostgreSQL 16.2、SQLite 3.45.1 */
  readonly version: string;
  run(sql: string, o: RunOptions): Promise<RunResult>;
  close(): Promise<void>;
}

/** 超时 / 停止：连接已经断开，不能再用 */
export class DbAbortError extends UserError {}

const CONNECT_TIMEOUT_MS = 10_000;
/** 数据库自己的超时之后，客户端再等 2 秒才断开连接 */
const SERVER_GRACE_MS = 2_000;

/**
 * 计时和停止：到时间或停止时调用 kill（断开连接），并以 DbAbortError 结束。
 * graceMs：数据库自己也会按超时取消（statement_timeout / max_execution_time）时，客户端多等一会儿，让数据库先返回超时错误
 */
function guard<T>(o: RunOptions, kill: () => void, work: Promise<T>, graceMs = 0): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const stop = (msg: string): void =>
      finish(() => {
        try {
          kill();
        } catch {
          // 断开连接失败也照样返回
        }
        reject(new DbAbortError(msg));
      });
    const timer = setTimeout(() => stop(`查询超时（超过 ${Math.round(o.timeoutMs / 1000)} 秒），已断开连接`), o.timeoutMs + graceMs);
    const onAbort = (): void => stop('已停止');
    if (o.signal?.aborted) return onAbort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e)),
    );
  });
}

// ---------------------------------------------------------------- MySQL / MariaDB

class MysqlDriver implements DbDriver {
  readonly type = 'MYSQL' as const;
  private dead = false;

  constructor(
    private readonly conn: Connection,
    readonly version: string,
  ) {}

  private simple(sql: string): Promise<void> {
    return new Promise((resolve, reject) => this.conn.query(sql, (err) => (err ? reject(err) : resolve())));
  }

  private kill(): void {
    this.dead = true;
    this.conn.destroy();
  }

  /** 流式读取：最多 maxRows 行，多出来时暂停并断开连接（不把整张大表读进内存） */
  private stream(sql: string, o: RunOptions): Promise<RunResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      let columns: string[] | null = null;
      let sets = 0;
      const rows: unknown[][] = [];
      let affected: number | null = null;
      let settled = false;
      const done = (err: Error | null, truncated = false): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve({ columns: columns ?? [], rows, truncated, affected, durationMs: Date.now() - started });
      };
      const q = this.conn.query({ sql, values: o.params, rowsAsArray: true });
      q.on('error', (e: Error) => done(e));
      q.on('fields', (f: FieldPacket[] | undefined) => {
        // UPDATE 等没有结果集的语句也会触发 fields（参数是 undefined）
        if (!Array.isArray(f)) return;
        sets++;
        if (sets === 1) columns = f.map((x) => x.name);
      });
      q.on('result', (row: unknown) => {
        if (settled) return;
        if (Array.isArray(row)) {
          // 存储过程等返回多个结果集时只取第一个
          if (sets > 1) return;
          if (rows.length >= o.maxRows) {
            this.conn.pause();
            this.kill();
            done(null, true);
            return;
          }
          rows.push(row);
        } else if (row && typeof row === 'object' && 'affectedRows' in row) {
          affected = (affected ?? 0) + Number((row as { affectedRows: number }).affectedRows);
        }
      });
      q.on('end', () => done(null));
    });
  }

  async run(sql: string, o: RunOptions): Promise<RunResult> {
    if (this.dead) throw new UserError('数据库连接已断开');
    const work = (async (): Promise<RunResult> => {
      // 服务器端的超时：MySQL 只对 SELECT 生效；MariaDB 对所有语句生效。不支持时忽略
      const mariadb = /mariadb/i.test(this.version);
      await this.simple(mariadb ? `SET SESSION max_statement_time = ${Math.max(1, Math.ceil(o.timeoutMs / 1000))}` : `SET SESSION max_execution_time = ${Math.max(1, o.timeoutMs)}`).catch(() => undefined);
      await this.simple(o.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
      try {
        const r = await this.stream(sql, o);
        // 达到行数上限时连接已经断开（只读事务随之回滚）
        if (!this.dead) await this.simple(o.readOnly || o.rollback ? 'ROLLBACK' : 'COMMIT');
        return r;
      } catch (e) {
        if (!this.dead) await this.simple('ROLLBACK').catch(() => undefined);
        throw e;
      }
    })();
    return guard(o, () => this.kill(), work, SERVER_GRACE_MS);
  }

  async close(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    await new Promise<void>((resolve) => this.conn.end(() => resolve()));
  }
}

async function openMysql(t: DbTarget): Promise<DbDriver> {
  const conn = mysql.createConnection({
    host: t.host,
    port: t.port,
    user: t.username,
    password: t.password ?? undefined,
    database: t.database || undefined,
    ssl: t.ssl === 'OFF' ? undefined : { rejectUnauthorized: t.ssl === 'VERIFY' },
    connectTimeout: CONNECT_TIMEOUT_MS,
    // 日期按数据库返回的原文、大整数和 DECIMAL 用字符串、JSON 不解析
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    jsonStrings: true,
    multipleStatements: false,
    charset: 'utf8mb4',
    // 不允许 LOAD DATA LOCAL INFILE 读本机文件
    flags: ['-LOCAL_FILES'],
  });
  conn.on('error', () => undefined);
  try {
    await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())));
    const version = await new Promise<string>((resolve, reject) =>
      conn.query({ sql: 'SELECT VERSION()', rowsAsArray: true }, (err, rows) => (err ? reject(err) : resolve(String((rows as unknown[][])[0]?.[0] ?? '')))),
    );
    return new MysqlDriver(conn, version);
  } catch (e) {
    conn.destroy();
    throw e;
  }
}

// ---------------------------------------------------------------- PostgreSQL

/** 所有类型都按服务器返回的文本（不做时区换算、不丢精度）；布尔值换成 true / false */
const PG_TYPES = {
  getTypeParser: (oid: number) => (oid === 16 ? (v: string) => (v === 't' ? 'true' : v === 'f' ? 'false' : v) : (v: string) => v),
};

export function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

class PostgresDriver implements DbDriver {
  readonly type = 'POSTGRES' as const;
  private dead = false;

  constructor(
    private readonly client: pg.Client,
    readonly version: string,
  ) {}

  private kill(): void {
    this.dead = true;
    // pg 没有公开的强制断开方法：直接关闭底层连接（服务器会回滚没有提交的事务）
    const stream = (this.client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream;
    stream?.destroy();
    void this.client.end().catch(() => undefined);
  }

  async run(sql: string, o: RunOptions): Promise<RunResult> {
    if (this.dead) throw new UserError('数据库连接已断开');
    const c = this.client;
    const started = Date.now();
    const work = (async (): Promise<RunResult> => {
      await c.query(o.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
      try {
        await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(o.timeoutMs))}`);
        if (o.schema) await c.query(`SET LOCAL search_path TO ${pgIdent(o.schema)}, public`);
        let columns: string[];
        let rows: unknown[][];
        let truncated = false;
        let affected: number | null = null;
        if (o.readOnly && o.cursorable && !o.params?.length) {
          await c.query(`DECLARE itm_cursor NO SCROLL CURSOR FOR ${sql}`);
          const r = await c.query({ text: `FETCH ${o.maxRows + 1} FROM itm_cursor`, rowMode: 'array' });
          columns = r.fields.map((f) => f.name);
          rows = r.rows as unknown[][];
        } else {
          const r = await c.query({ text: sql, values: o.params, rowMode: 'array' });
          columns = (r.fields ?? []).map((f) => f.name);
          rows = (r.rows ?? []) as unknown[][];
          if (!r.fields?.length || ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'].includes(r.command)) affected = r.rowCount ?? null;
        }
        if (rows.length > o.maxRows) {
          rows = rows.slice(0, o.maxRows);
          truncated = true;
        }
        await c.query(o.readOnly || o.rollback ? 'ROLLBACK' : 'COMMIT');
        return { columns, rows, truncated, affected, durationMs: Date.now() - started };
      } catch (e) {
        if (!this.dead) await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    })();
    return guard(o, () => this.kill(), work, SERVER_GRACE_MS);
  }

  async close(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    await this.client.end().catch(() => undefined);
  }
}

async function openPostgres(t: DbTarget): Promise<DbDriver> {
  const client = new pg.Client({
    host: t.host,
    port: t.port,
    user: t.username,
    password: t.password ?? undefined,
    database: t.database || 'postgres',
    ssl: t.ssl === 'OFF' ? false : { rejectUnauthorized: t.ssl === 'VERIFY' },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: 'iTerminal',
    types: PG_TYPES,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    const r = await client.query<{ v: string }>("SELECT current_setting('server_version') AS v");
    return new PostgresDriver(client, `PostgreSQL ${r.rows[0]?.v ?? ''}`.trim());
  } catch (e) {
    await client.end().catch(() => undefined);
    throw e;
  }
}

// ---------------------------------------------------------------- SQLite（本机文件）

/**
 * SQLite 在主进程里同步执行：每次调用按需要以只读或读写方式打开文件，用完关闭。
 * 只读时除了只读打开，还检查语句确实不写（stmt.readonly）。超时只能在返回的行之间检查。
 */
class SqliteDriver implements DbDriver {
  readonly type = 'SQLITE' as const;

  constructor(
    private readonly file: string,
    readonly version: string,
  ) {}

  async run(sql: string, o: RunOptions): Promise<RunResult> {
    if (o.signal?.aborted) throw new DbAbortError('已停止');
    const started = Date.now();
    const db = new Database(this.file, { readonly: o.readOnly, fileMustExist: true, timeout: 5000 });
    try {
      db.defaultSafeIntegers(true);
      const stmt = db.prepare(sql);
      if (o.readOnly && !stmt.readonly) throw new UserError('这条语句会修改数据库，只读查询不能执行');
      const params = o.params ?? [];
      if (stmt.reader) {
        stmt.raw(true);
        const columns = stmt.columns().map((c) => c.name);
        const rows: unknown[][] = [];
        let truncated = false;
        const deadline = started + o.timeoutMs;
        const run = (): void => {
          for (const row of stmt.iterate(...params) as Iterable<unknown[]>) {
            if (rows.length >= o.maxRows) {
              truncated = true;
              break;
            }
            if (Date.now() > deadline) throw new DbAbortError(`查询超时（超过 ${Math.round(o.timeoutMs / 1000)} 秒）`);
            if (o.signal?.aborted) throw new DbAbortError('已停止');
            rows.push(row);
          }
        };
        if (o.readOnly) run();
        else db.transaction(run)();
        return { columns, rows, truncated, affected: null, durationMs: Date.now() - started };
      }
      const info = o.readOnly ? stmt.run(...params) : db.transaction(() => stmt.run(...params))();
      return { columns: [], rows: [], truncated: false, affected: Number(info.changes), durationMs: Date.now() - started };
    } finally {
      db.close();
    }
  }

  async close(): Promise<void> {
    // 每次执行都单独打开、关闭文件
  }
}

function openSqlite(t: DbTarget): DbDriver {
  if (!t.filePath) throw new UserError('没有设置 SQLite 文件');
  const db = new Database(t.filePath, { readonly: true, fileMustExist: true });
  try {
    const v = db.prepare('SELECT sqlite_version()').pluck().get() as string;
    return new SqliteDriver(t.filePath, `SQLite ${v}`);
  } catch (e) {
    throw new UserError(`打不开 SQLite 文件：${(e as Error).message}`);
  } finally {
    db.close();
  }
}

/** 连接数据库（经过 SSH 主机时 host / port 已经换成本机隧道的地址） */
export async function openDriver(t: DbTarget): Promise<DbDriver> {
  try {
    if (t.type === 'SQLITE') return openSqlite(t);
    if (t.type === 'POSTGRES') return await openPostgres(t);
    return await openMysql(t);
  } catch (e) {
    if (e instanceof UserError) throw e;
    if ((e as { code?: string }).code === 'SQLITE_CANTOPEN') throw new UserError(`打不开 SQLite 文件 ${t.filePath}`);
    throw new UserError(`连接数据库失败：${describeDbError(e)}`);
  }
}

const NET_ERRORS: Record<string, string> = {
  ECONNREFUSED: '连接被拒绝（地址或端口不对，或者数据库没有监听这个地址）',
  ETIMEDOUT: '连接超时',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: '域名解析失败',
  EHOSTUNREACH: '主机不可达',
  ECONNRESET: '连接被重置',
  ER_ACCESS_DENIED_ERROR: '用户名或密码错误',
  ER_BAD_DB_ERROR: '库不存在',
  ER_DBACCESS_DENIED_ERROR: '没有这个库的访问权限',
  '28P01': '用户名或密码错误',
  '3D000': '库不存在',
  '57014': '查询超时，已被数据库取消',
  '25006': '只读事务里不能执行写操作',
  ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: '只读事务里不能执行写操作',
  ER_QUERY_TIMEOUT: '查询超时，已被数据库取消',
};

/** 数据库错误的说明：常见错误换成中文，其余保留原文（不含密码） */
export function describeDbError(e: unknown): string {
  const err = e as { code?: string; errno?: number; message?: string; sqlMessage?: string };
  const text = err.sqlMessage ?? err.message ?? String(e);
  const zh = err.code ? NET_ERRORS[err.code] : undefined;
  if (zh && err.code && /^(E[A-Z]+|28P01|3D000)$/.test(err.code)) return zh;
  return zh ? `${zh}（${text}）` : text;
}
