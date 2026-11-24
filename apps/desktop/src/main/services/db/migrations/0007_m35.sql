-- v0.5（M3.5）：模型厂商预设与深度思考参数、用户命令规则（文档一 6.15）

-- 模型提供商：厂商预设、深度思考参数的发送方式、是否回传 reasoning_content
ALTER TABLE ai_provider ADD COLUMN vendor TEXT;
ALTER TABLE ai_provider ADD COLUMN thinking_style TEXT;
ALTER TABLE ai_provider ADD COLUMN echo_reasoning INTEGER NOT NULL DEFAULT 0;

-- 用户自己的命令规则（命令安全配置，6.15.7）。list：WHITE 白名单 / DANGER 危险命令 / BLACK 黑名单 / NULL 自定义规则
CREATE TABLE command_rule (
  id          TEXT PRIMARY KEY,
  list        TEXT,
  level       TEXT NOT NULL,                      -- L0 | L1 | L2 | DENY
  match_type  TEXT NOT NULL,                      -- PREFIX | REGEX | EXACT
  pattern     TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
