<template>
  <div class="app-container">
    <el-form :model="queryParams" ref="queryRef" :inline="true" v-show="showSearch">
      <el-form-item label="用户" prop="userName">
        <el-input v-model="queryParams.userName" placeholder="用户账号" clearable style="width: 140px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="主机" prop="hostName">
        <el-input v-model="queryParams.hostName" placeholder="主机名称" clearable style="width: 160px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="类型" prop="kind">
        <el-select v-model="queryParams.kind" placeholder="全部" clearable style="width: 110px">
          <el-option v-for="(label, value) in KIND" :key="value" :label="label" :value="value" />
        </el-select>
      </el-form-item>
      <el-form-item label="上传完整" prop="complete">
        <el-select v-model="queryParams.complete" placeholder="全部" clearable style="width: 100px">
          <el-option label="完整" value="1" />
          <el-option label="上传中" value="0" />
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
      <el-col :span="1.5">
        <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDelete()" v-hasPermi="['itm:session:remove']">删除</el-button>
      </el-col>
      <right-toolbar v-model:showSearch="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <el-table v-loading="loading" :data="list" @selection-change="(rows) => (ids = rows.map((r) => r.recordingId))">
      <el-table-column type="selection" width="50" align="center" />
      <el-table-column label="开始时间" width="160">
        <template #default="scope">{{ parseTime(scope.row.startedAt) }}</template>
      </el-table-column>
      <el-table-column label="时长" width="90">
        <template #default="scope">{{ duration(scope.row) }}</template>
      </el-table-column>
      <el-table-column label="用户" prop="userName" width="100" />
      <el-table-column label="主机" prop="hostName" min-width="160" :show-overflow-tooltip="true" />
      <el-table-column label="类型" width="80">
        <template #default="scope">{{ KIND[scope.row.kind] || scope.row.kind }}</template>
      </el-table-column>
      <el-table-column label="尺寸" width="90">
        <template #default="scope">{{ scope.row.cols }}×{{ scope.row.rowsCount }}</template>
      </el-table-column>
      <el-table-column label="大小" width="100">
        <template #default="scope">{{ size(scope.row.bytes) }}</template>
      </el-table-column>
      <el-table-column label="上传" width="90" align="center">
        <template #default="scope">
          <el-tag :type="scope.row.complete === '1' ? 'success' : 'warning'" disable-transitions>{{ scope.row.complete === '1' ? '完整' : '上传中' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" align="center" width="150" class-name="small-padding fixed-width">
        <template #default="scope">
          <el-button link type="primary" icon="VideoPlay" :disabled="!scope.row.chunks" @click="handlePlay(scope.row)" v-hasPermi="['itm:session:play']">回放</el-button>
          <el-button link type="danger" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="['itm:session:remove']">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />

    <el-dialog v-model="playOpen" :title="playTitle" width="min(1100px, 94vw)" append-to-body destroy-on-close>
      <div v-loading="castLoading" style="min-height: 120px">
        <el-alert v-if="castError" :title="castError" type="error" :closable="false" />
        <cast-player v-else-if="cast" :cast="cast" />
      </div>
    </el-dialog>
  </div>
</template>

<script setup name="ItmSession">
import { listSession, getSessionCast, delSession } from "@/api/iterminal"
import CastPlayer from "@/components/CastPlayer"

const { proxy } = getCurrentInstance()

const list = ref([])
const loading = ref(true)
const showSearch = ref(true)
const total = ref(0)
const ids = ref([])
const dateRange = ref([])
const playOpen = ref(false)
const playTitle = ref("")
const cast = ref("")
const castLoading = ref(false)
const castError = ref("")
const queryParams = ref({ pageNum: 1, pageSize: 10, userName: undefined, hostName: undefined, kind: undefined, complete: undefined })
/** 客户端上报的会话类型 */
const KIND = { ssh: "SSH", telnet: "Telnet", serial: "串口", local: "本地终端" }

function duration(row) {
  if (!row.startedAt || !row.endedAt) return "—"
  const s = Math.max(0, Math.round((new Date(row.endedAt) - new Date(row.startedAt)) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s % 60).padStart(2, "0")
}

function size(b) {
  if (b == null) return "—"
  if (b < 1024) return b + " B"
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB"
  return (b / 1024 / 1024).toFixed(1) + " MB"
}

function getList() {
  loading.value = true
  listSession(proxy.addDateRange(queryParams.value, dateRange.value)).then(res => {
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

function handlePlay(row) {
  playTitle.value = (row.hostName || "会话录像") + " · " + proxy.parseTime(row.startedAt)
  cast.value = ""
  castError.value = ""
  castLoading.value = true
  playOpen.value = true
  getSessionCast(row.recordingId).then(text => {
    // 正常是 asciicast 文本（第一行是带 version 的头）；出错时后端返回 JSON（{ code, msg }）
    let head = null
    try {
      head = JSON.parse(String(text).split("\n", 1)[0])
    } catch {
      head = null
    }
    if (head && head.version === undefined && head.code !== undefined) {
      castError.value = head.msg || "录像读取失败"
    } else {
      cast.value = text
    }
  }).catch(() => {
    castError.value = "录像读取失败"
  }).finally(() => {
    castLoading.value = false
  })
}

function handleDelete(row) {
  const target = row ? [row.recordingId] : ids.value
  proxy.$modal.confirm("确认删除选中的 " + target.length + " 条录像？录像文件会一起删除，无法恢复。").then(() => {
    return delSession(target.join(","))
  }).then(() => {
    getList()
    proxy.$modal.msgSuccess("删除成功")
  }).catch(() => {})
}

getList()
</script>
