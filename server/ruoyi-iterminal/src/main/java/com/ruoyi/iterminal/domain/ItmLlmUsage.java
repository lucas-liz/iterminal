package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * 团队模型用量（itm_llm_usage）
 */
public class ItmLlmUsage extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 记录ID */
    private Long usageId;

    /** 用户ID */
    private Long userId;

    /** 用户账号 */
    private String userName;

    /** 设备ID */
    private String deviceId;

    /** 提供商ID */
    private Long providerId;

    /** 提供商名称 */
    private String providerName;

    /** 模型 */
    private String model;

    /** 输入 token */
    private Integer inputTokens;

    /** 输出 token */
    private Integer outputTokens;

    /** 用量是估算的 */
    private String estimated;

    /** 结果（0成功 1失败） */
    private String status;

    /** 失败原因 */
    private String error;

    /** 耗时（毫秒） */
    private Integer durationMs;

    /** 时间 */
    @com.fasterxml.jackson.annotation.JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private java.util.Date createdAt;

    public Long getUsageId()
    {
        return usageId;
    }

    public void setUsageId(Long usageId)
    {
        this.usageId = usageId;
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

    public String getDeviceId()
    {
        return deviceId;
    }

    public void setDeviceId(String deviceId)
    {
        this.deviceId = deviceId;
    }

    public Long getProviderId()
    {
        return providerId;
    }

    public void setProviderId(Long providerId)
    {
        this.providerId = providerId;
    }

    public String getProviderName()
    {
        return providerName;
    }

    public void setProviderName(String providerName)
    {
        this.providerName = providerName;
    }

    public String getModel()
    {
        return model;
    }

    public void setModel(String model)
    {
        this.model = model;
    }

    public Integer getInputTokens()
    {
        return inputTokens;
    }

    public void setInputTokens(Integer inputTokens)
    {
        this.inputTokens = inputTokens;
    }

    public Integer getOutputTokens()
    {
        return outputTokens;
    }

    public void setOutputTokens(Integer outputTokens)
    {
        this.outputTokens = outputTokens;
    }

    public String getEstimated()
    {
        return estimated;
    }

    public void setEstimated(String estimated)
    {
        this.estimated = estimated;
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

    public Integer getDurationMs()
    {
        return durationMs;
    }

    public void setDurationMs(Integer durationMs)
    {
        this.durationMs = durationMs;
    }

    public java.util.Date getCreatedAt()
    {
        return createdAt;
    }

    public void setCreatedAt(java.util.Date createdAt)
    {
        this.createdAt = createdAt;
    }
}
