package com.ruoyi.iterminal.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmRelease;

/** 客户端版本 */
public interface ItmReleaseMapper
{
    ItmRelease selectItmReleaseById(Long releaseId);

    List<ItmRelease> selectItmReleaseList(ItmRelease query);

    /** 某个渠道、系统、架构下已发布的版本（选最新版本在 Java 里按版本号比较） */
    List<ItmRelease> selectPublished(@Param("channel") String channel, @Param("os") String os, @Param("arch") String arch);

    int insertItmRelease(ItmRelease release);

    int updateItmRelease(ItmRelease release);

    int deleteItmReleaseByIds(Long[] releaseIds);
}
