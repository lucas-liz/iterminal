package com.ruoyi.iterminal.service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import com.ruoyi.common.core.domain.entity.SysRole;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.config.ItmCrypto;
import com.ruoyi.iterminal.domain.ItmTeamFolder;
import com.ruoyi.iterminal.domain.ItmTeamHost;
import com.ruoyi.iterminal.mapper.ItmTeamFolderMapper;
import com.ruoyi.iterminal.mapper.ItmTeamHostMapper;

/**
 * 团队主机（文档二 5.2 资产、5.4 团队凭证的简化版）：管理员维护分组和主机，密码 / 私钥用服务端密钥加密保存；
 * 客户端登录后按角色拉取自己能看到的主机（含凭证，经 HTTPS 传输），保存在本机加密库的「团队主机」分组里，只读。
 * 可见范围：主机设置了角色时按主机，否则按所在分组（逐级向上找第一个设置了角色的分组），都没设置时所有人可见。
 */
@Service
public class ItmTeamAssetService
{
    private static final String MASK = "******";
    private static final Set<String> PROTOCOLS = Set.of("SSH", "TELNET");
    private static final Set<String> AUTH = Set.of("PASSWORD", "KEY", "INTERACTIVE");

    @Autowired
    private ItmTeamFolderMapper folderMapper;

    @Autowired
    private ItmTeamHostMapper hostMapper;

    @Autowired
    private ItmCrypto crypto;

    // ---------------------------------------------------------------- 分组

    /** 分组树（管理后台） */
    public List<Map<String, Object>> tree()
    {
        List<ItmTeamFolder> all = folderMapper.selectAll();
        return children(all, 0L, new HashSet<>());
    }

    private List<Map<String, Object>> children(List<ItmTeamFolder> all, Long parent, Set<Long> seen)
    {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ItmTeamFolder f : all)
        {
            if (parent.equals(f.getParentId() == null ? 0L : f.getParentId()) && seen.add(f.getFolderId()))
            {
                Map<String, Object> n = new LinkedHashMap<>();
                n.put("folderId", f.getFolderId());
                n.put("parentId", f.getParentId());
                n.put("folderName", f.getFolderName());
                n.put("roleKeys", f.getRoleKeys());
                n.put("sort", f.getSort());
                n.put("hosts", hostMapper.countInFolder(f.getFolderId()));
                n.put("children", children(all, f.getFolderId(), seen));
                out.add(n);
            }
        }
        return out;
    }

    public int saveFolder(ItmTeamFolder f, String user)
    {
        if (StringUtils.isEmpty(StringUtils.trim(f.getFolderName())))
        {
            throw new ServiceException("请填写分组名称");
        }
        f.setFolderName(f.getFolderName().trim());
        long parent = f.getParentId() == null ? 0L : f.getParentId();
        if (parent != 0 && folderMapper.selectById(parent) == null)
        {
            throw new ServiceException("上级分组不存在");
        }
        if (f.getFolderId() != null)
        {
            // 不能移到自己或自己的下级里
            Map<Long, Long> parents = new HashMap<>();
            folderMapper.selectAll().forEach(x -> parents.put(x.getFolderId(), x.getParentId()));
            for (Long p = parent; p != null && p != 0; p = parents.get(p))
            {
                if (p.equals(f.getFolderId()))
                {
                    throw new ServiceException("不能移到自己或自己的下级分组里");
                }
            }
            f.setUpdateBy(user);
            return folderMapper.updateFolder(f);
        }
        f.setParentId(parent);
        f.setCreateBy(user);
        return folderMapper.insertFolder(f);
    }

    public int deleteFolder(Long folderId)
    {
        if (folderMapper.countChildren(folderId) > 0 || hostMapper.countInFolder(folderId) > 0)
        {
            throw new ServiceException("分组里还有下级分组或主机，请先移走或删除");
        }
        return folderMapper.deleteById(folderId);
    }

    // ---------------------------------------------------------------- 主机

    /** 返回给管理后台：密码 / 私钥显示为 ******（没有设置时为空） */
    public ItmTeamHost masked(ItmTeamHost h)
    {
        if (h != null)
        {
            h.setPassword(StringUtils.isNotEmpty(h.getPasswordEnc()) ? MASK : "");
            h.setPrivateKey(StringUtils.isNotEmpty(h.getPrivateKeyEnc()) ? MASK : "");
            h.setPassphrase(StringUtils.isNotEmpty(h.getPassphraseEnc()) ? MASK : "");
        }
        return h;
    }

    public int saveHost(ItmTeamHost h, String user)
    {
        if (StringUtils.isEmpty(StringUtils.trim(h.getHostName())))
        {
            throw new ServiceException("请填写主机名称");
        }
        if (StringUtils.isEmpty(StringUtils.trim(h.getAddress())) || !h.getAddress().trim().matches("^[\\w.:\\-\\[\\]%]+$"))
        {
            throw new ServiceException("主机地址不正确");
        }
        h.setHostName(h.getHostName().trim());
        h.setAddress(h.getAddress().trim());
        if (h.getProtocol() == null)
        {
            h.setProtocol("SSH");
        }
        if (!PROTOCOLS.contains(h.getProtocol()))
        {
            throw new ServiceException("协议只支持 SSH / TELNET");
        }
        if (h.getPort() == null)
        {
            h.setPort("TELNET".equals(h.getProtocol()) ? 23 : 22);
        }
        if (h.getPort() < 1 || h.getPort() > 65535)
        {
            throw new ServiceException("端口需要是 1–65535");
        }
        if (h.getAuthMethod() == null)
        {
            h.setAuthMethod("PASSWORD");
        }
        if (!AUTH.contains(h.getAuthMethod()))
        {
            throw new ServiceException("认证方式不正确");
        }
        if (changed(h.getPrivateKey()) && StringUtils.isNotEmpty(h.getPrivateKey()) && !h.getPrivateKey().contains("PRIVATE KEY"))
        {
            throw new ServiceException("私钥格式不正确（需要 OpenSSH / PEM 格式，以 -----BEGIN ... PRIVATE KEY----- 开头）");
        }
        ItmTeamHost old = h.getHostId() == null ? null : hostMapper.selectById(h.getHostId());
        if (h.getHostId() != null && old == null)
        {
            throw new ServiceException("主机不存在");
        }
        long folder = h.getFolderId() == null ? 0L : h.getFolderId();
        if (folder != 0 && folderMapper.selectById(folder) == null)
        {
            throw new ServiceException("分组不存在");
        }
        h.setFolderId(folder);
        int n;
        if (h.getHostId() == null)
        {
            h.setCreateBy(user);
            n = hostMapper.insertHost(h);
        }
        else
        {
            h.setUpdateBy(user);
            n = hostMapper.updateHost(h);
        }
        // 密文：****** 或 null 表示不修改，空串表示清除（原来就没有时不算修改）
        String aad = "host:" + h.getHostId();
        String pw = changed(h.getPassword(), old == null ? null : old.getPasswordEnc()) ? crypto.encrypt(h.getPassword(), aad + ":pw") : null;
        String key = changed(h.getPrivateKey(), old == null ? null : old.getPrivateKeyEnc()) ? crypto.encrypt(h.getPrivateKey(), aad + ":key") : null;
        String pp = changed(h.getPassphrase(), old == null ? null : old.getPassphraseEnc()) ? crypto.encrypt(h.getPassphrase(), aad + ":pp") : null;
        if (pw != null || key != null || pp != null)
        {
            hostMapper.updateSecrets(h.getHostId(), pw, key, pp);
        }
        return n;
    }

    private static boolean changed(String v)
    {
        return v != null && !MASK.equals(v);
    }

    private static boolean changed(String v, String oldEnc)
    {
        return changed(v) && !(v.isEmpty() && StringUtils.isEmpty(oldEnc));
    }

    // ---------------------------------------------------------------- 客户端同步

    /** 这个用户能看到的团队主机（含解密后的凭证）和它们所在的分组 */
    public Map<String, Object> assetsFor(LoginUser user)
    {
        List<ItmTeamFolder> folders = folderMapper.selectAll();
        Map<Long, ItmTeamFolder> byId = new HashMap<>();
        folders.forEach(f -> byId.put(f.getFolderId(), f));
        boolean admin = user.getUser() != null && user.getUser().isAdmin();
        Set<String> mine = new HashSet<>();
        if (user.getUser() != null && user.getUser().getRoles() != null)
        {
            user.getUser().getRoles().stream().map(SysRole::getRoleKey).forEach(mine::add);
        }

        List<Map<String, Object>> hosts = new ArrayList<>();
        Set<Long> usedFolders = new HashSet<>();
        for (ItmTeamHost h : hostMapper.selectEnabled())
        {
            if (!admin && !visible(roles(h.getRoleKeys(), h.getFolderId(), byId), mine))
            {
                continue;
            }
            String aad = "host:" + h.getHostId();
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", h.getHostId());
            v.put("folderId", h.getFolderId() == null || h.getFolderId() == 0 ? null : h.getFolderId());
            v.put("name", h.getHostName());
            v.put("protocol", h.getProtocol());
            v.put("address", h.getAddress());
            v.put("port", h.getPort());
            v.put("username", h.getUsername());
            v.put("authMethod", h.getAuthMethod());
            v.put("password", nullIfEmpty(crypto.decrypt(h.getPasswordEnc(), aad + ":pw")));
            v.put("privateKey", nullIfEmpty(crypto.decrypt(h.getPrivateKeyEnc(), aad + ":key")));
            v.put("passphrase", nullIfEmpty(crypto.decrypt(h.getPassphraseEnc(), aad + ":pp")));
            v.put("allowReveal", "1".equals(h.getAllowReveal()));
            v.put("note", h.getNote());
            v.put("version", h.getVersion());
            hosts.add(v);
            for (Long f = h.getFolderId(); f != null && f != 0 && usedFolders.add(f); f = byId.containsKey(f) ? byId.get(f).getParentId() : null)
            {
                // 用到的分组和它们的上级都要下发
            }
        }
        List<Map<String, Object>> fs = new ArrayList<>();
        for (ItmTeamFolder f : folders)
        {
            if (usedFolders.contains(f.getFolderId()))
            {
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("id", f.getFolderId());
                v.put("parentId", f.getParentId() == null || f.getParentId() == 0 ? null : f.getParentId());
                v.put("name", f.getFolderName());
                v.put("sort", f.getSort());
                fs.add(v);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("folders", fs);
        out.put("hosts", hosts);
        return out;
    }

    private static String nullIfEmpty(String s)
    {
        return StringUtils.isEmpty(s) ? null : s;
    }

    /** 主机的有效可见角色：主机自己的，否则逐级向上找分组的；都没有返回空串（所有人可见） */
    private static String roles(String hostRoles, Long folderId, Map<Long, ItmTeamFolder> byId)
    {
        if (StringUtils.isNotEmpty(StringUtils.trim(hostRoles)))
        {
            return hostRoles;
        }
        Set<Long> seen = new HashSet<>();
        for (Long f = folderId; f != null && f != 0 && seen.add(f); )
        {
            ItmTeamFolder folder = byId.get(f);
            if (folder == null)
            {
                break;
            }
            if (StringUtils.isNotEmpty(StringUtils.trim(folder.getRoleKeys())))
            {
                return folder.getRoleKeys();
            }
            f = folder.getParentId();
        }
        return "";
    }

    private static boolean visible(String roleKeys, Set<String> mine)
    {
        if (StringUtils.isEmpty(StringUtils.trim(roleKeys)))
        {
            return true;
        }
        for (String r : roleKeys.split("[,，\\s]+"))
        {
            if (!r.isBlank() && mine.contains(r.trim()))
            {
                return true;
            }
        }
        return false;
    }
}
