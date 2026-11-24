package com.ruoyi.iterminal.api.dto;

import java.util.List;
import java.util.Set;

/**
 * 客户端登录相关的请求和响应。
 */
public final class AuthDtos
{
    private AuthDtos()
    {
    }

    /** 账号密码登录（客户端没有图形验证码；密码连续错误会按若依的设置锁定账号） */
    public record LoginBody(String username, String password, String deviceId, String deviceName, String os, String arch, String clientVersion)
    {
    }

    /** 用刷新令牌换新的登录令牌（刷新令牌每次使用后轮换） */
    public record RefreshBody(String deviceId, String refreshToken)
    {
    }

    /**
     * @param avatar 头像地址（若依的 /profile/avatar/... 相对路径，没有上传时为空）；客户端登录后取回缓存在本机
     */
    public record MeInfo(Long userId, String userName, String nickName, String email, String avatar, List<String> roles, Set<String> permissions, String deviceId)
    {
    }

    /**
     * @param accessToken  请求接口用的令牌（Authorization: Bearer），一段时间不用会过期
     * @param refreshToken 刷新令牌：只返回这一次，客户端加密保存；30 天有效，每次刷新后换新的
     * @param expiresIn    访问令牌的有效期（秒，有请求时自动延长）
     */
    public record LoginResult(String accessToken, String refreshToken, long expiresIn, MeInfo user)
    {
    }
}
