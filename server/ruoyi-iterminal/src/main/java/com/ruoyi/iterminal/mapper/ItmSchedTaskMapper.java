package com.ruoyi.iterminal.mapper;

import java.util.List;
import com.ruoyi.iterminal.domain.ItmSchedTask;

/** 定时任务 */
public interface ItmSchedTaskMapper
{
    ItmSchedTask selectItmSchedTaskById(Long taskId);

    List<ItmSchedTask> selectItmSchedTaskList(ItmSchedTask query);

    int insertItmSchedTask(ItmSchedTask task);

    int updateItmSchedTask(ItmSchedTask task);

    int deleteItmSchedTaskByIds(Long[] taskIds);
}
