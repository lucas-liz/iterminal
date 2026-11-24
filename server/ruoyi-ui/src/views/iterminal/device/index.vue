<template>
  <div class="app-container">
    <el-form :model="queryParams" ref="queryRef" :inline="true" v-show="showSearch">
      <el-form-item label="用户" prop="userName">
        <el-input v-model="queryParams.userName" placeholder="用户账号" clearable style="width: 160px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="设备名称" prop="deviceName">
        <el-input v-model="queryParams.deviceName" placeholder="设备名称" clearable style="width: 160px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="系统" prop="os">
        <el-select v-model="queryParams.os" placeholder="全部" clearable style="width: 120px">
          <el-option label="macOS" value="mac" />
          <el-option label="Windows" value="win" />
          <el-option label="Linux" value="linux" />
        </el-select>
      </el-form-item>
      <el-form-item label="在线" prop="online">
        <el-select v-model="queryParams.online" placeholder="全部" clearable style="width: 100px">
          <el-option label="在线" value="1" />
          <el-option label="离线" value="0" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-select v-model="queryParams.status" placeholder="全部" clearable style="width: 110px">
          <el-option v-for="dict in itm_device_status" :key="dict.value" :label="dict.label" :value="dict.value" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="Search" @click="handleQuery">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="warning" plain icon="Download" @click="handleExport" v-hasPermi="['itm:device:list']">导出</el-button>
      </el-col>
      <right-toolbar v-model:showSearch="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <el-table v-loading="loading" :data="list">
      <el-table-column label="设备名称" prop="deviceName" min-width="140" :show-overflow-tooltip="true" />
      <el-table-column label="用户" prop="userName" width="110" />
      <el-table-column label="系统" width="120">
        <template #default="scope">{{ osLabel(scope.row.os) }} {{ scope.row.arch }}</template>
      </el-table-column>
      <el-table-column label="客户端版本" prop="clientVersion" width="110" />
      <el-table-column label="在线" width="80" align="center">
        <template #default="scope">
          <el-tag :type="scope.row.online === '1' ? 'success' : 'info'" disable-transitions>{{ scope.row.online === '1' ? '在线' : '离线' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90" align="center">
        <template #default="scope"><dict-tag :options="itm_device_status" :value="scope.row.status" /></template>
      </el-table-column>
      <el-table-column label="最后 IP" prop="lastIp" width="140" />
      <el-table-column label="最后活跃" width="160">
        <template #default="scope">{{ parseTime(scope.row.lastSeenAt) }}</template>
      </el-table-column>
      <el-table-column label="首次登录" width="160">
        <template #default="scope">{{ parseTime(scope.row.createTime) }}</template>
      </el-table-column>
      <el-table-column label="设备ID" prop="deviceId" min-width="120" :show-overflow-tooltip="true" />
      <el-table-column label="操作" align="center" width="100" class-name="small-padding fixed-width">
        <template #default="scope">
          <el-button link type="danger" icon="CircleClose" :disabled="scope.row.status !== '0'" @click="handleRevoke(scope.row)" v-hasPermi="['itm:device:revoke']">吊销</el-button>
        </template>
      </el-table-column>
    </el-table>

    <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />
  </div>
</template>

<script setup name="ItmDevice">
import { listDevice, revokeDevice } from "@/api/iterminal"

const { proxy } = getCurrentInstance()
const { itm_device_status } = useDict("itm_device_status")

const list = ref([])
const loading = ref(true)
const showSearch = ref(true)
const total = ref(0)
const queryParams = ref({ pageNum: 1, pageSize: 10, userName: undefined, deviceName: undefined, os: undefined, online: undefined, status: undefined })

const osLabel = (os) => ({ mac: "macOS", win: "Windows", linux: "Linux" }[os] || os || "—")

function getList() {
  loading.value = true
  listDevice(queryParams.value).then(res => {
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
  proxy.resetForm("queryRef")
  handleQuery()
}

/** 吊销：令牌失效、断开连接，这台设备需要重新输入密码登录 */
function handleRevoke(row) {
  proxy.$modal.confirm('确认吊销设备「' + (row.deviceName || row.deviceId) + '」？吊销后这台设备的登录立即失效，需要重新输入密码登录。').then(() => {
    return revokeDevice(row.deviceId)
  }).then(() => {
    getList()
    proxy.$modal.msgSuccess("已吊销")
  }).catch(() => {})
}

function handleExport() {
  proxy.download("iterminal/device/export", { ...queryParams.value }, `device_${new Date().getTime()}.xlsx`)
}

getList()
</script>
