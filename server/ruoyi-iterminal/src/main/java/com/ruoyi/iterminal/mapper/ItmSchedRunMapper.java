package com.ruoyi.iterminal.mapper;

import java.util.Date;
import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmSchedRun;

/** 定时任务执行记录 */
public interface ItmSchedRunMapper
{
    ItmSchedRun selectItmSchedRunById(String runId);

    List<ItmSchedRun> selectItmSchedRunList(ItmSchedRun query);

    /** 还没结束的执行（已派发 / 执行中），用于超时检查 */
    List<ItmSchedRun> selectUnfinished();

    int insertItmSchedRun(ItmSchedRun run);

    int updateItmSchedRun(ItmSchedRun run);

    /** 保留期限清理：删除早于 before 开始、已经结束的执行记录 */
    int deleteBefore(@Param("before") Date before, @Param("limit") int limit);
}
