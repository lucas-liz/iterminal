package com.ruoyi.iterminal.controller.api;

import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.service.ItmAuditService;
import com.ruoyi.iterminal.service.ItmDeviceContext;

/**
 * 审计上报：命令 / 安全事件批量上报，会话录像分片上传。
 */
@RestController
@RequestMapping("/api/v1/audit")
public class AuditApiController
{
    @Autowired
    private ItmAuditService auditService;

    @Autowired
    private ItmDeviceContext deviceContext;

    @PostMapping("/commands:batch")
    public ApiResult<Map<String, Integer>> commands(@RequestBody Map<String, Object> body)
    {
        return ApiResult.ok(Map.of("accepted", auditService.uploadCommands(deviceContext.currentDevice(), body.get("items"))));
    }

    @PostMapping("/sessions/{recordingId}/chunks")
    public ApiResult<Void> chunk(@PathVariable String recordingId, @RequestBody Map<String, Object> body)
    {
        auditService.uploadChunk(deviceContext.currentDevice(), recordingId, body);
        return ApiResult.ok(null);
    }
}
