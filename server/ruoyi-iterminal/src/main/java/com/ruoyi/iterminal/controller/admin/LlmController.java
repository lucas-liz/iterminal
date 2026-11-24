package com.ruoyi.iterminal.controller.admin;

import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.core.page.TableDataInfo;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.iterminal.domain.ItmLlmProvider;
import com.ruoyi.iterminal.domain.ItmLlmUsage;
import com.ruoyi.iterminal.mapper.ItmLlmProviderMapper;
import com.ruoyi.iterminal.mapper.ItmLlmUsageMapper;
import com.ruoyi.iterminal.service.ItmLlmService;
import com.ruoyi.iterminal.service.ItmWebSearchService;
import com.ruoyi.system.service.ISysRoleService;

/**
 * 管理后台：团队模型（提供商、API Key、模型列表、可用角色）和用量统计
 */
@RestController
@RequestMapping("/iterminal/llm")
public class LlmController extends BaseController
{
    @Autowired
    private ItmLlmProviderMapper providerMapper;

    @Autowired
    private ItmLlmUsageMapper usageMapper;

    @Autowired
    private ItmLlmService llmService;

    @Autowired
    private ISysRoleService roleService;

    @Autowired
    private ItmWebSearchService webSearchService;

    /** 联网搜索的配置（第二十五轮）：和团队模型无关，Key 显示为 ****** */
    @PreAuthorize("@ss.hasPermi('itm:llm:list')")
    @GetMapping("/web")
    public AjaxResult webConfig()
    {
        return success(webSearchService.adminView());
    }

    /** 保存联网搜索的配置：{enabled, format, baseUrl, searchUrl, fetchUrl, apiKey（****** 表示不修改）, count, label, dailyLimit} */
    @PreAuthorize("@ss.hasPermi('itm:llm:edit')")
    @Log(title = "联网搜索", businessType = BusinessType.UPDATE)
    @PutMapping("/web")
    public AjaxResult saveWeb(@RequestBody Map<String, Object> body)
    {
        webSearchService.save(body, getUsername());
        return success();
    }

    /** 用表单里的配置搜一次（不保存） */
    @PreAuthorize("@ss.hasPermi('itm:llm:test')")
    @PostMapping("/web/test")
    public AjaxResult testWeb(@RequestBody Map<String, Object> body)
    {
        return success(webSearchService.test(body));
    }

    /** 「可以使用的角色」下拉框：角色名称和权限字符 */
    @PreAuthorize("@ss.hasPermi('itm:llm:list')")
    @GetMapping("/roles")
    public AjaxResult roles()
    {
        return success(roleService.selectRoleAll().stream().filter(r -> "0".equals(r.getStatus())).map(r -> Map.of("roleKey", r.getRoleKey(), "roleName", r.getRoleName())).toList());
    }

    @PreAuthorize("@ss.hasPermi('itm:llm:list')")
    @GetMapping("/provider/list")
    public TableDataInfo list(ItmLlmProvider query)
    {
        startPage();
        List<ItmLlmProvider> list = providerMapper.selectItmLlmProviderList(query);
        list.forEach(llmService::masked);
        return getDataTable(list);
    }

    @PreAuthorize("@ss.hasPermi('itm:llm:list')")
    @GetMapping("/provider/{providerId}")
    public AjaxResult getInfo(@PathVariable Long providerId)
    {
        return success(llmService.masked(providerMapper.selectItmLlmProviderById(providerId)));
    }

    @PreAuthorize("@ss.hasPermi('itm:llm:add')")
    @Log(title = "团队模型", businessType = BusinessType.INSERT)
    @PostMapping("/provider")
    public AjaxResult add(@RequestBody ItmLlmProvider p)
    {
        p.setProviderId(null);
        return toAjax(llmService.save(p, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:llm:edit')")
    @Log(title = "团队模型", businessType = BusinessType.UPDATE)
    @PutMapping("/provider")
    public AjaxResult edit(@RequestBody ItmLlmProvider p)
    {
        return toAjax(llmService.save(p, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:llm:remove')")
    @Log(title = "团队模型", businessType = BusinessType.DELETE)
    @DeleteMapping("/provider/{providerIds}")
    public AjaxResult remove(@PathVariable Long[] providerIds)
    {
        return toAjax(providerMapper.deleteItmLlmProviderByIds(providerIds));
    }

    /** 测试连接（可以用还没保存的表单） */
    @PreAuthorize("@ss.hasPermi('itm:llm:test')")
    @PostMapping("/provider/test")
    public AjaxResult test(@RequestBody ItmLlmProvider p, @RequestParam(required = false) String model)
    {
        return success(llmService.test(p, model));
    }

    /** 从上游拉取模型 ID */
    @PreAuthorize("@ss.hasPermi('itm:llm:test')")
    @PostMapping("/provider/fetchModels")
    public AjaxResult fetchModels(@RequestBody ItmLlmProvider p)
    {
        return success(llmService.fetchModelIds(p));
    }

    @PreAuthorize("@ss.hasPermi('itm:llm:list')")
    @GetMapping("/usage/list")
    public TableDataInfo usage(ItmLlmUsage query)
    {
        startPage();
        return getDataTable(usageMapper.selectItmLlmUsageList(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:llm:list')")
    @GetMapping("/usage/summary")
    public TableDataInfo summary(ItmLlmUsage query)
    {
        startPage();
        List<Map<String, Object>> rows = usageMapper.selectSummary(query);
        return getDataTable(rows);
    }
}
