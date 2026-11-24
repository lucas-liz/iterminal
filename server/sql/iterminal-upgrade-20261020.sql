-- ============================================================================
-- iTerminal 数据库升级：联网搜索独立配置（2026-10-20，第二十五轮）
-- 已经用 iterminal.sql 初始化过的库执行这个脚本（新装的库不需要，iterminal.sql 已经包含）：
--   mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/iterminal-upgrade-20261020.sql
-- 内容：参数 itm.web.*（联网搜索的格式、地址、加密的 API Key、条数、每人每天次数）。
-- 不执行也可以：管理页面第一次保存联网搜索配置时会自动补上这些参数。
-- 可以重复执行：参数已经存在时不插入（按参数键名判断，不占用固定的主键）
-- ============================================================================

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-启用', 'itm.web.enabled', 'false', 'Y', 'admin', sysdate(), '', null,
       '客户端「联网」默认使用的搜索服务是否启用（true / false）；和团队模型无关，在「大模型 → 联网搜索」里配置'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.enabled');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-接口格式', 'itm.web.format', 'deepseek', 'Y', 'admin', sysdate(), '', null,
       'deepseek（DeepSeek Search / Fetch 接口）或 custom（自定义，DeepSeek 风格，兼容 Kimi 等字段名）'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.format');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-DeepSeek 根地址', 'itm.web.baseUrl', '', 'Y', 'admin', sysdate(), '', null,
       'deepseek 格式的根地址，为空时用 https://api.deepseek.com'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.baseUrl');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-搜索接口', 'itm.web.searchUrl', '', 'Y', 'admin', sysdate(), '', null,
       'custom 格式的搜索接口完整地址，例如 https://api.moonshot.cn/v1/tools/search'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.searchUrl');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-网页读取接口', 'itm.web.fetchUrl', '', 'Y', 'admin', sysdate(), '', null,
       'custom 格式的网页读取接口完整地址；为空时客户端只能搜索'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.fetchUrl');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-API Key（加密）', 'itm.web.apiKey', '', 'Y', 'admin', sysdate(), '', null,
       '搜索服务的 API Key（AES-256-GCM 加密，请在管理页面里修改，不要直接改这里）'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.apiKey');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-每次条数', 'itm.web.count', '8', 'Y', 'admin', sysdate(), '', null,
       '每次搜索返回的结果数（1–20）'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.count');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-显示名称', 'itm.web.label', '', 'Y', 'admin', sysdate(), '', null,
       '客户端显示的搜索服务名称（为空时显示 DeepSeek / 自定义搜索）'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.label');

insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, update_by, update_time, remark)
select 'iTerminal-联网搜索-每人每天次数', 'itm.web.dailyLimit', '500', 'Y', 'admin', sysdate(), '', null,
       '每个用户每天最多搜索 / 读取网页多少次，0 表示不限制'
from dual
where not exists (select 1 from sys_config where config_key = 'itm.web.dailyLimit');
