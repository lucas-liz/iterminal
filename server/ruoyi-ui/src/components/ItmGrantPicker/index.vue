<template>
  <div class="itm-grant">
    <div class="itm-grant-row">
      <span class="itm-grant-label">角色</span>
      <el-select :model-value="roles" multiple clearable filterable collapse-tags collapse-tags-tooltip :max-collapse-tags="4" placeholder="不限" style="flex: 1" @update:model-value="(v) => emit('update:roles', v)">
        <el-option v-for="r in opts.roles" :key="r.roleKey" :label="r.roleName + '（' + r.roleKey + '）'" :value="r.roleKey" />
      </el-select>
    </div>
    <div class="itm-grant-row">
      <span class="itm-grant-label">用户</span>
      <el-select :model-value="users" multiple clearable filterable collapse-tags collapse-tags-tooltip :max-collapse-tags="4" placeholder="不限（可以输入账号或昵称搜索）" style="flex: 1" @update:model-value="(v) => emit('update:users', v)">
        <el-option v-for="u in opts.users" :key="u.userId" :label="(u.nickName || u.userName) + '（' + u.userName + (u.deptName ? ' · ' + u.deptName : '') + '）'" :value="String(u.userId)" />
      </el-select>
    </div>
    <div class="itm-grant-row">
      <span class="itm-grant-label">组织</span>
      <el-tree-select
        :model-value="depts"
        :data="opts.depts"
        :props="{ value: 'id', label: 'label', children: 'children' }"
        value-key="id"
        multiple
        check-strictly
        show-checkbox
        clearable
        filterable
        collapse-tags
        collapse-tags-tooltip
        :max-collapse-tags="4"
        node-key="id"
        placeholder="不限（包含所选部门的下级部门）"
        style="flex: 1"
        @update:model-value="(v) => emit('update:depts', (v || []).map(String))"
      />
    </div>
    <div class="itm-grant-hint">{{ hint }}</div>
  </div>
</template>

<script setup>
// 可用范围选择（第十三轮）：角色 / 用户 / 组织任意满足一项即可使用；三项都不选表示所有人；组织包含下级部门；管理员始终可用
import { computed, ref } from 'vue'
import { loadGrantOptions } from '@/utils/itmGrant'

const props = defineProps({
  roles: { type: Array, default: () => [] },
  users: { type: Array, default: () => [] },
  depts: { type: Array, default: () => [] },
  allText: { type: String, default: '所有登录用户都能使用' },
})
const emit = defineEmits(['update:roles', 'update:users', 'update:depts'])
const opts = ref({ roles: [], users: [], depts: [] })
loadGrantOptions().then((o) => {
  // 部门 ID 统一成字符串（和保存的值一致）
  const fix = (list) => (list || []).map((d) => ({ ...d, id: String(d.id), children: fix(d.children) }))
  opts.value = { ...o, depts: fix(o.depts) }
})
const hint = computed(() => (props.roles.length || props.users.length || props.depts.length ? '满足任意一项即可使用；选了组织时包含它的下级部门；管理员始终可用' : props.allText))
</script>

<style scoped>
.itm-grant { width: 100%; display: flex; flex-direction: column; gap: 6px; }
.itm-grant-row { display: flex; align-items: center; gap: 8px; }
.itm-grant-label { width: 32px; color: var(--el-text-color-secondary); font-size: 13px; flex: none; }
.itm-grant-hint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
</style>
