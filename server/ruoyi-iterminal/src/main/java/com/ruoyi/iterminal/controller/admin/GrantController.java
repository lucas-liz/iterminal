package com.ruoyi.iterminal.controller.admin;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.iterminal.service.ItmGrant;

/**
 * 管理后台：「可用范围」的选项（角色、用户、部门树），团队模型和知识库共用（第十三轮）
 */
@RestController
@RequestMapping("/iterminal/grant")
public class GrantController extends BaseController
{
    @Autowired
    private ItmGrant grant;

    @PreAuthorize("@ss.hasAnyPermi('itm:llm:list,itm:kb:list')")
    @GetMapping("/options")
    public AjaxResult options()
    {
        return success(grant.options());
    }
}
