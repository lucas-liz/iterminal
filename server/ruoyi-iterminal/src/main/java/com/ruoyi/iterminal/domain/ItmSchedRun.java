package com.ruoyi.iterminal.domain;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.ruoyi.common.core.domain.BaseEntity;
import java.util.Date;

/**
 * 执行记录（itm_sched_run）
 */
public class ItmSchedRun extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 执行ID */
    private String runId;

    /** 任务ID */
    private Long taskId;

    /** 任务名称 */
    private String taskName;

    /** 类型 */
    private String taskType;

    /** 执行设备 */
    private String deviceId;

    /** 触发方式 */
    private String triggerType;

    /** 状态 */
    private String status;

    /** 进度 */
    private Integer percent;

    /** 摘要 */
    private String summary;

    /** 主机结果 */
    private String hosts;

    /** 开始时间 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date startedAt;

    /** 结束时间 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date endedAt;

    public String getRunId()
    {
        return runId;
    }

    public void setRunId(String runId)
    {
        this.runId = runId;
    }

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

    public String getDeviceId()
    {
        return deviceId;
    }

    public void setDeviceId(String deviceId)
    {
        this.deviceId = deviceId;
    }

    public String getTriggerType()
    {
        return triggerType;
    }

    public void setTriggerType(String triggerType)
    {
        this.triggerType = triggerType;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }

    public Integer getPercent()
    {
        return percent;
    }

    public void setPercent(Integer percent)
    {
        this.percent = percent;
    }

    public String getSummary()
    {
        return summary;
    }

    public void setSummary(String summary)
    {
        this.summary = summary;
    }

    public String getHosts()
    {
        return hosts;
    }

    public void setHosts(String hosts)
    {
        this.hosts = hosts;
    }

    public Date getStartedAt()
    {
        return startedAt;
    }

    public void setStartedAt(Date startedAt)
    {
        this.startedAt = startedAt;
    }

    public Date getEndedAt()
    {
        return endedAt;
    }

    public void setEndedAt(Date endedAt)
    {
        this.endedAt = endedAt;
    }
}
