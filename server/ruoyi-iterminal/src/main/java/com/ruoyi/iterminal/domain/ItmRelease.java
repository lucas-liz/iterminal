package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * 客户端版本（itm_release）
 */
public class ItmRelease extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 主键 */
    private Long releaseId;

    /** 版本号 */
    private String version;

    /** 渠道 */
    private String channel;

    /** 系统 */
    private String os;

    /** 架构 */
    private String arch;

    /** 文件名 */
    private String fileName;

    /** 文件路径 */
    private String filePath;

    /** 大小 */
    private Long fileSize;

    /** SHA-512 */
    private String sha512;

    /** 灰度比例 */
    private Integer rolloutPercent;

    /** 最低版本 */
    private String minVersion;

    /** 更新说明 */
    private String releaseNotes;

    /** 状态 */
    private String status;

    public Long getReleaseId()
    {
        return releaseId;
    }

    public void setReleaseId(Long releaseId)
    {
        this.releaseId = releaseId;
    }

    public String getVersion()
    {
        return version;
    }

    public void setVersion(String version)
    {
        this.version = version;
    }

    public String getChannel()
    {
        return channel;
    }

    public void setChannel(String channel)
    {
        this.channel = channel;
    }

    public String getOs()
    {
        return os;
    }

    public void setOs(String os)
    {
        this.os = os;
    }

    public String getArch()
    {
        return arch;
    }

    public void setArch(String arch)
    {
        this.arch = arch;
    }

    public String getFileName()
    {
        return fileName;
    }

    public void setFileName(String fileName)
    {
        this.fileName = fileName;
    }

    public String getFilePath()
    {
        return filePath;
    }

    public void setFilePath(String filePath)
    {
        this.filePath = filePath;
    }

    public Long getFileSize()
    {
        return fileSize;
    }

    public void setFileSize(Long fileSize)
    {
        this.fileSize = fileSize;
    }

    public String getSha512()
    {
        return sha512;
    }

    public void setSha512(String sha512)
    {
        this.sha512 = sha512;
    }

    public Integer getRolloutPercent()
    {
        return rolloutPercent;
    }

    public void setRolloutPercent(Integer rolloutPercent)
    {
        this.rolloutPercent = rolloutPercent;
    }

    public String getMinVersion()
    {
        return minVersion;
    }

    public void setMinVersion(String minVersion)
    {
        this.minVersion = minVersion;
    }

    public String getReleaseNotes()
    {
        return releaseNotes;
    }

    public void setReleaseNotes(String releaseNotes)
    {
        this.releaseNotes = releaseNotes;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }
}
