<template>
  <div class="app-container">
    <el-alert type="info" :closable="false" class="mb8">
      <template #title>
        登录了团队账号的客户端，AI 助手排障时会用「知识库」工具检索这里的文档并注明出处。支持 Word（.doc / .docx）、PDF（需有文字层）、Excel（.xls / .xlsx）、CSV、Markdown、文本、HTML 以及 json / yaml / conf / sh / sql 等文本文件，单个文件不超过 30MB；也可以直接粘贴文字。
        设置了可见范围（角色 / 用户 / 组织，满足任意一项）的知识库只有范围内的人能检索到；不设置时所有人可见。
      </template>
    </el-alert>
    <el-row :gutter="16">
      <!-- 知识库列表 -->
      <el-col :span="7" :xs="24">
        <div class="itm-side-head">
          <span>知识库</span>
          <el-button link type="primary" icon="Plus" @click="handleAddCollection" v-hasPermi="['itm:kb:add']">新增</el-button>
        </div>
        <div v-loading="colLoading" class="itm-cols">
          <div v-for="c in collections" :key="c.collection_id" class="itm-col" :class="{ active: current && current.collection_id === c.collection_id }" @click="select(c)">
            <div class="itm-col-main">
              <div class="itm-col-name">
                <el-icon><Collection /></el-icon>
                <span class="itm-ellipsis">{{ c.collection_name }}</span>
                <el-tooltip v-if="c.role_keys || c.user_ids || c.dept_ids" :content="'可见范围：' + grantText(c, grantOpts)"><el-icon class="itm-lock"><Lock /></el-icon></el-tooltip>
                <el-tag v-if="c.status === '1'" size="small" type="info" disable-transitions>停用</el-tag>
              </div>
              <div class="itm-col-meta">{{ c.documents }} 篇文档 · {{ c.chunks }} 个片段</div>
            </div>
            <span @click.stop>
              <el-dropdown trigger="click" @command="(cmd) => onCollectionCommand(cmd, c)">
                <el-icon class="itm-more"><MoreFilled /></el-icon>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="edit" v-if="checkPermi(['itm:kb:edit'])">修改</el-dropdown-item>
                    <el-dropdown-item command="remove" v-if="checkPermi(['itm:kb:remove'])" divided>删除</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </span>
          </div>
          <el-empty v-if="!colLoading && !collections.length" description="还没有知识库" :image-size="60" />
        </div>

        <div class="itm-embed">
          <div class="itm-side-head">
            <span>向量模型</span>
            <el-button link type="primary" icon="Setting" @click="openConfig" v-hasPermi="['itm:kb:edit']">设置</el-button>
          </div>
          <div v-if="config.source === 'LOCAL'" class="itm-embed-body">
            <el-tag size="small" type="success" disable-transitions>本地</el-tag> <code>{{ config.embedModel }}</code>
            <div class="itm-muted">{{ config.embedUrl }}</div>
          </div>
          <div v-else-if="config.source === 'PROVIDER'" class="itm-embed-body">
            <el-tag size="small" disable-transitions>云端</el-tag> {{ providerName(config.embedProviderId) }} / <code>{{ config.embedModel }}</code>
          </div>
          <div v-else class="itm-embed-body itm-muted">未配置：只用关键词检索。配置后按语义检索，问法和原文不一样也能找到。</div>
        </div>

        <div class="itm-embed">
          <div class="itm-side-head">
            <span>向量存储</span>
            <span>
              <el-button v-if="config.vectorStore === 'MILVUS'" link type="primary" icon="Refresh" :disabled="syncing" @click="doSync" v-hasPermi="['itm:kb:edit']">同步</el-button>
              <el-button link type="primary" icon="Setting" @click="openStore" v-hasPermi="['itm:kb:edit']">设置</el-button>
            </span>
          </div>
          <div v-if="config.vectorStore === 'MILVUS'" class="itm-embed-body">
            <el-tag size="small" type="success" disable-transitions>Milvus</el-tag> <code>{{ config.milvusDb || "default" }}</code>
            <div class="itm-muted">{{ config.milvusUrl }}</div>
            <div v-if="syncing" class="itm-muted">正在同步向量：{{ sync.done || 0 }} / {{ sync.total || 0 }} 篇文档</div>
            <div v-else-if="sync.error" class="itm-sync-err">同步失败：{{ sync.error }}</div>
            <div v-else-if="sync.finishedAt" class="itm-muted">已同步 {{ sync.done }} 篇文档的向量（{{ parseTime(sync.finishedAt) }}）</div>
          </div>
          <div v-else class="itm-embed-body itm-muted">MySQL（默认）：向量存在数据库里，检索时在内存里计算，适合几万个片段以内。文档多时可以改用 Milvus。</div>
        </div>
      </el-col>

      <!-- 文档 -->
      <el-col :span="17" :xs="24">
        <template v-if="current">
          <div class="itm-doc-head">
            <div>
              <div class="itm-doc-title">{{ current.collection_name }}</div>
              <div class="itm-muted" v-if="current.description">{{ current.description }}</div>
            </div>
          </div>
          <el-row :gutter="10" class="mb8">
            <el-col :span="1.5" v-hasPermi="['itm:kb:add']">
              <el-upload :show-file-list="false" multiple :http-request="doUpload" accept=".doc,.docx,.pdf,.xls,.xlsx,.csv,.tsv,.md,.markdown,.txt,.text,.log,.html,.htm,.json,.yaml,.yml,.xml,.conf,.cfg,.ini,.properties,.sh,.sql" :disabled="uploading > 0">
                <el-button type="primary" plain icon="Upload" :loading="uploading > 0">{{ uploading > 0 ? "上传中（" + uploading + "）" : "上传文件" }}</el-button>
              </el-upload>
            </el-col>
            <el-col :span="1.5" v-hasPermi="['itm:kb:add']">
              <el-button type="primary" plain icon="EditPen" @click="openText">粘贴文字</el-button>
            </el-col>
            <el-col :span="1.5">
              <el-button plain icon="Search" @click="openSearch">检索测试</el-button>
            </el-col>
            <el-col :span="1.5" v-hasPermi="['itm:kb:remove']">
              <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDeleteDoc()">删除</el-button>
            </el-col>
            <right-toolbar :search="false" @queryTable="getDocs" />
          </el-row>
          <el-table v-loading="docLoading" :data="docs" @selection-change="(rows) => (ids = rows.map((r) => r.document_id))">
            <el-table-column type="selection" width="50" align="center" />
            <el-table-column label="标题" prop="title" min-width="180" :show-overflow-tooltip="true">
              <template #default="scope">
                {{ scope.row.title }}
                <span class="itm-muted itm-file">{{ scope.row.file_name }}</span>
              </template>
            </el-table-column>
            <el-table-column label="类型" width="70" align="center">
              <template #default="scope">{{ (scope.row.file_type || "").toUpperCase() }}</template>
            </el-table-column>
            <el-table-column label="大小" width="90" align="right">
              <template #default="scope">{{ size(scope.row.file_size) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="110" align="center">
              <template #default="scope">
                <el-tooltip v-if="scope.row.error" :content="scope.row.error" placement="top">
                  <el-tag :type="STATUS[scope.row.status].type" disable-transitions>
                    {{ STATUS[scope.row.status].label }}
                    <el-icon v-if="scope.row.status === 'INDEXED'" class="itm-warn-icon"><Warning /></el-icon>
                  </el-tag>
                </el-tooltip>
                <el-tag v-else :type="(STATUS[scope.row.status] || {}).type" disable-transitions>{{ (STATUS[scope.row.status] || { label: scope.row.status }).label }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="片段" prop="chunk_count" width="70" align="center" />
            <el-table-column label="向量" width="70" align="center">
              <template #default="scope">
                <el-icon v-if="scope.row.embedded === '1'" class="itm-ok"><Check /></el-icon>
                <span v-else class="itm-muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="上传人" prop="create_by" width="100" :show-overflow-tooltip="true" />
            <el-table-column label="更新时间" width="160" align="center">
              <template #default="scope">{{ parseTime(scope.row.update_time) }}</template>
            </el-table-column>
            <el-table-column label="操作" align="center" width="110" class-name="small-padding fixed-width">
              <template #default="scope">
                <el-tooltip content="重新解析和索引" placement="top">
                  <el-button link type="primary" icon="Refresh" :disabled="busy(scope.row)" @click="handleReindex(scope.row)" v-hasPermi="['itm:kb:edit']" />
                </el-tooltip>
                <el-button link type="danger" icon="Delete" @click="handleDeleteDoc(scope.row)" v-hasPermi="['itm:kb:remove']" />
              </template>
            </el-table-column>
          </el-table>
        </template>
        <el-empty v-else description="先在左边新增或选择一个知识库" />
      </el-col>
    </el-row>

    <!-- 知识库 -->
    <el-dialog :title="colTitle" v-model="colOpen" width="520px" append-to-body>
      <el-form ref="colRef" :model="colForm" :rules="colRules" label-width="90px">
        <el-form-item label="名称" prop="collectionName">
          <el-input v-model="colForm.collectionName" maxlength="100" placeholder="例如：运维手册、故障复盘" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="colForm.description" type="textarea" :rows="2" maxlength="500" placeholder="AI 助手会看到这个说明，用来判断要不要检索" />
        </el-form-item>
        <el-form-item label="可见范围">
          <itm-grant-picker v-model:roles="colForm.roleList" v-model:users="colForm.userList" v-model:depts="colForm.deptList" all-text="不选表示所有人可见" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="colForm.status">
            <el-radio value="0">启用</el-radio>
            <el-radio value="1">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="submitCollection">确 定</el-button>
        <el-button @click="colOpen = false">取 消</el-button>
      </template>
    </el-dialog>

    <!-- 粘贴文字 -->
    <el-dialog title="粘贴文字" v-model="textOpen" width="760px" append-to-body>
      <el-form ref="textRef" :model="textForm" :rules="textRules" label-width="60px">
        <el-form-item label="标题" prop="title">
          <el-input v-model="textForm.title" maxlength="200" placeholder="例如：2026-10 订单库主从延迟复盘" />
        </el-form-item>
        <el-form-item label="内容" prop="content">
          <el-input v-model="textForm.content" type="textarea" :rows="14" class="itm-mono" placeholder="按 Markdown 处理：用 # / ## 标题分章节，检索结果会带上章节名" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" :loading="textSaving" @click="submitText">保 存</el-button>
        <el-button @click="textOpen = false">取 消</el-button>
      </template>
    </el-dialog>

    <!-- 检索测试 -->
    <el-drawer v-model="searchOpen" title="检索测试" size="640px" append-to-body>
      <el-form :inline="true" class="itm-search-form" @submit.prevent>
        <el-form-item>
          <el-input v-model="search.query" placeholder="像在客户端里提问一样输入，例如：nginx 502 怎么排查" clearable style="width: 280px" @keyup.enter="doSearch" />
        </el-form-item>
        <el-form-item>
          <el-select v-model="search.collectionIds" multiple collapse-tags placeholder="全部知识库" clearable style="width: 150px">
            <el-option v-for="c in collections" :key="c.collection_id" :label="c.collection_name" :value="c.collection_id" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" icon="Search" :loading="searching" @click="doSearch">检索</el-button>
        </el-form-item>
      </el-form>
      <div class="itm-muted mb8">按你的权限检索（管理员能看到所有知识库），返回前 8 条；客户端用户只能检索到自己角色可见的知识库。</div>
      <div v-for="(h, i) in hits" :key="h.chunkId" class="itm-hit">
        <div class="itm-hit-head">
          <span class="itm-hit-title">{{ i + 1 }}. {{ h.title }}<span v-if="h.section" class="itm-muted"> · {{ h.section }}</span></span>
          <span class="itm-muted">{{ h.source }} · 相关度 {{ (h.score * 100).toFixed(0) }}%</span>
        </div>
        <div class="itm-hit-body">{{ h.content }}</div>
      </div>
      <el-empty v-if="searched && !hits.length" description="没有找到相关内容" :image-size="60" />
    </el-drawer>

    <!-- 向量模型 -->
    <el-dialog title="向量模型" v-model="configOpen" width="600px" append-to-body>
      <el-form :model="configForm" label-width="90px">
        <el-form-item label="来源">
          <el-radio-group v-model="configForm.source" @change="onSourceChange">
            <el-radio-button value="LOCAL">本地向量服务</el-radio-button>
            <el-radio-button value="PROVIDER">云端（团队模型）</el-radio-button>
            <el-radio-button value="NONE">不使用</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="configForm.source === 'LOCAL'">
          <el-form-item label="服务地址">
            <el-input v-model="configForm.embedUrl" placeholder="http://127.0.0.1:11434/v1" />
            <div class="itm-muted itm-tip">和后端部署在一起的 Ollama / TEI / Xinference 等（OpenAI 兼容的 /embeddings 接口），文档内容不出服务器。只写到端口时自动补上 /v1。</div>
          </el-form-item>
          <el-form-item label="模型">
            <el-input v-model="configForm.embedModel" placeholder="bge-m3" />
          </el-form-item>
        </template>
        <template v-else-if="configForm.source === 'PROVIDER'">
          <el-form-item label="提供商">
            <el-select v-model="configForm.embedProviderId" placeholder="选择团队模型提供商" style="width: 100%">
              <el-option v-for="p in config.providers" :key="p.id" :label="p.name" :value="String(p.id)" />
            </el-select>
            <div class="itm-muted itm-tip">从「团队模型」里选 OpenAI 兼容的提供商（调用它的 /embeddings 接口）。DeepSeek、Anthropic 没有向量接口。文档内容会发给这个提供商。</div>
          </el-form-item>
          <el-form-item label="模型">
            <el-input v-model="configForm.embedModel" placeholder="例如千问 text-embedding-v4、豆包 doubao-embedding" />
          </el-form-item>
        </template>
        <div v-else class="itm-muted itm-tip" style="padding-left: 90px">只用关键词检索，任何文字都不会发给向量模型。</div>
        <el-form-item label="" v-if="configForm.source !== 'NONE'">
          <el-checkbox v-model="configForm.reindex">保存后所有文档重新生成向量（换了来源或模型时会自动重新生成）</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :loading="testing" :disabled="configForm.source === 'NONE'" @click="doTest">测 试</el-button>
        <el-button type="primary" :loading="configSaving" @click="submitConfig">保 存</el-button>
        <el-button @click="configOpen = false">取 消</el-button>
      </template>
    </el-dialog>

    <!-- 向量存储 -->
    <el-dialog title="向量存储" v-model="storeOpen" width="600px" append-to-body>
      <el-form :model="storeForm" label-width="90px">
        <el-form-item label="存储">
          <el-radio-group v-model="storeForm.store">
            <el-radio-button value="MYSQL">MySQL（默认）</el-radio-button>
            <el-radio-button value="MILVUS">Milvus 向量库</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="storeForm.store === 'MILVUS'">
          <el-form-item label="地址">
            <el-input v-model="storeForm.milvusUrl" placeholder="http://127.0.0.1:19530" />
            <div class="itm-muted itm-tip">Milvus 2.4 以上（用 RESTful v2 接口，地址就是 19530 端口）；Zilliz Cloud 填 Public Endpoint。</div>
          </el-form-item>
          <el-form-item label="认证">
            <el-input v-model="storeForm.milvusToken" type="password" show-password autocomplete="new-password" :disabled="storeForm.clearToken" :placeholder="config.milvusTokenSet ? '已设置，留空不修改' : '用户名:密码 或 API Key；没开认证时留空'" />
            <el-checkbox v-if="config.milvusTokenSet" v-model="storeForm.clearToken">清除已保存的认证</el-checkbox>
          </el-form-item>
          <el-form-item label="数据库">
            <el-input v-model="storeForm.milvusDb" placeholder="default" />
          </el-form-item>
          <el-form-item label="集合前缀">
            <el-input v-model="storeForm.milvusCollection" placeholder="itm_kb_chunks" />
            <div class="itm-muted itm-tip">实际的集合名带向量维度，例如 itm_kb_chunks_d1024，没有时自动创建（COSINE，AUTOINDEX）。</div>
          </el-form-item>
        </template>
        <div class="itm-muted itm-tip" style="padding-left: 90px">
          向量始终在 MySQL 里留一份：切到 Milvus 时自动把已有的向量同步过去，不用重新生成；切回 MySQL 立即生效。Milvus 出错时检索自动改用 MySQL 里的向量。
        </div>
      </el-form>
      <template #footer>
        <el-button v-if="storeForm.store === 'MILVUS'" :loading="storeTesting" @click="doStoreTest">测 试</el-button>
        <el-button type="primary" :loading="storeSaving" @click="submitStore">保 存</el-button>
        <el-button @click="storeOpen = false">取 消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup name="ItmKb">
import ItmGrantPicker from "@/components/ItmGrantPicker"
import { grantText, loadGrantOptions, splitIds } from "@/utils/itmGrant"
import { listKbCollection, addKbCollection, updateKbCollection, delKbCollection, listKbDocument, uploadKbDocument, addKbText, reindexKbDocument, delKbDocument, searchKb, getKbConfig, saveKbConfig, testKbConfig, saveKbStore, testKbStore, syncKbStore } from "@/api/iterminal"
import { checkPermi } from "@/utils/permission"

const { proxy } = getCurrentInstance()
const STATUS = {
  PENDING: { label: "排队中", type: "info" },
  INDEXING: { label: "索引中", type: "warning" },
  INDEXED: { label: "已索引", type: "success" },
  FAILED: { label: "失败", type: "danger" }
}

const grantOpts = ref({ roles: [], users: [], depts: [] })
const collections = ref([])
const colLoading = ref(true)
const current = ref(null)
const docs = ref([])
const docLoading = ref(false)
const ids = ref([])
const uploading = ref(0)
let timer = null

const colOpen = ref(false)
const colTitle = ref("")
const colForm = ref({})
const colRules = { collectionName: [{ required: true, message: "请填写名称", trigger: "blur" }] }

const textOpen = ref(false)
const textSaving = ref(false)
const textForm = ref({})
const textRules = {
  title: [{ required: true, message: "请填写标题", trigger: "blur" }],
  content: [{ required: true, message: "请填写内容", trigger: "blur" }]
}

const searchOpen = ref(false)
const searching = ref(false)
const searched = ref(false)
const search = ref({ query: "", collectionIds: [] })
const hits = ref([])

const config = ref({ source: "NONE", embedProviderId: "", embedUrl: "", embedModel: "", providers: [], documents: 0 })
const configOpen = ref(false)
const configSaving = ref(false)
const testing = ref(false)
const configForm = ref({})
const storeOpen = ref(false)
const storeSaving = ref(false)
const storeTesting = ref(false)
const storeForm = ref({})
const sync = computed(() => config.value.milvusSync || {})
const syncing = computed(() => !!sync.value.running)
let syncTimer = null
const LOCAL_URL = "http://127.0.0.1:11434/v1"
const LOCAL_MODEL = "bge-m3"

const providerName = (id) => (config.value.providers.find((p) => String(p.id) === String(id)) || { name: "提供商 " + id }).name
const busy = (d) => d.status === "PENDING" || d.status === "INDEXING"
const size = (n) => (n == null ? "" : n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB")

function getCollections() {
  colLoading.value = true
  return listKbCollection().then(res => {
    collections.value = res.data || []
    colLoading.value = false
    if (current.value) current.value = collections.value.find((c) => c.collection_id === current.value.collection_id) || null
    if (!current.value && collections.value.length) select(collections.value[0])
  }).catch(() => {
    colLoading.value = false
  })
}

function select(c) {
  if (current.value && current.value.collection_id === c.collection_id) return
  current.value = c
  docs.value = []
  getDocs()
}

function getDocs(silent) {
  if (!current.value) return
  clearTimeout(timer)
  const id = current.value.collection_id
  if (!silent) docLoading.value = true
  listKbDocument(id).then(res => {
    if (!current.value || current.value.collection_id !== id) return
    const before = docs.value.filter(busy).length
    docs.value = res.data || []
    docLoading.value = false
    const after = docs.value.filter(busy).length
    // 还有文档在排队 / 索引时，隔一会儿刷新一次
    if (after > 0) timer = setTimeout(() => getDocs(true), 1500)
    if (before !== after) refreshCounts()
  }).catch(() => {
    docLoading.value = false
  })
}

function refreshCounts() {
  listKbCollection().then(res => {
    for (const c of res.data || []) {
      const old = collections.value.find((x) => x.collection_id === c.collection_id)
      if (old) Object.assign(old, { documents: c.documents, chunks: c.chunks })
    }
  })
}

function handleAddCollection() {
  colForm.value = { collectionId: undefined, collectionName: "", description: "", roleList: [], userList: [], deptList: [], status: "0" }
  colTitle.value = "新增知识库"
  colOpen.value = true
  proxy.resetForm("colRef")
}

function onCollectionCommand(cmd, c) {
  if (cmd === "edit") {
    colForm.value = { collectionId: c.collection_id, collectionName: c.collection_name, description: c.description, roleList: splitIds(c.role_keys), userList: splitIds(c.user_ids), deptList: splitIds(c.dept_ids), status: c.status }
    colTitle.value = "修改知识库"
    colOpen.value = true
  } else if (cmd === "remove") {
    proxy.$modal.confirm("确认删除知识库「" + c.collection_name + "」？里面的 " + c.documents + " 篇文档和片段会一起删除。").then(() => delKbCollection(c.collection_id)).then(() => {
      proxy.$modal.msgSuccess("删除成功")
      if (current.value && current.value.collection_id === c.collection_id) current.value = null
      getCollections()
    }).catch(() => {})
  }
}

function submitCollection() {
  proxy.$refs["colRef"].validate(valid => {
    if (!valid) return
    const body = { collectionId: colForm.value.collectionId, collectionName: colForm.value.collectionName, description: colForm.value.description, roleKeys: colForm.value.roleList.join(","), userIds: colForm.value.userList.join(","), deptIds: colForm.value.deptList.join(","), status: colForm.value.status }
    const req = body.collectionId ? updateKbCollection(body) : addKbCollection(body)
    req.then(() => {
      proxy.$modal.msgSuccess("保存成功")
      colOpen.value = false
      getCollections()
    })
  })
}

// el-upload 选多个文件时每个文件调用一次
function doUpload(opt) {
  const form = new FormData()
  form.append("collectionId", current.value.collection_id)
  form.append("files", opt.file)
  uploading.value++
  return uploadKbDocument(form).then(() => {
    getDocs(true)
  }).finally(() => {
    uploading.value--
    if (uploading.value === 0) refreshCounts()
  })
}

function openText() {
  textForm.value = { title: "", content: "" }
  textOpen.value = true
  proxy.resetForm("textRef")
}

function submitText() {
  proxy.$refs["textRef"].validate(valid => {
    if (!valid) return
    textSaving.value = true
    addKbText({ collectionId: current.value.collection_id, ...textForm.value }).then(() => {
      proxy.$modal.msgSuccess("已保存，正在索引")
      textOpen.value = false
      getDocs(true)
    }).finally(() => {
      textSaving.value = false
    })
  })
}

function handleReindex(row) {
  reindexKbDocument(row.document_id).then(() => {
    row.status = "PENDING"
    getDocs(true)
  })
}

function handleDeleteDoc(row) {
  const target = row ? [row.document_id] : ids.value
  proxy.$modal.confirm("确认删除选中的 " + target.length + " 篇文档？").then(() => delKbDocument(target.join(","))).then(() => {
    proxy.$modal.msgSuccess("删除成功")
    getDocs()
    refreshCounts()
  }).catch(() => {})
}

function openSearch() {
  search.value.collectionIds = current.value ? [current.value.collection_id] : []
  searchOpen.value = true
}

function doSearch() {
  if (!search.value.query.trim()) return
  searching.value = true
  searchKb({ query: search.value.query, collectionIds: search.value.collectionIds, topK: 8 }).then(res => {
    hits.value = res.data || []
    searched.value = true
  }).finally(() => {
    searching.value = false
  })
}

function loadConfig() {
  return getKbConfig().then(res => {
    config.value = res.data
    // 正在同步到 Milvus：隔两秒刷新进度
    clearTimeout(syncTimer)
    if (res.data.milvusSync && res.data.milvusSync.running) syncTimer = setTimeout(loadConfig, 2000)
  })
}

function openStore() {
  loadConfig().then(() => {
    const c = config.value
    storeForm.value = { store: c.vectorStore || "MYSQL", milvusUrl: c.milvusUrl || "http://127.0.0.1:19530", milvusToken: "", milvusDb: c.milvusDb || "", milvusCollection: c.milvusCollection || "", clearToken: false }
    storeOpen.value = true
  })
}

function storeBody() {
  const f = storeForm.value
  return { store: f.store, milvusUrl: (f.milvusUrl || "").trim(), milvusToken: f.clearToken ? "" : f.milvusToken || "", milvusDb: (f.milvusDb || "").trim(), milvusCollection: (f.milvusCollection || "").trim(), clearToken: !!f.clearToken }
}

function doStoreTest() {
  storeTesting.value = true
  testKbStore(storeBody()).then(res => {
    const cols = Object.entries(res.data.collections || {})
    proxy.$modal.msgSuccess("Milvus 连接正常（" + res.data.elapsedMs + " ms）" + (cols.length ? "，已有集合：" + cols.map(([k, v]) => k + " " + v + " 条").join("，") : "，还没有知识库的集合（保存后自动创建）"))
  }).finally(() => {
    storeTesting.value = false
  })
}

function submitStore() {
  storeSaving.value = true
  saveKbStore(storeBody()).then(res => {
    proxy.$modal.msgSuccess(res.data.syncing ? "已保存，正在把已有的向量同步到 Milvus" : "已保存")
    storeOpen.value = false
    return loadConfig()
  }).finally(() => {
    storeSaving.value = false
  })
}

function doSync() {
  proxy.$modal.confirm("把 MySQL 里所有文档的向量重新写到 Milvus？（Milvus 数据丢失、之前写入失败时使用，不会重新生成向量）").then(() => syncKbStore()).then(res => {
    proxy.$modal.msgSuccess(res.data.started ? "开始同步" : "已经在同步了")
    loadConfig()
  }).catch(() => {})
}

function openConfig() {
  loadConfig().then(() => {
    const c = config.value
    // 还没配置过时默认选本地，填好 Ollama 的默认地址和 bge-m3
    const source = c.source === "NONE" && !c.embedModel ? "LOCAL" : c.source
    configForm.value = {
      source,
      embedProviderId: c.embedProviderId || "",
      embedUrl: c.embedUrl || (source === "LOCAL" ? LOCAL_URL : ""),
      embedModel: c.embedModel || (source === "LOCAL" ? LOCAL_MODEL : ""),
      reindex: false
    }
    configOpen.value = true
  })
}

// 切换来源时换上对应的默认值，不把本地的模型名带到云端（反过来也一样）
function onSourceChange(source) {
  const f = configForm.value
  const c = config.value
  if (source === "LOCAL") {
    f.embedUrl = c.embedUrl || LOCAL_URL
    f.embedModel = c.source === "LOCAL" ? c.embedModel : LOCAL_MODEL
  } else if (source === "PROVIDER") {
    f.embedProviderId = c.embedProviderId || (c.providers.length ? String(c.providers[0].id) : "")
    f.embedModel = c.source === "PROVIDER" ? c.embedModel : ""
  }
}

function configBody() {
  const f = configForm.value
  return {
    source: f.source,
    embedProviderId: f.source === "PROVIDER" ? f.embedProviderId || "" : "",
    embedUrl: f.source === "LOCAL" ? (f.embedUrl || "").trim() : "",
    embedModel: f.source === "NONE" ? "" : (f.embedModel || "").trim()
  }
}

function submitConfig() {
  configSaving.value = true
  saveKbConfig({ ...configBody(), reindex: configForm.value.reindex }).then(res => {
    proxy.$modal.msgSuccess(res.data.reindexed ? "已保存，" + res.data.reindexed + " 篇文档正在重新生成向量" : "已保存")
    configOpen.value = false
    return loadConfig()
  }).then(() => {
    getDocs(true)
  }).finally(() => {
    configSaving.value = false
  })
}

function doTest() {
  testing.value = true
  testKbConfig(configBody()).then(res => {
    proxy.$modal.msgSuccess("向量接口正常：维度 " + res.data.dimensions + "，耗时 " + res.data.elapsedMs + " ms")
  }).finally(() => {
    testing.value = false
  })
}

onBeforeUnmount(() => {
  clearTimeout(timer)
  clearTimeout(syncTimer)
})

loadGrantOptions().then((o) => (grantOpts.value = o)).catch(() => {})
loadConfig()
getCollections()
</script>

<style scoped>
.itm-side-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 8px;
}
.itm-cols {
  min-height: 80px;
}
.itm-col {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
}
.itm-col:hover,
.itm-col.active {
  background: var(--el-fill-color-light);
}
.itm-col.active .itm-col-name {
  color: var(--el-color-primary);
}
.itm-col-main {
  min-width: 0;
  flex: 1;
}
.itm-col-name {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
}
.itm-ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.itm-col-meta {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin: 2px 0 0 18px;
}
.itm-lock {
  color: var(--el-color-warning);
}
.itm-more {
  cursor: pointer;
  color: var(--el-text-color-secondary);
}
.itm-embed {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}
.itm-embed-body {
  font-size: 13px;
  line-height: 1.6;
}
.itm-muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.itm-tip {
  line-height: 1.5;
  margin-top: 4px;
}
.itm-doc-head {
  margin-bottom: 10px;
}
.itm-doc-title {
  font-size: 16px;
  font-weight: 600;
}
.itm-file {
  margin-left: 6px;
}
.itm-ok {
  color: var(--el-color-success);
}
.itm-sync-err {
  font-size: 12px;
  color: var(--el-color-danger);
  word-break: break-all;
}
.itm-warn-icon {
  margin-left: 2px;
  vertical-align: -2px;
  color: var(--el-color-warning);
}
.itm-search-form .el-form-item {
  margin-right: 10px;
}
.itm-hit {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.itm-hit-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.itm-hit-title {
  font-weight: 600;
  font-size: 14px;
}
.itm-hit-body {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.6;
  max-height: 180px;
  overflow: auto;
  color: var(--el-text-color-regular);
}
.itm-mono :deep(textarea) {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
