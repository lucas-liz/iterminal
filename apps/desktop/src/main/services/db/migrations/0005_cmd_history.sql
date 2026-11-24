-- 终端行内补全（文档一 6.1）的本地候选：在终端里执行过的命令（按主机分开，只存本地加密库）
CREATE TABLE cmd_history (
  scope     TEXT NOT NULL,                        -- host:{hostId} | local
  command   TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 1,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (scope, command)
);
CREATE INDEX idx_cmd_history_scope ON cmd_history(scope, last_used);
