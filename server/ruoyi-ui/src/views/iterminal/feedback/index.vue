<template>
  <div class="app-container">
    <el-alert type="info" :closable="false" class="mb8">
      <template #title>
        用户在客户端「设置 → 问题反馈」提交的描述、截图和自动附带的诊断信息（环境、操作轨迹、错误、日志尾部，已在客户端脱敏）。
        「复制给 AI」可以粘贴给任何 AI 工具分析；「AI 分析」用团队模型分析（默认模型在参数设置 <code>itm.feedback.aiProviderId</code> / <code>itm.feedback.aiModel</code>）。
        是否接受未登录用户的匿名反馈：<code>itm.feedback.allowAnonymous</code>；保留天数：<code>itm.feedback.retentionDays</code>。新反馈的通知在「通知渠道」里订阅「新的问题反馈」。
      </template>
    </el-alert>
    <el-form :model="query" :inline="true">
      <el-form-item label="状态">
        <el-select v-model="query.status" clearable placeholder="全部" style="width: 120px">
          <el-option v-for="d in itm_feedback_status" :key="d.value" :label="d.label" :value="d.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="类型">
        <el-select v-model="query.category" clearable placeholder="全部" style="width: 110px">
          <el-option v-for="d in itm_feedback_category" :key="d.value" :label="d.label" :value="d.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="关键字">
        <el-input v-model="query.keyword" placeholder="编号、标题、描述、提交人" clearable style="width: 220px" @keyup.enter="getList(true)" />
      </el-form-item>
      <el-form-item label="提交时间">
        <el-date-picker v-model="range" type="daterange" value-format="YYYY-MM-DD" range-separator="-" start-placeholder="开始" end-placeholder="结束" style="width: 240px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="Search" @click="getList(true)">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>
    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDelete()" v-hasPermi="['itm:feedback:remove']">删除</el-button>
      </el-col>
      <right-toolbar :search="false" @queryTable="getList"></right-toolbar>
    </el-row>
    <el-table v-loading="loading" :data="list" @selection-change="(rows) => (ids = rows.map((r) => r.feedback_id))" @row-dblclick="openDetail">
      <el-table-column type="selection" width="50" align="center" />
      <el-table-column label="编号" width="80">
        <template #default="scope">#{{ scope.row.feedback_id }}</template>
      </el-table-column>
      <el-table-column label="类型" width="80" align="center">
        <template #default="scope"><dict-tag :options="itm_feedback_category" :value="scope.row.category" /></template>
      </el-table-column>
      <el-table-column label="标题" prop="title" min-width="220" :show-overflow-tooltip="true" />
      <el-table-column label="提交人" min-width="130" :show-overflow-tooltip="true">
        <template #default="scope">
          <span v-if="scope.row.user_name">{{ scope.row.nick_name || scope.row.user_name }}（{{ scope.row.user_name }}）</span>
          <span v-else class="itm-muted">匿名{{ scope.row.contact ? " · " + scope.row.contact : "" }}</span>
        </template>
      </el-table-column>
      <el-table-column label="客户端" min-width="150" :show-overflow-tooltip="true">
        <template #default="scope">{{ scope.row.platform }} v{{ scope.row.client_version }}</template>
      </el-table-column>
      <el-table-column label="附件" width="90" align="center">
        <template #default="scope">
          <el-tooltip v-if="scope.row.image_count" :content="scope.row.image_count + ' 张截图'"><el-icon><Picture /></el-icon></el-tooltip>
          <el-tooltip v-if="scope.row.has_diag === '1'" content="带诊断信息"><el-icon style="margin-left: 6px"><Document /></el-icon></el-tooltip>
          <el-tooltip v-if="scope.row.ai_analyzed_at" content="已 AI 分析"><el-icon style="margin-left: 6px; color: var(--el-color-primary)"><MagicStick /></el-icon></el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="scope"><dict-tag :options="itm_feedback_status" :value="scope.row.status" /></template>
      </el-table-column>
      <el-table-column label="提交时间" width="170">
        <template #default="scope">{{ parseTime(scope.row.create_time) }}</template>
      </el-table-column>
      <el-table-column label="操作" align="center" width="120" class-name="small-padding fixed-width">
        <template #default="scope">
          <el-button link type="primary" icon="View" @click="openDetail(scope.row)" v-hasPermi="['itm:feedback:query']">详情</el-button>
          <el-button link type="danger" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="['itm:feedback:remove']" />
        </template>
      </el-table-column>
    </el-table>
    <pagination v-show="total > 0" :total="total" v-model:page="query.pageNum" v-model:limit="query.pageSize" @pagination="getList" />

    <!-- 详情 -->
    <el-drawer v-model="detailOpen" size="78%" :title="detail ? '#' + detail.feedback_id + ' ' + detail.title : '反馈详情'" destroy-on-close @closed="onClosed">
      <div v-if="detail" v-loading="detailLoading" class="itm-fb">
        <div class="itm-fb-head">
          <dict-tag :options="itm_feedback_category" :value="detail.category" />
          <dict-tag :options="itm_feedback_status" :value="detail.status" />
          <span class="itm-muted">{{ submitter }} · {{ parseTime(detail.create_time) }} · {{ detail.platform }} {{ detail.os_version }} {{ detail.arch }} · v{{ detail.client_version }}</span>
          <span style="flex: 1" />
          <el-button icon="CopyDocument" @click="copyForAi">复制给 AI</el-button>
          <el-dropdown v-if="diagFiles.length" @command="downloadFile">
            <el-button icon="Download">下载诊断包<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item v-for="f in diagFiles" :key="f.file_id" :command="f">{{ f.file_name }}（{{ size(f.size) }}）</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <el-tabs v-model="detailTab">
          <el-tab-pane label="概览" name="overview">
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item label="提交人">{{ submitter }}</el-descriptions-item>
              <el-descriptions-item label="联系方式">{{ detail.contact || "—" }}</el-descriptions-item>
              <el-descriptions-item label="设备">{{ detail.device_id || "—" }}</el-descriptions-item>
              <el-descriptions-item label="IP">{{ detail.ip || "—" }}</el-descriptions-item>
            </el-descriptions>
            <h4>描述</h4>
            <div class="itm-fb-desc">{{ detail.description }}</div>
            <template v-if="images.length">
              <h4>截图（{{ images.length }}）</h4>
              <div class="itm-fb-images">
                <el-image v-for="(src, i) in imageUrls" :key="i" :src="src" :preview-src-list="imageUrls" :initial-index="i" fit="cover" class="itm-fb-image" preview-teleported />
              </div>
            </template>
            <h4>环境</h4>
            <div v-if="envSections.length" class="itm-fb-env">
              <el-descriptions v-for="sec in envSections" :key="sec.name" :title="sec.name" :column="2" border size="small" class="mb8">
                <el-descriptions-item v-for="(v, k) in sec.items" :key="k" :label="k">{{ v }}</el-descriptions-item>
              </el-descriptions>
            </div>
            <el-empty v-else description="没有环境信息" :image-size="50" />
          </el-tab-pane>

          <el-tab-pane :label="'操作轨迹（' + crumbs.length + '）'" name="trail" :disabled="!diag">
            <div class="itm-fb-filter">
              <el-checkbox-group v-model="cats" size="small">
                <el-checkbox-button v-for="c in allCats" :key="c" :value="c">{{ CAT[c] || c }}</el-checkbox-button>
              </el-checkbox-group>
              <el-switch v-model="onlyWarn" active-text="只看警告和错误" />
              <el-input v-model="trailKw" size="small" clearable placeholder="搜索消息" style="width: 200px" />
            </div>
            <el-table :data="trail" size="small" height="calc(100vh - 290px)" :row-class-name="({ row }) => 'lv-' + row.level">
              <el-table-column label="时间" width="150">
                <template #default="scope">
                  <span class="mono">{{ rel(scope.row.t) }}</span>
                  <span class="itm-muted mono" style="margin-left: 6px">{{ clock(scope.row.t) }}</span>
                </template>
              </el-table-column>
              <el-table-column label="分类" width="80">
                <template #default="scope"><el-tag size="small" :type="CAT_TYPE[scope.row.cat] || 'info'" disable-transitions>{{ CAT[scope.row.cat] || scope.row.cat }}</el-tag></template>
              </el-table-column>
              <el-table-column label="级别" width="70">
                <template #default="scope"><span :class="'lv-text-' + scope.row.level">{{ scope.row.level }}</span></template>
              </el-table-column>
              <el-table-column label="消息" min-width="260">
                <template #default="scope">
                  <span class="mono">{{ scope.row.msg }}</span>
                  <div v-if="scope.row.data !== undefined" class="itm-fb-data mono">{{ dataText(scope.row.data) }}</div>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane :label="'错误（' + errors.length + '）'" name="errors" :disabled="!diag">
            <el-empty v-if="!errors.length" description="没有记录到错误" :image-size="50" />
            <div v-for="(e, i) in errors" :key="i" class="itm-fb-error">
              <div class="itm-fb-error-head"><span class="mono">{{ rel(e.t) }}</span><el-tag size="small" type="danger" disable-transitions>{{ CAT[e.cat] || e.cat }}</el-tag><strong>{{ e.msg }}</strong></div>
              <pre v-if="e.data" class="itm-fb-pre">{{ dataText(e.data, true) }}</pre>
            </div>
          </el-tab-pane>

          <el-tab-pane label="日志" name="log" :disabled="!diag">
            <div class="itm-fb-filter">
              <el-input v-model="logKw" size="small" clearable placeholder="只显示包含关键字的行" style="width: 260px" />
              <span class="itm-muted">{{ logLines.length }} 行（日志尾部，最多 300KB）</span>
            </div>
            <pre class="itm-fb-pre itm-fb-log">{{ logLines.join("\n") }}</pre>
          </el-tab-pane>

          <el-tab-pane label="AI 分析" name="ai">
            <div class="itm-fb-filter">
              <el-select v-model="aiProvider" clearable placeholder="默认模型" style="width: 260px" @change="aiModel = ''">
                <el-option v-for="p in providers" :key="p.providerId" :label="p.providerName" :value="p.providerId" />
              </el-select>
              <el-select v-if="aiProvider" v-model="aiModel" clearable placeholder="第一个模型" style="width: 220px">
                <el-option v-for="m in providerModels" :key="m.id" :label="m.displayName || m.id" :value="m.id" />
              </el-select>
              <el-button type="primary" icon="MagicStick" :loading="analyzing" @click="runAnalyze" v-hasPermi="['itm:feedback:analyze']">{{ detail.ai_analysis ? "重新分析" : "AI 分析" }}</el-button>
              <span v-if="detail.ai_analyzed_at" class="itm-muted">{{ detail.ai_model }} · {{ parseTime(detail.ai_analyzed_at) }}</span>
            </div>
            <div v-if="detail.ai_analysis" class="itm-md" v-html="renderMarkdown(detail.ai_analysis)" />
            <el-empty v-else-if="!analyzing" description="还没有分析。分析会把描述、环境、错误、操作轨迹和日志（最多约 6 万字）发给所选的团队模型" :image-size="60" />
          </el-tab-pane>
        </el-tabs>

        <el-divider />
        <el-form label-width="60px" class="itm-fb-handle">
          <el-form-item label="状态">
            <el-radio-group v-model="handle.status">
              <el-radio-button v-for="d in itm_feedback_status" :key="d.value" :value="d.value">{{ d.label }}</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="回复">
            <el-input v-model="handle.reply" type="textarea" :rows="3" maxlength="5000" show-word-limit placeholder="提交人在客户端「我的反馈」里能看到" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :loading="saving" @click="saveHandle" v-hasPermi="['itm:feedback:edit']">保存</el-button>
            <span v-if="detail.handler" class="itm-muted" style="margin-left: 12px">上次处理：{{ detail.handler }} · {{ parseTime(detail.handled_at) }}</span>
          </el-form-item>
        </el-form>
      </div>
    </el-drawer>
  </div>
</template>

<script setup name="ItmFeedback">
import { listFeedback, getFeedback, feedbackFile, feedbackPrompt, updateFeedback, analyzeFeedback, delFeedback, listLlmProvider } from "@/api/iterminal"
import { renderMarkdown } from "@/utils/itmMarkdown"
import { saveAs } from "file-saver"

const { proxy } = getCurrentInstance()
const route = useRoute()
const { itm_feedback_status, itm_feedback_category } = useDict("itm_feedback_status", "itm_feedback_category")

const CAT = { app: "应用", ipc: "调用", event: "状态", ui: "操作", console: "控制台", error: "异常", net: "服务端" }
const CAT_TYPE = { app: "primary", ipc: "info", event: "success", ui: "warning", console: "info", error: "danger", net: "primary" }

const list = ref([])
const total = ref(0)
const loading = ref(false)
const ids = ref([])
const range = ref([])
const query = ref({ pageNum: 1, pageSize: 20, status: undefined, category: undefined, keyword: undefined })

const detailOpen = ref(false)
const detailLoading = ref(false)
const detail = ref(null)
const detailTab = ref("overview")
const imageUrls = ref([])
const cats = ref([])
const onlyWarn = ref(false)
const trailKw = ref("")
const logKw = ref("")
const handle = ref({ status: "NEW", reply: "" })
const saving = ref(false)
const analyzing = ref(false)
const providers = ref([])
const aiProvider = ref(undefined)
const aiModel = ref("")

const size = (n) => (n == null ? "—" : n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB")

function getList(reset) {
  if (reset === true) query.value.pageNum = 1
  loading.value = true
  listFeedback({ ...query.value, beginTime: range.value?.[0], endTime: range.value?.[1] }).then(res => {
    list.value = res.rows || []
    total.value = res.total || 0
  }).finally(() => {
    loading.value = false
  })
}

function resetQuery() {
  range.value = []
  query.value = { pageNum: 1, pageSize: 20, status: undefined, category: undefined, keyword: undefined }
  getList()
}

function handleDelete(row) {
  const del = row ? [row.feedback_id] : ids.value
  proxy.$modal.confirm("删除选中的 " + del.length + " 条反馈？截图和诊断信息一起删除。").then(() => delFeedback(del.join(","))).then(() => {
    proxy.$modal.msgSuccess("删除成功")
    getList()
  }).catch(() => {})
}

// ---------------------------------------------------------------- 详情

const diag = computed(() => detail.value?.diagnostics || null)
const images = computed(() => (detail.value?.files || []).filter((f) => f.kind === "IMAGE"))
const diagFiles = computed(() => (detail.value?.files || []).filter((f) => f.kind !== "IMAGE"))
const submitter = computed(() => {
  const d = detail.value
  if (!d) return ""
  return d.user_name ? (d.nick_name || d.user_name) + "（" + d.user_name + "）" : "匿名"
})
const envSections = computed(() => {
  const env = detail.value?.env || {}
  return Object.entries(env)
    .filter(([, v]) => v && typeof v === "object")
    .map(([name, items]) => ({ name, items: Array.isArray(items) ? Object.fromEntries(items.map((x, i) => [String(i + 1), typeof x === "object" ? JSON.stringify(x) : String(x)])) : Object.fromEntries(Object.entries(items).map(([k, v]) => [k, typeof v === "object" ? JSON.stringify(v) : String(v)])) }))
})
const crumbs = computed(() => (diag.value?.breadcrumbs || []).slice().sort((a, b) => b.t - a.t))
const allCats = computed(() => [...new Set(crumbs.value.map((c) => c.cat))])
const trail = computed(() => {
  const k = trailKw.value.trim().toLowerCase()
  return crumbs.value.filter((c) => (!cats.value.length || cats.value.includes(c.cat)) && (!onlyWarn.value || c.level === "warn" || c.level === "error") && (!k || (c.msg + " " + dataText(c.data)).toLowerCase().includes(k)))
})
const errors = computed(() => (diag.value?.errors || []).slice().sort((a, b) => b.t - a.t))
const logLines = computed(() => {
  const all = String(diag.value?.logTail || "").split("\n")
  const k = logKw.value.trim().toLowerCase()
  return k ? all.filter((l) => l.toLowerCase().includes(k)) : all
})
const providerModels = computed(() => {
  const p = providers.value.find((x) => x.providerId === aiProvider.value)
  try {
    return p ? JSON.parse(p.models || "[]") : []
  } catch {
    return []
  }
})

const base = computed(() => diag.value?.createdAt || (detail.value ? new Date(detail.value.create_time).getTime() : Date.now()))
function rel(t) {
  const s = Math.round((t - base.value) / 1000)
  const a = Math.abs(s)
  const txt = a < 60 ? a + "s" : a < 3600 ? Math.floor(a / 60) + "m" + String(a % 60).padStart(2, "0") + "s" : Math.floor(a / 3600) + "h" + String(Math.floor((a % 3600) / 60)).padStart(2, "0") + "m"
  return (s < 0 ? "-" : "+") + txt
}
const clock = (t) => {
  const d = new Date(t)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":")
}
function dataText(v, pretty) {
  if (v === undefined || v === null) return ""
  if (typeof v === "string") return v
  if (typeof v === "object" && typeof v.stack === "string" && pretty) return v.stack
  try {
    return JSON.stringify(v, null, pretty ? 2 : 0)
  } catch {
    return String(v)
  }
}

function openDetail(row) {
  detailOpen.value = true
  detailTab.value = "overview"
  detailLoading.value = true
  cats.value = []
  onlyWarn.value = false
  trailKw.value = ""
  logKw.value = ""
  getFeedback(row.feedback_id).then(res => {
    detail.value = res.data
    handle.value = { status: res.data.status, reply: res.data.reply || "" }
    loadImages()
  }).finally(() => {
    detailLoading.value = false
  })
}

function loadImages() {
  imageUrls.value.forEach((u) => URL.revokeObjectURL(u))
  imageUrls.value = []
  Promise.all(images.value.map((f) => feedbackFile(f.file_id).then((blob) => URL.createObjectURL(blob)).catch(() => ""))).then((urls) => {
    imageUrls.value = urls.filter(Boolean)
  })
}

function onClosed() {
  imageUrls.value.forEach((u) => URL.revokeObjectURL(u))
  imageUrls.value = []
  detail.value = null
}

function downloadFile(f) {
  feedbackFile(f.file_id).then((blob) => saveAs(blob, "feedback-" + detail.value.feedback_id + "-" + f.file_name))
}

function copyForAi() {
  feedbackPrompt(detail.value.feedback_id).then(res => {
    const text = res.data || ""
    navigator.clipboard.writeText(text).then(
      () => proxy.$modal.msgSuccess("已复制（" + Math.round(text.length / 1000) + "K 字符），可以粘贴给任何 AI 工具分析"),
      () => saveAs(new Blob([text], { type: "text/markdown;charset=utf-8" }), "feedback-" + detail.value.feedback_id + ".md"),
    )
  })
}

function runAnalyze() {
  analyzing.value = true
  analyzeFeedback(detail.value.feedback_id, { providerId: aiProvider.value, model: aiModel.value || undefined }).then(res => {
    detail.value.ai_analysis = res.data.text
    detail.value.ai_model = res.data.model
    detail.value.ai_analyzed_at = new Date()
    proxy.$modal.msgSuccess("分析完成（" + Math.round(res.data.latencyMs / 1000) + " 秒）")
    getList()
  }).finally(() => {
    analyzing.value = false
  })
}

function saveHandle() {
  saving.value = true
  updateFeedback(detail.value.feedback_id, handle.value).then(() => {
    proxy.$modal.msgSuccess("已保存")
    detail.value.status = handle.value.status
    detail.value.reply = handle.value.reply
    getList()
  }).finally(() => {
    saving.value = false
  })
}

listLlmProvider({ pageNum: 1, pageSize: 200, status: "0" }).then(res => {
  providers.value = res.rows || []
}).catch(() => {})
getList()
// 通知里的链接：/iterminal/feedback?id=123 直接打开详情
if (route.query.id) openDetail({ feedback_id: route.query.id })
</script>

<style scoped>
.itm-muted { color: var(--el-text-color-secondary); font-size: 12px; }
.mono { font-family: Menlo, Consolas, monospace; font-size: 12px; }
code { font-family: Menlo, Consolas, monospace; }
.itm-fb { padding: 0 4px; }
.itm-fb-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.itm-fb h4 { margin: 16px 0 8px; }
.itm-fb-desc { white-space: pre-wrap; line-height: 1.7; padding: 10px 12px; background: var(--el-fill-color-light); border-radius: 6px; }
.itm-fb-images { display: flex; flex-wrap: wrap; gap: 10px; }
.itm-fb-image { width: 180px; height: 120px; border-radius: 6px; border: 1px solid var(--el-border-color-lighter); cursor: zoom-in; }
.itm-fb-filter { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
.itm-fb-data { color: var(--el-text-color-secondary); white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow: auto; }
.itm-fb-pre { white-space: pre-wrap; word-break: break-all; font-family: Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; background: var(--el-fill-color-light); padding: 10px 12px; border-radius: 6px; margin: 6px 0 0; }
.itm-fb-log { max-height: calc(100vh - 300px); overflow: auto; }
.itm-fb-error { margin-bottom: 14px; }
.itm-fb-error-head { display: flex; align-items: center; gap: 8px; }
.itm-md { line-height: 1.75; }
.itm-md :deep(h3), .itm-md :deep(h4) { margin: 14px 0 6px; }
.itm-md :deep(pre) { background: var(--el-fill-color-light); padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; font-size: 12px; }
.itm-md :deep(code) { font-family: Menlo, Consolas, monospace; background: var(--el-fill-color-light); padding: 0 4px; border-radius: 3px; }
.itm-md :deep(blockquote) { border-left: 3px solid var(--el-border-color); margin: 6px 0; padding-left: 10px; color: var(--el-text-color-secondary); }
:deep(.lv-error) td { background: var(--el-color-danger-light-9) !important; }
:deep(.lv-warn) td { background: var(--el-color-warning-light-9) !important; }
.lv-text-error { color: var(--el-color-danger); font-weight: 600; }
.lv-text-warn { color: var(--el-color-warning); }
.lv-text-debug { color: var(--el-text-color-secondary); }
</style>
