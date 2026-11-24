package com.ruoyi.iterminal.mapper;

import java.util.List;
import com.ruoyi.iterminal.domain.ItmNotifyChannel;

/** 通知渠道 */
public interface ItmNotifyChannelMapper
{
    List<ItmNotifyChannel> selectItmNotifyChannelList(ItmNotifyChannel query);

    ItmNotifyChannel selectItmNotifyChannelById(Long channelId);

    /** 启用的、订阅了这个事件的渠道 */
    List<ItmNotifyChannel> selectSubscribers(String event);

    int insertItmNotifyChannel(ItmNotifyChannel channel);

    int updateItmNotifyChannel(ItmNotifyChannel channel);

    int deleteItmNotifyChannelByIds(Long[] channelIds);
}
