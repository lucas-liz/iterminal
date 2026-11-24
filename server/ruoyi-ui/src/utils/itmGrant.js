import { grantOptions } from '@/api/iterminal'

// 「可用范围」的选项（角色 / 用户 / 部门树），团队模型和知识库页共用；页面打开时取一次
let cache = null
export function loadGrantOptions(force = false) {
  if (!cache || force) {
    cache = grantOptions()
      .then((res) => res.data || { roles: [], users: [], depts: [] })
      .catch((e) => {
        cache = null
        throw e
      })
  }
  return cache
}

const split = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean)

function deptName(tree, id) {
  for (const d of tree || []) {
    if (String(d.id) === String(id)) return d.label
    const sub = deptName(d.children, id)
    if (sub) return sub
  }
  return null
}

// 列表里显示的范围：「角色：运维；用户：张三、李四；组织：研发部」，都为空时「所有人」
export function grantText(row, opts, all = '所有人') {
  const parts = []
  const roles = split(row.roleKeys ?? row.role_keys)
  const users = split(row.userIds ?? row.user_ids)
  const depts = split(row.deptIds ?? row.dept_ids)
  const o = opts || { roles: [], users: [], depts: [] }
  if (roles.length) parts.push('角色：' + roles.map((k) => (o.roles.find((r) => r.roleKey === k) || { roleName: k }).roleName).join('、'))
  if (users.length) parts.push('用户：' + users.map((id) => { const u = o.users.find((x) => String(x.userId) === id); return u ? u.nickName || u.userName : '#' + id }).join('、'))
  if (depts.length) parts.push('组织：' + depts.map((id) => deptName(o.depts, id) || '#' + id).join('、'))
  return parts.length ? parts.join('；') : all
}

export { split as splitIds }
