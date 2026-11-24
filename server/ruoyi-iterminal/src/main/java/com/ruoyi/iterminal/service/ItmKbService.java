package com.ruoyi.iterminal.service;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.poi.hwpf.HWPFDocument;
import org.apache.poi.hwpf.extractor.WordExtractor;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.FormulaEvaluator;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import org.apache.poi.xwpf.usermodel.IBodyElement;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.util.HtmlUtils;
import com.ruoyi.common.config.RuoYiConfig;
import com.ruoyi.common.constant.CacheConstants;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.core.redis.RedisCache;
import com.ruoyi.common.exception.ServiceException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.ruoyi.common.utils.StringUtils;
import com.ruoyi.iterminal.config.ItmCrypto;
import com.ruoyi.system.service.ISysConfigService;

/**
 * 知识库（文档二 5.8 的简化版）：上传 Markdown / 文本 / HTML / PDF / Word（.doc / .docx）/ Excel（.xls / .xlsx）/ CSV 等 → 解析纯文本 → 按章节切块 →
 * 写入片段表（MySQL 全文索引，ngram 支持中文）；配置了向量模型（团队模型里 OpenAI 兼容的 embeddings 接口）时再生成向量。
 * 向量存储：默认存在 MySQL、检索时在内存里按余弦相似度（知识库不大时足够）；可以改用 Milvus（第三十三轮），向量同时留一份在 MySQL，
 * 切换存储或 Milvus 数据丢失时直接从 MySQL 同步过去，不用重新生成向量。
 * 检索：关键词（MATCH AGAINST）和向量分别召回，再用 RRF 融合（向量权重 0.7）。
 */
@Service
public class ItmKbService
{
    private static final Logger log = LoggerFactory.getLogger(ItmKbService.class);

    private static final Set<String> TYPES = Set.of("md", "markdown", "txt", "text", "log", "html", "htm", "pdf", "doc", "docx", "xls", "xlsx", "csv", "tsv",
        "json", "yaml", "yml", "xml", "conf", "cfg", "ini", "properties", "sh", "sql");
    /** 上传时的提示 */
    static final String TYPES_HINT = "Word（.doc / .docx）、PDF、Excel（.xls / .xlsx）、CSV、Markdown、文本、HTML，以及 json / yaml / xml / conf / sh / sql 等文本文件";
    /** Excel 每个工作表最多读这么多行 */
    private static final int MAX_SHEET_ROWS = 20000;
    private static final long MAX_FILE = 30L * 1024 * 1024;
    private static final int TARGET = 800;
    private static final int OVERLAP = 100;
    private static final int RECALL = 50;
    private static final double VECTOR_WEIGHT = 0.7;
    /** 每次 embeddings 请求的片段数：阿里百炼（千问 text-embedding-v3 / v4）每批最多 10 条 */
    private static final int EMBED_BATCH = 10;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private ISysConfigService configService;

    @Autowired
    private ItmLlmService llmService;

    @Autowired
    private ItmGrant grant;

    @Autowired
    private RedisCache redisCache;

    @Autowired
    @Qualifier("itmScheduler")
    private ThreadPoolTaskScheduler scheduler;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private ItmCrypto crypto;

    /** Milvus 检索失败后，这个时间之前直接用 MySQL 里的向量（不可达时不要每次检索都等连接超时） */
    private volatile long milvusDownUntil = 0;

    /** 同步向量到 Milvus 的进度（管理页显示） */
    private final Map<String, Object> syncState = new ConcurrentHashMap<>();

    /** 每个知识库的向量缓存；索引或删除后版本号变化，下次检索时重新加载 */
    private final Map<Long, AtomicLong> versions = new ConcurrentHashMap<>();
    private final Map<Long, Vectors> cache = new ConcurrentHashMap<>();

    private record Vectors(long version, long[] ids, float[][] vecs)
    {
    }

    private void bump(Long collectionId)
    {
        versions.computeIfAbsent(collectionId, k -> new AtomicLong()).incrementAndGet();
    }

    // ---------------------------------------------------------------- 知识库

    public List<Map<String, Object>> collections()
    {
        return jdbc.queryForList("select c.*, (select count(*) from itm_kb_document d where d.collection_id = c.collection_id) as documents, "
            + "(select ifnull(sum(chunk_count), 0) from itm_kb_document d where d.collection_id = c.collection_id) as chunks from itm_kb_collection c order by c.collection_id");
    }

    public Map<String, Object> collection(Long id)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_kb_collection where collection_id = ?", id);
        if (rows.isEmpty())
        {
            throw new ServiceException("知识库不存在");
        }
        return rows.get(0);
    }

    public void saveCollection(Map<String, Object> body, String user)
    {
        String name = StringUtils.trim(String.valueOf(body.getOrDefault("collectionName", "")));
        if (StringUtils.isEmpty(name) || "null".equals(name))
        {
            throw new ServiceException("请填写名称");
        }
        String desc = StringUtils.substring(StringUtils.nvl((String) body.get("description"), ""), 0, 500);
        // 可见范围：角色 / 用户 / 组织（第十三轮）
        String roles = ItmGrant.normalizeKeys(body.get("roleKeys"), 500);
        String users = ItmGrant.normalizeIds(body.get("userIds"), 2000);
        String depts = ItmGrant.normalizeIds(body.get("deptIds"), 1000);
        String status = "1".equals(body.get("status")) ? "1" : "0";
        Object id = body.get("collectionId");
        if (id == null)
        {
            jdbc.update("insert into itm_kb_collection (collection_name, description, role_keys, user_ids, dept_ids, status, create_by, create_time) values (?, ?, ?, ?, ?, ?, ?, now())",
                name, desc, roles, users, depts, status, user);
        }
        else
        {
            jdbc.update("update itm_kb_collection set collection_name = ?, description = ?, role_keys = ?, user_ids = ?, dept_ids = ?, status = ?, update_by = ?, update_time = now() where collection_id = ?",
                name, desc, roles, users, depts, status, user, Long.valueOf(String.valueOf(id)));
        }
    }

    public void deleteCollection(Long id)
    {
        for (Map<String, Object> d : jdbc.queryForList("select document_id from itm_kb_document where collection_id = ?", id))
        {
            deleteDocument(((Number) d.get("document_id")).longValue());
        }
        jdbc.update("delete from itm_kb_collection where collection_id = ?", id);
        cache.remove(id);
        milvusDelete("collection_id == " + id);
    }

    // ---------------------------------------------------------------- 文档

    public List<Map<String, Object>> documents(Long collectionId)
    {
        return jdbc.queryForList("select document_id, collection_id, title, file_name, file_type, file_size, status, error, chunk_count, embedded, create_by, create_time, update_time "
            + "from itm_kb_document where collection_id = ? order by document_id desc", collectionId);
    }

    /** 上传文件，异步解析和索引，返回新建的文档 ID */
    public List<Long> upload(Long collectionId, MultipartFile[] files, String user)
    {
        collection(collectionId);
        if (files == null || files.length == 0)
        {
            throw new ServiceException("请选择文件");
        }
        List<Long> ids = new ArrayList<>();
        for (MultipartFile f : files)
        {
            String name = StringUtils.nvl(f.getOriginalFilename(), "未命名").replaceAll("[\\\\/]", "_");
            String ext = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT) : "";
            if (!TYPES.contains(ext))
            {
                throw new ServiceException("不支持的文件类型：" + name + "（支持 " + TYPES_HINT + "）");
            }
            if (f.getSize() > MAX_FILE)
            {
                throw new ServiceException("文件太大：" + name + "（上限 30MB）");
            }
            String rel = "itm/kb/" + collectionId + "/" + UUID.randomUUID() + "." + ext;
            try
            {
                Path target = Path.of(RuoYiConfig.getProfile(), rel);
                Files.createDirectories(target.getParent());
                f.transferTo(target);
            }
            catch (IOException e)
            {
                throw new ServiceException("保存文件失败：" + e.getMessage());
            }
            String title = StringUtils.substring(name.contains(".") ? name.substring(0, name.lastIndexOf('.')) : name, 0, 200);
            Long id = ItmJdbc.insert(jdbc, "insert into itm_kb_document (collection_id, title, file_name, file_type, file_size, file_path, status, create_by, create_time, update_time) values (?, ?, ?, ?, ?, ?, 'PENDING', ?, now(), now())",
                collectionId, title, StringUtils.substring(name, 0, 255), ext, f.getSize(), rel, user);
            ids.add(id);
            scheduler.execute(() -> index(id));
        }
        return ids;
    }

    /** 直接粘贴文字（例如排障复盘），按 Markdown 处理 */
    public Long addText(Long collectionId, String title, String content, String user)
    {
        collection(collectionId);
        if (StringUtils.isEmpty(StringUtils.trim(title)) || StringUtils.isEmpty(StringUtils.trim(content)))
        {
            throw new ServiceException("请填写标题和内容");
        }
        String rel = "itm/kb/" + collectionId + "/" + UUID.randomUUID() + ".md";
        try
        {
            Path target = Path.of(RuoYiConfig.getProfile(), rel);
            Files.createDirectories(target.getParent());
            Files.writeString(target, content, StandardCharsets.UTF_8);
        }
        catch (IOException e)
        {
            throw new ServiceException("保存失败：" + e.getMessage());
        }
        Long id = ItmJdbc.insert(jdbc, "insert into itm_kb_document (collection_id, title, file_name, file_type, file_size, file_path, status, create_by, create_time, update_time) values (?, ?, ?, 'md', ?, ?, 'PENDING', ?, now(), now())",
            collectionId, StringUtils.substring(title.trim(), 0, 200), StringUtils.substring(title.trim(), 0, 250) + ".md", content.getBytes(StandardCharsets.UTF_8).length, rel, user);
        scheduler.execute(() -> index(id));
        return id;
    }

    public void reindex(Long documentId)
    {
        jdbc.update("update itm_kb_document set status = 'PENDING', error = '', update_time = now() where document_id = ?", documentId);
        scheduler.execute(() -> index(documentId));
    }

    public void deleteDocument(Long documentId)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select collection_id, file_path from itm_kb_document where document_id = ?", documentId);
        if (rows.isEmpty())
        {
            return;
        }
        jdbc.update("delete from itm_kb_chunk where document_id = ?", documentId);
        jdbc.update("delete from itm_kb_document where document_id = ?", documentId);
        try
        {
            Files.deleteIfExists(Path.of(RuoYiConfig.getProfile(), String.valueOf(rows.get(0).get("file_path"))));
        }
        catch (IOException ignored)
        {
            // 文件已经不在了
        }
        bump(((Number) rows.get(0).get("collection_id")).longValue());
        milvusDelete("document_id == " + documentId);
    }

    // ---------------------------------------------------------------- 索引

    /** 服务重启时还没索引完的文档重新排队 */
    @EventListener(ApplicationReadyEvent.class)
    public void resumePending()
    {
        try
        {
            List<Long> ids = jdbc.queryForList("select document_id from itm_kb_document where status in ('PENDING', 'INDEXING') order by document_id", Long.class);
            for (Long id : ids)
            {
                scheduler.execute(() -> index(id));
            }
            if (!ids.isEmpty())
            {
                log.info("知识库：{} 个文档重新排队索引", ids.size());
            }
        }
        catch (Exception e)
        {
            // 表还没建（没导入 iterminal.sql）时不影响启动
            log.warn("知识库：恢复索引队列失败：{}", e.getMessage());
        }
    }

    /** 解析 → 切块 → 写片段 → （配置了向量模型时）生成向量 */
    void index(Long documentId)
    {
        List<Map<String, Object>> rows = jdbc.queryForList("select * from itm_kb_document where document_id = ?", documentId);
        if (rows.isEmpty())
        {
            return;
        }
        Map<String, Object> d = rows.get(0);
        Long collectionId = ((Number) d.get("collection_id")).longValue();
        jdbc.update("update itm_kb_document set status = 'INDEXING', error = '', update_time = now() where document_id = ?", documentId);
        try
        {
            byte[] data = Files.readAllBytes(Path.of(RuoYiConfig.getProfile(), String.valueOf(d.get("file_path"))));
            String text = extract(String.valueOf(d.get("file_type")), data);
            List<String[]> chunks = chunk(text);
            if (chunks.isEmpty())
            {
                throw new ServiceException("没有解析出文字（扫描版 PDF 需要先做文字识别）");
            }
            jdbc.update("delete from itm_kb_chunk where document_id = ?", documentId);
            List<Long> ids = new ArrayList<>();
            int seq = 0;
            for (String[] c : chunks)
            {
                ids.add(ItmJdbc.insert(jdbc, "insert into itm_kb_chunk (document_id, collection_id, seq, heading, content) values (?, ?, ?, ?, ?)", documentId, collectionId, seq++, StringUtils.substring(c[0], 0, 300), c[1]));
            }
            String embedError = null;
            boolean embedded = false;
            if (embedConfigured())
            {
                List<float[]> vecs = null;
                try
                {
                    vecs = embedChunks(ids, chunks);
                    embedded = true;
                }
                catch (Exception e)
                {
                    // 向量失败不影响关键词检索
                    embedError = "向量生成失败（只能用关键词检索）：" + StringUtils.nvl(e.getMessage(), e.getClass().getSimpleName());
                }
                ItmMilvusClient milvus = vecs == null ? null : milvus();
                if (milvus != null)
                {
                    try
                    {
                        milvus.replaceDocument(collectionId, documentId, ids, vecs);
                    }
                    catch (Exception e)
                    {
                        embedError = "写入 Milvus 失败（向量已存在 MySQL，修好后在「向量存储」里点同步）：" + StringUtils.nvl(e.getMessage(), e.getClass().getSimpleName());
                    }
                }
            }
            jdbc.update("update itm_kb_document set status = 'INDEXED', chunk_count = ?, embedded = ?, error = ?, update_time = now() where document_id = ?",
                chunks.size(), embedded ? "1" : "0", StringUtils.substring(StringUtils.nvl(embedError, ""), 0, 500), documentId);
        }
        catch (Throwable e)
        {
            // 解析库可能抛 Error（比如畸形文件导致的 StackOverflowError），也要落到 FAILED，不能一直停在“索引中”
            log.warn("知识库文档 {} 索引失败", documentId, e);
            jdbc.update("update itm_kb_document set status = 'FAILED', error = ?, update_time = now() where document_id = ?", StringUtils.substring(StringUtils.nvl(e.getMessage(), e.toString()), 0, 500), documentId);
        }
        finally
        {
            bump(collectionId);
        }
    }

    /** 当前的向量模型配置：source = PROVIDER（团队模型，云端）/ LOCAL（本地向量服务）/ NONE（只用关键词） */
    private record EmbedConf(String source, String providerId, String url, String model)
    {
        boolean on()
        {
            return !"NONE".equals(source);
        }
    }

    private EmbedConf embedConf()
    {
        String provider = StringUtils.trim(StringUtils.nvl(configService.selectConfigByKey("itm.kb.embedProviderId"), ""));
        String url = StringUtils.trim(StringUtils.nvl(configService.selectConfigByKey("itm.kb.embedUrl"), ""));
        String model = StringUtils.trim(StringUtils.nvl(configService.selectConfigByKey("itm.kb.embedModel"), ""));
        String source = model.isEmpty() ? "NONE" : !provider.isEmpty() ? "PROVIDER" : !url.isEmpty() ? "LOCAL" : "NONE";
        return new EmbedConf(source, provider, url, model);
    }

    private boolean embedConfigured()
    {
        return embedConf().on();
    }

    private List<float[]> embed(List<String> texts)
    {
        return embedWith(embedConf(), texts);
    }

    private List<float[]> embedWith(EmbedConf c, List<String> texts)
    {
        return switch (c.source())
        {
            case "PROVIDER" -> llmService.embed(Long.valueOf(c.providerId()), c.model(), texts);
            case "LOCAL" -> llmService.embedLocal(c.url(), c.model(), texts);
            default -> throw new ServiceException("还没有配置向量模型");
        };
    }

    /** 生成并保存（MySQL）所有片段的向量，返回向量（写 Milvus 用） */
    private List<float[]> embedChunks(List<Long> ids, List<String[]> chunks)
    {
        List<float[]> all = new ArrayList<>();
        for (int i = 0; i < ids.size(); i += EMBED_BATCH)
        {
            List<String> batch = new ArrayList<>();
            for (int j = i; j < Math.min(ids.size(), i + EMBED_BATCH); j++)
            {
                batch.add((StringUtils.isEmpty(chunks.get(j)[0]) ? "" : chunks.get(j)[0] + "\n") + chunks.get(j)[1]);
            }
            List<float[]> vecs = embed(batch);
            for (int j = 0; j < vecs.size(); j++)
            {
                jdbc.update("update itm_kb_chunk set embedding = ? where chunk_id = ?", toBytes(vecs.get(j)), ids.get(i + j));
            }
            all.addAll(vecs);
        }
        return all;
    }

    private static byte[] toBytes(float[] v)
    {
        ByteBuffer b = ByteBuffer.allocate(v.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        for (float f : v)
        {
            b.putFloat(f);
        }
        return b.array();
    }

    private static float[] toFloats(byte[] data)
    {
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        float[] v = new float[data.length / 4];
        for (int i = 0; i < v.length; i++)
        {
            v[i] = b.getFloat();
        }
        return v;
    }

    /** 解析成纯文本；Word 的标题和 Markdown 一样用 # 表示层级（切块时按章节） */
    static String extract(String type, byte[] data) throws IOException
    {
        switch (type)
        {
            case "pdf" ->
            {
                try (PDDocument doc = PDDocument.load(data))
                {
                    PDFTextStripper s = new PDFTextStripper();
                    s.setSortByPosition(true);
                    return s.getText(doc);
                }
            }
            case "docx" ->
            {
                try (XWPFDocument doc = new XWPFDocument(new ByteArrayInputStream(data)))
                {
                    StringBuilder sb = new StringBuilder();
                    for (IBodyElement e : doc.getBodyElements())
                    {
                        if (e instanceof XWPFParagraph p)
                        {
                            String style = StringUtils.nvl(p.getStyle(), "");
                            String t = p.getText();
                            java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)^(heading|标题)\\s*(\\d)$").matcher(style.replace("Heading", "heading"));
                            if (m.find() && StringUtils.isNotEmpty(t))
                            {
                                sb.append("#".repeat(Math.min(6, Integer.parseInt(m.group(2))))).append(' ').append(t).append("\n\n");
                            }
                            else if (style.matches("\\d") && StringUtils.isNotEmpty(t))
                            {
                                // 中文 Word 的标题样式 ID 常常是 1、2、3
                                sb.append("#".repeat(Math.min(6, Integer.parseInt(style)))).append(' ').append(t).append("\n\n");
                            }
                            else
                            {
                                sb.append(t).append("\n\n");
                            }
                        }
                        else if (e instanceof XWPFTable t)
                        {
                            for (XWPFTableRow row : t.getRows())
                            {
                                List<String> cells = new ArrayList<>();
                                row.getTableCells().forEach(c -> cells.add(c.getText().replace('\n', ' ')));
                                sb.append("| ").append(String.join(" | ", cells)).append(" |\n");
                            }
                            sb.append('\n');
                        }
                    }
                    return sb.toString();
                }
            }
            case "doc" ->
            {
                // Word 97-2003：段落文字，标题样式和 .docx 一样转成 #
                try (HWPFDocument doc = new HWPFDocument(new ByteArrayInputStream(data)); WordExtractor ex = new WordExtractor(doc))
                {
                    StringBuilder sb = new StringBuilder();
                    for (String p : ex.getParagraphText())
                    {
                        String t = WordExtractor.stripFields(p).replace('\u0007', ' ').strip();
                        if (!t.isEmpty())
                        {
                            sb.append(t).append("\n\n");
                        }
                    }
                    return sb.toString();
                }
            }
            case "xls", "xlsx" ->
            {
                return excel(data);
            }
            case "csv", "tsv" ->
            {
                return table(decode(data), "tsv".equals(type) ? '\t' : ',');
            }
            case "html", "htm" ->
            {
                String html = decode(data);
                html = html.replaceAll("(?is)<(script|style|head)[^>]*>.*?</\\1>", " ");
                // 标题转成 Markdown 的 #，段落和换行保留
                html = html.replaceAll("(?is)<h([1-6])[^>]*>(.*?)</h\\1>", "\n\n$1#HEADING# $2\n\n");
                html = html.replaceAll("(?i)<(br|/p|/div|/li|/tr|/h[1-6])\\s*/?>", "\n");
                html = html.replaceAll("(?s)<[^>]+>", " ");
                html = HtmlUtils.htmlUnescape(html);
                StringBuilder sb = new StringBuilder();
                for (String line : html.split("\n"))
                {
                    java.util.regex.Matcher m = java.util.regex.Pattern.compile("^\\s*([1-6])#HEADING#\\s*(.*)$").matcher(line);
                    sb.append(m.find() ? "#".repeat(Integer.parseInt(m.group(1))) + " " + m.group(2).trim() : line.replaceAll("[ \\t]+", " ").trim()).append('\n');
                }
                return sb.toString();
            }
            default ->
            {
                return decode(data);
            }
        }
    }

    /**
     * Excel：每个工作表一个章节（# 工作表名），第一行非空行当表头，之后每行写成「表头: 值；表头: 值」——
     * 切块后每个片段都带着列名，检索时能对上；公式取计算结果。
     */
    static String excel(byte[] data) throws IOException
    {
        try (Workbook wb = WorkbookFactory.create(new ByteArrayInputStream(data)))
        {
            DataFormatter fmt = new DataFormatter();
            FormulaEvaluator ev = wb.getCreationHelper().createFormulaEvaluator();
            StringBuilder sb = new StringBuilder();
            for (Sheet sheet : wb)
            {
                List<List<String>> rows = new ArrayList<>();
                for (Row row : sheet)
                {
                    if (rows.size() >= MAX_SHEET_ROWS)
                    {
                        break;
                    }
                    List<String> cells = new ArrayList<>();
                    for (int c = 0; c < Math.max(0, row.getLastCellNum()); c++)
                    {
                        Cell cell = row.getCell(c);
                        String v;
                        try
                        {
                            v = cell == null ? "" : fmt.formatCellValue(cell, ev);
                        }
                        catch (RuntimeException e)
                        {
                            // 外部引用等算不出来的公式：用公式本身
                            v = cell.toString();
                        }
                        cells.add(v.replaceAll("\\s+", " ").strip());
                    }
                    if (cells.stream().anyMatch(x -> !x.isEmpty()))
                    {
                        rows.add(cells);
                    }
                }
                if (rows.isEmpty())
                {
                    continue;
                }
                sb.append("# ").append(sheet.getSheetName()).append("\n\n").append(rowsText(rows)).append('\n');
            }
            return sb.toString();
        }
    }

    /** CSV / TSV：和 Excel 一样按「表头: 值」逐行输出（支持双引号包起来的字段） */
    static String table(String text, char sep)
    {
        List<List<String>> rows = new ArrayList<>();
        List<String> cur = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        boolean quoted = false;
        String t = text.replace("\r\n", "\n");
        for (int i = 0; i < t.length() && rows.size() < MAX_SHEET_ROWS; i++)
        {
            char ch = t.charAt(i);
            if (quoted)
            {
                if (ch == '"' && i + 1 < t.length() && t.charAt(i + 1) == '"')
                {
                    cell.append('"');
                    i++;
                }
                else if (ch == '"')
                {
                    quoted = false;
                }
                else
                {
                    cell.append(ch);
                }
            }
            else if (ch == '"' && cell.length() == 0)
            {
                quoted = true;
            }
            else if (ch == sep)
            {
                cur.add(cell.toString().strip());
                cell.setLength(0);
            }
            else if (ch == '\n')
            {
                cur.add(cell.toString().strip());
                cell.setLength(0);
                if (cur.stream().anyMatch(x -> !x.isEmpty()))
                {
                    rows.add(cur);
                }
                cur = new ArrayList<>();
            }
            else
            {
                cell.append(ch);
            }
        }
        cur.add(cell.toString().strip());
        if (cur.stream().anyMatch(x -> !x.isEmpty()))
        {
            rows.add(cur);
        }
        return rowsText(rows);
    }

    /** 第一行当表头，之后每行一段「表头: 值；…」（空值省略）；只有一行时原样输出 */
    private static String rowsText(List<List<String>> rows)
    {
        StringBuilder sb = new StringBuilder();
        List<String> head = rows.get(0);
        if (rows.size() == 1)
        {
            return String.join(" | ", head) + "\n";
        }
        for (int r = 1; r < rows.size(); r++)
        {
            List<String> row = rows.get(r);
            List<String> parts = new ArrayList<>();
            for (int c = 0; c < row.size(); c++)
            {
                if (row.get(c).isEmpty())
                {
                    continue;
                }
                String h = c < head.size() && !head.get(c).isEmpty() ? head.get(c) : "第" + (c + 1) + "列";
                parts.add(h + ": " + row.get(c));
            }
            if (!parts.isEmpty())
            {
                sb.append(String.join("；", parts)).append("\n\n");
            }
        }
        return sb.toString();
    }

    /** UTF-8 解不开时按 GBK（Windows 上的中文文本文件） */
    private static String decode(byte[] data)
    {
        try
        {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(data)).toString().replace("﻿", "");
        }
        catch (CharacterCodingException e)
        {
            return new String(data, Charset.forName("GBK"));
        }
    }

    /**
     * 切块：按 Markdown 标题维护章节路径，章节内按段落累积到约 800 字，超长段落按句子切开；
     * 相邻片段重叠约 100 字（只在同一章节内）。返回 [章节路径, 内容]。
     */
    static List<String[]> chunk(String text)
    {
        List<String[]> out = new ArrayList<>();
        String[] path = new String[7];
        StringBuilder cur = new StringBuilder();
        String heading = "";
        List<String> paras = new ArrayList<>();
        StringBuilder para = new StringBuilder();
        // 先拆成段落（空行分隔），标题单独成段
        for (String raw : text.replace("\r\n", "\n").replace('\r', '\n').split("\n"))
        {
            String line = raw.strip();
            if (line.matches("^#{1,6}\\s+.*"))
            {
                if (para.length() > 0)
                {
                    paras.add(para.toString());
                    para.setLength(0);
                }
                paras.add(line);
            }
            else if (line.isEmpty())
            {
                if (para.length() > 0)
                {
                    paras.add(para.toString());
                    para.setLength(0);
                }
            }
            else
            {
                if (para.length() > 0)
                {
                    para.append('\n');
                }
                para.append(line);
            }
        }
        if (para.length() > 0)
        {
            paras.add(para.toString());
        }
        for (String p : paras)
        {
            java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(#{1,6})\\s+(.*)$").matcher(p);
            if (m.find())
            {
                flush(out, heading, cur);
                cur.setLength(0);
                int level = m.group(1).length();
                path[level] = m.group(2).trim();
                for (int i = level + 1; i < path.length; i++)
                {
                    path[i] = null;
                }
                List<String> parts = new ArrayList<>();
                for (int i = 1; i < path.length; i++)
                {
                    if (path[i] != null)
                    {
                        parts.add(path[i]);
                    }
                }
                heading = String.join(" / ", parts);
                continue;
            }
            for (String piece : splitLong(p))
            {
                if (cur.length() > 0 && cur.length() + piece.length() > TARGET)
                {
                    flush(out, heading, cur);
                    String tail = cur.length() > OVERLAP ? cur.substring(cur.length() - OVERLAP) : "";
                    cur.setLength(0);
                    cur.append(tail);
                }
                if (cur.length() > 0)
                {
                    cur.append("\n\n");
                }
                cur.append(piece);
            }
        }
        flush(out, heading, cur);
        return out;
    }

    private static void flush(List<String[]> out, String heading, StringBuilder cur)
    {
        String c = cur.toString().strip();
        if (c.length() >= 2)
        {
            out.add(new String[] { heading, c });
        }
    }

    /** 超过 1.5 倍目标长度的段落按句子切开 */
    private static List<String> splitLong(String p)
    {
        if (p.length() <= TARGET * 3 / 2)
        {
            return List.of(p);
        }
        List<String> out = new ArrayList<>();
        StringBuilder sb = new StringBuilder();
        for (String s : p.split("(?<=[。！？.!?；;\\n])"))
        {
            if (sb.length() + s.length() > TARGET && sb.length() > 0)
            {
                out.add(sb.toString());
                sb.setLength(0);
            }
            sb.append(s);
            while (sb.length() > TARGET * 2)
            {
                out.add(sb.substring(0, TARGET));
                sb.delete(0, TARGET);
            }
        }
        if (sb.length() > 0)
        {
            out.add(sb.toString());
        }
        return out;
    }

    // ---------------------------------------------------------------- 检索

    /** 这个用户可以检索的知识库（启用的、在可见范围内的：角色 / 用户 / 组织任意一项；管理员全部） */
    public List<Map<String, Object>> visibleCollections(LoginUser user)
    {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> c : jdbc.queryForList("select collection_id, collection_name, description, role_keys, user_ids, dept_ids from itm_kb_collection where status = '0' order by collection_id"))
        {
            if (grant.allowed(user, (String) c.get("role_keys"), (String) c.get("user_ids"), (String) c.get("dept_ids")))
            {
                Map<String, Object> v = new LinkedHashMap<>();
                v.put("id", c.get("collection_id"));
                v.put("name", c.get("collection_name"));
                v.put("description", c.get("description"));
                out.add(v);
            }
        }
        return out;
    }

    /**
     * 混合检索：返回 [{title, section, content, score, source, documentId, chunkId}]，score 归一到 0–1。
     * collectionIds 为空时检索所有可见的知识库；指定了不可见的知识库时忽略。
     */
    public List<Map<String, Object>> search(LoginUser user, String query, List<Long> collectionIds, int topK)
    {
        String q = StringUtils.trim(query);
        if (StringUtils.isEmpty(q))
        {
            throw new ServiceException("请输入检索内容");
        }
        int k = Math.max(1, Math.min(topK, 20));
        Map<Long, String> names = new LinkedHashMap<>();
        for (Map<String, Object> c : visibleCollections(user))
        {
            Long id = ((Number) c.get("id")).longValue();
            if (collectionIds == null || collectionIds.isEmpty() || collectionIds.contains(id))
            {
                names.put(id, String.valueOf(c.get("name")));
            }
        }
        if (names.isEmpty())
        {
            return List.of();
        }
        String in = String.join(",", names.keySet().stream().map(String::valueOf).toList());

        // 关键词召回（ngram 全文索引）；太短的词用 LIKE 兜底。
        // ngram 的自然语言模式把问题拆成两字词再 OR，只沾上一个两字词也算命中，所以再按关键词覆盖率过滤一遍
        List<Long> kw = new ArrayList<>();
        List<String> units = terms(q);
        try
        {
            for (Map<String, Object> r : jdbc.queryForList("select chunk_id, heading, content from itm_kb_chunk where collection_id in (" + in + ") and match(heading, content) against (? in natural language mode) "
                + "order by match(heading, content) against (? in natural language mode) desc limit " + RECALL, q, q))
            {
                if (covered(units, StringUtils.nvl((String) r.get("heading"), "") + "\n" + r.get("content")))
                {
                    kw.add(((Number) r.get("chunk_id")).longValue());
                }
            }
        }
        catch (Exception e)
        {
            log.debug("全文检索失败：{}", e.getMessage());
        }
        if (kw.isEmpty())
        {
            kw.addAll(jdbc.queryForList("select chunk_id from itm_kb_chunk where collection_id in (" + in + ") and (content like ? or heading like ?) limit " + RECALL, Long.class, "%" + q + "%", "%" + q + "%"));
        }

        // 向量召回：配置了 Milvus 用 Milvus，失败或没配置时在内存里算
        List<Long> vec = new ArrayList<>();
        if (embedConfigured())
        {
            try
            {
                float[] qv = embed(List.of(q)).get(0);
                ItmMilvusClient milvus = System.currentTimeMillis() < milvusDownUntil ? null : milvus();
                boolean done = false;
                if (milvus != null)
                {
                    try
                    {
                        vec.addAll(milvus.search(qv, names.keySet(), RECALL));
                        done = true;
                    }
                    catch (Exception e)
                    {
                        milvusDownUntil = System.currentTimeMillis() + 60_000;
                        log.warn("Milvus 检索失败，1 分钟内改用 MySQL 里的向量：{}", e.getMessage());
                    }
                }
                if (!done)
                {
                    vec.addAll(memorySearch(qv, names.keySet()));
                }
            }
            catch (Exception e)
            {
                log.warn("向量检索失败，只用关键词：{}", e.getMessage());
            }
        }

        // RRF 融合：score = w·1/(60+rank_vec) + (1−w)·1/(60+rank_kw)；只有一路时权重为 1
        Map<Long, Double> fused = new HashMap<>();
        double wv = vec.isEmpty() ? 0 : (kw.isEmpty() ? 1 : VECTOR_WEIGHT);
        double wk = 1 - wv;
        for (int i = 0; i < vec.size(); i++)
        {
            fused.merge(vec.get(i), wv / (60 + i + 1), Double::sum);
        }
        for (int i = 0; i < kw.size(); i++)
        {
            fused.merge(kw.get(i), wk / (60 + i + 1), Double::sum);
        }
        List<Map.Entry<Long, Double>> top = fused.entrySet().stream().sorted((a, b) -> Double.compare(b.getValue(), a.getValue())).limit(k).toList();
        if (top.isEmpty())
        {
            return List.of();
        }
        double best = 1.0 / 61;
        String ids = String.join(",", top.stream().map(e -> String.valueOf(e.getKey())).toList());
        Map<Long, Map<String, Object>> rows = new HashMap<>();
        for (Map<String, Object> r : jdbc.queryForList("select c.chunk_id, c.document_id, c.collection_id, c.heading, c.content, d.title from itm_kb_chunk c join itm_kb_document d on d.document_id = c.document_id where c.chunk_id in (" + ids + ")"))
        {
            rows.put(((Number) r.get("chunk_id")).longValue(), r);
        }
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map.Entry<Long, Double> e : top)
        {
            Map<String, Object> r = rows.get(e.getKey());
            if (r == null)
            {
                continue;
            }
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("title", r.get("title"));
            v.put("section", StringUtils.isEmpty((String) r.get("heading")) ? null : r.get("heading"));
            v.put("content", r.get("content"));
            v.put("score", Math.min(1.0, e.getValue() / best));
            v.put("source", names.get(((Number) r.get("collection_id")).longValue()));
            v.put("documentId", r.get("document_id"));
            v.put("chunkId", r.get("chunk_id"));
            out.add(v);
        }
        return out;
    }

    /** 把问题拆成检索单元：英文 / 数字按词，中文按相邻两字（和 ngram 索引一致） */
    static List<String> terms(String query)
    {
        List<String> out = new ArrayList<>();
        for (String w : query.toLowerCase(Locale.ROOT).split("[^\\p{L}\\p{N}_]+"))
        {
            if (w.isEmpty())
            {
                continue;
            }
            // 中英文混写（比如“nginx返回502”）先按字符类别拆开
            for (String part : w.split("(?<=\\p{IsHan})(?=[^\\p{IsHan}])|(?<=[^\\p{IsHan}])(?=\\p{IsHan})"))
            {
                if (part.codePoints().allMatch(c -> Character.UnicodeScript.of(c) == Character.UnicodeScript.HAN))
                {
                    int[] cp = part.codePoints().toArray();
                    if (cp.length == 1)
                    {
                        out.add(part);
                    }
                    for (int i = 0; i + 1 < cp.length; i++)
                    {
                        out.add(new String(cp, i, 2));
                    }
                }
                else if (part.length() >= 2 || part.chars().allMatch(Character::isDigit))
                {
                    out.add(part);
                }
            }
        }
        return out.stream().distinct().toList();
    }

    /** 片段至少包含问题里 20% 的检索单元（至少一个） */
    static boolean covered(List<String> units, String text)
    {
        if (units.isEmpty())
        {
            return true;
        }
        String t = text.toLowerCase(Locale.ROOT);
        long hit = units.stream().filter(t::contains).count();
        return hit >= Math.max(1, Math.ceil(units.size() * 0.2));
    }

    /** 在内存里按余弦相似度召回（向量存在 MySQL） */
    private List<Long> memorySearch(float[] qv, Set<Long> collectionIds)
    {
        List<long[]> scored = new ArrayList<>();
        List<double[]> scores = new ArrayList<>();
        for (Long cid : collectionIds)
        {
            Vectors v = vectors(cid);
            for (int i = 0; i < v.ids().length; i++)
            {
                scored.add(new long[] { v.ids()[i] });
                scores.add(new double[] { cosine(qv, v.vecs()[i]) });
            }
        }
        Integer[] order = new Integer[scored.size()];
        for (int i = 0; i < order.length; i++)
        {
            order[i] = i;
        }
        java.util.Arrays.sort(order, (a, b) -> Double.compare(scores.get(b)[0], scores.get(a)[0]));
        List<Long> out = new ArrayList<>();
        for (int i = 0; i < Math.min(RECALL, order.length); i++)
        {
            out.add(scored.get(order[i])[0]);
        }
        return out;
    }

    private Vectors vectors(Long collectionId)
    {
        long version = versions.computeIfAbsent(collectionId, x -> new AtomicLong()).get();
        Vectors cached = cache.get(collectionId);
        if (cached != null && cached.version() == version)
        {
            return cached;
        }
        List<Map<String, Object>> rows = jdbc.queryForList("select chunk_id, embedding from itm_kb_chunk where collection_id = ? and embedding is not null", collectionId);
        long[] ids = new long[rows.size()];
        float[][] vecs = new float[rows.size()][];
        for (int i = 0; i < rows.size(); i++)
        {
            ids[i] = ((Number) rows.get(i).get("chunk_id")).longValue();
            vecs[i] = toFloats((byte[]) rows.get(i).get("embedding"));
        }
        Vectors v = new Vectors(version, ids, vecs);
        cache.put(collectionId, v);
        return v;
    }

    private static double cosine(float[] a, float[] b)
    {
        if (a.length != b.length)
        {
            return -1;
        }
        double dot = 0;
        double na = 0;
        double nb = 0;
        for (int i = 0; i < a.length; i++)
        {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        return na == 0 || nb == 0 ? 0 : dot / Math.sqrt(na * nb);
    }

    // ---------------------------------------------------------------- 配置

    public Map<String, Object> config()
    {
        EmbedConf c = embedConf();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", c.source());
        out.put("embedProviderId", c.providerId());
        out.put("embedUrl", c.url());
        out.put("embedModel", c.model());
        out.put("providers", jdbc.queryForList("select provider_id as id, provider_name as name, provider_type as type from itm_llm_provider where status = '0' and provider_type != 'ANTHROPIC' order by sort, provider_id"));
        out.put("documents", jdbc.queryForObject("select count(*) from itm_kb_document", Integer.class));
        // 向量存储（第三十三轮）：MYSQL / MILVUS；Milvus 的认证信息不回显，只告诉界面有没有设置
        out.put("vectorStore", vectorStore());
        out.put("milvusUrl", cfg("itm.kb.milvusUrl"));
        out.put("milvusDb", cfg("itm.kb.milvusDb"));
        out.put("milvusCollection", cfg("itm.kb.milvusCollection"));
        out.put("milvusTokenSet", StringUtils.isNotEmpty(cfg("itm.kb.milvusToken")));
        out.put("milvusSync", new LinkedHashMap<>(syncState));
        out.put("types", TYPES_HINT);
        return out;
    }

    // ---------------------------------------------------------------- 向量存储（MySQL / Milvus）

    private String cfg(String key)
    {
        return StringUtils.trim(StringUtils.nvl(configService.selectConfigByKey(key), ""));
    }

    /** MYSQL（默认：向量存在 MySQL、检索时在内存里算）/ MILVUS */
    public String vectorStore()
    {
        return "MILVUS".equalsIgnoreCase(cfg("itm.kb.vectorStore")) ? "MILVUS" : "MYSQL";
    }

    private String milvusToken()
    {
        String enc = cfg("itm.kb.milvusToken");
        if (enc.isEmpty())
        {
            return "";
        }
        try
        {
            return crypto.decrypt(enc, "itm.kb.milvusToken");
        }
        catch (Exception e)
        {
            log.warn("Milvus 认证信息解密失败（换过 itm.data-key？）：{}", e.getMessage());
            return "";
        }
    }

    /** 当前配置的 Milvus；向量存储不是 Milvus 时为 null */
    ItmMilvusClient milvus()
    {
        if (!"MILVUS".equals(vectorStore()) || cfg("itm.kb.milvusUrl").isEmpty())
        {
            return null;
        }
        return new ItmMilvusClient(objectMapper, cfg("itm.kb.milvusUrl"), milvusToken(), cfg("itm.kb.milvusDb"), cfg("itm.kb.milvusCollection"));
    }

    /** 删除文档 / 知识库时同步删掉 Milvus 里的向量；失败只记日志（不影响删除，检索时查不到对应片段会被忽略） */
    private void milvusDelete(String filter)
    {
        ItmMilvusClient m = milvus();
        if (m == null)
        {
            return;
        }
        try
        {
            m.deleteWhere(filter);
        }
        catch (Exception e)
        {
            log.warn("删除 Milvus 里的向量失败（{}）：{}", filter, e.getMessage());
        }
    }

    /** 表单里的 Milvus 配置；token 为空时沿用已保存的 */
    private ItmMilvusClient draftMilvus(String url, String token, String db, String collection)
    {
        String t = StringUtils.isEmpty(StringUtils.trim(token)) ? milvusToken() : token.trim();
        return new ItmMilvusClient(objectMapper, url, t, db, collection);
    }

    /** 测试 Milvus 连接（表单里的配置，不用先保存） */
    public Map<String, Object> testMilvus(String url, String token, String db, String collection)
    {
        return draftMilvus(url, token, db, collection).test();
    }

    /**
     * 保存向量存储配置。切到 Milvus（或者 Milvus 的地址 / 库 / 集合变了）时先测试连接，然后在后台把 MySQL 里已有的向量同步过去；
     * 切回 MySQL 时什么都不用做（向量一直留在 MySQL）。返回是否开始了同步。
     */
    public boolean saveStore(String store, String url, String token, String db, String collection, boolean clearToken, String user)
    {
        String next = "MILVUS".equalsIgnoreCase(StringUtils.trim(store)) ? "MILVUS" : "MYSQL";
        if ("MYSQL".equals(next))
        {
            setConfig("itm.kb.vectorStore", "MYSQL", user);
            return false;
        }
        ItmMilvusClient m = clearToken ? new ItmMilvusClient(objectMapper, url, "", db, collection) : draftMilvus(url, token, db, collection);
        m.test();
        boolean changed = !"MILVUS".equals(vectorStore()) || !m.url().equals(ItmMilvusClient.normalizeUrl(StringUtils.nvl(cfg("itm.kb.milvusUrl"), "x")))
            || !StringUtils.nvl(StringUtils.trim(db), "").equals(cfg("itm.kb.milvusDb")) || !StringUtils.nvl(StringUtils.trim(collection), "").equals(cfg("itm.kb.milvusCollection"));
        setConfig("itm.kb.milvusUrl", m.url(), user);
        setConfig("itm.kb.milvusDb", StringUtils.nvl(StringUtils.trim(db), ""), user);
        setConfig("itm.kb.milvusCollection", StringUtils.nvl(StringUtils.trim(collection), ""), user);
        if (clearToken)
        {
            setConfig("itm.kb.milvusToken", "", user);
        }
        else if (StringUtils.isNotEmpty(StringUtils.trim(token)))
        {
            setConfig("itm.kb.milvusToken", crypto.encrypt(token.trim(), "itm.kb.milvusToken"), user);
        }
        setConfig("itm.kb.vectorStore", "MILVUS", user);
        ItmMilvusClient.forget();
        milvusDownUntil = 0;
        if (changed)
        {
            syncMilvus();
        }
        return changed;
    }

    /** 在后台把 MySQL 里已有的向量全部写到 Milvus（按文档写，写之前删掉这个文档的旧向量）；已经在同步时不重复开始 */
    public synchronized boolean syncMilvus()
    {
        if (Boolean.TRUE.equals(syncState.get("running")))
        {
            return false;
        }
        if (milvus() == null)
        {
            throw new ServiceException("向量存储不是 Milvus");
        }
        List<Long> docs = jdbc.queryForList("select distinct document_id from itm_kb_chunk where embedding is not null order by document_id", Long.class);
        syncState.clear();
        syncState.put("running", true);
        syncState.put("total", docs.size());
        syncState.put("done", 0);
        syncState.put("startedAt", System.currentTimeMillis());
        scheduler.execute(() -> {
            int done = 0;
            try
            {
                ItmMilvusClient m = milvus();
                for (Long d : docs)
                {
                    List<Map<String, Object>> rows = jdbc.queryForList("select chunk_id, collection_id, embedding from itm_kb_chunk where document_id = ? and embedding is not null order by seq", d);
                    if (!rows.isEmpty() && m != null)
                    {
                        List<Long> ids = new ArrayList<>();
                        List<float[]> vecs = new ArrayList<>();
                        for (Map<String, Object> r : rows)
                        {
                            ids.add(((Number) r.get("chunk_id")).longValue());
                            vecs.add(toFloats((byte[]) r.get("embedding")));
                        }
                        m.replaceDocument(((Number) rows.get(0).get("collection_id")).longValue(), d, ids, vecs);
                    }
                    syncState.put("done", ++done);
                }
                log.info("知识库：{} 个文档的向量已同步到 Milvus", done);
            }
            catch (Exception e)
            {
                log.warn("同步向量到 Milvus 失败", e);
                syncState.put("error", StringUtils.substring(StringUtils.nvl(e.getMessage(), e.toString()), 0, 300));
            }
            finally
            {
                syncState.put("running", false);
                syncState.put("finishedAt", System.currentTimeMillis());
            }
        });
        return true;
    }

    /**
     * 检查并整理表单里的向量模型配置：
     * PROVIDER 用团队模型提供商（云端）；LOCAL 用本地向量服务的地址（OpenAI 兼容，只写到端口时补上 /v1）；NONE 只用关键词检索。
     */
    private EmbedConf draftConf(String source, String providerId, String url, String model)
    {
        source = StringUtils.nvl(StringUtils.trim(source), "").toUpperCase(Locale.ROOT);
        providerId = StringUtils.nvl(StringUtils.trim(providerId), "");
        url = StringUtils.nvl(StringUtils.trim(url), "");
        model = StringUtils.nvl(StringUtils.trim(model), "");
        // 旧版界面不传 source：按填了什么判断
        if (source.isEmpty())
        {
            source = !providerId.isEmpty() ? "PROVIDER" : !url.isEmpty() ? "LOCAL" : model.isEmpty() ? "NONE" : "PROVIDER";
        }
        switch (source)
        {
            case "NONE":
                return new EmbedConf("NONE", "", "", "");
            case "PROVIDER":
                if (providerId.isEmpty() || model.isEmpty())
                {
                    throw new ServiceException("请选择团队模型提供商并填写向量模型");
                }
                Integer n = jdbc.queryForObject("select count(*) from itm_llm_provider where provider_id = ? and provider_type != 'ANTHROPIC'", Integer.class, Long.valueOf(providerId));
                if (n == null || n == 0)
                {
                    throw new ServiceException("提供商不存在，或者不支持向量接口（Anthropic 没有 embeddings 接口）");
                }
                return new EmbedConf("PROVIDER", providerId, "", model);
            case "LOCAL":
                if (url.isEmpty() || model.isEmpty())
                {
                    throw new ServiceException("请填写本地向量服务的地址和模型");
                }
                return new EmbedConf("LOCAL", "", normalizeEmbedUrl(url), model);
            default:
                throw new ServiceException("未知的向量模型来源：" + source);
        }
    }

    /** http://127.0.0.1:11434 → http://127.0.0.1:11434/v1；去掉末尾的 / 和 /embeddings */
    static String normalizeEmbedUrl(String url)
    {
        String u = url.trim().replaceAll("/+$", "");
        if (u.endsWith("/embeddings"))
        {
            u = u.substring(0, u.length() - "/embeddings".length());
        }
        URI uri;
        try
        {
            uri = URI.create(u);
        }
        catch (IllegalArgumentException e)
        {
            throw new ServiceException("本地向量服务的地址格式不对：" + url);
        }
        if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme()) || StringUtils.isEmpty(uri.getHost()))
        {
            throw new ServiceException("本地向量服务的地址要以 http:// 或 https:// 开头，例如 http://127.0.0.1:11434/v1");
        }
        return StringUtils.isEmpty(uri.getPath()) ? u + "/v1" : u;
    }

    /**
     * 保存向量模型配置；返回配置是否有变化（换了来源 / 提供商 / 地址 / 模型，已有的向量就不能再用了）。
     * 直接写 sys_config：若依的 updateConfig 会跳过空值，清空配置时写不进去。
     */
    public boolean saveConfig(String source, String providerId, String url, String model, String user)
    {
        EmbedConf next = draftConf(source, providerId, url, model);
        EmbedConf prev = embedConf();
        setConfig("itm.kb.embedProviderId", next.providerId(), user);
        setConfig("itm.kb.embedUrl", next.url(), user);
        setConfig("itm.kb.embedModel", next.model(), user);
        return !next.equals(prev);
    }

    private static final Map<String, String> CONFIG_NAMES = Map.of(
        "itm.kb.embedProviderId", "iTerminal-知识库向量模型提供商",
        "itm.kb.embedUrl", "iTerminal-知识库本地向量服务",
        "itm.kb.embedModel", "iTerminal-知识库向量模型",
        "itm.kb.vectorStore", "iTerminal-知识库向量存储（MYSQL / MILVUS）",
        "itm.kb.milvusUrl", "iTerminal-知识库 Milvus 地址",
        "itm.kb.milvusToken", "iTerminal-知识库 Milvus 认证（加密）",
        "itm.kb.milvusDb", "iTerminal-知识库 Milvus 数据库",
        "itm.kb.milvusCollection", "iTerminal-知识库 Milvus 集合前缀");

    private void setConfig(String key, String value, String user)
    {
        int n = jdbc.update("update sys_config set config_value = ?, update_by = ?, update_time = now() where config_key = ?", value, user, key);
        if (n == 0)
        {
            // 老库没执行升级脚本、缺这个参数：补一条，否则只写进 Redis，重启后就丢了
            jdbc.update("insert into sys_config (config_name, config_key, config_value, config_type, create_by, create_time, remark) values (?, ?, ?, 'Y', ?, now(), '')",
                CONFIG_NAMES.getOrDefault(key, key), key, value, user);
        }
        redisCache.setCacheObject(CacheConstants.SYS_CONFIG_KEY + key, value);
    }

    /**
     * 测试向量模型：生成一条向量，返回维度和耗时。传了表单（model 不为空）时测试表单里的配置，不用先保存；否则测试已保存的配置。
     */
    public Map<String, Object> testEmbedding(String source, String providerId, String url, String model)
    {
        EmbedConf c = StringUtils.isNotEmpty(StringUtils.trim(model)) || "NONE".equalsIgnoreCase(StringUtils.trim(source)) ? draftConf(source, providerId, url, model) : embedConf();
        if (!c.on())
        {
            throw new ServiceException("还没有配置向量模型");
        }
        long t0 = System.currentTimeMillis();
        int dims = embedWith(c, List.of("iTerminal 知识库向量测试")).get(0).length;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("dimensions", dims);
        out.put("elapsedMs", System.currentTimeMillis() - t0);
        out.put("url", c.url());
        return out;
    }

    /** 换了向量模型后：所有文档重新生成向量 */
    public int reindexAll()
    {
        List<Long> ids = jdbc.queryForList("select document_id from itm_kb_document", Long.class);
        ids.forEach(this::reindex);
        return ids.size();
    }
}
