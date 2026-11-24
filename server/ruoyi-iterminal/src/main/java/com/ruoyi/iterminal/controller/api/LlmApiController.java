package com.ruoyi.iterminal.controller.api;

import java.util.List;
import java.util.Map;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.service.ItmDeviceContext;
import com.ruoyi.iterminal.service.ItmLlmService;
import com.ruoyi.iterminal.service.ItmWebSearchService;

/**
 * 客户端：团队模型列表、大模型代理（文档二 5.5）、联网搜索（第二十五轮，文档二 5.5.4）
 */
@RestController
@RequestMapping("/api/v1")
public class LlmApiController
{
    private static final String PREFIX = "/api/v1/llm/proxy/";

    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ItmLlmService llmService;

    @Autowired
    private ItmWebSearchService webSearchService;

    /** 管理员配置的默认联网搜索（不含 Key）；没配置时 {enabled: false} */
    @GetMapping("/ai/web")
    public ApiResult<Map<String, Object>> web()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(webSearchService.clientInfo());
    }

    /** 联网搜索：{query, count} → {results: [{title, url, site_name, date, snippet, summary}]}（DeepSeek 的格式） */
    @PostMapping("/ai/web/search")
    public ApiResult<Map<String, Object>> webSearch(@RequestBody Map<String, Object> body)
    {
        deviceContext.currentDevice();
        return ApiResult.ok(webSearchService.search(body, SecurityUtils.getLoginUser()));
    }

    /** 读取网页：{url} → {title, content} */
    @PostMapping("/ai/web/fetch")
    public ApiResult<Map<String, Object>> webFetch(@RequestBody Map<String, Object> body)
    {
        deviceContext.currentDevice();
        return ApiResult.ok(webSearchService.fetch(body, SecurityUtils.getLoginUser()));
    }

    /** 当前用户可以用的团队模型（不含 Key） */
    @GetMapping("/ai/models")
    public ApiResult<List<Map<String, Object>>> models()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(llmService.modelsFor(SecurityUtils.getLoginUser()));
    }

    /** OpenAI / Anthropic 兼容的转发接口：{服务端}/api/v1/llm/proxy/{提供商ID}/chat/completions、/v1/messages 等 */
    @RequestMapping(value = "/llm/proxy/{providerId}/**", method = { RequestMethod.GET, RequestMethod.POST })
    public void proxy(@PathVariable String providerId, HttpServletRequest req, HttpServletResponse res) throws Exception
    {
        ItmDevice device = deviceContext.currentDevice();
        String uri = req.getRequestURI();
        int i = uri.indexOf(PREFIX);
        String rest = i < 0 ? "" : uri.substring(i + PREFIX.length());
        int slash = rest.indexOf('/');
        String sub = slash < 0 ? "" : rest.substring(slash + 1);
        Long id;
        try
        {
            id = Long.valueOf(providerId);
        }
        catch (NumberFormatException e)
        {
            id = null;
        }
        llmService.proxy(id, sub.replaceAll("/+$", ""), req, res, SecurityUtils.getLoginUser(), device);
    }
}
