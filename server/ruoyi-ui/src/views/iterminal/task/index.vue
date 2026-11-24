<template>
  <div class="app-container">
    <el-form :model="queryParams" ref="queryRef" :inline="true" v-show="showSearch">
      <el-form-item label="任务名称" prop="taskName">
        <el-input v-model="queryParams.taskName" placeholder="任务名称" clearable style="width: 180px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item label="类型" prop="taskType">
        <el-select v-model="queryParams.taskType" placeholder="全部" clearable style="width: 120px">
          <el-option v-for="dict in itm_task_type" :key="dict.value" :label="dict.label" :value="dict.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="执行设备" prop="deviceId">
        <el-select v-model="queryParams.deviceId" placeholder="全部" clearable filterable style="width: 200px">
          <el-option v-for="d in devices" :key="d.deviceId" :label="deviceLabel(d)" :value="d.deviceId" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-select v-model="queryParams.status" placeholder="全部" clearable style="width: 100px">
          <el-option label="启用" value="0" />
          <el-option label="暂停" value="1" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="Search" @click="handleQuery">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="primary" plain icon="Plus" @click="handleAdd" v-hasPermi="['itm:task:add']">新增</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDelete()" v-hasPermi="['itm:task:remove']">删除</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="info" plain icon="Tickets" @click="handleRuns()" v-hasPermi="['itm:run:list']">执行记录</el-button>
      </el-col>
      <right-toolbar v-model:showSearch="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <el-table v-loading="loading" :data="list" @selection-change="(rows) => (ids = rows.map((r) => r.taskId))">
      <el-table-column type="selection" width="50" align="center" />
      <el-table-column label="任务名称" prop="taskName" min-width="150" :show-overflow-tooltip="true" />
      <el-table-column label="类型" width="90" align="center">
        <template #default="scope"><dict-tag :options="itm_task_type" :value="scope.row.taskType" /></template>
      </el-table-column>
      <el-table-column label="内容" min-width="220" :show-overflow-tooltip="true">
        <template #default="scope">
          <code v-if="scope.row.taskType === 'COMMAND'" class="itm-cmd">{{ scope.row.command }}</code>
          <span v-else-if="scope.row.taskType === 'SKILL'">{{ scope.row.skill }}</span>
          <span v-else>{{ scope.row.prompt }}</span>
        </template>
      </el-table-column>
      <el-table-column label="执行设备" min-width="150" :show-overflow-tooltip="true">
        <template #default="scope">{{ deviceName(scope.row.deviceId) }}</template>
      </el-table-column>
      <el-table-column label="目标主机" width="90" align="center">
        <template #default="scope">
          <el-tooltip :content="hostList(scope.row.hosts).join('、')" placement="top">
            <span>{{ hostList(scope.row.hosts).length }} 台</span>
          </el-tooltip>
        </template>
      </el-table-column>
      <el-table-column label="cron" prop="cronExpression" width="130" />
      <el-table-column label="权限上限" width="100" align="center">
        <template #default="scope">{{ capLabel(scope.row.permissionCap) }}</template>
      </el-table-column>
      <el-table-column label="启用" width="80" align="center">
        <template #default="scope">
          <el-switch v-model="scope.row.status" active-value="0" inactive-value="1" @change="handleStatusChange(scope.row)" />
        </template>
      </el-table-column>
      <el-table-column label="上次执行" width="160">
        <template #default="scope">{{ parseTime(scope.row.lastRunAt) || "—" }}</template>
      </el-table-column>
      <el-table-column label="操作" align="center" width="200" class-name="small-padding fixed-width">
        <template #default="scope">
          <el-tooltip content="修改" placement="top">
            <el-button link type="primary" icon="Edit" @click="handleUpdate(scope.row)" v-hasPermi="['itm:task:edit']" />
          </el-tooltip>
          <el-tooltip content="立即执行一次" placement="top">
            <el-button link type="primary" icon="CaretRight" @click="handleRun(scope.row)" v-hasPermi="['itm:task:run']" />
          </el-tooltip>
          <el-tooltip content="执行记录" placement="top">
            <el-button link type="primary" icon="Tickets" @click="handleRuns(scope.row)" v-hasPermi="['itm:run:list']" />
          </el-tooltip>
          <el-tooltip content="删除" placement="top">
            <el-button link type="danger" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="['itm:task:remove']" />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />

    <el-dialog :title="title" v-model="open" width="720px" append-to-body>
      <el-form ref="taskRef" :model="form" :rules="rules" label-width="100px">
        <el-row>
          <el-col :span="14">
            <el-form-item label="任务名称" prop="taskName">
              <el-input v-model="form.taskName" placeholder="例如：每天凌晨检查磁盘" maxlength="100" />
            </el-form-item>
          </el-col>
          <el-col :span="10">
            <el-form-item label="类型" prop="taskType">
              <el-select v-model="form.taskType" style="width: 100%">
                <el-option v-for="dict in itm_task_type" :key="dict.value" :label="dict.label" :value="dict.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24" v-if="form.taskType === 'COMMAND'">
            <el-form-item label="命令" prop="command">
              <el-input v-model="form.command" type="textarea" :rows="3" class="itm-mono" placeholder="在每台目标主机上执行，例如：df -h" />
            </el-form-item>
          </el-col>
          <el-col :span="24" v-if="form.taskType === 'AGENT_PROMPT'">
            <el-form-item label="任务描述" prop="prompt">
              <el-input v-model="form.prompt" type="textarea" :rows="4" placeholder="交给 Agent 的目标，例如：检查 nginx 是否正常，如果挂了就重启并确认恢复" />
            </el-form-item>
          </el-col>
          <template v-if="form.taskType === 'SKILL'">
            <el-col :span="10">
              <el-form-item label="Skill" prop="skill">
                <el-input v-model="form.skill" placeholder="设备上的 Skill 名称" />
              </el-form-item>
            </el-col>
            <el-col :span="14">
              <el-form-item label="参数" prop="skillParams">
                <el-input v-model="form.skillParams" class="itm-mono" placeholder='JSON，例如 {"threshold": 80}' />
              </el-form-item>
            </el-col>
          </template>
          <el-col :span="24">
            <el-form-item label="执行设备" prop="deviceId">
              <el-select v-model="form.deviceId" placeholder="由哪台客户端执行（需要在线）" filterable style="width: 100%">
                <el-option v-for="d in devices" :key="d.deviceId" :label="deviceLabel(d)" :value="d.deviceId">
                  <span>{{ deviceLabel(d) }}</span>
                  <el-tag size="small" :type="d.online === '1' ? 'success' : 'info'" style="float: right; margin-top: 6px">{{ d.online === "1" ? "在线" : "离线" }}</el-tag>
                </el-option>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="目标主机" prop="hosts">
              <el-input v-model="form.hosts" type="textarea" :rows="3" placeholder="设备上的主机名称或 ID，每行一个" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="cron" prop="cronExpression">
              <el-input v-model="form.cronExpression" placeholder="6 段：秒 分 时 日 月 周，例如 0 0 2 * * ?">
                <template #append>
                  <el-button type="primary" @click="handleShowCron">
                    生成表达式
                    <i class="el-icon-time el-icon--right"></i>
                  </el-button>
                </template>
              </el-input>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="权限上限" prop="permissionCap">
              <el-select v-model="form.permissionCap" style="width: 100%">
                <el-option label="只读（只执行只读命令）" value="READONLY" />
                <el-option label="审批（写操作需要远程审批）" value="APPROVE" />
                <el-option label="自动（写操作自动执行）" value="AUTO" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="超时（分钟）" prop="timeoutMin">
              <el-input-number v-model="form.timeoutMin" :min="1" :max="1440" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-radio-group v-model="form.status">
                <el-radio value="0">启用</el-radio>
                <el-radio value="1">暂停</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注" prop="remark">
              <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-alert type="info" :closable="false" show-icon title="高危命令始终需要审批，禁止的命令始终被拒绝；无人值守的权限上限还受「iTerminal-无人值守权限上限」参数限制。" />
      </el-form>
      <template #footer>
        <div class="dialog-footer">
          <el-button type="primary" @click="submitForm">确 定</el-button>
          <el-button @click="open = false">取 消</el-button>
        </div>
      </template>
    </el-dialog>

    <el-dialog title="Cron表达式生成器" v-model="openCron" append-to-body destroy-on-close>
      <crontab @hide="openCron = false" @fill="(v) => (form.cronExpression = v)" :expression="expression"></crontab>
    </el-dialog>
  </div>
</template>

<script setup name="ItmTask">
import { listTask, getTask, addTask, updateTask, changeTaskStatus, delTask, runTask, deviceOptions } from "@/api/iterminal"
import Crontab from "@/components/Crontab"

const router = useRouter()
const { proxy } = getCurrentInstance()
const { itm_task_type } = useDict("itm_task_type")

const list = ref([])
const devices = ref([])
const open = ref(false)
const openCron = ref(false)
const expression = ref("")
const loading = ref(true)
const showSearch = ref(true)
const ids = ref([])
const total = ref(0)
const title = ref("")

const CAPS = { READONLY: "只读", APPROVE: "审批", AUTO: "自动" }
const capLabel = (c) => CAPS[c] || c || "只读"
const deviceLabel = (d) => (d.deviceName || d.deviceId) + (d.userName ? "（" + d.userName + "）" : "")
const deviceName = (id) => {
  const d = devices.value.find((x) => x.deviceId === id)
  return d ? deviceLabel(d) : id
}
const hostList = (s) => (s || "").split(/[\r\n,，]+/).map((x) => x.trim()).filter(Boolean)

const validJson = (rule, value, callback) => {
  if (!value) return callback()
  try {
    const v = JSON.parse(value)
    if (v && typeof v === "object" && !Array.isArray(v)) return callback()
  } catch {
    // 走下面的错误提示
  }
  callback(new Error('需要是 JSON 对象，例如 {"threshold": 80}'))
}

const data = reactive({
  form: {},
  queryParams: { pageNum: 1, pageSize: 10, taskName: undefined, taskType: undefined, deviceId: undefined, status: undefined },
  rules: {
    taskName: [{ required: true, message: "请填写任务名称", trigger: "blur" }],
    taskType: [{ required: true, message: "请选择类型", trigger: "change" }],
    command: [{ required: true, message: "请填写要执行的命令", trigger: "blur" }],
    prompt: [{ required: true, message: "请填写交给 Agent 的任务描述", trigger: "blur" }],
    skill: [{ required: true, message: "请填写 Skill 名称", trigger: "blur" }],
    skillParams: [{ validator: validJson, trigger: "blur" }],
    deviceId: [{ required: true, message: "请选择执行设备", trigger: "change" }],
    hosts: [{ required: true, message: "请填写目标主机", trigger: "blur" }],
    cronExpression: [{ required: true, message: "请填写 cron 表达式", trigger: "blur" }]
  }
})

const { queryParams, form, rules } = toRefs(data)

function getList() {
  loading.value = true
  listTask(queryParams.value).then(res => {
    list.value = res.rows
    total.value = res.total
    loading.value = false
  })
}

function loadDevices() {
  deviceOptions().then(res => {
    devices.value = res.data || []
  })
}

function reset() {
  form.value = {
    taskId: undefined,
    taskName: undefined,
    taskType: "COMMAND",
    command: undefined,
    prompt: undefined,
    skill: undefined,
    skillParams: undefined,
    deviceId: undefined,
    hosts: undefined,
    cronExpression: "0 0 2 * * ?",
    permissionCap: "READONLY",
    timeoutMin: 30,
    status: "0",
    remark: undefined
  }
  proxy.resetForm("taskRef")
}

function handleQuery() {
  queryParams.value.pageNum = 1
  getList()
}

function resetQuery() {
  proxy.resetForm("queryRef")
  handleQuery()
}

function handleAdd() {
  reset()
  loadDevices()
  open.value = true
  title.value = "新增定时任务"
}

function handleUpdate(row) {
  reset()
  loadDevices()
  getTask(row.taskId).then(res => {
    form.value = res.data
    open.value = true
    title.value = "修改定时任务"
  })
}

function handleShowCron() {
  expression.value = form.value.cronExpression
  openCron.value = true
}

function submitForm() {
  proxy.$refs["taskRef"].validate(valid => {
    if (!valid) return
    // 只提交当前类型用到的字段
    const body = { ...form.value }
    if (body.taskType !== "COMMAND") body.command = null
    if (body.taskType !== "AGENT_PROMPT") body.prompt = null
    if (body.taskType !== "SKILL") {
      body.skill = null
      body.skillParams = null
    }
    const req = body.taskId != undefined ? updateTask(body) : addTask(body)
    req.then(() => {
      proxy.$modal.msgSuccess(body.taskId != undefined ? "修改成功" : "新增成功")
      open.value = false
      getList()
    })
  })
}

function handleStatusChange(row) {
  const text = row.status === "0" ? "启用" : "暂停"
  proxy.$modal.confirm("确认" + text + "任务「" + row.taskName + "」？").then(() => {
    return changeTaskStatus(row.taskId, row.status)
  }).then(() => {
    proxy.$modal.msgSuccess(text + "成功")
  }).catch(() => {
    row.status = row.status === "0" ? "1" : "0"
  })
}

function handleRun(row) {
  proxy.$modal.confirm("确认立即执行一次「" + row.taskName + "」？").then(() => {
    return runTask(row.taskId)
  }).then(() => {
    // 设备离线时后端返回 warn（code 601），由请求拦截器提示
    proxy.$modal.msgSuccess("已派发给设备执行")
  }).catch(() => {})
}

function handleRuns(row) {
  router.push({ path: "/iterminal/run", query: row ? { taskId: row.taskId, taskName: row.taskName } : {} })
}

function handleDelete(row) {
  const target = row ? [row.taskId] : ids.value
  proxy.$modal.confirm("确认删除选中的 " + target.length + " 个定时任务？").then(() => {
    return delTask(target.join(","))
  }).then(() => {
    getList()
    proxy.$modal.msgSuccess("删除成功")
  }).catch(() => {})
}

loadDevices()
getList()
</script>

<style scoped>
.itm-cmd {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
.itm-mono :deep(textarea),
.itm-mono :deep(input) {
  font-family: Menlo, Consolas, monospace;
}
</style>
