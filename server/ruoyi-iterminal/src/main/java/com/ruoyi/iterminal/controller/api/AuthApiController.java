package com.ruoyi.iterminal.controller.api;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.annotation.Anonymous;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.api.dto.AuthDtos.LoginBody;
import com.ruoyi.iterminal.api.dto.AuthDtos.LoginResult;
import com.ruoyi.iterminal.api.dto.AuthDtos.RefreshBody;
import com.ruoyi.iterminal.service.ItmAuthService;
import com.ruoyi.iterminal.service.ItmDeviceContext;

/**
 * 客户端登录：账号密码登录、刷新令牌、退出登录。
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthApiController
{
    @Autowired
    private ItmAuthService authService;

    @Autowired
    private ItmDeviceContext deviceContext;

    @Anonymous
    @PostMapping("/login")
    public ApiResult<LoginResult> login(@RequestBody LoginBody body)
    {
        return ApiResult.ok(authService.login(body));
    }

    @Anonymous
    @PostMapping("/refresh")
    public ApiResult<LoginResult> refresh(@RequestBody RefreshBody body)
    {
        return ApiResult.ok(authService.refresh(body));
    }

    @PostMapping("/logout")
    public ApiResult<Void> logout()
    {
        authService.logout(deviceContext.currentDevice());
        return ApiResult.ok(null);
    }
}
