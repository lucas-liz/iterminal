-- ============================================================================
-- iTerminal 业务表、管理后台菜单、字典和配置（在若依基础库 ry_20260417.sql、quartz.sql 之后执行）
-- 表名统一 itm_ 前缀；时间用 datetime（服务器时区 GMT+8，与若依一致）
-- ============================================================================

-- ----------------------------
-- 1、设备（桌面客户端登录后注册）
-- ----------------------------
drop table if exists itm_device;
create table itm_device (
  device_id           varchar(64)     not null                   comment '设备ID（客户端生成的 UUID）',
  user_id             bigint(20)      not null                   comment '用户ID',
  user_name           varchar(30)     default ''                 comment '用户账号',
  device_name         varchar(100)    default ''                 comment '设备名称（主机名）',
  os                  varchar(20)     default ''                 comment '系统（mac / win / linux）',
  arch                varchar(20)     default ''                 comment '架构（x64 / arm64）',
  client_version      varchar(40)     default ''                 comment '客户端版本',
  refresh_token_hash  char(64)        default null               comment '刷新令牌的 SHA-256（明文只返回给客户端一次）',
  refresh_expires_at  datetime                                   comment '刷新令牌过期时间',
  status              char(1)         default '0'                comment '状态（0正常 1已吊销）',
  online              char(1)         default '0'                comment '是否在线（WebSocket 已连接）',
  last_ip             varchar(128)    default ''                 comment '最后登录 IP',
  last_seen_at        datetime                                   comment '最后活跃时间',
  create_time         datetime                                   comment '首次登录时间',
  update_time         datetime                                   comment '更新时间',
  primary key (device_id),
  key idx_itm_device_user (user_id)
) engine=innodb comment = '客户端设备';

-- ----------------------------
-- 2、命令审计和安全事件（客户端每 5 秒批量上报）
-- ----------------------------
drop table if exists itm_audit_command;
create table itm_audit_command (
  audit_id            bigint(20)      not null auto_increment    comment '主键',
  client_event_id     varchar(64)     not null                   comment '客户端事件ID（同一设备去重）',
  device_id           varchar(64)     not null                   comment '设备ID',
  user_id             bigint(20)      default null               comment '用户ID',
  user_name           varchar(30)     default ''                 comment '用户账号',
  kind                varchar(16)     default 'COMMAND'          comment '类型（COMMAND 命令 / EVENT 安全事件）',
  source              varchar(20)     default ''                 comment '来源（USER / AGENT / SKILL / SCHEDULE / MCP_EXTERNAL）',
  event_type          varchar(64)     default null               comment '事件类型（EVENT）',
  host_id             varchar(64)     default null               comment '主机ID（客户端）',
  host_name           varchar(200)    default null               comment '主机名称',
  session_id          varchar(64)     default null               comment '终端会话ID',
  command             text                                       comment '命令（已脱敏）',
  risk                varchar(10)     default null               comment '风险等级（L0 / L1 / L2 / DENY）',
  decision            varchar(16)     default null               comment '处理结果（AUTO / APPROVED / REJECTED / DENIED）',
  exit_code           int(11)         default null               comment '退出码',
  detail              text                                       comment '详情（JSON）',
  occurred_at         datetime(3)                                comment '发生时间',
  create_time         datetime                                   comment '上报时间',
  primary key (audit_id),
  unique key uk_itm_audit_event (device_id, client_event_id),
  key idx_itm_audit_time (occurred_at),
  key idx_itm_audit_user (user_id, occurred_at)
) engine=innodb comment = '命令审计';

-- ----------------------------
-- 3、会话录像（asciicast v2，按分片上传，文件保存在上传目录）
-- ----------------------------
drop table if exists itm_audit_session;
create table itm_audit_session (
  recording_id        varchar(64)     not null                   comment '录像ID（客户端）',
  device_id           varchar(64)     not null                   comment '设备ID',
  user_id             bigint(20)      default null               comment '用户ID',
  user_name           varchar(30)     default ''                 comment '用户账号',
  session_id          varchar(64)     default null               comment '终端会话ID',
  kind                varchar(16)     default ''                 comment '会话类型（ssh / telnet / serial / local）',
  host_id             varchar(64)     default null               comment '主机ID',
  host_name           varchar(200)    default null               comment '主机名称',
  cols                int(11)         default 80                 comment '列数',
  rows_count          int(11)         default 24                 comment '行数',
  started_at          datetime(3)                                comment '开始时间',
  ended_at            datetime(3)                                comment '结束时间',
  chunks              int(11)         default 0                  comment '已收到的分片数',
  bytes               bigint(20)      default 0                  comment '大小（字节）',
  complete            char(1)         default '0'                comment '是否上传完成（0否 1是）',
  file_path           varchar(500)    default ''                 comment '文件路径（相对上传目录）',
  create_time         datetime                                   comment '创建时间',
  update_time         datetime                                   comment '更新时间',
  primary key (recording_id),
  key idx_itm_session_time (started_at)
) engine=innodb comment = '会话录像';

-- ----------------------------
-- 4、定时任务（服务端按 cron 派发到指定设备执行）
-- ----------------------------
drop table if exists itm_sched_task;
create table itm_sched_task (
  task_id             bigint(20)      not null auto_increment    comment '任务ID',
  task_name           varchar(100)    not null                   comment '任务名称',
  task_type           varchar(20)     default 'COMMAND'          comment '类型（COMMAND 命令 / SKILL / AGENT_PROMPT AI 任务）',
  command             text                                       comment '命令（COMMAND）',
  prompt              text                                       comment '任务描述（AGENT_PROMPT）',
  skill               varchar(100)    default null               comment 'Skill 名称（SKILL）',
  params              varchar(2000)   default null               comment 'Skill 参数（JSON）',
  device_id           varchar(64)     not null                   comment '执行设备',
  hosts               varchar(2000)   not null                   comment '目标主机（设备上的主机名称或ID，每行一个）',
  cron_expression     varchar(100)    not null                   comment 'cron 表达式（Spring 6 段：秒 分 时 日 月 周）',
  permission_cap      varchar(16)     default 'READONLY'         comment '权限上限（READONLY / APPROVE / AUTO）',
  timeout_min         int(11)         default 30                 comment '超时（分钟）',
  status              char(1)         default '1'                comment '状态（0正常 1暂停）',
  last_run_at         datetime                                   comment '上次执行时间',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  remark              varchar(500)    default ''                 comment '备注',
  primary key (task_id)
) engine=innodb auto_increment=100 comment = '定时任务';

drop table if exists itm_sched_run;
create table itm_sched_run (
  run_id              varchar(64)     not null                   comment '执行ID',
  task_id             bigint(20)      not null                   comment '任务ID',
  task_name           varchar(100)    default ''                 comment '任务名称',
  task_type           varchar(20)     default ''                 comment '类型',
  device_id           varchar(64)     default ''                 comment '执行设备',
  trigger_type        varchar(10)     default 'CRON'             comment '触发方式（CRON 定时 / MANUAL 手动）',
  status              varchar(16)     default 'DISPATCHED'       comment '状态（DISPATCHED / RUNNING / SUCCESS / PARTIAL / FAILED / TIMEOUT / OFFLINE）',
  percent             int(11)         default 0                  comment '进度（%）',
  summary             text                                       comment '结果摘要',
  hosts               mediumtext                                 comment '每台主机的结果（JSON）',
  started_at          datetime                                   comment '开始时间',
  ended_at            datetime                                   comment '结束时间',
  primary key (run_id),
  key idx_itm_run_task (task_id, started_at),
  key idx_itm_run_time (started_at)
) engine=innodb comment = '定时任务执行记录';

-- ----------------------------
-- 5、远程审批（执行器遇到超出权限上限的写操作时创建，审批人在客户端或管理后台处理）
-- ----------------------------
drop table if exists itm_approval;
create table itm_approval (
  approval_id         varchar(64)     not null                   comment '审批ID',
  run_id              varchar(64)     not null                   comment '执行ID',
  task_id             bigint(20)      default null               comment '任务ID',
  task_name           varchar(100)    default ''                 comment '任务名称',
  device_id           varchar(64)     not null                   comment '执行设备',
  host_id             varchar(200)    default ''                 comment '主机',
  host_name           varchar(200)    default ''                 comment '主机名称',
  command             text                                       comment '命令',
  risk                varchar(10)     default 'L1'               comment '风险等级',
  reasons             varchar(2000)   default null               comment '判定原因（JSON 数组）',
  explanation         varchar(1000)   default null               comment '命令作用说明',
  status              varchar(16)     default 'PENDING'          comment '状态（PENDING 待审批 / APPROVED / REJECTED / EXPIRED）',
  decided_by          varchar(64)     default ''                 comment '审批人',
  decide_comment      varchar(500)    default ''                 comment '审批意见',
  expires_at          datetime                                   comment '过期时间',
  decided_at          datetime                                   comment '审批时间',
  create_time         datetime                                   comment '创建时间',
  primary key (approval_id),
  key idx_itm_approval_status (status, create_time)
) engine=innodb comment = '远程审批';

-- ----------------------------
-- 6、客户端版本发布（electron-updater 的 generic 更新源）
-- ----------------------------
drop table if exists itm_release;
create table itm_release (
  release_id          bigint(20)      not null auto_increment    comment '主键',
  version             varchar(40)     not null                   comment '版本号',
  channel             varchar(10)     default 'stable'           comment '渠道（stable 正式 / beta 测试）',
  os                  varchar(10)     not null                   comment '系统（mac / win / linux）',
  arch                varchar(10)     not null                   comment '架构（x64 / arm64）',
  file_name           varchar(255)    not null                   comment '安装包文件名',
  file_path           varchar(500)    not null                   comment '文件路径（相对上传目录）',
  file_size           bigint(20)      default 0                  comment '大小（字节）',
  sha512              varchar(100)    default ''                 comment 'SHA-512（base64）',
  rollout_percent     int(11)         default 100                comment '灰度比例（1-100）',
  min_version         varchar(40)     default ''                 comment '最低版本（低于它强制升级）',
  release_notes       text                                       comment '更新说明',
  status              char(1)         default '0'                comment '状态（0已发布 1已下架）',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '发布时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  primary key (release_id),
  key idx_itm_release (channel, os, arch, status)
) engine=innodb comment = '客户端版本';

-- ----------------------------
-- 7、AI 命令规则、脱敏规则（下发给客户端的审批引擎和脱敏器）
-- ----------------------------
drop table if exists itm_command_rule;
create table itm_command_rule (
  rule_id             bigint(20)      not null auto_increment    comment '规则ID',
  rule_name           varchar(100)    not null                   comment '规则名称',
  match_type          varchar(10)     default 'PREFIX'           comment '匹配方式（PREFIX 前缀 / REGEX 正则 / EXACT 完全一致）',
  pattern             varchar(500)    not null                   comment '匹配内容',
  level               varchar(10)     default 'L1'               comment '等级（L0 只读 / L1 写操作 / L2 高危 / DENY 禁止）',
  reason              varchar(200)    default ''                 comment '判定说明',
  priority            int(11)         default 100                comment '优先级（越小越先匹配）',
  status              char(1)         default '0'                comment '状态（0启用 1停用）',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  primary key (rule_id)
) engine=innodb comment = 'AI 命令规则';

drop table if exists itm_mask_rule;
create table itm_mask_rule (
  rule_id             bigint(20)      not null auto_increment    comment '规则ID',
  rule_name           varchar(100)    not null                   comment '规则名称',
  pattern             varchar(500)    not null                   comment '正则表达式',
  replacement         varchar(100)    default '****'             comment '替换为',
  force_private       char(1)         default '0'                comment '命中后必须用内网模型（0否 1是）',
  status              char(1)         default '0'                comment '状态（0启用 1停用）',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  primary key (rule_id)
) engine=innodb comment = 'AI 脱敏规则';

-- 示例规则
insert into itm_command_rule values(1, '查看日志', 'PREFIX', 'journalctl', 'L0', '只读查看系统日志', 100, '0', 'admin', sysdate(), '', null);
insert into itm_command_rule values(2, '重启服务', 'REGEX', '^systemctl\\s+(restart|reload)\\b', 'L1', '重启 / 重载服务', 100, '0', 'admin', sysdate(), '', null);
insert into itm_command_rule values(3, '格式化磁盘', 'PREFIX', 'mkfs', 'DENY', '格式化磁盘，禁止 AI 执行', 10, '0', 'admin', sysdate(), '', null);
insert into itm_mask_rule values(1, '内部工号', '\\bEMP\\d{6}\\b', '[工号]', '0', '0', 'admin', sysdate(), '', null);
insert into itm_mask_rule values(2, '客户合同号', '\\bHT-\\d{4}-\\d{6}\\b', '[合同号]', '1', '0', 'admin', sysdate(), '', null);

-- ----------------------------
-- 7.1、通知渠道（钉钉 / 企业微信 / 飞书机器人、邮件、通用 Webhook）和发送记录
-- ----------------------------
drop table if exists itm_notify_channel;
create table itm_notify_channel (
  channel_id          bigint(20)      not null auto_increment    comment '渠道ID',
  channel_name        varchar(100)    not null                   comment '渠道名称',
  channel_type        varchar(16)     not null                   comment '类型（DINGTALK / WECOM / FEISHU / EMAIL / WEBHOOK）',
  webhook             varchar(500)    default ''                 comment '机器人或 Webhook 地址',
  secret              varchar(200)    default ''                 comment '加签密钥（钉钉、飞书、通用 Webhook）',
  recipients          varchar(1000)   default ''                 comment '邮件收件人（逗号分隔）',
  mention             varchar(500)    default ''                 comment '@ 的手机号（逗号分隔，all 表示所有人）',
  events              varchar(500)    not null                   comment '订阅的事件（逗号分隔）',
  status              char(1)         default '0'                comment '状态（0启用 1停用）',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  remark              varchar(500)    default ''                 comment '备注',
  primary key (channel_id)
) engine=innodb auto_increment=100 comment = '通知渠道';

drop table if exists itm_notify_log;
create table itm_notify_log (
  log_id              bigint(20)      not null auto_increment    comment '记录ID',
  channel_id          bigint(20)      not null                   comment '渠道ID',
  channel_name        varchar(100)    default ''                 comment '渠道名称',
  channel_type        varchar(16)     default ''                 comment '渠道类型',
  event               varchar(40)     default ''                 comment '事件',
  title               varchar(200)    default ''                 comment '标题',
  content             varchar(4000)   default ''                 comment '内容（Markdown）',
  status              char(1)         default '0'                comment '结果（0成功 1失败）',
  error               varchar(500)    default ''                 comment '失败原因',
  sent_at             datetime(3)                                comment '发送时间',
  primary key (log_id),
  key idx_itm_notify_log_time (sent_at)
) engine=innodb comment = '通知发送记录';

-- ----------------------------
-- 7.2、团队模型（大模型代理：客户端用登录令牌调用，服务端注入真实的 API Key 后转发）和用量
-- ----------------------------
drop table if exists itm_llm_provider;
create table itm_llm_provider (
  provider_id         bigint(20)      not null auto_increment    comment '提供商ID',
  provider_name       varchar(100)    not null                   comment '名称（客户端显示）',
  provider_type       varchar(16)     not null                   comment '协议（ANTHROPIC / OPENAI / OPENAI_COMPAT）',
  base_url            varchar(500)    not null                   comment '接口地址',
  api_key_enc         varchar(2000)   default ''                 comment 'API Key（AES-256-GCM 加密）',
  models              text                                       comment '模型列表（JSON）',
  thinking_style      varchar(20)     default 'none'             comment '深度思考参数的发送方式',
  echo_reasoning      char(1)         default '0'                comment '工具调用时回传 reasoning_content（0否 1是）',
  role_keys           varchar(500)    default ''                 comment '可以使用的角色（权限字符，逗号分隔）',
  user_ids            varchar(2000)   default ''                 comment '可以使用的用户（用户ID，逗号分隔）',
  dept_ids            varchar(1000)   default ''                 comment '可以使用的组织（部门ID，逗号分隔，含下级；角色 / 用户 / 组织都为空表示所有人）',
  sort                int(11)         default 0                  comment '显示顺序',
  status              char(1)         default '0'                comment '状态（0启用 1停用）',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  remark              varchar(500)    default ''                 comment '备注',
  primary key (provider_id)
) engine=innodb auto_increment=100 comment = '团队模型提供商';

drop table if exists itm_llm_usage;
create table itm_llm_usage (
  usage_id            bigint(20)      not null auto_increment    comment '记录ID',
  user_id             bigint(20)      not null                   comment '用户ID',
  user_name           varchar(30)     default ''                 comment '用户账号',
  device_id           varchar(64)     default ''                 comment '设备ID',
  provider_id         bigint(20)      not null                   comment '提供商ID',
  provider_name       varchar(100)    default ''                 comment '提供商名称',
  model               varchar(100)    default ''                 comment '模型',
  input_tokens        int(11)         default 0                  comment '输入 token',
  output_tokens       int(11)         default 0                  comment '输出 token',
  estimated           char(1)         default '0'                comment '用量是估算的（上游没有返回用量）',
  status              char(1)         default '0'                comment '结果（0成功 1失败）',
  error               varchar(500)    default ''                 comment '失败原因',
  duration_ms         int(11)         default 0                  comment '耗时（毫秒）',
  created_at          datetime(3)                                comment '时间',
  primary key (usage_id),
  key idx_itm_llm_usage_time (created_at),
  key idx_itm_llm_usage_user (user_id, created_at)
) engine=innodb comment = '团队模型用量';

-- ----------------------------
-- 7.3、团队主机（管理员维护，登录后同步到客户端的「团队主机」分组，只读）
-- ----------------------------
drop table if exists itm_team_folder;
create table itm_team_folder (
  folder_id           bigint(20)      not null auto_increment    comment '分组ID',
  parent_id           bigint(20)      default 0                  comment '上级分组（0 表示顶层）',
  folder_name         varchar(100)    not null                   comment '分组名称',
  role_keys           varchar(500)    default ''                 comment '可见的角色（逗号分隔；为空时继承上级，顶层为空表示所有人）',
  sort                int(11)         default 0                  comment '显示顺序',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  primary key (folder_id)
) engine=innodb auto_increment=100 comment = '团队主机分组';

drop table if exists itm_team_host;
create table itm_team_host (
  host_id             bigint(20)      not null auto_increment    comment '主机ID',
  folder_id           bigint(20)      default 0                  comment '分组ID（0 表示顶层）',
  host_name           varchar(100)    not null                   comment '名称',
  protocol            varchar(10)     default 'SSH'              comment '协议（SSH / TELNET）',
  address             varchar(255)    not null                   comment '地址',
  port                int(11)         default 22                 comment '端口',
  username            varchar(100)    default ''                 comment '登录用户名',
  auth_method         varchar(16)     default 'PASSWORD'         comment '认证方式（PASSWORD / KEY / INTERACTIVE）',
  password_enc        varchar(2000)   default ''                 comment '密码（AES-256-GCM 加密）',
  private_key_enc     text                                       comment '私钥（加密）',
  passphrase_enc      varchar(2000)   default ''                 comment '私钥口令（加密）',
  allow_reveal        char(1)         default '0'                comment '允许客户端查看 / 复制密码（0否 1是）',
  role_keys           varchar(500)    default ''                 comment '可见的角色（为空时按分组）',
  note                varchar(1000)   default ''                 comment '备注（客户端显示）',
  sort                int(11)         default 0                  comment '显示顺序',
  status              char(1)         default '0'                comment '状态（0启用 1停用）',
  version             int(11)         default 1                  comment '版本（每次修改加 1，客户端据此判断是否需要更新）',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  primary key (host_id),
  key idx_itm_team_host_folder (folder_id)
) engine=innodb auto_increment=100 comment = '团队主机';

-- ----------------------------
-- 7.4、云备份、个人分享码（端到端加密：服务端只保存密文，见文档一 6.10、文档二 5.3.3 / 5.13 / 5.14）
-- ----------------------------
drop table if exists itm_sync_e2e_key;
create table itm_sync_e2e_key (
  user_id             bigint(20)      not null                   comment '用户ID',
  wrapped_cdk         varchar(500)    not null                   comment '同步密码包装的 CDK（base64）',
  recovery_wrapped_cdk varchar(500)   not null                   comment '恢复码包装的 CDK（base64）',
  kdf                 varchar(500)    not null                   comment 'Argon2id 参数（JSON）',
  key_version         int(11)         default 1                  comment 'CDK 版本（轮换时加 1）',
  updated_at          datetime(3)                                comment '更新时间',
  primary key (user_id)
) engine=innodb comment = '端到端加密密钥托管';

drop table if exists itm_sync_backup;
create table itm_sync_backup (
  backup_id           bigint(20)      not null auto_increment    comment '备份ID',
  user_id             bigint(20)      not null                   comment '用户ID',
  user_name           varchar(30)     default ''                 comment '用户账号',
  format_version      int(11)         default 2                  comment '备份包格式版本',
  device_name         varchar(64)     default ''                 comment '来源设备',
  platform            varchar(20)     default ''                 comment '平台（macos / windows / linux）',
  client_version      varchar(40)     default ''                 comment '客户端版本',
  data_groups         varchar(100)    default ''                 comment '包含的分组',
  item_counts         varchar(500)    default '{}'               comment '各类条数（JSON）',
  key_version         int(11)         default 1                  comment 'CDK 版本',
  size                bigint(20)      default 0                  comment '大小（字节）',
  sha256              char(64)        default ''                 comment 'SHA-256',
  file_path           varchar(300)    default ''                 comment '文件路径',
  remark              varchar(200)    default ''                 comment '备注',
  pinned              char(1)         default '0'                comment '置顶（0否 1是）',
  created_at          datetime(3)                                comment '上传时间',
  primary key (backup_id),
  key idx_itm_backup_user (user_id, created_at)
) engine=innodb comment = '云备份';

drop table if exists itm_sync_share;
create table itm_sync_share (
  user_id             bigint(20)      not null                   comment '分享者',
  user_name           varchar(30)     default ''                 comment '分享者账号',
  lookup_hash         char(64)        not null                   comment 'SHA-256(lookupToken)',
  code_e2e            varchar(500)    default ''                 comment '分享码（CDK 加密托管）',
  e2e_key_version     int(11)         default 1                  comment 'CDK 版本',
  data_groups         varchar(100)    default ''                 comment '允许分享的分组',
  enabled             char(1)         default '1'                comment '是否开启（1开启 0暂停）',
  content_path        varchar(300)    default ''                 comment '分享包文件',
  content_groups      varchar(100)    default ''                 comment '分享包实际包含的分组',
  content_counts      varchar(500)    default ''                 comment '分享包条数（JSON）',
  content_size        bigint(20)      default 0                  comment '分享包大小',
  content_sha256      char(64)        default ''                 comment '分享包 SHA-256',
  content_format_version int(11)      default 0                  comment '分享包格式版本',
  content_device      varchar(64)     default ''                 comment '来源设备',
  content_platform    varchar(20)     default ''                 comment '来源平台',
  content_client_version varchar(40)  default ''                 comment '客户端版本',
  content_updated_at  datetime(3)                                comment '分享包更新时间',
  pull_count          int(11)         default 0                  comment '被拉取次数',
  last_pulled_at      datetime(3)                                comment '最近一次被拉取',
  created_at          datetime(3)                                comment '开启时间',
  updated_at          datetime(3)                                comment '更新时间',
  primary key (user_id),
  unique key uk_itm_share_lookup (lookup_hash)
) engine=innodb comment = '个人分享码';

drop table if exists itm_share_link;
create table itm_share_link (
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

-- ----------------------------
-- 7.5、知识库（文档二 5.8 简化版：MySQL 全文检索 + 可选的向量检索，Agent 用 kb_search 引用）
-- ----------------------------
drop table if exists itm_kb_collection;
create table itm_kb_collection (
  collection_id       bigint(20)      not null auto_increment    comment '知识库ID',
  collection_name     varchar(100)    not null                   comment '名称',
  description         varchar(500)    default ''                 comment '说明（Agent 选择知识库时参考）',
  role_keys           varchar(500)    default ''                 comment '可以检索的角色（逗号分隔）',
  user_ids            varchar(2000)   default ''                 comment '可以检索的用户（用户ID，逗号分隔）',
  dept_ids            varchar(1000)   default ''                 comment '可以检索的组织（部门ID，逗号分隔，含下级；角色 / 用户 / 组织都为空表示所有人）',
  status              char(1)         default '0'                comment '状态（0启用 1停用）',
  create_by           varchar(64)     default ''                 comment '创建者',
  create_time         datetime                                   comment '创建时间',
  update_by           varchar(64)     default ''                 comment '更新者',
  update_time         datetime                                   comment '更新时间',
  primary key (collection_id)
) engine=innodb auto_increment=100 comment = '知识库';

drop table if exists itm_kb_document;
create table itm_kb_document (
  document_id         bigint(20)      not null auto_increment    comment '文档ID',
  collection_id       bigint(20)      not null                   comment '知识库ID',
  title               varchar(200)    not null                   comment '标题',
  file_name           varchar(255)    default ''                 comment '原文件名',
  file_type           varchar(20)     default ''                 comment '类型（md / txt / html / pdf / docx）',
  file_size           bigint(20)      default 0                  comment '大小',
  file_path           varchar(300)    default ''                 comment '原件路径',
  status              varchar(16)     default 'PENDING'          comment '状态（PENDING 等待 / INDEXING 处理中 / INDEXED 完成 / FAILED 失败）',
  error               varchar(500)    default ''                 comment '失败原因',
  chunk_count         int(11)         default 0                  comment '片段数',
  embedded            char(1)         default '0'                comment '是否生成了向量（0否 1是）',
  create_by           varchar(64)     default ''                 comment '上传者',
  create_time         datetime                                   comment '上传时间',
  update_time         datetime                                   comment '更新时间',
  primary key (document_id),
  key idx_itm_kb_doc_collection (collection_id)
) engine=innodb auto_increment=100 comment = '知识库文档';

drop table if exists itm_kb_chunk;
create table itm_kb_chunk (
  chunk_id            bigint(20)      not null auto_increment    comment '片段ID',
  document_id         bigint(20)      not null                   comment '文档ID',
  collection_id       bigint(20)      not null                   comment '知识库ID',
  seq                 int(11)         default 0                  comment '在文档里的顺序',
  heading             varchar(300)    default ''                 comment '所在章节（标题路径）',
  content             text            not null                   comment '内容',
  embedding           mediumblob                                 comment '向量（float32 小端）',
  primary key (chunk_id),
  key idx_itm_kb_chunk_doc (document_id),
  key idx_itm_kb_chunk_collection (collection_id),
  fulltext key ft_itm_kb_chunk (heading, content) with parser ngram
) engine=innodb comment = '知识库片段';

-- ----------------------------
-- 7.6、问题反馈（客户端提交：描述、截图、诊断包；管理后台查看、回复、AI 分析，见文档二 5.15）
-- ----------------------------
drop table if exists itm_feedback;
create table itm_feedback (
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

drop table if exists itm_feedback_file;
create table itm_feedback_file (
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

-- ----------------------------
-- 8、字典
-- ----------------------------
insert into sys_dict_type values(100, '设备状态',     'itm_device_status',   '0', 'admin', sysdate(), '', null, 'iTerminal 设备状态');
insert into sys_dict_type values(101, '风险等级',     'itm_risk_level',      '0', 'admin', sysdate(), '', null, '命令风险等级');
insert into sys_dict_type values(102, '执行状态',     'itm_run_status',      '0', 'admin', sysdate(), '', null, '定时任务执行状态');
insert into sys_dict_type values(103, '审批状态',     'itm_approval_status', '0', 'admin', sysdate(), '', null, '远程审批状态');
insert into sys_dict_type values(104, '任务类型',     'itm_task_type',       '0', 'admin', sysdate(), '', null, '定时任务类型');
insert into sys_dict_type values(105, '发布渠道',     'itm_release_channel', '0', 'admin', sysdate(), '', null, '客户端发布渠道');
insert into sys_dict_type values(106, '审计来源',     'itm_audit_source',    '0', 'admin', sysdate(), '', null, '命令来源');
insert into sys_dict_type values(107, '通知渠道类型', 'itm_notify_type',     '0', 'admin', sysdate(), '', null, '通知渠道类型');
insert into sys_dict_type values(109, '模型协议',     'itm_llm_type',        '0', 'admin', sysdate(), '', null, '团队模型的接口协议');
insert into sys_dict_type values(108, '通知事件',     'itm_notify_event',    '0', 'admin', sysdate(), '', null, '可以订阅的通知事件');

insert into sys_dict_data values(1000, 1, '正常',     '0',            'itm_device_status',   '', 'success', 'Y', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1001, 2, '已吊销',   '1',            'itm_device_status',   '', 'danger',  'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1010, 1, '只读',     'L0',           'itm_risk_level',      '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1011, 2, '写操作',   'L1',           'itm_risk_level',      '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1012, 3, '高危',     'L2',           'itm_risk_level',      '', 'danger',  'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1013, 4, '禁止',     'DENY',         'itm_risk_level',      '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1020, 1, '已派发',   'DISPATCHED',   'itm_run_status',      '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1021, 2, '执行中',   'RUNNING',      'itm_run_status',      '', 'primary', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1022, 3, '成功',     'SUCCESS',      'itm_run_status',      '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1023, 4, '部分成功', 'PARTIAL',      'itm_run_status',      '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1024, 5, '失败',     'FAILED',       'itm_run_status',      '', 'danger',  'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1025, 6, '超时',     'TIMEOUT',      'itm_run_status',      '', 'danger',  'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1026, 7, '设备离线', 'OFFLINE',      'itm_run_status',      '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1030, 1, '待审批',   'PENDING',      'itm_approval_status', '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1031, 2, '已批准',   'APPROVED',     'itm_approval_status', '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1032, 3, '已拒绝',   'REJECTED',     'itm_approval_status', '', 'danger',  'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1033, 4, '已过期',   'EXPIRED',      'itm_approval_status', '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1040, 1, '命令',     'COMMAND',      'itm_task_type',       '', 'primary', 'Y', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1041, 2, 'Skill',    'SKILL',        'itm_task_type',       '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1042, 3, 'AI 任务',  'AGENT_PROMPT', 'itm_task_type',       '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1050, 1, '正式版',   'stable',       'itm_release_channel', '', 'success', 'Y', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1051, 2, '测试版',   'beta',         'itm_release_channel', '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1060, 1, '手动',     'USER',         'itm_audit_source',    '', 'default', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1061, 2, 'Agent',    'AGENT',        'itm_audit_source',    '', 'primary', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1062, 3, 'Skill',    'SKILL',        'itm_audit_source',    '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1063, 4, '定时任务', 'SCHEDULE',     'itm_audit_source',    '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1070, 1, '钉钉机器人', 'DINGTALK',      'itm_notify_type',     '', 'primary', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1071, 2, '企业微信机器人', 'WECOM',     'itm_notify_type',     '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1072, 3, '飞书机器人', 'FEISHU',        'itm_notify_type',     '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1073, 4, '邮件',       'EMAIL',         'itm_notify_type',     '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1074, 5, 'Webhook',    'WEBHOOK',       'itm_notify_type',     '', 'default', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1080, 1, '任务失败',   'TASK_FAILED',   'itm_notify_event',    '', 'danger',  'N', '0', 'admin', sysdate(), '', null, '定时任务执行失败、部分成功或超时');
insert into sys_dict_data values(1081, 2, '设备离线',   'TASK_OFFLINE',  'itm_notify_event',    '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '执行设备离线，任务没有派发');
insert into sys_dict_data values(1082, 3, '任务成功',   'TASK_SUCCESS',  'itm_notify_event',    '', 'success', 'N', '0', 'admin', sysdate(), '', null, '定时任务全部成功');
insert into sys_dict_data values(1083, 4, '等待审批',   'APPROVAL_REQUEST', 'itm_notify_event', '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '无人值守任务有命令等待审批');
insert into sys_dict_data values(1084, 5, '审批过期',   'APPROVAL_EXPIRED', 'itm_notify_event', '', 'info',    'N', '0', 'admin', sysdate(), '', null, '审批到期没人处理');
insert into sys_dict_data values(1085, 6, '高危命令',   'AUDIT_HIGH_RISK',  'itm_notify_event', '', 'danger',  'N', '0', 'admin', sysdate(), '', null, '命令审计里出现高危或被禁止的命令');
insert into sys_dict_data values(1090, 1, 'Anthropic',          'ANTHROPIC',     'itm_llm_type', '', 'primary', 'N', '0', 'admin', sysdate(), '', null, 'Anthropic Messages API');
insert into sys_dict_data values(1091, 2, 'OpenAI',             'OPENAI',        'itm_llm_type', '', 'success', 'N', '0', 'admin', sysdate(), '', null, 'OpenAI Chat Completions');
insert into sys_dict_data values(1092, 3, 'OpenAI 兼容',        'OPENAI_COMPAT', 'itm_llm_type', '', 'info',    'N', '0', 'admin', sysdate(), '', null, 'DeepSeek、通义千问、智谱、Kimi、Ollama、vLLM 等');
insert into sys_dict_data values(1064, 5, '外部 MCP', 'MCP_EXTERNAL', 'itm_audit_source',    '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_type values(110, '反馈类型',     'itm_feedback_category', '0', 'admin', sysdate(), '', null, '问题反馈的类型');
insert into sys_dict_type values(111, '反馈状态',     'itm_feedback_status',   '0', 'admin', sysdate(), '', null, '问题反馈的处理状态');
insert into sys_dict_data values(1086, 7, '新的问题反馈', 'FEEDBACK_NEW',   'itm_notify_event', '', 'primary', 'N', '0', 'admin', sysdate(), '', null, '用户在客户端提交了问题反馈');
insert into sys_dict_data values(1100, 1, '问题',     'BUG',          'itm_feedback_category', '', 'danger',  'Y', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1101, 2, '建议',     'SUGGESTION',   'itm_feedback_category', '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1102, 3, '咨询',     'QUESTION',     'itm_feedback_category', '', 'primary', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1103, 4, '其他',     'OTHER',        'itm_feedback_category', '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1110, 1, '新建',     'NEW',          'itm_feedback_status',   '', 'danger',  'Y', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1111, 2, '处理中',   'PROCESSING',   'itm_feedback_status',   '', 'warning', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1112, 3, '已解决',   'RESOLVED',     'itm_feedback_status',   '', 'success', 'N', '0', 'admin', sysdate(), '', null, '');
insert into sys_dict_data values(1113, 4, '已关闭',   'CLOSED',       'itm_feedback_status',   '', 'info',    'N', '0', 'admin', sysdate(), '', null, '');

-- ----------------------------
-- 9、系统参数（AI 策略，下发给客户端）
-- ----------------------------
insert into sys_config values(100, 'iTerminal-无人值守权限上限', 'itm.ai.unattendedCap',  'READONLY', 'Y', 'admin', sysdate(), '', null, '定时任务的默认权限上限：READONLY / APPROVE / AUTO');
insert into sys_config values(101, 'iTerminal-允许 LLM 复核',    'itm.ai.allowLlmReview', 'true',     'Y', 'admin', sysdate(), '', null, '是否允许客户端用 LLM 复核命令风险（true / false）');
insert into sys_config values(102, 'iTerminal-审批有效期（分钟）', 'itm.approval.expireMin', '30',       'Y', 'admin', sysdate(), '', null, '远程审批多久没处理就过期');
insert into sys_config values(103, 'iTerminal-审计保留天数',     'itm.audit.retentionDays',     '180', 'Y', 'admin', sysdate(), '', null, '命令审计、执行记录、已处理的审批保留多少天（每天 03:30 清理）');
insert into sys_config values(105, 'iTerminal-管理后台地址',     'itm.admin.url',               '',    'Y', 'admin', sysdate(), '', null, '通知消息里「查看详情」链接的前缀，例如 https://ops.example.com（为空时不带链接）');
insert into sys_config values(106, 'iTerminal-通知记录保留天数', 'itm.notify.retentionDays',    '30',  'Y', 'admin', sysdate(), '', null, '通知发送记录保留多少天');
insert into sys_config values(107, 'iTerminal-模型每人每天 token 上限', 'itm.llm.dailyTokenLimit', '0',    'Y', 'admin', sysdate(), '', null, '团队模型每个用户每天最多用多少 token（输入 + 输出），0 表示不限制');
insert into sys_config values(108, 'iTerminal-模型每人每分钟请求数',   'itm.llm.rpm',             '30',   'Y', 'admin', sysdate(), '', null, '团队模型每个用户每分钟最多请求多少次，0 表示不限制');
insert into sys_config values(109, 'iTerminal-允许个人模型',           'itm.ai.allowPersonalProvider', 'true', 'Y', 'admin', sysdate(), '', null, '登录后是否还能使用自己配置的模型（false 时只能用团队模型）');
insert into sys_config values(110, 'iTerminal-云备份保留份数',       'itm.backup.keepCount',          '20',   'Y', 'admin', sysdate(), '', null, '每人保留最近多少份云备份（置顶的另外最多 5 份，不被清理）');
insert into sys_config values(111, 'iTerminal-云备份大小上限（MB）', 'itm.backup.maxMb',              '50',   'Y', 'admin', sysdate(), '', null, '单个云备份 / 分享包的大小上限');
insert into sys_config values(112, 'iTerminal-允许凭证上云',         'itm.sync.allowCredentialSync',  'true', 'Y', 'admin', sysdate(), '', null, '是否允许个人凭证进入云备份和分享包（false 时禁止）');
insert into sys_config values(113, 'iTerminal-允许分享码',           'itm.share.enabled',             'true', 'Y', 'admin', sysdate(), '', null, '是否允许开启和拉取个人分享码');
insert into sys_config values(114, 'iTerminal-允许分享凭证',         'itm.share.allowCredentials',    'true', 'Y', 'admin', sysdate(), '', null, '分享包是否可以包含凭证');
insert into sys_config values(115, 'iTerminal-知识库向量模型提供商', 'itm.kb.embedProviderId', '',     'Y', 'admin', sysdate(), '', null, '生成向量用的团队模型提供商 ID（OpenAI 兼容的 embeddings 接口）；为空时只用关键词检索');
insert into sys_config values(116, 'iTerminal-知识库向量模型',       'itm.kb.embedModel',      '',     'Y', 'admin', sysdate(), '', null, '向量模型 ID，例如本地 bge-m3、千问 text-embedding-v4、豆包 doubao-embedding');
insert into sys_config values(121, 'iTerminal-知识库本地向量服务',   'itm.kb.embedUrl',        '',     'Y', 'admin', sysdate(), '', null, '本地向量服务的地址（OpenAI 兼容，例如 Ollama 的 http://127.0.0.1:11434/v1）；配置了提供商时不用这个地址');
insert into sys_config values(117, 'iTerminal-接受匿名反馈',         'itm.feedback.allowAnonymous', 'true', 'Y', 'admin', sysdate(), '', null, '是否接受本地模式（未登录）客户端提交的匿名问题反馈（true / false）');
insert into sys_config values(118, 'iTerminal-问题反馈保留天数',     'itm.feedback.retentionDays',  '365',  'Y', 'admin', sysdate(), '', null, '问题反馈和附件（截图、诊断包）保留多少天（每天 03:30 清理）');
insert into sys_config values(119, 'iTerminal-反馈 AI 分析提供商',   'itm.feedback.aiProviderId',   '',     'Y', 'admin', sysdate(), '', null, 'AI 分析问题反馈默认用的团队模型提供商 ID（为空时用第一个启用的团队模型）');
insert into sys_config values(120, 'iTerminal-反馈 AI 分析模型',     'itm.feedback.aiModel',        '',     'Y', 'admin', sysdate(), '', null, 'AI 分析问题反馈默认用的模型 ID（为空时用提供商的第一个模型）');
insert into sys_config values(122, 'iTerminal-联网搜索-启用', 'itm.web.enabled', 'false', 'Y', 'admin', sysdate(), '', null, '客户端「联网」默认使用的搜索服务是否启用（true / false）；和团队模型无关，在「大模型 → 联网搜索」里配置');
insert into sys_config values(123, 'iTerminal-联网搜索-接口格式', 'itm.web.format', 'deepseek', 'Y', 'admin', sysdate(), '', null, 'deepseek（DeepSeek Search / Fetch 接口）或 custom（自定义，DeepSeek 风格，兼容 Kimi 等字段名）');
insert into sys_config values(124, 'iTerminal-联网搜索-DeepSeek 根地址', 'itm.web.baseUrl', '', 'Y', 'admin', sysdate(), '', null, 'deepseek 格式的根地址，为空时用 https://api.deepseek.com');
insert into sys_config values(125, 'iTerminal-联网搜索-搜索接口', 'itm.web.searchUrl', '', 'Y', 'admin', sysdate(), '', null, 'custom 格式的搜索接口完整地址，例如 https://api.moonshot.cn/v1/tools/search');
insert into sys_config values(126, 'iTerminal-联网搜索-网页读取接口', 'itm.web.fetchUrl', '', 'Y', 'admin', sysdate(), '', null, 'custom 格式的网页读取接口完整地址；为空时客户端只能搜索');
insert into sys_config values(127, 'iTerminal-联网搜索-API Key（加密）', 'itm.web.apiKey', '', 'Y', 'admin', sysdate(), '', null, '搜索服务的 API Key（AES-256-GCM 加密，请在管理页面里修改，不要直接改这里）');
insert into sys_config values(128, 'iTerminal-联网搜索-每次条数', 'itm.web.count', '8', 'Y', 'admin', sysdate(), '', null, '每次搜索返回的结果数（1–20）');
insert into sys_config values(129, 'iTerminal-联网搜索-显示名称', 'itm.web.label', '', 'Y', 'admin', sysdate(), '', null, '客户端显示的搜索服务名称（为空时显示 DeepSeek / 自定义搜索）');
insert into sys_config values(130, 'iTerminal-联网搜索-每人每天次数', 'itm.web.dailyLimit', '500', 'Y', 'admin', sysdate(), '', null, '每个用户每天最多搜索 / 读取网页多少次，0 表示不限制');
insert into sys_config values(131, 'iTerminal-知识库向量存储（MYSQL / MILVUS）', 'itm.kb.vectorStore', 'MYSQL', 'Y', 'admin', sysdate(), '', null, '知识库向量存在哪里：MYSQL（默认，检索时在内存里计算）或 MILVUS（请在管理页「知识库 → 向量存储」里修改）');
insert into sys_config values(132, 'iTerminal-知识库 Milvus 地址', 'itm.kb.milvusUrl', '', 'Y', 'admin', sysdate(), '', null, 'Milvus 2.4+ 的地址，例如 http://127.0.0.1:19530');
insert into sys_config values(133, 'iTerminal-知识库 Milvus 认证（加密）', 'itm.kb.milvusToken', '', 'Y', 'admin', sysdate(), '', null, '用户名:密码或 API Key（AES-256-GCM 加密，请在管理页面里修改，不要直接改这里）');
insert into sys_config values(134, 'iTerminal-知识库 Milvus 数据库', 'itm.kb.milvusDb', '', 'Y', 'admin', sysdate(), '', null, 'Milvus 数据库名，为空时用 default');
insert into sys_config values(135, 'iTerminal-知识库 Milvus 集合前缀', 'itm.kb.milvusCollection', '', 'Y', 'admin', sysdate(), '', null, 'Milvus 集合名前缀，为空时用 itm_kb_chunks（实际集合名带向量维度，例如 itm_kb_chunks_d1024）');
insert into sys_config values(104, 'iTerminal-录像保留天数',     'itm.recording.retentionDays', '30',  'Y', 'admin', sysdate(), '', null, '会话录像（记录和文件）保留多少天（每天 03:30 清理）');

-- ----------------------------
-- 10、菜单（3000 起）：iTerminal 目录和各管理页面、按钮权限
-- ----------------------------
insert into sys_menu values('3000', 'iTerminal', '0', '5', 'iterminal', null, '', '', 1, 0, 'M', '0', '0', '', 'terminal', 'admin', sysdate(), '', null, 'iTerminal 管理目录');
insert into sys_menu values('3001', '设备管理', '3000', '1', 'device',   'iterminal/device/index',   '', '', 1, 0, 'C', '0', '0', 'itm:device:list',   'phone',     'admin', sysdate(), '', null, '桌面客户端设备');
insert into sys_menu values('3002', '命令审计', '3000', '2', 'audit',    'iterminal/audit/index',    '', '', 1, 0, 'C', '0', '0', 'itm:audit:list',    'log',       'admin', sysdate(), '', null, '客户端上报的命令审计');
insert into sys_menu values('3003', '会话录像', '3000', '3', 'session',  'iterminal/session/index',  '', '', 1, 0, 'C', '0', '0', 'itm:session:list',  'eye-open',  'admin', sysdate(), '', null, '终端会话录像');
insert into sys_menu values('3004', '定时任务', '3000', '4', 'task',     'iterminal/task/index',     '', '', 1, 0, 'C', '0', '0', 'itm:task:list',     'time-range','admin', sysdate(), '', null, '服务端派发的定时任务');
insert into sys_menu values('3005', '执行记录', '3000', '5', 'run',      'iterminal/run/index',      '', '', 1, 0, 'C', '0', '0', 'itm:run:list',      'list',      'admin', sysdate(), '', null, '定时任务执行记录');
insert into sys_menu values('3006', '远程审批', '3000', '6', 'approval', 'iterminal/approval/index', '', '', 1, 0, 'C', '0', '0', 'itm:approval:list', 'checkbox',  'admin', sysdate(), '', null, '远程审批');
insert into sys_menu values('3007', '版本发布', '3000', '7', 'release',  'iterminal/release/index',  '', '', 1, 0, 'C', '0', '0', 'itm:release:list',  'upload',    'admin', sysdate(), '', null, '客户端版本发布');
insert into sys_menu values('3008', '命令规则', '3000', '8', 'rule',     'iterminal/rule/index',     '', '', 1, 0, 'C', '0', '0', 'itm:rule:list',     'validCode', 'admin', sysdate(), '', null, 'AI 命令规则和脱敏规则');
insert into sys_menu values('3009', '通知渠道', '3000', '9', 'notify',   'iterminal/notify/index',   '', '', 1, 0, 'C', '0', '0', 'itm:notify:list',   'message',   'admin', sysdate(), '', null, '钉钉 / 企业微信 / 飞书 / 邮件 / Webhook 通知');
insert into sys_menu values('3010', '团队模型', '3000', '10', 'llm',     'iterminal/llm/index',      '', '', 1, 0, 'C', '0', '0', 'itm:llm:list',      'skill',     'admin', sysdate(), '', null, '大模型代理：团队模型配置和用量');
insert into sys_menu values('3011', '团队主机', '3000', '11', 'asset',   'iterminal/asset/index',    '', '', 1, 0, 'C', '0', '0', 'itm:asset:list',    'server',    'admin', sysdate(), '', null, '团队主机：登录后同步到客户端');
insert into sys_menu values('3012', '云备份与分享', '3000', '12', 'cloud', 'iterminal/cloud/index',    '', '', 1, 0, 'C', '0', '0', 'itm:cloud:list',    'zip',       'admin', sysdate(), '', null, '云备份记录和个人分享码（只能看元数据）');
insert into sys_menu values('3013', '知识库',   '3000', '13', 'kb',      'iterminal/kb/index',       '', '', 1, 0, 'C', '0', '0', 'itm:kb:list',       'documentation', 'admin', sysdate(), '', null, '知识库：Agent 排障时检索引用');
insert into sys_menu values('3014', '问题反馈', '3000', '14', 'feedback', 'iterminal/feedback/index',  '', '', 1, 0, 'C', '0', '0', 'itm:feedback:list', 'message',   'admin', sysdate(), '', null, '客户端提交的问题反馈：截图、操作轨迹、日志、AI 分析');
-- 按钮
insert into sys_menu values('3100', '设备查询', '3001', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:device:query',   '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3101', '设备吊销', '3001', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:device:revoke',  '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3110', '审计导出', '3002', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:audit:export',   '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3120', '录像回放', '3003', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:session:play',   '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3121', '录像删除', '3003', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:session:remove', '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3130', '任务新增', '3004', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:task:add',       '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3131', '任务修改', '3004', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:task:edit',      '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3132', '任务删除', '3004', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:task:remove',    '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3133', '立即执行', '3004', '4', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:task:run',       '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3140', '审批处理', '3006', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:approval:decide','#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3150', '版本上传', '3007', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:release:add',    '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3151', '版本修改', '3007', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:release:edit',   '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3152', '版本删除', '3007', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:release:remove', '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3160', '规则新增', '3008', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:rule:add',       '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3161', '规则修改', '3008', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:rule:edit',      '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3170', '渠道新增', '3009', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:notify:add',     '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3171', '渠道修改', '3009', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:notify:edit',    '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3172', '渠道删除', '3009', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:notify:remove',  '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3173', '发送测试', '3009', '4', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:notify:test',    '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3180', '模型新增', '3010', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:llm:add',        '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3181', '模型修改', '3010', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:llm:edit',       '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3182', '模型删除', '3010', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:llm:remove',     '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3183', '模型测试', '3010', '4', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:llm:test',       '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3190', '主机新增', '3011', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:asset:add',      '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3191', '主机修改', '3011', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:asset:edit',     '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3192', '主机删除', '3011', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:asset:remove',   '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3200', '关闭分享码', '3012', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:cloud:remove',   '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3210', '知识库新增', '3013', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:kb:add',         '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3211', '知识库修改', '3013', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:kb:edit',        '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3212', '知识库删除', '3013', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:kb:remove',      '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3220', '反馈查看', '3014', '1', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:query',   '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3221', '反馈处理', '3014', '2', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:edit',    '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3222', '反馈删除', '3014', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:remove',  '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3223', 'AI 分析',  '3014', '4', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:feedback:analyze', '#', 'admin', sysdate(), '', null, '');
insert into sys_menu values('3162', '规则删除', '3008', '3', '', '', '', '', 1, 0, 'F', '0', '0', 'itm:rule:remove',    '#', 'admin', sysdate(), '', null, '');

-- ----------------------------
-- 11、角色：运维审批员（可以在客户端和管理后台处理远程审批、查看审计和执行记录）
-- ----------------------------
insert into sys_role values('3', '运维审批员', 'itm_approver', 3, 1, 1, 1, '0', '0', 'admin', sysdate(), '', null, 'iTerminal 远程审批和审计查看');
insert into sys_role_menu values ('3', '3000');
insert into sys_role_menu values ('3', '3002');
insert into sys_role_menu values ('3', '3003');
insert into sys_role_menu values ('3', '3005');
insert into sys_role_menu values ('3', '3006');
insert into sys_role_menu values ('3', '3120');
insert into sys_role_menu values ('3', '3140');

-- ----------------------------
-- 12、清理若依的演示数据：外链菜单「若依官网」、演示通知、示例部门和昵称；停用演示账号 ry；提示修改初始密码
-- ----------------------------
delete from sys_role_menu where menu_id = 4;
delete from sys_menu where menu_id = 4;
delete from sys_notice_read;
delete from sys_notice;
update sys_dept set dept_name = 'iTerminal', leader = '', phone = '', email = '' where dept_id = 100;
update sys_dept set leader = '', phone = '', email = '' where dept_id > 100;
-- pwd_update_date 置空：管理员第一次登录管理后台时提示修改初始密码
update sys_user set nick_name = '管理员', email = '', phonenumber = '', pwd_update_date = null where user_id = 1;
update sys_user set nick_name = '演示用户', email = '', phonenumber = '', status = '1' where user_id = 2;
