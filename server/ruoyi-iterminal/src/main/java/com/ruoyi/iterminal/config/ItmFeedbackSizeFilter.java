package com.ruoyi.iterminal.config;

import java.io.IOException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 问题反馈的请求体大小（第十三轮）：在解析 multipart 之前按 Content-Length 拒绝过大的请求。
 * 全局的上传上限是 1GB（安装包），反馈最多 6 张 5MB 的图片 + 6MB 诊断包，40MB 足够；匿名接口不接受没有 Content-Length 的请求。
 */
@Configuration
public class ItmFeedbackSizeFilter
{
    public static final long MAX_BYTES = 40L * 1024 * 1024;

    @Bean
    public FilterRegistrationBean<OncePerRequestFilter> itmFeedbackSize()
    {
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter()
        {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException
            {
                if ("POST".equalsIgnoreCase(req.getMethod()))
                {
                    long len = req.getContentLengthLong();
                    boolean anonymous = req.getRequestURI().endsWith("/public/feedback");
                    if (len > MAX_BYTES || (anonymous && len < 0))
                    {
                        res.setStatus(len > MAX_BYTES ? 413 : 411);
                        res.setContentType("application/json;charset=UTF-8");
                        res.getWriter().write(len > MAX_BYTES ? "{\"code\":413,\"message\":\"反馈太大了（截图和诊断信息合计不能超过 40MB）\"}" : "{\"code\":411,\"message\":\"缺少 Content-Length\"}");
                        return;
                    }
                }
                chain.doFilter(req, res);
            }
        });
        reg.addUrlPatterns("/api/v1/feedback", "/api/v1/public/feedback");
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE + 1);
        reg.setName("itmFeedbackSize");
        return reg;
    }
}
