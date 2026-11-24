package com.ruoyi.iterminal.ws;

import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;

/**
 * 握手校验：/ws/client?ticket=…，票据有效且设备没有被吊销才允许连接。
 */
@Component
public class TicketHandshakeInterceptor implements HandshakeInterceptor
{
    @Autowired
    private WsTicketService tickets;

    @Autowired
    private ItmDeviceMapper deviceMapper;

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Map<String, Object> attributes)
    {
        String ticket = UriComponentsBuilder.fromUri(request.getURI()).build().getQueryParams().getFirst("ticket");
        WsTicketService.Ticket t = tickets.consume(ticket);
        if (t == null)
        {
            response.setStatusCode(HttpStatus.UNAUTHORIZED);
            return false;
        }
        ItmDevice device = deviceMapper.selectItmDeviceById(t.deviceId());
        if (device == null || !"0".equals(device.getStatus()) || !t.userId().equals(device.getUserId()))
        {
            response.setStatusCode(HttpStatus.FORBIDDEN);
            return false;
        }
        attributes.put(ClientWsHandler.ATTR_USER_ID, t.userId());
        attributes.put(ClientWsHandler.ATTR_USER_NAME, t.userName());
        attributes.put(ClientWsHandler.ATTR_DEVICE_ID, t.deviceId());
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response, WebSocketHandler wsHandler, Exception exception)
    {
    }
}
