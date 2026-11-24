package com.ruoyi.iterminal.service;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.core.redis.RedisCache;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.config.ItmCrypto;
import com.ruoyi.iterminal.domain.ItmDevice;
import com.ruoyi.iterminal.domain.ItmLlmProvider;
import com.ruoyi.iterminal.domain.ItmLlmUsage;
import com.ruoyi.iterminal.mapper.ItmLlmProviderMapper;
import com.ruoyi.iterminal.mapper.ItmLlmUsageMapper;
import com.ruoyi.system.service.ISysConfigService;

/**
 * 团队模型（文档二 5.5 大模型代理）：管理员在后台配置模型提供商和 API Key（加密保存），
 * 客户端把 {服务端}/api/v1/llm/proxy/{提供商ID} 当作 OpenAI / Anthropic 兼容的接口地址、用登录令牌鉴权；
 * 服务端换上真实的 Key 后转发（流式原样透传），按用户限流、统计用量。Key 不会下发到客户端。
 */
@Service
public class ItmLlmService
{
    private static final Logger log = LoggerFactory.getLogger(ItmLlmService.class);

    public static final Set<String> TYPES = Set.of("ANTHROPIC", "OPENAI", "OPENAI_COMPAT");
    public static final Set<String> STYLES = Set.of("anthropic", "openai-effort", "qwen", "thinking-type", "minimax", "openrouter", "tags", "none");
    /** 思考强度（按从低到高的顺序；minimal 第二十五轮加入） */
    private static final List<String> EFFORTS = List.of("minimal", "low", "medium", "high", "xhigh", "max");
    /** 思考控制方式：自适应档位 / Token 预算 / 仅开关（第二十五轮） */
    private static final Set<String> THINKING_CONTROLS = Set.of("effort", "budget", "toggle");
    private static final String MASK = "******";
    private static final int MAX_BODY = 20 * 1024 * 1024;
    /** 可以转发的接口：POST 对话、计数、向量；GET 模型列表。联网搜索第二十五轮改成独立的配置（ItmWebSearchService），不再借用模型的 Key */
    private static final Pattern POST_PATHS = Pattern.compile("^(chat/completions|v1/messages|v1/messages/count_tokens|embeddings|v1/embeddings)$");
    private static final Pattern GET_PATHS = Pattern.compile("^(models|v1/models)$");

    @Autowired
    private ItmLlmProviderMapper providerMapper;

    @Autowired
    private ItmLlmUsageMapper usageMapper;

    @Autowired
    private ItmCrypto crypto;

    @Autowired
    private ItmGrant grant;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private RedisCache redisCache;

    @Autowired
    private ObjectMapper objectMapper;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).followRedirects(HttpClient.Redirect.NORMAL).build();

    // ---------------------------------------------------------------- 管理

    /** 返回给管理后台：Key 显示为 ******（没有设置时为空） */
    public ItmLlmProvider masked(ItmLlmProvider p)
    {
        if (p != null)
        {
            p.setApiKey(StringUtils.isNotEmpty(p.getApiKeyEnc()) ? MASK : "");
        }
        return p;
    }

    public void validate(ItmLlmProvider p)
    {
        if (StringUtils.isEmpty(p.getProviderName()))
        {
            throw new ServiceException("请填写名称");
        }
        if (!TYPES.contains(p.getProviderType()))
        {
            throw new ServiceException("协议不正确");
        }
        String url = StringUtils.trim(StringUtils.nvl(p.getBaseUrl(), ""));
        if (!url.matches("^https?://\\S+$"))
        {
            throw new ServiceException("接口地址需要以 http:// 或 https:// 开头");
        }
        p.setBaseUrl(url.replaceAll("/+$", ""));
        if (p.getThinkingStyle() != null && !STYLES.contains(p.getThinkingStyle()))
        {
            throw new ServiceException("深度思考方式不正确");
        }
        List<Map<String, Object>> models = parseModels(p.getModels());
        if (models.isEmpty())
        {
            throw new ServiceException("请至少添加一个模型");
        }
        // 可用范围：角色 / 用户 / 组织（第十三轮）
        if (p.getRoleKeys() != null)
        {
            p.setRoleKeys(ItmGrant.normalizeKeys(p.getRoleKeys(), 500));
        }
        if (p.getUserIds() != null)
        {
            p.setUserIds(ItmGrant.normalizeIds(p.getUserIds(), 2000));
        }
        if (p.getDeptIds() != null)
        {
            p.setDeptIds(ItmGrant.normalizeIds(p.getDeptIds(), 1000));
        }
        try
        {
            p.setModels(objectMapper.writeValueAsString(models));
        }
        catch (Exception e)
        {
            throw new ServiceException("模型列表格式不正确");
        }
    }

    /** 模型列表：[{id, displayName, contextWindow, maxOutput, supportsImages, reasoning, efforts, thinkingControl, supportsTools, imageFormat}]，去掉不认识的字段 */
    private List<Map<String, Object>> parseModels(String json)
    {
        List<Map<String, Object>> out = new ArrayList<>();
        try
        {
            JsonNode arr = objectMapper.readTree(StringUtils.nvl(json, "[]"));
            for (JsonNode m : arr)
            {
                String id = StringUtils.trim(m.path("id").asText(""));
                if (id.isEmpty() || out.stream().anyMatch(x -> id.equals(x.get("id"))))
                {
                    continue;
                }
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("id", id);
                String name = StringUtils.trim(m.path("displayName").asText(""));
                if (!name.isEmpty())
                {
                    v.put("displayName", name);
                }
                v.put("contextWindow", Math.max(1024, m.path("contextWindow").asInt(128_000)));
                v.put("maxOutput", Math.max(256, m.path("maxOutput").asInt(8192)));
                v.put("supportsImages", m.path("supportsImages").asBoolean(false));
                String reasoning = m.path("reasoning").asText("");
                if (Set.of("none", "optional", "always").contains(reasoning))
                {
                    v.put("reasoning", reasoning);
                }
                // 模型支持的思考强度：客户端发 reasoning_effort 时换成其中最接近的一档
                List<String> efforts = new ArrayList<>();
                m.path("efforts").forEach(e -> efforts.add(e.asText("")));
                List<String> known = EFFORTS.stream().filter(efforts::contains).toList();
                if (!known.isEmpty())
                {
                    v.put("efforts", known);
                }
                // 第二十五轮：思考控制方式、能不能调用工具、图片发送格式（客户端「检测模型能力」的结果，管理员也可以手动设置）
                String control = m.path("thinkingControl").asText("");
                if (THINKING_CONTROLS.contains(control))
                {
                    v.put("thinkingControl", control);
                }
                if (m.path("supportsTools").isBoolean())
                {
                    v.put("supportsTools", m.path("supportsTools").asBoolean());
                }
                if ("base64".equals(m.path("imageFormat").asText("")))
                {
                    v.put("imageFormat", "base64");
                }
                out.add(v);
            }
        }
        catch (Exception e)
        {
            throw new ServiceException("模型列表格式不正确：" + e.getMessage());
        }
        return out;
    }

    public int save(ItmLlmProvider p, String user)
    {
        validate(p);
        int n;
        if (p.getProviderId() == null)
        {
            p.setCreateBy(user);
            n = providerMapper.insertItmLlmProvider(p);
        }
        else
        {
            p.setUpdateBy(user);
            n = providerMapper.updateItmLlmProvider(p);
        }
        // Key：****** 或 null 表示不修改，空串表示清除
        if (p.getApiKey() != null && !MASK.equals(p.getApiKey()))
        {
            providerMapper.updateApiKey(p.getProviderId(), crypto.encrypt(p.getApiKey().trim(), aad(p.getProviderId())));
        }
        return n;
    }

    private static String aad(Long id)
    {
        return "llm:" + id;
    }

    private String apiKeyOf(ItmLlmProvider p)
    {
        return crypto.decrypt(p.getApiKeyEnc(), aad(p.getProviderId()));
    }

    /** 测试和拉取模型时可以用还没保存的表单；Key 为 ****** 时用已经保存的 */
    private String draftKey(ItmLlmProvider p)
    {
        if (p.getApiKey() != null && !MASK.equals(p.getApiKey()))
        {
            return p.getApiKey().trim();
        }
        if (p.getProviderId() == null)
        {
            return "";
        }
        ItmLlmProvider saved = providerMapper.selectItmLlmProviderById(p.getProviderId());
        return saved == null ? "" : apiKeyOf(saved);
    }

    /** 测试连接：用最小的请求调一次，返回耗时和回复的开头 */
    public Map<String, Object> test(ItmLlmProvider p, String modelId)
    {
        validate(p);
        String model = StringUtils.isNotEmpty(modelId) ? modelId : String.valueOf(parseModels(p.getModels()).get(0).get("id"));
        String key = draftKey(p);
        long t0 = System.currentTimeMillis();
        try
        {
            ObjectNode body = objectMapper.createObjectNode();
            body.put("model", model);
            body.put("max_tokens", 16);
            body.putArray("messages").addObject().put("role", "user").put("content", "ping，请只回复 pong");
            String path = "ANTHROPIC".equals(p.getProviderType()) ? "/v1/messages" : "/chat/completions";
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(p.getBaseUrl() + path)).timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)));
            auth(b, p.getProviderType(), key);
            HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (res.statusCode() / 100 != 2)
            {
                throw new ServiceException("HTTP " + res.statusCode() + "：" + StringUtils.substring(res.body(), 0, 300));
            }
            JsonNode r = objectMapper.readTree(res.body());
            String text = "ANTHROPIC".equals(p.getProviderType()) ? r.path("content").path(0).path("text").asText("") : r.path("choices").path(0).path("message").path("content").asText("");
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("model", model);
            out.put("latencyMs", System.currentTimeMillis() - t0);
            out.put("reply", StringUtils.substring(text, 0, 100));
            return out;
        }
        catch (ServiceException e)
        {
            throw e;
        }
        catch (Exception e)
        {
            throw new ServiceException("连接失败：" + e.getMessage());
        }
    }

    /** 第一个启用的团队模型（按显示顺序） */
    private ItmLlmProvider firstEnabled()
    {
        ItmLlmProvider q = new ItmLlmProvider();
        q.setStatus("0");
        List<ItmLlmProvider> all = providerMapper.selectItmLlmProviderList(q);
        return all.isEmpty() ? null : all.get(0);
    }

    /**
     * 服务端自己调用一次团队模型（非流式，例如问题反馈的 AI 分析，文档二 5.15）。
     * providerId / modelId 为空时用第一个启用的团队模型和它的第一个模型；用量记在 itm_llm_usage（设备记为 admin）。
     * 返回 {text, model, providerName, inputTokens, outputTokens, latencyMs}。
     */
    public Map<String, Object> complete(Long providerId, String modelId, String system, String prompt, int maxTokens, LoginUser user)
    {
        ItmLlmProvider p = providerId == null ? firstEnabled() : providerMapper.selectItmLlmProviderById(providerId);
        if (p == null || !"0".equals(p.getStatus()))
        {
            throw new ServiceException("没有可用的团队模型：请先在「团队模型」里添加并启用一个，或者在参数设置里指定 itm.feedback.aiProviderId");
        }
        List<Map<String, Object>> models = parseModels(p.getModels());
        String model = StringUtils.isNotEmpty(modelId) ? modelId : models.isEmpty() ? "" : String.valueOf(models.get(0).get("id"));
        if (StringUtils.isEmpty(model))
        {
            throw new ServiceException("团队模型「" + p.getProviderName() + "」没有配置模型");
        }
        boolean anthropic = "ANTHROPIC".equals(p.getProviderType());
        long t0 = System.currentTimeMillis();
        String err = null;
        int input = 0;
        int output = 0;
        try
        {
            ObjectNode body = objectMapper.createObjectNode();
            body.put("model", model);
            body.put("max_tokens", maxTokens);
            body.put("stream", false);
            if (anthropic)
            {
                body.put("system", system);
                body.putArray("messages").addObject().put("role", "user").put("content", prompt);
            }
            else
            {
                var msgs = body.putArray("messages");
                msgs.addObject().put("role", "system").put("content", system);
                msgs.addObject().put("role", "user").put("content", prompt);
            }
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(p.getBaseUrl() + (anthropic ? "/v1/messages" : "/chat/completions"))).timeout(Duration.ofSeconds(180))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)));
            auth(b, p.getProviderType(), apiKeyOf(p));
            HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (res.statusCode() / 100 != 2)
            {
                err = "HTTP " + res.statusCode() + "：" + StringUtils.substring(res.body(), 0, 300);
                throw new ServiceException("模型调用失败：" + err);
            }
            JsonNode r = objectMapper.readTree(res.body());
            StringBuilder text = new StringBuilder();
            if (anthropic)
            {
                for (JsonNode c : r.path("content"))
                {
                    if ("text".equals(c.path("type").asText()))
                    {
                        text.append(c.path("text").asText(""));
                    }
                }
                input = r.path("usage").path("input_tokens").asInt(0);
                output = r.path("usage").path("output_tokens").asInt(0);
            }
            else
            {
                text.append(r.path("choices").path(0).path("message").path("content").asText(""));
                input = r.path("usage").path("prompt_tokens").asInt(0);
                output = r.path("usage").path("completion_tokens").asInt(0);
            }
            if (text.toString().isBlank())
            {
                err = "模型没有返回内容";
                throw new ServiceException(err);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("text", text.toString().trim());
            out.put("model", model);
            out.put("providerName", p.getProviderName());
            out.put("inputTokens", input);
            out.put("outputTokens", output);
            out.put("latencyMs", System.currentTimeMillis() - t0);
            return out;
        }
        catch (ServiceException e)
        {
            if (err == null)
            {
                err = e.getMessage();
            }
            throw e;
        }
        catch (Exception e)
        {
            err = e.getMessage();
            throw new ServiceException("模型调用失败：" + e.getMessage());
        }
        finally
        {
            try
            {
                ItmLlmUsage u = new ItmLlmUsage();
                u.setUserId(user == null ? 0L : user.getUserId());
                u.setUserName(user == null ? "" : user.getUsername());
                u.setDeviceId("admin");
                u.setProviderId(p.getProviderId());
                u.setProviderName(p.getProviderName());
                u.setModel(StringUtils.substring(model, 0, 100));
                u.setInputTokens(input);
                u.setOutputTokens(output);
                u.setEstimated("0");
                u.setStatus(err == null ? "0" : "1");
                u.setError(StringUtils.substring(StringUtils.nvl(err, ""), 0, 500));
                u.setDurationMs((int) Math.min(System.currentTimeMillis() - t0, Integer.MAX_VALUE));
                u.setCreatedAt(new Date());
                usageMapper.insertItmLlmUsage(u);
            }
            catch (Exception e)
            {
                log.warn("记录模型用量失败：{}", e.getMessage());
            }
        }
    }

    /** 从上游拉取模型 ID 列表（OpenAI / Anthropic 的 models 接口） */
    public List<String> fetchModelIds(ItmLlmProvider p)
    {
        String url = StringUtils.trim(StringUtils.nvl(p.getBaseUrl(), "")).replaceAll("/+$", "");
        if (!url.matches("^https?://\\S+$"))
        {
            throw new ServiceException("接口地址需要以 http:// 或 https:// 开头");
        }
        try
        {
            String path = "ANTHROPIC".equals(p.getProviderType()) ? "/v1/models" : "/models";
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url + path)).timeout(Duration.ofSeconds(30)).GET();
            auth(b, p.getProviderType(), draftKey(p));
            HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (res.statusCode() / 100 != 2)
            {
                throw new ServiceException("HTTP " + res.statusCode() + "：" + StringUtils.substring(res.body(), 0, 300));
            }
            List<String> ids = new ArrayList<>();
            JsonNode r = objectMapper.readTree(res.body());
            for (JsonNode m : r.path("data").isArray() ? r.path("data") : r.path("models"))
            {
                String id = m.path("id").asText(m.path("name").asText(""));
                if (!id.isEmpty())
                {
                    ids.add(id);
                }
            }
            return ids;
        }
        catch (ServiceException e)
        {
            throw e;
        }
        catch (Exception e)
        {
            throw new ServiceException("拉取失败：" + e.getMessage());
        }
    }

    private static void auth(HttpRequest.Builder b, String type, String key)
    {
        auth(b, type, key, true);
    }

    /** withVersion：Anthropic 补上 anthropic-version（代理时客户端已经带了就不重复加） */
    private static void auth(HttpRequest.Builder b, String type, String key, boolean withVersion)
    {
        if ("ANTHROPIC".equals(type) && withVersion)
        {
            b.header("anthropic-version", "2023-06-01");
        }
        if (StringUtils.isEmpty(key))
        {
            return;
        }
        if ("ANTHROPIC".equals(type))
        {
            b.header("x-api-key", key);
        }
        else
        {
            b.header("Authorization", "Bearer " + key);
        }
    }

    /**
     * 生成向量（知识库用）：调用团队模型提供商的 OpenAI 兼容 embeddings 接口，返回和输入一一对应的向量。
     * 提供商不存在、停用或者协议是 Anthropic（没有 embeddings 接口）时报错。
     */
    public List<float[]> embed(Long providerId, String model, List<String> inputs)
    {
        ItmLlmProvider p = providerId == null ? null : providerMapper.selectItmLlmProviderById(providerId);
        if (p == null || !"0".equals(p.getStatus()))
        {
            throw new ServiceException("向量模型的提供商不存在或已停用");
        }
        if ("ANTHROPIC".equals(p.getProviderType()))
        {
            throw new ServiceException("Anthropic 没有向量接口，请选择 OpenAI 或 OpenAI 兼容的提供商");
        }
        return embedAt(p.getBaseUrl(), p.getProviderType(), apiKeyOf(p), model, inputs);
    }

    /**
     * 生成向量：调用本地向量服务（和后端部署在一起的 Ollama / TEI / Xinference 等）的 OpenAI 兼容接口，
     * baseUrl 例如 http://127.0.0.1:11434/v1，请求 {baseUrl}/embeddings，不带 Key。
     */
    public List<float[]> embedLocal(String baseUrl, String model, List<String> inputs)
    {
        return embedAt(baseUrl, "OPENAI_COMPAT", "", model, inputs);
    }

    private List<float[]> embedAt(String baseUrl, String type, String key, String model, List<String> inputs)
    {
        try
        {
            ObjectNode body = objectMapper.createObjectNode();
            body.put("model", model);
            com.fasterxml.jackson.databind.node.ArrayNode arr = body.putArray("input");
            inputs.forEach(arr::add);
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl + "/embeddings")).timeout(Duration.ofSeconds(120))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)));
            auth(b, type, key);
            HttpResponse<String> res = http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (res.statusCode() / 100 != 2)
            {
                throw new ServiceException("向量接口返回 HTTP " + res.statusCode() + "：" + StringUtils.substring(res.body(), 0, 300));
            }
            JsonNode data = objectMapper.readTree(res.body()).path("data");
            float[][] out = new float[inputs.size()][];
            for (JsonNode item : data)
            {
                int idx = item.path("index").asInt(-1);
                JsonNode emb = item.path("embedding");
                if (idx < 0 || idx >= out.length || !emb.isArray())
                {
                    continue;
                }
                float[] v = new float[emb.size()];
                for (int i = 0; i < v.length; i++)
                {
                    v[i] = (float) emb.get(i).asDouble();
                }
                out[idx] = v;
            }
            for (float[] v : out)
            {
                if (v == null)
                {
                    throw new ServiceException("向量接口返回的条数和输入不一致");
                }
            }
            return java.util.Arrays.asList(out);
        }
        catch (ServiceException e)
        {
            throw e;
        }
        catch (Exception e)
        {
            throw new ServiceException("调用向量接口失败：" + StringUtils.nvl(e.getMessage(), e.getClass().getSimpleName()));
        }
    }

    // ---------------------------------------------------------------- 客户端

    /** 这个用户可以用的团队模型（不含 Key） */
    public List<Map<String, Object>> modelsFor(LoginUser user)
    {
        ItmLlmProvider q = new ItmLlmProvider();
        q.setStatus("0");
        List<Map<String, Object>> out = new ArrayList<>();
        for (ItmLlmProvider p : providerMapper.selectItmLlmProviderList(q))
        {
            if (!canUse(p, user))
            {
                continue;
            }
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("id", String.valueOf(p.getProviderId()));
            v.put("name", p.getProviderName());
            v.put("type", p.getProviderType());
            v.put("thinkingStyle", StringUtils.nvl(p.getThinkingStyle(), "none"));
            v.put("echoReasoning", "1".equals(p.getEchoReasoning()));
            v.put("models", parseModels(p.getModels()));
            out.add(v);
        }
        return out;
    }

    /** 可用范围：角色 / 用户 / 组织任意满足一项（都为空表示所有人；管理员始终可用） */
    private boolean canUse(ItmLlmProvider p, LoginUser user)
    {
        return grant.allowed(user, p.getRoleKeys(), p.getUserIds(), p.getDeptIds());
    }

    /**
     * 代理一次请求：检查权限和配额 → 换上真实 Key 转发 → 原样把响应（包括 SSE 流）写回 → 记录用量。
     * 出错时按提供商的协议格式返回错误，客户端的 SDK 能直接显示原因。
     */
    public void proxy(Long providerId, String subPath, HttpServletRequest req, HttpServletResponse res, LoginUser user, ItmDevice device) throws Exception
    {
        ItmLlmProvider p = providerId == null ? null : providerMapper.selectItmLlmProviderById(providerId);
        String type = p == null ? "OPENAI" : p.getProviderType();
        if (p == null || !"0".equals(p.getStatus()))
        {
            error(res, type, 404, "not_found_error", "团队模型不存在或已停用，请在设置里重新选择模型");
            return;
        }
        if (!canUse(p, user))
        {
            error(res, type, 403, "permission_error", "你没有使用团队模型「" + p.getProviderName() + "」的权限");
            return;
        }
        String method = req.getMethod();
        if (!("POST".equals(method) && POST_PATHS.matcher(subPath).matches()) && !("GET".equals(method) && GET_PATHS.matcher(subPath).matches()))
        {
            error(res, type, 404, "not_found_error", "不支持的接口：" + method + " " + subPath);
            return;
        }
        String quota = checkQuota(user.getUserId());
        if (quota != null)
        {
            error(res, type, 429, "rate_limit_error", quota);
            return;
        }
        byte[] body = req.getInputStream().readNBytes(MAX_BODY + 1);
        if (body.length > MAX_BODY)
        {
            error(res, type, 413, "invalid_request_error", "请求太大（超过 20MB）");
            return;
        }
        String model = "";
        if (body.length > 0)
        {
            try
            {
                model = objectMapper.readTree(body).path("model").asText("");
            }
            catch (Exception ignored)
            {
                // 不是 JSON：交给上游判断
            }
        }

        String url = p.getBaseUrl() + "/" + subPath + (StringUtils.isNotEmpty(req.getQueryString()) ? "?" + req.getQueryString() : "");
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofMinutes(15));
        for (String h : List.of("content-type", "accept", "anthropic-version", "anthropic-beta"))
        {
            String v = req.getHeader(h);
            if (StringUtils.isNotEmpty(v))
            {
                b.header(h, v);
            }
        }
        auth(b, p.getProviderType(), apiKeyOf(p), StringUtils.isEmpty(req.getHeader("anthropic-version")));
        b.method(method, body.length == 0 ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));

        long t0 = System.currentTimeMillis();
        UsageMeter meter = new UsageMeter(objectMapper);
        int status = 502;
        String err = null;
        try
        {
            HttpResponse<InputStream> up = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
            status = up.statusCode();
            res.setStatus(status);
            String ct = up.headers().firstValue("content-type").orElse("application/json");
            res.setContentType(ct);
            boolean sse = ct.contains("text/event-stream");
            meter.sse = sse;
            if (sse)
            {
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("X-Accel-Buffering", "no");
            }
            byte[] buf = new byte[8192];
            try (InputStream in = up.body())
            {
                OutputStream out = res.getOutputStream();
                for (int n; (n = in.read(buf)) > 0; )
                {
                    out.write(buf, 0, n);
                    if (sse)
                    {
                        out.flush();
                    }
                    meter.feed(buf, n, status / 100 == 2);
                }
                out.flush();
            }
            if (status / 100 != 2)
            {
                err = "HTTP " + status + "：" + meter.errorText();
            }
        }
        catch (java.net.http.HttpTimeoutException e)
        {
            err = "上游超时";
            if (!res.isCommitted())
            {
                error(res, type, 504, "api_error", "团队模型「" + p.getProviderName() + "」响应超时");
            }
        }
        catch (java.io.IOException e)
        {
            // 客户端中途取消（关闭连接）或者连不上上游
            err = res.isCommitted() ? "连接中断：" + e.getMessage() : "连不上上游：" + e.getMessage();
            if (!res.isCommitted())
            {
                error(res, type, 502, "api_error", "连不上团队模型「" + p.getProviderName() + "」的接口：" + e.getMessage());
            }
        }
        finally
        {
            meter.finish();
            record(user, device, p, model, meter, err, System.currentTimeMillis() - t0, body.length);
        }
    }

    private void record(LoginUser user, ItmDevice device, ItmLlmProvider p, String model, UsageMeter m, String err, long ms, int requestBytes)
    {
        try
        {
            boolean estimated = m.input == null && m.output == null;
            int input = m.input != null ? m.input : (err == null ? requestBytes / 4 : 0);
            int output = m.output != null ? m.output : (int) (m.chars / 3);
            ItmLlmUsage u = new ItmLlmUsage();
            u.setUserId(user.getUserId());
            u.setUserName(user.getUsername());
            u.setDeviceId(device == null ? "" : device.getDeviceId());
            u.setProviderId(p.getProviderId());
            u.setProviderName(p.getProviderName());
            u.setModel(StringUtils.substring(model, 0, 100));
            u.setInputTokens(input);
            u.setOutputTokens(output);
            u.setEstimated(estimated && err == null ? "1" : "0");
            u.setStatus(err == null ? "0" : "1");
            u.setError(StringUtils.substring(StringUtils.nvl(err, ""), 0, 500));
            u.setDurationMs((int) Math.min(ms, Integer.MAX_VALUE));
            u.setCreatedAt(new Date());
            usageMapper.insertItmLlmUsage(u);
            if (input + output > 0)
            {
                String key = dailyKey(user.getUserId());
                if (redisCache.hasKey(key))
                {
                    redisCache.redisTemplate.opsForValue().increment(key, input + output);
                }
            }
        }
        catch (Exception e)
        {
            log.warn("记录模型用量失败：{}", e.getMessage());
        }
    }

    private static String dailyKey(Long userId)
    {
        return "itm:llm:tokens:" + userId + ":" + new SimpleDateFormat("yyyyMMdd").format(new Date());
    }

    /** 配额：每分钟请求数、每天 token 数；超出时返回原因 */
    public String checkQuota(Long userId)
    {
        int rpm = intConfig("itm.llm.rpm", 30);
        if (rpm > 0)
        {
            String key = "itm:llm:rpm:" + userId + ":" + (System.currentTimeMillis() / 60_000);
            Long n = redisCache.redisTemplate.opsForValue().increment(key);
            if (n != null && n == 1)
            {
                redisCache.expire(key, 90, TimeUnit.SECONDS);
            }
            if (n != null && n > rpm)
            {
                return "请求太频繁：团队模型每人每分钟最多 " + rpm + " 次，请稍后再试";
            }
        }
        long limit = intConfig("itm.llm.dailyTokenLimit", 0);
        if (limit > 0)
        {
            String key = dailyKey(userId);
            Object cached = redisCache.getCacheObject(key);
            long used;
            if (cached instanceof Number num)
            {
                used = num.longValue();
            }
            else
            {
                Date since = Date.from(LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant());
                Long sum = usageMapper.sumTokensSince(userId, since);
                used = sum == null ? 0 : sum;
                redisCache.setCacheObject(key, used, 2, TimeUnit.DAYS);
            }
            if (used >= limit)
            {
                return "今天的团队模型额度已经用完（每人每天 " + limit + " token），明天恢复；需要更多额度请联系管理员";
            }
        }
        return null;
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

    /** 按协议格式写错误：OpenAI {error: {message, type}}；Anthropic {type: error, error: {type, message}} */
    private void error(HttpServletResponse res, String type, int status, String kind, String message) throws java.io.IOException
    {
        res.setStatus(status);
        res.setContentType("application/json;charset=UTF-8");
        Map<String, Object> body = "ANTHROPIC".equals(type)
            ? Map.of("type", "error", "error", Map.of("type", kind, "message", message))
            : Map.of("error", Map.of("message", message, "type", kind, "code", status));
        res.getOutputStream().write(objectMapper.writeValueAsBytes(body));
    }

    /** 从转发的响应里读出用量（OpenAI / Anthropic，流式和非流式）；上游没有返回用量时按字数估算输出 */
    static final class UsageMeter
    {
        private final ObjectMapper om;
        boolean sse;
        Integer input;
        Integer output;
        long chars;
        private final ByteArrayOutputStream line = new ByteArrayOutputStream();
        private final ByteArrayOutputStream whole = new ByteArrayOutputStream();

        UsageMeter(ObjectMapper om)
        {
            this.om = om;
        }

        void feed(byte[] buf, int n, boolean ok)
        {
            if (!sse || !ok)
            {
                if (whole.size() < 4 * 1024 * 1024)
                {
                    whole.write(buf, 0, Math.min(n, 4 * 1024 * 1024 - whole.size()));
                }
                return;
            }
            for (int i = 0; i < n; i++)
            {
                if (buf[i] == '\n')
                {
                    onLine(line.toString(StandardCharsets.UTF_8));
                    line.reset();
                }
                else if (line.size() < 1024 * 1024)
                {
                    line.write(buf[i]);
                }
            }
        }

        private void onLine(String l)
        {
            if (!l.startsWith("data:"))
            {
                return;
            }
            String json = l.substring(5).trim();
            if (json.isEmpty() || "[DONE]".equals(json))
            {
                return;
            }
            try
            {
                JsonNode node = om.readTree(json);
                usage(node.path("usage"));
                // Anthropic：message_start 里有输入用量，message_delta 里有输出用量
                usage(node.path("message").path("usage"));
                JsonNode delta = node.path("choices").path(0).path("delta");
                chars += delta.path("content").asText("").length() + delta.path("reasoning_content").asText("").length();
                for (JsonNode tc : delta.path("tool_calls"))
                {
                    chars += tc.path("function").path("arguments").asText("").length();
                }
                JsonNode d = node.path("delta");
                chars += d.path("text").asText("").length() + d.path("partial_json").asText("").length() + d.path("thinking").asText("").length();
            }
            catch (Exception ignored)
            {
                // 不是 JSON 的行忽略
            }
        }

        private void usage(JsonNode u)
        {
            if (u.isMissingNode() || u.isNull())
            {
                return;
            }
            if (u.has("prompt_tokens"))
            {
                input = u.path("prompt_tokens").asInt();
            }
            if (u.has("completion_tokens"))
            {
                output = u.path("completion_tokens").asInt();
            }
            if (u.has("input_tokens"))
            {
                input = u.path("input_tokens").asInt() + u.path("cache_read_input_tokens").asInt(0) + u.path("cache_creation_input_tokens").asInt(0);
            }
            if (u.has("output_tokens"))
            {
                output = u.path("output_tokens").asInt();
            }
        }

        void finish()
        {
            if (sse)
            {
                if (line.size() > 0)
                {
                    onLine(line.toString(StandardCharsets.UTF_8));
                }
                return;
            }
            try
            {
                JsonNode node = om.readTree(whole.toByteArray());
                usage(node.path("usage"));
            }
            catch (Exception ignored)
            {
                // 非 JSON 响应
            }
        }

        String errorText()
        {
            return StringUtils.substring(whole.toString(StandardCharsets.UTF_8), 0, 300);
        }
    }
}
