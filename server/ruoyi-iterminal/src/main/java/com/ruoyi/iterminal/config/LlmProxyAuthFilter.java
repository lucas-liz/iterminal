package com.ruoyi.iterminal.config;

import java.io.IOException;
import java.util.Collections;
import java.util.Enumeration;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * 大模型代理的鉴权：Anthropic 的 SDK 把 Key（这里是登录令牌）放在 x-api-key 头里，
 * 在进入 Spring Security 之前把它转成 Authorization: Bearer，后面按普通的登录令牌校验。
 */
@Configuration
public class LlmProxyAuthFilter
{
    @Bean
    public FilterRegistrationBean<OncePerRequestFilter> llmProxyAuth()
    {
        FilterRegistrationBean<OncePerRequestFilter> reg = new FilterRegistrationBean<>(new OncePerRequestFilter()
        {
            @Override
            protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException
            {
                String apiKey = req.getHeader("x-api-key");
                if (apiKey == null || apiKey.isBlank() || req.getHeader("Authorization") != null)
                {
                    chain.doFilter(req, res);
                    return;
                }
                String bearer = "Bearer " + apiKey.trim();
                chain.doFilter(new HttpServletRequestWrapper(req)
                {
                    @Override
                    public String getHeader(String name)
                    {
                        return "Authorization".equalsIgnoreCase(name) ? bearer : super.getHeader(name);
                    }

                    @Override
                    public Enumeration<String> getHeaders(String name)
                    {
                        return "Authorization".equalsIgnoreCase(name) ? Collections.enumeration(java.util.List.of(bearer)) : super.getHeaders(name);
                    }
                }, res);
            }
        });
        reg.addUrlPatterns("/api/v1/llm/proxy/*");
        reg.setOrder(Ordered.HIGHEST_PRECEDENCE);
        reg.setName("itmLlmProxyAuth");
        return reg;
    }
}
