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
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;
import com.ruoyi.iterminal.service.ItmDeviceContext;
import com.ruoyi.iterminal.ws.ClientWsHandler;

/**
 * 设备管理：查看登录过的客户端设备、在线状态，吊销设备（令牌失效并断开连接）。
 */
@RestController
@RequestMapping("/iterminal/device")
public class DeviceController extends BaseController
{
    @Autowired
    private ItmDeviceMapper deviceMapper;

    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ClientWsHandler ws;

    @PreAuthorize("@ss.hasPermi('itm:device:list')")
    @GetMapping("/list")
    public TableDataInfo list(ItmDevice query)
    {
        startPage();
        return getDataTable(deviceMapper.selectItmDeviceList(query));
    }

    /** 定时任务表单里选择执行设备（不分页，只列正常的设备） */
    @PreAuthorize("@ss.hasPermi('itm:task:list')")
    @GetMapping("/options")
    public AjaxResult options()
    {
        ItmDevice q = new ItmDevice();
        q.setStatus("0");
        return success(deviceMapper.selectItmDeviceList(q));
    }

    @PreAuthorize("@ss.hasPermi('itm:device:query')")
    @GetMapping("/{deviceId}")
    public AjaxResult getInfo(@PathVariable String deviceId)
    {
        return success(deviceMapper.selectItmDeviceById(deviceId));
    }

    @PreAuthorize("@ss.hasPermi('itm:device:list')")
    @Log(title = "设备管理", businessType = BusinessType.EXPORT)
    @PostMapping("/export")
    public void export(HttpServletResponse response, ItmDevice query)
    {
        new ExcelUtil<>(ItmDevice.class).exportExcel(response, deviceMapper.selectItmDeviceList(query), "设备");
    }

    /** 吊销：令牌和刷新令牌作废、断开长连接；这台设备要重新输入密码登录 */
    @PreAuthorize("@ss.hasPermi('itm:device:revoke')")
    @Log(title = "设备管理", businessType = BusinessType.FORCE)
    @PutMapping("/{deviceId}/revoke")
    public AjaxResult revoke(@PathVariable String deviceId)
    {
        ItmDevice d = new ItmDevice();
        d.setDeviceId(deviceId);
        d.setStatus("1");
        d.setRefreshTokenHash("");
        int n = deviceMapper.updateItmDevice(d);
        deviceContext.unbind(deviceId);
        ws.kick(deviceId, "管理员吊销了这台设备");
        return toAjax(n);
    }
}
