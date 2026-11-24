package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * AI 脱敏规则（itm_mask_rule）
 */
public class ItmMaskRule extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 规则ID */
    private Long ruleId;

    /** 规则名称 */
    private String ruleName;

    /** 正则表达式 */
    private String pattern;

    /** 替换为 */
    private String replacement;

    /** 必须用内网模型 */
    private String forcePrivate;

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

    public String getPattern()
    {
        return pattern;
    }

    public void setPattern(String pattern)
    {
        this.pattern = pattern;
    }

    public String getReplacement()
    {
        return replacement;
    }

    public void setReplacement(String replacement)
    {
        this.replacement = replacement;
    }

    public String getForcePrivate()
    {
        return forcePrivate;
    }

    public void setForcePrivate(String forcePrivate)
    {
        this.forcePrivate = forcePrivate;
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
