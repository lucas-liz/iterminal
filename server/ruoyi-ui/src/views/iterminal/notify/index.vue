<template>
  <div class="app-container">
    <el-tabs v-model="tab">
      <el-tab-pane label="通知渠道" name="channel" />
      <el-tab-pane label="发送记录" name="log" />
    </el-tabs>

    <!-- 渠道 -->
    <template v-if="tab === 'channel'">
      <el-alert type="info" :closable="false" class="mb8">
        <template #title>
          事件发生时发给订阅了它的渠道，失败 5 秒后重试一次。消息里的「在管理后台查看」链接需要在「系统管理 → 参数设置」里填写 <code>itm.admin.url</code>；
          邮件渠道需要服务端配置 SMTP（环境变量 <code>ITM_SMTP_HOST</code> 等，见部署说明）。
        </template>
      </el-alert>
      <el-row :gutter="10" class="mb8">
        <el-col :span="1.5">
          <el-button type="primary" plain icon="Plus" @click="handleAdd" v-hasPermi="['itm:notify:add']">新增</el-button>
        </el-col>
        <el-col :span="1.5">
          <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDelete()" v-hasPermi="['itm:notify:remove']">删除</el-button>
        </el-col>
        <right-toolbar :search="false" @queryTable="getList"></right-toolbar>
      </el-row>

      <el-table v-loading="loading" :data="list" @selection-change="(rows) => (ids = rows.map((r) => r.channelId))">
        <el-table-column type="selection" width="50" align="center" />
        <el-table-column label="渠道名称" prop="channelName" min-width="140" :show-overflow-tooltip="true" />
        <el-table-column label="类型" width="130" align="center">
          <template #default="scope"><dict-tag :options="itm_notify_type" :value="scope.row.channelType" /></template>
        </el-table-column>
        <el-table-column label="地址 / 收件人" min-width="240" :show-overflow-tooltip="true">
          <template #default="scope">{{ scope.row.channelType === "EMAIL" ? scope.row.recipients : maskUrl(scope.row.webhook) }}</template>
        </el-table-column>
        <el-table-column label="接收的事件" min-width="260">
          <template #default="scope">
            <el-tag v-for="e in splitEvents(scope.row.events)" :key="e" size="small" class="itm-event-tag" disable-transitions>{{ eventLabel(e) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="启用" width="80" align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.status" active-value="0" inactive-value="1" @change="handleStatusChange(scope.row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" align="center" width="160" class-name="small-padding fixed-width">
          <template #default="scope">
            <el-tooltip content="发送测试消息" placement="top">
              <el-button link type="primary" icon="Promotion" @click="handleTest(scope.row)" v-hasPermi="['itm:notify:test']" />
            </el-tooltip>
            <el-tooltip content="修改" placement="top">
              <el-button link type="primary" icon="Edit" @click="handleUpdate(scope.row)" v-hasPermi="['itm:notify:edit']" />
            </el-tooltip>
            <el-tooltip content="删除" placement="top">
              <el-button link type="danger" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="['itm:notify:remove']" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
      <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />
    </template>

    <!-- 发送记录 -->
    <template v-else>
      <el-form :model="logQuery" ref="logQueryRef" :inline="true">
        <el-form-item label="事件" prop="event">
          <el-select v-model="logQuery.event" placeholder="全部" clearable style="width: 130px">
            <el-option v-for="dict in itm_notify_event" :key="dict.value" :label="dict.label" :value="dict.value" />
            <el-option label="测试" value="TEST" />
          </el-select>
        </el-form-item>
        <el-form-item label="结果" prop="status">
          <el-select v-model="logQuery.status" placeholder="全部" clearable style="width: 100px">
            <el-option label="成功" value="0" />
            <el-option label="失败" value="1" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间">
          <el-date-picker v-model="logRange" value-format="YYYY-MM-DD" type="daterange" range-separator="-" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" icon="Search" @click="getLogs(true)">搜索</el-button>
          <el-button icon="Refresh" @click="resetLogs">重置</el-button>
        </el-form-item>
      </el-form>
      <el-table v-loading="logLoading" :data="logs">
        <el-table-column type="expand">
          <template #default="scope">
            <pre class="itm-pre">{{ scope.row.content }}</pre>
          </template>
        </el-table-column>
        <el-table-column label="时间" prop="sentAt" width="170" />
        <el-table-column label="渠道" prop="channelName" width="160" :show-overflow-tooltip="true" />
        <el-table-column label="事件" width="110" align="center">
          <template #default="scope">{{ eventLabel(scope.row.event) }}</template>
        </el-table-column>
        <el-table-column label="标题" prop="title" min-width="240" :show-overflow-tooltip="true" />
        <el-table-column label="结果" width="80" align="center">
          <template #default="scope">
            <el-tag :type="scope.row.status === '0' ? 'success' : 'danger'" disable-transitions>{{ scope.row.status === "0" ? "成功" : "失败" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" prop="error" min-width="220" :show-overflow-tooltip="true" />
      </el-table>
      <pagination v-show="logTotal > 0" :total="logTotal" v-model:page="logQuery.pageNum" v-model:limit="logQuery.pageSize" @pagination="getLogs()" />
    </template>

    <el-dialog :title="title" v-model="open" width="640px" append-to-body>
      <el-form ref="channelRef" :model="form" :rules="rules" label-width="120px">
        <el-form-item label="渠道名称" prop="channelName">
          <el-input v-model="form.channelName" maxlength="100" placeholder="例如：运维群机器人" />
        </el-form-item>
        <el-form-item label="类型" prop="channelType">
          <el-radio-group v-model="form.channelType">
            <el-radio-button v-for="dict in itm_notify_type" :key="dict.value" :value="dict.value">{{ dict.label }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="form.channelType === 'EMAIL'">
          <el-form-item label="收件人" prop="recipients">
            <el-input v-model="form.recipients" type="textarea" :rows="2" placeholder="多个邮箱用逗号分隔" />
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="Webhook 地址" prop="webhook">
            <el-input v-model="form.webhook" :placeholder="HOOK_HINT[form.channelType]" />
          </el-form-item>
          <el-form-item v-if="form.channelType !== 'WECOM'" label="加签密钥" prop="secret">
            <el-input v-model="form.secret" type="password" show-password :placeholder="SECRET_HINT[form.channelType]" autocomplete="new-password" />
          </el-form-item>
          <el-form-item v-if="form.channelType !== 'WEBHOOK'" label="@ 成员" prop="mention">
            <el-input v-model="form.mention" :placeholder="form.channelType === 'FEISHU' ? '填 all 表示 @所有人' : '手机号，多个用逗号分隔；all 表示 @所有人'" />
          </el-form-item>
        </template>
        <el-form-item label="接收的事件" prop="eventList">
          <el-checkbox-group v-model="form.eventList">
            <el-checkbox v-for="dict in itm_notify_event" :key="dict.value" :value="dict.value">{{ dict.label }}</el-checkbox>
          </el-checkbox-group>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="0">启用</el-radio>
            <el-radio value="1">停用</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="备注" prop="remark">
          <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :loading="testing" @click="testForm" v-hasPermi="['itm:notify:test']">发送测试</el-button>
        <el-button type="primary" @click="submitForm">确 定</el-button>
        <el-button @click="open = false">取 消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup name="ItmNotify">
import { listNotifyChannel, getNotifyChannel, addNotifyChannel, updateNotifyChannel, delNotifyChannel, testNotifyChannel, listNotifyLog } from "@/api/iterminal"

const { proxy } = getCurrentInstance()
const { itm_notify_type, itm_notify_event } = useDict("itm_notify_type", "itm_notify_event")

const HOOK_HINT = {
  DINGTALK: "https://oapi.dingtalk.com/robot/send?access_token=…",
  WECOM: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…",
  FEISHU: "https://open.feishu.cn/open-apis/bot/v2/hook/…",
  WEBHOOK: "https://…（POST JSON）"
}
const SECRET_HINT = {
  DINGTALK: "机器人安全设置里的「加签」密钥（SEC 开头），没开启加签可以不填",
  FEISHU: "机器人安全设置里的「签名校验」密钥，没开启可以不填",
  WEBHOOK: "可选：填了会带 X-Itm-Signature 头（HMAC-SHA256）"
}

const tab = ref("channel")
const list = ref([])
const loading = ref(true)
const total = ref(0)
const ids = ref([])
const open = ref(false)
const title = ref("")
const testing = ref(false)
const form = ref({})
const queryParams = ref({ pageNum: 1, pageSize: 10 })
const logs = ref([])
const logLoading = ref(false)
const logTotal = ref(0)
const logRange = ref([])
const logQuery = ref({ pageNum: 1, pageSize: 20, event: undefined, status: undefined })

const rules = {
  channelName: [{ required: true, message: "请填写渠道名称", trigger: "blur" }],
  channelType: [{ required: true, message: "请选择类型", trigger: "change" }],
  webhook: [{ required: true, message: "请填写 Webhook 地址", trigger: "blur" }, { pattern: /^https?:\/\/\S+$/, message: "http:// 或 https:// 开头", trigger: "blur" }],
  recipients: [{ required: true, message: "请填写收件人", trigger: "blur" }],
  eventList: [{ type: "array", required: true, min: 1, message: "请至少选择一个事件", trigger: "change" }]
}

const splitEvents = (s) => (s || "").split(",").filter(Boolean)
const eventLabel = (e) => (e === "TEST" ? "测试" : (itm_notify_event.value.find((d) => d.value === e) || { label: e }).label)
/** 列表里不显示完整的 token / key */
const maskUrl = (u) => (u || "").replace(/((?:access_token|key|token)=)[^&]{4,}/i, (m, p) => p + "****").replace(/(\/hook\/)[^/?]{6,}/, "$1****")

function getList() {
  loading.value = true
  listNotifyChannel(queryParams.value).then(res => {
    list.value = res.rows
    total.value = res.total
    loading.value = false
  })
}

function getLogs(reset) {
  if (reset) logQuery.value.pageNum = 1
  logLoading.value = true
  listNotifyLog(proxy.addDateRange(logQuery.value, logRange.value)).then(res => {
    logs.value = res.rows
    logTotal.value = res.total
  }).finally(() => {
    logLoading.value = false
  })
}

function resetLogs() {
  logRange.value = []
  proxy.resetForm("logQueryRef")
  getLogs(true)
}

watch(tab, (v) => (v === "log" ? getLogs(true) : getList()))

function reset() {
  form.value = { channelId: undefined, channelName: undefined, channelType: "DINGTALK", webhook: "", secret: "", recipients: "", mention: "", eventList: ["TASK_FAILED", "TASK_OFFLINE", "APPROVAL_REQUEST"], status: "0", remark: undefined }
  proxy.resetForm("channelRef")
}

function handleAdd() {
  reset()
  open.value = true
  title.value = "新增通知渠道"
}

function handleUpdate(row) {
  reset()
  getNotifyChannel(row.channelId).then(res => {
    form.value = { ...res.data, eventList: splitEvents(res.data.events) }
    open.value = true
    title.value = "修改通知渠道"
  })
}

function payload() {
  const f = { ...form.value, events: form.value.eventList.join(",") }
  delete f.eventList
  return f
}

function submitForm() {
  proxy.$refs["channelRef"].validate(valid => {
    if (!valid) return
    const req = form.value.channelId != undefined ? updateNotifyChannel(payload()) : addNotifyChannel(payload())
    req.then(() => {
      proxy.$modal.msgSuccess(form.value.channelId != undefined ? "修改成功" : "新增成功")
      open.value = false
      getList()
    })
  })
}

function testForm() {
  proxy.$refs["channelRef"].validate(valid => {
    if (!valid) return
    testing.value = true
    testNotifyChannel(payload()).then(res => {
      proxy.$modal.msgSuccess(res.msg || "测试消息已发送")
    }).finally(() => {
      testing.value = false
    })
  })
}

function handleTest(row) {
  testNotifyChannel({ ...row }).then(res => {
    proxy.$modal.msgSuccess((res.msg || "测试消息已发送") + "：" + row.channelName)
  })
}

function handleStatusChange(row) {
  const text = row.status === "0" ? "启用" : "停用"
  updateNotifyChannel({ ...row }).then(() => {
    proxy.$modal.msgSuccess(text + "成功")
  }).catch(() => {
    row.status = row.status === "0" ? "1" : "0"
  })
}

function handleDelete(row) {
  const target = row ? [row.channelId] : ids.value
  proxy.$modal.confirm("确认删除选中的 " + target.length + " 个通知渠道？").then(() => {
    return delNotifyChannel(target.join(","))
  }).then(() => {
    getList()
    proxy.$modal.msgSuccess("删除成功")
  }).catch(() => {})
}

getList()
</script>

<style scoped>
.itm-event-tag {
  margin: 2px 4px 2px 0;
}
.itm-pre {
  margin: 0 48px;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
code {
  font-family: Menlo, Consolas, monospace;
}
</style>
