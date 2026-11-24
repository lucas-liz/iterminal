-- ============================================================================
-- iTerminal 数据库升级：知识库本地向量模型（2026-10-19）
-- 已经用 iterminal.sql 初始化过的库执行这个脚本（新装的库不需要，iterminal.sql 已经包含）：
--   mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/iterminal-upgrade-20261019.sql
-- 内容：参数 itm.kb.embedUrl（本地向量服务地址，例如 Ollama 的 http://127.0.0.1:11434/v1）
-- 可以重复执行：参数已经存在时不插入（按参数键名判断，不占用固定的主键，避免和手工新增的参数冲突）
-- ============================================================================

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-知识库本地向量服务', 'itm.kb.embedUrl', '', 'Y', 'admin', sysdate(), '', null,
       '本地向量服务的地址（OpenAI 兼容，例如 Ollama 的 http://127.0.0.1:11434/v1）；配置了提供商时不用这个地址'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.kb.embedUrl');

update sys_config set remark = '向量模型 ID，例如本地 bge-m3、千问 text-embedding-v4、豆包 doubao-embedding'
where config_key = 'itm.kb.embedModel';
