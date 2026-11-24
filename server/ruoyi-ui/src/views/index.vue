<template>
  <div class="app-container home">
    <div class="home-head">
      <img :src="logo" class="home-logo" alt="" />
      <div>
        <h2>iTerminal 管理后台</h2>
        <p class="home-sub">账号与权限、设备、命令审计、会话录像、定时任务、远程审批、版本发布和 AI 规则</p>
      </div>
    </div>

    <el-row :gutter="16">
      <el-col v-for="c in cards" :key="c.key" :xs="12" :sm="12" :lg="6">
        <el-card shadow="hover" class="home-card" @click="c.to && router.push(c.to)">
          <div class="home-card-label">{{ c.label }}</div>
          <div class="home-card-value" :class="c.tone">{{ c.value ?? "—" }}</div>
          <div class="home-card-hint">{{ c.hint }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16" class="home-row">
      <el-col :xs="24" :lg="12" v-if="can.approval">
        <el-card shadow="never">
          <template #header>
            <div class="home-card-header">
              <span>待处理的审批</span>
              <el-button link type="primary" @click="router.push('/iterminal/approval')">全部</el-button>
            </div>
          </template>
          <el-empty v-if="!pending.length" description="没有待处理的审批" :image-size="60" />
          <el-table v-else :data="pending" size="small" :show-header="false">
            <el-table-column min-width="200" :show-overflow-tooltip="true">
              <template #default="scope">
                <code class="itm-cmd">{{ scope.row.command }}</code>
                <div class="home-muted">{{ scope.row.taskName }} · {{ scope.row.hostName }}</div>
              </template>
            </el-table-column>
            <el-table-column width="90" align="right">
              <template #default="scope"><dict-tag :options="itm_risk_level" :value="scope.row.risk" /></template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="12" v-if="can.run">
        <el-card shadow="never">
          <template #header>
            <div class="home-card-header">
              <span>最近的定时任务执行</span>
              <el-button link type="primary" @click="router.push('/iterminal/run')">全部</el-button>
            </div>
          </template>
          <el-empty v-if="!runs.length" description="还没有执行记录" :image-size="60" />
          <el-table v-else :data="runs" size="small" :show-header="false">
            <el-table-column min-width="200" :show-overflow-tooltip="true">
              <template #default="scope">
                {{ scope.row.taskName }}
                <div class="home-muted">{{ parseTime(scope.row.startedAt) }} · {{ scope.row.summary || "" }}</div>
              </template>
            </el-table-column>
            <el-table-column width="100" align="right">
              <template #default="scope"><dict-tag :options="itm_run_status" :value="scope.row.status" /></template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup name="Index">
import logo from "@/assets/logo/logo.png"
import { checkPermi } from "@/utils/permission"
import { listDevice, listApproval, listRun, listAudit } from "@/api/iterminal"

const router = useRouter()
const { proxy } = getCurrentInstance()
const { itm_risk_level, itm_run_status } = useDict("itm_risk_level", "itm_run_status")

const can = {
  device: checkPermi(["itm:device:list"]),
  approval: checkPermi(["itm:approval:list"]),
  run: checkPermi(["itm:run:list"]),
  audit: checkPermi(["itm:audit:list"])
}
const stats = reactive({ online: null, devices: null, pending: null, runsToday: null, failedToday: null, riskToday: null })
const pending = ref([])
const runs = ref([])

const today = proxy.parseTime(new Date(), "{y}-{m}-{d}")
const todayRange = { "params[beginTime]": today, "params[endTime]": today }

const cards = computed(() => [
  can.device && { key: "online", label: "在线设备", value: stats.online, hint: "共 " + (stats.devices ?? "—") + " 台正常设备", to: "/iterminal/device", tone: "ok" },
  can.approval && { key: "pending", label: "待审批", value: stats.pending, hint: "无人值守任务等待人工确认", to: "/iterminal/approval", tone: stats.pending ? "warn" : "" },
  can.run && { key: "runs", label: "今日任务执行", value: stats.runsToday, hint: "其中失败 / 超时 " + (stats.failedToday ?? "—") + " 次", to: "/iterminal/run", tone: "" },
  can.audit && { key: "risk", label: "今日高危命令", value: stats.riskToday, hint: "命令审计里等级为高危的记录", to: "/iterminal/audit", tone: stats.riskToday ? "bad" : "" }
].filter(Boolean))

const totalOf = (p) => p.then((r) => r.total).catch(() => null)

function load() {
  if (can.device) {
    totalOf(listDevice({ pageNum: 1, pageSize: 1, online: "1", status: "0" })).then((v) => (stats.online = v))
    totalOf(listDevice({ pageNum: 1, pageSize: 1, status: "0" })).then((v) => (stats.devices = v))
  }
  if (can.approval) {
    listApproval({ pageNum: 1, pageSize: 5, status: "PENDING" }).then((r) => {
      stats.pending = r.total
      pending.value = r.rows
    })
  }
  if (can.run) {
    listRun({ pageNum: 1, pageSize: 5 }).then((r) => (runs.value = r.rows))
    totalOf(listRun({ pageNum: 1, pageSize: 1, ...todayRange })).then((v) => (stats.runsToday = v))
    Promise.all(["FAILED", "TIMEOUT"].map((s) => totalOf(listRun({ pageNum: 1, pageSize: 1, status: s, ...todayRange })))).then(([a, b]) => {
      stats.failedToday = a == null || b == null ? null : a + b
    })
  }
  if (can.audit) {
    totalOf(listAudit({ pageNum: 1, pageSize: 1, risk: "L2", ...todayRange })).then((v) => (stats.riskToday = v))
  }
}

onActivated(load)
load()
</script>

<style scoped lang="scss">
.home {
  .home-head {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 20px;
    h2 {
      margin: 0 0 4px;
      font-size: 22px;
    }
  }
  .home-logo {
    width: 52px;
    height: 52px;
    border-radius: 12px;
  }
  .home-sub,
  .home-muted {
    margin: 0;
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }
  .home-muted {
    font-size: 12px;
  }
  .home-card {
    cursor: pointer;
    margin-bottom: 16px;
  }
  .home-card-label {
    color: var(--el-text-color-secondary);
    font-size: 13px;
  }
  .home-card-value {
    font-size: 30px;
    font-weight: 600;
    margin: 6px 0 2px;
    &.ok {
      color: var(--el-color-success);
    }
    &.warn {
      color: var(--el-color-warning);
    }
    &.bad {
      color: var(--el-color-danger);
    }
  }
  .home-card-hint {
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }
  .home-row .el-card {
    margin-bottom: 16px;
  }
  .home-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .itm-cmd {
    font-family: Menlo, Consolas, monospace;
    font-size: 12px;
  }
}
</style>
