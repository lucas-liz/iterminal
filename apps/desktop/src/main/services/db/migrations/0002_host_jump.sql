-- 跳板机链（文档一 8.2 host_jump）：本机 → seq=0 → seq=1 → … → 目标主机
CREATE TABLE host_jump (
  host_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  jump_host_id TEXT NOT NULL,
  PRIMARY KEY (host_id, seq)
);
CREATE INDEX idx_host_jump_target ON host_jump(jump_host_id);
