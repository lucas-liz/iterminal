-- 团队主机（第七轮）：管理员在服务端维护、登录后同步到「团队主机」分组（folder.scope = 'TEAM'，srv_id 对应服务端 ID，根分组 srv_id = -1）。
-- host.team_reveal 为空表示个人主机；0 / 1 表示团队主机，以及是否允许查看密码。团队主机和分组在客户端只读。
ALTER TABLE host ADD COLUMN team_reveal INTEGER;
