package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * 通知发送记录（itm_notify_log）
 */
public class ItmNotifyLog extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 记录ID */
    private Long logId;

    /** 渠道ID */
    private Long channelId;

    /** 渠道名称 */
    private String channelName;

    /** 渠道类型 */
    private String channelType;

    /** 事件 */
    private String event;

    /** 标题 */
    private String title;

    /** 内容 */
    private String content;

    /** 结果（0成功 1失败） */
    private String status;

    /** 失败原因 */
    private String error;

    /** 发送时间 */
    @com.fasterxml.jackson.annotation.JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private java.util.Date sentAt;

    public Long getLogId()
    {
        return logId;
    }

    public void setLogId(Long logId)
    {
        this.logId = logId;
    }

    public Long getChannelId()
    {
        return channelId;
    }

    public void setChannelId(Long channelId)
    {
        this.channelId = channelId;
    }

    public String getChannelName()
    {
        return channelName;
    }

    public void setChannelName(String channelName)
    {
        this.channelName = channelName;
    }

    public String getChannelType()
    {
        return channelType;
    }

    public void setChannelType(String channelType)
    {
        this.channelType = channelType;
    }

    public String getEvent()
    {
        return event;
    }

    public void setEvent(String event)
    {
        this.event = event;
    }

    public String getTitle()
    {
        return title;
    }

    public void setTitle(String title)
    {
        this.title = title;
    }

    public String getContent()
    {
        return content;
    }

    public void setContent(String content)
    {
        this.content = content;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }

    public String getError()
    {
        return error;
    }

    public void setError(String error)
    {
        this.error = error;
    }

    public java.util.Date getSentAt()
    {
        return sentAt;
    }

    public void setSentAt(java.util.Date sentAt)
    {
        this.sentAt = sentAt;
    }
}
