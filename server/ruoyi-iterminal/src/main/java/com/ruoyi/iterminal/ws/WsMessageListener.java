package com.ruoyi.iterminal.ws;

import java.util.Map;

/**
 * 处理客户端发来的业务消息（task.progress、task.result、approval.decide 等）。
 * 业务服务实现这个接口并声明自己处理哪些 type，ClientWsHandler 按 type 分发。
 */
public interface WsMessageListener
{
    /** 处理的消息类型 */
    java.util.Set<String> types();

    /** 收到消息（已经回过 ack、去过重） */
    void onMessage(ClientWsHandler.Peer peer, String type, Map<String, Object> payload);

    /** 设备连上（可以补发离线期间的消息）；默认不处理 */
    default void onConnected(ClientWsHandler.Peer peer)
    {
    }
}
