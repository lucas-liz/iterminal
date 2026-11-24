package com.ruoyi.iterminal.controller.admin;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.iterminal.service.ItmFeedbackService;

/**
 * 管理后台：问题反馈（第十三轮）——列表、详情（截图、环境、操作轨迹、错误、日志）、附件下载、处理和回复、复制给 AI、AI 分析
 */
@RestController
@RequestMapping("/iterminal/feedback")
public class FeedbackController extends BaseController
{
    @Autowired
    private ItmFeedbackService feedback;

    @PreAuthorize("@ss.hasPermi('itm:feedback:list')")
    @GetMapping("/list")
    public AjaxResult list(@RequestParam(required = false) String status, @RequestParam(required = false) String category, @RequestParam(required = false) String keyword,
        @RequestParam(required = false) String beginTime, @RequestParam(required = false) String endTime, @RequestParam(defaultValue = "1") int pageNum, @RequestParam(defaultValue = "20") int pageSize)
    {
        Map<String, Object> r = feedback.list(status, category, keyword, beginTime, endTime, pageNum, pageSize);
        AjaxResult a = AjaxResult.success();
        a.put("rows", r.get("rows"));
        a.put("total", r.get("total"));
        return a;
    }

    @PreAuthorize("@ss.hasPermi('itm:feedback:query')")
    @GetMapping("/{id}")
    public AjaxResult detail(@PathVariable Long id)
    {
        return success(feedback.detail(id));
    }

    /** 附件（截图、诊断包）：只能通过这里下载，/profile/itm/** 已经禁止直接访问 */
    @PreAuthorize("@ss.hasPermi('itm:feedback:query')")
    @GetMapping("/file/{fileId}")
    public ResponseEntity<Resource> file(@PathVariable Long fileId)
    {
        Object[] f = feedback.file(fileId);
        return ResponseEntity.ok().contentType(MediaType.parseMediaType((String) f[1]))
            .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline().filename(String.valueOf(f[2]), StandardCharsets.UTF_8).build().toString())
            .header("X-Content-Type-Options", "nosniff")
            .body(new FileSystemResource((Path) f[0]));
    }

    /** 「复制给 AI」：Markdown 文本 */
    @PreAuthorize("@ss.hasPermi('itm:feedback:query')")
    @GetMapping("/{id}/prompt")
    public AjaxResult prompt(@PathVariable Long id)
    {
        return success(feedback.prompt(id));
    }

    @PreAuthorize("@ss.hasPermi('itm:feedback:edit')")
    @Log(title = "问题反馈", businessType = BusinessType.UPDATE)
    @PutMapping("/{id}")
    public AjaxResult update(@PathVariable Long id, @RequestBody Map<String, Object> body)
    {
        feedback.update(id, (String) body.get("status"), (String) body.get("reply"), getUsername());
        return success();
    }

    @PreAuthorize("@ss.hasPermi('itm:feedback:analyze')")
    @Log(title = "问题反馈 AI 分析", businessType = BusinessType.OTHER)
    @PostMapping("/{id}/analyze")
    public AjaxResult analyze(@PathVariable Long id, @RequestBody(required = false) Map<String, Object> body)
    {
        Object pid = body == null ? null : body.get("providerId");
        Long providerId = pid == null || String.valueOf(pid).isBlank() ? null : Long.valueOf(String.valueOf(pid));
        String model = body == null ? null : (String) body.get("model");
        return success(feedback.analyze(id, providerId, model, getLoginUser()));
    }

    @PreAuthorize("@ss.hasPermi('itm:feedback:remove')")
    @Log(title = "问题反馈", businessType = BusinessType.DELETE)
    @DeleteMapping("/{ids}")
    public AjaxResult remove(@PathVariable Long[] ids)
    {
        return toAjax(feedback.delete(ids));
    }
}
