package com.ruoyi.iterminal.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.exception.ServiceException;
import com.sun.net.httpserver.HttpServer;

/** Milvus RESTful v2 客户端：用本机的模拟服务检查请求格式（第三十三轮） */
class ItmMilvusClientTest
{
    private final ObjectMapper json = new ObjectMapper();
    private HttpServer server;
    private final List<String[]> calls = new ArrayList<>();
    private final Set<String> collections = new HashSet<>();
    private String auth;

    @BeforeEach
    void start() throws Exception
    {
        ItmMilvusClient.forget();
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v2/vectordb/", ex -> {
            String path = ex.getRequestURI().getPath().substring("/v2/vectordb".length());
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            auth = ex.getRequestHeaders().getFirst("Authorization");
            calls.add(new String[] { path, body });
            JsonNode b = json.readTree(body);
            String data = switch (path)
            {
                case "/collections/list" -> json.writeValueAsString(collections);
                case "/collections/has" -> "{\"has\":" + collections.contains(b.path("collectionName").asText()) + "}";
                case "/collections/create" -> {
                    collections.add(b.path("collectionName").asText());
                    yield "{}";
                }
                case "/collections/get_stats" -> "{\"rowCount\":3}";
                case "/entities/search" -> "[{\"chunk_id\":7,\"distance\":0.93},{\"chunk_id\":5,\"distance\":0.81}]";
                case "/entities/delete" -> b.path("filter").asText().contains("999") ? null : "{}";
                default -> "{}";
            };
            String out = data == null ? "{\"code\":1100,\"message\":\"invalid filter\"}" : "{\"code\":0,\"data\":" + data + "}";
            byte[] bytes = out.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("Content-Type", "application/json");
            ex.sendResponseHeaders(200, bytes.length);
            ex.getResponseBody().write(bytes);
            ex.close();
        });
        server.start();
    }

    @AfterEach
    void stop()
    {
        server.stop(0);
    }

    private ItmMilvusClient client()
    {
        return new ItmMilvusClient(json, "127.0.0.1:" + server.getAddress().getPort() + "/", "root:Milvus", "kb", "");
    }

    private JsonNode last(String path) throws Exception
    {
        for (int i = calls.size() - 1; i >= 0; i--)
        {
            if (calls.get(i)[0].equals(path))
            {
                return json.readTree(calls.get(i)[1]);
            }
        }
        throw new AssertionError("没有调用 " + path);
    }

    @Test
    void createsCollectionPerDimensionAndUpserts() throws Exception
    {
        ItmMilvusClient m = client();
        m.replaceDocument(2, 10, List.of(5L, 6L), List.of(new float[] { 0.1f, 0.2f, 0.3f }, new float[] { 0.3f, 0.2f, 0.1f }));
        assertEquals("Bearer root:Milvus", auth);
        JsonNode create = last("/collections/create");
        assertEquals("itm_kb_chunks_d3", create.path("collectionName").asText());
        assertEquals("kb", create.path("dbName").asText());
        assertEquals("3", create.at("/schema/fields/3/elementTypeParams/dim").asText());
        assertEquals("COSINE", create.at("/indexParams/0/metricType").asText());
        JsonNode up = last("/entities/upsert");
        assertEquals(2, up.path("data").size());
        assertEquals(6, up.at("/data/1/chunk_id").asLong());
        assertEquals(10, up.at("/data/1/document_id").asLong());
        assertEquals(2, up.at("/data/1/collection_id").asLong());
        assertEquals(3, up.at("/data/0/vector").size());
        // 写入前按文档删除旧向量（已有集合里）
        m.replaceDocument(2, 10, List.of(5L), List.of(new float[] { 1, 0, 0 }));
        assertEquals("document_id == 10", last("/entities/delete").path("filter").asText());
        // 第二次不再建集合
        assertEquals(1, calls.stream().filter(c -> c[0].equals("/collections/create")).count());
    }

    @Test
    void searchFiltersByCollection() throws Exception
    {
        ItmMilvusClient m = client();
        assertEquals(List.of(), m.search(new float[] { 1, 0 }, List.of(1L, 2L), 50));
        collections.add("itm_kb_chunks_d2");
        assertEquals(List.of(7L, 5L), m.search(new float[] { 1, 0 }, List.of(1L, 2L), 50));
        JsonNode s = last("/entities/search");
        assertEquals("collection_id in [1,2]", s.path("filter").asText());
        assertEquals(50, s.path("limit").asInt());
        assertEquals("vector", s.path("annsField").asText());
        assertEquals(2, s.at("/data/0").size());
    }

    @Test
    void errorsAndValidation()
    {
        collections.add("itm_kb_chunks_d2");
        collections.add("other");
        ServiceException e = assertThrows(ServiceException.class, () -> client().deleteWhere("document_id == 999"));
        assertTrue(e.getMessage().contains("1100"), e.getMessage());
        assertEquals(List.of("itm_kb_chunks_d2"), client().ownCollections());
        assertEquals(3L, ((java.util.Map<?, ?>) client().test().get("collections")).get("itm_kb_chunks_d2"));
        assertThrows(ServiceException.class, () -> new ItmMilvusClient(json, "", "", "", ""));
        assertThrows(ServiceException.class, () -> new ItmMilvusClient(json, "http://x:19530", "", "", "bad-name"));
        assertEquals("http://h:19530", ItmMilvusClient.normalizeUrl("http://h:19530/v2/vectordb/"));
        ServiceException down = assertThrows(ServiceException.class, () -> new ItmMilvusClient(json, "http://127.0.0.1:1", "", "", "").ownCollections());
        assertTrue(down.getMessage().startsWith("连接 Milvus 失败"), down.getMessage());
    }
}
