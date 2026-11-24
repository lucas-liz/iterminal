package com.ruoyi.iterminal.ws;

import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import com.ruoyi.common.core.redis.RedisCache;

/**
 * WebSocket 一次性票据（文档二 7.1）：REST 接口签发，30 秒内有效，只能用一次。
 */
@Component
public class WsTicketService
{
    private static final String KEY = "itm:ws:ticket:";

    /** 票据对应的连接身份 */
    public record Ticket(Long userId, String userName, String deviceId)
    {
    }

    @Autowired
    private RedisCache redisCache;

    public String issue(Long userId, String userName, String deviceId)
    {
        String ticket = UUID.randomUUID().toString().replace("-", "");
        redisCache.setCacheObject(KEY + ticket, userId + "|" + deviceId + "|" + userName, 30, TimeUnit.SECONDS);
        return ticket;
    }

    /** 取出并删除；不存在或已用过返回 null */
    @SuppressWarnings("unchecked")
    public Ticket consume(String ticket)
    {
        if (ticket == null || !ticket.matches("^[a-f0-9]{32}$"))
        {
            return null;
        }
        Object v = redisCache.redisTemplate.opsForValue().getAndDelete(KEY + ticket);
        if (!(v instanceof String s))
        {
            return null;
        }
        String[] p = s.split("\\|", 3);
        if (p.length < 3)
        {
            return null;
        }
        return new Ticket(Long.valueOf(p[0]), p[2], p[1]);
    }
}
