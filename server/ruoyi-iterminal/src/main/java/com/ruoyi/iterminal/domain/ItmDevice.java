package com.ruoyi.iterminal.domain;

import com.fasterxml.jackson.annotation.JsonFormat;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.ruoyi.common.annotation.Excel;
import com.ruoyi.common.core.domain.BaseEntity;
import java.util.Date;

/**
 * 客户端设备（itm_device）
 */
public class ItmDevice extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 设备ID */
    @Excel(name = "设备ID")
    private String deviceId;

    /** 用户ID */
    private Long userId;

    /** 用户账号 */
    @Excel(name = "用户账号")
    private String userName;

    /** 设备名称 */
    @Excel(name = "设备名称")
    private String deviceName;

    /** 系统 */
    @Excel(name = "系统")
    private String os;

    /** 架构 */
    @Excel(name = "架构")
    private String arch;

    /** 客户端版本 */
    @Excel(name = "客户端版本")
    private String clientVersion;

    /** 刷新令牌摘要（不返回给前端） */
    @JsonIgnore
    private String refreshTokenHash;

    /** 刷新令牌过期时间 */
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date refreshExpiresAt;

    /** 状态（0正常 1已吊销） */
    @Excel(name = "状态（0正常 1已吊销）")
    private String status;

    /** 是否在线（0否 1是） */
    @Excel(name = "是否在线（0否 1是）")
    private String online;

    /** 最后登录IP */
    @Excel(name = "最后登录IP")
    private String lastIp;

    /** 最后活跃时间 */
    @Excel(name = "最后活跃时间", width = 20, dateFormat = "yyyy-MM-dd HH:mm:ss")
    @JsonFormat(pattern = "yyyy-MM-dd HH:mm:ss", timezone = "GMT+8")
    private Date lastSeenAt;

    public String getDeviceId()
    {
        return deviceId;
    }

    public void setDeviceId(String deviceId)
    {
        this.deviceId = deviceId;
    }

    public Long getUserId()
    {
        return userId;
    }

    public void setUserId(Long userId)
    {
        this.userId = userId;
    }

    public String getUserName()
    {
        return userName;
    }

    public void setUserName(String userName)
    {
        this.userName = userName;
    }

    public String getDeviceName()
    {
        return deviceName;
    }

    public void setDeviceName(String deviceName)
    {
        this.deviceName = deviceName;
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

    public String getClientVersion()
    {
        return clientVersion;
    }

    public void setClientVersion(String clientVersion)
    {
        this.clientVersion = clientVersion;
    }

    public String getRefreshTokenHash()
    {
        return refreshTokenHash;
    }

    public void setRefreshTokenHash(String refreshTokenHash)
    {
        this.refreshTokenHash = refreshTokenHash;
    }

    public Date getRefreshExpiresAt()
    {
        return refreshExpiresAt;
    }

    public void setRefreshExpiresAt(Date refreshExpiresAt)
    {
        this.refreshExpiresAt = refreshExpiresAt;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }

    public String getOnline()
    {
        return online;
    }

    public void setOnline(String online)
    {
        this.online = online;
    }

    public String getLastIp()
    {
        return lastIp;
    }

    public void setLastIp(String lastIp)
    {
        this.lastIp = lastIp;
    }

    public Date getLastSeenAt()
    {
        return lastSeenAt;
    }

    public void setLastSeenAt(Date lastSeenAt)
    {
        this.lastSeenAt = lastSeenAt;
    }
}
