-- ============================================================================
-- iTerminal 数据库升级：第十三轮（2026-10-17）
-- 已经用 iterminal.sql 初始化过的库执行这个脚本（新装的库不需要，iterminal.sql 已经包含）：
--   mysql -uitm -p --default-character-set=utf8mb4 iterminal < sql/iterminal-upgrade-20261017.sql
-- 内容：团队模型 / 知识库按用户和组织授权、单项分享、问题反馈（表、参数、字典、菜单）
-- 可以重复执行：建表用 if not exists，加列前先检查，种子数据用 insert ignore
-- ============================================================================

-- 1、团队模型、知识库：可用范围增加用户和组织（部门）
drop procedure if exists itm_add_column;
delimiter $$
create procedure itm_add_column(in t varchar(64), in c varchar(64), in ddl varchar(500))
begin
  if not exists (select 1 from information_schema.columns where table_schema = database() and table_name = t and column_name = c) then
    set @s = concat('alter table ', t, ' add column ', ddl);
    prepare stmt from @s;
    execute stmt;
    deallocate prepare stmt;
  end if;
end$$
delimiter ;
call itm_add_column('itm_llm_provider',  'user_ids', "user_ids varchar(2000) default '' comment '可以使用的用户（用户ID，逗号分隔）' after role_keys");
call itm_add_column('itm_llm_provider',  'dept_ids', "dept_ids varchar(1000) default '' comment '可以使用的组织（部门ID，逗号分隔，含下级）' after user_ids");
call itm_add_column('itm_kb_collection', 'user_ids', "user_ids varchar(2000) default '' comment '可以检索的用户（用户ID，逗号分隔）' after role_keys");
call itm_add_column('itm_kb_collection', 'dept_ids', "dept_ids varchar(1000) default '' comment '可以检索的组织（部门ID，逗号分隔，含下级）' after user_ids");
drop procedure if exists itm_add_column;

-- 2、单项分享
create table if not exists itm_share_link (
  link_id             bigint(20)      not null auto_increment    comment '单项分享ID',
  user_id             bigint(20)      not null                   comment '分享者',
  user_name           varchar(30)     default ''                 comment '分享者账号',
  lookup_hash         char(64)        not null                   comment 'SHA-256(lookupToken)',
  title               varchar(100)    default ''                 comment '标题',
  data_groups         varchar(100)    default ''                 comment '包含的分组',
  item_counts         varchar(500)    default '{}'               comment '各类条数（JSON）',
  code_e2e            varchar(500)    default ''                 comment '分享码（CDK 加密托管，可空）',
  e2e_key_version     int(11)         default 0                  comment 'CDK 版本（0 = 没有托管）',
  expires_at          datetime(3)                                comment '过期时间（空 = 永久）',
  max_pulls           int(11)         default 0                  comment '拉取次数上限（0 = 不限）',
  pull_count          int(11)         default 0                  comment '已拉取次数',
  last_pulled_at      datetime(3)                                comment '最近一次被拉取',
  content_path        varchar(300)    default ''                 comment '分享包文件',
  content_size        bigint(20)      default 0                  comment '分享包大小',
  content_sha256      char(64)        default ''                 comment '分享包 SHA-256',
  format_version      int(11)         default 2                  comment '分享包格式版本',
  device_name         varchar(64)     default ''                 comment '来源设备',
  platform            varchar(20)     default ''                 comment '来源平台',
  client_version      varchar(40)     default ''                 comment '客户端版本',
  status              char(1)         default '0'                comment '状态（0有效 1已撤销）',
  created_at          datetime(3)                                comment '创建时间',
  revoked_at          datetime(3)                                comment '撤销时间',
  primary key (link_id),
  unique key uk_itm_share_link_lookup (lookup_hash),
  key idx_itm_share_link_user (user_id, created_at)
) engine=innodb auto_increment=100 comment = '单项分享（选中的主机 / 分组 / 笔记 / 快捷指令）';

-- 3、问题反馈
create table if not exists itm_feedback (
  feedback_id         bigint(20)      not null auto_increment    comment '反馈ID（编号）',
  user_id             bigint(20)                                 comment '提交人（匿名时为空）',
  user_name           varchar(30)     default ''                 comment '提交人账号',
  nick_name           varchar(30)     default ''                 comment '提交人昵称',
  contact             varchar(100)    default ''                 comment '联系方式',
  device_id           varchar(64)     default ''                 comment '设备ID',
  ip                  varchar(64)     default ''                 comment '来源 IP',
  category            varchar(16)     default 'BUG'              comment '类型（BUG / SUGGESTION / QUESTION / OTHER）',
  title               varchar(100)    not null                   comment '标题',
  description         text                                       comment '描述',
  client_version      varchar(40)     default ''                 comment '客户端版本',
  platform            varchar(20)     default ''                 comment '平台',
  os_version          varchar(100)    default ''                 comment '系统版本',
  arch                varchar(20)     default ''                 comment '架构',
  env_json            mediumtext                                 comment '环境信息（JSON）',
  image_count         int(11)         default 0                  comment '图片数',
  has_diag            char(1)         default '0'                comment '带诊断包（0否 1是）',
  status              varchar(16)     default 'NEW'              comment '状态（NEW / PROCESSING / RESOLVED / CLOSED）',
  reply               text                                       comment '回复（提交人可见）',
  handler             varchar(64)     default ''                 comment '处理人',
  handled_at          datetime                                   comment '处理时间',
  ai_analysis         mediumtext                                 comment 'AI 分析结果（Markdown）',
  ai_model            varchar(150)    default ''                 comment 'AI 分析用的模型',
  ai_analyzed_at      datetime                                   comment 'AI 分析时间',
  create_time         datetime                                   comment '提交时间',
  update_time         datetime                                   comment '更新时间',
  primary key (feedback_id),
  key idx_itm_feedback_time (create_time),
  key idx_itm_feedback_user (user_id, create_time)
) engine=innodb auto_increment=1000 comment = '问题反馈';

create table if not exists itm_feedback_file (
  file_id             bigint(20)      not null auto_increment    comment '附件ID',
  feedback_id         bigint(20)      not null                   comment '反馈ID',
  kind                varchar(16)     not null                   comment '类型（IMAGE / DIAG_JSON / DIAG_MD）',
  file_name           varchar(200)    default ''                 comment '原文件名',
  content_type        varchar(100)    default ''                 comment 'MIME 类型',
  size                bigint(20)      default 0                  comment '大小（字节）',
  sha256              char(64)        default ''                 comment 'SHA-256',
  file_path           varchar(300)    default ''                 comment '文件路径（上传目录下，不能直接访问）',
  create_time         datetime                                   comment '上传时间',
  primary key (file_id),
  key idx_itm_feedback_file (feedback_id)
) engine=innodb comment = '问题反馈附件';


-- 4、字典、参数、菜单
insert ignore into sys_dict_type values(110, '反馈类型',     'itm_feedback_category', '0', 'admin', sysdate(), '', null, '问题反馈的类型');
insert ignore into sys_dict_type values(111, '反馈状态',     'itm_feedback_status',   '0', 'admin', sysdate(), '', null, '问题反馈的处理状态');
insert ignore into sys_dict_data values(1086, 7, '新的问题反馈', 'FEEDBACK_NEW',   'itm_notify_event', '', 'primary', 'N', '0', 'admin', sysdate(), '', null, '用户在客户端提交了问题反馈');
insert ignore into sys_dict_data values(1100, 1, '问题',     'BUG',          'itm_feedback_category', '', 'danger',  'Y', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_dict_data values(1101, 2, '建议',     'SUGGESTION',   'itm_feedback_category', '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_dict_data values(1102, 3, '咨询',     'QUESTION',     'itm_feedback_category', '', 'primary', 'N', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_dict_data values(1103, 4, '其他',     'OTHER',        'itm_feedback_category', '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_dict_data values(1110, 1, '新建',     'NEW',          'itm_feedback_status',   '', 'danger',  'Y', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_dict_data values(1111, 2, '处理中',   'PROCESSING',   'itm_feedback_status',   '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_dict_data values(1112, 3, '已解决',   'RESOLVED',     'itm_feedback_status',   '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_dict_data values(1113, 4, '已关闭',   'CLOSED',       'itm_feedback_status',   '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert ignore into sys_config values(117, 'iTerminal-接受匿名反馈',         'itm.feedback.allowAnonymous', 'true', 'Y', 'admin', sysdate(), '', null, '是否接受本地模式（未登录）客户端提交的匿名问题反馈（true / false）');
insert ignore into sys_config values(118, 'iTerminal-问题反馈保留天数',     'itm.feedback.retentionDays',  '365',  'Y', 'admin', sysdate(), '', null, '问题反馈和附件（截图、诊断包）保留多少天（每天 03:30 清理）');
insert ignore into sys_config values(119, 'iTerminal-反馈 AI 分析提供商',   'itm.feedback.aiProviderId',   '',     'Y', 'admin', sysdate(), '', null, 'AI 分析问题反馈默认用的团队模型提供商 ID（为空时用第一个启用的团队模型）');
insert ignore into sys_config values(120, 'iTerminal-反馈 AI 分析模型',     'itm.feedback.aiModel',        '',     'Y', 'admin', sysdate(), '', null, 'AI 分析问题反馈默认用的模型 ID（为空时用提供商的第一个模型）');
insert ignore into sys_menu values('3014', '问题反馈', '3000', '14', 'feedback', 'iterminal/feedback/index',  '', '', 1, 0, 'C', '0', '0', 'itm:feedback:list', 'message',   'admin', sysdate(), '', null, '客户端提交的问题反馈：截图、操作轨迹、日志、AI 分析');
insert ignore into sys_menu values('3220', '反馈查看', '3014', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:query',   '#', 'admin', sysdate(), '', null, '');
insert ignore into sys_menu values('3221', '反馈处理', '3014', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:edit',    '#', 'admin', sysdate(), '', null, '');
insert ignore into sys_menu values('3222', '反馈删除', '3014', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:remove',  '#', 'admin', sysdate(), '', null, '');
insert ignore into sys_menu values('3223', 'AI 分析',  '3014', '4', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:analyze', '#', 'admin', sysdate(), '', null, '');
