package com.ruoyi.iterminal.mapper;

import java.util.List;
import com.ruoyi.iterminal.domain.ItmCommandRule;

/** AI 命令规则 */
public interface ItmCommandRuleMapper
{
    ItmCommandRule selectItmCommandRuleById(Long ruleId);

    List<ItmCommandRule> selectItmCommandRuleList(ItmCommandRule query);

    int insertItmCommandRule(ItmCommandRule rule);

    int updateItmCommandRule(ItmCommandRule rule);

    int deleteItmCommandRuleByIds(Long[] ruleIds);
}
