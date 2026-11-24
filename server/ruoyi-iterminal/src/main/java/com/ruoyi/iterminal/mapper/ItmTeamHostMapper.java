package com.ruoyi.iterminal.mapper;

import java.util.List;
import org.apache.ibatis.annotations.Param;
import com.ruoyi.iterminal.domain.ItmTeamHost;

/** 团队主机 */
public interface ItmTeamHostMapper
{
    List<ItmTeamHost> selectList(ItmTeamHost query);

    /** 客户端同步用：启用的主机（含密文） */
    List<ItmTeamHost> selectEnabled();

    ItmTeamHost selectById(Long hostId);

    int insertHost(ItmTeamHost h);

    int updateHost(ItmTeamHost h);

    /** 只更新密文（新增时拿到 ID 之后再加密）；null 的字段不改 */
    int updateSecrets(@Param("hostId") Long hostId, @Param("passwordEnc") String passwordEnc, @Param("privateKeyEnc") String privateKeyEnc, @Param("passphraseEnc") String passphraseEnc);

    int deleteByIds(Long[] hostIds);

    int countInFolder(Long folderId);
}
