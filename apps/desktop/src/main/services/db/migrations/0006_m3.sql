-- v0.4（M3）：快捷命令与笔记、端口转发、监控采样、MCP Server、分享码导入映射（文档一 6.14 / 6.4 / 6.8 / 6.10.7 / 8.2）

-- 快捷命令分组（单层，可排序）/ 快捷命令；删除打墓碑（参与云同步）
CREATE TABLE snippet_group (
  id         TEXT PRIMARY KEY,
  srv_id     INTEGER UNIQUE,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE snippet (
  id          TEXT PRIMARY KEY,
  srv_id      INTEGER UNIQUE,
  scope       TEXT NOT NULL DEFAULT 'PERSONAL',
  group_id    TEXT,                               -- NULL = 未分组
  name        TEXT NOT NULL,
  content     TEXT NOT NULL,                      -- 支持 {{变量}} / {{变量:默认值}}
  description TEXT,
  tags        TEXT,                               -- JSON 数组
  sort        INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_snippet_group ON snippet(group_id);

-- 笔记分组（单层，可排序）/ 笔记
CREATE TABLE note_group (
  id         TEXT PRIMARY KEY,
  srv_id     INTEGER UNIQUE,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE note (
  id         TEXT PRIMARY KEY,
  srv_id     INTEGER UNIQUE,
  group_id   TEXT,                                -- NULL = 未分组
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  format     TEXT NOT NULL DEFAULT 'MARKDOWN',    -- MARKDOWN | TEXT
  pinned     INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_note_group ON note(group_id);

-- 端口转发（主机的附属数据）：LOCAL（-L）| REMOTE（-R）| DYNAMIC（-D，SOCKS5）
CREATE TABLE port_forward (
  id          TEXT PRIMARY KEY,
  srv_id      INTEGER UNIQUE,
  host_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  bind_addr   TEXT NOT NULL,
  bind_port   INTEGER NOT NULL,
  target_addr TEXT,
  target_port INTEGER,
  auto_start  INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 0,
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_port_forward_host ON port_forward(host_id);

-- 分享码导入映射（6.10.7）：从某个分享者导入过哪些条目，再次拉取时识别为同一条目
CREATE TABLE share_import_map (
  owner_id    TEXT NOT NULL,
  entity      TEXT NOT NULL,
  remote_id   TEXT NOT NULL,
  local_id    TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, entity, remote_id)
);

-- MCP Server 配置（6.8）：环境变量和请求头可能含令牌，加密保存
CREATE TABLE mcp_server (
  id                 TEXT PRIMARY KEY,
  srv_id             INTEGER UNIQUE,
  scope              TEXT NOT NULL DEFAULT 'PERSONAL',
  name               TEXT NOT NULL,
  transport          TEXT NOT NULL,              -- STDIO | SSE | HTTP
  command            TEXT,
  args               TEXT,                       -- JSON 数组
  url                TEXT,
  env_enc            BLOB,
  headers_enc        BLOB,
  default_permission TEXT NOT NULL DEFAULT 'APPROVE',
  tool_policies      TEXT,                       -- JSON {toolName: AUTO|APPROVE|DISABLED}
  enabled            INTEGER NOT NULL DEFAULT 1,
  version            INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

-- 监控采样（6.4）：每台主机每小时一条（取这一小时内的平均 / 最大值），保留 30 天；磁盘写满预测用最近 7 天
CREATE TABLE metric_sample (
  host_id TEXT NOT NULL,
  ts      INTEGER NOT NULL,                      -- 整点（毫秒）
  cpu     REAL,
  mem     REAL,
  load1   REAL,
  disk    TEXT,                                  -- JSON {mount: usedPct}
  net_rx  REAL,
  net_tx  REAL,
  n       INTEGER NOT NULL DEFAULT 1,            -- 这一小时已合并的采样次数
  PRIMARY KEY (host_id, ts)
);

-- 主机的自定义监控采集脚本（非 Linux 设备）
ALTER TABLE host ADD COLUMN monitor_script TEXT;
