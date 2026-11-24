package com.ruoyi.iterminal.mapper;

import java.util.Date;
import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmAuditSession;

/** 会话录像 */
public interface ItmAuditSessionMapper
{
    ItmAuditSession selectItmAuditSessionById(String recordingId);

    List<ItmAuditSession> selectItmAuditSessionList(ItmAuditSession query);

    int insertItmAuditSession(ItmAuditSession session);

    int updateItmAuditSession(ItmAuditSession session);

    int deleteItmAuditSessionByIds(String[] recordingIds);

    /** 保留期限清理：早于 before 开始的录像 ID（每次最多 limit 条） */
    List<String> selectIdsBefore(@Param("before") Date before, @Param("limit") int limit);
}
