package com.ruoyi.iterminal.service;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import com.ruoyi.common.core.domain.entity.SysRole;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.utils.StringUtils;

/**
 * 可用范围（第十三轮，文档二 5.5 / 5.8）：团队模型、知识库可以按角色、用户、组织（部门）授权，满足任意一项即可；
 * 三项都为空表示所有登录用户；组织包含下级部门（按 sys_dept.ancestors）；管理员始终可用。
 */
@Component
public class ItmGrant
{
    private static final long DEPT_TTL_MS = 60_000;

    @Autowired
    private JdbcTemplate jdbc;

    /** 部门 ID → [自己, 上级, 上上级…]，缓存 1 分钟（部门调整后最多 1 分钟生效） */
    private final Map<Long, Object[]> deptChains = new ConcurrentHashMap<>();

    public static Set<String> split(String s)
    {
        Set<String> out = new HashSet<>();
        for (String x : StringUtils.nvl(s, "").split("[,，\\s]+"))
        {
            if (!x.isBlank())
            {
                out.add(x.trim());
            }
        }
        return out;
    }

    /** 规范化 ID 列表：只保留数字，去重，逗号分隔 */
    public static String normalizeIds(Object v, int maxLen)
    {
        List<String> ids = new ArrayList<>();
        Iterable<?> items = v instanceof Iterable<?> it ? it : List.of(StringUtils.nvl(v == null ? null : String.valueOf(v), "").split("[,，\\s]+"));
        for (Object o : items)
        {
            String s = o == null ? "" : String.valueOf(o).trim();
            if (s.matches("^\\d{1,19}$") && !ids.contains(s))
            {
                ids.add(s);
            }
        }
        String out = String.join(",", ids);
        if (out.length() > maxLen)
        {
            throw new com.ruoyi.common.exception.ServiceException("选择的用户或组织太多了");
        }
        return out;
    }

    /** 规范化角色列表（权限字符） */
    public static String normalizeKeys(Object v, int maxLen)
    {
        List<String> keys = new ArrayList<>();
        Iterable<?> items = v instanceof Iterable<?> it ? it : List.of(StringUtils.nvl(v == null ? null : String.valueOf(v), "").split("[,，\\s]+"));
        for (Object o : items)
        {
            String s = o == null ? "" : String.valueOf(o).trim();
            if (!s.isEmpty() && s.length() <= 100 && !keys.contains(s))
            {
                keys.add(s);
            }
        }
        return StringUtils.substring(String.join(",", keys), 0, maxLen);
    }

    private List<Long> deptChain(Long deptId)
    {
        if (deptId == null)
        {
            return List.of();
        }
        Object[] cached = deptChains.get(deptId);
        if (cached != null && System.currentTimeMillis() - (Long) cached[0] < DEPT_TTL_MS)
        {
            @SuppressWarnings("unchecked")
            List<Long> v = (List<Long>) cached[1];
            return v;
        }
        List<Long> chain = new ArrayList<>();
        chain.add(deptId);
        List<String> rows = jdbc.queryForList("select ancestors from sys_dept where dept_id = ?", String.class, deptId);
        if (!rows.isEmpty())
        {
            for (String a : StringUtils.nvl(rows.get(0), "").split(","))
            {
                if (a.trim().matches("^\\d+$") && !"0".equals(a.trim()))
                {
                    chain.add(Long.valueOf(a.trim()));
                }
            }
        }
        deptChains.put(deptId, new Object[] { System.currentTimeMillis(), chain });
        return chain;
    }

    /** 这个用户是否在可用范围内 */
    public boolean allowed(LoginUser user, String roleKeys, String userIds, String deptIds)
    {
        Set<String> roles = split(roleKeys);
        Set<String> users = split(userIds);
        Set<String> depts = split(deptIds);
        if (roles.isEmpty() && users.isEmpty() && depts.isEmpty())
        {
            return true;
        }
        if (user == null || user.getUser() == null)
        {
            return false;
        }
        if (user.getUser().isAdmin())
        {
            return true;
        }
        if (user.getUserId() != null && users.contains(String.valueOf(user.getUserId())))
        {
            return true;
        }
        if (!roles.isEmpty() && user.getUser().getRoles() != null)
        {
            for (SysRole r : user.getUser().getRoles())
            {
                if (r.getRoleKey() != null && roles.contains(r.getRoleKey()))
                {
                    return true;
                }
            }
        }
        if (!depts.isEmpty())
        {
            for (Long d : deptChain(user.getDeptId() != null ? user.getDeptId() : user.getUser().getDeptId()))
            {
                if (depts.contains(String.valueOf(d)))
                {
                    return true;
                }
            }
        }
        return false;
    }

    /** 管理后台的选项：角色、用户（正常状态，最多 2000 个）、部门树 */
    public Map<String, Object> options()
    {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("roles", jdbc.queryForList("select role_key as roleKey, role_name as roleName from sys_role where status = '0' and del_flag = '0' order by role_sort"));
        out.put("users", jdbc.queryForList(
            "select u.user_id as userId, u.user_name as userName, u.nick_name as nickName, ifnull(d.dept_name, '') as deptName from sys_user u left join sys_dept d on d.dept_id = u.dept_id "
                + "where u.del_flag = '0' and u.status = '0' order by u.user_id limit 2000"));
        List<Map<String, Object>> depts = jdbc.queryForList("select dept_id as id, parent_id as parentId, dept_name as label from sys_dept where del_flag = '0' and status = '0' order by parent_id, order_num");
        Map<Object, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Map<String, Object> d : depts)
        {
            Map<String, Object> n = new LinkedHashMap<>(d);
            n.put("children", new ArrayList<Map<String, Object>>());
            byId.put(((Number) d.get("id")).longValue(), n);
        }
        List<Map<String, Object>> roots = new ArrayList<>();
        for (Map<String, Object> n : byId.values())
        {
            Map<String, Object> parent = byId.get(((Number) n.get("parentId")).longValue());
            if (parent == null)
            {
                roots.add(n);
            }
            else
            {
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> ch = (List<Map<String, Object>>) parent.get("children");
                ch.add(n);
            }
        }
        out.put("depts", roots);
        return out;
    }
}
