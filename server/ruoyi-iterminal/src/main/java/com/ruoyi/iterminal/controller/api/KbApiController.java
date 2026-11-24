package com.ruoyi.iterminal.controller.api;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.fasterxml.jackson.databind.JsonNode;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.service.ItmDeviceContext;
import com.ruoyi.iterminal.service.ItmKbService;

/**
 * 客户端：知识库检索（Agent 的 kb_search 工具，文档一 6.9）
 */
@RestController
@RequestMapping("/api/v1/kb")
public class KbApiController
{
    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ItmKbService kb;

    @GetMapping("/collections")
    public ApiResult<List<Map<String, Object>>> collections()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(kb.visibleCollections(SecurityUtils.getLoginUser()));
    }

    /** {query, collectionIds?, topK?} → [{title, section, content, score, source}] */
    @PostMapping("/search")
    public ApiResult<List<Map<String, Object>>> search(@RequestBody JsonNode body)
    {
        deviceContext.currentDevice();
        List<Long> ids = new ArrayList<>();
        body.path("collectionIds").forEach(n -> ids.add(n.asLong()));
        return ApiResult.ok(kb.search(SecurityUtils.getLoginUser(), body.path("query").asText(""), ids, body.path("topK").asInt(5)));
    }
}
