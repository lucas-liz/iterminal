package com.ruoyi.iterminal.mapper;

import java.util.Date;
import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmAuditCommand;

/** 命令审计 */
public interface ItmAuditCommandMapper
{
    List<ItmAuditCommand> selectItmAuditCommandList(ItmAuditCommand query);

    ItmAuditCommand selectItmAuditCommandById(Long auditId);

    /** 批量写入；同一设备重复上报的事件（client_event_id 相同）忽略 */
    int insertIgnoreBatch(@Param("list") List<ItmAuditCommand> list);

    /** 这台设备已经上报过的事件 ID（避免重发的批次重复通知） */
    List<String> selectExistingEventIds(@Param("deviceId") String deviceId, @Param("ids") List<String> ids);

    /** 保留期限清理：删除早于 before 的记录（每次最多 limit 条） */
    int deleteBefore(@Param("before") Date before, @Param("limit") int limit);
}
