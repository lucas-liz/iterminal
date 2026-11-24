package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * 通知渠道（itm_notify_channel）
 */
public class ItmNotifyChannel extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 渠道ID */
    private Long channelId;

    /** 渠道名称 */
    private String channelName;

    /** 类型（DINGTALK / WECOM / FEISHU / EMAIL / WEBHOOK） */
    private String channelType;

    /** 机器人或 Webhook 地址 */
    private String webhook;

    /** 加签密钥（列表里不返回明文） */
    private String secret;

    /** 邮件收件人（逗号分隔） */
    private String recipients;

    /** @ 的手机号（逗号分隔，all 表示所有人） */
    private String mention;

    /** 订阅的事件（逗号分隔） */
    private String events;

    /** 状态（0启用 1停用） */
    private String status;

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

    public String getWebhook()
    {
        return webhook;
    }

    public void setWebhook(String webhook)
    {
        this.webhook = webhook;
    }

    public String getSecret()
    {
        return secret;
    }

    public void setSecret(String secret)
    {
        this.secret = secret;
    }

    public String getRecipients()
    {
        return recipients;
    }

    public void setRecipients(String recipients)
    {
        this.recipients = recipients;
    }

    public String getMention()
    {
        return mention;
    }

    public void setMention(String mention)
    {
        this.mention = mention;
    }

    public String getEvents()
    {
        return events;
    }

    public void setEvents(String events)
    {
        this.events = events;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }
}
