-- 数据库资产（第十七轮，文档一 6.31.2）：Agent 的 db_* 工具连接的数据库。
-- 密码用保险库密钥再加密一层（AAD 绑定资产 ID）；删除打墓碑，留出 updated_at 给以后的云同步。
CREATE TABLE db_asset (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  host          TEXT NOT NULL DEFAULT '',
  port          INTEGER NOT NULL DEFAULT 0,
  database_name TEXT NOT NULL DEFAULT '',
  username      TEXT NOT NULL DEFAULT '',
  password_enc  BLOB,
  credential_id TEXT,
  ssl           TEXT NOT NULL DEFAULT 'OFF',
  via_host_id   TEXT,
  file_path     TEXT,
  agent_policy  TEXT,
  production    INTEGER NOT NULL DEFAULT 0,
  sql_denylist  TEXT NOT NULL DEFAULT '[]',
  note          TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_db_asset_live ON db_asset (deleted, name);
