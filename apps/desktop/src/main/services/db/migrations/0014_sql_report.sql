-- 定时 SQL 报表（第十八轮，文档一 6.32.3）：type = SQL 时，command 是只读 SQL，在 db_id 这个数据库上执行，按 report 的设置发送
ALTER TABLE schedule_task ADD COLUMN db_id TEXT;
ALTER TABLE schedule_task ADD COLUMN db_database TEXT;
ALTER TABLE schedule_task ADD COLUMN report TEXT;
