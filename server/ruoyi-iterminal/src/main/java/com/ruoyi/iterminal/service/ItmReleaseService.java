package com.ruoyi.iterminal.service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import com.ruoyi.common.config.RuoYiConfig;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.domain.ItmRelease;
import com.ruoyi.iterminal.mapper.ItmReleaseMapper;

/**
 * 客户端版本发布（文档二 5.12）：管理员上传安装包，服务端算 SHA-512，按渠道 / 系统 / 架构生成 electron-updater 的
 * generic 更新源（latest.yml、latest-mac.yml、latest-linux.yml），并提供安装包下载（支持断点续传）。
 * 文件保存在 {上传目录}/itm/releases/{channel}/{os}/{arch}/{文件名}。
 */
@Service
public class ItmReleaseService
{
    private static final Set<String> CHANNELS = Set.of("stable", "beta");
    private static final Set<String> OSES = Set.of("mac", "win", "linux");
    private static final Set<String> ARCHES = Set.of("x64", "arm64");
    private static final Pattern VERSION = Pattern.compile("^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$");
    private static final Pattern FILE = Pattern.compile("^[0-9A-Za-z][0-9A-Za-z ._()+-]{0,200}\\.(dmg|zip|exe|msi|AppImage|deb|rpm|blockmap)$");

    @Autowired
    private ItmReleaseMapper releaseMapper;

    public List<ItmRelease> list(ItmRelease q)
    {
        return releaseMapper.selectItmReleaseList(q);
    }

    public ItmRelease get(Long id)
    {
        return releaseMapper.selectItmReleaseById(id);
    }

    public ItmRelease upload(MultipartFile file, ItmRelease meta, String user)
    {
        if (file == null || file.isEmpty())
        {
            throw new ServiceException("请选择安装包");
        }
        String name = StringUtils.trim(file.getOriginalFilename());
        if (name == null || !FILE.matcher(name).matches())
        {
            throw new ServiceException("文件名不正确：只支持 dmg / zip / exe / msi / AppImage / deb / rpm / blockmap，文件名里不能有 / 等特殊字符");
        }
        if (!VERSION.matcher(StringUtils.nvl(meta.getVersion(), "")).matches())
        {
            throw new ServiceException("版本号格式是 主版本.次版本.修订号，例如 0.2.0 或 0.3.0-beta.1");
        }
        if (!CHANNELS.contains(meta.getChannel()) || !OSES.contains(meta.getOs()) || !ARCHES.contains(meta.getArch()))
        {
            throw new ServiceException("渠道 / 系统 / 架构不正确");
        }
        int rollout = meta.getRolloutPercent() == null ? 100 : meta.getRolloutPercent();
        if (rollout < 1 || rollout > 100)
        {
            throw new ServiceException("灰度比例需要是 1–100");
        }
        String rel = "itm/releases/" + meta.getChannel() + "/" + meta.getOs() + "/" + meta.getArch() + "/" + name;
        for (ItmRelease r : releaseMapper.selectPublished(meta.getChannel(), meta.getOs(), meta.getArch()))
        {
            if (r.getFileName().equals(name))
            {
                throw new ServiceException("这个渠道下已经有同名的安装包，请先删除或下架旧的");
            }
        }
        Path target = Path.of(RuoYiConfig.getProfile(), rel);
        String sha512;
        long size;
        try
        {
            Files.createDirectories(target.getParent());
            MessageDigest md = MessageDigest.getInstance("SHA-512");
            try (InputStream in = file.getInputStream(); OutputStream out = new DigestOutputStream(Files.newOutputStream(target), md))
            {
                size = in.transferTo(out);
            }
            sha512 = Base64.getEncoder().encodeToString(md.digest());
        }
        catch (Exception e)
        {
            throw new ServiceException("保存安装包失败：" + e.getMessage());
        }
        ItmRelease r = new ItmRelease();
        r.setVersion(meta.getVersion());
        r.setChannel(meta.getChannel());
        r.setOs(meta.getOs());
        r.setArch(meta.getArch());
        r.setFileName(name);
        r.setFilePath(rel);
        r.setFileSize(size);
        r.setSha512(sha512);
        r.setRolloutPercent(rollout);
        r.setMinVersion(StringUtils.nvl(meta.getMinVersion(), ""));
        r.setReleaseNotes(meta.getReleaseNotes());
        r.setStatus("0");
        r.setCreateBy(user);
        releaseMapper.insertItmRelease(r);
        return r;
    }

    public int update(ItmRelease r)
    {
        if (r.getRolloutPercent() != null && (r.getRolloutPercent() < 1 || r.getRolloutPercent() > 100))
        {
            throw new ServiceException("灰度比例需要是 1–100");
        }
        return releaseMapper.updateItmRelease(r);
    }

    public int delete(Long[] ids)
    {
        for (Long id : ids)
        {
            ItmRelease r = releaseMapper.selectItmReleaseById(id);
            if (r != null)
            {
                try
                {
                    Files.deleteIfExists(Path.of(RuoYiConfig.getProfile(), r.getFilePath()));
                }
                catch (IOException ignored)
                {
                    // 文件已经不在了
                }
            }
        }
        return releaseMapper.deleteItmReleaseByIds(ids);
    }

    /**
     * 更新源的 yml：这个渠道 / 系统 / 架构下已发布的最高版本，列出它的所有安装包（blockmap 除外）。没有版本时返回 null。
     */
    public String feed(String channel, String os, String arch)
    {
        if (!CHANNELS.contains(channel) || !OSES.contains(os) || !ARCHES.contains(arch))
        {
            return null;
        }
        List<ItmRelease> all = releaseMapper.selectPublished(channel, os, arch);
        String latest = all.stream().map(ItmRelease::getVersion).max(ItmReleaseService::compareVersions).orElse(null);
        if (latest == null)
        {
            return null;
        }
        List<ItmRelease> files = new ArrayList<>();
        for (ItmRelease r : all)
        {
            if (latest.equals(r.getVersion()) && !r.getFileName().endsWith(".blockmap"))
            {
                files.add(r);
            }
        }
        // electron-updater 按 path 找默认的安装包：macOS 用 zip，Windows 用 exe，Linux 用 AppImage
        String prefer = "mac".equals(os) ? ".zip" : "win".equals(os) ? ".exe" : ".AppImage";
        files.sort(Comparator.comparing((ItmRelease r) -> !r.getFileName().endsWith(prefer)).thenComparing(ItmRelease::getFileName));
        ItmRelease main = files.get(0);
        StringBuilder y = new StringBuilder();
        y.append("version: ").append(latest).append('\n');
        y.append("files:\n");
        for (ItmRelease r : files)
        {
            y.append("  - url: ").append(q(r.getFileName())).append('\n');
            y.append("    sha512: ").append(r.getSha512()).append('\n');
            y.append("    size: ").append(r.getFileSize()).append('\n');
        }
        y.append("path: ").append(q(main.getFileName())).append('\n');
        y.append("sha512: ").append(main.getSha512()).append('\n');
        y.append("releaseDate: ").append(q(Instant.ofEpochMilli(main.getCreateTime().getTime()).toString())).append('\n');
        if (StringUtils.isNotEmpty(main.getMinVersion()))
        {
            y.append("minimumSupportedVersion: ").append(q(main.getMinVersion())).append('\n');
        }
        if (main.getRolloutPercent() != null && main.getRolloutPercent() < 100)
        {
            y.append("stagingPercentage: ").append(main.getRolloutPercent()).append('\n');
        }
        if (StringUtils.isNotEmpty(main.getReleaseNotes()))
        {
            y.append("releaseNotes: |-\n");
            for (String line : main.getReleaseNotes().split("\\r?\\n"))
            {
                y.append("  ").append(line).append('\n');
            }
        }
        return y.toString();
    }

    /** 已发布的安装包文件；不存在返回 null */
    public Path file(String channel, String os, String arch, String fileName)
    {
        if (!CHANNELS.contains(channel) || !OSES.contains(os) || !ARCHES.contains(arch) || fileName == null || !FILE.matcher(fileName).matches())
        {
            return null;
        }
        for (ItmRelease r : releaseMapper.selectPublished(channel, os, arch))
        {
            if (r.getFileName().equals(fileName))
            {
                Path p = Path.of(RuoYiConfig.getProfile(), r.getFilePath());
                return Files.isRegularFile(p) ? p : null;
            }
        }
        return null;
    }

    /** YAML 单引号字符串 */
    private static String q(String s)
    {
        return "'" + s.replace("'", "''") + "'";
    }

    /** 比较版本号：0.10.0 > 0.9.0，正式版 > 同号的预发布版 */
    static int compareVersions(String a, String b)
    {
        String[] pa = a.split("-", 2);
        String[] pb = b.split("-", 2);
        String[] na = pa[0].split("\\.");
        String[] nb = pb[0].split("\\.");
        for (int i = 0; i < Math.max(na.length, nb.length); i++)
        {
            long x = i < na.length ? Long.parseLong(na[i]) : 0;
            long y = i < nb.length ? Long.parseLong(nb[i]) : 0;
            if (x != y)
            {
                return Long.compare(x, y);
            }
        }
        if (pa.length == 1 && pb.length == 1)
        {
            return 0;
        }
        if (pa.length == 1)
        {
            return 1;
        }
        if (pb.length == 1)
        {
            return -1;
        }
        return pa[1].compareTo(pb[1]);
    }
}
