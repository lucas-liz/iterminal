package com.ruoyi.iterminal.mapper;

import java.util.List;
import com.ruoyi.iterminal.domain.ItmMaskRule;

/** AI 脱敏规则 */
public interface ItmMaskRuleMapper
{
    ItmMaskRule selectItmMaskRuleById(Long ruleId);

    List<ItmMaskRule> selectItmMaskRuleList(ItmMaskRule query);

    int insertItmMaskRule(ItmMaskRule rule);

    int updateItmMaskRule(ItmMaskRule rule);

    int deleteItmMaskRuleByIds(Long[] ruleIds);
}
