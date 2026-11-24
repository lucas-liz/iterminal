package com.ruoyi.iterminal.service;

import java.util.concurrent.TimeUnit;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.core.redis.RedisCache;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.common.utils.ServletUtils;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.framework.web.service.TokenService;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;

/**
 * 登录令牌和设备的对应关系：客户端登录 / 刷新时绑定，接口里用它判断「是哪台设备在调用」。
 * Redis：itm:token:device:{令牌 uuid} = 设备ID；itm:device:token:{设备ID} = 令牌 uuid（吊销设备时用来让令牌失效）。
 */
@Component
public class ItmDeviceContext
{
    private static final String TOKEN_DEVICE = "itm:token:device:";
    private static final String DEVICE_TOKEN = "itm:device:token:";
    /** 映射保留和刷新令牌一样久（令牌本身过期后映射没有用处，也不会被误用） */
    private static final int TTL_DAYS = 30;

    @Autowired
    private RedisCache redisCache;

    @Autowired
    private TokenService tokenService;

    @Autowired
    private ItmDeviceMapper deviceMapper;

    /** 把刚签发的登录令牌绑定到设备；同一设备之前的令牌作废 */
    public void bind(LoginUser user, String deviceId)
    {
        String old = redisCache.getCacheObject(DEVICE_TOKEN + deviceId);
        if (StringUtils.isNotEmpty(old) && !old.equals(user.getToken()))
        {
            tokenService.delLoginUser(old);
            redisCache.deleteObject(TOKEN_DEVICE + old);
        }
        redisCache.setCacheObject(TOKEN_DEVICE + user.getToken(), deviceId, TTL_DAYS, TimeUnit.DAYS);
        redisCache.setCacheObject(DEVICE_TOKEN + deviceId, user.getToken(), TTL_DAYS, TimeUnit.DAYS);
    }

    /** 让设备当前的登录令牌失效（退出登录、吊销设备） */
    public void unbind(String deviceId)
    {
        String token = redisCache.getCacheObject(DEVICE_TOKEN + deviceId);
        if (StringUtils.isNotEmpty(token))
        {
            tokenService.delLoginUser(token);
            redisCache.deleteObject(TOKEN_DEVICE + token);
        }
        redisCache.deleteObject(DEVICE_TOKEN + deviceId);
    }

    /** 当前请求来自哪台设备：必须是客户端登录签发的令牌，且设备没有被吊销 */
    public ItmDevice currentDevice()
    {
        LoginUser user = SecurityUtils.getLoginUser();
        String deviceId = redisCache.getCacheObject(TOKEN_DEVICE + user.getToken());
        HttpServletRequest request = ServletUtils.getRequest();
        String header = request == null ? null : request.getHeader("X-Device-Id");
        if (StringUtils.isEmpty(deviceId))
        {
            throw ApiException.forbidden("这个接口只能由 iTerminal 客户端调用（请在客户端里登录）");
        }
        if (StringUtils.isNotEmpty(header) && !header.equals(deviceId))
        {
            throw ApiException.forbidden("设备标识和登录令牌不一致");
        }
        ItmDevice device = deviceMapper.selectItmDeviceById(deviceId);
        if (device == null || !"0".equals(device.getStatus()) || !user.getUserId().equals(device.getUserId()))
        {
            throw ApiException.unauthorized("设备已被吊销，请重新登录");
        }
        return device;
    }
}
