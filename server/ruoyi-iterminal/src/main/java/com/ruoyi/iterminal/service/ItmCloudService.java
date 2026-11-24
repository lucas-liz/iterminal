package com.ruoyi.iterminal.service;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.config.RuoYiConfig;
import com.ruoyi.common.core.redis.RedisCache;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.domain.ItmAuditCommand;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.mapper.ItmAuditCommandMapper;
import com.ruoyi.system.service.ISysConfigService;

/**
 * 云备份、个人分享码和端到端加密的密钥托管（文档二 5.3.3 / 5.13 / 5.14）。
 * 备份包、分享包、分享码都是客户端加密好的密文，服务端只保存和转发，不解析、不解密：
 * - 密钥托管：保存同步密码 / 恢复码包装后的 CDK，乐观锁（ETag / If-Match）防止两台设备同时修改；
 * - 云备份：每人保留最近 N 份（置顶的另外最多 5 份），只有本人能下载；
 * - 分享码：服务端只存 SHA-256(lookupToken)；分享包只保留最新一份；拉取方用 lookupToken 查找和下载。
 */
@Service
public class ItmCloudService
{
    /** SKILLS：客户端 Skill（SKILL.md，第二十二轮）；内容和其他分组一样端到端加密，服务端只校验分组名和条数 */
    public static final Set<String> GROUPS = Set.of("HOSTS", "SNIPPETS", "NOTES", "SKILLS", "CREDENTIALS");
    private static final Map<String, List<String>> COUNT_KEYS = Map.of(
        "HOSTS", List.of("hosts", "hostGroups"), "SNIPPETS", List.of("snippets", "snippetGroups"),
        "NOTES", List.of("notes", "noteGroups"), "SKILLS", List.of("skills"), "CREDENTIALS", List.of("credentials"));
    private static final int MAX_PINNED = 5;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private RedisCache redisCache;

    @Autowired
    private ItmAuditCommandMapper auditMapper;

    // ---------------------------------------------------------------- 工具

    private boolean flag(String key, boolean fallback)
    {
        String v = configService.selectConfigByKey(key);
        return StringUtils.isEmpty(v) ? fallback : !"false".equalsIgnoreCase(v.trim());
    }

    private int intConfig(String key, int fallback)
    {
        try
        {
            return Integer.parseInt(configService.selectConfigByKey(key).trim());
        }
        catch (Exception e)
        {
            return fallback;
        }
    }

    private static String sha256Hex(byte[] data)
    {
        try
        {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(data));
        }
        catch (Exception e)
        {
            throw new IllegalStateException(e);
        }
    }

    /** 每人每小时的次数限制 */
    private void rateLimit(String kind, Long userId, int perHour, String message)
    {
        String key = "itm:rl:" + kind + ":" + userId + ":" + (System.currentTimeMillis() / 3_600_000);
        Long n = redisCache.redisTemplate.opsForValue().increment(key);
        if (n != null && n == 1)
        {
            redisCache.expire(key, 2, TimeUnit.HOURS);
        }
        if (n != null && n > perHour)
        {
            throw new ApiException(org.springframework.http.HttpStatus.TOO_MANY_REQUESTS, message);
        }
    }

    /** 安全事件写进命令审计（kind = EVENT） */
    private void audit(ItmDevice device, Long userId, String userName, String type, Map<String, Object> detail)
    {
        try
        {
            ItmAuditCommand c = new ItmAuditCommand();
            c.setClientEventId("srv-" + UUID.randomUUID());
            c.setDeviceId(device == null ? "" : device.getDeviceId());
            c.setUserId(userId);
            c.setUserName(userName);
            c.setKind("EVENT");
            c.setSource("USER");
            c.setEventType(type);
            c.setDetail(objectMapper.writeValueAsString(detail));
            c.setOccurredAt(new Date());
            auditMapper.insertIgnoreBatch(List.of(c));
        }
        catch (Exception ignored)
        {
            // 审计失败不影响操作
        }
    }

    /** 分组和条数：分组只能是 GROUPS 之一，条数的键必须属于所含分组 */
    private List<String> checkGroups(JsonNode groupsNode, JsonNode counts, boolean allowCredentials)
    {
        List<String> groups = new ArrayList<>();
        if (groupsNode != null && groupsNode.isArray())
        {
            for (JsonNode g : groupsNode)
            {
                String v = g.asText("");
                if (!GROUPS.contains(v))
                {
                    throw ApiException.badRequest("分组不正确：" + v);
                }
                if (!groups.contains(v))
                {
                    groups.add(v);
                }
            }
        }
        if (groups.isEmpty())
        {
            throw ApiException.badRequest("请至少包含一个分组");
        }
        if (groups.contains("CREDENTIALS") && !allowCredentials)
        {
            throw ApiException.forbidden("管理员禁止了个人凭证上云（备份和分享都不能包含凭证）");
        }
        if (counts != null && counts.isObject())
        {
            List<String> allowed = groups.stream().flatMap(g -> COUNT_KEYS.get(g).stream()).toList();
            List<String> drop = new ArrayList<>();
            counts.fieldNames().forEachRemaining(k -> {
                JsonNode v = counts.get(k);
                if (!v.canConvertToInt() || v.asInt() < 0)
                {
                    throw ApiException.badRequest("条数不正确：" + k);
                }
                if (!allowed.contains(k))
                {
                    // 不属于所含分组的键：为 0 时忽略（老版本客户端会带上全部 7 个键），不为 0 时拒绝
                    if (v.asInt() != 0)
                    {
                        throw ApiException.badRequest("条数不正确：" + k);
                    }
                    drop.add(k);
                }
            });
            if (counts instanceof com.fasterxml.jackson.databind.node.ObjectNode obj)
            {
                drop.forEach(obj::remove);
            }
        }
        return groups;
    }

    private JsonNode parseMeta(String meta)
    {
        try
        {
            JsonNode n = objectMapper.readTree(StringUtils.nvl(meta, "{}"));
            if (!n.isObject())
            {
                throw new IllegalArgumentException();
            }
            return n;
        }
        catch (Exception e)
        {
            throw ApiException.badRequest("meta 需要是 JSON 对象");
        }
    }

    /** 保存上传的文件，返回相对路径和 sha256；大小超出、sha256 不一致时报错 */
    private Map<String, Object> store(MultipartFile file, String rel, String expectSha)
    {
        long max = intConfig("itm.backup.maxMb", 50) * 1024L * 1024L;
        if (file == null || file.isEmpty())
        {
            throw ApiException.badRequest("缺少文件");
        }
        if (file.getSize() > max)
        {
            throw ApiException.badRequest("文件太大（上限 " + (max / 1024 / 1024) + "MB）");
        }
        try
        {
            byte[] data = file.getBytes();
            String sha = sha256Hex(data);
            if (StringUtils.isNotEmpty(expectSha) && !expectSha.equalsIgnoreCase(sha))
            {
                throw ApiException.badRequest("文件校验失败（sha256 不一致），请重新上传");
            }
            Path target = Path.of(RuoYiConfig.getProfile(), rel);
            Files.createDirectories(target.getParent());
            Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(tmp, data);
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("path", rel);
            out.put("sha256", sha);
            out.put("size", (long) data.length);
            return out;
        }
        catch (ApiException e)
        {
            throw e;
        }
        catch (IOException e)
        {
            throw new IllegalStateException("保存文件失败：" + e.getMessage());
        }
    }

    private static void deleteFile(String rel)
    {
        if (StringUtils.isEmpty(rel))
        {
            return;
        }
        try
        {
            Files.deleteIfExists(Path.of(RuoYiConfig.getProfile(), rel));
        }
        catch (IOException ignored)
        {
            // 文件已经不在了
        }
    }

    public static Path fileOf(String rel)
    {
        return Path.of(RuoYiConfig.getProfile(), rel);
    }

    private static Long time(Object v)
    {
        if (v instanceof java.time.LocalDateTime l)
        {
            return l.atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli();
        }
        return v instanceof Timestamp t ? t.getTime() : v instanceof Date d ? d.getTime() : null;
    }

    // ---------------------------------------------------------------- 密钥托管

    /** 返回托管的密钥和 ETag；没有设置时返回 null */
    public Map<String, Object> e2eKey(Long userId)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_sync_e2e_key where user_id = ?", userId);
        if (rows.isEmpty())
        {
            return null;
        }
        Map<String, Object> r = rows.get(0);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("wrappedCdk", r.get("wrapped_cdk"));
        out.put("recoveryWrappedCdk", r.get("recovery_wrapped_cdk"));
        try
        {
            out.put("kdf", objectMapper.readTree(String.valueOf(r.get("kdf"))));
        }
        catch (Exception e)
        {
            out.put("kdf", null);
        }
        out.put("keyVersion", r.get("key_version"));
        out.put("etag", "\"" + r.get("key_version") + "-" + time(r.get("updated_at")) + "\"");
        return out;
    }

    public int currentKeyVersion(Long userId)
    {
        List<Integer> v = jdbc.queryForList("select key_version from itm_sync_e2e_key where user_id = ?", Integer.class, userId);
        return v.isEmpty() ? 0 : v.get(0);
    }

    /**
     * 设置 / 修改同步密码 / 轮换 CDK。首次设置不带 If-Match、keyVersion 必须是 1；
     * 之后必须带上次读到的 ETag；修改同步密码时 keyVersion 不变（恢复码可以不传），轮换时 keyVersion + 1 且必须带新的恢复码。
     */
    @Transactional
    public Map<String, Object> putE2eKey(ItmDevice device, Long userId, String userName, JsonNode body, String ifMatch)
    {
        String wrapped = body.path("wrappedCdk").asText("");
        String recovery = body.path("recoveryWrappedCdk").asText("");
        JsonNode kdf = body.path("kdf");
        int version = body.path("keyVersion").asInt(0);
        if (!validB64(wrapped) || (!recovery.isEmpty() && !validB64(recovery)) || !kdf.isObject())
        {
            throw ApiException.badRequest("密钥格式不正确");
        }
        Map<String, Object> cur = e2eKey(userId);
        String action;
        if (cur == null)
        {
            if (StringUtils.isNotEmpty(ifMatch) || version != 1 || recovery.isEmpty())
            {
                throw ApiException.badRequest("首次设置时 keyVersion 必须是 1，并且需要恢复码包装的密钥");
            }
            jdbc.update("insert into itm_sync_e2e_key (user_id, wrapped_cdk, recovery_wrapped_cdk, kdf, key_version, updated_at) values (?, ?, ?, ?, 1, now(3))",
                userId, wrapped, recovery, kdf.toString());
            action = "SETUP";
        }
        else
        {
            if (StringUtils.isEmpty(ifMatch) || !ifMatch.equals(cur.get("etag")))
            {
                throw new ApiException(org.springframework.http.HttpStatus.PRECONDITION_FAILED, "同步密码已经在其他设备上修改过，请刷新后重试");
            }
            int current = ((Number) cur.get("keyVersion")).intValue();
            if (version == current)
            {
                jdbc.update("update itm_sync_e2e_key set wrapped_cdk = ?, kdf = ?, recovery_wrapped_cdk = if(? = '', recovery_wrapped_cdk, ?), updated_at = now(3) where user_id = ?",
                    wrapped, kdf.toString(), recovery, recovery, userId);
                action = recovery.isEmpty() ? "CHANGE_PASSWORD" : "RESET_WITH_RECOVERY";
            }
            else if (version == current + 1)
            {
                if (recovery.isEmpty())
                {
                    throw ApiException.badRequest("轮换密钥时需要新的恢复码包装的密钥");
                }
                jdbc.update("update itm_sync_e2e_key set wrapped_cdk = ?, recovery_wrapped_cdk = ?, kdf = ?, key_version = ?, updated_at = now(3) where user_id = ?",
                    wrapped, recovery, kdf.toString(), version, userId);
                action = "ROTATE";
            }
            else
            {
                throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "密钥版本不正确（当前是 " + current + "）");
            }
        }
        audit(device, userId, userName, "E2E_KEY_CHANGE", Map.of("action", action, "keyVersion", version));
        return e2eKey(userId);
    }

    private static boolean validB64(String s)
    {
        if (StringUtils.isEmpty(s) || s.length() > 500)
        {
            return false;
        }
        try
        {
            return Base64.getDecoder().decode(s).length >= 28;
        }
        catch (IllegalArgumentException e)
        {
            return false;
        }
    }

    // ---------------------------------------------------------------- 云备份

    @Transactional
    public Map<String, Object> uploadBackup(ItmDevice device, Long userId, String userName, String metaJson, MultipartFile file)
    {
        JsonNode meta = parseMeta(metaJson);
        int keyVersion = meta.path("keyVersion").asInt(0);
        int current = currentKeyVersion(userId);
        if (current == 0)
        {
            throw ApiException.badRequest("请先设置同步密码");
        }
        if (keyVersion != current)
        {
            throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "加密密钥已经轮换，请先输入同步密码解锁新密钥");
        }
        List<String> groups = checkGroups(meta.path("groups"), meta.path("counts"), flag("itm.sync.allowCredentialSync", true));
        rateLimit("backup:up", userId, 10, "上传太频繁：每人每小时最多上传 10 次备份");
        String ym = new SimpleDateFormat("yyyyMM").format(new Date());
        String rel = "itm/backups/" + userId + "/" + ym + "/" + UUID.randomUUID() + ".itmbak";
        Map<String, Object> f = store(file, rel, meta.path("sha256").asText(""));
        Long id = ItmJdbc.insert(jdbc, "insert into itm_sync_backup (user_id, user_name, format_version, device_name, platform, client_version, data_groups, item_counts, key_version, size, sha256, file_path, remark, pinned, created_at) "
            + "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', now(3))",
            userId, userName, meta.path("formatVersion").asInt(2), StringUtils.substring(meta.path("deviceName").asText(""), 0, 64),
            StringUtils.substring(meta.path("platform").asText(""), 0, 20), StringUtils.substring(meta.path("clientVersion").asText(""), 0, 40),
            String.join(",", groups), meta.path("counts").isObject() ? meta.path("counts").toString() : "{}", keyVersion, f.get("size"), f.get("sha256"), rel,
            StringUtils.substring(meta.path("remark").asText(""), 0, 200));
        // 保留最近 N 份（置顶的不算）
        int keep = Math.max(1, intConfig("itm.backup.keepCount", 20));
        List<Map<String, Object>> old = jdbc.queryForList("select backup_id, file_path from itm_sync_backup where user_id = ? and pinned = '0' order by created_at desc, backup_id desc limit 100000 offset " + keep, userId);
        for (Map<String, Object> o : old)
        {
            jdbc.update("delete from itm_sync_backup where backup_id = ?", o.get("backup_id"));
            deleteFile(String.valueOf(o.get("file_path")));
        }
        audit(device, userId, userName, "BACKUP_CREATE", Map.of("backupId", id, "groups", groups, "size", f.get("size")));
        return backupOf(userId, id);
    }

    private Map<String, Object> toBackup(Map<String, Object> r)
    {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", r.get("backup_id"));
        out.put("formatVersion", r.get("format_version"));
        out.put("deviceName", r.get("device_name"));
        out.put("platform", r.get("platform"));
        out.put("clientVersion", r.get("client_version"));
        out.put("groups", StringUtils.isEmpty((String) r.get("data_groups")) ? List.of() : List.of(((String) r.get("data_groups")).split(",")));
        try
        {
            out.put("counts", objectMapper.readTree(String.valueOf(r.get("item_counts"))));
        }
        catch (Exception e)
        {
            out.put("counts", Map.of());
        }
        out.put("keyVersion", r.get("key_version"));
        out.put("size", r.get("size"));
        out.put("sha256", r.get("sha256"));
        out.put("remark", r.get("remark"));
        out.put("pinned", "1".equals(r.get("pinned")));
        out.put("createdAt", time(r.get("created_at")));
        return out;
    }

    private Map<String, Object> backupOf(Long userId, Long id)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_sync_backup where backup_id = ? and user_id = ?", id, userId);
        if (rows.isEmpty())
        {
            throw ApiException.notFound("备份不存在");
        }
        return toBackup(rows.get(0));
    }

    public List<Map<String, Object>> listBackups(Long userId)
    {
        return jdbc.queryForList("select * from itm_sync_backup where user_id = ? order by pinned desc, created_at desc", userId).stream().map(this::toBackup).toList();
    }

    /** 只有本人能下载 */
    public Path backupFile(Long userId, Long id)
    {
        List<String> rows = jdbc.queryForList("select file_path from itm_sync_backup where backup_id = ? and user_id = ?", String.class, id, userId);
        if (rows.isEmpty() || !Files.exists(fileOf(rows.get(0))))
        {
            throw ApiException.notFound("备份不存在");
        }
        return fileOf(rows.get(0));
    }

    public Map<String, Object> patchBackup(Long userId, Long id, JsonNode body)
    {
        backupOf(userId, id);
        if (body.has("remark"))
        {
            jdbc.update("update itm_sync_backup set remark = ? where backup_id = ?", StringUtils.substring(body.path("remark").asText(""), 0, 200), id);
        }
        if (body.has("pinned"))
        {
            boolean pin = body.path("pinned").asBoolean();
            if (pin)
            {
                Integer n = jdbc.queryForObject("select count(*) from itm_sync_backup where user_id = ? and pinned = '1' and backup_id != ?", Integer.class, userId, id);
                if (n != null && n >= MAX_PINNED)
                {
                    throw ApiException.badRequest("最多置顶 " + MAX_PINNED + " 份备份");
                }
            }
            jdbc.update("update itm_sync_backup set pinned = ? where backup_id = ?", pin ? "1" : "0", id);
        }
        return backupOf(userId, id);
    }

    public void deleteBackup(ItmDevice device, Long userId, String userName, Long id)
    {
        List<String> rows = jdbc.queryForList("select file_path from itm_sync_backup where backup_id = ? and user_id = ?", String.class, id, userId);
        if (rows.isEmpty())
        {
            throw ApiException.notFound("备份不存在");
        }
        jdbc.update("delete from itm_sync_backup where backup_id = ?", id);
        deleteFile(rows.get(0));
        audit(device, userId, userName, "BACKUP_DELETE", Map.of("backupId", id));
    }

    // ---------------------------------------------------------------- 分享码（分享者）

    private Map<String, Object> shareRow(Long userId)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_sync_share where user_id = ?", userId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private Map<String, Object> toShare(Map<String, Object> r, boolean owner)
    {
        Map<String, Object> out = new LinkedHashMap<>();
        if (owner)
        {
            out.put("codeE2e", r.get("code_e2e"));
            out.put("e2eKeyVersion", r.get("e2e_key_version"));
        }
        out.put("dataGroups", splitGroups((String) r.get("data_groups")));
        out.put("enabled", "1".equals(r.get("enabled")));
        boolean hasContent = StringUtils.isNotEmpty((String) r.get("content_path"));
        Map<String, Object> content = null;
        if (hasContent)
        {
            content = new LinkedHashMap<>();
            content.put("groups", splitGroups((String) r.get("content_groups")));
            try
            {
                content.put("counts", objectMapper.readTree(StringUtils.nvl((String) r.get("content_counts"), "{}")));
            }
            catch (Exception e)
            {
                content.put("counts", Map.of());
            }
            content.put("size", r.get("content_size"));
            content.put("sha256", r.get("content_sha256"));
            content.put("formatVersion", r.get("content_format_version"));
            content.put("deviceName", r.get("content_device"));
            content.put("platform", r.get("content_platform"));
            content.put("clientVersion", r.get("content_client_version"));
            content.put("updatedAt", time(r.get("content_updated_at")));
        }
        out.put("content", content);
        out.put("pullCount", r.get("pull_count"));
        out.put("lastPulledAt", time(r.get("last_pulled_at")));
        out.put("createdAt", time(r.get("created_at")));
        return out;
    }

    private static List<String> splitGroups(String s)
    {
        return StringUtils.isEmpty(s) ? List.of() : List.of(s.split(","));
    }

    public Map<String, Object> myShare(Long userId)
    {
        Map<String, Object> r = shareRow(userId);
        return r == null ? null : toShare(r, true);
    }

    private void requireShareEnabled()
    {
        if (!flag("itm.share.enabled", true))
        {
            throw ApiException.forbidden("管理员关闭了分享码功能");
        }
    }

    /** 开启 / 更新 / 重置分享码（lookupToken 不同时为重置：旧码失效、旧分享包清空） */
    @Transactional
    public Map<String, Object> putShare(ItmDevice device, Long userId, String userName, JsonNode body)
    {
        requireShareEnabled();
        String token = body.path("lookupToken").asText("");
        String codeE2e = body.path("codeE2e").asText("");
        int keyVersion = body.path("e2eKeyVersion").asInt(0);
        if (!token.matches("^[A-Za-z0-9_-]{40,64}$") || !validB64(codeE2e))
        {
            throw ApiException.badRequest("分享码参数不正确");
        }
        if (keyVersion != currentKeyVersion(userId) || keyVersion == 0)
        {
            throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "请先设置并解锁同步密码");
        }
        List<String> groups = checkGroups(body.path("dataGroups"), null, allowShareCredentials());
        String hash = sha256Hex(token.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        boolean enabled = !body.has("enabled") || body.path("enabled").asBoolean(true);
        Map<String, Object> cur = shareRow(userId);
        String action;
        if (cur == null)
        {
            jdbc.update("insert into itm_sync_share (user_id, user_name, lookup_hash, code_e2e, e2e_key_version, data_groups, enabled, pull_count, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 0, now(3), now(3))",
                userId, userName, hash, codeE2e, keyVersion, String.join(",", groups), enabled ? "1" : "0");
            action = "CREATE";
        }
        else if (hash.equals(cur.get("lookup_hash")))
        {
            jdbc.update("update itm_sync_share set code_e2e = ?, e2e_key_version = ?, data_groups = ?, enabled = ?, updated_at = now(3) where user_id = ?",
                codeE2e, keyVersion, String.join(",", groups), enabled ? "1" : "0", userId);
            clearContentOutside(userId, groups);
            action = "UPDATE";
        }
        else
        {
            deleteFile((String) cur.get("content_path"));
            jdbc.update("update itm_sync_share set lookup_hash = ?, code_e2e = ?, e2e_key_version = ?, data_groups = ?, enabled = ?, content_path = '', content_groups = '', content_counts = '', content_size = 0, content_sha256 = '', "
                + "content_updated_at = null, pull_count = 0, last_pulled_at = null, updated_at = now(3) where user_id = ?",
                hash, codeE2e, keyVersion, String.join(",", groups), enabled ? "1" : "0", userId);
            action = "RESET";
        }
        audit(device, userId, userName, "SHARE_SETUP", Map.of("action", action, "groups", groups));
        return myShare(userId);
    }

    /** 收窄范围后，分享包包含了范围之外的分组时立即清空 */
    private void clearContentOutside(Long userId, List<String> groups)
    {
        Map<String, Object> r = shareRow(userId);
        if (r == null || StringUtils.isEmpty((String) r.get("content_path")))
        {
            return;
        }
        if (!groups.containsAll(splitGroups((String) r.get("content_groups"))))
        {
            deleteFile((String) r.get("content_path"));
            jdbc.update("update itm_sync_share set content_path = '', content_groups = '', content_counts = '', content_size = 0, content_sha256 = '', content_updated_at = null where user_id = ?", userId);
        }
    }

    private boolean allowShareCredentials()
    {
        return flag("itm.share.allowCredentials", true) && flag("itm.sync.allowCredentialSync", true);
    }

    public Map<String, Object> patchShare(ItmDevice device, Long userId, String userName, JsonNode body)
    {
        Map<String, Object> cur = shareRow(userId);
        if (cur == null)
        {
            throw ApiException.notFound("还没有开启分享码");
        }
        if (body.has("enabled"))
        {
            boolean on = body.path("enabled").asBoolean();
            if (on)
            {
                requireShareEnabled();
            }
            jdbc.update("update itm_sync_share set enabled = ?, updated_at = now(3) where user_id = ?", on ? "1" : "0", userId);
        }
        if (body.has("dataGroups"))
        {
            requireShareEnabled();
            List<String> groups = checkGroups(body.path("dataGroups"), null, allowShareCredentials());
            jdbc.update("update itm_sync_share set data_groups = ?, updated_at = now(3) where user_id = ?", String.join(",", groups), userId);
            clearContentOutside(userId, groups);
        }
        audit(device, userId, userName, "SHARE_UPDATE", Map.of("enabled", body.path("enabled").asText(""), "groups", body.path("dataGroups").toString()));
        return myShare(userId);
    }

    public void closeShare(ItmDevice device, Long userId, String userName)
    {
        Map<String, Object> cur = shareRow(userId);
        if (cur == null)
        {
            return;
        }
        deleteFile((String) cur.get("content_path"));
        jdbc.update("delete from itm_sync_share where user_id = ?", userId);
        audit(device, userId, userName, "SHARE_CLOSE", Map.of());
    }

    /** 上传 / 替换分享包：lookupToken 必须是当前分享码，分组必须在分享范围内 */
    @Transactional
    public Map<String, Object> putShareContent(ItmDevice device, Long userId, String userName, String metaJson, MultipartFile file)
    {
        requireShareEnabled();
        JsonNode meta = parseMeta(metaJson);
        Map<String, Object> cur = shareRow(userId);
        String hash = sha256Hex(meta.path("lookupToken").asText("").getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (cur == null || !hash.equals(cur.get("lookup_hash")))
        {
            throw new ApiException(org.springframework.http.HttpStatus.PRECONDITION_FAILED, "分享码已经在其他设备上重置或关闭，请刷新");
        }
        List<String> groups = checkGroups(meta.path("groups"), meta.path("counts"), allowShareCredentials());
        if (!splitGroups((String) cur.get("data_groups")).containsAll(groups))
        {
            throw ApiException.badRequest("分享包里有分享范围之外的分组");
        }
        rateLimit("share:up", userId, 30, "更新太频繁：每人每小时最多更新 30 次分享内容");
        String rel = "itm/shares/" + userId + "/" + UUID.randomUUID() + ".itmshare";
        Map<String, Object> f = store(file, rel, meta.path("sha256").asText(""));
        // 上传期间可能被其他设备重置或收窄：锁住记录再检查一次
        List<Map<String, Object>> locked = jdbc.queryForList("select * from itm_sync_share where user_id = ? for update", userId);
        if (locked.isEmpty() || !hash.equals(locked.get(0).get("lookup_hash")) || !splitGroups((String) locked.get(0).get("data_groups")).containsAll(groups))
        {
            deleteFile(rel);
            throw new ApiException(org.springframework.http.HttpStatus.PRECONDITION_FAILED, "分享码或分享范围已经在其他设备上修改，请刷新");
        }
        String oldPath = (String) locked.get(0).get("content_path");
        jdbc.update("update itm_sync_share set content_path = ?, content_groups = ?, content_counts = ?, content_size = ?, content_sha256 = ?, content_format_version = ?, content_device = ?, content_platform = ?, "
            + "content_client_version = ?, content_updated_at = now(3), updated_at = now(3) where user_id = ?",
            rel, String.join(",", groups), meta.path("counts").isObject() ? meta.path("counts").toString() : "{}", f.get("size"), f.get("sha256"),
            meta.path("formatVersion").asInt(2), StringUtils.substring(meta.path("deviceName").asText(""), 0, 64), StringUtils.substring(meta.path("platform").asText(""), 0, 20),
            StringUtils.substring(meta.path("clientVersion").asText(""), 0, 40), userId);
        if (StringUtils.isNotEmpty(oldPath) && !oldPath.equals(rel))
        {
            deleteFile(oldPath);
        }
        audit(device, userId, userName, "SHARE_CONTENT_UPLOAD", Map.of("groups", groups, "size", f.get("size")));
        return myShare(userId);
    }

    // ---------------------------------------------------------------- 单项分享（第十三轮，文档二 5.14）

    private static final int MAX_ACTIVE_LINKS = 200;
    private static final long MAX_LINK_LIFETIME_MS = 366L * 24 * 3600 * 1000;

    /** 一个 lookupToken 的哈希是否已经被个人分享码或单项分享用了 */
    private boolean lookupTaken(String hash)
    {
        Integer a = jdbc.queryForObject("select count(*) from itm_sync_share where lookup_hash = ?", Integer.class, hash);
        Integer b = jdbc.queryForObject("select count(*) from itm_share_link where lookup_hash = ?", Integer.class, hash);
        return (a != null && a > 0) || (b != null && b > 0);
    }

    private Map<String, Object> toLink(Map<String, Object> r, boolean owner)
    {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", String.valueOf(r.get("link_id")));
        out.put("title", r.get("title"));
        out.put("groups", splitGroups((String) r.get("data_groups")));
        try
        {
            out.put("counts", objectMapper.readTree(StringUtils.nvl((String) r.get("item_counts"), "{}")));
        }
        catch (Exception e)
        {
            out.put("counts", Map.of());
        }
        Long expiresAt = time(r.get("expires_at"));
        int maxPulls = ((Number) r.get("max_pulls")).intValue();
        int pulls = ((Number) r.get("pull_count")).intValue();
        out.put("expiresAt", expiresAt);
        out.put("maxPulls", maxPulls);
        out.put("pullCount", pulls);
        out.put("lastPulledAt", time(r.get("last_pulled_at")));
        out.put("expired", expiresAt != null && expiresAt <= System.currentTimeMillis());
        out.put("exhausted", maxPulls > 0 && pulls >= maxPulls);
        out.put("size", r.get("content_size"));
        out.put("createdAt", time(r.get("created_at")));
        if (owner)
        {
            out.put("codeE2e", r.get("code_e2e"));
            out.put("e2eKeyVersion", r.get("e2e_key_version"));
            out.put("deviceName", r.get("device_name"));
        }
        return out;
    }

    /** 创建单项分享：分享包随创建一起上传，之后不能替换 */
    public Map<String, Object> createLink(ItmDevice device, Long userId, String userName, String metaJson, MultipartFile file)
    {
        requireShareEnabled();
        JsonNode meta = parseMeta(metaJson);
        String token = meta.path("lookupToken").asText("");
        if (!token.matches("^[A-Za-z0-9_-]{40,64}$"))
        {
            throw ApiException.badRequest("分享码参数不正确");
        }
        List<String> groups = checkGroups(meta.path("groups"), meta.path("counts"), allowShareCredentials());
        String title = StringUtils.substring(StringUtils.trim(meta.path("title").asText("")), 0, 100);
        if (StringUtils.isEmpty(title))
        {
            title = "分享";
        }
        Long expiresAt = meta.path("expiresAt").isNumber() ? meta.path("expiresAt").asLong() : null;
        long now = System.currentTimeMillis();
        if (expiresAt != null && (expiresAt <= now || expiresAt > now + MAX_LINK_LIFETIME_MS))
        {
            throw ApiException.badRequest("有效期不正确（最长一年）");
        }
        int maxPulls = meta.path("maxPulls").asInt(0);
        if (maxPulls < 0 || maxPulls > 1000)
        {
            throw ApiException.badRequest("可拉取次数需要在 0–1000 之间（0 表示不限）");
        }
        String codeE2e = meta.path("codeE2e").asText("");
        int keyVersion = meta.path("e2eKeyVersion").asInt(0);
        if (StringUtils.isNotEmpty(codeE2e) && (!validB64(codeE2e) || keyVersion != currentKeyVersion(userId) || keyVersion == 0))
        {
            // 托管是可选的：密钥对不上时只是不托管（这台设备仍然保存着分享码）
            codeE2e = "";
            keyVersion = 0;
        }
        String hash = sha256Hex(token.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (lookupTaken(hash))
        {
            throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "分享码冲突，请重新生成");
        }
        Integer active = jdbc.queryForObject("select count(*) from itm_share_link where user_id = ? and status = '0' and (expires_at is null or expires_at > now(3))", Integer.class, userId);
        if (active != null && active >= MAX_ACTIVE_LINKS)
        {
            throw ApiException.badRequest("有效的单项分享最多 " + MAX_ACTIVE_LINKS + " 个，请先撤销不用的");
        }
        rateLimit("share:link", userId, 60, "分享太频繁：每人每小时最多创建 60 个单项分享");
        String rel = "itm/share-links/" + userId + "/" + UUID.randomUUID() + ".itmshare";
        Map<String, Object> f = store(file, rel, meta.path("sha256").asText(""));
        Long id;
        try
        {
            id = ItmJdbc.insert(jdbc, "insert into itm_share_link (user_id, user_name, lookup_hash, title, data_groups, item_counts, code_e2e, e2e_key_version, expires_at, max_pulls, pull_count, "
                + "content_path, content_size, content_sha256, format_version, device_name, platform, client_version, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, '0', now(3))",
                userId, userName, hash, title, String.join(",", groups), meta.path("counts").isObject() ? meta.path("counts").toString() : "{}", codeE2e, keyVersion,
                expiresAt == null ? null : new Timestamp(expiresAt), maxPulls, rel, f.get("size"), f.get("sha256"), meta.path("formatVersion").asInt(2),
                StringUtils.substring(meta.path("deviceName").asText(""), 0, 64), StringUtils.substring(meta.path("platform").asText(""), 0, 20), StringUtils.substring(meta.path("clientVersion").asText(""), 0, 40));
        }
        catch (org.springframework.dao.DuplicateKeyException e)
        {
            deleteFile(rel);
            throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "分享码冲突，请重新生成");
        }
        audit(device, userId, userName, "SHARE_LINK_CREATE", Map.of("linkId", id, "groups", groups, "size", f.get("size"), "maxPulls", maxPulls, "expiresAt", expiresAt == null ? "" : expiresAt));
        return toLink(jdbc.queryForMap("select * from itm_share_link where link_id = ?", id), true);
    }

    /** 我的单项分享（不含已撤销的），新的在前 */
    public List<Map<String, Object>> listLinks(Long userId)
    {
        return jdbc.queryForList("select * from itm_share_link where user_id = ? and status = '0' order by created_at desc limit 500", userId).stream().map(r -> toLink(r, true)).toList();
    }

    /** 撤销：删除分享包，分享码立即失效 */
    public void revokeLink(ItmDevice device, Long userId, String userName, Long linkId)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_share_link where link_id = ? and user_id = ?", linkId, userId);
        if (rows.isEmpty())
        {
            throw ApiException.notFound("分享不存在");
        }
        revoke(rows.get(0));
        audit(device, userId, userName, "SHARE_LINK_REVOKE", Map.of("linkId", linkId));
    }

    private void revoke(Map<String, Object> r)
    {
        deleteFile((String) r.get("content_path"));
        jdbc.update("update itm_share_link set status = '1', content_path = '', revoked_at = now(3) where link_id = ?", r.get("link_id"));
    }

    /** 管理后台：所有单项分享（元数据），可以强制撤销 */
    public List<Map<String, Object>> adminLinks(String userName)
    {
        String sql = "select link_id, user_id, user_name, title, data_groups, item_counts, expires_at, max_pulls, pull_count, last_pulled_at, content_size, status, created_at, revoked_at from itm_share_link"
            + (StringUtils.isEmpty(userName) ? "" : " where user_name like ?") + " order by created_at desc limit 500";
        return StringUtils.isEmpty(userName) ? jdbc.queryForList(sql) : jdbc.queryForList(sql, "%" + userName + "%");
    }

    public void adminRevokeLink(Long linkId)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_share_link where link_id = ?", linkId);
        if (!rows.isEmpty())
        {
            revoke(rows.get(0));
        }
    }

    /** 清理：撤销、过期、拉满 7 天后删文件；记录保留 90 天 */
    public int cleanupLinks()
    {
        int n = 0;
        for (Map<String, Object> r : jdbc.queryForList("select link_id, content_path from itm_share_link where content_path <> '' and ((expires_at is not null and expires_at < now(3) - interval 7 day) "
            + "or (max_pulls > 0 and pull_count >= max_pulls and last_pulled_at < now(3) - interval 7 day))"))
        {
            deleteFile((String) r.get("content_path"));
            jdbc.update("update itm_share_link set content_path = '' where link_id = ?", r.get("link_id"));
            n++;
        }
        jdbc.update("delete from itm_share_link where (status = '1' and revoked_at < now(3) - interval 90 day) or (expires_at is not null and expires_at < now(3) - interval 90 day)");
        return n;
    }

    // ---------------------------------------------------------------- 分享码（拉取方）

    /**
     * 找到可以拉取的分享码：先查个人分享码，再查单项分享；各种失效情况统一提示「无效或已失效」，避免探测。
     * 返回的行里 kind = PERSONAL / LINK。
     */
    private Map<String, Object> findShare(Long userId, String token)
    {
        if (!flag("itm.share.enabled", true))
        {
            throw ApiException.forbidden("管理员关闭了分享码功能");
        }
        rateLimit("share:pull", userId, 60, "拉取太频繁：每人每小时最多 60 次");
        if (StringUtils.isEmpty(token) || token.length() > 100)
        {
            throw ApiException.notFound("分享码无效或已失效");
        }
        String hash = sha256Hex(token.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        List<Map<String, Object>> rows = jdbc.queryForList(
            "select s.*, u.nick_name, u.user_name as owner_name from itm_sync_share s join sys_user u on u.user_id = s.user_id and u.status = '0' and u.del_flag = '0' where s.lookup_hash = ? and s.enabled = '1'", hash);
        Map<String, Object> r;
        if (!rows.isEmpty())
        {
            r = new LinkedHashMap<>(rows.get(0));
            r.put("kind", "PERSONAL");
        }
        else
        {
            List<Map<String, Object>> links = jdbc.queryForList(
                "select l.*, u.nick_name, u.user_name as owner_name from itm_share_link l join sys_user u on u.user_id = l.user_id and u.status = '0' and u.del_flag = '0' "
                    + "where l.lookup_hash = ? and l.status = '0' and l.content_path <> '' and (l.expires_at is null or l.expires_at > now(3)) and (l.max_pulls = 0 or l.pull_count < l.max_pulls)", hash);
            if (links.isEmpty())
            {
                throw ApiException.notFound("分享码无效或已失效");
            }
            r = new LinkedHashMap<>(links.get(0));
            r.put("kind", "LINK");
            // 和个人分享码统一的字段名
            r.put("content_groups", r.get("data_groups"));
            r.put("content_counts", r.get("item_counts"));
            r.put("content_format_version", r.get("format_version"));
            r.put("content_device", r.get("device_name"));
            r.put("content_platform", r.get("platform"));
            r.put("content_client_version", r.get("client_version"));
            r.put("content_updated_at", r.get("created_at"));
        }
        if (userId.equals(((Number) r.get("user_id")).longValue()))
        {
            throw ApiException.badRequest("这是你自己的分享码；恢复自己的数据请用云端备份记录");
        }
        if (StringUtils.isEmpty((String) r.get("content_path")))
        {
            throw ApiException.notFound("对方还没有上传分享内容");
        }
        if (splitGroups((String) r.get("content_groups")).contains("CREDENTIALS") && !allowShareCredentials())
        {
            throw ApiException.forbidden("分享内容包含凭证，管理员禁止了分享凭证");
        }
        return r;
    }

    public Map<String, Object> lookupShare(Long userId, String token)
    {
        Map<String, Object> r = findShare(userId, token);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("kind", r.get("kind"));
        out.put("ownerId", r.get("user_id"));
        out.put("ownerUsername", r.get("owner_name"));
        out.put("ownerDisplayName", r.get("nick_name"));
        if ("LINK".equals(r.get("kind")))
        {
            out.put("title", r.get("title"));
            out.put("expiresAt", time(r.get("expires_at")));
            out.put("maxPulls", r.get("max_pulls"));
            out.put("pullCount", r.get("pull_count"));
        }
        Map<String, Object> share = toShare(r, false);
        out.putAll((Map<String, Object>) share.get("content"));
        return out;
    }

    /** 下载分享包：拉取次数加 1（单项分享不会超过上限），写审计（操作人是拉取方，目标是分享者） */
    public Path downloadShare(ItmDevice device, Long userId, String userName, String token)
    {
        Map<String, Object> r = findShare(userId, token);
        Path p = fileOf((String) r.get("content_path"));
        if (!Files.exists(p))
        {
            throw ApiException.notFound("对方还没有上传分享内容");
        }
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("ownerId", r.get("user_id"));
        detail.put("owner", String.valueOf(r.get("owner_name")));
        detail.put("groups", String.valueOf(r.get("content_groups")));
        if ("LINK".equals(r.get("kind")))
        {
            int n = jdbc.update("update itm_share_link set pull_count = pull_count + 1, last_pulled_at = now(3) where link_id = ? and status = '0' and (max_pulls = 0 or pull_count < max_pulls)", r.get("link_id"));
            if (n == 0)
            {
                throw ApiException.notFound("分享码无效或已失效");
            }
            detail.put("linkId", r.get("link_id"));
        }
        else
        {
            jdbc.update("update itm_sync_share set pull_count = pull_count + 1, last_pulled_at = now(3) where user_id = ?", r.get("user_id"));
        }
        audit(device, userId, userName, "SHARE_PULL", detail);
        return p;
    }

    // ---------------------------------------------------------------- 清理

    /** 已删除的用户（sys_user 不存在或 del_flag = 2）的云备份、分享码和密钥托管：删除文件和记录，返回删除的备份数 */
    public int cleanupDeletedUsers()
    {
        String orphan = " not exists (select 1 from sys_user u where u.user_id = t.user_id and u.del_flag = '0')";
        List<Map<String, Object>> files = jdbc.queryForList("select backup_id, file_path from itm_sync_backup t where" + orphan);
        for (Map<String, Object> f : files)
        {
            deleteFile(String.valueOf(f.get("file_path")));
            jdbc.update("delete from itm_sync_backup where backup_id = ?", f.get("backup_id"));
        }
        for (Map<String, Object> s : jdbc.queryForList("select user_id, content_path from itm_sync_share t where" + orphan))
        {
            deleteFile((String) s.get("content_path"));
            jdbc.update("delete from itm_sync_share where user_id = ?", s.get("user_id"));
        }
        for (Map<String, Object> l : jdbc.queryForList("select link_id, content_path from itm_share_link t where" + orphan))
        {
            deleteFile((String) l.get("content_path"));
            jdbc.update("delete from itm_share_link where link_id = ?", l.get("link_id"));
        }
        jdbc.update("delete from itm_sync_e2e_key t where" + orphan);
        return files.size();
    }

    // ---------------------------------------------------------------- 管理后台（只看元数据）

    public List<Map<String, Object>> adminBackups(String userName)
    {
        String sql = "select backup_id, user_id, user_name, format_version, device_name, platform, client_version, data_groups, item_counts, size, pinned, remark, created_at from itm_sync_backup"
            + (StringUtils.isEmpty(userName) ? "" : " where user_name like ?") + " order by created_at desc limit 500";
        return StringUtils.isEmpty(userName) ? jdbc.queryForList(sql) : jdbc.queryForList(sql, "%" + userName + "%");
    }

    public List<Map<String, Object>> adminShares()
    {
        return jdbc.queryForList("select user_id, user_name, data_groups, enabled, content_groups, content_size, content_updated_at, pull_count, last_pulled_at, created_at from itm_sync_share order by updated_at desc");
    }

    public static InputStream open(Path p) throws IOException
    {
        return Files.newInputStream(p);
    }
}
