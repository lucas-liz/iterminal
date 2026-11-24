package com.ruoyi.iterminal.controller.api;

import java.util.List;
import java.util.Map;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import com.ruoyi.common.annotation.Anonymous;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.common.utils.ip.IpUtils;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.service.ItmDeviceContext;
import com.ruoyi.iterminal.service.ItmFeedbackService;

/**
 * 客户端：问题反馈（第十三轮，文档二 5.15）。登录后提交到 /feedback；本地模式（没有登录）用匿名接口 /public/feedback。
 */
@RestController
@RequestMapping("/api/v1")
public class FeedbackApiController
{
    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ItmFeedbackService feedback;

    @PostMapping("/feedback")
    public ApiResult<Map<String, Object>> submit(HttpServletRequest req, @RequestPart("meta") String meta, @RequestParam(value = "images", required = false) List<MultipartFile> images,
        @RequestParam(value = "diagnostics", required = false) MultipartFile diag, @RequestParam(value = "diagnosticsMd", required = false) MultipartFile diagMd)
    {
        ItmDevice d = deviceContext.currentDevice();
        return ApiResult.ok(feedback.submit(SecurityUtils.getLoginUser(), d, IpUtils.getIpAddr(req), meta, images, diag, diagMd));
    }

    @GetMapping("/feedback/mine")
    public ApiResult<List<Map<String, Object>>> mine()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(feedback.mine(SecurityUtils.getLoginUser().getUserId()));
    }

    /** 匿名提交（本地模式）：按 IP 限流，参数 itm.feedback.allowAnonymous = false 时关闭 */
    @Anonymous
    @PostMapping("/public/feedback")
    public ApiResult<Map<String, Object>> submitAnonymous(HttpServletRequest req, @RequestPart("meta") String meta, @RequestParam(value = "images", required = false) List<MultipartFile> images,
        @RequestParam(value = "diagnostics", required = false) MultipartFile diag, @RequestParam(value = "diagnosticsMd", required = false) MultipartFile diagMd)
    {
        return ApiResult.ok(feedback.submit(null, null, IpUtils.getIpAddr(req), meta, images, diag, diagMd));
    }
}
