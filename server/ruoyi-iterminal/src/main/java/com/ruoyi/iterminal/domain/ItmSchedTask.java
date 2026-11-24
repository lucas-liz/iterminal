package com.ruoyi.iterminal.domain;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.ruoyi.common.core.domain.BaseEntity;
import java.util.Date;

/**
 * 定时任务（itm_sched_task）
 */
public class ItmSchedTask extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 任务ID */
    private Long taskId;

    /** 任务名称 */
    private String taskName;

    /** 类型 */
    private String taskType;

    /** 命令 */
    private String command;

    /** 任务描述 */
    private String prompt;

    /** Skill */
    private String skill;

    /** Skill 参数 */
    private String skillParams;

    /** 执行设备 */
    private String deviceId;

    /** 目标主机 */
    private String hosts;

    /** cron 表达式 */
    private String cronExpression;

    /** 权限上限 */
    private String permissionCap;

    /** 超时（分钟） */
    private Integer timeoutMin;

    /** 状态 */
    private String status;

    /** 上次执行 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date lastRunAt;

    public Long getTaskId()
    {
        return taskId;
    }

    public void setTaskId(Long taskId)
    {
        this.taskId = taskId;
    }

    public String getTaskName()
    {
        return taskName;
    }

    public void setTaskName(String taskName)
    {
        this.taskName = taskName;
    }

    public String getTaskType()
    {
        return taskType;
    }

    public void setTaskType(String taskType)
    {
        this.taskType = taskType;
    }

    public String getCommand()
    {
        return command;
    }

    public void setCommand(String command)
    {
        this.command = command;
    }

    public String getPrompt()
    {
        return prompt;
    }

    public void setPrompt(String prompt)
    {
        this.prompt = prompt;
    }

    public String getSkill()
    {
        return skill;
    }

    public void setSkill(String skill)
    {
        this.skill = skill;
    }

    public String getSkillParams()
    {
        return skillParams;
    }

    public void setSkillParams(String skillParams)
    {
        this.skillParams = skillParams;
    }

    public String getDeviceId()
    {
        return deviceId;
    }

    public void setDeviceId(String deviceId)
    {
        this.deviceId = deviceId;
    }

    public String getHosts()
    {
        return hosts;
    }

    public void setHosts(String hosts)
    {
        this.hosts = hosts;
    }

    public String getCronExpression()
    {
        return cronExpression;
    }

    public void setCronExpression(String cronExpression)
    {
        this.cronExpression = cronExpression;
    }

    public String getPermissionCap()
    {
        return permissionCap;
    }

    public void setPermissionCap(String permissionCap)
    {
        this.permissionCap = permissionCap;
    }

    public Integer getTimeoutMin()
    {
        return timeoutMin;
    }

    public void setTimeoutMin(Integer timeoutMin)
    {
        this.timeoutMin = timeoutMin;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }

    public Date getLastRunAt()
    {
        return lastRunAt;
    }

    public void setLastRunAt(Date lastRunAt)
    {
        this.lastRunAt = lastRunAt;
    }
}
