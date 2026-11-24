package com.ruoyi.iterminal.controller.admin;

import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.core.page.TableDataInfo;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.iterminal.domain.ItmTeamFolder;
import com.ruoyi.iterminal.domain.ItmTeamHost;
import com.ruoyi.iterminal.mapper.ItmTeamHostMapper;
import com.ruoyi.iterminal.service.ItmTeamAssetService;
import com.ruoyi.system.service.ISysRoleService;

/**
 * 管理后台：团队主机（分组树、主机、可见角色）
 */
@RestController
@RequestMapping("/iterminal/asset")
public class AssetController extends BaseController
{
    @Autowired
    private ItmTeamAssetService assetService;

    @Autowired
    private ItmTeamHostMapper hostMapper;

    @Autowired
    private ISysRoleService roleService;

    @PreAuthorize("@ss.hasPermi('itm:asset:list')")
    @GetMapping("/folder/tree")
    public AjaxResult tree()
    {
        return success(assetService.tree());
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:add')")
    @Log(title = "团队主机分组", businessType = BusinessType.INSERT)
    @PostMapping("/folder")
    public AjaxResult addFolder(@RequestBody ItmTeamFolder f)
    {
        f.setFolderId(null);
        return toAjax(assetService.saveFolder(f, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:edit')")
    @Log(title = "团队主机分组", businessType = BusinessType.UPDATE)
    @PutMapping("/folder")
    public AjaxResult editFolder(@RequestBody ItmTeamFolder f)
    {
        return toAjax(assetService.saveFolder(f, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:remove')")
    @Log(title = "团队主机分组", businessType = BusinessType.DELETE)
    @DeleteMapping("/folder/{folderId}")
    public AjaxResult removeFolder(@PathVariable Long folderId)
    {
        return toAjax(assetService.deleteFolder(folderId));
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:list')")
    @GetMapping("/host/list")
    public TableDataInfo list(ItmTeamHost query)
    {
        startPage();
        List<ItmTeamHost> list = hostMapper.selectList(query);
        list.forEach(assetService::masked);
        return getDataTable(list);
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:list')")
    @GetMapping("/host/{hostId}")
    public AjaxResult getInfo(@PathVariable Long hostId)
    {
        return success(assetService.masked(hostMapper.selectById(hostId)));
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:add')")
    @Log(title = "团队主机", businessType = BusinessType.INSERT)
    @PostMapping("/host")
    public AjaxResult add(@RequestBody ItmTeamHost h)
    {
        h.setHostId(null);
        return toAjax(assetService.saveHost(h, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:edit')")
    @Log(title = "团队主机", businessType = BusinessType.UPDATE)
    @PutMapping("/host")
    public AjaxResult edit(@RequestBody ItmTeamHost h)
    {
        return toAjax(assetService.saveHost(h, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:asset:remove')")
    @Log(title = "团队主机", businessType = BusinessType.DELETE)
    @DeleteMapping("/host/{hostIds}")
    public AjaxResult remove(@PathVariable Long[] hostIds)
    {
        return toAjax(hostMapper.deleteByIds(hostIds));
    }

    /** 「可见的角色」下拉框 */
    @PreAuthorize("@ss.hasPermi('itm:asset:list')")
    @GetMapping("/roles")
    public AjaxResult roles()
    {
        return success(roleService.selectRoleAll().stream().filter(r -> "0".equals(r.getStatus())).map(r -> Map.of("roleKey", r.getRoleKey(), "roleName", r.getRoleName())).toList());
    }
}
