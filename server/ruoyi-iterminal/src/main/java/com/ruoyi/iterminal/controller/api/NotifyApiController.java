package com.ruoyi.iterminal.controller.api;

import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.core.domain.entity.SysUser;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.service.ItmDeviceContext;
import com.ruoyi.iterminal.service.ItmNotifyService;
import com.ruoyi.system.service.ISysUserService;

/**
 * 客户端：发邮件给当前登录用户自己（第二十八轮）。告警、定时任务报告、AI 自动排查的结果由客户端调用，
 * 收件人固定是用户资料里的邮箱（不能指定别人）；没有填邮箱或服务端没有配置邮件服务器时不发，返回原因。
 */
@RestController
@RequestMapping("/api/v1")
public class NotifyApiController
{
    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ItmNotifyService notifyService;

    @Autowired
    private ISysUserService userService;

    public record MailMe(String subject, String text) {}

    @PostMapping("/notify/mail-me")
    public ApiResult<Map<String, String>> mailMe(@RequestBody MailMe body)
    {
        deviceContext.currentDevice();
        Long userId = SecurityUtils.getUserId();
        SysUser user = userService.selectUserById(userId);
        String email = user == null ? null : user.getEmail();
        String status = notifyService.mailToUser(userId, email, body == null ? "" : body.subject(), body == null ? "" : body.text());
        return ApiResult.ok(Map.of("status", status));
    }
}
