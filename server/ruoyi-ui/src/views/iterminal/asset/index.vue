<template>
  <div class="app-container">
    <el-row :gutter="16">
      <!-- 分组树 -->
      <el-col :span="6" :xs="24">
        <div class="itm-tree-head">
          <span>分组</span>
          <el-button link type="primary" icon="Plus" @click="handleAddFolder()" v-hasPermi="['itm:asset:add']">新增分组</el-button>
        </div>
        <el-tree
          ref="treeRef"
          :data="treeData"
          node-key="folderId"
          :props="{ label: 'folderName', children: 'children' }"
          highlight-current
          default-expand-all
          :expand-on-click-node="false"
          @node-click="onFolder"
          class="itm-tree"
        >
          <template #default="{ data }">
            <span class="itm-tree-node">
              <span class="itm-tree-label">
                <el-icon><Folder /></el-icon>
                {{ data.folderName }}
                <el-tooltip v-if="data.roleKeys" :content="'可见角色：' + roleNames(data.roleKeys)"><el-icon class="itm-lock"><Lock /></el-icon></el-tooltip>
              </span>
              <span class="itm-tree-ops" @click.stop>
                <el-dropdown trigger="click" @command="(c) => onFolderCommand(c, data)">
                  <el-icon class="itm-more"><MoreFilled /></el-icon>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="add" v-if="checkPermi(['itm:asset:add'])">新增下级分组</el-dropdown-item>
                      <el-dropdown-item command="edit" v-if="checkPermi(['itm:asset:edit'])">修改</el-dropdown-item>
                      <el-dropdown-item command="remove" v-if="checkPermi(['itm:asset:remove'])" divided>删除</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </span>
            </span>
          </template>
        </el-tree>
        <div class="itm-all" :class="{ active: queryParams.folderId === undefined }" @click="showAll">全部主机</div>
      </el-col>

      <!-- 主机 -->
      <el-col :span="18" :xs="24">
        <el-alert type="info" :closable="false" class="mb8">
          <template #title>
            登录后客户端自动同步自己能看到的主机（含密码 / 私钥）到「团队主机」分组，只读；没开启「允许查看密码」时客户端不能显示和复制密码。
            可见范围：主机设置了角色时按主机，否则按分组（逐级向上），都没设置时所有人可见。
          </template>
        </el-alert>
        <el-form :model="queryParams" ref="queryRef" :inline="true">
          <el-form-item label="名称 / 地址" prop="hostName">
            <el-input v-model="queryParams.hostName" placeholder="搜索" clearable style="width: 200px" @keyup.enter="getList" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" icon="Search" @click="getList">搜索</el-button>
            <el-button type="primary" plain icon="Plus" @click="handleAdd" v-hasPermi="['itm:asset:add']">新增主机</el-button>
            <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDelete()" v-hasPermi="['itm:asset:remove']">删除</el-button>
          </el-form-item>
        </el-form>
        <el-table v-loading="loading" :data="list" @selection-change="(rows) => (ids = rows.map((r) => r.hostId))">
          <el-table-column type="selection" width="50" align="center" />
          <el-table-column label="名称" prop="hostName" min-width="140" :show-overflow-tooltip="true" />
          <el-table-column label="地址" min-width="160" :show-overflow-tooltip="true">
            <template #default="scope">{{ scope.row.address }}:{{ scope.row.port }}</template>
          </el-table-column>
          <el-table-column label="用户" prop="username" width="100" />
          <el-table-column label="协议" prop="protocol" width="80" align="center" />
          <el-table-column label="认证" width="110" align="center">
            <template #default="scope">
              {{ AUTH[scope.row.authMethod] }}
              <el-tag v-if="scope.row.authMethod === 'PASSWORD' && !scope.row.password" size="small" type="warning" disable-transitions>未设置</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="查看密码" width="90" align="center">
            <template #default="scope">{{ scope.row.allowReveal === "1" ? "允许" : "不允许" }}</template>
          </el-table-column>
          <el-table-column label="可见角色" min-width="120" :show-overflow-tooltip="true">
            <template #default="scope">{{ scope.row.roleKeys ? roleNames(scope.row.roleKeys) : "按分组" }}</template>
          </el-table-column>
          <el-table-column label="分组" min-width="110" :show-overflow-tooltip="true">
            <template #default="scope">{{ folderName(scope.row.folderId) }}</template>
          </el-table-column>
          <el-table-column label="启用" width="70" align="center">
            <template #default="scope">
              <el-switch v-model="scope.row.status" active-value="0" inactive-value="1" @change="handleStatusChange(scope.row)" />
            </template>
          </el-table-column>
          <el-table-column label="操作" align="center" width="110" class-name="small-padding fixed-width">
            <template #default="scope">
              <el-button link type="primary" icon="Edit" @click="handleUpdate(scope.row)" v-hasPermi="['itm:asset:edit']" />
              <el-button link type="danger" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="['itm:asset:remove']" />
            </template>
          </el-table-column>
        </el-table>
        <pagination v-show="total > 0" :total="total" v-model:page="queryParams.pageNum" v-model:limit="queryParams.pageSize" @pagination="getList" />
      </el-col>
    </el-row>

    <!-- 分组 -->
    <el-dialog :title="folderTitle" v-model="folderOpen" width="520px" append-to-body>
      <el-form ref="folderRef" :model="folderForm" :rules="folderRules" label-width="90px">
        <el-form-item label="上级分组">
          <el-tree-select v-model="folderForm.parentId" :data="[{ folderId: 0, folderName: '（顶层）', children: treeData }]" :props="{ label: 'folderName', value: 'folderId', children: 'children' }" check-strictly style="width: 100%" />
        </el-form-item>
        <el-form-item label="名称" prop="folderName">
          <el-input v-model="folderForm.folderName" maxlength="100" />
        </el-form-item>
        <el-form-item label="可见角色">
          <el-select v-model="folderForm.roleList" multiple clearable placeholder="不选时继承上级（顶层不选表示所有人可见）" style="width: 100%">
            <el-option v-for="r in roles" :key="r.roleKey" :label="r.roleName" :value="r.roleKey" />
          </el-select>
        </el-form-item>
        <el-form-item label="显示顺序">
          <el-input-number v-model="folderForm.sort" :min="0" controls-position="right" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="submitFolder">确 定</el-button>
        <el-button @click="folderOpen = false">取 消</el-button>
      </template>
    </el-dialog>

    <!-- 主机 -->
    <el-dialog :title="title" v-model="open" width="680px" append-to-body>
      <el-form ref="hostRef" :model="form" :rules="rules" label-width="110px">
        <el-row>
          <el-col :span="12">
            <el-form-item label="名称" prop="hostName">
              <el-input v-model="form.hostName" maxlength="100" placeholder="客户端显示的名称" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="分组">
              <el-tree-select v-model="form.folderId" :data="[{ folderId: 0, folderName: '（顶层）', children: treeData }]" :props="{ label: 'folderName', value: 'folderId', children: 'children' }" check-strictly style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="协议">
              <el-radio-group v-model="form.protocol" @change="(v) => (form.port = v === 'TELNET' ? 23 : 22)">
                <el-radio-button value="SSH">SSH</el-radio-button>
                <el-radio-button value="TELNET">Telnet</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="用户名" prop="username">
              <el-input v-model="form.username" placeholder="root" />
            </el-form-item>
          </el-col>
          <el-col :span="16">
            <el-form-item label="地址" prop="address">
              <el-input v-model="form.address" placeholder="IP 或域名" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="端口" prop="port" label-width="60px">
              <el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="24" v-if="form.protocol === 'SSH'">
            <el-form-item label="认证方式">
              <el-radio-group v-model="form.authMethod">
                <el-radio value="PASSWORD">密码</el-radio>
                <el-radio value="KEY">私钥</el-radio>
                <el-radio value="INTERACTIVE">连接时询问</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="24" v-if="form.authMethod === 'PASSWORD' || form.protocol === 'TELNET'">
            <el-form-item label="密码">
              <el-input v-model="form.password" type="password" show-password autocomplete="new-password" :placeholder="form.hostId ? '不修改请保持 ******' : '加密保存在服务端'" />
            </el-form-item>
          </el-col>
          <template v-if="form.authMethod === 'KEY' && form.protocol === 'SSH'">
            <el-col :span="24">
              <el-form-item label="私钥">
                <el-input v-model="form.privateKey" type="textarea" :rows="4" class="itm-mono" :placeholder="form.hostId ? '不修改请保持 ******' : '-----BEGIN OPENSSH PRIVATE KEY-----'" />
              </el-form-item>
            </el-col>
            <el-col :span="24">
              <el-form-item label="私钥口令">
                <el-input v-model="form.passphrase" type="password" show-password autocomplete="new-password" placeholder="没有可以不填" />
              </el-form-item>
            </el-col>
          </template>
          <el-col :span="12">
            <el-form-item label="允许查看密码">
              <el-switch v-model="form.allowReveal" active-value="1" inactive-value="0" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="状态">
              <el-radio-group v-model="form.status">
                <el-radio value="0">启用</el-radio>
                <el-radio value="1">停用</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="可见角色">
              <el-select v-model="form.roleList" multiple clearable placeholder="不选时按分组" style="width: 100%">
                <el-option v-for="r in roles" :key="r.roleKey" :label="r.roleName" :value="r.roleKey" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="form.note" type="textarea" :rows="2" maxlength="1000" placeholder="客户端显示（例如用途、注意事项）" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button type="primary" @click="submitForm">确 定</el-button>
        <el-button @click="open = false">取 消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup name="ItmAsset">
import { assetFolderTree, addAssetFolder, updateAssetFolder, delAssetFolder, listAssetHost, getAssetHost, addAssetHost, updateAssetHost, delAssetHost, assetRoles } from "@/api/iterminal"
import { checkPermi } from "@/utils/permission"

const { proxy } = getCurrentInstance()
const AUTH = { PASSWORD: "密码", KEY: "私钥", INTERACTIVE: "连接时询问" }

const treeData = ref([])
const roles = ref([])
const list = ref([])
const loading = ref(true)
const total = ref(0)
const ids = ref([])
const open = ref(false)
const title = ref("")
const form = ref({})
const folderOpen = ref(false)
const folderTitle = ref("")
const folderForm = ref({})
const queryParams = ref({ pageNum: 1, pageSize: 20, folderId: undefined, hostName: undefined })

const rules = {
  hostName: [{ required: true, message: "请填写名称", trigger: "blur" }],
  address: [{ required: true, message: "请填写地址", trigger: "blur" }],
  port: [{ required: true, message: "请填写端口", trigger: "blur" }]
}
const folderRules = { folderName: [{ required: true, message: "请填写名称", trigger: "blur" }] }

const flat = (nodes) => nodes.flatMap((n) => [n, ...flat(n.children || [])])
const folderName = (id) => (id ? (flat(treeData.value).find((f) => f.folderId === id) || { folderName: id }).folderName : "（顶层）")
const roleNames = (keys) => (keys || "").split(",").filter(Boolean).map((k) => (roles.value.find((r) => r.roleKey === k) || { roleName: k }).roleName).join("、")

function loadTree() {
  return assetFolderTree().then(res => {
    treeData.value = res.data || []
  })
}

function getList() {
  loading.value = true
  listAssetHost(queryParams.value).then(res => {
    list.value = res.rows
    total.value = res.total
    loading.value = false
  })
}

function onFolder(data) {
  queryParams.value.folderId = data.folderId
  queryParams.value.pageNum = 1
  getList()
}

function showAll() {
  queryParams.value.folderId = undefined
  proxy.$refs.treeRef.setCurrentKey(null)
  getList()
}

function handleAddFolder(parent) {
  folderForm.value = { folderId: undefined, parentId: parent ? parent.folderId : 0, folderName: "", roleList: [], sort: 0 }
  folderTitle.value = "新增分组"
  folderOpen.value = true
}

function onFolderCommand(cmd, data) {
  if (cmd === "add") handleAddFolder(data)
  else if (cmd === "edit") {
    folderForm.value = { folderId: data.folderId, parentId: data.parentId || 0, folderName: data.folderName, roleList: (data.roleKeys || "").split(",").filter(Boolean), sort: data.sort }
    folderTitle.value = "修改分组"
    folderOpen.value = true
  } else if (cmd === "remove") {
    proxy.$modal.confirm("确认删除分组「" + data.folderName + "」？").then(() => delAssetFolder(data.folderId)).then(() => {
      proxy.$modal.msgSuccess("删除成功")
      loadTree()
    }).catch(() => {})
  }
}

function submitFolder() {
  proxy.$refs["folderRef"].validate(valid => {
    if (!valid) return
    const body = { folderId: folderForm.value.folderId, parentId: folderForm.value.parentId || 0, folderName: folderForm.value.folderName, roleKeys: folderForm.value.roleList.join(","), sort: folderForm.value.sort }
    const req = body.folderId ? updateAssetFolder(body) : addAssetFolder(body)
    req.then(() => {
      proxy.$modal.msgSuccess("保存成功")
      folderOpen.value = false
      loadTree()
    })
  })
}

function reset() {
  form.value = { hostId: undefined, folderId: queryParams.value.folderId || 0, hostName: "", protocol: "SSH", address: "", port: 22, username: "root", authMethod: "PASSWORD", password: "", privateKey: "", passphrase: "", allowReveal: "0", status: "0", roleList: [], note: "" }
  proxy.resetForm("hostRef")
}

function handleAdd() {
  reset()
  open.value = true
  title.value = "新增团队主机"
}

function handleUpdate(row) {
  reset()
  getAssetHost(row.hostId).then(res => {
    form.value = { ...res.data, roleList: (res.data.roleKeys || "").split(",").filter(Boolean) }
    open.value = true
    title.value = "修改团队主机"
  })
}

function submitForm() {
  proxy.$refs["hostRef"].validate(valid => {
    if (!valid) return
    const body = { ...form.value, roleKeys: form.value.roleList.join(",") }
    delete body.roleList
    const req = body.hostId ? updateAssetHost(body) : addAssetHost(body)
    req.then(() => {
      proxy.$modal.msgSuccess(body.hostId ? "修改成功" : "新增成功")
      open.value = false
      getList()
      loadTree()
    })
  })
}

function handleStatusChange(row) {
  updateAssetHost({ ...row }).then(() => {
    proxy.$modal.msgSuccess(row.status === "0" ? "已启用" : "已停用")
  }).catch(() => {
    row.status = row.status === "0" ? "1" : "0"
  })
}

function handleDelete(row) {
  const target = row ? [row.hostId] : ids.value
  proxy.$modal.confirm("确认删除选中的 " + target.length + " 台团队主机？客户端下次同步时会删除。").then(() => {
    return delAssetHost(target.join(","))
  }).then(() => {
    getList()
    loadTree()
    proxy.$modal.msgSuccess("删除成功")
  }).catch(() => {})
}

assetRoles().then(res => {
  roles.value = res.data || []
})
loadTree()
getList()
</script>

<style scoped>
.itm-tree-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
  margin-bottom: 8px;
}
.itm-tree-node {
  flex: 1;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-right: 6px;
}
.itm-tree-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.itm-lock {
  color: var(--el-color-warning);
}
.itm-more {
  cursor: pointer;
  color: var(--el-text-color-secondary);
}
.itm-all {
  margin-top: 6px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
}
.itm-all.active,
.itm-all:hover {
  background: var(--el-fill-color-light);
}
.itm-mono :deep(textarea) {
  font-family: Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
