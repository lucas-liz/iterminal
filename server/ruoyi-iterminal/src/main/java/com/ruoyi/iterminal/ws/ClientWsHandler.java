package com.ruoyi.iterminal.ws;

import java.io.IOException;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledFuture;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.context.annotation.Lazy;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;

/**
 * 客户端长连接（文档二第 7 章）：消息 {type, id, ts, ack?, payload}。
 * - ack: true 的消息，接收方回 {type: "ack", id}；发送方 10 秒没收到就重发，最多 3 次；接收方按 id 去重；
 * - 客户端每 25 秒 ping，服务端回 pong；60 秒没有任何消息就断开；
 * - 每台设备只保留一条连接（新连接上来时关闭旧的）。
 * 单实例部署：连接保存在内存里（多实例时需要按文档二 7.3 用 Redis 发布订阅转发）。
 */
@Component
public class ClientWsHandler extends TextWebSocketHandler
{
    private static final Logger log = LoggerFactory.getLogger(ClientWsHandler.class);

    public static final String ATTR_USER_ID = "itm.userId";
    public static final String ATTR_USER_NAME = "itm.userName";
    public static final String ATTR_DEVICE_ID = "itm.deviceId";
    private static final String ATTR_SEEN = "itm.seen";
    private static final String ATTR_LAST = "itm.last";
    private static final Duration RESEND = Duration.ofSeconds(10);
    private static final int MAX_ATTEMPTS = 3;
    private static final Duration IDLE = Duration.ofSeconds(60);

    /** 一条连接的身份 */
    public record Peer(Long userId, String userName, String deviceId)
    {
    }

    private final Map<String, WebSocketSession> sessions = new ConcurrentHashMap<>();
    /** 等待 ack 的消息：id → 重发任务 */
    private final Map<String, ScheduledFuture<?>> pendingAcks = new ConcurrentHashMap<>();
    private final Map<String, WsMessageListener> listeners = new HashMap<>();

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ItmDeviceMapper deviceMapper;

    @Autowired
    @Qualifier("itmScheduler")
    private ThreadPoolTaskScheduler scheduler;

    @Autowired
    @Lazy
    private List<WsMessageListener> listenerBeans;

    @PostConstruct
    public void init()
    {
        // 上次退出时没来得及标记离线的设备
        deviceMapper.resetOnline();
        scheduler.scheduleWithFixedDelay(this::closeIdle, Duration.ofSeconds(30));
    }

    private Map<String, WsMessageListener> listeners()
    {
        if (listeners.isEmpty() && listenerBeans != null)
        {
            synchronized (listeners)
            {
                for (WsMessageListener l : listenerBeans)
                {
                    for (String t : l.types())
                    {
                        listeners.put(t, l);
                    }
                }
            }
        }
        return listeners;
    }

    // ---------------------------------------------------------------- 连接

    @Override
    public void afterConnectionEstablished(WebSocketSession raw)
    {
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(raw, 10_000, 1024 * 1024);
        Peer peer = peer(session);
        session.getAttributes().put(ATTR_SEEN, Collections.synchronizedMap(new LinkedHashMap<String, Boolean>(64, 0.75f, true)
        {
            private static final long serialVersionUID = 1L;

            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Boolean> eldest)
            {
                return size() > 500;
            }
        }));
        touch(session);
        WebSocketSession old = sessions.put(peer.deviceId(), session);
        if (old != null && old.isOpen())
        {
            try
            {
                old.close(new CloseStatus(4000, "replaced"));
            }
            catch (IOException ignored)
            {
                // 旧连接已经断开
            }
        }
        markOnline(peer.deviceId(), true);
        for (WsMessageListener l : listenerBeans)
        {
            try
            {
                l.onConnected(peer);
            }
            catch (Exception e)
            {
                log.warn("设备上线处理失败：{}", e.getMessage());
            }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status)
    {
        String deviceId = (String) session.getAttributes().get(ATTR_DEVICE_ID);
        // 只在当前登记的连接断开时才算离线（被新连接替换的旧连接不算）
        WebSocketSession current = sessions.get(deviceId);
        if (current != null && current.getId().equals(session.getId()))
        {
            sessions.remove(deviceId);
            markOnline(deviceId, false);
        }
    }

    @Override
    @SuppressWarnings("unchecked")
    protected void handleTextMessage(WebSocketSession raw, TextMessage message)
    {
        WebSocketSession session = sessions.getOrDefault((String) raw.getAttributes().get(ATTR_DEVICE_ID), raw);
        touch(session);
        Map<String, Object> msg;
        try
        {
            msg = objectMapper.readValue(message.getPayload(), new TypeReference<Map<String, Object>>()
            {
            });
        }
        catch (Exception e)
        {
            return;
        }
        String type = String.valueOf(msg.get("type"));
        String id = msg.get("id") == null ? null : String.valueOf(msg.get("id"));
        if ("ack".equals(type))
        {
            ScheduledFuture<?> f = id == null ? null : pendingAcks.remove(id);
            if (f != null)
            {
                f.cancel(false);
            }
            return;
        }
        if ("ping".equals(type))
        {
            raw(session, Map.of("type", "pong", "id", id == null ? "" : id));
            return;
        }
        if (Boolean.TRUE.equals(msg.get("ack")) && id != null)
        {
            raw(session, Map.of("type", "ack", "id", id));
            Map<String, Boolean> seen = (Map<String, Boolean>) session.getAttributes().get(ATTR_SEEN);
            if (seen.put(id, Boolean.TRUE) != null)
            {
                // 重发的消息：已经处理过
                return;
            }
        }
        Peer peer = peer(session);
        Map<String, Object> payload = msg.get("payload") instanceof Map<?, ?> p ? (Map<String, Object>) p : Map.of();
        if ("hello".equals(type))
        {
            ItmDevice d = new ItmDevice();
            d.setDeviceId(peer.deviceId());
            Object v = payload.get("clientVersion");
            if (v != null)
            {
                d.setClientVersion(String.valueOf(v).substring(0, Math.min(40, String.valueOf(v).length())));
            }
            d.setLastSeenAt(new Date());
            deviceMapper.updateItmDevice(d);
            return;
        }
        WsMessageListener l = listeners().get(type);
        if (l == null)
        {
            return;
        }
        try
        {
            l.onMessage(peer, type, payload);
        }
        catch (Exception e)
        {
            log.warn("处理客户端消息 {} 失败：{}", type, e.getMessage());
        }
    }

    // ---------------------------------------------------------------- 发送

    public boolean isOnline(String deviceId)
    {
        WebSocketSession s = sessions.get(deviceId);
        return s != null && s.isOpen();
    }

    /** 当前在线的设备（设备ID → 用户ID） */
    public Map<String, Long> onlineDevices()
    {
        Map<String, Long> out = new HashMap<>();
        sessions.forEach((d, s) -> out.put(d, (Long) s.getAttributes().get(ATTR_USER_ID)));
        return out;
    }

    /**
     * 发给一台设备；ack = true 时 10 秒没确认就重发，最多 3 次。设备不在线返回 false。
     */
    public boolean send(String deviceId, String type, Object payload, boolean ack)
    {
        WebSocketSession s = sessions.get(deviceId);
        if (s == null || !s.isOpen())
        {
            return false;
        }
        String id = UUID.randomUUID().toString();
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("type", type);
        msg.put("id", id);
        msg.put("ts", Instant.now().toString());
        if (ack)
        {
            msg.put("ack", true);
        }
        msg.put("payload", payload);
        if (!raw(s, msg))
        {
            return false;
        }
        if (ack)
        {
            scheduleResend(deviceId, id, msg, 1);
        }
        return true;
    }

    /** 发给这些用户的所有在线设备 */
    public void sendToUsers(Collection<Long> userIds, String type, Object payload, boolean ack)
    {
        Set<Long> ids = Set.copyOf(userIds);
        sessions.forEach((deviceId, s) -> {
            if (ids.contains((Long) s.getAttributes().get(ATTR_USER_ID)))
            {
                send(deviceId, type, payload, ack);
            }
        });
    }

    /** 吊销设备：通知客户端后断开 */
    public void kick(String deviceId, String reason)
    {
        WebSocketSession s = sessions.get(deviceId);
        if (s == null)
        {
            return;
        }
        Map<String, Object> msg = new LinkedHashMap<>();
        msg.put("type", "device.revoked");
        msg.put("id", UUID.randomUUID().toString());
        msg.put("ts", Instant.now().toString());
        msg.put("payload", Map.of("reason", reason));
        raw(s, msg);
        try
        {
            s.close(new CloseStatus(4001, "revoked"));
        }
        catch (IOException ignored)
        {
            // 已经断开
        }
    }

    private void scheduleResend(String deviceId, String id, Map<String, Object> msg, int attempt)
    {
        ScheduledFuture<?> f = scheduler.schedule(() -> {
            if (pendingAcks.remove(id) == null)
            {
                return;
            }
            if (attempt >= MAX_ATTEMPTS)
            {
                log.info("消息 {}（{}）发给设备 {} 重试 {} 次没有确认，放弃", msg.get("type"), id, deviceId, MAX_ATTEMPTS);
                return;
            }
            WebSocketSession s = sessions.get(deviceId);
            if (s != null && s.isOpen() && raw(s, msg))
            {
                scheduleResend(deviceId, id, msg, attempt + 1);
            }
        }, Instant.now().plus(RESEND));
        pendingAcks.put(id, f);
    }

    private boolean raw(WebSocketSession s, Object msg)
    {
        try
        {
            s.sendMessage(new TextMessage(objectMapper.writeValueAsString(msg)));
            return true;
        }
        catch (Exception e)
        {
            log.debug("发送失败：{}", e.getMessage());
            return false;
        }
    }

    private void touch(WebSocketSession s)
    {
        s.getAttributes().put(ATTR_LAST, System.currentTimeMillis());
    }

    private void closeIdle()
    {
        long now = System.currentTimeMillis();
        sessions.forEach((deviceId, s) -> {
            Long last = (Long) s.getAttributes().get(ATTR_LAST);
            if (last != null && now - last > IDLE.toMillis())
            {
                try
                {
                    s.close(new CloseStatus(4002, "idle"));
                }
                catch (IOException ignored)
                {
                    // 已经断开
                }
            }
        });
    }

    private void markOnline(String deviceId, boolean online)
    {
        ItmDevice d = new ItmDevice();
        d.setDeviceId(deviceId);
        d.setOnline(online ? "1" : "0");
        d.setLastSeenAt(new Date());
        deviceMapper.updateItmDevice(d);
    }

    private static Peer peer(WebSocketSession s)
    {
        return new Peer((Long) s.getAttributes().get(ATTR_USER_ID), (String) s.getAttributes().get(ATTR_USER_NAME), (String) s.getAttributes().get(ATTR_DEVICE_ID));
    }
}
