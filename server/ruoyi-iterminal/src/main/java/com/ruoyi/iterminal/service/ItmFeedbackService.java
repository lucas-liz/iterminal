package com.ruoyi.iterminal.service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.sql.Timestamp;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.config.RuoYiConfig;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.core.redis.RedisCache;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.system.service.ISysConfigService;

/**
 * 问题反馈（第十三轮，文档二 5.15）：客户端提交描述、截图和诊断包（环境、操作轨迹、错误、日志尾部）；
 * 管理后台查看、回复、复制给 AI、用团队模型 AI 分析。附件保存在上传目录 itm/feedback/ 下，不能通过 /profile/** 直接访问。
 */
@Service
public class ItmFeedbackService
{
    private static final Logger log = LoggerFactory.getLogger(ItmFeedbackService.class);

    public static final Set<String> CATEGORIES = Set.of("BUG", "SUGGESTION", "QUESTION", "OTHER");
    public static final Set<String> STATUSES = Set.of("NEW", "PROCESSING", "RESOLVED", "CLOSED");
    private static final Map<String, String> CATEGORY_LABEL = Map.of("BUG", "问题", "SUGGESTION", "建议", "QUESTION", "咨询", "OTHER", "其他");
    private static final int MAX_IMAGES = 6;
    private static final long MAX_IMAGE = 5L * 1024 * 1024;
    private static final long MAX_DIAG_JSON = 4L * 1024 * 1024;
    private static final long MAX_DIAG_MD = 2L * 1024 * 1024;
    private static final int MAX_ENV = 64 * 1024;
    /** 「复制给 AI」的上限（字符） */
    private static final int MAX_PROMPT = 200_000;
    /** AI 分析时交给模型的上限（字符） */
    private static final int MAX_ANALYZE = 60_000;

    private static final String AI_INTRO = "下面是 iTerminal 桌面客户端（Electron：主进程负责连接、数据和 IPC，渲染进程是 React 界面，Agent 在独立的 utilityProcess 里运行）"
        + "用户提交的问题反馈和自动附带的诊断信息。操作轨迹按时间排列（相对提交时刻），分类：app 应用、ipc 界面调用主进程、event 主进程推送的状态、ui 用户操作、"
        + "console 界面日志、error 异常、net 访问服务端。敏感信息已经脱敏，IP 可能被替换成 HOST_IP_n。";

    private static final String ANALYZE_SYSTEM = "你是 iTerminal（桌面 SSH 终端 + AI 运维助手，Electron + React + Node.js，服务端 Spring Boot）的资深开发和技术支持。"
        + "根据用户的问题反馈和诊断信息定位问题。要求：\n"
        + "1. 只根据给出的内容分析，引用具体的日志行、错误信息或操作轨迹作为依据；信息不足时明确说出还缺什么，不要编造。\n"
        + "2. 用中文 Markdown 输出，按这些小节：\n"
        + "## 问题概述\n一两句话说明用户遇到了什么。\n"
        + "## 可能的根因\n按可能性从高到低列出，每条附上依据（时间点 + 日志 / 错误原文）。\n"
        + "## 复现步骤\n根据操作轨迹推测。\n"
        + "## 修复建议\n分「用户现在可以怎么做」和「开发需要修改什么」（尽量指出模块、IPC 通道或接口）。\n"
        + "## 还需要的信息\n没有就写「无」。";

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private RedisCache redisCache;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private ItmLlmService llmService;

    @Autowired
    private ItmNotifyService notifyService;

    // ---------------------------------------------------------------- 工具

    private boolean flag(String key, boolean fallback)
    {
        String v = configService.selectConfigByKey(key);
        return StringUtils.isEmpty(v) ? fallback : !"false".equalsIgnoreCase(v.trim());
    }

    private String config(String key)
    {
        return StringUtils.trim(StringUtils.nvl(configService.selectConfigByKey(key), ""));
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

    private void rateLimit(String key, int perHour, String message)
    {
        String k = "itm:rl:" + key + ":" + (System.currentTimeMillis() / 3_600_000);
        Long n = redisCache.redisTemplate.opsForValue().increment(k);
        if (n != null && n == 1)
        {
            redisCache.expire(k, 2, TimeUnit.HOURS);
        }
        if (n != null && n > perHour)
        {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, message);
        }
    }

    private static Long time(Object v)
    {
        if (v instanceof java.time.LocalDateTime l)
        {
            return l.atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli();
        }
        return v instanceof Timestamp t ? t.getTime() : v instanceof Date d ? d.getTime() : null;
    }

    private static String str(JsonNode n, String field, int max)
    {
        return StringUtils.substring(StringUtils.trim(n.path(field).asText("")), 0, max);
    }

    /** 按文件头识别图片类型（不信任客户端给的 Content-Type） */
    private static String imageType(byte[] b)
    {
        if (b.length >= 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G')
        {
            return "png";
        }
        if (b.length >= 3 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8 && (b[2] & 0xff) == 0xff)
        {
            return "jpg";
        }
        if (b.length >= 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F' && b[3] == '8')
        {
            return "gif";
        }
        if (b.length >= 12 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P')
        {
            return "webp";
        }
        return null;
    }

    private static final Map<String, String> MIME = Map.of("png", "image/png", "jpg", "image/jpeg", "gif", "image/gif", "webp", "image/webp", "json", "application/json", "md", "text/markdown");

    private static String write(byte[] data, String ext)
    {
        String rel = "itm/feedback/" + new SimpleDateFormat("yyyyMM").format(new Date()) + "/" + UUID.randomUUID() + "." + ext;
        try
        {
            Path target = Path.of(RuoYiConfig.getProfile(), rel);
            Files.createDirectories(target.getParent());
            Path tmp = target.resolveSibling(target.getFileName() + ".tmp");
            Files.write(tmp, data);
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            return rel;
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

    private static byte[] bytes(MultipartFile f)
    {
        try
        {
            return f.getBytes();
        }
        catch (IOException e)
        {
            throw ApiException.badRequest("读取上传的文件失败");
        }
    }

    // ---------------------------------------------------------------- 提交

    /**
     * 提交反馈。user 为 null 表示匿名（本地模式），这时按 IP 限流。返回 {id, createdAt}。
     */
    public Map<String, Object> submit(LoginUser user, ItmDevice device, String ip, String metaJson, List<MultipartFile> images, MultipartFile diag, MultipartFile diagMd)
    {
        if (user == null)
        {
            if (!flag("itm.feedback.allowAnonymous", true))
            {
                throw ApiException.forbidden("这个服务端只接受登录后的问题反馈，请先登录");
            }
            rateLimit("feedback:ip:" + StringUtils.nvl(ip, "unknown"), 5, "提交太频繁：每小时最多提交 5 条反馈，请稍后再试");
            rateLimit("feedback:anon", 200, "匿名反馈太多了，请稍后再试或登录后提交");
        }
        else
        {
            rateLimit("feedback:" + user.getUserId(), 10, "提交太频繁：每人每小时最多提交 10 条反馈");
        }
        JsonNode meta;
        try
        {
            meta = objectMapper.readTree(StringUtils.nvl(metaJson, "{}"));
        }
        catch (Exception e)
        {
            throw ApiException.badRequest("meta 需要是 JSON 对象");
        }
        if (!meta.isObject())
        {
            throw ApiException.badRequest("meta 需要是 JSON 对象");
        }
        String category = meta.path("category").asText("BUG");
        if (!CATEGORIES.contains(category))
        {
            category = "OTHER";
        }
        String title = str(meta, "title", 100);
        String description = StringUtils.trim(meta.path("description").asText(""));
        if (title.isEmpty())
        {
            throw ApiException.badRequest("请填写标题");
        }
        if (description.isEmpty())
        {
            throw ApiException.badRequest("请填写问题描述");
        }
        if (description.length() > 5000)
        {
            throw ApiException.badRequest("描述太长了（最多 5000 字）");
        }
        String env = "{}";
        if (meta.path("env").isObject())
        {
            env = meta.path("env").toString();
            if (env.length() > MAX_ENV)
            {
                throw ApiException.badRequest("环境信息太大");
            }
        }
        // 先校验全部附件，再写文件
        List<MultipartFile> imgs = images == null ? List.of() : images.stream().filter(f -> f != null && !f.isEmpty()).toList();
        if (imgs.size() > MAX_IMAGES)
        {
            throw ApiException.badRequest("最多上传 " + MAX_IMAGES + " 张图片");
        }
        List<Object[]> files = new ArrayList<>();
        for (MultipartFile f : imgs)
        {
            if (f.getSize() > MAX_IMAGE)
            {
                throw ApiException.badRequest("图片「" + StringUtils.substring(f.getOriginalFilename(), 0, 60) + "」超过 5MB");
            }
            byte[] b = bytes(f);
            String type = imageType(b);
            if (type == null)
            {
                throw ApiException.badRequest("只支持 PNG / JPG / GIF / WebP 图片");
            }
            files.add(new Object[] { "IMAGE", StringUtils.substring(StringUtils.nvl(f.getOriginalFilename(), "image." + type), 0, 200), type, b });
        }
        if (diag != null && !diag.isEmpty())
        {
            if (diag.getSize() > MAX_DIAG_JSON)
            {
                throw ApiException.badRequest("诊断信息太大（最多 4MB）");
            }
            byte[] b = bytes(diag);
            try
            {
                if (!objectMapper.readTree(b).isObject())
                {
                    throw new IllegalArgumentException();
                }
            }
            catch (Exception e)
            {
                throw ApiException.badRequest("诊断信息不是有效的 JSON");
            }
            files.add(new Object[] { "DIAG_JSON", "diagnostics.json", "json", b });
        }
        if (diagMd != null && !diagMd.isEmpty())
        {
            if (diagMd.getSize() > MAX_DIAG_MD)
            {
                throw ApiException.badRequest("诊断信息太大（Markdown 最多 2MB）");
            }
            files.add(new Object[] { "DIAG_MD", "diagnostics.md", "md", bytes(diagMd) });
        }
        int imageCount = (int) files.stream().filter(f -> "IMAGE".equals(f[0])).count();
        boolean hasDiag = files.stream().anyMatch(f -> !"IMAGE".equals(f[0]));
        String userName = user == null ? "" : user.getUsername();
        String nick = user == null || user.getUser() == null ? "" : StringUtils.nvl(user.getUser().getNickName(), "");
        Long id = ItmJdbc.insert(jdbc, "insert into itm_feedback (user_id, user_name, nick_name, contact, device_id, ip, category, title, description, client_version, platform, os_version, arch, env_json, "
            + "image_count, has_diag, status, create_time, update_time) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', now(), now())",
            user == null ? null : user.getUserId(), userName, StringUtils.substring(nick, 0, 30), str(meta, "contact", 100), device == null ? "" : device.getDeviceId(),
            StringUtils.substring(StringUtils.nvl(ip, ""), 0, 64), category, title, description, str(meta, "clientVersion", 40), str(meta, "platform", 20), str(meta, "osVersion", 100),
            str(meta, "arch", 20), env, imageCount, hasDiag ? "1" : "0");
        List<String> written = new ArrayList<>();
        try
        {
            for (Object[] f : files)
            {
                byte[] b = (byte[]) f[3];
                String rel = write(b, (String) f[2]);
                written.add(rel);
                jdbc.update("insert into itm_feedback_file (feedback_id, kind, file_name, content_type, size, sha256, file_path, create_time) values (?, ?, ?, ?, ?, ?, ?, now())",
                    id, f[0], f[1], MIME.get((String) f[2]), (long) b.length, sha256Hex(b), rel);
            }
        }
        catch (RuntimeException e)
        {
            written.forEach(ItmFeedbackService::deleteFile);
            jdbc.update("delete from itm_feedback_file where feedback_id = ?", id);
            jdbc.update("delete from itm_feedback where feedback_id = ?", id);
            throw e;
        }
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("类型", CATEGORY_LABEL.getOrDefault(category, category));
        fields.put("标题", title);
        fields.put("提交人", user == null ? "匿名" + (StringUtils.isNotEmpty(str(meta, "contact", 100)) ? "（" + str(meta, "contact", 100) + "）" : "") : (StringUtils.isNotEmpty(nick) ? nick + "（" + userName + "）" : userName));
        fields.put("客户端", (str(meta, "platform", 20) + " " + str(meta, "clientVersion", 40)).trim());
        notifyService.publish(ItmNotifyService.FEEDBACK_NEW, "新的问题反馈 #" + id, fields, "/iterminal/feedback?id=" + id);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", id);
        out.put("createdAt", System.currentTimeMillis());
        return out;
    }

    /** 我的反馈（最近 50 条） */
    public List<Map<String, Object>> mine(Long userId)
    {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> r : jdbc.queryForList("select feedback_id, category, title, status, reply, handled_at, create_time from itm_feedback where user_id = ? order by feedback_id desc limit 50", userId))
        {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", r.get("feedback_id"));
            v.put("category", r.get("category"));
            v.put("title", r.get("title"));
            v.put("status", r.get("status"));
            v.put("reply", StringUtils.nvl((String) r.get("reply"), ""));
            v.put("handledAt", time(r.get("handled_at")));
            v.put("createdAt", time(r.get("create_time")));
            out.add(v);
        }
        return out;
    }

    // ---------------------------------------------------------------- 管理后台

    /** 列表：按状态、类型、关键字（标题 / 描述 / 提交人）、时间筛选，分页 */
    public Map<String, Object> list(String status, String category, String keyword, String begin, String end, int pageNum, int pageSize)
    {
        StringBuilder where = new StringBuilder(" where 1 = 1");
        List<Object> args = new ArrayList<>();
        if (StringUtils.isNotEmpty(status))
        {
            where.append(" and status = ?");
            args.add(status);
        }
        if (StringUtils.isNotEmpty(category))
        {
            where.append(" and category = ?");
            args.add(category);
        }
        if (StringUtils.isNotEmpty(keyword))
        {
            String k = "%" + keyword.trim() + "%";
            where.append(" and (title like ? or description like ? or user_name like ? or nick_name like ? or contact like ? or cast(feedback_id as char) = ?)");
            args.add(k);
            args.add(k);
            args.add(k);
            args.add(k);
            args.add(k);
            args.add(keyword.trim().replace("#", ""));
        }
        if (StringUtils.isNotEmpty(begin))
        {
            where.append(" and create_time >= ?");
            args.add(begin + (begin.length() <= 10 ? " 00:00:00" : ""));
        }
        if (StringUtils.isNotEmpty(end))
        {
            where.append(" and create_time <= ?");
            args.add(end + (end.length() <= 10 ? " 23:59:59" : ""));
        }
        Long total = jdbc.queryForObject("select count(*) from itm_feedback" + where, Long.class, args.toArray());
        int size = Math.max(1, Math.min(pageSize, 100));
        int offset = Math.max(0, (Math.max(1, pageNum) - 1) * size);
        List<Map<String, Object>> rows = jdbc.queryForList("select feedback_id, user_id, user_name, nick_name, contact, category, title, client_version, platform, os_version, image_count, has_diag, status, handler, "
            + "handled_at, ai_analyzed_at, create_time from itm_feedback" + where + " order by feedback_id desc limit " + size + " offset " + offset, args.toArray());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("rows", rows);
        out.put("total", total == null ? 0 : total);
        return out;
    }

    private Map<String, Object> row(Long id)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_feedback where feedback_id = ?", id);
        if (rows.isEmpty())
        {
            throw new ServiceException("反馈不存在");
        }
        return rows.get(0);
    }

    private List<Map<String, Object>> files(Long id)
    {
        return jdbc.queryForList("select file_id, kind, file_name, content_type, size, file_path from itm_feedback_file where feedback_id = ? order by file_id", id);
    }

    private String readText(List<Map<String, Object>> files, String kind)
    {
        for (Map<String, Object> f : files)
        {
            if (kind.equals(f.get("kind")))
            {
                try
                {
                    return Files.readString(Path.of(RuoYiConfig.getProfile(), String.valueOf(f.get("file_path"))), StandardCharsets.UTF_8);
                }
                catch (IOException e)
                {
                    return null;
                }
            }
        }
        return null;
    }

    /** 详情：记录 + 附件列表 + 诊断信息（JSON 解析好，界面直接画时间线） */
    public Map<String, Object> detail(Long id)
    {
        Map<String, Object> r = new LinkedHashMap<>(row(id));
        List<Map<String, Object>> files = files(id);
        r.put("files", files.stream().map(f -> {
            Map<String, Object> v = new LinkedHashMap<>(f);
            v.remove("file_path");
            return v;
        }).toList());
        try
        {
            r.put("env", objectMapper.readTree(StringUtils.nvl((String) r.get("env_json"), "{}")));
        }
        catch (Exception e)
        {
            r.put("env", Map.of());
        }
        r.remove("env_json");
        String diag = readText(files, "DIAG_JSON");
        if (diag != null)
        {
            try
            {
                r.put("diagnostics", objectMapper.readTree(diag));
            }
            catch (Exception e)
            {
                log.warn("反馈 #{} 的诊断信息无法解析：{}", id, e.getMessage());
            }
        }
        return r;
    }

    /** 附件：[路径, 类型, 文件名] */
    public Object[] file(Long fileId)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_feedback_file where file_id = ?", fileId);
        if (rows.isEmpty())
        {
            throw new ServiceException("附件不存在");
        }
        Map<String, Object> f = rows.get(0);
        Path p = Path.of(RuoYiConfig.getProfile(), String.valueOf(f.get("file_path")));
        if (!Files.exists(p))
        {
            throw new ServiceException("附件文件已经不在了");
        }
        return new Object[] { p, StringUtils.nvl((String) f.get("content_type"), "application/octet-stream"), f.get("file_name") };
    }

    public void update(Long id, String status, String reply, String handler)
    {
        row(id);
        if (status != null && !STATUSES.contains(status))
        {
            throw new ServiceException("状态不正确");
        }
        if (reply != null && reply.length() > 5000)
        {
            throw new ServiceException("回复太长了（最多 5000 字）");
        }
        jdbc.update("update itm_feedback set status = ifnull(?, status), reply = ifnull(?, reply), handler = ?, handled_at = now(), update_time = now() where feedback_id = ?", status, reply, handler, id);
    }

    public int delete(Long[] ids)
    {
        int n = 0;
        for (Long id : ids)
        {
            for (Map<String, Object> f : files(id))
            {
                deleteFile(String.valueOf(f.get("file_path")));
            }
            jdbc.update("delete from itm_feedback_file where feedback_id = ?", id);
            n += jdbc.update("delete from itm_feedback where feedback_id = ?", id);
        }
        return n;
    }

    /**
     * 「复制给 AI」的 Markdown：说明 + 描述 + 诊断信息（客户端生成的 diagnostics.md；没有时用环境信息）。超过上限时从中间截掉日志。
     */
    public String prompt(Long id, int limit)
    {
        Map<String, Object> r = row(id);
        List<Map<String, Object>> files = files(id);
        StringBuilder sb = new StringBuilder();
        sb.append("# iTerminal 问题反馈 #").append(id).append("：").append(r.get("title")).append("\n\n");
        sb.append("> ").append(AI_INTRO).append("\n\n");
        sb.append("- 类型：").append(CATEGORY_LABEL.getOrDefault(String.valueOf(r.get("category")), String.valueOf(r.get("category")))).append("\n");
        sb.append("- 提交时间：").append(r.get("create_time")).append("\n");
        sb.append("- 客户端：").append(r.get("platform")).append(" ").append(r.get("os_version")).append(" ").append(r.get("arch")).append("，版本 ").append(r.get("client_version")).append("\n");
        sb.append("- 截图：").append(r.get("image_count")).append(" 张（文字版里看不到，需要时在管理后台查看）\n\n");
        sb.append("## 用户的描述\n\n").append(r.get("description")).append("\n\n");
        String md = readText(files, "DIAG_MD");
        if (md != null)
        {
            // 客户端的 Markdown 里已经有描述，去掉它自己的标题和说明部分，从「环境」开始
            int at = md.indexOf("## 环境");
            sb.append(at >= 0 ? md.substring(at) : md);
        }
        else
        {
            sb.append("## 环境\n\n```json\n").append(StringUtils.nvl((String) r.get("env_json"), "{}")).append("\n```\n\n（没有附带诊断信息：操作轨迹和日志不可用）\n");
        }
        String out = sb.toString();
        if (out.length() > limit)
        {
            // 保留开头（描述、环境、错误）和结尾（最近的日志）
            int head = (int) (limit * 0.6);
            out = out.substring(0, head) + "\n\n…（中间省略 " + (out.length() - limit) + " 个字符）…\n\n" + out.substring(out.length() - (limit - head));
        }
        return out;
    }

    public String prompt(Long id)
    {
        return prompt(id, MAX_PROMPT);
    }

    /** AI 分析：用团队模型（默认按参数设置）分析，结果保存在记录里 */
    public Map<String, Object> analyze(Long id, Long providerId, String model, LoginUser admin)
    {
        Long pid = providerId;
        String m = model;
        if (pid == null && StringUtils.isNotEmpty(config("itm.feedback.aiProviderId")))
        {
            try
            {
                pid = Long.valueOf(config("itm.feedback.aiProviderId"));
            }
            catch (NumberFormatException ignored)
            {
                pid = null;
            }
        }
        if (StringUtils.isEmpty(m) && providerId == null)
        {
            m = config("itm.feedback.aiModel");
        }
        Map<String, Object> r = llmService.complete(pid, m, ANALYZE_SYSTEM, prompt(id, MAX_ANALYZE), 4096, admin);
        String label = r.get("providerName") + " / " + r.get("model");
        jdbc.update("update itm_feedback set ai_analysis = ?, ai_model = ?, ai_analyzed_at = now(), update_time = now() where feedback_id = ?", r.get("text"), StringUtils.substring(label, 0, 150), id);
        Map<String, Object> out = new LinkedHashMap<>(r);
        out.put("model", label);
        return out;
    }

    // ---------------------------------------------------------------- 清理

    /** 保留期限清理：超过 itm.feedback.retentionDays（默认 365）天的反馈和附件 */
    public int cleanup(int days)
    {
        List<Long> ids = jdbc.queryForList("select feedback_id from itm_feedback where create_time < now() - interval ? day limit 5000", Long.class, days);
        return ids.isEmpty() ? 0 : delete(ids.toArray(new Long[0]));
    }
}
