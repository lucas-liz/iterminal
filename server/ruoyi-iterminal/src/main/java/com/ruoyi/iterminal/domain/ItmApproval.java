package com.ruoyi.iterminal.domain;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.ruoyi.common.core.domain.BaseEntity;
import java.util.Date;

/**
 * 远程审批（itm_approval）
 */
public class ItmApproval extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 审批ID */
    private String approvalId;

    /** 执行ID */
    private String runId;

    /** 任务ID */
    private Long taskId;

    /** 任务名称 */
    private String taskName;

    /** 执行设备 */
    private String deviceId;

    /** 主机 */
    private String hostId;

    /** 主机名称 */
    private String hostName;

    /** 命令 */
    private String command;

    /** 风险等级 */
    private String risk;

    /** 判定原因 */
    private String reasons;

    /** 作用说明 */
    private String explanation;

    /** 状态 */
    private String status;

    /** 审批人 */
    private String decidedBy;

    /** 审批意见 */
    private String decideComment;

    /** 过期时间 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date expiresAt;

    /** 审批时间 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date decidedAt;

    public String getApprovalId()
    {
        return approvalId;
    }

    public void setApprovalId(String approvalId)
    {
        this.approvalId = approvalId;
    }

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

    public String getDeviceId()
    {
        return deviceId;
    }

    public void setDeviceId(String deviceId)
    {
        this.deviceId = deviceId;
    }

    public String getHostId()
    {
        return hostId;
    }

    public void setHostId(String hostId)
    {
        this.hostId = hostId;
    }

    public String getHostName()
    {
        return hostName;
    }

    public void setHostName(String hostName)
    {
        this.hostName = hostName;
    }

    public String getCommand()
    {
        return command;
    }

    public void setCommand(String command)
    {
        this.command = command;
    }

    public String getRisk()
    {
        return risk;
    }

    public void setRisk(String risk)
    {
        this.risk = risk;
    }

    public String getReasons()
    {
        return reasons;
    }

    public void setReasons(String reasons)
    {
        this.reasons = reasons;
    }

    public String getExplanation()
    {
        return explanation;
    }

    public void setExplanation(String explanation)
    {
        this.explanation = explanation;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }

    public String getDecidedBy()
    {
        return decidedBy;
    }

    public void setDecidedBy(String decidedBy)
    {
        this.decidedBy = decidedBy;
    }

    public String getDecideComment()
    {
        return decideComment;
    }

    public void setDecideComment(String decideComment)
    {
        this.decideComment = decideComment;
    }

    public Date getExpiresAt()
    {
        return expiresAt;
    }

    public void setExpiresAt(Date expiresAt)
    {
        this.expiresAt = expiresAt;
    }

    public Date getDecidedAt()
    {
        return decidedAt;
    }

    public void setDecidedAt(Date decidedAt)
    {
        this.decidedAt = decidedAt;
    }
}
