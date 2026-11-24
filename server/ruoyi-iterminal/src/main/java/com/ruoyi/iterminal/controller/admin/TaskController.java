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
import com.ruoyi.iterminal.domain.ItmSchedRun;
import com.ruoyi.iterminal.domain.ItmSchedTask;
import com.ruoyi.iterminal.mapper.ItmSchedRunMapper;
import com.ruoyi.iterminal.service.ItmSchedService;

/**
 * 定时任务：派发到客户端设备执行的命令 / Skill / AI 任务，以及执行记录。
 */
@RestController
@RequestMapping("/iterminal")
public class TaskController extends BaseController
{
    @Autowired
    private ItmSchedService schedService;

    @Autowired
    private ItmSchedRunMapper runMapper;

    @PreAuthorize("@ss.hasPermi('itm:task:list')")
    @GetMapping("/task/list")
    public TableDataInfo list(ItmSchedTask query)
    {
        startPage();
        return getDataTable(schedService.list(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:task:list')")
    @GetMapping("/task/{taskId}")
    public AjaxResult getInfo(@PathVariable Long taskId)
    {
        return success(schedService.get(taskId));
    }

    @PreAuthorize("@ss.hasPermi('itm:task:add')")
    @Log(title = "定时任务", businessType = BusinessType.INSERT)
    @PostMapping("/task")
    public AjaxResult add(@RequestBody ItmSchedTask task)
    {
        task.setCreateBy(getUsername());
        return toAjax(schedService.insert(task));
    }

    @PreAuthorize("@ss.hasPermi('itm:task:edit')")
    @Log(title = "定时任务", businessType = BusinessType.UPDATE)
    @PutMapping("/task")
    public AjaxResult edit(@RequestBody ItmSchedTask task)
    {
        task.setUpdateBy(getUsername());
        return toAjax(schedService.update(task));
    }

    @PreAuthorize("@ss.hasPermi('itm:task:edit')")
    @Log(title = "定时任务", businessType = BusinessType.UPDATE)
    @PutMapping("/task/changeStatus")
    public AjaxResult changeStatus(@RequestBody ItmSchedTask task)
    {
        return toAjax(schedService.changeStatus(task.getTaskId(), task.getStatus(), getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:task:remove')")
    @Log(title = "定时任务", businessType = BusinessType.DELETE)
    @DeleteMapping("/task/{taskIds}")
    public AjaxResult remove(@PathVariable Long[] taskIds)
    {
        return toAjax(schedService.delete(taskIds));
    }

    @PreAuthorize("@ss.hasPermi('itm:task:run')")
    @Log(title = "定时任务", businessType = BusinessType.OTHER)
    @PutMapping("/task/run/{taskId}")
    public AjaxResult run(@PathVariable Long taskId)
    {
        ItmSchedRun run = schedService.runNow(taskId);
        return "OFFLINE".equals(run.getStatus()) ? AjaxResult.warn(run.getSummary(), run) : success(run);
    }

    @PreAuthorize("@ss.hasPermi('itm:run:list')")
    @GetMapping("/run/list")
    public TableDataInfo runs(ItmSchedRun query)
    {
        startPage();
        return getDataTable(runMapper.selectItmSchedRunList(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:run:list')")
    @GetMapping("/run/{runId}")
    public AjaxResult run(@PathVariable String runId)
    {
        return success(runMapper.selectItmSchedRunById(runId));
    }
}
