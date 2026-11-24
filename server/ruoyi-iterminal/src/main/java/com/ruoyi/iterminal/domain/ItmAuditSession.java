package com.ruoyi.iterminal.domain;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.ruoyi.common.core.domain.BaseEntity;
import java.util.Date;

/**
 * 会话录像（itm_audit_session）
 */
public class ItmAuditSession extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 录像ID */
    private String recordingId;

    /** 设备ID */
    private String deviceId;

    /** 用户ID */
    private Long userId;

    /** 用户 */
    private String userName;

    /** 会话ID */
    private String sessionId;

    /** 类型 */
    private String kind;

    /** 主机ID */
    private String hostId;

    /** 主机 */
    private String hostName;

    /** 列数 */
    private Integer cols;

    /** 行数 */
    private Integer rowsCount;

    /** 开始时间 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date startedAt;

    /** 结束时间 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date endedAt;

    /** 分片数 */
    private Integer chunks;

    /** 大小 */
    private Long bytes;

    /** 是否完成 */
    private String complete;

    /** 文件路径 */
    private String filePath;

    public String getRecordingId()
    {
        return recordingId;
    }

    public void setRecordingId(String recordingId)
    {
        this.recordingId = recordingId;
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

    public String getSessionId()
    {
        return sessionId;
    }

    public void setSessionId(String sessionId)
    {
        this.sessionId = sessionId;
    }

    public String getKind()
    {
        return kind;
    }

    public void setKind(String kind)
    {
        this.kind = kind;
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

    public Integer getCols()
    {
        return cols;
    }

    public void setCols(Integer cols)
    {
        this.cols = cols;
    }

    public Integer getRowsCount()
    {
        return rowsCount;
    }

    public void setRowsCount(Integer rowsCount)
    {
        this.rowsCount = rowsCount;
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

    public Integer getChunks()
    {
        return chunks;
    }

    public void setChunks(Integer chunks)
    {
        this.chunks = chunks;
    }

    public Long getBytes()
    {
        return bytes;
    }

    public void setBytes(Long bytes)
    {
        this.bytes = bytes;
    }

    public String getComplete()
    {
        return complete;
    }

    public void setComplete(String complete)
    {
        this.complete = complete;
    }

    public String getFilePath()
    {
        return filePath;
    }

    public void setFilePath(String filePath)
    {
        this.filePath = filePath;
    }
}
