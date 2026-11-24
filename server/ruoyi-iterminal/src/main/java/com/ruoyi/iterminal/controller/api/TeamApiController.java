package com.ruoyi.iterminal.controller.api;

import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.service.ItmDeviceContext;
import com.ruoyi.iterminal.service.ItmTeamAssetService;

/**
 * 客户端：团队主机同步（文档二 5.2）
 */
@RestController
@RequestMapping("/api/v1/team")
public class TeamApiController
{
    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ItmTeamAssetService assetService;

    /** 当前用户能看到的团队主机和分组（含凭证，只能由登录了的客户端设备调用） */
    @GetMapping("/assets")
    public ApiResult<Map<String, Object>> assets()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(assetService.assetsFor(SecurityUtils.getLoginUser()));
    }
}
