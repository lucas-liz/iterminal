package com.ruoyi.iterminal.domain;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.ruoyi.common.annotation.Excel;
import com.ruoyi.common.core.domain.BaseEntity;
import java.util.Date;

/**
 * 命令审计（itm_audit_command）
 */
public class ItmAuditCommand extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 主键 */
    private Long auditId;

    /** 客户端事件ID */
    private String clientEventId;

    /** 设备ID */
    @Excel(name = "设备ID")
    private String deviceId;

    /** 用户ID */
    private Long userId;

    /** 用户 */
    @Excel(name = "用户")
    private String userName;

    /** 类型 */
    @Excel(name = "类型")
    private String kind;

    /** 来源 */
    @Excel(name = "来源")
    private String source;

    /** 事件类型 */
    @Excel(name = "事件类型")
    private String eventType;

    /** 主机ID */
    private String hostId;

    /** 主机 */
    @Excel(name = "主机")
    private String hostName;

    /** 会话ID */
    private String sessionId;

    /** 命令 */
    @Excel(name = "命令")
    private String command;

    /** 风险等级 */
    @Excel(name = "风险等级")
    private String risk;

    /** 处理结果 */
    @Excel(name = "处理结果")
    private String decision;

    /** 退出码 */
    @Excel(name = "退出码")
    private Integer exitCode;

    /** 详情 */
    private String detail;

    /** 发生时间 */
    @Excel(name = "发生时间", width = 20, dateFormat = "yyyy-MM-dd HH:mm:ss")
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date occurredAt;

    public Long getAuditId()
    {
        return auditId;
    }

    public void setAuditId(Long auditId)
    {
        this.auditId = auditId;
    }

    public String getClientEventId()
    {
        return clientEventId;
    }

    public void setClientEventId(String clientEventId)
    {
        this.clientEventId = clientEventId;
    }

    public String getDeviceId()
    {
        return deviceId;
    }

    public void setDeviceId(String deviceId)
    {
        this.deviceId = deviceId;
    }

    public Long getUserId()
    {
        return userId;
    }

    public void setUserId(Long userId)
    {
        this.userId = userId;
    }

    public String getUserName()
    {
        return userName;
    }

    public void setUserName(String userName)
    {
        this.userName = userName;
    }

    public String getKind()
    {
        return kind;
    }

    public void setKind(String kind)
    {
        this.kind = kind;
    }

    public String getSource()
    {
        return source;
    }

    public void setSource(String source)
    {
        this.source = source;
    }

    public String getEventType()
    {
        return eventType;
    }

    public void setEventType(String eventType)
    {
        this.eventType = eventType;
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

    public String getSessionId()
    {
        return sessionId;
    }

    public void setSessionId(String sessionId)
    {
        this.sessionId = sessionId;
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

    public String getDecision()
    {
        return decision;
    }

    public void setDecision(String decision)
    {
        this.decision = decision;
    }

    public Integer getExitCode()
    {
        return exitCode;
    }

    public void setExitCode(Integer exitCode)
    {
        this.exitCode = exitCode;
    }

    public String getDetail()
    {
        return detail;
    }

    public void setDetail(String detail)
    {
        this.detail = detail;
    }

    public Date getOccurredAt()
    {
        return occurredAt;
    }

    public void setOccurredAt(Date occurredAt)
    {
        this.occurredAt = occurredAt;
    }
}
