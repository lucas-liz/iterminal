-- v0.6（M4）：会话录像（文档一 6.1 / 6.12）

-- 录像元数据；内容是 asciicast v2，按块加密写在 {档案目录}/recordings/ 下（密钥由保险库密钥派生）
CREATE TABLE session_recording (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                      -- ssh | telnet | serial | local
  host_id     TEXT,
  host_name   TEXT NOT NULL,
  cols        INTEGER NOT NULL,
  rows        INTEGER NOT NULL,
  file        TEXT NOT NULL,                      -- 相对档案目录的路径
  bytes       INTEGER NOT NULL DEFAULT 0,         -- 记录的输出字节数（明文）
  duration_ms INTEGER NOT NULL DEFAULT 0,
  truncated   INTEGER NOT NULL DEFAULT 0,         -- 超过大小上限后停止记录
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  uploaded    INTEGER NOT NULL DEFAULT 0          -- 登录后分片上传（M4.3）
);
CREATE INDEX idx_recording_time ON session_recording(started_at);
CREATE INDEX idx_audit_kind_time ON audit_log(kind, created_at);

-- 本设备执行过的定时任务（服务端 task.dispatch 派发，文档一 6.11）
CREATE TABLE task_run (
  run_id      TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  task_name   TEXT,
  type        TEXT NOT NULL,                      -- COMMAND | SKILL | AGENT_PROMPT
  target      TEXT NOT NULL,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  summary     TEXT,
  hosts       TEXT NOT NULL                       -- JSON [{hostId, hostName, status, exitCode, output, message}]
);
CREATE INDEX idx_task_run_time ON task_run(started_at);
