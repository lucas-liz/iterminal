package com.ruoyi.iterminal.service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.ruoyi.common.exception.ServiceException;
import com.ruoyi.common.utils.StringUtils;

/**
 * Milvus 向量库（知识库的向量存储，第三十三轮）：用 Milvus 2.4+ 的 RESTful API v2（/v2/vectordb/...），不引入 SDK。
 * 所有知识库共用一个 Milvus 集合，按向量维度分开：{集合名}_d{维度}（换了维度不同的向量模型时自动用新集合）。
 * 字段：chunk_id（主键，对应 itm_kb_chunk）、collection_id、document_id、vector（COSINE，AUTOINDEX）。
 */
public class ItmMilvusClient
{
    /** 每次写入的条数 */
    private static final int INSERT_BATCH = 200;

    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    /** 已经确认存在（并已加载）的集合，避免每次写入都去查 */
    private static final Set<String> READY = ConcurrentHashMap.newKeySet();

    private final ObjectMapper json;
    private final String url;
    private final String token;
    private final String db;
    private final String base;

    /**
     * @param url Milvus 地址，例如 http://127.0.0.1:19530（Zilliz Cloud 的 Public Endpoint 也可以）
     * @param token 认证：用户名:密码，或者 API Key；没开认证时留空
     * @param db 数据库名，留空用 default
     * @param base 集合名前缀，留空用 itm_kb_chunks
     */
    public ItmMilvusClient(ObjectMapper json, String url, String token, String db, String base)
    {
        this.json = json;
        this.url = normalizeUrl(url);
        this.token = StringUtils.nvl(token, "").trim();
        this.db = StringUtils.isEmpty(StringUtils.trim(db)) ? "default" : db.trim();
        this.base = StringUtils.isEmpty(StringUtils.trim(base)) ? "itm_kb_chunks" : base.trim();
        if (!this.base.matches("[A-Za-z_][A-Za-z0-9_]{0,200}"))
        {
            throw new ServiceException("Milvus 集合名只能用字母、数字和下划线，并且不能以数字开头");
        }
    }

    /** http://host:19530/ → http://host:19530；没写协议时补 http:// */
    static String normalizeUrl(String url)
    {
        String u = StringUtils.nvl(url, "").trim().replaceAll("/+$", "");
        if (u.isEmpty())
        {
            throw new ServiceException("请填写 Milvus 地址，例如 http://127.0.0.1:19530");
        }
        if (!u.matches("(?i)^https?://.*"))
        {
            u = "http://" + u;
        }
        u = u.replaceAll("(?i)/v2/vectordb.*$", "");
        URI uri;
        try
        {
            uri = URI.create(u);
        }
        catch (IllegalArgumentException e)
        {
            throw new ServiceException("Milvus 地址格式不对：" + url);
        }
        if (StringUtils.isEmpty(uri.getHost()))
        {
            throw new ServiceException("Milvus 地址格式不对：" + url);
        }
        return u;
    }

    public String collectionFor(int dim)
    {
        return base + "_d" + dim;
    }

    /** 调用一个接口；Milvus 出错时 HTTP 也是 200，看返回的 code */
    JsonNode call(String path, ObjectNode body)
    {
        body.put("dbName", db);
        try
        {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url + "/v2/vectordb" + path)).timeout(Duration.ofSeconds(60))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
            if (!token.isEmpty())
            {
                b.header("Authorization", "Bearer " + token);
            }
            HttpResponse<String> res = HTTP.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (res.statusCode() == 404)
            {
                throw new ServiceException("Milvus 没有 RESTful v2 接口（需要 Milvus 2.4 以上，地址填 19530 端口）");
            }
            if (res.statusCode() / 100 != 2)
            {
                throw new ServiceException("Milvus 返回 HTTP " + res.statusCode() + "：" + StringUtils.substring(res.body(), 0, 300));
            }
            JsonNode r = json.readTree(res.body());
            int code = r.path("code").asInt(0);
            if (code != 0 && code != 200)
            {
                throw new ServiceException("Milvus 出错（" + code + "）：" + StringUtils.substring(r.path("message").asText(res.body()), 0, 300));
            }
            return r.path("data");
        }
        catch (ServiceException e)
        {
            throw e;
        }
        catch (Exception e)
        {
            throw new ServiceException("连接 Milvus 失败：" + StringUtils.nvl(e.getMessage(), e.getClass().getSimpleName()));
        }
    }

    private ObjectNode body(String collection)
    {
        ObjectNode b = json.createObjectNode();
        if (collection != null)
        {
            b.put("collectionName", collection);
        }
        return b;
    }

    /** 已有的、本插件建的集合（{前缀}_d{维度}） */
    public List<String> ownCollections()
    {
        List<String> out = new ArrayList<>();
        for (JsonNode n : call("/collections/list", body(null)))
        {
            String name = n.asText();
            if (name.matches(java.util.regex.Pattern.quote(base) + "_d\\d+"))
            {
                out.add(name);
            }
        }
        return out;
    }

    public boolean has(String collection)
    {
        return call("/collections/has", body(collection)).path("has").asBoolean(false);
    }

    /** 没有就建集合（带索引，建好自动加载）；有就确保已加载 */
    public void ensure(int dim)
    {
        String c = collectionFor(dim);
        String key = url + "|" + db + "|" + c;
        if (READY.contains(key))
        {
            return;
        }
        if (!has(c))
        {
            ObjectNode b = body(c);
            ObjectNode schema = b.putObject("schema");
            schema.put("autoId", false);
            schema.put("enableDynamicField", false);
            ArrayNode fields = schema.putArray("fields");
            fields.addObject().put("fieldName", "chunk_id").put("dataType", "Int64").put("isPrimary", true);
            fields.addObject().put("fieldName", "collection_id").put("dataType", "Int64");
            fields.addObject().put("fieldName", "document_id").put("dataType", "Int64");
            fields.addObject().put("fieldName", "vector").put("dataType", "FloatVector").putObject("elementTypeParams").put("dim", String.valueOf(dim));
            b.putArray("indexParams").addObject().put("fieldName", "vector").put("indexName", "vector").put("metricType", "COSINE").put("indexType", "AUTOINDEX");
            call("/collections/create", b);
        }
        else
        {
            call("/collections/load", body(c));
        }
        READY.add(key);
    }

    /** 某个文档的向量换成新的：先删旧的再写入 */
    public void replaceDocument(long collectionId, long documentId, List<Long> chunkIds, List<float[]> vectors)
    {
        deleteWhere("document_id == " + documentId);
        insert(collectionId, documentId, chunkIds, vectors);
    }

    public void insert(long collectionId, long documentId, List<Long> chunkIds, List<float[]> vectors)
    {
        if (chunkIds.isEmpty())
        {
            return;
        }
        int dim = vectors.get(0).length;
        ensure(dim);
        String c = collectionFor(dim);
        for (int i = 0; i < chunkIds.size(); i += INSERT_BATCH)
        {
            ObjectNode b = body(c);
            ArrayNode data = b.putArray("data");
            for (int j = i; j < Math.min(chunkIds.size(), i + INSERT_BATCH); j++)
            {
                ObjectNode row = data.addObject();
                row.put("chunk_id", chunkIds.get(j));
                row.put("collection_id", collectionId);
                row.put("document_id", documentId);
                ArrayNode v = row.putArray("vector");
                for (float f : vectors.get(j))
                {
                    v.add(f);
                }
            }
            call("/entities/upsert", b);
        }
    }

    /** 在本插件建的所有集合里按条件删除（文档 / 知识库被删除时） */
    public void deleteWhere(String filter)
    {
        for (String c : ownCollections())
        {
            ObjectNode b = body(c);
            b.put("filter", filter);
            call("/entities/delete", b);
        }
    }

    /** 向量检索：在指定的知识库里找最相似的片段，返回 chunk_id（按相似度从高到低） */
    public List<Long> search(float[] query, Collection<Long> collectionIds, int limit)
    {
        String c = collectionFor(query.length);
        if (!has(c))
        {
            return List.of();
        }
        ensure(query.length);
        ObjectNode b = body(c);
        ArrayNode q = b.putArray("data").addArray();
        for (float f : query)
        {
            q.add(f);
        }
        b.put("annsField", "vector");
        b.put("limit", limit);
        b.put("filter", "collection_id in [" + collectionIds.stream().map(String::valueOf).collect(Collectors.joining(",")) + "]");
        b.putArray("outputFields").add("chunk_id");
        b.putObject("searchParams").put("metricType", "COSINE");
        List<Long> out = new ArrayList<>();
        for (JsonNode hit : call("/entities/search", b))
        {
            JsonNode id = hit.has("chunk_id") ? hit.get("chunk_id") : hit.get("id");
            if (id != null)
            {
                out.add(id.asLong());
            }
        }
        return out;
    }

    /** 测试连接：列出集合，返回本插件集合的条数 */
    public Map<String, Object> test()
    {
        long t0 = System.currentTimeMillis();
        List<String> own = ownCollections();
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> rows = new LinkedHashMap<>();
        for (String c : own)
        {
            rows.put(c, call("/collections/get_stats", body(c)).path("rowCount").asLong(0));
        }
        out.put("collections", rows);
        out.put("elapsedMs", System.currentTimeMillis() - t0);
        out.put("url", url);
        out.put("db", db);
        return out;
    }

    /** 清掉「已确认存在」的缓存（换了配置、删了集合以后） */
    static void forget()
    {
        READY.clear();
    }

    public String url()
    {
        return url;
    }
}
