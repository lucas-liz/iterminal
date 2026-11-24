-- 本机定时任务（第四轮）：用户手动创建或 Agent 创建（用户批准后），应用运行时按计划执行
CREATE TABLE schedule_task (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  type               TEXT NOT NULL,                 -- COMMAND | AGENT_PROMPT
  command            TEXT,
  prompt             TEXT,
  host_ids           TEXT NOT NULL,                 -- JSON ["hostId", ...]
  schedule           TEXT NOT NULL,                 -- JSON ScheduleSpec
  ai_assist          INTEGER NOT NULL DEFAULT 0,
  goal               TEXT,
  ai_policy          TEXT NOT NULL DEFAULT 'APPROVE',
  timeout_min        INTEGER NOT NULL DEFAULT 30,
  notify_on_failure  INTEGER NOT NULL DEFAULT 1,
  created_by         TEXT NOT NULL DEFAULT 'USER',  -- USER | AGENT
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  next_run_at        INTEGER,
  last_run_at        INTEGER,
  last_status        TEXT
);

-- 执行记录：区分服务端派发和本机定时任务；Agent 介入时记下对话
ALTER TABLE task_run ADD COLUMN origin TEXT NOT NULL DEFAULT 'SERVER';
ALTER TABLE task_run ADD COLUMN conversation_id TEXT;
CREATE INDEX idx_task_run_task ON task_run(task_id, started_at);
