package com.ruoyi.iterminal.controller.admin;

import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import com.ruoyi.common.annotation.Log;
import com.ruoyi.common.core.controller.BaseController;
import com.ruoyi.common.core.domain.AjaxResult;
import com.ruoyi.common.enums.BusinessType;
import com.ruoyi.iterminal.service.ItmKbService;
import com.ruoyi.system.service.ISysRoleService;

/**
 * 管理后台：知识库（集合、文档上传和索引、检索测试、向量模型配置）
 */
@RestController
@RequestMapping("/iterminal/kb")
public class KbController extends BaseController
{
    @Autowired
    private ItmKbService kb;

    @Autowired
    private ISysRoleService roleService;

    @PreAuthorize("@ss.hasPermi('itm:kb:list')")
    @GetMapping("/collection/list")
    public AjaxResult collections()
    {
        return success(kb.collections());
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:add')")
    @Log(title = "知识库", businessType = BusinessType.INSERT)
    @PostMapping("/collection")
    public AjaxResult addCollection(@RequestBody Map<String, Object> body)
    {
        body.remove("collectionId");
        kb.saveCollection(body, getUsername());
        return success();
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:edit')")
    @Log(title = "知识库", businessType = BusinessType.UPDATE)
    @PutMapping("/collection")
    public AjaxResult editCollection(@RequestBody Map<String, Object> body)
    {
        kb.saveCollection(body, getUsername());
        return success();
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:remove')")
    @Log(title = "知识库", businessType = BusinessType.DELETE)
    @DeleteMapping("/collection/{id}")
    public AjaxResult removeCollection(@PathVariable Long id)
    {
        kb.deleteCollection(id);
        return success();
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:list')")
    @GetMapping("/document/list")
    public AjaxResult documents(@RequestParam Long collectionId)
    {
        return success(kb.documents(collectionId));
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:add')")
    @Log(title = "知识库文档", businessType = BusinessType.INSERT)
    @PostMapping("/document/upload")
    public AjaxResult upload(@RequestParam Long collectionId, @RequestParam("files") MultipartFile[] files)
    {
        return success(kb.upload(collectionId, files, getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:add')")
    @Log(title = "知识库文档", businessType = BusinessType.INSERT)
    @PostMapping("/document/text")
    public AjaxResult addText(@RequestBody Map<String, Object> body)
    {
        return success(kb.addText(Long.valueOf(String.valueOf(body.get("collectionId"))), (String) body.get("title"), (String) body.get("content"), getUsername()));
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:edit')")
    @PutMapping("/document/{id}/reindex")
    public AjaxResult reindex(@PathVariable Long id)
    {
        kb.reindex(id);
        return success();
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:remove')")
    @Log(title = "知识库文档", businessType = BusinessType.DELETE)
    @DeleteMapping("/document/{ids}")
    public AjaxResult removeDocuments(@PathVariable Long[] ids)
    {
        for (Long id : ids)
        {
            kb.deleteDocument(id);
        }
        return success();
    }

    /** 检索测试（按管理员的权限，能检索所有知识库） */
    @PreAuthorize("@ss.hasPermi('itm:kb:list')")
    @PostMapping("/search")
    public AjaxResult search(@RequestBody Map<String, Object> body)
    {
        @SuppressWarnings("unchecked")
        List<Number> ids = (List<Number>) body.getOrDefault("collectionIds", List.of());
        int topK = body.get("topK") instanceof Number n ? n.intValue() : 8;
        return success(kb.search(getLoginUser(), String.valueOf(body.getOrDefault("query", "")), ids.stream().map(Number::longValue).toList(), topK));
    }

    /** 「可见的角色」下拉框 */
    @PreAuthorize("@ss.hasPermi('itm:kb:list')")
    @GetMapping("/roles")
    public AjaxResult roles()
    {
        return success(roleService.selectRoleAll().stream().filter(r -> "0".equals(r.getStatus())).map(r -> Map.of("roleKey", r.getRoleKey(), "roleName", r.getRoleName())).toList());
    }

    @PreAuthorize("@ss.hasPermi('itm:kb:list')")
    @GetMapping("/config")
    public AjaxResult config()
    {
        return success(kb.config());
    }

    /**
     * 修改向量模型配置（写到参数设置里）：{source: PROVIDER / LOCAL / NONE, embedProviderId, embedUrl, embedModel, reindex}。
     * 换了模型时已有的向量不能再用，自动让所有文档重新生成；reindex = true 时没换也重新生成。
     */
    @PreAuthorize("@ss.hasPermi('itm:kb:edit')")
    @Log(title = "知识库向量模型", businessType = BusinessType.UPDATE)
    @PutMapping("/config")
    public AjaxResult saveConfig(@RequestBody Map<String, Object> body)
    {
        boolean changed = kb.saveConfig(str(body, "source"), str(body, "embedProviderId"), str(body, "embedUrl"), str(body, "embedModel"), getUsername());
        int n = changed || Boolean.TRUE.equals(body.get("reindex")) ? kb.reindexAll() : 0;
        return success(Map.of("reindexed", n, "changed", changed));
    }

    /** 测试向量模型：带表单时测试表单里的配置（不用先保存），不带时测试已保存的 */
    @PreAuthorize("@ss.hasPermi('itm:kb:edit')")
    @PostMapping("/config/test")
    public AjaxResult testConfig(@RequestBody(required = false) Map<String, Object> body)
    {
        Map<String, Object> b = body == null ? Map.of() : body;
        return success(kb.testEmbedding(str(b, "source"), str(b, "embedProviderId"), str(b, "embedUrl"), str(b, "embedModel")));
    }

    /**
     * 向量存储（第三十三轮）：{store: MYSQL / MILVUS, milvusUrl, milvusToken, milvusDb, milvusCollection, clearToken}。
     * 切到 Milvus 时先测试连接，再在后台把已有的向量同步过去（不用重新生成向量）。
     */
    @PreAuthorize("@ss.hasPermi('itm:kb:edit')")
    @Log(title = "知识库向量存储", businessType = BusinessType.UPDATE)
    @PutMapping("/config/store")
    public AjaxResult saveStore(@RequestBody Map<String, Object> body)
    {
        boolean syncing = kb.saveStore(str(body, "store"), str(body, "milvusUrl"), str(body, "milvusToken"), str(body, "milvusDb"), str(body, "milvusCollection"),
            Boolean.TRUE.equals(body.get("clearToken")), getUsername());
        return success(Map.of("syncing", syncing));
    }

    /** 测试 Milvus 连接（表单里的配置；认证留空时用已保存的） */
    @PreAuthorize("@ss.hasPermi('itm:kb:edit')")
    @PostMapping("/config/store/test")
    public AjaxResult testStore(@RequestBody Map<String, Object> body)
    {
        return success(kb.testMilvus(str(body, "milvusUrl"), str(body, "milvusToken"), str(body, "milvusDb"), str(body, "milvusCollection")));
    }

    /** 把 MySQL 里的向量重新同步到 Milvus（Milvus 数据丢了、之前写入失败时） */
    @PreAuthorize("@ss.hasPermi('itm:kb:edit')")
    @Log(title = "知识库向量存储", businessType = BusinessType.UPDATE)
    @PostMapping("/config/store/sync")
    public AjaxResult syncStore()
    {
        return success(Map.of("started", kb.syncMilvus()));
    }

    private static String str(Map<String, Object> body, String key)
    {
        Object v = body.get(key);
        return v == null ? "" : String.valueOf(v);
    }
}
