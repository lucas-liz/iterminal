-- 本地档案库初始化（文档一 8.2 中本期用到的表）。
-- 带 srv_id、version、deleted 的表是云端实体的本地镜像：本地模式下 srv_id 为空、version 为 0，删除只打墓碑，
-- 以便登录后参与云同步 / 备份。

-- 主机分组（多级文件夹）
CREATE TABLE folder (
  id            TEXT PRIMARY KEY,                 -- 本地 UUID
  srv_id        INTEGER UNIQUE,
  parent_id     TEXT REFERENCES folder(id),
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,                    -- 物化路径 /rootId/.../selfId/
  sort          INTEGER NOT NULL DEFAULT 0,
  scope         TEXT NOT NULL DEFAULT 'PERSONAL',
  team_id       INTEGER,
  default_credential_id TEXT,
  default_jump_host_id  TEXT,
  agent_policy  TEXT,
  ai_note       TEXT,
  default_skills TEXT,
  version       INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_folder_parent ON folder(parent_id);
CREATE INDEX idx_folder_path   ON folder(path);

-- 凭证：秘密字段用保险库密钥 AES-256-GCM 加密（AAD = credential:{id}），在整库加密之上再加一层
CREATE TABLE credential (
  id            TEXT PRIMARY KEY,
  srv_id        INTEGER UNIQUE,
  scope         TEXT NOT NULL,                    -- PERSONAL | TEAM
  type          TEXT NOT NULL,                    -- PASSWORD | SSH_KEY | CERT | OTP | CLOUD_AK | DB
  name          TEXT NOT NULL,
  username      TEXT,
  secret_enc    BLOB,                             -- JSON {password} 或 {privateKey, passphrase}
  public_key    TEXT,
  fingerprint   TEXT,
  otp_seed_enc  BLOB,
  ai_access     TEXT NOT NULL DEFAULT 'REFERENCE',
  rotate_days   INTEGER,
  expires_at    INTEGER,
  last_used_at  INTEGER,
  version       INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- 主机
CREATE TABLE host (
  id            TEXT PRIMARY KEY,
  srv_id        INTEGER UNIQUE,
  folder_id     TEXT REFERENCES folder(id),
  name          TEXT NOT NULL,
  protocol      TEXT NOT NULL,                    -- SSH | TELNET | SERIAL | RDP | VNC | LOCAL
  address       TEXT,
  port          INTEGER,
  username      TEXT,                             -- 登录用户名（合并规则按 协议+地址+端口+用户名 识别同一主机）
  auth_method   TEXT NOT NULL DEFAULT 'PASSWORD', -- PASSWORD | KEY | AGENT | INTERACTIVE
  serial_opts   TEXT,
  credential_id TEXT REFERENCES credential(id),
  proxy         TEXT,
  encoding      TEXT DEFAULT 'UTF-8',
  term_type     TEXT DEFAULT 'xterm-256color',
  env           TEXT,
  startup_script TEXT,
  keepalive_sec INTEGER DEFAULT 30,
  agent_policy  TEXT,
  cmd_denylist  TEXT,
  ai_memory     TEXT,
  os_info       TEXT,
  note          TEXT,
  record_session INTEGER DEFAULT 1,
  last_connected_at INTEGER,
  version       INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_host_folder ON host(folder_id);

-- 已确认的主机指纹（首次连接时由用户确认，之后指纹变化会告警）
CREATE TABLE known_host (
  host        TEXT NOT NULL,
  port        INTEGER NOT NULL,
  key_type    TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (host, port, key_type)
);

-- 设置（只存本地）
CREATE TABLE setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
