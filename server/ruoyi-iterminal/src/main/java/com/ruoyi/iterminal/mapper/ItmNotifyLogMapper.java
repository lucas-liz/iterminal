package com.ruoyi.iterminal.mapper;

import java.util.Date;
import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmNotifyLog;

/** 通知发送记录 */
public interface ItmNotifyLogMapper
{
    List<ItmNotifyLog> selectItmNotifyLogList(ItmNotifyLog query);

    int insertItmNotifyLog(ItmNotifyLog log);

    /** 保留期限清理 */
    int deleteBefore(@Param("before") Date before, @Param("limit") int limit);
}
