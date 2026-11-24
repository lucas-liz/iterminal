package com.ruoyi.framework.security.handle;

import java.io.IOException;
import java.io.Serializable;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;
import com.alibaba.fastjson2.JSON;
import com.ruoyi.common.constant.HttpStatus;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.utils.ServletUtils;
import com.ruoyi.common.utils.StringUtils;

/**
 * 认证失败处理类 返回未授权
 * 
 * @author ruoyi
 */
@Component
public class AuthenticationEntryPointImpl implements AuthenticationEntryPoint, Serializable
{
    private static final long serialVersionUID = -8970718410437077606L;

    @Override
    public void commence(HttpServletRequest request, HttpServletResponse response, AuthenticationException e)
            throws IOException
    {
        int code = HttpStatus.UNAUTHORIZED;
        // iTerminal 客户端接口：按 HTTP 状态码判断，返回真正的 401 和 {code, message, data}（客户端据此用刷新令牌换新令牌）
        if (request.getRequestURI().startsWith("/api/v1/"))
        {
            // 不能用 ServletUtils.renderString：它会把状态码改回 200
            response.setStatus(code);
            response.setContentType("application/json");
            response.setCharacterEncoding("utf-8");
            response.getWriter().print("{\"code\":401,\"message\":\"登录已过期，请重新登录\",\"data\":null}");
            return;
        }
        String msg = StringUtils.format("请求访问：{}，认证失败，无法访问系统资源", request.getRequestURI());
        ServletUtils.renderString(response, JSON.toJSONString(AjaxResult.error(code, msg)));
    }
}
