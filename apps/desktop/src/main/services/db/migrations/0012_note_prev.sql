-- 笔记的上一个版本（第八轮）：只保留一个，用于笔记页「撤回」和 Agent 修改笔记后的回退。
ALTER TABLE note ADD COLUMN prev_title TEXT;
ALTER TABLE note ADD COLUMN prev_content TEXT;
ALTER TABLE note ADD COLUMN prev_at INTEGER;
