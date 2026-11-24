<template>
  <div class="app-container">
    <el-alert type="info" :closable="false" class="mb8">
      <template #title>
        云备份和分享内容在客户端用同步密码 / 分享码加密，服务端只保存密文：这里只能看到数量、平台、大小等元数据，不能下载内容、也看不到分享码。
        保留份数、是否允许凭证上云、是否允许分享码在「系统管理 → 参数设置」里修改（<code>itm.backup.*</code>、<code>itm.sync.*</code>、<code>itm.share.*</code>）。
      </template>
    </el-alert>
    <el-tabs v-model="tab">
      <el-tab-pane label="云备份记录" name="backup" />
      <el-tab-pane label="个人分享码" name="share" />
      <el-tab-pane label="单项分享" name="link" />
    </el-tabs>

    <template v-if="tab === 'backup'">
      <el-form :inline="true">
        <el-form-item label="用户">
          <el-input v-model="userName" placeholder="用户账号" clearable style="width: 180px" @keyup.enter="getBackups" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" icon="Search" @click="getBackups">搜索</el-button>
        </el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="backups">
        <el-table-column label="上传时间" width="170">
          <template #default="scope">{{ parseTime(scope.row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="用户" prop="user_name" width="130" />
        <el-table-column label="内容" min-width="260">
          <template #default="scope">{{ countsText(scope.row.data_groups, scope.row.item_counts) }}</template>
        </el-table-column>
        <el-table-column label="大小" width="100" align="right">
          <template #default="scope">{{ size(scope.row.size) }}</template>
        </el-table-column>
        <el-table-column label="来源" min-width="200" :show-overflow-tooltip="true">
          <template #default="scope">{{ scope.row.device_name }} · {{ scope.row.platform }} v{{ scope.row.client_version }}</template>
        </el-table-column>
        <el-table-column label="格式" width="70" align="center">
          <template #default="scope">V{{ scope.row.format_version }}</template>
        </el-table-column>
        <el-table-column label="置顶" width="70" align="center">
          <template #default="scope">{{ scope.row.pinned === "1" ? "是" : "" }}</template>
        </el-table-column>
        <el-table-column label="备注" prop="remark" min-width="120" :show-overflow-tooltip="true" />
      </el-table>
      <div class="itm-muted" style="margin-top: 8px">最多显示最近 500 条</div>
    </template>

    <template v-else-if="tab === 'link'">
      <el-form :inline="true">
        <el-form-item label="用户">
          <el-input v-model="userName" placeholder="用户账号" clearable style="width: 180px" @keyup.enter="getLinks" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" icon="Search" @click="getLinks">搜索</el-button>
        </el-form-item>
      </el-form>
      <el-table v-loading="loading" :data="links">
        <el-table-column label="创建时间" width="170">
          <template #default="scope">{{ parseTime(scope.row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="分享者" prop="user_name" width="120" />
        <el-table-column label="标题" prop="title" min-width="160" :show-overflow-tooltip="true" />
        <el-table-column label="内容" min-width="220">
          <template #default="scope">{{ countsText(scope.row.data_groups, scope.row.item_counts) }}</template>
        </el-table-column>
        <el-table-column label="大小" width="90" align="right">
          <template #default="scope">{{ size(scope.row.content_size) }}</template>
        </el-table-column>
        <el-table-column label="有效期至" width="170">
          <template #default="scope">{{ scope.row.expires_at ? parseTime(scope.row.expires_at) : "永久" }}</template>
        </el-table-column>
        <el-table-column label="拉取" width="90" align="right">
          <template #default="scope">{{ scope.row.pull_count }}{{ scope.row.max_pulls > 0 ? " / " + scope.row.max_pulls : "" }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90" align="center">
          <template #default="scope">
            <el-tag :type="linkState(scope.row).type" disable-transitions>{{ linkState(scope.row).label }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" align="center" width="100">
          <template #default="scope">
            <el-button v-if="scope.row.status === '0'" link type="danger" icon="CircleClose" @click="handleRevoke(scope.row)" v-hasPermi="['itm:cloud:remove']">撤销</el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="itm-muted" style="margin-top: 8px">最多显示最近 500 条；撤销后分享码立即失效，云端的分享内容一起删除</div>
    </template>

    <template v-else>
      <el-table v-loading="loading" :data="shares">
        <el-table-column label="用户" prop="user_name" width="140" />
        <el-table-column label="状态" width="90" align="center">
          <template #default="scope">
            <el-tag :type="scope.row.enabled === '1' ? 'success' : 'info'" disable-transitions>{{ scope.row.enabled === "1" ? "分享中" : "已暂停" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="分享范围" min-width="160">
          <template #default="scope">{{ groupsText(scope.row.data_groups) }}</template>
        </el-table-column>
        <el-table-column label="当前分享内容" min-width="180">
          <template #default="scope">
            <span v-if="scope.row.content_groups">{{ groupsText(scope.row.content_groups) }} · {{ size(scope.row.content_size) }}</span>
            <span v-else class="itm-muted">还没有上传</span>
          </template>
        </el-table-column>
        <el-table-column label="内容更新" width="170">
          <template #default="scope">{{ parseTime(scope.row.content_updated_at) || "—" }}</template>
        </el-table-column>
        <el-table-column label="被拉取" width="80" align="right" prop="pull_count" />
        <el-table-column label="最近拉取" width="170">
          <template #default="scope">{{ parseTime(scope.row.last_pulled_at) || "—" }}</template>
        </el-table-column>
        <el-table-column label="开启时间" width="170">
          <template #default="scope">{{ parseTime(scope.row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="操作" align="center" width="110">
          <template #default="scope">
            <el-button link type="danger" icon="CircleClose" @click="handleClose(scope.row)" v-hasPermi="['itm:cloud:remove']">强制关闭</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>
  </div>
</template>

<script setup name="ItmCloud">
import { listCloudBackup, listCloudShare, closeCloudShare, listCloudLink, revokeCloudLink } from "@/api/iterminal"

const { proxy } = getCurrentInstance()
const GROUP = { HOSTS: "主机", SNIPPETS: "快捷命令", NOTES: "笔记", SKILLS: "Skill", CREDENTIALS: "凭证" }
const ITEMS = [["HOSTS", "hosts", "hostGroups"], ["SNIPPETS", "snippets", "snippetGroups"], ["NOTES", "notes", "noteGroups"], ["SKILLS", "skills", null], ["CREDENTIALS", "credentials", null]]

const tab = ref("backup")
const loading = ref(false)
const userName = ref("")
const backups = ref([])
const shares = ref([])
const links = ref([])

const size = (n) => (n == null ? "—" : n < 1024 ? n + " B" : n < 1024 * 1024 ? (n / 1024).toFixed(1) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB")
const groupsText = (s) => (s || "").split(",").filter(Boolean).map((g) => GROUP[g] || g).join("、")
/** 主机 3（分组 1）· 笔记 2 */
const countsText = (groups, countsJson) => {
  let c = {}
  try {
    c = JSON.parse(countsJson || "{}")
  } catch {
    c = {}
  }
  const gs = (groups || "").split(",")
  return ITEMS.filter(([g]) => gs.includes(g)).map(([g, main, sub]) => GROUP[g] + " " + (c[main] ?? 0) + (sub ? "（分组 " + (c[sub] ?? 0) + "）" : "")).join(" · ")
}

function getBackups() {
  loading.value = true
  listCloudBackup({ userName: userName.value || undefined }).then(res => {
    backups.value = res.data || []
  }).finally(() => {
    loading.value = false
  })
}

function getShares() {
  loading.value = true
  listCloudShare().then(res => {
    shares.value = res.data || []
  }).finally(() => {
    loading.value = false
  })
}

function handleClose(row) {
  proxy.$modal.confirm("强制关闭「" + row.user_name + "」的分享码？分享码立即失效，云端的分享内容一起删除。").then(() => closeCloudShare(row.user_id)).then(() => {
    proxy.$modal.msgSuccess("已关闭")
    getShares()
  }).catch(() => {})
}

function getLinks() {
  loading.value = true
  listCloudLink({ userName: userName.value || undefined }).then(res => {
    links.value = res.data || []
  }).finally(() => {
    loading.value = false
  })
}

const linkState = (r) => {
  if (r.status === "1") return { label: "已撤销", type: "info" }
  if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) return { label: "已过期", type: "info" }
  if (r.max_pulls > 0 && r.pull_count >= r.max_pulls) return { label: "已拉满", type: "warning" }
  return { label: "有效", type: "success" }
}

function handleRevoke(row) {
  proxy.$modal.confirm("撤销「" + row.user_name + "」的单项分享「" + row.title + "」？分享码立即失效，云端的分享内容一起删除。").then(() => revokeCloudLink(row.link_id)).then(() => {
    proxy.$modal.msgSuccess("已撤销")
    getLinks()
  }).catch(() => {})
}

watch(tab, (v) => (v === "backup" ? getBackups() : v === "link" ? getLinks() : getShares()))
getBackups()
</script>

<style scoped>
.itm-muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
code {
  font-family: Menlo, Consolas, monospace;
}
</style>
