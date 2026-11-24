package com.ruoyi.iterminal.controller.api;

import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.api.dto.AuthDtos.MeInfo;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;
import com.ruoyi.iterminal.service.ItmAuthService;
import com.ruoyi.iterminal.service.ItmDeviceContext;
import com.ruoyi.iterminal.service.ItmPolicyService;
import com.ruoyi.iterminal.ws.WsTicketService;

/**
 * 当前用户、我的设备、长连接票据、AI 策略。
 */
@RestController
@RequestMapping("/api/v1")
public class MeApiController
{
    @Autowired
    private ItmAuthService authService;

    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ItmDeviceMapper deviceMapper;

    @Autowired
    private WsTicketService tickets;

    @Autowired
    private ItmPolicyService policyService;

    @GetMapping("/me")
    public ApiResult<MeInfo> me()
    {
        ItmDevice device = deviceContext.currentDevice();
        LoginUser user = SecurityUtils.getLoginUser();
        return ApiResult.ok(authService.me(user, device.getDeviceId()));
    }

    @GetMapping("/devices")
    public ApiResult<List<ItmDevice>> devices()
    {
        ItmDevice q = new ItmDevice();
        q.setUserId(SecurityUtils.getUserId());
        return ApiResult.ok(deviceMapper.selectItmDeviceList(q));
    }

    /** 长连接的一次性票据（30 秒有效） */
    @GetMapping("/ws/ticket")
    public ApiResult<Map<String, String>> ticket()
    {
        ItmDevice device = deviceContext.currentDevice();
        return ApiResult.ok(Map.of("ticket", tickets.issue(device.getUserId(), device.getUserName(), device.getDeviceId())));
    }

    @GetMapping("/ai/policy")
    public ApiResult<Map<String, Object>> policy()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(policyService.policy());
    }
}
