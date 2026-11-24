package com.ruoyi.iterminal.mapper;

import java.util.Date;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmLlmUsage;

/** 团队模型用量 */
public interface ItmLlmUsageMapper
{
    List<ItmLlmUsage> selectItmLlmUsageList(ItmLlmUsage query);

    /** 按用户、模型汇总（时间范围用 params.beginTime / endTime） */
    List<Map<String, Object>> selectSummary(ItmLlmUsage query);

    /** 某个用户从 since 开始用掉的 token（输入 + 输出） */
    Long sumTokensSince(@Param("userId") Long userId, @Param("since") Date since);

    int insertItmLlmUsage(ItmLlmUsage u);

    int deleteBefore(@Param("before") Date before, @Param("limit") int limit);
}
