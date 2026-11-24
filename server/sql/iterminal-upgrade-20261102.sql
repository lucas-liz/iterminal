-- ============================================================================
-- iTerminal 数据库升级：知识库支持 Milvus 向量库（2026-11-02）
-- 已经用 iterminal.sql 初始化过的库执行这个脚本（新装的库不需要，iterminal.sql 已经包含）：
--   mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/iterminal-upgrade-20261102.sql
-- 内容：参数 itm.kb.vectorStore / milvusUrl / milvusToken / milvusDb / milvusCollection
-- 不执行也能用（管理页保存时会自动补上参数），执行后参数设置页面里能看到说明
-- 可以重复执行：参数已经存在时不插入（按参数键名判断，不占用固定的主键）
-- ============================================================================

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-知识库向量存储（MYSQL / MILVUS）', 'itm.kb.vectorStore', 'MYSQL', 'Y', 'admin', sysdate(), '', null,
       '知识库向量存在哪里：MYSQL（默认，检索时在内存里计算）或 MILVUS（请在管理页「知识库 → 向量存储」里修改）'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.kb.vectorStore');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-知识库 Milvus 地址', 'itm.kb.milvusUrl', '', 'Y', 'admin', sysdate(), '', null,
       'Milvus 2.4+ 的地址，例如 http://127.0.0.1:19530'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.kb.milvusUrl');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-知识库 Milvus 认证（加密）', 'itm.kb.milvusToken', '', 'Y', 'admin', sysdate(), '', null,
       '用户名:密码或 API Key（AES-256-GCM 加密，请在管理页面里修改，不要直接改这里）'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.kb.milvusToken');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-知识库 Milvus 数据库', 'itm.kb.milvusDb', '', 'Y', 'admin', sysdate(), '', null,
       'Milvus 数据库名，为空时用 default'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.kb.milvusDb');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-知识库 Milvus 集合前缀', 'itm.kb.milvusCollection', '', 'Y', 'admin', sysdate(), '', null,
       'Milvus 集合名前缀，为空时用 itm_kb_chunks（实际集合名带向量维度，例如 itm_kb_chunks_d1024）'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.kb.milvusCollection');
