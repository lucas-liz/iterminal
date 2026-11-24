package com.ruoyi.iterminal.controller.api;

import java.nio.file.Path;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import com.ruoyi.common.annotation.Anonymous;
import com.ruoyi.iterminal.service.ItmReleaseService;

/**
 * 客户端更新源（electron-updater generic provider）：
 * GET /api/v1/releases/{channel}/{os}/{arch}/latest(-mac|-linux).yml 和安装包下载（支持 Range 断点续传）。
 * 不需要登录：还没登录的客户端也要能检查更新。
 */
@RestController
@RequestMapping("/api/v1/releases")
public class ReleaseApiController
{
    @Autowired
    private ItmReleaseService releaseService;

    @Anonymous
    @GetMapping("/{channel}/{os}/{arch}/{file:.+}")
    public ResponseEntity<?> get(@PathVariable String channel, @PathVariable String os, @PathVariable String arch, @PathVariable String file)
    {
        if (file.matches("^latest(-mac|-linux)?\\.yml$"))
        {
            String yml = releaseService.feed(channel, os, arch);
            if (yml == null)
            {
                return ResponseEntity.notFound().build();
            }
            return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/yaml; charset=utf-8")).header(HttpHeaders.CACHE_CONTROL, "no-cache").body(yml);
        }
        Path p = releaseService.file(channel, os, arch, file);
        if (p == null)
        {
            return ResponseEntity.notFound().build();
        }
        Resource body = new FileSystemResource(p);
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.attachment().filename(file).build().toString())
                .body(body);
    }
}
