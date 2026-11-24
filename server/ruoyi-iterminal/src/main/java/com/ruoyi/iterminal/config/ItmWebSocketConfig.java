package com.ruoyi.iterminal.config;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import com.ruoyi.iterminal.ws.ClientWsHandler;
import com.ruoyi.iterminal.ws.TicketHandshakeInterceptor;

/**
 * 客户端长连接：/ws/client?ticket=…（桌面客户端从主进程连接，没有浏览器 Origin，不限制来源）。
 */
@Configuration
@EnableWebSocket
public class ItmWebSocketConfig implements WebSocketConfigurer
{
    @Autowired
    private ClientWsHandler handler;

    @Autowired
    private TicketHandshakeInterceptor interceptor;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry)
    {
        registry.addHandler(handler, "/ws/client").addInterceptors(interceptor).setAllowedOriginPatterns("*");
    }
}
