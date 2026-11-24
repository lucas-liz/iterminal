<template>
  <div class="app-container">
    <el-alert type="info" :closable="false" class="mb8">
      <template #title>
        规则随 AI 策略下发给客户端（登录、重连时拉取），客户端在内置规则之前先匹配这里的规则。
        无人值守权限上限、是否允许 LLM 复核、审批有效期在「系统管理 → 参数设置」里修改（参数键名以 <code>itm.</code> 开头）。
      </template>
    </el-alert>
    <el-tabs v-model="kind" @tab-change="onTab">
      <el-tab-pane label="命令规则" name="command" />
      <el-tab-pane label="脱敏规则" name="mask" />
    </el-tabs>

    <el-form :model="queryParams" ref="queryRef" :inline="true" v-show="showSearch">
      <el-form-item label="规则名称" prop="ruleName">
        <el-input v-model="queryParams.ruleName" placeholder="规则名称" clearable style="width: 180px" @keyup.enter="handleQuery" />
      </el-form-item>
      <el-form-item v-if="kind === 'command'" label="等级" prop="level">
        <el-select v-model="queryParams.level" placeholder="全部" clearable style="width: 110px">
          <el-option v-for="dict in itm_risk_level" :key="dict.value" :label="dict.label" :value="dict.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态" prop="status">
        <el-select v-model="queryParams.status" placeholder="全部" clearable style="width: 100px">
          <el-option label="启用" value="0" />
          <el-option label="停用" value="1" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" icon="Search" @click="handleQuery">搜索</el-button>
        <el-button icon="Refresh" @click="resetQuery">重置</el-button>
      </el-form-item>
    </el-form>

    <el-row :gutter="10" class="mb8">
      <el-col :span="1.5">
        <el-button type="primary" plain icon="Plus" @click="handleAdd" v-hasPermi="['itm:rule:add']">新增</el-button>
      </el-col>
      <el-col :span="1.5">
        <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDelete()" v-hasPermi="['itm:rule:remove']">删除</el-button>
      </el-col>
      <right-toolbar v-model:showSearch="showSearch" @queryTable="getList"></right-toolbar>
    </el-row>

    <el-table v-loading="loading" :data="list" @selection-change="(rows) => (ids = rows.map((r) => r.ruleId))">
      <el-table-column type="selection" width="50" align="center" />
      <el-table-column label="规则名称" prop="ruleName" min-width="140" :show-overflow-tooltip="true" />
      <template v-if="kind === 'command'">
        <el-table-column label="匹配方式" width="100" align="center">
          <template #default="scope">{{ MATCH[scope.row.matchType] || scope.row.matchType }}</template>
        </el-table-column>
        <el-table-column label="匹配内容" min-width="220" :show-overflow-tooltip="true">
          <template #default="scope"><code class="itm-code">{{ scope.row.pattern }}</code></template>
        </el-table-column>
        <el-table-column label="等级" width="90" align="center">
          <template #default="scope"><dict-tag :options="itm_risk_level" :value="scope.row.level" /></template>
        </el-table-column>
        <el-table-column label="说明" prop="reason" min-width="160" :show-overflow-tooltip="true" />
        <el-table-column label="优先级" prop="priority" width="80" align="center" />
      </template>
      <template v-else>
        <el-table-column label="正则表达式" min-width="240" :show-overflow-tooltip="true">
          <template #default="scope"><code class="itm-code">{{ scope.row.pattern }}</code></template>
        </el-table-column>
        <el-table-column label="替换为" prop="replacement" width="120" />
        <el-table-column label="强制内网模型" width="110" align="center">
          <template #default="scope">
            <el-tag :type="scope.row.forcePrivate === '1' ? 'warning' : 'info'" disable-transitions>{{ scope.row.forcePrivate === "1" ? "是" : "否" }}</el-tag>
          </template>
        </el-table-column>
      </template>
      <el-table-column label="状态" width="80" align="center">
        <template #default="scope">
          <el-tag :type="scope.row.status === '0' ? 'success' : 'info'" disable-transitions>{{ scope.row.status === "0" ? "启用" : "停用" }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" width="160">
        <template #default="scope">{{ parseTime(scope.row.updateTime || scope.row.createTime) }}</template>
      </el-table-column>
      <el-table-column label="操作" align="center" width="120" class-name="small-padding fixed-width">
        <template #default="scope">
          <el-tooltip content="修改" placement="top">
            <el-button link type="primary" icon="Edit" @click="handleUpdate(scope.row)" v-hasPermi="['itm:rule:edit']" />
          </el-tooltip>
          <el-tooltip content="删除" placement="top">
            <el-button link type="danger" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="['itm:rule:remove']" />
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />

    <el-dialog :title="title" v-model="open" width="620px" append-to-body>
      <el-form ref="ruleRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="规则名称" prop="ruleName">
          <el-input v-model="form.ruleName" maxlength="100" />
        </el-form-item>
        <template v-if="kind === 'command'">
          <el-form-item label="匹配方式" prop="matchType">
            <el-radio-group v-model="form.matchType">
              <el-radio value="PREFIX">前缀</el-radio>
              <el-radio value="EXACT">完全一致</el-radio>
              <el-radio value="REGEX">正则</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="匹配内容" prop="pattern">
            <el-input v-model="form.pattern" class="itm-mono" maxlength="500" :placeholder="form.matchType === 'REGEX' ? '例如 ^systemctl\\s+(restart|reload)\\b' : '例如 journalctl'" />
          </el-form-item>
          <el-form-item label="等级" prop="level">
            <el-radio-group v-model="form.level">
              <el-radio value="L0">只读（自动执行）</el-radio>
              <el-radio value="L1">写操作</el-radio>
              <el-radio value="L2">高危</el-radio>
              <el-radio value="DENY">禁止</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="说明" prop="reason">
            <el-input v-model="form.reason" maxlength="200" placeholder="命中时展示给用户 / 审批人" />
          </el-form-item>
          <el-form-item label="优先级" prop="priority">
            <el-input-number v-model="form.priority" :min="0" :max="10000" controls-position="right" />
            <span class="itm-muted">越小越先匹配</span>
          </el-form-item>
        </template>
        <template v-else>
          <el-form-item label="正则表达式" prop="pattern">
            <el-input v-model="form.pattern" class="itm-mono" maxlength="500" placeholder="例如 \bEMP\d{6}\b" />
          </el-form-item>
          <el-form-item label="替换为" prop="replacement">
            <el-input v-model="form.replacement" maxlength="100" placeholder="****" />
          </el-form-item>
          <el-form-item label="强制内网模型">
            <el-switch v-model="form.forcePrivate" active-value="1" inactive-value="0" />
            <span class="itm-muted">命中后这次对话只能发给内网 / 本地模型</span>
          </el-form-item>
        </template>
        <el-form-item label="试一试" v-if="kind === 'mask' || form.matchType === 'REGEX'">
          <el-input v-model="sample" :placeholder="kind === 'mask' ? '输入一段文字，看脱敏后的结果' : '输入一条命令，看是否命中'" />
          <div class="itm-try" v-if="sample">{{ tryResult }}</div>
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="form.status">
            <el-radio value="0">启用</el-radio>
            <el-radio value="1">停用</el-radio>
          </el-radio-group>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="submitForm">确 定</el-button>
        <el-button @click="open = false">取 消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup name="ItmRule">
import { listRule, getRule, addRule, updateRule, delRule } from "@/api/iterminal"

const { proxy } = getCurrentInstance()
const { itm_risk_level } = useDict("itm_risk_level")

const MATCH = { PREFIX: "前缀", EXACT: "完全一致", REGEX: "正则" }

const kind = ref("command")
const list = ref([])
const loading = ref(true)
const showSearch = ref(true)
const total = ref(0)
const ids = ref([])
const open = ref(false)
const title = ref("")
const sample = ref("")
const form = ref({})
const queryParams = ref({ pageNum: 1, pageSize: 10, ruleName: undefined, level: undefined, status: undefined })

/** 客户端用 JavaScript 正则匹配，这里用同样的引擎检查 */
const compile = (p, flags) => {
  try {
    return new RegExp(p, flags)
  } catch {
    return null
  }
}
const validRegex = (rule, value, callback) => {
  const needRegex = kind.value === "mask" || form.value.matchType === "REGEX"
  if (!value || !needRegex) return callback()
  compile(value, "") ? callback() : callback(new Error("正则表达式不正确"))
}
const rules = {
  ruleName: [{ required: true, message: "请填写规则名称", trigger: "blur" }],
  pattern: [{ required: true, message: "请填写匹配内容", trigger: "blur" }, { validator: validRegex, trigger: "blur" }]
}

const tryResult = computed(() => {
  const re = compile(form.value.pattern || "", kind.value === "mask" ? "g" : "")
  if (!form.value.pattern) return "先填写正则表达式"
  if (!re) return "正则表达式不正确"
  if (kind.value === "mask") return "脱敏后：" + sample.value.replace(re, form.value.replacement || "****")
  return re.test(sample.value) ? "命中" : "没有命中"
})

function getList() {
  loading.value = true
  listRule(kind.value, queryParams.value).then(res => {
    list.value = res.rows
    total.value = res.total
    loading.value = false
  })
}

function onTab() {
  ids.value = []
  list.value = []
  proxy.resetForm("queryRef")
  queryParams.value.pageNum = 1
  getList()
}

function handleQuery() {
  queryParams.value.pageNum = 1
  getList()
}

function resetQuery() {
  proxy.resetForm("queryRef")
  handleQuery()
}

function reset() {
  sample.value = ""
  form.value = kind.value === "command"
    ? { ruleId: undefined, ruleName: undefined, matchType: "PREFIX", pattern: undefined, level: "L1", reason: undefined, priority: 100, status: "0" }
    : { ruleId: undefined, ruleName: undefined, pattern: undefined, replacement: "****", forcePrivate: "0", status: "0" }
  proxy.resetForm("ruleRef")
}

function handleAdd() {
  reset()
  open.value = true
  title.value = kind.value === "command" ? "新增命令规则" : "新增脱敏规则"
}

function handleUpdate(row) {
  reset()
  getRule(kind.value, row.ruleId).then(res => {
    form.value = res.data
    open.value = true
    title.value = kind.value === "command" ? "修改命令规则" : "修改脱敏规则"
  })
}

function submitForm() {
  proxy.$refs["ruleRef"].validate(valid => {
    if (!valid) return
    const req = form.value.ruleId != undefined ? updateRule(kind.value, form.value) : addRule(kind.value, form.value)
    req.then(() => {
      proxy.$modal.msgSuccess(form.value.ruleId != undefined ? "修改成功" : "新增成功")
      open.value = false
      getList()
    })
  })
}

function handleDelete(row) {
  const target = row ? [row.ruleId] : ids.value
  proxy.$modal.confirm("确认删除选中的 " + target.length + " 条规则？").then(() => {
    return delRule(kind.value, target.join(","))
  }).then(() => {
    getList()
    proxy.$modal.msgSuccess("删除成功")
  }).catch(() => {})
}

getList()
</script>

<style scoped>
.itm-code {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
.itm-mono :deep(input) {
  font-family: Menlo, Consolas, monospace;
}
.itm-muted {
  margin-left: 10px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.itm-try {
  width: 100%;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}
code {
  font-family: Menlo, Consolas, monospace;
}
</style>
