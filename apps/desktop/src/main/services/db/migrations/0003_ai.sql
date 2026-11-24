-- AI 配置：个人 Provider，只存本地，不上云（文档一 8.2）
CREATE TABLE ai_provider (
  id            TEXT PRIMARY KEY,
  srv_id        INTEGER UNIQUE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,                    -- ANTHROPIC | OPENAI | OPENAI_COMPAT | OLLAMA
  base_url      TEXT NOT NULL,
  api_key_enc   BLOB,                             -- AES-256-GCM（AAD = ai_provider:{id}）
  models        TEXT,                             -- JSON [{id, displayName, contextWindow, maxOutput, effort}]
  extra_headers_enc BLOB,
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- Agent 会话（本地）。meta：终端编号、已注入的 Skill、用量校准系数
CREATE TABLE ai_conversation (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  mode        TEXT NOT NULL DEFAULT 'agent',
  model_ref   TEXT,
  meta        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived    INTEGER DEFAULT 0
);

-- 消息只追加（压缩时只打 compacted 标记），保证发给模型的历史不被改写
CREATE TABLE ai_message (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_conversation(id),
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,                  -- user | assistant | tool_results
  content         TEXT NOT NULL,                  -- JSON
  compacted       INTEGER NOT NULL DEFAULT 0,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_msg_conv ON ai_message(conversation_id, seq);
