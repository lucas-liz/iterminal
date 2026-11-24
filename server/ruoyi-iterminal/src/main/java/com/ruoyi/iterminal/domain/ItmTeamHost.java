package com.ruoyi.iterminal.domain;

import com.ruoyi.common.core.domain.BaseEntity;

/**
 * 团队主机（itm_team_host）
 */
public class ItmTeamHost extends BaseEntity
{
    private static final long serialVersionUID = 1L;

    /** 主机ID */
    private Long hostId;

    /** 分组ID（0 表示顶层） */
    private Long folderId;

    /** 名称 */
    private String hostName;

    /** 协议（SSH / TELNET） */
    private String protocol;

    /** 地址 */
    private String address;

    /** 端口 */
    private Integer port;

    /** 登录用户名 */
    private String username;

    /** 认证方式（PASSWORD / KEY / INTERACTIVE） */
    private String authMethod;

    /** 密码密文 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    private String passwordEnc;

    /** 私钥密文 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    private String privateKeyEnc;

    /** 私钥口令密文 */
    @com.fasterxml.jackson.annotation.JsonIgnore
    private String passphraseEnc;

    /** 密码：保存时传明文；读取时 ****** 表示已经设置 */
    private String password;

    /** 私钥：同上 */
    private String privateKey;

    /** 私钥口令：同上 */
    private String passphrase;

    /** 允许客户端查看密码（0否 1是） */
    private String allowReveal;

    /** 可见的角色（为空时按分组） */
    private String roleKeys;

    /** 备注 */
    private String note;

    /** 显示顺序 */
    private Integer sort;

    /** 状态（0启用 1停用） */
    private String status;

    /** 版本 */
    private Integer version;

    public Long getHostId()
    {
        return hostId;
    }

    public void setHostId(Long hostId)
    {
        this.hostId = hostId;
    }

    public Long getFolderId()
    {
        return folderId;
    }

    public void setFolderId(Long folderId)
    {
        this.folderId = folderId;
    }

    public String getHostName()
    {
        return hostName;
    }

    public void setHostName(String hostName)
    {
        this.hostName = hostName;
    }

    public String getProtocol()
    {
        return protocol;
    }

    public void setProtocol(String protocol)
    {
        this.protocol = protocol;
    }

    public String getAddress()
    {
        return address;
    }

    public void setAddress(String address)
    {
        this.address = address;
    }

    public Integer getPort()
    {
        return port;
    }

    public void setPort(Integer port)
    {
        this.port = port;
    }

    public String getUsername()
    {
        return username;
    }

    public void setUsername(String username)
    {
        this.username = username;
    }

    public String getAuthMethod()
    {
        return authMethod;
    }

    public void setAuthMethod(String authMethod)
    {
        this.authMethod = authMethod;
    }

    public String getPasswordEnc()
    {
        return passwordEnc;
    }

    public void setPasswordEnc(String passwordEnc)
    {
        this.passwordEnc = passwordEnc;
    }

    public String getPrivateKeyEnc()
    {
        return privateKeyEnc;
    }

    public void setPrivateKeyEnc(String privateKeyEnc)
    {
        this.privateKeyEnc = privateKeyEnc;
    }

    public String getPassphraseEnc()
    {
        return passphraseEnc;
    }

    public void setPassphraseEnc(String passphraseEnc)
    {
        this.passphraseEnc = passphraseEnc;
    }

    public String getPassword()
    {
        return password;
    }

    public void setPassword(String password)
    {
        this.password = password;
    }

    public String getPrivateKey()
    {
        return privateKey;
    }

    public void setPrivateKey(String privateKey)
    {
        this.privateKey = privateKey;
    }

    public String getPassphrase()
    {
        return passphrase;
    }

    public void setPassphrase(String passphrase)
    {
        this.passphrase = passphrase;
    }

    public String getAllowReveal()
    {
        return allowReveal;
    }

    public void setAllowReveal(String allowReveal)
    {
        this.allowReveal = allowReveal;
    }

    public String getRoleKeys()
    {
        return roleKeys;
    }

    public void setRoleKeys(String roleKeys)
    {
        this.roleKeys = roleKeys;
    }

    public String getNote()
    {
        return note;
    }

    public void setNote(String note)
    {
        this.note = note;
    }

    public Integer getSort()
    {
        return sort;
    }

    public void setSort(Integer sort)
    {
        this.sort = sort;
    }

    public String getStatus()
    {
        return status;
    }

    public void setStatus(String status)
    {
        this.status = status;
    }

    public Integer getVersion()
    {
        return version;
    }

    public void setVersion(Integer version)
    {
        this.version = version;
    }
}
