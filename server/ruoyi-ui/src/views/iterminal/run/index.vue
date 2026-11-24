<template>
  <div class="app-container">
    <el-form :model="queryParams" ref="queryRef" :inline="true" v-show="showSearch">
      <el-form-item label="任务名称" prop="taskName">
        <el-input v-model="queryParams.taskName" placeholder="任务名称" clearable style="width: 180px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-select v-model="queryParams.status" placeholder="全部" clearable style="width: 120px">
          <el-option v-for="dict in itm_run_status" :key="dict.value" :label="dict.label" :value="dict.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="开始时间">
        <el-date-picker v-model="dateRange" value-format="YYYY-MM-DD" type="daterange" range-separator="-" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="Search" @click="handleQuery">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5" v-if="queryParams.taskId">
        <el-tag closable @close="clearTask">任务：{{ taskName || queryParams.taskId }}</el-tag>
      </el-col>
      <right-toolbar v-model:showSearch="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <el-table v-loading="loading" :data="list" @row-click="showDetail" row-class-name="clickable-row">
      <el-table-column label="开始时间" width="160">
        <template #default="scope">{{ parseTime(scope.row.startedAt) }}</template>
      </el-table-column>
      <el-table-column label="任务" prop="taskName" min-width="150" :show-overflow-tooltip="true" />
      <el-table-column label="类型" width="90" align="center">
        <template #default="scope"><dict-tag :options="itm_task_type" :value="scope.row.taskType" /></template>
      </el-table-column>
      <el-table-column label="触发" width="70" align="center">
        <template #default="scope">{{ scope.row.triggerType === "MANUAL" ? "手动" : "定时" }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="scope"><dict-tag :options="itm_run_status" :value="scope.row.status" /></template>
      </el-table-column>
      <el-table-column label="进度" width="140">
        <template #default="scope">
          <el-progress :percentage="scope.row.percent || 0" :stroke-width="6" :status="progressStatus(scope.row.status)" />
        </template>
      </el-table-column>
      <el-table-column label="结果" prop="summary" min-width="220" :show-overflow-tooltip="true" />
      <el-table-column label="结束时间" width="160">
        <template #default="scope">{{ parseTime(scope.row.endedAt) || "—" }}</template>
      </el-table-column>
    </el-table>

    <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />

    <el-drawer v-model="detailOpen" title="执行详情" size="680px" append-to-body>
      <div v-loading="detailLoading">
        <template v-if="detail">
          <el-descriptions :column="2" border>
            <el-descriptions-item label="任务" :span="2">{{ detail.taskName }}</el-descriptions-item>
            <el-descriptions-item label="状态"><dict-tag :options="itm_run_status" :value="detail.status" /></el-descriptions-item>
            <el-descriptions-item label="触发">{{ detail.triggerType === "MANUAL" ? "手动" : "定时" }}</el-descriptions-item>
            <el-descriptions-item label="开始">{{ parseTime(detail.startedAt) }}</el-descriptions-item>
            <el-descriptions-item label="结束">{{ parseTime(detail.endedAt) || "—" }}</el-descriptions-item>
            <el-descriptions-item label="设备" :span="2">{{ detail.deviceId }}</el-descriptions-item>
            <el-descriptions-item label="结果" :span="2"><pre class="itm-pre">{{ detail.summary || "—" }}</pre></el-descriptions-item>
          </el-descriptions>
          <h4 class="itm-sub">每台主机</h4>
          <el-empty v-if="!hosts.length" description="还没有主机的结果" :image-size="60" />
          <el-collapse v-else>
            <el-collapse-item v-for="(h, i) in hosts" :key="i" :name="i">
              <template #title>
                <span class="itm-host">{{ h.hostName || h.hostId }}</span>
                <el-tag size="small" :type="hostTag(h.status)" disable-transitions>{{ hostStatus(h.status) }}</el-tag>
                <span v-if="h.exitCode != null" class="itm-exit">退出码 {{ h.exitCode }}</span>
                <span v-if="h.message" class="itm-msg">{{ h.message }}</span>
              </template>
              <pre class="itm-out">{{ h.output || "（没有输出）" }}</pre>
            </el-collapse-item>
          </el-collapse>
        </template>
      </div>
    </el-drawer>
  </div>
</template>

<script setup name="ItmRun">
import { listRun, getRun } from "@/api/iterminal"

const route = useRoute()
const { proxy } = getCurrentInstance()
const { itm_run_status, itm_task_type } = useDict("itm_run_status", "itm_task_type")

const list = ref([])
const loading = ref(true)
const showSearch = ref(true)
const total = ref(0)
const dateRange = ref([])
const taskName = ref(route.query.taskName || "")
const detailOpen = ref(false)
const detailLoading = ref(false)
const detail = ref(null)
const queryParams = ref({ pageNum: 1, pageSize: 10, taskId: route.query.taskId || undefined, taskName: undefined, status: undefined })

const HOST_STATUS = {
  PENDING: ["等待", "info"],
  RUNNING: ["执行中", "primary"],
  WAITING_APPROVAL: ["等待审批", "warning"],
  SUCCESS: ["成功", "success"],
  FAILED: ["失败", "danger"],
  DENIED: ["已拒绝", "danger"],
  SKIPPED: ["已跳过", "info"]
}
const hostStatus = (s) => (HOST_STATUS[s] || [s])[0]
const hostTag = (s) => (HOST_STATUS[s] || [s, "info"])[1]
const progressStatus = (s) => (s === "SUCCESS" ? "success" : ["FAILED", "TIMEOUT"].includes(s) ? "exception" : s === "PARTIAL" ? "warning" : undefined)

const hosts = computed(() => {
  try {
    const v = JSON.parse(detail.value?.hosts || "[]")
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
})

function getList() {
  loading.value = true
  listRun(proxy.addDateRange(queryParams.value, dateRange.value)).then(res => {
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

function clearTask() {
  queryParams.value.taskId = undefined
  taskName.value = ""
  handleQuery()
}

function showDetail(row) {
  detail.value = row
  detailOpen.value = true
  detailLoading.value = true
  getRun(row.runId).then(res => {
    detail.value = res.data
  }).finally(() => {
    detailLoading.value = false
  })
}

// 从任务列表跳过来时带着 taskId
watch(() => route.query.taskId, (v) => {
  if (route.path !== "/iterminal/run") return
  queryParams.value.taskId = v || undefined
  taskName.value = route.query.taskName || ""
  handleQuery()
})

getList()
</script>

<style scoped>
.itm-pre,
.itm-out {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
.itm-out {
  background: var(--el-fill-color-light);
  border-radius: 4px;
  padding: 8px 10px;
  max-height: 360px;
  overflow: auto;
}
.itm-sub {
  margin: 18px 0 8px;
}
.itm-host {
  font-weight: 600;
  margin-right: 10px;
}
.itm-exit,
.itm-msg {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
:deep(.clickable-row) {
  cursor: pointer;
}
</style>
