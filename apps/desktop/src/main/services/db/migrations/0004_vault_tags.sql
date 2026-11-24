-- v0.3：文件夹设置与继承、主机扩展字段、标签 / 收藏、凭证管理、本地审计（文档一 6.5 / 6.6 / 6.12）

-- 生产环境分组：Agent 执行命令最低按 L1 审批，向下继承
ALTER TABLE folder ADD COLUMN production INTEGER NOT NULL DEFAULT 0;

-- jump_inherit：主机没有设置跳板机时，是否使用分组的默认跳板机
ALTER TABLE host ADD COLUMN jump_inherit INTEGER NOT NULL DEFAULT 1;
-- 代理密码（AES-256-GCM，AAD = host_proxy:{id}）；代理地址等在 proxy 列（JSON）
ALTER TABLE host ADD COLUMN proxy_password_enc BLOB;

-- 主机专属凭证（在主机编辑框里直接填写的密码 / 私钥）记录所属主机；共享凭证为 NULL
ALTER TABLE credential ADD COLUMN owner_host_id TEXT;
ALTER TABLE credential ADD COLUMN note TEXT;
ALTER TABLE credential ADD COLUMN key_type TEXT;
-- 最近一次修改秘密的时间（轮换提醒按它计算）
ALTER TABLE credential ADD COLUMN rotated_at INTEGER;
UPDATE credential SET owner_host_id = (SELECT h.id FROM host h WHERE h.credential_id = credential.id LIMIT 1), rotated_at = updated_at;
CREATE INDEX idx_credential_owner ON credential(owner_host_id);

-- 标签：名称不区分大小写唯一；删除打墓碑（参与云同步）
CREATE TABLE tag (
  id         TEXT PRIMARY KEY,
  srv_id     INTEGER UNIQUE,
  name       TEXT NOT NULL,
  color      TEXT,
  version    INTEGER NOT NULL DEFAULT 0,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_tag_name ON tag(lower(name)) WHERE deleted = 0;

CREATE TABLE host_tag (
  host_id    TEXT NOT NULL,
  tag_id     TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, tag_id)
);
CREATE INDEX idx_host_tag_tag ON host_tag(tag_id);

CREATE TABLE favorite (
  host_id    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- 本地审计（文档一 6.12）：命令（人工 / Agent / Skill / 定时 / 外部 MCP）和安全事件。
-- 本地模式只保存在本机（保留 30 天）；登录后 uploaded = 0 的记录作为 Outbox 批量上报。
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL UNIQUE,               -- client_event_id，上报幂等
  kind        TEXT NOT NULL,                      -- COMMAND | EVENT
  source      TEXT,                               -- USER | AGENT | SKILL | SCHEDULE | MCP_EXTERNAL
  event_type  TEXT,                               -- EVENT 的类型，例如 CREDENTIAL_REVEAL
  host_id     TEXT,
  host_name   TEXT,
  session_id  TEXT,
  command     TEXT,
  risk        TEXT,                               -- L0 | L1 | L2 | DENY
  decision    TEXT,                               -- AUTO | APPROVED | REJECTED | DENIED
  exit_code   INTEGER,
  detail      TEXT,                               -- JSON
  created_at  INTEGER NOT NULL,
  uploaded    INTEGER NOT NULL DEFAULT 0,
  tries       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_time ON audit_log(created_at);
CREATE INDEX idx_audit_upload ON audit_log(uploaded, id);
