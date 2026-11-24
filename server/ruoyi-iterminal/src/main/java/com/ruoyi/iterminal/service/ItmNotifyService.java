package com.ruoyi.iterminal.service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Date;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.stereotype.Service;
import org.springframework.web.util.HtmlUtils;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.domain.ItmNotifyChannel;
import com.ruoyi.iterminal.domain.ItmNotifyLog;
import com.ruoyi.iterminal.mapper.ItmDeviceMapper;
import com.ruoyi.iterminal.mapper.ItmNotifyChannelMapper;
import com.ruoyi.iterminal.mapper.ItmNotifyLogMapper;
import com.ruoyi.system.service.ISysConfigService;
import jakarta.mail.internet.MimeMessage;

/**
 * 通知（文档二 5.11）：定时任务失败、设备离线、等待审批、审批过期、高危命令等事件发给订阅了它的渠道。
 * 渠道：钉钉 / 企业微信 / 飞书机器人（Webhook + 可选加签）、邮件（SMTP，环境变量配置）、通用 Webhook（JSON + 可选 HMAC 签名）。
 * 异步发送，失败 5 秒后重试一次；每次的结果写进发送记录。
 */
@Service
public class ItmNotifyService
{
    private static final Logger log = LoggerFactory.getLogger(ItmNotifyService.class);

    public static final String TASK_FAILED = "TASK_FAILED";
    public static final String TASK_OFFLINE = "TASK_OFFLINE";
    public static final String TASK_SUCCESS = "TASK_SUCCESS";
    public static final String APPROVAL_REQUEST = "APPROVAL_REQUEST";
    public static final String APPROVAL_EXPIRED = "APPROVAL_EXPIRED";
    public static final String AUDIT_HIGH_RISK = "AUDIT_HIGH_RISK";
    /** 新的问题反馈（第十三轮） */
    public static final String FEEDBACK_NEW = "FEEDBACK_NEW";
    public static final String TEST = "TEST";

    public static final Set<String> EVENTS = Set.of(TASK_FAILED, TASK_OFFLINE, TASK_SUCCESS, APPROVAL_REQUEST, APPROVAL_EXPIRED, AUDIT_HIGH_RISK, FEEDBACK_NEW);
    public static final Set<String> TYPES = Set.of("DINGTALK", "WECOM", "FEISHU", "EMAIL", "WEBHOOK");

    /** 一条通知：标题、若干「名称：值」、管理后台里的页面路径（可空） */
    public record Message(String event, String title, Map<String, String> fields, String path)
    {
    }

    @Autowired
    private ItmNotifyChannelMapper channelMapper;

    @Autowired
    private ItmNotifyLogMapper logMapper;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private ItmDeviceMapper deviceMapper;

    @Autowired
    private ObjectProvider<JavaMailSender> mailSender;

    @Autowired
    @Qualifier("itmScheduler")
    private ThreadPoolTaskScheduler scheduler;

    @Autowired
    private ObjectMapper objectMapper;

    @Value("${spring.mail.host:}")
    private String smtpHost;

    @Value("${itm.mail.from:}")
    private String mailFrom;

    @Value("${spring.mail.username:}")
    private String smtpUser;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    // ---------------------------------------------------------------- 发布

    /** 发布事件：异步发给启用的、订阅了这个事件的渠道 */
    public void publish(String event, String title, Map<String, String> fields, String path)
    {
        try
        {
            List<ItmNotifyChannel> subs = channelMapper.selectSubscribers(event);
            if (subs.isEmpty())
            {
                return;
            }
            Message m = new Message(event, title, fields, path);
            for (ItmNotifyChannel ch : subs)
            {
                scheduler.execute(() -> deliver(ch, m, 0));
            }
        }
        catch (Exception e)
        {
            log.warn("发布通知失败：{}", e.getMessage());
        }
    }

    private void deliver(ItmNotifyChannel ch, Message m, int attempt)
    {
        try
        {
            send(ch, m);
            record(ch, m, null);
        }
        catch (Exception e)
        {
            if (attempt == 0)
            {
                scheduler.schedule(() -> deliver(ch, m, 1), Instant.now().plusSeconds(5));
            }
            else
            {
                record(ch, m, "重试后仍然失败：" + e.getMessage());
            }
        }
    }

    /** 发送测试消息（同步），返回 null 表示成功，否则是失败原因 */
    public String test(ItmNotifyChannel ch)
    {
        Map<String, String> f = new LinkedHashMap<>();
        f.put("渠道", ch.getChannelName());
        f.put("说明", "这是一条测试消息，收到说明渠道配置正确");
        Message m = new Message(TEST, "通知渠道测试", f, "/iterminal/notify");
        try
        {
            send(ch, m);
            record(ch, m, null);
            return null;
        }
        catch (Exception e)
        {
            record(ch, m, e.getMessage());
            return e.getMessage();
        }
    }

    private void record(ItmNotifyChannel ch, Message m, String error)
    {
        try
        {
            ItmNotifyLog l = new ItmNotifyLog();
            l.setChannelId(ch.getChannelId());
            l.setChannelName(ch.getChannelName());
            l.setChannelType(ch.getChannelType());
            l.setEvent(m.event());
            l.setTitle(StringUtils.substring(m.title(), 0, 200));
            l.setContent(StringUtils.substring(markdown(m), 0, 4000));
            l.setStatus(error == null ? "0" : "1");
            l.setError(StringUtils.substring(StringUtils.nvl(error, ""), 0, 500));
            l.setSentAt(new Date());
            logMapper.insertItmNotifyLog(l);
        }
        catch (Exception e)
        {
            log.warn("写通知记录失败：{}", e.getMessage());
        }
    }

    // ---------------------------------------------------------------- 渠道

    /** 校验渠道配置 */
    public void validate(ItmNotifyChannel ch)
    {
        if (StringUtils.isEmpty(ch.getChannelName()))
        {
            throw new ServiceException("请填写渠道名称");
        }
        if (!TYPES.contains(ch.getChannelType()))
        {
            throw new ServiceException("渠道类型不正确");
        }
        if ("EMAIL".equals(ch.getChannelType()))
        {
            if (recipients(ch).isEmpty())
            {
                throw new ServiceException("请填写收件人邮箱");
            }
            for (String r : recipients(ch))
            {
                if (!r.matches("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"))
                {
                    throw new ServiceException("邮箱格式不正确：" + r);
                }
            }
        }
        else if (!StringUtils.nvl(ch.getWebhook(), "").matches("^https?://\\S+$"))
        {
            throw new ServiceException("请填写机器人 / Webhook 地址（http:// 或 https:// 开头）");
        }
        List<String> events = splitList(ch.getEvents());
        if (events.isEmpty() || !EVENTS.containsAll(events))
        {
            throw new ServiceException("请选择要接收的事件");
        }
        ch.setEvents(String.join(",", events));
    }

    private static List<String> splitList(String s)
    {
        List<String> out = new ArrayList<>();
        for (String x : StringUtils.nvl(s, "").split("[,，;；\\s]+"))
        {
            if (!x.isBlank() && !out.contains(x.trim()))
            {
                out.add(x.trim());
            }
        }
        return out;
    }

    private static List<String> recipients(ItmNotifyChannel ch)
    {
        return splitList(ch.getRecipients());
    }

    private void send(ItmNotifyChannel ch, Message m) throws Exception
    {
        switch (ch.getChannelType())
        {
            case "DINGTALK" -> sendDingTalk(ch, m);
            case "WECOM" -> sendWeCom(ch, m);
            case "FEISHU" -> sendFeishu(ch, m);
            case "EMAIL" -> sendEmail(ch, m);
            case "WEBHOOK" -> sendWebhook(ch, m);
            default -> throw new IllegalStateException("不支持的渠道类型：" + ch.getChannelType());
        }
    }

    private List<String> mentions(ItmNotifyChannel ch)
    {
        return splitList(ch.getMention());
    }

    private static boolean atAll(List<String> mentions)
    {
        return mentions.stream().anyMatch(x -> "all".equalsIgnoreCase(x) || "@all".equalsIgnoreCase(x));
    }

    /** 钉钉机器人：Markdown；加签时在地址后带 timestamp 和 sign（HmacSHA256(timestamp + "\n" + secret)） */
    private void sendDingTalk(ItmNotifyChannel ch, Message m) throws Exception
    {
        String url = ch.getWebhook();
        if (StringUtils.isNotEmpty(ch.getSecret()))
        {
            long ts = System.currentTimeMillis();
            String sign = Base64.getEncoder().encodeToString(hmac(ch.getSecret().getBytes(StandardCharsets.UTF_8), (ts + "\n" + ch.getSecret()).getBytes(StandardCharsets.UTF_8)));
            url += (url.contains("?") ? "&" : "?") + "timestamp=" + ts + "&sign=" + URLEncoder.encode(sign, StandardCharsets.UTF_8);
        }
        List<String> at = mentions(ch);
        List<String> mobiles = at.stream().filter(x -> !atAll(List.of(x))).toList();
        String text = markdown(m) + (mobiles.isEmpty() ? "" : "\n\n" + String.join(" ", mobiles.stream().map(x -> "@" + x).toList()));
        Map<String, Object> body = Map.of(
            "msgtype", "markdown",
            "markdown", Map.of("title", "iTerminal：" + m.title(), "text", text),
            "at", Map.of("atMobiles", mobiles, "isAtAll", atAll(at)));
        checkCode(post(url, body, Map.of()), "errcode", "errmsg");
    }

    /** 企业微信机器人：没有 @ 时用 Markdown；需要 @ 手机号时用文本消息（Markdown 不支持按手机号 @） */
    private void sendWeCom(ItmNotifyChannel ch, Message m) throws Exception
    {
        List<String> at = mentions(ch);
        Map<String, Object> body;
        if (at.isEmpty())
        {
            body = Map.of("msgtype", "markdown", "markdown", Map.of("content", markdown(m)));
        }
        else
        {
            List<String> list = at.stream().map(x -> atAll(List.of(x)) ? "@all" : x).toList();
            body = Map.of("msgtype", "text", "text", Map.of("content", plain(m), "mentioned_mobile_list", list));
        }
        checkCode(post(ch.getWebhook(), body, Map.of()), "errcode", "errmsg");
    }

    /** 飞书机器人：文本消息；加签时 body 带 timestamp（秒）和 sign（以 timestamp + "\n" + secret 为密钥对空串做 HmacSHA256） */
    private void sendFeishu(ItmNotifyChannel ch, Message m) throws Exception
    {
        Map<String, Object> body = new LinkedHashMap<>();
        if (StringUtils.isNotEmpty(ch.getSecret()))
        {
            long ts = System.currentTimeMillis() / 1000;
            body.put("timestamp", String.valueOf(ts));
            body.put("sign", Base64.getEncoder().encodeToString(hmac((ts + "\n" + ch.getSecret()).getBytes(StandardCharsets.UTF_8), new byte[0])));
        }
        String text = plain(m);
        if (atAll(mentions(ch)))
        {
            text += "\n<at user_id=\"all\">所有人</at>";
        }
        body.put("msg_type", "text");
        body.put("content", Map.of("text", text));
        JsonNode r = post(ch.getWebhook(), body, Map.of());
        int code = r.has("code") ? r.path("code").asInt() : r.path("StatusCode").asInt(0);
        if (code != 0)
        {
            throw new IllegalStateException("飞书返回 " + code + "：" + r.path("msg").asText(r.path("StatusMessage").asText("")));
        }
    }

    /** 通用 Webhook：POST JSON；有密钥时带 X-Itm-Signature: sha256=hex(HmacSHA256(secret, body)) */
    private void sendWebhook(ItmNotifyChannel ch, Message m) throws Exception
    {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("event", m.event());
        body.put("title", m.title());
        body.put("text", plain(m));
        body.put("markdown", markdown(m));
        body.put("fields", m.fields());
        body.put("link", link(m));
        body.put("time", Instant.now().toString());
        String json = objectMapper.writeValueAsString(body);
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("X-Itm-Event", m.event());
        if (StringUtils.isNotEmpty(ch.getSecret()))
        {
            headers.put("X-Itm-Signature", "sha256=" + HexFormat.of().formatHex(hmac(ch.getSecret().getBytes(StandardCharsets.UTF_8), json.getBytes(StandardCharsets.UTF_8))));
        }
        postRaw(ch.getWebhook(), json, headers);
    }

    /** 邮件：SMTP 服务器用环境变量配置（ITM_SMTP_HOST 等），收件人在渠道里填写 */
    private void sendEmail(ItmNotifyChannel ch, Message m) throws Exception
    {
        JavaMailSender sender = mailSender.getIfAvailable();
        if (sender == null || StringUtils.isEmpty(smtpHost))
        {
            throw new IllegalStateException("没有配置邮件服务器：请设置环境变量 ITM_SMTP_HOST、ITM_SMTP_PORT、ITM_SMTP_USER、ITM_SMTP_PASSWORD 后重启服务端");
        }
        String from = StringUtils.isNotEmpty(mailFrom) ? mailFrom : smtpUser;
        if (StringUtils.isEmpty(from))
        {
            throw new IllegalStateException("没有配置发件人：请设置环境变量 ITM_SMTP_FROM");
        }
        MimeMessage mime = sender.createMimeMessage();
        MimeMessageHelper h = new MimeMessageHelper(mime, true, "UTF-8");
        h.setFrom(from);
        h.setTo(recipients(ch).toArray(new String[0]));
        h.setSubject("[iTerminal] " + m.title());
        h.setText(plain(m), html(m));
        sender.send(mime);
    }

    // ---------------------------------------------------------------- 发给当前用户的邮件（第二十八轮）

    /** 每个用户每小时最多发多少封（客户端的告警 / 定时任务邮件，防止告警风暴把邮箱塞满） */
    private static final int USER_MAIL_PER_HOUR = 60;
    private final Map<Long, List<Long>> userMailTimes = new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * 客户端的告警、定时任务报告、AI 排查结果：发到当前登录用户在用户资料里的邮箱。
     * 返回 SENT / NO_EMAIL（用户没有填邮箱）/ NO_SMTP（服务端没有配置邮件服务器）/ RATE_LIMITED。
     */
    public String mailToUser(Long userId, String email, String subject, String text)
    {
        if (StringUtils.isEmpty(email) || !email.contains("@"))
        {
            return "NO_EMAIL";
        }
        JavaMailSender sender = mailSender.getIfAvailable();
        String from = StringUtils.isNotEmpty(mailFrom) ? mailFrom : smtpUser;
        if (sender == null || StringUtils.isEmpty(smtpHost) || StringUtils.isEmpty(from))
        {
            return "NO_SMTP";
        }
        long now = System.currentTimeMillis();
        List<Long> times = userMailTimes.computeIfAbsent(userId, k -> new ArrayList<>());
        synchronized (times)
        {
            times.removeIf(t -> t < now - 3600_000L);
            if (times.size() >= USER_MAIL_PER_HOUR)
            {
                return "RATE_LIMITED";
            }
            times.add(now);
        }
        String title = StringUtils.substring(StringUtils.defaultString(subject).replaceAll("[\\r\\n]+", " "), 0, 200);
        String body = StringUtils.substring(StringUtils.defaultString(text), 0, 100_000);
        try
        {
            MimeMessage mime = sender.createMimeMessage();
            MimeMessageHelper h = new MimeMessageHelper(mime, true, "UTF-8");
            h.setFrom(from);
            h.setTo(email);
            h.setSubject("[iTerminal] " + title);
            String html = "<div style=\"font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;color:#1f1f1f\">"
                + "<h3 style=\"margin:0 0 12px\">" + HtmlUtils.htmlEscape(title) + "</h3>"
                + "<pre style=\"white-space:pre-wrap;word-break:break-word;font-family:inherit;line-height:1.6;margin:0\">" + HtmlUtils.htmlEscape(body) + "</pre>"
                + "<p style=\"color:#8c8c8c;font-size:12px;margin-top:16px\">这封邮件由 iTerminal 客户端发出（告警 / 定时任务 / AI 排查）。</p></div>";
            h.setText(body, html);
            sender.send(mime);
            return "SENT";
        }
        catch (Exception e)
        {
            log.warn("发送用户邮件失败 userId={}：{}", userId, e.getMessage());
            throw new ServiceException("邮件发送失败：" + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- HTTP

    private JsonNode post(String url, Object body, Map<String, String> headers) throws Exception
    {
        String text = postRaw(url, objectMapper.writeValueAsString(body), headers);
        try
        {
            return objectMapper.readTree(StringUtils.isEmpty(text) ? "{}" : text);
        }
        catch (Exception e)
        {
            throw new IllegalStateException("返回的不是 JSON：" + StringUtils.substring(text, 0, 200));
        }
    }

    private String postRaw(String url, String json, Map<String, String> headers) throws Exception
    {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url))
            .timeout(Duration.ofSeconds(10))
            .header("Content-Type", "application/json; charset=utf-8")
            .POST(HttpRequest.BodyPublishers.ofString(json, StandardCharsets.UTF_8));
        headers.forEach(b::header);
        HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (res.statusCode() < 200 || res.statusCode() >= 300)
        {
            throw new IllegalStateException("HTTP " + res.statusCode() + "：" + StringUtils.substring(res.body(), 0, 200));
        }
        return res.body();
    }

    private static void checkCode(JsonNode r, String codeField, String msgField)
    {
        int code = r.path(codeField).asInt(0);
        if (code != 0)
        {
            throw new IllegalStateException("返回 " + code + "：" + r.path(msgField).asText(""));
        }
    }

    private static byte[] hmac(byte[] key, byte[] data) throws Exception
    {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(key, "HmacSHA256"));
        return mac.doFinal(data);
    }

    // ---------------------------------------------------------------- 内容

    private String link(Message m)
    {
        String base = StringUtils.trim(configService.selectConfigByKey("itm.admin.url"));
        if (StringUtils.isEmpty(base) || StringUtils.isEmpty(m.path()))
        {
            return null;
        }
        return base.replaceAll("/+$", "") + m.path();
    }

    private static String now()
    {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date());
    }

    String markdown(Message m)
    {
        StringBuilder sb = new StringBuilder("### iTerminal：").append(m.title()).append("\n\n");
        m.fields().forEach((k, v) -> sb.append("- **").append(k).append("**：").append(StringUtils.nvl(v, "—").replace("\n", " ")).append("\n"));
        sb.append("- **时间**：").append(now()).append("\n");
        String link = link(m);
        if (link != null)
        {
            sb.append("\n[在管理后台查看](").append(link).append(")");
        }
        return sb.toString();
    }

    String plain(Message m)
    {
        StringBuilder sb = new StringBuilder("【iTerminal】").append(m.title()).append("\n");
        m.fields().forEach((k, v) -> sb.append(k).append("：").append(StringUtils.nvl(v, "—")).append("\n"));
        sb.append("时间：").append(now());
        String link = link(m);
        if (link != null)
        {
            sb.append("\n查看：").append(link);
        }
        return sb.toString();
    }

    private String html(Message m)
    {
        StringBuilder sb = new StringBuilder("<div style=\"font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;color:#222\">");
        sb.append("<h3 style=\"margin:0 0 12px\">iTerminal：").append(HtmlUtils.htmlEscape(m.title())).append("</h3><table style=\"border-collapse:collapse\">");
        Map<String, String> rows = new LinkedHashMap<>(m.fields());
        rows.put("时间", now());
        rows.forEach((k, v) -> sb.append("<tr><td style=\"padding:4px 16px 4px 0;color:#888;white-space:nowrap;vertical-align:top\">").append(HtmlUtils.htmlEscape(k))
            .append("</td><td style=\"padding:4px 0;white-space:pre-wrap\">").append(HtmlUtils.htmlEscape(StringUtils.nvl(v, "—"))).append("</td></tr>"));
        sb.append("</table>");
        String link = link(m);
        if (link != null)
        {
            sb.append("<p style=\"margin-top:16px\"><a href=\"").append(HtmlUtils.htmlEscape(link)).append("\">在管理后台查看</a></p>");
        }
        return sb.append("</div>").toString();
    }

    /** 设备的显示名：设备名称（用户） */
    public String deviceLabel(String deviceId)
    {
        try
        {
            ItmDevice d = deviceId == null ? null : deviceMapper.selectItmDeviceById(deviceId);
            if (d == null)
            {
                return deviceId;
            }
            return StringUtils.nvl(d.getDeviceName(), deviceId) + (StringUtils.isNotEmpty(d.getUserName()) ? "（" + d.getUserName() + "）" : "");
        }
        catch (Exception e)
        {
            return deviceId;
        }
    }

    /** 列表里不返回密钥明文 */
    public static ItmNotifyChannel masked(ItmNotifyChannel ch)
    {
        if (ch != null && StringUtils.isNotEmpty(ch.getSecret()))
        {
            ch.setSecret("******");
        }
        return ch;
    }

    public static boolean isMaskedSecret(String s)
    {
        return "******".equals(s);
    }

    static String join(String... parts)
    {
        return String.join("，", Arrays.stream(parts).filter(StringUtils::isNotEmpty).toList());
    }
}
