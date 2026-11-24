package com.ruoyi.iterminal.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.domain.ItmCommandRule;
import com.ruoyi.iterminal.domain.ItmMaskRule;
import com.ruoyi.iterminal.mapper.ItmCommandRuleMapper;
import com.ruoyi.iterminal.mapper.ItmMaskRuleMapper;
import com.ruoyi.system.service.ISysConfigService;

/**
 * AI 策略（文档二 5.6）：命令规则、脱敏规则和全局开关，客户端登录后拉取（GET /api/v1/ai/policy）。
 */
@Service
public class ItmPolicyService
{
    private static final Set<String> MATCH = Set.of("PREFIX", "REGEX", "EXACT");
    private static final Set<String> LEVELS = Set.of("L0", "L1", "L2", "DENY");

    @Autowired
    private ItmCommandRuleMapper commandRuleMapper;

    @Autowired
    private ItmMaskRuleMapper maskRuleMapper;

    @Autowired
    private ISysConfigService configService;

    public Map<String, Object> policy()
    {
        ItmCommandRule cq = new ItmCommandRule();
        cq.setStatus("0");
        ItmMaskRule mq = new ItmMaskRule();
        mq.setStatus("0");
        List<Map<String, Object>> commands = new ArrayList<>();
        for (ItmCommandRule r : commandRuleMapper.selectItmCommandRuleList(cq))
        {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", String.valueOf(r.getRuleId()));
            m.put("name", r.getRuleName());
            m.put("matchType", r.getMatchType());
            m.put("pattern", r.getPattern());
            m.put("level", r.getLevel());
            m.put("reason", r.getReason());
            m.put("priority", r.getPriority());
            commands.add(m);
        }
        List<Map<String, Object>> masks = new ArrayList<>();
        for (ItmMaskRule r : maskRuleMapper.selectItmMaskRuleList(mq))
        {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", String.valueOf(r.getRuleId()));
            m.put("name", r.getRuleName());
            m.put("pattern", r.getPattern());
            m.put("replacement", r.getReplacement());
            m.put("forcePrivate", "1".equals(r.getForcePrivate()));
            masks.add(m);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("commandRules", commands);
        out.put("maskRules", masks);
        out.put("unattendedCap", StringUtils.nvl(configService.selectConfigByKey("itm.ai.unattendedCap"), "READONLY"));
        out.put("allowLlmReview", !"false".equalsIgnoreCase(configService.selectConfigByKey("itm.ai.allowLlmReview")));
        out.put("allowPersonalProvider", !"false".equalsIgnoreCase(configService.selectConfigByKey("itm.ai.allowPersonalProvider")));
        // 内容的摘要：客户端可以据此判断是否需要更新
        out.put("version", Integer.toHexString(out.toString().hashCode()));
        return out;
    }

    public void validate(ItmCommandRule r)
    {
        if (StringUtils.isEmpty(r.getRuleName()) || StringUtils.isEmpty(r.getPattern()))
        {
            throw new ServiceException("请填写规则名称和匹配内容");
        }
        if (!MATCH.contains(r.getMatchType()) || !LEVELS.contains(r.getLevel()))
        {
            throw new ServiceException("匹配方式或等级不正确");
        }
        if ("REGEX".equals(r.getMatchType()))
        {
            checkRegex(r.getPattern());
        }
    }

    public void validate(ItmMaskRule r)
    {
        if (StringUtils.isEmpty(r.getRuleName()) || StringUtils.isEmpty(r.getPattern()))
        {
            throw new ServiceException("请填写规则名称和正则表达式");
        }
        checkRegex(r.getPattern());
        if (Pattern.compile(r.getPattern()).matcher("").find())
        {
            throw new ServiceException("这个正则会匹配空字符串，请修改");
        }
    }

    private static void checkRegex(String p)
    {
        try
        {
            Pattern.compile(p);
        }
        catch (PatternSyntaxException e)
        {
            throw new ServiceException("正则表达式不正确：" + e.getDescription());
        }
    }
}
