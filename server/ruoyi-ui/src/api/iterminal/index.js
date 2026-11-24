import request from '@/utils/request'

// 上传文件：默认的 JSON Content-Type 会让 axios 把 FormData 转成 JSON（文件丢失），换成 multipart 后浏览器自动带 boundary；
// 多个文件连续上传时 FormData 序列化后都是 {}，要关掉防重复提交
const MULTIPART = { 'Content-Type': 'multipart/form-data', repeatSubmit: false }

// ---------------------------------------------------------------- 设备
export function listDevice(query) {
  return request({ url: '/iterminal/device/list', method: 'get', params: query })
}
export function deviceOptions() {
  return request({ url: '/iterminal/device/options', method: 'get' })
}
export function revokeDevice(deviceId) {
  return request({ url: '/iterminal/device/' + deviceId + '/revoke', method: 'put' })
}

// ---------------------------------------------------------------- 审计
export function listAudit(query) {
  return request({ url: '/iterminal/audit/list', method: 'get', params: query })
}
export function getAudit(auditId) {
  return request({ url: '/iterminal/audit/' + auditId, method: 'get' })
}
export function listSession(query) {
  return request({ url: '/iterminal/session/list', method: 'get', params: query })
}
export function getSessionCast(recordingId) {
  return request({ url: '/iterminal/session/' + recordingId + '/cast', method: 'get', responseType: 'text', transformResponse: [(d) => d] })
}
export function delSession(recordingIds) {
  return request({ url: '/iterminal/session/' + recordingIds, method: 'delete' })
}

// ---------------------------------------------------------------- 定时任务
export function listTask(query) {
  return request({ url: '/iterminal/task/list', method: 'get', params: query })
}
export function getTask(taskId) {
  return request({ url: '/iterminal/task/' + taskId, method: 'get' })
}
export function addTask(data) {
  return request({ url: '/iterminal/task', method: 'post', data })
}
export function updateTask(data) {
  return request({ url: '/iterminal/task', method: 'put', data })
}
export function changeTaskStatus(taskId, status) {
  return request({ url: '/iterminal/task/changeStatus', method: 'put', data: { taskId, status } })
}
export function delTask(taskIds) {
  return request({ url: '/iterminal/task/' + taskIds, method: 'delete' })
}
export function runTask(taskId) {
  return request({ url: '/iterminal/task/run/' + taskId, method: 'put' })
}
export function listRun(query) {
  return request({ url: '/iterminal/run/list', method: 'get', params: query })
}
export function getRun(runId) {
  return request({ url: '/iterminal/run/' + runId, method: 'get' })
}

// ---------------------------------------------------------------- 远程审批
export function listApproval(query) {
  return request({ url: '/iterminal/approval/list', method: 'get', params: query })
}
export function decideApproval(approvalId, decision, comment) {
  return request({ url: '/iterminal/approval/' + approvalId + '/decide', method: 'put', data: { decision, comment } })
}

// ---------------------------------------------------------------- 版本发布
export function listRelease(query) {
  return request({ url: '/iterminal/release/list', method: 'get', params: query })
}
export function uploadRelease(formData, onUploadProgress) {
  return request({ url: '/iterminal/release/upload', method: 'post', data: formData, headers: MULTIPART, timeout: 30 * 60 * 1000, onUploadProgress })
}
export function updateRelease(data) {
  return request({ url: '/iterminal/release', method: 'put', data })
}
export function delRelease(releaseIds) {
  return request({ url: '/iterminal/release/' + releaseIds, method: 'delete' })
}

// ---------------------------------------------------------------- AI 规则
export function listRule(kind, query) {
  return request({ url: '/iterminal/rule/' + kind + '/list', method: 'get', params: query })
}
export function getRule(kind, ruleId) {
  return request({ url: '/iterminal/rule/' + kind + '/' + ruleId, method: 'get' })
}
export function addRule(kind, data) {
  return request({ url: '/iterminal/rule/' + kind, method: 'post', data })
}
export function updateRule(kind, data) {
  return request({ url: '/iterminal/rule/' + kind, method: 'put', data })
}
export function delRule(kind, ruleIds) {
  return request({ url: '/iterminal/rule/' + kind + '/' + ruleIds, method: 'delete' })
}

// ---------------------------------------------------------------- 通知渠道
export function listNotifyChannel(query) {
  return request({ url: '/iterminal/notify/channel/list', method: 'get', params: query })
}
export function getNotifyChannel(channelId) {
  return request({ url: '/iterminal/notify/channel/' + channelId, method: 'get' })
}
export function addNotifyChannel(data) {
  return request({ url: '/iterminal/notify/channel', method: 'post', data })
}
export function updateNotifyChannel(data) {
  return request({ url: '/iterminal/notify/channel', method: 'put', data })
}
export function delNotifyChannel(channelIds) {
  return request({ url: '/iterminal/notify/channel/' + channelIds, method: 'delete' })
}
export function testNotifyChannel(data) {
  return request({ url: '/iterminal/notify/channel/test', method: 'post', data, timeout: 60000 })
}
export function listNotifyLog(query) {
  return request({ url: '/iterminal/notify/log/list', method: 'get', params: query })
}

// ---------------------------------------------------------------- 团队模型
export function listLlmProvider(query) {
  return request({ url: '/iterminal/llm/provider/list', method: 'get', params: query })
}
export function getLlmProvider(providerId) {
  return request({ url: '/iterminal/llm/provider/' + providerId, method: 'get' })
}
export function addLlmProvider(data) {
  return request({ url: '/iterminal/llm/provider', method: 'post', data })
}
export function updateLlmProvider(data) {
  return request({ url: '/iterminal/llm/provider', method: 'put', data })
}
export function delLlmProvider(providerIds) {
  return request({ url: '/iterminal/llm/provider/' + providerIds, method: 'delete' })
}
export function testLlmProvider(data, model) {
  return request({ url: '/iterminal/llm/provider/test', method: 'post', data, params: { model }, timeout: 90000 })
}
export function fetchLlmModels(data) {
  return request({ url: '/iterminal/llm/provider/fetchModels', method: 'post', data, timeout: 60000 })
}
// 联网搜索（第二十五轮）：和团队模型无关的独立配置
export function getLlmWeb() {
  return request({ url: '/iterminal/llm/web', method: 'get' })
}
export function saveLlmWeb(data) {
  return request({ url: '/iterminal/llm/web', method: 'put', data })
}
export function testLlmWeb(data) {
  return request({ url: '/iterminal/llm/web/test', method: 'post', data, timeout: 90000 })
}
export function llmRoles() {
  return request({ url: '/iterminal/llm/roles', method: 'get' })
}
export function listLlmUsage(query) {
  return request({ url: '/iterminal/llm/usage/list', method: 'get', params: query })
}
export function llmUsageSummary(query) {
  return request({ url: '/iterminal/llm/usage/summary', method: 'get', params: query })
}

// ---------------------------------------------------------------- 团队主机
export function assetFolderTree() {
  return request({ url: '/iterminal/asset/folder/tree', method: 'get' })
}
export function addAssetFolder(data) {
  return request({ url: '/iterminal/asset/folder', method: 'post', data })
}
export function updateAssetFolder(data) {
  return request({ url: '/iterminal/asset/folder', method: 'put', data })
}
export function delAssetFolder(folderId) {
  return request({ url: '/iterminal/asset/folder/' + folderId, method: 'delete' })
}
export function listAssetHost(query) {
  return request({ url: '/iterminal/asset/host/list', method: 'get', params: query })
}
export function getAssetHost(hostId) {
  return request({ url: '/iterminal/asset/host/' + hostId, method: 'get' })
}
export function addAssetHost(data) {
  return request({ url: '/iterminal/asset/host', method: 'post', data })
}
export function updateAssetHost(data) {
  return request({ url: '/iterminal/asset/host', method: 'put', data })
}
export function delAssetHost(hostIds) {
  return request({ url: '/iterminal/asset/host/' + hostIds, method: 'delete' })
}
export function assetRoles() {
  return request({ url: '/iterminal/asset/roles', method: 'get' })
}

// ---------------------------------------------------------------- 云备份与分享（只看元数据）
export function listCloudBackup(query) {
  return request({ url: '/iterminal/cloud/backup/list', method: 'get', params: query })
}
export function listCloudShare() {
  return request({ url: '/iterminal/cloud/share/list', method: 'get' })
}
export function closeCloudShare(userId) {
  return request({ url: '/iterminal/cloud/share/' + userId, method: 'delete' })
}

// ---------------------------------------------------------------- 知识库
export function listKbCollection() {
  return request({ url: '/iterminal/kb/collection/list', method: 'get' })
}
export function addKbCollection(data) {
  return request({ url: '/iterminal/kb/collection', method: 'post', data })
}
export function updateKbCollection(data) {
  return request({ url: '/iterminal/kb/collection', method: 'put', data })
}
export function delKbCollection(collectionId) {
  return request({ url: '/iterminal/kb/collection/' + collectionId, method: 'delete' })
}
export function listKbDocument(collectionId) {
  return request({ url: '/iterminal/kb/document/list', method: 'get', params: { collectionId } })
}
export function uploadKbDocument(formData, onUploadProgress) {
  return request({ url: '/iterminal/kb/document/upload', method: 'post', data: formData, headers: MULTIPART, timeout: 10 * 60 * 1000, onUploadProgress })
}
export function addKbText(data) {
  return request({ url: '/iterminal/kb/document/text', method: 'post', data })
}
export function reindexKbDocument(documentId) {
  return request({ url: '/iterminal/kb/document/' + documentId + '/reindex', method: 'put' })
}
export function delKbDocument(documentIds) {
  return request({ url: '/iterminal/kb/document/' + documentIds, method: 'delete' })
}
export function searchKb(data) {
  return request({ url: '/iterminal/kb/search', method: 'post', data })
}
export function getKbConfig() {
  return request({ url: '/iterminal/kb/config', method: 'get' })
}
export function saveKbConfig(data) {
  return request({ url: '/iterminal/kb/config', method: 'put', data })
}
export function testKbConfig(data) {
  return request({ url: '/iterminal/kb/config/test', method: 'post', data: data || {} })
}
// 向量存储：MySQL / Milvus
export function saveKbStore(data) {
  return request({ url: '/iterminal/kb/config/store', method: 'put', data, timeout: 60 * 1000 })
}
export function testKbStore(data) {
  return request({ url: '/iterminal/kb/config/store/test', method: 'post', data, timeout: 60 * 1000 })
}
export function syncKbStore() {
  return request({ url: '/iterminal/kb/config/store/sync', method: 'post' })
}
export function kbRoles() {
  return request({ url: '/iterminal/kb/roles', method: 'get' })
}

// ---------------------------------------------------------------- 可用范围（角色 / 用户 / 组织，第十三轮）
export function grantOptions() {
  return request({ url: '/iterminal/grant/options', method: 'get' })
}

// ---------------------------------------------------------------- 单项分享（只看元数据，第十三轮）
export function listCloudLink(query) {
  return request({ url: '/iterminal/cloud/link/list', method: 'get', params: query })
}
export function revokeCloudLink(linkId) {
  return request({ url: '/iterminal/cloud/link/' + linkId, method: 'delete' })
}

// ---------------------------------------------------------------- 问题反馈（第十三轮）
export function listFeedback(query) {
  return request({ url: '/iterminal/feedback/list', method: 'get', params: query })
}
export function getFeedback(id) {
  return request({ url: '/iterminal/feedback/' + id, method: 'get' })
}
export function feedbackFile(fileId) {
  return request({ url: '/iterminal/feedback/file/' + fileId, method: 'get', responseType: 'blob' })
}
export function feedbackPrompt(id) {
  return request({ url: '/iterminal/feedback/' + id + '/prompt', method: 'get' })
}
export function updateFeedback(id, data) {
  return request({ url: '/iterminal/feedback/' + id, method: 'put', data })
}
export function analyzeFeedback(id, data) {
  return request({ url: '/iterminal/feedback/' + id + '/analyze', method: 'post', data, timeout: 5 * 60 * 1000 })
}
export function delFeedback(ids) {
  return request({ url: '/iterminal/feedback/' + ids, method: 'delete' })
}
