package com.ruoyi.iterminal.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.HexFormat;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.authentication.AuthenticationManager;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import com.ruoyi.common.constant.Constants;
import com.ruoyi.common.core.domain.entity.SysRole;
import com.ruoyi.common.core.domain.entity.SysUser;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.MessageUtils;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.common.utils.ip.IpUtils;
import com.ruoyi.framework.manager.AsyncManager;
import com.ruoyi.framework.manager.factory.AsyncFactory;
import com.ruoyi.framework.security.context.AuthenticationContextHolder;
import com.ruoyi.framework.web.service.SysLoginService;
import com.ruoyi.framework.web.service.TokenService;
import com.ruoyi.framework.web.service.UserDetailsServiceImpl;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.api.dto.AuthDtos.LoginBody;
import com.ruoyi.iterminal.api.dto.AuthDtos.LoginResult;
import com.ruoyi.iterminal.api.dto.AuthDtos.MeInfo;
import com.ruoyi.iterminal.api.dto.AuthDtos.RefreshBody;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;
import com.ruoyi.system.service.ISysUserService;

/**
 * 桌面客户端登录：用若依的账号体系认证（密码错误次数限制、IP 黑名单、登录日志都沿用），
 * 同时登记设备、签发设备专用的刷新令牌（只保存 SHA-256），客户端用它在令牌过期后换新令牌，不需要再输入密码。
 */
@Service
public class ItmAuthService
{
    /** 设备ID：客户端生成的 UUID */
    private static final Pattern DEVICE_ID = Pattern.compile("^[A-Za-z0-9-]{8,64}$");
    private static final long REFRESH_DAYS = 30;
    private static final SecureRandom RANDOM = new SecureRandom();

    @Autowired
    private SysLoginService loginService;

    @Autowired
    private AuthenticationManager authenticationManager;

    @Autowired
    private TokenService tokenService;

    @Autowired
    private UserDetailsServiceImpl userDetailsService;

    @Autowired
    private ISysUserService userService;

    @Autowired
    private ItmDeviceMapper deviceMapper;

    @Autowired
    private ItmDeviceContext deviceContext;

    @Value("${token.expireTime}")
    private int expireMinutes;

    public LoginResult login(LoginBody body)
    {
        if (body == null)
        {
            throw ApiException.badRequest("请填写账号和密码");
        }
        checkDeviceId(body.deviceId());
        String username = StringUtils.trim(body.username());
        // 空账号、长度、IP 黑名单（若依的登录前置校验）
        loginService.loginPreCheck(username, body.password());
        Authentication authentication;
        try
        {
            UsernamePasswordAuthenticationToken token = new UsernamePasswordAuthenticationToken(username, body.password());
            AuthenticationContextHolder.setContext(token);
            // 调用 UserDetailsServiceImpl：校验密码、错误次数、账号状态
            authentication = authenticationManager.authenticate(token);
        }
        catch (Exception e)
        {
            if (e instanceof BadCredentialsException)
            {
                AsyncManager.me().execute(AsyncFactory.recordLogininfor(username, Constants.LOGIN_FAIL, MessageUtils.message("user.password.not.match")));
                throw ApiException.unauthorized("账号或密码不正确");
            }
            AsyncManager.me().execute(AsyncFactory.recordLogininfor(username, Constants.LOGIN_FAIL, e.getMessage()));
            throw ApiException.unauthorized(StringUtils.isNotEmpty(e.getMessage()) ? e.getMessage() : "登录失败");
        }
        finally
        {
            AuthenticationContextHolder.clearContext();
        }
        AsyncManager.me().execute(AsyncFactory.recordLogininfor(username, Constants.LOGIN_SUCCESS, "iTerminal 客户端登录"));
        LoginUser loginUser = (LoginUser) authentication.getPrincipal();
        loginService.recordLoginInfo(loginUser.getUserId());

        String refresh = newRefreshToken();
        ItmDevice device = new ItmDevice();
        device.setDeviceId(body.deviceId());
        device.setUserId(loginUser.getUserId());
        device.setUserName(loginUser.getUsername());
        device.setDeviceName(StringUtils.substring(StringUtils.nvl(body.deviceName(), ""), 0, 100));
        device.setOs(StringUtils.substring(StringUtils.nvl(body.os(), ""), 0, 20));
        device.setArch(StringUtils.substring(StringUtils.nvl(body.arch(), ""), 0, 20));
        device.setClientVersion(StringUtils.substring(StringUtils.nvl(body.clientVersion(), ""), 0, 40));
        device.setRefreshTokenHash(sha256(refresh));
        device.setRefreshExpiresAt(new Date(System.currentTimeMillis() + REFRESH_DAYS * 86_400_000L));
        device.setLastIp(IpUtils.getIpAddr());
        ItmDevice existing = deviceMapper.selectItmDeviceById(body.deviceId());
        if (existing != null && "1".equals(existing.getStatus()) && existing.getUserId().equals(loginUser.getUserId()))
        {
            // 被管理员吊销的设备：同一个账号重新输入密码登录后恢复（换账号登录也会重新登记）
            AsyncManager.me().execute(AsyncFactory.recordLogininfor(username, Constants.LOGIN_SUCCESS, "已吊销的设备重新登录：" + body.deviceId()));
        }
        deviceMapper.upsertItmDevice(device);
        return issue(loginUser, body.deviceId(), refresh);
    }

    public LoginResult refresh(RefreshBody body)
    {
        if (body == null || StringUtils.isEmpty(body.refreshToken()))
        {
            throw ApiException.badRequest("缺少刷新令牌");
        }
        checkDeviceId(body.deviceId());
        ItmDevice device = deviceMapper.selectItmDeviceById(body.deviceId());
        if (device == null || StringUtils.isEmpty(device.getRefreshTokenHash()) || !MessageDigest.isEqual(device.getRefreshTokenHash().getBytes(StandardCharsets.UTF_8), sha256(body.refreshToken()).getBytes(StandardCharsets.UTF_8)))
        {
            throw ApiException.unauthorized("登录已失效，请重新登录");
        }
        if (!"0".equals(device.getStatus()))
        {
            throw ApiException.unauthorized("这台设备已被管理员吊销，请重新登录");
        }
        if (device.getRefreshExpiresAt() == null || device.getRefreshExpiresAt().before(new Date()))
        {
            throw ApiException.unauthorized("登录已超过 30 天，请重新登录");
        }
        SysUser user = userService.selectUserById(device.getUserId());
        if (user == null || !"0".equals(user.getStatus()) || !"0".equals(user.getDelFlag()))
        {
            throw ApiException.unauthorized("账号已停用或已删除");
        }
        LoginUser loginUser = (LoginUser) userDetailsService.createLoginUser(user);
        String refresh = newRefreshToken();
        ItmDevice update = new ItmDevice();
        update.setDeviceId(device.getDeviceId());
        update.setRefreshTokenHash(sha256(refresh));
        update.setRefreshExpiresAt(new Date(System.currentTimeMillis() + REFRESH_DAYS * 86_400_000L));
        update.setLastIp(IpUtils.getIpAddr());
        update.setLastSeenAt(new Date());
        deviceMapper.updateItmDevice(update);
        return issue(loginUser, device.getDeviceId(), refresh);
    }

    /** 退出登录：令牌和刷新令牌都作废 */
    public void logout(ItmDevice device)
    {
        deviceContext.unbind(device.getDeviceId());
        ItmDevice update = new ItmDevice();
        update.setDeviceId(device.getDeviceId());
        update.setRefreshTokenHash("");
        deviceMapper.updateItmDevice(update);
    }

    public MeInfo me(LoginUser loginUser, String deviceId)
    {
        SysUser user = loginUser.getUser();
        List<String> roles = new ArrayList<>();
        if (user.getRoles() != null)
        {
            for (SysRole r : user.getRoles())
            {
                roles.add(r.getRoleKey());
            }
        }
        return new MeInfo(user.getUserId(), user.getUserName(), user.getNickName(), user.getEmail(), user.getAvatar(), roles, loginUser.getPermissions(), deviceId);
    }

    private LoginResult issue(LoginUser loginUser, String deviceId, String refresh)
    {
        String access = tokenService.createToken(loginUser);
        deviceContext.bind(loginUser, deviceId);
        return new LoginResult(access, refresh, expireMinutes * 60L, me(loginUser, deviceId));
    }

    private static void checkDeviceId(String deviceId)
    {
        if (deviceId == null || !DEVICE_ID.matcher(deviceId).matches())
        {
            throw ApiException.badRequest("设备标识不正确");
        }
    }

    private static String newRefreshToken()
    {
        byte[] b = new byte[32];
        RANDOM.nextBytes(b);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }

    static String sha256(String s)
    {
        try
        {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        }
        catch (NoSuchAlgorithmException e)
        {
            throw new ServiceException("SHA-256 不可用");
        }
    }
}
