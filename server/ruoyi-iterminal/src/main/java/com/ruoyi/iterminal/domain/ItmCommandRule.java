package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * AI 命令规则（itm_command_rule）
 */
public class ItmCommandRule extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 规则ID */
    private Long ruleId;

    /** 规则名称 */
    private String ruleName;

    /** 匹配方式 */
    private String matchType;

    /** 匹配内容 */
    private String pattern;

    /** 等级 */
    private String level;

    /** 判定说明 */
    private String reason;

    /** 优先级 */
    private Integer priority;

    /** 状态 */
    private String status;

    public Long getRuleId()
    {
        return ruleId;
    }

    public void setRuleId(Long ruleId)
    {
        this.ruleId = ruleId;
    }

    public String getRuleName()
    {
        return ruleName;
    }

    public void setRuleName(String ruleName)
    {
        this.ruleName = ruleName;
    }

    public String getMatchType()
    {
        return matchType;
    }

    public void setMatchType(String matchType)
    {
        this.matchType = matchType;
    }

    public String getPattern()
    {
        return pattern;
    }

    public void setPattern(String pattern)
    {
        this.pattern = pattern;
    }

    public String getLevel()
    {
        return level;
    }

    public void setLevel(String level)
    {
        this.level = level;
    }

    public String getReason()
    {
        return reason;
    }

    public void setReason(String reason)
    {
        this.reason = reason;
    }

    public Integer getPriority()
    {
        return priority;
    }

    public void setPriority(Integer priority)
    {
        this.priority = priority;
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
