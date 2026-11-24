<template>
  <div class="app-container">
    <el-tabs v-model="tab">
      <el-tab-pane label="模型配置" name="provider" />
      <el-tab-pane label="联网搜索" name="web" />
      <el-tab-pane label="用量统计" name="summary" />
      <el-tab-pane label="调用记录" name="usage" />
    </el-tabs>

    <!-- 模型配置 -->
    <template v-if="tab === 'provider'">
      <el-alert type="info" :closable="false" class="mb8">
        <template #title>
          客户端登录后在模型列表里看到「团队」模型，用登录令牌通过服务端调用，API Key 只保存在服务端（加密）、不会下发。
          限流和额度在「系统管理 → 参数设置」：<code>itm.llm.rpm</code>（每人每分钟请求数）、<code>itm.llm.dailyTokenLimit</code>（每人每天 token）、<code>itm.ai.allowPersonalProvider</code>（是否还允许用自己的模型）。
        </template>
      </el-alert>
      <el-row :gutter="10" class="mb8">
        <el-col :span="1.5">
          <el-button type="primary" plain icon="Plus" @click="handleAdd" v-hasPermi="['itm:llm:add']">新增</el-button>
        </el-col>
        <el-col :span="1.5">
          <el-button type="danger" plain icon="Delete" :disabled="!ids.length" @click="handleDelete()" v-hasPermi="['itm:llm:remove']">删除</el-button>
        </el-col>
        <right-toolbar :search="false" @queryTable="getList"></right-toolbar>
      </el-row>
      <el-table v-loading="loading" :data="list" @selection-change="(rows) => (ids = rows.map((r) => r.providerId))">
        <el-table-column type="selection" width="50" align="center" />
        <el-table-column label="名称" prop="providerName" min-width="140" :show-overflow-tooltip="true" />
        <el-table-column label="协议" width="120" align="center">
          <template #default="scope"><dict-tag :options="itm_llm_type" :value="scope.row.providerType" /></template>
        </el-table-column>
        <el-table-column label="接口地址" prop="baseUrl" min-width="220" :show-overflow-tooltip="true" />
        <el-table-column label="模型" min-width="220">
          <template #default="scope">
            <el-tag v-for="m in parseModels(scope.row.models)" :key="m.id" size="small" class="itm-tag" disable-transitions>{{ m.displayName || m.id }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Key" width="80" align="center">
          <template #default="scope">
            <el-tag :type="scope.row.apiKey ? 'success' : 'info'" size="small" disable-transitions>{{ scope.row.apiKey ? "已设置" : "未设置" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="可用范围" min-width="180" :show-overflow-tooltip="true">
          <template #default="scope">{{ grantText(scope.row, grantOpts) }}</template>
        </el-table-column>
        <el-table-column label="启用" width="80" align="center">
          <template #default="scope">
            <el-switch v-model="scope.row.status" active-value="0" inactive-value="1" @change="handleStatusChange(scope.row)" />
          </template>
        </el-table-column>
        <el-table-column label="操作" align="center" width="160" class-name="small-padding fixed-width">
          <template #default="scope">
            <el-tooltip content="测试连接" placement="top">
              <el-button link type="primary" icon="Connection" @click="handleTest(scope.row)" v-hasPermi="['itm:llm:test']" />
            </el-tooltip>
            <el-tooltip content="修改" placement="top">
              <el-button link type="primary" icon="Edit" @click="handleUpdate(scope.row)" v-hasPermi="['itm:llm:edit']" />
            </el-tooltip>
            <el-tooltip content="删除" placement="top">
              <el-button link type="danger" icon="Delete" @click="handleDelete(scope.row)" v-hasPermi="['itm:llm:remove']" />
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <!-- 联网搜索（第二十五轮）：独立的工具，和团队模型无关 -->
    <template v-else-if="tab === 'web'">
      <el-alert type="info" :closable="false" class="mb8">
        <template #title>
          客户端输入框打开「联网」后，AI 可以搜索和读取公开网页。客户端默认使用这里的配置：经服务端调用，API Key 加密保存在服务端、不会下发；用户也可以在客户端改用自己的 Key。
          按次计费（DeepSeek Search / Fetch 各 0.75 美元 / 千次），每个用户的次数限制见下面的「每人每天」，同时受 <code>itm.llm.rpm</code>（每人每分钟请求数）限制。
        </template>
      </el-alert>
      <el-form ref="webRef" :model="web" label-width="130px" style="max-width: 760px" v-loading="webLoading">
        <el-form-item label="启用">
          <el-switch v-model="web.enabled" />
        </el-form-item>
        <el-form-item label="接口格式">
          <el-radio-group v-model="web.format">
            <el-radio-button value="deepseek">DeepSeek</el-radio-button>
            <el-radio-button value="custom">自定义</el-radio-button>
          </el-radio-group>
          <div class="itm-muted itm-block">{{ web.format === "custom" ? "DeepSeek 风格的接口：请求体同时带 query / text_query、count / limit，返回 results / search_results / data 都能识别（例如 Kimi 的 /v1/tools/search）" : "DeepSeek 的 Search / Fetch 接口：POST /v1/tools/search、/v1/tools/fetch，使用 DeepSeek API Key" }}</div>
        </el-form-item>
        <el-form-item v-if="web.format === 'deepseek'" label="根地址">
          <el-input v-model="web.baseUrl" placeholder="留空使用 https://api.deepseek.com" />
        </el-form-item>
        <template v-else>
          <el-form-item label="搜索接口地址">
            <el-input v-model="web.searchUrl" placeholder="https://api.moonshot.cn/v1/tools/search" />
          </el-form-item>
          <el-form-item label="网页读取接口地址">
            <el-input v-model="web.fetchUrl" placeholder="可选：留空时客户端只能搜索、不能读取网页" />
          </el-form-item>
        </template>
        <el-form-item label="API Key">
          <el-input v-model="web.apiKey" type="password" show-password autocomplete="new-password" placeholder="不修改请保持 ******" />
        </el-form-item>
        <el-form-item label="显示名称">
          <el-input v-model="web.label" maxlength="30" placeholder="客户端显示的名称，留空显示 DeepSeek / 自定义搜索" />
        </el-form-item>
        <el-form-item label="每次条数">
          <el-input-number v-model="web.count" :min="1" :max="20" controls-position="right" />
        </el-form-item>
        <el-form-item label="每人每天">
          <el-input-number v-model="web.dailyLimit" :min="0" :step="100" controls-position="right" />
          <span class="itm-muted" style="margin-left: 8px">次（搜索和读取网页都算一次，0 表示不限制）</span>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="saveWeb" v-hasPermi="['itm:llm:edit']">保 存</el-button>
          <el-button :loading="webTesting" @click="testWeb" v-hasPermi="['itm:llm:test']">搜一下试试</el-button>
        </el-form-item>
        <el-form-item v-if="webResult" label="测试结果">
          <div>
            <div>{{ webResult.elapsedMs }} ms · {{ webResult.results.length }} 条结果</div>
            <div v-for="r in webResult.results" :key="r.url" class="itm-muted"><a :href="r.url" target="_blank" rel="noreferrer">{{ r.title }}</a></div>
          </div>
        </el-form-item>
      </el-form>
    </template>

    <!-- 用量统计 / 调用记录 -->
    <template v-else>
      <el-form :model="usageQuery" ref="usageQueryRef" :inline="true">
        <el-form-item label="用户" prop="userName">
          <el-input v-model="usageQuery.userName" placeholder="用户账号" clearable style="width: 140px" @keyup.enter="getUsage(true)" />
        </el-form-item>
        <el-form-item label="模型" prop="providerId">
          <el-select v-model="usageQuery.providerId" placeholder="全部" clearable style="width: 160px">
            <el-option v-for="p in list" :key="p.providerId" :label="p.providerName" :value="p.providerId" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="tab === 'usage'" label="结果" prop="status">
          <el-select v-model="usageQuery.status" placeholder="全部" clearable style="width: 100px">
            <el-option label="成功" value="0" />
            <el-option label="失败" value="1" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间">
          <el-date-picker v-model="usageRange" value-format="YYYY-MM-DD" type="daterange" range-separator="-" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" icon="Search" @click="getUsage(true)">搜索</el-button>
          <el-button icon="Refresh" @click="resetUsage">重置</el-button>
        </el-form-item>
      </el-form>
      <el-table v-if="tab === 'summary'" v-loading="usageLoading" :data="usage">
        <el-table-column label="用户" prop="userName" width="140" />
        <el-table-column label="提供商" prop="providerName" min-width="140" :show-overflow-tooltip="true" />
        <el-table-column label="模型" prop="model" min-width="160" :show-overflow-tooltip="true" />
        <el-table-column label="请求数" prop="requests" width="90" align="right" />
        <el-table-column label="失败" prop="failures" width="80" align="right" />
        <el-table-column label="输入 token" width="120" align="right">
          <template #default="scope">{{ num(scope.row.inputTokens) }}</template>
        </el-table-column>
        <el-table-column label="输出 token" width="120" align="right">
          <template #default="scope">{{ num(scope.row.outputTokens) }}</template>
        </el-table-column>
        <el-table-column label="合计" width="120" align="right">
          <template #default="scope"><b>{{ num(Number(scope.row.inputTokens) + Number(scope.row.outputTokens)) }}</b></template>
        </el-table-column>
        <el-table-column label="最后使用" width="170">
          <template #default="scope">{{ parseTime(scope.row.lastUsedAt) }}</template>
        </el-table-column>
      </el-table>
      <el-table v-else v-loading="usageLoading" :data="usage">
        <el-table-column label="时间" prop="createdAt" width="170" />
        <el-table-column label="用户" prop="userName" width="110" />
        <el-table-column label="提供商" prop="providerName" min-width="130" :show-overflow-tooltip="true" />
        <el-table-column label="模型" prop="model" min-width="150" :show-overflow-tooltip="true" />
        <el-table-column label="输入" width="90" align="right">
          <template #default="scope">{{ num(scope.row.inputTokens) }}</template>
        </el-table-column>
        <el-table-column label="输出" width="90" align="right">
          <template #default="scope">
            {{ num(scope.row.outputTokens) }}<el-tooltip v-if="scope.row.estimated === '1'" content="上游没有返回用量，按字数估算"><span class="itm-muted">≈</span></el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="耗时" width="90" align="right">
          <template #default="scope">{{ (scope.row.durationMs / 1000).toFixed(1) }}s</template>
        </el-table-column>
        <el-table-column label="结果" width="80" align="center">
          <template #default="scope">
            <el-tag :type="scope.row.status === '0' ? 'success' : 'danger'" disable-transitions>{{ scope.row.status === "0" ? "成功" : "失败" }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" prop="error" min-width="200" :show-overflow-tooltip="true" />
      </el-table>
      <pagination v-show="usageTotal > 0" :total="usageTotal" v-model:page="usageQuery.pageNum" v-model:limit="usageQuery.pageSize" @pagination="getUsage()" />
    </template>

    <el-dialog :title="title" v-model="open" width="1180px" append-to-body>
      <el-form ref="providerRef" :model="form" :rules="rules" label-width="110px">
        <el-row>
          <el-col :span="12">
            <el-form-item label="名称" prop="providerName">
              <el-input v-model="form.providerName" maxlength="100" placeholder="客户端显示的名称，例如：公司千问" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="厂商预设">
              <el-select v-model="vendor" placeholder="选择后自动填写协议和地址" clearable style="width: 100%" @change="applyVendor">
                <el-option-group v-for="g in VENDOR_GROUPS" :key="g" :label="g">
                  <el-option v-for="v in VENDORS.filter((x) => x.group === g)" :key="v.label" :label="v.label" :value="v.label" />
                </el-option-group>
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="协议" prop="providerType">
              <el-radio-group v-model="form.providerType">
                <el-radio-button v-for="dict in itm_llm_type" :key="dict.value" :value="dict.value">{{ dict.label }}</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="深度思考" prop="thinkingStyle">
              <el-select v-model="form.thinkingStyle" style="width: 100%">
                <el-option v-for="s in STYLES" :key="s.value" :label="s.label" :value="s.value" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="接口地址" prop="baseUrl">
              <el-input v-model="form.baseUrl" :placeholder="form.providerType === 'ANTHROPIC' ? 'https://api.anthropic.com' : 'https://…/v1'" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="API Key" prop="apiKey">
              <el-input v-model="form.apiKey" type="password" show-password autocomplete="new-password" :placeholder="form.providerId ? '不修改请保持 ******；清空表示删除 Key' : 'Ollama 等不需要 Key 的可以不填'" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="模型" prop="modelRows">
              <el-table :data="form.modelRows" size="small" border class="itm-models">
                <el-table-column label="模型 ID" min-width="170">
                  <template #default="scope"><el-input v-model="scope.row.id" size="small" placeholder="请求里用的 ID" /></template>
                </el-table-column>
                <el-table-column label="显示名" min-width="130">
                  <template #default="scope"><el-input v-model="scope.row.displayName" size="small" placeholder="可选" /></template>
                </el-table-column>
                <el-table-column label="上下文" width="110">
                  <template #default="scope"><el-input-number v-model="scope.row.contextWindow" size="small" :min="1024" :step="1000" controls-position="right" style="width: 96px" /></template>
                </el-table-column>
                <el-table-column label="最大输出" width="110">
                  <template #default="scope"><el-input-number v-model="scope.row.maxOutput" size="small" :min="256" :step="1000" controls-position="right" style="width: 96px" /></template>
                </el-table-column>
                <el-table-column label="深度思考" width="104">
                  <template #default="scope">
                    <el-select v-model="scope.row.reasoning" size="small" placeholder="不支持">
                      <el-option v-for="r in REASONING" :key="r.value" :label="r.label" :value="r.value" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="150">
                  <template #header>
                    思考强度
                    <el-tooltip content="模型支持的 reasoning_effort 档位，客户端会把选择的强度换成其中最接近的一档。thinking.type、千问、MiniMax 方式只有填了才发送强度"><el-icon class="itm-help"><QuestionFilled /></el-icon></el-tooltip>
                  </template>
                  <template #default="scope">
                    <el-select v-model="scope.row.efforts" size="small" multiple collapse-tags placeholder="不填">
                      <el-option v-for="e in EFFORT_OPTIONS" :key="e.value" :label="e.label" :value="e.value" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column width="112">
                  <template #header>
                    思考方式
                    <el-tooltip content="自适应档位：发思考强度；Token 预算：把档位换算成思考 token 数；仅开关：只开关思考、不发强度"><el-icon class="itm-help"><QuestionFilled /></el-icon></el-tooltip>
                  </template>
                  <template #default="scope">
                    <el-select v-model="scope.row.thinkingControl" size="small" placeholder="自动" clearable>
                      <el-option v-for="c in CONTROLS" :key="c.value" :label="c.label" :value="c.value" />
                    </el-select>
                  </template>
                </el-table-column>
                <el-table-column label="图片" width="56" align="center">
                  <template #default="scope"><el-checkbox v-model="scope.row.supportsImages" /></template>
                </el-table-column>
                <el-table-column width="60" align="center">
                  <template #header>
                    工具
                    <el-tooltip content="能调用工具（客户端智能体模式要用）；取消勾选表示只能问答"><el-icon class="itm-help"><QuestionFilled /></el-icon></el-tooltip>
                  </template>
                  <template #default="scope"><el-checkbox :model-value="scope.row.supportsTools !== false" @update:model-value="(v) => (scope.row.supportsTools = v ? undefined : false)" /></template>
                </el-table-column>
                <el-table-column width="50" align="center">
                  <template #default="scope"><el-button link type="danger" icon="Delete" @click="form.modelRows.splice(scope.$index, 1)" /></template>
                </el-table-column>
              </el-table>
              <div class="itm-model-tools">
                <el-button size="small" icon="Plus" @click="addModel()">添加模型</el-button>
                <el-button v-if="vendorModels.length" size="small" icon="Star" @click="addVendorModels">添加官方模型（{{ vendorModels.length }}）</el-button>
                <el-button size="small" icon="Download" :loading="fetching" @click="fetchModels">从接口拉取</el-button>
                <span v-if="fetched.length" class="itm-muted">接口返回 {{ fetched.length }} 个模型，点击添加：</span>
              </div>
              <div v-if="fetched.length" class="itm-fetched">
                <el-tag v-for="id in fetched" :key="id" size="small" class="itm-tag" style="cursor: pointer" @click="addModel(id)">{{ id }}</el-tag>
              </div>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="可用范围">
              <itm-grant-picker v-model:roles="form.roleList" v-model:users="form.userList" v-model:depts="form.deptList" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="显示顺序">
              <el-input-number v-model="form.sort" :min="0" controls-position="right" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="回传思考">
              <el-switch v-model="form.echoReasoning" active-value="1" inactive-value="0" />
              <el-tooltip content="历史回答带上 reasoning_content（OpenRouter 为 reasoning_details）。DeepSeek、千问、GLM、Kimi、MiniMax 等调用工具时要求回传"><el-icon class="itm-help"><QuestionFilled /></el-icon></el-tooltip>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="状态">
              <el-radio-group v-model="form.status">
                <el-radio value="0">启用</el-radio>
                <el-radio value="1">停用</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="form.remark" type="textarea" :rows="2" maxlength="500" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button :loading="testing" @click="testForm" v-hasPermi="['itm:llm:test']">测试连接</el-button>
        <el-button type="primary" @click="submitForm">确 定</el-button>
        <el-button @click="open = false">取 消</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup name="ItmLlm">
import ItmGrantPicker from "@/components/ItmGrantPicker"
import { grantText, loadGrantOptions, splitIds } from "@/utils/itmGrant"
import { listLlmProvider, getLlmProvider, addLlmProvider, updateLlmProvider, delLlmProvider, testLlmProvider, fetchLlmModels, listLlmUsage, llmUsageSummary, getLlmWeb, saveLlmWeb, testLlmWeb } from "@/api/iterminal"

const { proxy } = getCurrentInstance()
const { itm_llm_type } = useDict("itm_llm_type")

// 厂商预设：和桌面客户端的 AI_VENDOR_PRESETS 保持一致（模型、思考档位、图片支持对照各厂商官方文档，2026-10；第二十五轮按 NewMax 的分类重排）
// m(id, 显示名, 上下文, 最大输出, 思考, 档位, 图片, 思考方式, 其他)
const m = (id, displayName, contextWindow, maxOutput, reasoning, efforts, supportsImages = false, thinkingControl = undefined, extra = {}) =>
  ({ id, displayName, contextWindow, maxOutput, reasoning, efforts: efforts || [], supportsImages, thinkingControl: thinkingControl || (efforts && efforts.length ? "effort" : reasoning && reasoning !== "none" ? "toggle" : undefined), ...extra })
const ALL = ["low", "medium", "high", "xhigh", "max"]
const LHM = ["low", "high", "max"]
const LMH = ["low", "medium", "high"]
const QWEN = ["low", "medium", "xhigh"]
const M1 = 1048576
const VENDORS = [
  { group: "国内", label: "DeepSeek", type: "OPENAI_COMPAT", url: "https://api.deepseek.com", style: "thinking-type", echo: "1", models: [
    m("deepseek-flash", "DeepSeek V4.1 Flash", 1000000, 384000, "optional", LHM, true),
    m("deepseek-v4-pro", "DeepSeek V4 Pro", 1000000, 384000, "optional", LHM)] },
  { group: "国内", label: "通义千问（百炼）", type: "OPENAI_COMPAT", url: "https://dashscope.aliyuncs.com/compatible-mode/v1", style: "qwen", echo: "1", models: [
    m("qwen3.8-max", "Qwen3.8 Max", 1000000, 131072, "optional", QWEN, true),
    m("qwen3.8-flash", "Qwen3.8 Flash", 1000000, 65536, "optional", QWEN, true),
    m("qwen3.7-plus", "Qwen3.7 Plus", 1000000, 65536, "optional", ALL, true, "budget")] },
  { group: "国内", label: "智谱 GLM", type: "OPENAI_COMPAT", url: "https://open.bigmodel.cn/api/paas/v4", style: "thinking-type", echo: "1", models: [
    m("glm-5.3", "GLM-5.3", 1000000, 128000, "always", LHM),
    m("glm-5.3-flash", "GLM-5.3 Flash", 1000000, 128000, "always", LHM, true),
    m("glm-5.2", "GLM-5.2", 1000000, 128000, "optional", ["high", "max"]),
    m("glm-5v-turbo", "GLM-5V Turbo（图片）", 202752, 128000, "optional", null, true)] },
  { group: "国内", label: "Kimi（月之暗面）", type: "OPENAI_COMPAT", url: "https://api.moonshot.cn/v1", style: "thinking-type", echo: "1", models: [
    m("kimi-k3", "Kimi K3", M1, 131072, "always", LHM, true),
    m("kimi-k2.7-code", "Kimi K2.7 Code", 262144, 32768, "always"),
    m("kimi-k2.6", "Kimi K2.6", 262144, 32768, "optional", null, true)] },
  { group: "国内", label: "豆包（火山方舟）", type: "OPENAI_COMPAT", url: "https://ark.cn-beijing.volces.com/api/v3", style: "thinking-type", models: [
    m("doubao-seed-2-1-pro-260915", "豆包 Seed 2.1 Pro", M1, 262144, "optional", LMH, true),
    m("doubao-seed-2-1-lite-260915", "豆包 Seed 2.1 Lite", M1, 262144, "optional", LMH, true),
    m("doubao-seed-2-1-turbo-260628", "豆包 Seed 2.1 Turbo", 262144, 262144, "optional", LMH, true)] },
  { group: "国内", label: "MiniMax", type: "OPENAI_COMPAT", url: "https://api.minimax.cn/v1", style: "minimax", echo: "1", models: [
    m("MiniMax-M3.1-Flash-Preview", "MiniMax M3.1 Flash（预览）", 1000000, 131072, "always", ALL, true),
    m("MiniMax-M3", "MiniMax M3", 1000000, 131072, "optional", null, true),
    m("MiniMax-M2.7", "MiniMax M2.7", 204800, 131072, "always")] },
  { group: "国内", label: "阶跃星辰", type: "OPENAI_COMPAT", url: "https://api.stepfun.com/v1", style: "openai-effort", echo: "1", models: [
    m("step-3.7-flash", "Step 3.7 Flash", 256000, 65536, "always", LMH, true),
    m("step-3.5-flash", "Step 3.5 Flash", 256000, 65536, "always")] },
  { group: "国内", label: "小米 MiMo", type: "OPENAI_COMPAT", url: "https://api.xiaomimimo.com/v1", style: "thinking-type", echo: "1", models: [
    m("mimo-v2.5-pro", "MiMo V2.5 Pro", M1, 131072, "always", null, true),
    m("mimo-v2.5", "MiMo V2.5", M1, 131072, "always", null, true)] },
  { group: "聚合平台", label: "OpenRouter", type: "OPENAI_COMPAT", url: "https://openrouter.ai/api/v1", style: "openrouter", echo: "1", models: [] },
  { group: "聚合平台", label: "硅基流动", type: "OPENAI_COMPAT", url: "https://api.siliconflow.cn/v1", style: "qwen", echo: "1", models: [] },
  { group: "聚合平台", label: "魔搭 ModelScope", type: "OPENAI_COMPAT", url: "https://api-inference.modelscope.cn/v1", style: "qwen", echo: "1", models: [] },
  { group: "海外", label: "Anthropic（Claude）", type: "ANTHROPIC", url: "https://api.anthropic.com", style: "anthropic", models: [
    m("claude-fable-5-1", "Claude Fable 5.1", 1000000, 128000, "always", ALL, true),
    m("claude-opus-5-5", "Claude Opus 5.5", 1000000, 128000, "always", ALL, true),
    m("claude-sonnet-5-5", "Claude Sonnet 5.5", 1000000, 128000, "optional", ALL, true),
    m("claude-haiku-5-5", "Claude Haiku 5.5", 1000000, 128000, "optional", ALL, true)] },
  { group: "海外", label: "OpenAI（GPT）", type: "OPENAI", url: "https://api.openai.com/v1", style: "openai-effort", models: [
    m("gpt-6-astra", "GPT-6 Astra", 1050000, 128000, "always", ALL, true),
    m("gpt-6.1-sol", "GPT-6.1 Sol", 1050000, 128000, "optional", ALL, true, "effort", { supportsTools: false }),
    m("gpt-6-luna", "GPT-6 Luna", 1050000, 128000, "optional", ALL, true, "effort", { supportsTools: false })] },
  { group: "海外", label: "Google Gemini", type: "OPENAI_COMPAT", url: "https://generativelanguage.googleapis.com/v1beta/openai", style: "openai-effort", models: [
    m("gemini-4-argon", "Gemini 4 Argon", M1, 65536, "always", LMH, true),
    m("gemini-3.8-flash", "Gemini 3.8 Flash", M1, 65536, "always", LMH, true),
    m("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", M1, 65536, "always", LMH, true)] },
  { group: "海外", label: "xAI Grok", type: "OPENAI_COMPAT", url: "https://api.x.ai/v1", style: "none", models: [
    m("grok-4.7", "Grok 4.7", 500000, 65536, "always", null, true),
    m("grok-4.6", "Grok 4.6", 500000, 65536, "always", null, true)] },
  { group: "本机", label: "Ollama", type: "OPENAI_COMPAT", url: "http://127.0.0.1:11434/v1", style: "openai-effort", models: [] },
  { group: "本机", label: "LM Studio", type: "OPENAI_COMPAT", url: "http://127.0.0.1:1234/v1", style: "tags", models: [] },
  { group: "自定义", label: "自定义（OpenAI 兼容）", type: "OPENAI_COMPAT", url: "", style: "none", models: [] }
]
const VENDOR_GROUPS = ["国内", "聚合平台", "海外", "本机", "自定义"]
const CONTROLS = [
  { value: "effort", label: "自适应档位" },
  { value: "budget", label: "Token 预算" },
  { value: "toggle", label: "仅开关" }
]
const STYLES = [
  { value: "none", label: "不发送思考参数" },
  { value: "anthropic", label: "Anthropic（adaptive thinking + effort）" },
  { value: "openai-effort", label: "reasoning_effort（OpenAI、Gemini、Ollama）" },
  { value: "qwen", label: "enable_thinking + reasoning_effort / thinking_budget（千问）" },
  { value: "thinking-type", label: "thinking.type + reasoning_effort（DeepSeek、GLM、Kimi、豆包）" },
  { value: "minimax", label: "thinking.type = adaptive + reasoning_split（MiniMax）" },
  { value: "openrouter", label: "reasoning.effort（OpenRouter）" },
  { value: "tags", label: "<think> 标签（不发参数）" }
]
const REASONING = [
  { value: "none", label: "不支持" },
  { value: "optional", label: "可开关" },
  { value: "always", label: "始终思考" }
]
const EFFORT_OPTIONS = [
  { value: "minimal", label: "极低" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "最高" }
]

const tab = ref("provider")
const list = ref([])
const loading = ref(true)
const ids = ref([])
const grantOpts = ref({ roles: [], users: [], depts: [] })
const open = ref(false)
const title = ref("")
const vendor = ref("")
const form = ref({})
const testing = ref(false)
const fetching = ref(false)
const fetched = ref([])
const usage = ref([])
const usageLoading = ref(false)
const usageTotal = ref(0)
const usageRange = ref([])
const usageQuery = ref({ pageNum: 1, pageSize: 20, userName: undefined, providerId: undefined, status: undefined })
const web = ref({ enabled: false, format: "deepseek", baseUrl: "", searchUrl: "", fetchUrl: "", apiKey: "", count: 8, label: "", dailyLimit: 500 })
const webLoading = ref(false)
const webTesting = ref(false)
const webResult = ref(null)

const rules = {
  providerName: [{ required: true, message: "请填写名称", trigger: "blur" }],
  providerType: [{ required: true, message: "请选择协议", trigger: "change" }],
  baseUrl: [{ required: true, message: "请填写接口地址", trigger: "blur" }, { pattern: /^https?:\/\/\S+$/, message: "http:// 或 https:// 开头", trigger: "blur" }],
  modelRows: [{ validator: (r, v, cb) => (v && v.some((m) => m.id && m.id.trim()) ? cb() : cb(new Error("请至少添加一个模型"))), trigger: "change" }]
}

const num = (v) => Number(v || 0).toLocaleString()
const parseModels = (s) => {
  try {
    return JSON.parse(s || "[]")
  } catch {
    return []
  }
}

function getList() {
  loading.value = true
  listLlmProvider({ pageNum: 1, pageSize: 200 }).then(res => {
    list.value = res.rows
    loading.value = false
  })
}

function getUsage(reset) {
  if (reset) usageQuery.value.pageNum = 1
  usageLoading.value = true
  const fn = tab.value === "summary" ? llmUsageSummary : listLlmUsage
  fn(proxy.addDateRange(usageQuery.value, usageRange.value)).then(res => {
    usage.value = res.rows
    usageTotal.value = res.total
  }).finally(() => {
    usageLoading.value = false
  })
}

function resetUsage() {
  usageRange.value = defaultRange()
  proxy.resetForm("usageQueryRef")
  getUsage(true)
}

/** 默认本月 */
function defaultRange() {
  const d = new Date()
  const first = new Date(d.getFullYear(), d.getMonth(), 1)
  return [proxy.parseTime(first, "{y}-{m}-{d}"), proxy.parseTime(d, "{y}-{m}-{d}")]
}

function getWeb() {
  webLoading.value = true
  webResult.value = null
  getLlmWeb().then(res => {
    web.value = res.data
  }).finally(() => {
    webLoading.value = false
  })
}

function saveWeb() {
  saveLlmWeb(web.value).then(() => {
    proxy.$modal.msgSuccess("已保存，客户端重新连接服务端（或 10 分钟内）后生效")
    getWeb()
  })
}

function testWeb() {
  webTesting.value = true
  webResult.value = null
  testLlmWeb(web.value).then(res => {
    webResult.value = res.data
  }).finally(() => {
    webTesting.value = false
  })
}

watch(tab, (v) => {
  if (v === "provider") getList()
  else if (v === "web") getWeb()
  else {
    if (!usageRange.value.length) usageRange.value = defaultRange()
    getUsage(true)
  }
})

function reset() {
  vendor.value = ""
  fetched.value = []
  form.value = { providerId: undefined, providerName: undefined, providerType: "OPENAI_COMPAT", baseUrl: "", apiKey: "", thinkingStyle: "none", echoReasoning: "0", modelRows: [], roleList: [], userList: [], deptList: [], sort: 0, status: "0", remark: undefined }
  proxy.resetForm("providerRef")
}

function applyVendor(label) {
  const v = VENDORS.find((x) => x.label === label)
  if (!v) return
  form.value.providerType = v.type
  form.value.baseUrl = v.url
  form.value.thinkingStyle = v.style
  form.value.echoReasoning = v.echo || "0"
  if (!form.value.providerName) form.value.providerName = label.replace(/（.*）/, "")
}

function addModel(id) {
  if (id && form.value.modelRows.some((m) => m.id === id)) return
  // 拉取到的模型如果是预设里的官方模型，带上完整参数
  const known = VENDORS.flatMap((v) => v.models).find((m) => m.id === id)
  form.value.modelRows.push(known ? { ...known, efforts: [...known.efforts] } : { id: id || "", displayName: "", contextWindow: 128000, maxOutput: 8192, reasoning: "none", efforts: [], supportsImages: false })
}

/** 当前选择的厂商的官方模型 */
const vendorModels = computed(() => VENDORS.find((v) => v.label === vendor.value)?.models ?? [])

function addVendorModels() {
  const have = new Set(form.value.modelRows.map((m) => m.id))
  const add = vendorModels.value.filter((m) => !have.has(m.id))
  if (!add.length) return proxy.$modal.msg("已经添加过了")
  form.value.modelRows.push(...add.map((m) => ({ ...m, efforts: [...m.efforts] })))
}

function handleAdd() {
  reset()
  open.value = true
  title.value = "新增团队模型"
}

function handleUpdate(row) {
  reset()
  getLlmProvider(row.providerId).then(res => {
    const p = res.data
    form.value = { ...p, modelRows: parseModels(p.models).map((m) => ({ reasoning: "none", ...m, efforts: m.efforts || [] })), roleList: splitIds(p.roleKeys), userList: splitIds(p.userIds), deptList: splitIds(p.deptIds) }
    open.value = true
    title.value = "修改团队模型"
  })
}

function payload() {
  const f = { ...form.value }
  f.models = JSON.stringify(f.modelRows.filter((m) => m.id && m.id.trim()).map((m) => ({ ...m, id: m.id.trim() })))
  f.roleKeys = (f.roleList || []).join(",")
  f.userIds = (f.userList || []).join(",")
  f.deptIds = (f.deptList || []).join(",")
  delete f.modelRows
  delete f.roleList
  delete f.userList
  delete f.deptList
  return f
}

function submitForm() {
  proxy.$refs["providerRef"].validate(valid => {
    if (!valid) return
    const req = form.value.providerId != undefined ? updateLlmProvider(payload()) : addLlmProvider(payload())
    req.then(() => {
      proxy.$modal.msgSuccess(form.value.providerId != undefined ? "修改成功" : "新增成功")
      open.value = false
      getList()
    })
  })
}

function showTestResult(r) {
  proxy.$modal.msgSuccess("连接正常：" + r.model + "，耗时 " + r.latencyMs + "ms" + (r.reply ? "，回复「" + r.reply + "」" : ""))
}

function testForm() {
  proxy.$refs["providerRef"].validate(valid => {
    if (!valid) return
    testing.value = true
    testLlmProvider(payload()).then(res => showTestResult(res.data)).finally(() => {
      testing.value = false
    })
  })
}

function handleTest(row) {
  testLlmProvider({ ...row }).then(res => showTestResult(res.data))
}

function fetchModels() {
  if (!/^https?:\/\/\S+$/.test(form.value.baseUrl || "")) {
    proxy.$modal.msgError("请先填写接口地址")
    return
  }
  fetching.value = true
  fetchLlmModels(payload()).then(res => {
    fetched.value = res.data || []
    if (!fetched.value.length) proxy.$modal.msgWarning("接口没有返回模型")
  }).finally(() => {
    fetching.value = false
  })
}

function handleStatusChange(row) {
  updateLlmProvider({ ...row, apiKey: null }).then(() => {
    proxy.$modal.msgSuccess(row.status === "0" ? "已启用" : "已停用")
  }).catch(() => {
    row.status = row.status === "0" ? "1" : "0"
  })
}

function handleDelete(row) {
  const target = row ? [row.providerId] : ids.value
  proxy.$modal.confirm("确认删除选中的 " + target.length + " 个团队模型？正在使用的客户端会提示重新选择模型。").then(() => {
    return delLlmProvider(target.join(","))
  }).then(() => {
    getList()
    proxy.$modal.msgSuccess("删除成功")
  }).catch(() => {})
}

loadGrantOptions().then((o) => (grantOpts.value = o)).catch(() => {})
getList()
</script>

<style scoped>
.itm-tag {
  margin: 2px 4px 2px 0;
}
.itm-models {
  width: 100%;
}
.itm-model-tools {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.itm-fetched {
  margin-top: 6px;
  max-height: 120px;
  overflow: auto;
}
.itm-muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.itm-block {
  width: 100%;
  margin-top: 4px;
  line-height: 1.6;
}
.itm-help {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  cursor: help;
}
code {
  font-family: Menlo, Consolas, monospace;
}
</style>
