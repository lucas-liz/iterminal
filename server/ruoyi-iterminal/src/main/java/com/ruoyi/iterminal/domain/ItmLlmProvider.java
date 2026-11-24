package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * 团队模型提供商（itm_llm_provider）
 */
public class ItmLlmProvider extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 提供商ID */
    private Long providerId;

    /** 名称 */
    private String providerName;

    /** 协议（ANTHROPIC / OPENAI / OPENAI_COMPAT） */
    private String providerType;

    /** 接口地址 */
    private String baseUrl;

    /** API Key 密文（不返回给前端） */
    @com.fasterxml.jackson.annotation.JsonIgnore
    private String apiKeyEnc;

    /** API Key：保存时传明文；读取时为 ****** 表示已经设置 */
    private String apiKey;

    /** 模型列表（JSON 数组） */
    private String models;

    /** 深度思考参数的发送方式 */
    private String thinkingStyle;

    /** 工具调用时回传 reasoning_content（0否 1是） */
    private String echoReasoning;

    /** 可以使用的角色（逗号分隔，空 = 所有人） */
    private String roleKeys;

    /** 可以使用的用户（用户ID，逗号分隔） */
    private String userIds;

    /** 可以使用的组织（部门ID，逗号分隔，含下级） */
    private String deptIds;

    /** 显示顺序 */
    private Integer sort;

    /** 状态（0启用 1停用） */
    private String status;

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

    public String getProviderType()
    {
        return providerType;
    }

    public void setProviderType(String providerType)
    {
        this.providerType = providerType;
    }

    public String getBaseUrl()
    {
        return baseUrl;
    }

    public void setBaseUrl(String baseUrl)
    {
        this.baseUrl = baseUrl;
    }

    public String getApiKeyEnc()
    {
        return apiKeyEnc;
    }

    public void setApiKeyEnc(String apiKeyEnc)
    {
        this.apiKeyEnc = apiKeyEnc;
    }

    public String getApiKey()
    {
        return apiKey;
    }

    public void setApiKey(String apiKey)
    {
        this.apiKey = apiKey;
    }

    public String getModels()
    {
        return models;
    }

    public void setModels(String models)
    {
        this.models = models;
    }

    public String getThinkingStyle()
    {
        return thinkingStyle;
    }

    public void setThinkingStyle(String thinkingStyle)
    {
        this.thinkingStyle = thinkingStyle;
    }

    public String getEchoReasoning()
    {
        return echoReasoning;
    }

    public void setEchoReasoning(String echoReasoning)
    {
        this.echoReasoning = echoReasoning;
    }

    public String getRoleKeys()
    {
        return roleKeys;
    }

    public void setRoleKeys(String roleKeys)
    {
        this.roleKeys = roleKeys;
    }

    public String getUserIds()
    {
        return userIds;
    }

    public void setUserIds(String userIds)
    {
        this.userIds = userIds;
    }

    public String getDeptIds()
    {
        return deptIds;
    }

    public void setDeptIds(String deptIds)
    {
        this.deptIds = deptIds;
    }

    public Integer getSort()
    {
        return sort;
    }

    public void setSort(Integer sort)
    {
        this.sort = sort;
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
