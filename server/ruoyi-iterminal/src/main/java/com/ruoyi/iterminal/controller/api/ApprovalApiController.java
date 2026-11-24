package com.ruoyi.iterminal.controller.api;

import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.domain.ItmApproval;
import com.ruoyi.iterminal.service.ItmApprovalService;
import com.ruoyi.iterminal.service.ItmDeviceContext;

/**
 * 远程审批：执行器创建审批；审批人查看待审批、批准 / 拒绝（也可以走长连接 approval.decide）。
 */
@RestController
@RequestMapping("/api/v1")
public class ApprovalApiController
{
    @Autowired
    private ItmApprovalService approvalService;

    @Autowired
    private ItmDeviceContext deviceContext;

    @PostMapping("/sched/runs/{runId}/approvals")
    public ApiResult<Map<String, Object>> create(@PathVariable String runId, @RequestBody Map<String, Object> body)
    {
        return ApiResult.ok(approvalService.create(deviceContext.currentDevice().getDeviceId(), runId, body));
    }

    @GetMapping("/approvals")
    public ApiResult<List<ItmApproval>> pending()
    {
        deviceContext.currentDevice();
        if (!SecurityUtils.hasPermi(ItmApprovalService.PERM))
        {
            throw ApiException.forbidden("没有审批权限");
        }
        return ApiResult.ok(approvalService.pending());
    }

    @PostMapping("/approvals/{approvalId}:decide")
    public ApiResult<Void> decide(@PathVariable String approvalId, @RequestBody Map<String, Object> body)
    {
        deviceContext.currentDevice();
        LoginUser user = SecurityUtils.getLoginUser();
        approvalService.decide(approvalId, String.valueOf(body.get("decision")), body.get("comment") == null ? null : String.valueOf(body.get("comment")), user.getUsername(), user.getPermissions());
        return ApiResult.ok(null);
    }
}
