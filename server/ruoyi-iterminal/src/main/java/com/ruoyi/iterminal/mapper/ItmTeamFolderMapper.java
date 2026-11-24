package com.ruoyi.iterminal.mapper;

import java.util.List;
import com.ruoyi.iterminal.domain.ItmTeamFolder;

/** 团队主机分组 */
public interface ItmTeamFolderMapper
{
    List<ItmTeamFolder> selectAll();

    ItmTeamFolder selectById(Long folderId);

    int insertFolder(ItmTeamFolder f);

    int updateFolder(ItmTeamFolder f);

    int deleteById(Long folderId);

    int countChildren(Long folderId);
}
