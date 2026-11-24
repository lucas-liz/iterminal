package com.ruoyi.iterminal.controller.api;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import com.fasterxml.jackson.databind.JsonNode;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.iterminal.api.ApiResult;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.service.ItmCloudService;
import com.ruoyi.iterminal.service.ItmDeviceContext;

/**
 * 客户端：端到端加密的密钥托管、云备份、个人分享码（文档二 5.3.3 / 5.13 / 5.14）
 */
@RestController
@RequestMapping("/api/v1")
public class CloudApiController
{
    @Autowired
    private ItmDeviceContext deviceContext;

    @Autowired
    private ItmCloudService cloud;

    private static LoginUser user()
    {
        return SecurityUtils.getLoginUser();
    }

    // ---------------------------------------------------------------- 密钥托管

    @GetMapping("/sync/e2e-key")
    public ResponseEntity<ApiResult<Map<String, Object>>> e2eKey()
    {
        deviceContext.currentDevice();
        Map<String, Object> k = cloud.e2eKey(user().getUserId());
        ResponseEntity.BodyBuilder b = ResponseEntity.ok();
        if (k != null)
        {
            b.eTag(String.valueOf(k.get("etag")));
        }
        return b.body(ApiResult.ok(k));
    }

    @PutMapping("/sync/e2e-key")
    public ResponseEntity<ApiResult<Map<String, Object>>> putE2eKey(@RequestBody JsonNode body, @RequestHeader(value = "If-Match", required = false) String ifMatch)
    {
        ItmDevice d = deviceContext.currentDevice();
        Map<String, Object> k = cloud.putE2eKey(d, user().getUserId(), user().getUsername(), body, ifMatch);
        return ResponseEntity.ok().eTag(String.valueOf(k.get("etag"))).body(ApiResult.ok(k));
    }

    // ---------------------------------------------------------------- 云备份

    @PostMapping("/backups")
    public ApiResult<Map<String, Object>> upload(@RequestPart("meta") String meta, @RequestParam("file") MultipartFile file)
    {
        ItmDevice d = deviceContext.currentDevice();
        return ApiResult.ok(cloud.uploadBackup(d, user().getUserId(), user().getUsername(), meta, file));
    }

    @GetMapping("/backups")
    public ApiResult<List<Map<String, Object>>> list()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(cloud.listBackups(user().getUserId()));
    }

    @GetMapping("/backups/{id}/content")
    public ResponseEntity<Resource> content(@PathVariable Long id)
    {
        deviceContext.currentDevice();
        Path p = cloud.backupFile(user().getUserId(), id);
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + p.getFileName() + "\"").body(new FileSystemResource(p));
    }

    @PatchMapping("/backups/{id}")
    public ApiResult<Map<String, Object>> patch(@PathVariable Long id, @RequestBody JsonNode body)
    {
        deviceContext.currentDevice();
        return ApiResult.ok(cloud.patchBackup(user().getUserId(), id, body));
    }

    @DeleteMapping("/backups/{id}")
    public ApiResult<Void> delete(@PathVariable Long id)
    {
        ItmDevice d = deviceContext.currentDevice();
        cloud.deleteBackup(d, user().getUserId(), user().getUsername(), id);
        return ApiResult.ok(null);
    }

    // ---------------------------------------------------------------- 分享码

    @GetMapping("/shares/me")
    public ApiResult<Map<String, Object>> myShare()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(cloud.myShare(user().getUserId()));
    }

    @PutMapping("/shares/me")
    public ApiResult<Map<String, Object>> putShare(@RequestBody JsonNode body)
    {
        ItmDevice d = deviceContext.currentDevice();
        return ApiResult.ok(cloud.putShare(d, user().getUserId(), user().getUsername(), body));
    }

    @PatchMapping("/shares/me")
    public ApiResult<Map<String, Object>> patchShare(@RequestBody JsonNode body)
    {
        ItmDevice d = deviceContext.currentDevice();
        return ApiResult.ok(cloud.patchShare(d, user().getUserId(), user().getUsername(), body));
    }

    @DeleteMapping("/shares/me")
    public ApiResult<Void> closeShare()
    {
        ItmDevice d = deviceContext.currentDevice();
        cloud.closeShare(d, user().getUserId(), user().getUsername());
        return ApiResult.ok(null);
    }

    @PutMapping("/shares/me/content")
    public ApiResult<Map<String, Object>> putContent(@RequestPart("meta") String meta, @RequestParam("file") MultipartFile file)
    {
        ItmDevice d = deviceContext.currentDevice();
        return ApiResult.ok(cloud.putShareContent(d, user().getUserId(), user().getUsername(), meta, file));
    }

    // ---------------------------------------------------------------- 单项分享（第十三轮）

    @GetMapping("/share-links")
    public ApiResult<List<Map<String, Object>>> links()
    {
        deviceContext.currentDevice();
        return ApiResult.ok(cloud.listLinks(user().getUserId()));
    }

    @PostMapping("/share-links")
    public ApiResult<Map<String, Object>> createLink(@RequestPart("meta") String meta, @RequestParam("file") MultipartFile file)
    {
        ItmDevice d = deviceContext.currentDevice();
        return ApiResult.ok(cloud.createLink(d, user().getUserId(), user().getUsername(), meta, file));
    }

    @DeleteMapping("/share-links/{id}")
    public ApiResult<Void> revokeLink(@PathVariable Long id)
    {
        ItmDevice d = deviceContext.currentDevice();
        cloud.revokeLink(d, user().getUserId(), user().getUsername(), id);
        return ApiResult.ok(null);
    }

    /** 拉取前预览（lookupToken 放在请求体里，不出现在 URL 和访问日志中） */
    @PostMapping("/shares:lookup")
    public ApiResult<Map<String, Object>> lookup(@RequestBody JsonNode body)
    {
        deviceContext.currentDevice();
        return ApiResult.ok(cloud.lookupShare(user().getUserId(), body.path("lookupToken").asText("")));
    }

    @PostMapping("/shares:download")
    public ResponseEntity<Resource> download(@RequestBody JsonNode body)
    {
        ItmDevice d = deviceContext.currentDevice();
        Path p = cloud.downloadShare(d, user().getUserId(), user().getUsername(), body.path("lookupToken").asText(""));
        return ResponseEntity.ok().contentType(MediaType.APPLICATION_OCTET_STREAM).body(new FileSystemResource(p));
    }
}
