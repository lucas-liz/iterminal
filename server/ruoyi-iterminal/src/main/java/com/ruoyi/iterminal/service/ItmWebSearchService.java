package com.ruoyi.iterminal.service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.constant.CacheConstants;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.core.redis.RedisCache;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.api.ApiException;
import com.ruoyi.iterminal.config.ItmCrypto;
import com.ruoyi.system.service.ISysConfigService;

/**
 * 联网搜索（第二十五轮，文档二 5.5.4）：和团队模型无关的独立配置——管理员在后台选搜索服务的格式、填地址和 API Key（加密保存在参数设置里），
 * 客户端「联网」默认用这里的配置：POST /api/v1/ai/web/search、/fetch 由服务端换上 Key 转发，返回统一成 DeepSeek 的格式，Key 不下发。
 * <ul>
 * <li>deepseek：POST {根地址}/v1/tools/search {query, count}、/v1/tools/fetch {url}；</li>
 * <li>custom：DeepSeek 风格的接口，请求体同时带 query / text_query、count / limit，返回 results / search_results / data 都认（例如 Kimi 的 /v1/tools/search）。</li>
 * </ul>
 */
@Service
public class ItmWebSearchService
{
    private static final Logger log = LoggerFactory.getLogger(ItmWebSearchService.class);

    private static final String DEEPSEEK = "https://api.deepseek.com";
    private static final String AAD = "web:search";
    private static final String MASK = "******";
    private static final int MAX_QUERY = 128;
    private static final int MAX_URL = 8192;

    private static final Map<String, String> CONFIG_NAMES = Map.of(
        "itm.web.enabled", "iTerminal-联网搜索-启用",
        "itm.web.format", "iTerminal-联网搜索-接口格式",
        "itm.web.baseUrl", "iTerminal-联网搜索-DeepSeek 根地址",
        "itm.web.searchUrl", "iTerminal-联网搜索-搜索接口",
        "itm.web.fetchUrl", "iTerminal-联网搜索-网页读取接口",
        "itm.web.apiKey", "iTerminal-联网搜索-API Key（加密）",
        "itm.web.count", "iTerminal-联网搜索-每次条数",
        "itm.web.label", "iTerminal-联网搜索-显示名称",
        "itm.web.dailyLimit", "iTerminal-联网搜索-每人每天次数");

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private RedisCache redisCache;

    @Autowired
    private ItmCrypto crypto;

    @Autowired
    private ItmLlmService llmService;

    @Autowired
    private ObjectMapper objectMapper;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).followRedirects(HttpClient.Redirect.NORMAL).build();

    /** 配置（apiKey 是明文，只在服务端内部用） */
    public record Conf(boolean enabled, String format, String baseUrl, String searchUrl, String fetchUrl, String apiKey, int count, String label, int dailyLimit)
    {
        String searchEndpoint()
        {
            return "custom".equals(format) ? searchUrl : root(baseUrl) + "/v1/tools/search";
        }

        /** 网页读取地址；自定义格式没填时为 null（只能搜索） */
        String fetchEndpoint()
        {
            return "custom".equals(format) ? (StringUtils.isEmpty(fetchUrl) ? null : fetchUrl) : root(baseUrl) + "/v1/tools/fetch";
        }

        String displayLabel()
        {
            return StringUtils.isNotEmpty(label) ? label : "custom".equals(format) ? "自定义搜索" : "DeepSeek";
        }

        private static String root(String base)
        {
            String b = StringUtils.isEmpty(base) ? DEEPSEEK : base.trim();
            return b.replaceAll("/+$", "").replaceAll("(?i)/(v1|anthropic)$", "");
        }
    }

    private String cfg(String key)
    {
        return StringUtils.trim(StringUtils.nvl(configService.selectConfigByKey(key), ""));
    }

    private int intCfg(String key, int fallback)
    {
        try
        {
            return Integer.parseInt(cfg(key));
        }
        catch (NumberFormatException e)
        {
            return fallback;
        }
    }

    public Conf conf()
    {
        String enc = cfg("itm.web.apiKey");
        String key = "";
        if (StringUtils.isNotEmpty(enc))
        {
            try
            {
                key = crypto.decrypt(enc, AAD);
            }
            catch (Exception e)
            {
                log.warn("联网搜索的 API Key 解不开（数据密钥可能换过）：{}", e.getMessage());
            }
        }
        int count = intCfg("itm.web.count", 8);
        return new Conf("true".equalsIgnoreCase(cfg("itm.web.enabled")), "custom".equals(cfg("itm.web.format")) ? "custom" : "deepseek", cfg("itm.web.baseUrl"), cfg("itm.web.searchUrl"), cfg("itm.web.fetchUrl"), key,
            count >= 1 && count <= 20 ? count : 8, cfg("itm.web.label"), Math.max(0, intCfg("itm.web.dailyLimit", 500)));
    }

    // ---------------------------------------------------------------- 管理后台

    /** 管理后台看到的配置：Key 显示为 ******（没有设置时为空） */
    public Map<String, Object> adminView()
    {
        Conf c = conf();
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("enabled", c.enabled());
        v.put("format", c.format());
        v.put("baseUrl", c.baseUrl());
        v.put("searchUrl", c.searchUrl());
        v.put("fetchUrl", c.fetchUrl());
        v.put("apiKey", StringUtils.isNotEmpty(c.apiKey()) ? MASK : "");
        v.put("count", c.count());
        v.put("label", c.label());
        v.put("dailyLimit", c.dailyLimit());
        return v;
    }

    /** 表单 → 配置（apiKey 为 ****** 或空串时沿用已保存的） */
    public Conf draft(Map<String, Object> body)
    {
        Conf cur = conf();
        String format = "custom".equals(str(body, "format")) ? "custom" : "deepseek";
        String key = str(body, "apiKey");
        if (StringUtils.isEmpty(key) || MASK.equals(key))
        {
            key = cur.apiKey();
        }
        int count;
        try
        {
            count = Integer.parseInt(str(body, "count"));
        }
        catch (NumberFormatException e)
        {
            count = 8;
        }
        int daily;
        try
        {
            daily = Integer.parseInt(str(body, "dailyLimit"));
        }
        catch (NumberFormatException e)
        {
            daily = 500;
        }
        Conf c = new Conf("true".equals(str(body, "enabled")), format, url(str(body, "baseUrl"), "DeepSeek 根地址"), url(str(body, "searchUrl"), "搜索接口地址"), url(str(body, "fetchUrl"), "网页读取接口地址"), key,
            Math.min(Math.max(count, 1), 20), StringUtils.substring(str(body, "label"), 0, 30), Math.max(0, daily));
        if (c.enabled())
        {
            if ("custom".equals(format) && StringUtils.isEmpty(c.searchUrl()))
            {
                throw new ServiceException("自定义格式要填写搜索接口地址");
            }
            if (StringUtils.isEmpty(c.apiKey()))
            {
                throw new ServiceException("请填写搜索服务的 API Key");
            }
        }
        return c;
    }

    public void save(Map<String, Object> body, String user)
    {
        Conf c = draft(body);
        setConfig("itm.web.enabled", String.valueOf(c.enabled()), user);
        setConfig("itm.web.format", c.format(), user);
        setConfig("itm.web.baseUrl", c.baseUrl(), user);
        setConfig("itm.web.searchUrl", c.searchUrl(), user);
        setConfig("itm.web.fetchUrl", c.fetchUrl(), user);
        setConfig("itm.web.apiKey", crypto.encrypt(c.apiKey(), AAD), user);
        setConfig("itm.web.count", String.valueOf(c.count()), user);
        setConfig("itm.web.label", c.label(), user);
        setConfig("itm.web.dailyLimit", String.valueOf(c.dailyLimit()), user);
    }

    /** 用表单里的配置搜一次（不保存） */
    public Map<String, Object> test(Map<String, Object> body)
    {
        Conf c = draft(body);
        if (StringUtils.isEmpty(c.apiKey()))
        {
            throw new ServiceException("请填写搜索服务的 API Key");
        }
        long t0 = System.currentTimeMillis();
        String q = StringUtils.isNotEmpty(str(body, "query")) ? str(body, "query") : "iTerminal";
        List<Map<String, Object>> results = searchWith(c, q, Math.min(c.count(), 5));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("elapsedMs", System.currentTimeMillis() - t0);
        out.put("results", results.stream().map(r -> Map.of("title", r.get("title"), "url", r.get("url"))).toList());
        return out;
    }

    // ---------------------------------------------------------------- 客户端

    /** GET /api/v1/ai/web：客户端显示用（不含 Key）；没启用时 enabled = false */
    public Map<String, Object> clientInfo()
    {
        Conf c = conf();
        Map<String, Object> v = new LinkedHashMap<>();
        boolean on = c.enabled() && StringUtils.isNotEmpty(c.apiKey());
        v.put("enabled", on);
        if (on)
        {
            v.put("format", c.format());
            v.put("label", c.displayLabel());
            v.put("count", c.count());
            v.put("fetch", c.fetchEndpoint() != null);
        }
        return v;
    }

    public Map<String, Object> search(Map<String, Object> body, LoginUser user)
    {
        Conf c = ready(user);
        String q = StringUtils.trim(str(body, "query"));
        if (StringUtils.isEmpty(q))
        {
            throw ApiException.badRequest("请提供搜索词");
        }
        int count;
        try
        {
            count = Integer.parseInt(str(body, "count"));
        }
        catch (NumberFormatException e)
        {
            count = c.count();
        }
        return Map.of("results", searchWith(c, StringUtils.substring(q, 0, MAX_QUERY), Math.min(Math.max(count, 1), 20)));
    }

    public Map<String, Object> fetch(Map<String, Object> body, LoginUser user)
    {
        Conf c = ready(user);
        String url = StringUtils.trim(str(body, "url"));
        if (url.length() > MAX_URL || !url.matches("^https?://[^/@\\s]+(/\\S*)?$"))
        {
            throw ApiException.badRequest("网址格式不正确：只能读取 http / https 网页，网址里不能带账号密码");
        }
        String endpoint = c.fetchEndpoint();
        if (endpoint == null)
        {
            throw ApiException.badRequest("服务端的搜索服务没有配置网页读取接口，只能搜索");
        }
        JsonNode j = post(c, endpoint, Map.of("url", url), "读取网页");
        JsonNode d = j.path("data").isObject() ? j.path("data") : j;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("title", first(d.path("title").asText(""), j.path("title").asText("")));
        out.put("content", first(d.path("content").asText(""), d.path("text").asText(""), d.path("markdown").asText(""), j.path("content").asText("")));
        return out;
    }

    /** 启用了、有 Key、没超过每人每天的次数，再检查团队模型的每分钟请求数（共用一个限流） */
    private Conf ready(LoginUser user)
    {
        Conf c = conf();
        if (!c.enabled() || StringUtils.isEmpty(c.apiKey()))
        {
            throw new ApiException(HttpStatus.NOT_FOUND, "服务端还没有配置联网搜索，请联系管理员");
        }
        String quota = llmService.checkQuota(user.getUserId());
        if (quota != null)
        {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, quota);
        }
        if (c.dailyLimit() > 0)
        {
            String key = "itm:web:daily:" + user.getUserId() + ":" + new SimpleDateFormat("yyyyMMdd").format(new Date());
            Long n = redisCache.redisTemplate.opsForValue().increment(key);
            if (n != null && n == 1)
            {
                redisCache.expire(key, 2, TimeUnit.DAYS);
            }
            if (n != null && n > c.dailyLimit())
            {
                throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "今天的联网搜索次数已经用完（每人每天 " + c.dailyLimit() + " 次），明天恢复");
            }
        }
        return c;
    }

    private List<Map<String, Object>> searchWith(Conf c, String query, int count)
    {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("query", query);
        body.put("count", count);
        if ("custom".equals(c.format()))
        {
            body.put("text_query", query);
            body.put("limit", count);
        }
        JsonNode j = post(c, c.searchEndpoint(), body, "联网搜索");
        JsonNode list = j.path("results").isArray() ? j.path("results")
            : j.path("search_results").isArray() ? j.path("search_results")
            : j.path("data").isArray() ? j.path("data")
            : j.path("data").path("results").isArray() ? j.path("data").path("results")
            : j.path("items");
        List<Map<String, Object>> out = new ArrayList<>();
        for (JsonNode x : list)
        {
            String url = first(x.path("url").asText(""), x.path("link").asText(""));
            if (StringUtils.isEmpty(url))
            {
                continue;
            }
            String snippet = first(x.path("snippet").asText(""), x.path("summary").asText(""), x.path("description").asText(""), StringUtils.substring(x.path("text").asText(""), 0, 300));
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("title", first(x.path("title").asText(""), url));
            r.put("url", url);
            r.put("site_name", nullIfEmpty(first(x.path("site_name").asText(""), x.path("site").asText(""), x.path("source").asText(""))));
            r.put("date", nullIfEmpty(first(x.path("date").asText(""), x.path("published_date").asText(""))));
            r.put("snippet", snippet);
            r.put("summary", first(x.path("summary").asText(""), snippet));
            out.add(r);
            if (out.size() >= count)
            {
                break;
            }
        }
        return out;
    }

    private JsonNode post(Conf c, String endpoint, Map<String, Object> body, String what)
    {
        HttpResponse<String> res;
        try
        {
            HttpRequest req = HttpRequest.newBuilder(URI.create(endpoint)).timeout(Duration.ofSeconds(45))
                .header("content-type", "application/json").header("authorization", "Bearer " + c.apiKey())
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body), StandardCharsets.UTF_8)).build();
            res = http.send(req, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }
        catch (java.net.http.HttpTimeoutException e)
        {
            throw new ApiException(HttpStatus.GATEWAY_TIMEOUT, what + "超时，请稍后再试");
        }
        catch (Exception e)
        {
            throw new ApiException(HttpStatus.BAD_GATEWAY, "连不上搜索服务：" + StringUtils.nvl(e.getMessage(), e.getClass().getSimpleName()));
        }
        int st = res.statusCode();
        if (st / 100 != 2)
        {
            String msg = errorText(res.body());
            // 上游的 401 / 402 是服务端的 Key 或余额问题，不能原样返回 401（客户端会以为登录过期）
            String hint = st == 401 ? "服务端搜索服务的 API Key 无效，请联系管理员" : st == 402 ? "服务端搜索服务的账户余额不足，请联系管理员" : st == 429 ? what + "太频繁，请稍后再试" : what + "失败（HTTP " + st + "）";
            throw new ApiException(st == 429 ? HttpStatus.TOO_MANY_REQUESTS : st == 404 ? HttpStatus.UNPROCESSABLE_ENTITY : HttpStatus.BAD_GATEWAY, hint + (StringUtils.isNotEmpty(msg) ? "：" + msg : ""));
        }
        try
        {
            return objectMapper.readTree(res.body());
        }
        catch (Exception e)
        {
            throw new ApiException(HttpStatus.BAD_GATEWAY, what + "返回的不是 JSON");
        }
    }

    private String errorText(String body)
    {
        try
        {
            JsonNode j = objectMapper.readTree(body);
            JsonNode e = j.path("error");
            String m = e.isTextual() ? e.asText() : first(e.path("message").asText(""), j.path("msg").asText(""), j.path("message").asText(""));
            return StringUtils.substring(m, 0, 300);
        }
        catch (Exception ex)
        {
            return StringUtils.substring(StringUtils.trim(StringUtils.nvl(body, "")), 0, 200);
        }
    }

    private void setConfig(String key, String value, String user)
    {
        int n = jdbc.update("update sys_config set config_value = ?, update_by = ?, update_time = now() where config_key = ?", value, user, key);
        if (n == 0)
        {
            jdbc.update("insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, remark) values (?, ?, ?, 'Y', ?, now(), '')",
                CONFIG_NAMES.getOrDefault(key, key), key, value, user);
        }
        redisCache.setCacheObject(CacheConstants.SYS_CONFIG_KEY + key, value);
    }

    private static String url(String v, String label)
    {
        String u = StringUtils.trim(StringUtils.nvl(v, ""));
        if (StringUtils.isNotEmpty(u) && !u.matches("^https?://\\S+$"))
        {
            throw new ServiceException(label + "要以 http:// 或 https:// 开头");
        }
        return u.replaceAll("/+$", "");
    }

    private static String str(Map<String, Object> m, String k)
    {
        Object v = m == null ? null : m.get(k);
        return v == null ? "" : String.valueOf(v);
    }

    private static String first(String... vs)
    {
        for (String v : vs)
        {
            if (StringUtils.isNotEmpty(v))
            {
                return v;
            }
        }
        return "";
    }

    private static String nullIfEmpty(String v)
    {
        return StringUtils.isEmpty(v) ? null : v;
    }
}
