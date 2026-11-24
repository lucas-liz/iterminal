package com.ruoyi.iterminal.mapper;

import java.util.List;
import com.ruoyi.iterminal.domain.ItmDevice;

/** 客户端设备 */
public interface ItmDeviceMapper
{
    ItmDevice selectItmDeviceById(String deviceId);

    List<ItmDevice> selectItmDeviceList(ItmDevice query);

    /** 登录时注册或更新设备（同一设备换了账号时归属到新账号） */
    int upsertItmDevice(ItmDevice device);

    int updateItmDevice(ItmDevice device);

    /** 服务启动时把所有设备标为离线（上次退出时没来得及更新的） */
    int resetOnline();
}
