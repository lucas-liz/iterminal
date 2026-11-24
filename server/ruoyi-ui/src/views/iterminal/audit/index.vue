<template>
  <div class="app-container">
    <el-form :model="queryParams" ref="queryRef" :inline="true" v-show="showSearch">
      <el-form-item label="类型" prop="kind">
        <el-select v-model="queryParams.kind" placeholder="全部" clearable style="width: 110px">
          <el-option label="命令" value="COMMAND" />
          <el-option label="安全事件" value="EVENT" />
        </el-select>
      </el-form-item>
      <el-form-item label="来源" prop="source">
        <el-select v-model="queryParams.source" placeholder="全部" clearable style="width: 120px">
          <el-option v-for="dict in itm_audit_source" :key="dict.value" :label="dict.label" :value="dict.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="用户" prop="userName">
        <el-input v-model="queryParams.userName" placeholder="用户账号" clearable style="width: 140px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="主机" prop="hostName">
        <el-input v-model="queryParams.hostName" placeholder="主机名称" clearable style="width: 140px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="命令" prop="command">
        <el-input v-model="queryParams.command" placeholder="包含的内容" clearable style="width: 180px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="风险" prop="risk">
        <el-select v-model="queryParams.risk" placeholder="全部" clearable style="width: 110px">
          <el-option v-for="dict in itm_risk_level" :key="dict.value" :label="dict.label" :value="dict.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="时间">
        <el-date-picker v-model="dateRange" value-format="YYYY-MM-DD" type="daterange" range-separator="-" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="Search" @click="handleQuery">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="warning" plain icon="Download" @click="handleExport" v-hasPermi="['itm:audit:export']">导出</el-button>
      </el-col>
      <right-toolbar v-model:showSearch="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <el-table v-loading="loading" :data="list" @row-click="showDetail" row-class-name="clickable-row">
      <el-table-column label="时间" width="160">
        <template #default="scope">{{ parseTime(scope.row.occurredAt) }}</template>
      </el-table-column>
      <el-table-column label="用户" prop="userName" width="100" />
      <el-table-column label="来源" width="100">
        <template #default="scope"><dict-tag :options="itm_audit_source" :value="scope.row.source" /></template>
      </el-table-column>
      <el-table-column label="主机" prop="hostName" width="140" :show-overflow-tooltip="true" />
      <el-table-column label="命令 / 事件" min-width="260" :show-overflow-tooltip="true">
        <template #default="scope">
          <code v-if="scope.row.kind === 'COMMAND'" class="itm-cmd">{{ scope.row.command }}</code>
          <span v-else>{{ scope.row.eventType }}</span>
        </template>
      </el-table-column>
      <el-table-column label="风险" width="90" align="center">
        <template #default="scope"><dict-tag :options="itm_risk_level" :value="scope.row.risk" /></template>
      </el-table-column>
      <el-table-column label="处理" width="90" align="center">
        <template #default="scope">{{ decisionLabel(scope.row.decision) }}</template>
      </el-table-column>
      <el-table-column label="退出码" prop="exitCode" width="80" align="center" />
    </el-table>

    <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />

    <el-drawer v-model="detailOpen" title="审计详情" size="520px" append-to-body>
      <el-descriptions v-if="detail" :column="1" border>
        <el-descriptions-item label="时间">{{ parseTime(detail.occurredAt) }}</el-descriptions-item>
        <el-descriptions-item label="用户">{{ detail.userName }}</el-descriptions-item>
        <el-descriptions-item label="设备">{{ detail.deviceId }}</el-descriptions-item>
        <el-descriptions-item label="来源"><dict-tag :options="itm_audit_source" :value="detail.source" /></el-descriptions-item>
        <el-descriptions-item label="主机">{{ detail.hostName }}</el-descriptions-item>
        <el-descriptions-item label="会话">{{ detail.sessionId }}</el-descriptions-item>
        <el-descriptions-item v-if="detail.kind === 'COMMAND'" label="命令"><pre class="itm-pre">{{ detail.command }}</pre></el-descriptions-item>
        <el-descriptions-item v-else label="事件">{{ detail.eventType }}</el-descriptions-item>
        <el-descriptions-item label="风险"><dict-tag :options="itm_risk_level" :value="detail.risk" /></el-descriptions-item>
        <el-descriptions-item label="处理">{{ decisionLabel(detail.decision) }}</el-descriptions-item>
        <el-descriptions-item label="退出码">{{ detail.exitCode }}</el-descriptions-item>
        <el-descriptions-item label="详情"><pre class="itm-pre">{{ prettyDetail }}</pre></el-descriptions-item>
      </el-descriptions>
    </el-drawer>
  </div>
</template>

<script setup name="ItmAudit">
import { listAudit } from "@/api/iterminal"

const { proxy } = getCurrentInstance()
const { itm_risk_level, itm_audit_source } = useDict("itm_risk_level", "itm_audit_source")

const list = ref([])
const loading = ref(true)
const showSearch = ref(true)
const total = ref(0)
const dateRange = ref([])
const detailOpen = ref(false)
const detail = ref(null)
const queryParams = ref({ pageNum: 1, pageSize: 20, kind: undefined, source: undefined, userName: undefined, hostName: undefined, command: undefined, risk: undefined })

const DECISION = { AUTO: "自动执行", APPROVED: "已批准", REJECTED: "已拒绝", DENIED: "已禁止" }
const decisionLabel = (d) => DECISION[d] || d || "—"
const prettyDetail = computed(() => {
  try {
    return detail.value?.detail ? JSON.stringify(JSON.parse(detail.value.detail), null, 2) : "—"
  } catch {
    return detail.value?.detail
  }
})

function getList() {
  loading.value = true
  listAudit(proxy.addDateRange(queryParams.value, dateRange.value)).then(res => {
    list.value = res.rows
    total.value = res.total
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
  handleQuery()
}

function showDetail(row) {
  detail.value = row
  detailOpen.value = true
}

function handleExport() {
  proxy.download("iterminal/audit/export", { ...proxy.addDateRange(queryParams.value, dateRange.value) }, `audit_${new Date().getTime()}.xlsx`)
}

getList()
</script>

<style scoped>
.itm-cmd {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
.itm-pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
:deep(.clickable-row) {
  cursor: pointer;
}
</style>
