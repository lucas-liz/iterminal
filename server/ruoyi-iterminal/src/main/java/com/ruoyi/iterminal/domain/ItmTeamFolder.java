package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * 团队主机分组（itm_team_folder）
 */
public class ItmTeamFolder extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 分组ID */
    private Long folderId;

    /** 上级分组（0 表示顶层） */
    private Long parentId;

    /** 分组名称 */
    private String folderName;

    /** 可见的角色（逗号分隔；为空时继承上级） */
    private String roleKeys;

    /** 显示顺序 */
    private Integer sort;

    public Long getFolderId()
    {
        return folderId;
    }

    public void setFolderId(Long folderId)
    {
        this.folderId = folderId;
    }

    public Long getParentId()
    {
        return parentId;
    }

    public void setParentId(Long parentId)
    {
        this.parentId = parentId;
    }

    public String getFolderName()
    {
        return folderName;
    }

    public void setFolderName(String folderName)
    {
        this.folderName = folderName;
    }

    public String getRoleKeys()
    {
        return roleKeys;
    }

    public void setRoleKeys(String roleKeys)
    {
        this.roleKeys = roleKeys;
    }

    public Integer getSort()
    {
        return sort;
    }

    public void setSort(Integer sort)
    {
        this.sort = sort;
    }
}
