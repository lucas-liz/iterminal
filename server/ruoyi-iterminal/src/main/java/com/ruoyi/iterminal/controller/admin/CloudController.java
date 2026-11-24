package com.ruoyi.iterminal.controller.admin;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.iterminal.service.ItmCloudService;

/**
 * 管理后台：云备份记录和个人分享码。内容是端到端加密的，这里只能看元数据，不能下载；可以强制关闭某个用户的分享码。
 */
@RestController
@RequestMapping("/iterminal/cloud")
public class CloudController extends BaseController
{
    @Autowired
    private ItmCloudService cloud;

    @PreAuthorize("@ss.hasPermi('itm:cloud:list')")
    @GetMapping("/backup/list")
    public AjaxResult backups(@RequestParam(required = false) String userName)
    {
        return success(cloud.adminBackups(userName));
    }

    @PreAuthorize("@ss.hasPermi('itm:cloud:list')")
    @GetMapping("/share/list")
    public AjaxResult shares()
    {
        return success(cloud.adminShares());
    }

    @PreAuthorize("@ss.hasPermi('itm:cloud:remove')")
    @Log(title = "个人分享码", businessType = BusinessType.FORCE)
    @DeleteMapping("/share/{userId}")
    public AjaxResult closeShare(@PathVariable Long userId)
    {
        cloud.closeShare(null, userId, "admin:" + getUsername());
        return success();
    }

    /** 单项分享（第十三轮）：只有元数据 */
    @PreAuthorize("@ss.hasPermi('itm:cloud:list')")
    @GetMapping("/link/list")
    public AjaxResult links(@RequestParam(required = false) String userName)
    {
        return success(cloud.adminLinks(userName));
    }

    @PreAuthorize("@ss.hasPermi('itm:cloud:remove')")
    @Log(title = "单项分享", businessType = BusinessType.FORCE)
    @DeleteMapping("/link/{linkId}")
    public AjaxResult revokeLink(@PathVariable Long linkId)
    {
        cloud.adminRevokeLink(linkId);
        return success();
    }
}
