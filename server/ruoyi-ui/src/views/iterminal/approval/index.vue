<template>
  <div class="app-container">
    <el-form :model="queryParams" ref="queryRef" :inline="true" v-show="showSearch">
      <el-form-item label="任务名称" prop="taskName">
        <el-input v-model="queryParams.taskName" placeholder="任务名称" clearable style="width: 180px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-select v-model="queryParams.status" placeholder="全部" clearable style="width: 120px">
          <el-option v-for="dict in itm_approval_status" :key="dict.value" :label="dict.label" :value="dict.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="申请时间">
        <el-date-picker v-model="dateRange" value-format="YYYY-MM-DD" type="daterange" range-separator="-" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="Search" @click="handleQuery">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-checkbox v-model="autoRefresh" label="每 10 秒自动刷新" />
      </el-col>
      <right-toolbar v-model:showSearch="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <el-table v-loading="loading" :data="list">
      <el-table-column type="expand">
        <template #default="scope">
          <div class="itm-expand">
            <p v-if="reasons(scope.row).length"><b>风险原因：</b>{{ reasons(scope.row).join("；") }}</p>
            <p v-if="scope.row.explanation"><b>Agent 说明：</b>{{ scope.row.explanation }}</p>
            <p><b>执行设备：</b>{{ scope.row.deviceId }}　<b>执行记录：</b>{{ scope.row.runId }}</p>
            <p v-if="scope.row.decideComment"><b>审批意见：</b>{{ scope.row.decideComment }}</p>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="申请时间" width="160">
        <template #default="scope">{{ parseTime(scope.row.createTime) }}</template>
      </el-table-column>
      <el-table-column label="任务" prop="taskName" min-width="140" :show-overflow-tooltip="true" />
      <el-table-column label="主机" prop="hostName" width="140" :show-overflow-tooltip="true" />
      <el-table-column label="命令" min-width="240" :show-overflow-tooltip="true">
        <template #default="scope"><code class="itm-cmd">{{ scope.row.command }}</code></template>
      </el-table-column>
      <el-table-column label="风险" width="90" align="center">
        <template #default="scope"><dict-tag :options="itm_risk_level" :value="scope.row.risk" /></template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="scope"><dict-tag :options="itm_approval_status" :value="scope.row.status" /></template>
      </el-table-column>
      <el-table-column label="处理人 / 过期" width="170">
        <template #default="scope">
          <span v-if="scope.row.status === 'PENDING'" class="itm-muted">{{ parseTime(scope.row.expiresAt, "{m}-{d} {h}:{i}") }} 过期</span>
          <span v-else-if="scope.row.decidedBy">{{ scope.row.decidedBy }} · {{ parseTime(scope.row.decidedAt, "{m}-{d} {h}:{i}") }}</span>
          <span v-else class="itm-muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" align="center" width="150" class-name="small-padding fixed-width">
        <template #default="scope">
          <template v-if="scope.row.status === 'PENDING'">
            <el-button link type="success" icon="Check" @click="handleDecide(scope.row, 'APPROVED')" v-hasPermi="['itm:approval:decide']">批准</el-button>
            <el-button link type="danger" icon="Close" @click="handleDecide(scope.row, 'REJECTED')" v-hasPermi="['itm:approval:decide']">拒绝</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />

    <el-dialog v-model="decideOpen" :title="decideForm.decision === 'APPROVED' ? '批准执行' : '拒绝执行'" width="560px" append-to-body>
      <template v-if="decideRow">
        <p class="itm-muted">{{ decideRow.taskName }} · {{ decideRow.hostName }}</p>
        <pre class="itm-pre">{{ decideRow.command }}</pre>
        <el-alert v-if="decideForm.decision === 'APPROVED' && decideRow.risk === 'L2'" type="warning" :closable="false" show-icon title="这是高危命令，批准后会立即在目标主机上执行。" style="margin: 10px 0" />
        <el-input v-model="decideForm.comment" type="textarea" :rows="3" maxlength="500" show-word-limit :placeholder="decideForm.decision === 'APPROVED' ? '审批意见（可选）' : '拒绝原因（可选，会返回给执行设备）'" />
      </template>
      <template #footer>
        <el-button :type="decideForm.decision === 'APPROVED' ? 'success' : 'danger'" :loading="deciding" @click="submitDecide">{{ decideForm.decision === "APPROVED" ? "批 准" : "拒 绝" }}</el-button>
        <el-button @click="decideOpen = false">取 消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup name="ItmApproval">
import { listApproval, decideApproval } from "@/api/iterminal"

const { proxy } = getCurrentInstance()
const { itm_approval_status, itm_risk_level } = useDict("itm_approval_status", "itm_risk_level")

const list = ref([])
const loading = ref(true)
const showSearch = ref(true)
const total = ref(0)
const dateRange = ref([])
const autoRefresh = ref(true)
const decideOpen = ref(false)
const deciding = ref(false)
const decideRow = ref(null)
const decideForm = ref({ decision: "APPROVED", comment: "" })
const queryParams = ref({ pageNum: 1, pageSize: 10, taskName: undefined, status: "PENDING" })
let timer = null

const reasons = (row) => {
  try {
    const v = JSON.parse(row.reasons || "[]")
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function getList(silent) {
  if (!silent) loading.value = true
  listApproval(proxy.addDateRange(queryParams.value, dateRange.value)).then(res => {
    list.value = res.rows
    total.value = res.total
  }).finally(() => {
    loading.value = false
  })
}

function handleQuery() {
  queryParams.value.pageNum = 1
  getList()
}

function resetQuery() {
  dateRange.value = []
  proxy.resetForm("queryRef")
  queryParams.value.status = "PENDING"
  handleQuery()
}

function handleDecide(row, decision) {
  decideRow.value = row
  decideForm.value = { decision, comment: "" }
  decideOpen.value = true
}

function submitDecide() {
  deciding.value = true
  decideApproval(decideRow.value.approvalId, decideForm.value.decision, decideForm.value.comment).then(() => {
    proxy.$modal.msgSuccess(decideForm.value.decision === "APPROVED" ? "已批准" : "已拒绝")
    decideOpen.value = false
    getList()
  }).catch(() => {
    // 已经被别人处理或过期：刷新列表
    getList()
  }).finally(() => {
    deciding.value = false
  })
}

function startTimer() {
  clearInterval(timer)
  timer = autoRefresh.value ? setInterval(() => !decideOpen.value && getList(true), 10_000) : null
}
watch(autoRefresh, startTimer, { immediate: true })
// 页面被标签页缓存（keep-alive）时：切走停止刷新，切回来立即刷新一次
onActivated(() => {
  startTimer()
  getList(true)
})
onDeactivated(() => clearInterval(timer))
onBeforeUnmount(() => clearInterval(timer))

getList()
</script>

<style scoped>
.itm-cmd {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
.itm-pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
.itm-muted {
  color: var(--el-text-color-secondary);
}
.itm-expand {
  padding: 4px 48px;
  font-size: 13px;
  line-height: 1.8;
}
.itm-expand p {
  margin: 0;
}
</style>
