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
import org.springframework.web.multipart.MultipartFile;
import com.ruoyi.iterminal.domain.ItmRelease;
import com.ruoyi.iterminal.service.ItmReleaseService;

/**
 * 客户端版本发布：上传安装包、调整灰度比例 / 最低版本、下架、删除。
 */
@RestController
@RequestMapping("/iterminal/release")
public class ReleaseController extends BaseController
{
    @Autowired
    private ItmReleaseService releaseService;

    @PreAuthorize("@ss.hasPermi('itm:release:list')")
    @GetMapping("/list")
    public TableDataInfo list(ItmRelease query)
    {
        startPage();
        return getDataTable(releaseService.list(query));
    }

    @PreAuthorize("@ss.hasPermi('itm:release:list')")
    @GetMapping("/{releaseId}")
    public AjaxResult getInfo(@PathVariable Long releaseId)
    {
        return success(releaseService.get(releaseId));
    }

    @PreAuthorize("@ss.hasPermi('itm:release:add')")
    @Log(title = "版本发布", businessType = BusinessType.INSERT)
    @PostMapping("/upload")
    public AjaxResult upload(@RequestParam("file") MultipartFile file, ItmRelease meta)
    {
        return success(releaseService.upload(file, meta, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:release:edit')")
    @Log(title = "版本发布", businessType = BusinessType.UPDATE)
    @PutMapping
    public AjaxResult edit(@RequestBody ItmRelease release)
    {
        release.setUpdateBy(getUsername());
        return toAjax(releaseService.update(release));
    }

    @PreAuthorize("@ss.hasPermi('itm:release:remove')")
    @Log(title = "版本发布", businessType = BusinessType.DELETE)
    @DeleteMapping("/{releaseIds}")
    public AjaxResult remove(@PathVariable Long[] releaseIds)
    {
        return toAjax(releaseService.delete(releaseIds));
    }
}
