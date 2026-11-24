package com.ruoyi.iterminal.controller.admin;

import java.util.List;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.core.page.TableDataInfo;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.common.utils.poi.ExcelUtil;
import java.util.Map;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.domain.ItmApproval;
import com.ruoyi.iterminal.mapper.ItmApprovalMapper;
import com.ruoyi.iterminal.service.ItmApprovalService;

/**
 * 远程审批（管理后台）：查看审批记录，处理待审批。
 */
@RestController
@RequestMapping("/iterminal/approval")
public class ApprovalController extends BaseController
{
    @Autowired
    private ItmApprovalMapper approvalMapper;

    @Autowired
    private ItmApprovalService approvalService;

    @PreAuthorize("@ss.hasPermi('itm:approval:list')")
    @GetMapping("/list")
    public TableDataInfo list(ItmApproval query)
    {
        startPage();
        return getDataTable(approvalMapper.selectItmApprovalList(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:approval:decide')")
    @Log(title = "远程审批", businessType = BusinessType.UPDATE)
    @PutMapping("/{approvalId}/decide")
    public AjaxResult decide(@PathVariable String approvalId, @RequestBody Map<String, String> body)
    {
        LoginUser user = getLoginUser();
        try
        {
            approvalService.decide(approvalId, body.get("decision"), body.get("comment"), user.getUsername(), user.getPermissions());
        }
        catch (ApiException e)
        {
            return error(e.getMessage());
        }
        return success();
    }
}
