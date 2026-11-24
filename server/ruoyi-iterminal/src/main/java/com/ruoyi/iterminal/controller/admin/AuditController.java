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
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import com.ruoyi.iterminal.domain.ItmAuditCommand;
import com.ruoyi.iterminal.domain.ItmAuditSession;
import com.ruoyi.iterminal.mapper.ItmAuditCommandMapper;
import com.ruoyi.iterminal.mapper.ItmAuditSessionMapper;
import com.ruoyi.iterminal.service.ItmAuditService;
import com.ruoyi.iterminal.service.ItmRetentionService;

/**
 * 审计：命令记录（客户端上报）和会话录像。
 */
@RestController
@RequestMapping("/iterminal")
public class AuditController extends BaseController
{
    @Autowired
    private ItmAuditCommandMapper commandMapper;

    @Autowired
    private ItmAuditSessionMapper sessionMapper;

    @Autowired
    private ItmAuditService auditService;

    @Autowired
    private ItmRetentionService retentionService;

    /** 立即按保留期限清理一次（平时每天 03:30 自动执行），只有管理员可以调用 */
    @PreAuthorize("@ss.hasRole('admin')")
    @Log(title = "保留期限清理", businessType = BusinessType.CLEAN)
    @PostMapping("/retention/cleanup")
    public AjaxResult cleanup()
    {
        return success(retentionService.cleanup());
    }

    @PreAuthorize("@ss.hasPermi('itm:audit:list')")
    @GetMapping("/audit/list")
    public TableDataInfo list(ItmAuditCommand query)
    {
        startPage();
        return getDataTable(commandMapper.selectItmAuditCommandList(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:audit:list')")
    @GetMapping("/audit/{auditId}")
    public AjaxResult getInfo(@PathVariable Long auditId)
    {
        return success(commandMapper.selectItmAuditCommandById(auditId));
    }

    @PreAuthorize("@ss.hasPermi('itm:audit:export')")
    @Log(title = "命令审计", businessType = BusinessType.EXPORT)
    @PostMapping("/audit/export")
    public void export(HttpServletResponse response, ItmAuditCommand query)
    {
        new ExcelUtil<>(ItmAuditCommand.class).exportExcel(response, commandMapper.selectItmAuditCommandList(query), "命令审计");
    }

    @PreAuthorize("@ss.hasPermi('itm:session:list')")
    @GetMapping("/session/list")
    public TableDataInfo sessions(ItmAuditSession query)
    {
        startPage();
        return getDataTable(sessionMapper.selectItmAuditSessionList(query));
    }

    /** 录像内容（asciicast v2），前端用 xterm 回放 */
    @PreAuthorize("@ss.hasPermi('itm:session:play')")
    @Log(title = "会话录像", businessType = BusinessType.OTHER)
    @GetMapping("/session/{recordingId}/cast")
    public ResponseEntity<String> cast(@PathVariable String recordingId)
    {
        String cast = auditService.readCast(recordingId);
        if (cast == null)
        {
            return ResponseEntity.notFound().build();
        }
        return ResponseEntity.ok().contentType(MediaType.TEXT_PLAIN).body(cast);
    }

    @PreAuthorize("@ss.hasPermi('itm:session:remove')")
    @Log(title = "会话录像", businessType = BusinessType.DELETE)
    @DeleteMapping("/session/{recordingIds}")
    public AjaxResult removeSessions(@PathVariable String[] recordingIds)
    {
        return toAjax(auditService.deleteSessions(recordingIds));
    }
}
