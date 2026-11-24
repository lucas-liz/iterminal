package com.ruoyi.iterminal.controller.admin;

import java.util.List;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.core.page.TableDataInfo;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.common.utils.poi.ExcelUtil;
import com.ruoyi.iterminal.domain.ItmCommandRule;
import com.ruoyi.iterminal.domain.ItmMaskRule;
import com.ruoyi.iterminal.mapper.ItmCommandRuleMapper;
import com.ruoyi.iterminal.mapper.ItmMaskRuleMapper;
import com.ruoyi.iterminal.service.ItmPolicyService;

/**
 * AI 命令规则和脱敏规则（下发给客户端）。
 */
@RestController
@RequestMapping("/iterminal/rule")
public class RuleController extends BaseController
{
    @Autowired
    private ItmCommandRuleMapper commandMapper;

    @Autowired
    private ItmMaskRuleMapper maskMapper;

    @Autowired
    private ItmPolicyService policyService;

    @PreAuthorize("@ss.hasPermi('itm:rule:list')")
    @GetMapping("/command/list")
    public TableDataInfo commandList(ItmCommandRule query)
    {
        startPage();
        return getDataTable(commandMapper.selectItmCommandRuleList(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:list')")
    @GetMapping("/command/{ruleId}")
    public AjaxResult commandInfo(@PathVariable Long ruleId)
    {
        return success(commandMapper.selectItmCommandRuleById(ruleId));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:add')")
    @Log(title = "AI 命令规则", businessType = BusinessType.INSERT)
    @PostMapping("/command")
    public AjaxResult commandAdd(@RequestBody ItmCommandRule rule)
    {
        policyService.validate(rule);
        rule.setCreateBy(getUsername());
        return toAjax(commandMapper.insertItmCommandRule(rule));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:edit')")
    @Log(title = "AI 命令规则", businessType = BusinessType.UPDATE)
    @PutMapping("/command")
    public AjaxResult commandEdit(@RequestBody ItmCommandRule rule)
    {
        policyService.validate(rule);
        rule.setUpdateBy(getUsername());
        return toAjax(commandMapper.updateItmCommandRule(rule));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:remove')")
    @Log(title = "AI 命令规则", businessType = BusinessType.DELETE)
    @DeleteMapping("/command/{ruleIds}")
    public AjaxResult commandRemove(@PathVariable Long[] ruleIds)
    {
        return toAjax(commandMapper.deleteItmCommandRuleByIds(ruleIds));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:list')")
    @GetMapping("/mask/list")
    public TableDataInfo maskList(ItmMaskRule query)
    {
        startPage();
        return getDataTable(maskMapper.selectItmMaskRuleList(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:list')")
    @GetMapping("/mask/{ruleId}")
    public AjaxResult maskInfo(@PathVariable Long ruleId)
    {
        return success(maskMapper.selectItmMaskRuleById(ruleId));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:add')")
    @Log(title = "AI 脱敏规则", businessType = BusinessType.INSERT)
    @PostMapping("/mask")
    public AjaxResult maskAdd(@RequestBody ItmMaskRule rule)
    {
        policyService.validate(rule);
        rule.setCreateBy(getUsername());
        return toAjax(maskMapper.insertItmMaskRule(rule));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:edit')")
    @Log(title = "AI 脱敏规则", businessType = BusinessType.UPDATE)
    @PutMapping("/mask")
    public AjaxResult maskEdit(@RequestBody ItmMaskRule rule)
    {
        policyService.validate(rule);
        rule.setUpdateBy(getUsername());
        return toAjax(maskMapper.updateItmMaskRule(rule));
    }

    @PreAuthorize("@ss.hasPermi('itm:rule:remove')")
    @Log(title = "AI 脱敏规则", businessType = BusinessType.DELETE)
    @DeleteMapping("/mask/{ruleIds}")
    public AjaxResult maskRemove(@PathVariable Long[] ruleIds)
    {
        return toAjax(maskMapper.deleteItmMaskRuleByIds(ruleIds));
    }
}
