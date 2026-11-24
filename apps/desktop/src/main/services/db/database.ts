import Database from 'better-sqlite3-multiple-ciphers';
import init from './migrations/0001_init.sql?raw';
import hostJump from './migrations/0002_host_jump.sql?raw';
import ai from './migrations/0003_ai.sql?raw';
import vaultTags from './migrations/0004_vault_tags.sql?raw';
import cmdHistory from './migrations/0005_cmd_history.sql?raw';
import m3 from './migrations/0006_m3.sql?raw';
import m35 from './migrations/0007_m35.sql?raw';
import m4 from './migrations/0008_m4.sql?raw';
import fileTransfer from './migrations/0009_file_transfer.sql?raw';
import schedule from './migrations/0010_schedule.sql?raw';
import team from './migrations/0011_team.sql?raw';
import notePrev from './migrations/0012_note_prev.sql?raw';
import dbAsset from './migrations/0013_db_asset.sql?raw';
import sqlReport from './migrations/0014_sql_report.sql?raw';

export type Db = Database.Database;

/**
 * 第二十四轮（文档一 6.38）：DeepSeek V4.1 Flash 开始支持图片。已经添加的 DeepSeek 提供商里，这个模型（含官方说明已并入它的旧名称）标记为支持图片；
 * 模型配置是 JSON，用代码改比 SQL 稳妥。
 */
const DEEPSEEK_VISION = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']);
function deepseekVision(db: Db): void {
  const rows = db.prepare<[], { id: string; models: string | null }>("SELECT id, models FROM ai_provider WHERE vendor = 'deepseek' OR base_url LIKE '%://api.deepseek.com%'").all();
  const update = db.prepare('UPDATE ai_provider SET models = ? WHERE id = ?');
  for (const r of rows) {
    let models: { id?: unknown; supportsImages?: boolean }[];
    try {
      models = JSON.parse(r.models ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(models)) continue;
    let changed = false;
    for (const m of models) {
      if (m && typeof m.id === 'string' && DEEPSEEK_VISION.has(m.id) && !m.supportsImages) {
        m.supportsImages = true;
        changed = true;
      }
    }
    if (changed) update.run(JSON.stringify(models), r.id);
  }
}

/** 第二十七轮新增的列（已经有的跳过：测试会把 user_version 改小重跑迁移） */
function round27Columns(db: Db): void {
  const add = (table: string, col: string, type: string): void => {
    const cols = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
    if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  };
  add('schedule_task', 'plan', 'TEXT');
  add('task_run', 'report_level', 'TEXT');
  add('db_asset', 'flavor', 'TEXT');
}

/** 第二十八轮：告警日志、外部告警接入；定时任务的告警设置（已经有的跳过） */
function round28Alerts(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS alert_event (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      host_id TEXT,
      host_name TEXT,
      source_name TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      status TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      resolved_at INTEGER,
      metrics TEXT,
      diagnosis TEXT,
      mail TEXT,
      raw TEXT,
      related TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_event_time ON alert_event(created_at);
    CREATE INDEX IF NOT EXISTS idx_alert_event_key ON alert_event(alert_key, status);
    CREATE TABLE IF NOT EXISTS alert_receiver (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      host_ids TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      email INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_at INTEGER,
      received INTEGER NOT NULL DEFAULT 0
    );`);
  const cols = db.prepare<[], { name: string }>('PRAGMA table_info(schedule_task)').all();
  if (!cols.some((c) => c.name === 'alert')) db.exec('ALTER TABLE schedule_task ADD COLUMN alert TEXT');
}

/** 第二十九轮：后台生成执行方案的状态；去掉外部告警接入 */
function round29PlanGen(db: Db): void {
  const cols = db.prepare<[], { name: string }>('PRAGMA table_info(schedule_task)').all();
  if (!cols.some((c) => c.name === 'plan_gen')) db.exec('ALTER TABLE schedule_task ADD COLUMN plan_gen TEXT');
  db.exec('DROP TABLE IF EXISTS alert_receiver');
}

/** 第三十五轮：连接日志记下登录的用户名；批量执行（命令 / 上传文件）的任务和每台主机的结果 */
function round35Batch(db: Db): void {
  const cols = db.prepare<[], { name: string }>('PRAGMA table_info(session_recording)').all();
  if (!cols.some((c) => c.name === 'username')) db.exec('ALTER TABLE session_recording ADD COLUMN username TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS batch_job (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      command TEXT,
      script INTEGER NOT NULL DEFAULT 0,
      timeout_sec INTEGER NOT NULL DEFAULT 0,
      remote_path TEXT,
      files TEXT,
      host_count INTEGER NOT NULL DEFAULT 0,
      file_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_batch_job_kind ON batch_job(kind, created_at);
    CREATE INDEX IF NOT EXISTS idx_recording_session ON session_recording(session_id);
    CREATE TABLE IF NOT EXISTS batch_job_host (
      job_id TEXT NOT NULL,
      host_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      username TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      output TEXT NOT NULL DEFAULT '',
      error TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      PRIMARY KEY (job_id, host_id)
    );`);
}

/** 按版本号依次执行，版本记在 PRAGMA user_version。新增迁移只能追加，不能修改已发布的脚本（sql 和 run 二选一）。 */
const MIGRATIONS: { version: number; sql?: string; run?: (db: Db) => void }[] = [
  { version: 1, sql: init },
  { version: 2, sql: hostJump },
  { version: 3, sql: ai },
  { version: 4, sql: vaultTags },
  { version: 5, sql: cmdHistory },
  { version: 6, sql: m3 },
  { version: 7, sql: m35 },
  { version: 8, sql: m4 },
  { version: 9, sql: fileTransfer },
  { version: 10, sql: schedule },
  { version: 11, sql: team },
  { version: 12, sql: notePrev },
  { version: 13, sql: dbAsset },
  { version: 14, sql: sqlReport },
  { version: 15, run: deepseekVision },
  // 第二十六轮：Agent 记下的主机记忆按条目保存（手工填写的仍在 host.ai_memory）
  {
    version: 16,
    sql: `CREATE TABLE IF NOT EXISTS host_agent_memory (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      content TEXT NOT NULL,
      conversation_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_host_agent_memory_host ON host_agent_memory(host_id, created_at);`,
  },
  // 第二十七轮：AI 任务的执行方案（试运行后固化的命令清单 + 汇总要求 + 报告推送）、执行记录的巡检结论、数据库的产品（图标）
  { version: 17, run: round27Columns },
  // 第二十八轮：告警中心（告警日志、外部告警接入）、定时任务的告警设置
  { version: 18, run: round28Alerts },
  // 第二十九轮：后台生成执行方案；外部告警接入去掉了
  { version: 19, run: round29PlanGen },
  // 第三十五轮：连接日志的登录用户、批量执行
  { version: 20, run: round35Batch },
];

/**
 * 打开（或创建）档案库。整库用 SQLCipher 加密，密钥错误时抛出 SQLITE_NOTADB。
 */
export function openDatabase(file: string, key: Buffer): Db {
  if (key.length !== 32) {
    throw new Error('数据库密钥长度必须是 32 字节');
  }
  const db = new Database(file);
  try {
    db.pragma(`cipher='sqlcipher'`);
    db.pragma('legacy=4');
    db.pragma(`key="x'${key.toString('hex')}'"`);
    // 读一次 schema，密钥不对时在这里就失败，而不是等到第一次查询
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const m of MIGRATIONS) {
    if (m.version <= current) {
      continue;
    }
    db.transaction(() => {
      if (m.sql) db.exec(m.sql);
      m.run?.(db);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}
