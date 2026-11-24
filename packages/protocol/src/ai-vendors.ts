import type { AiModelConfig, AiProviderType, Effort, ThinkingControl, ThinkingStyle } from './ai';

/**
 * 模型厂商预设（文档一 6.15.4，第二十五轮按 NewMax 的分类重排：推荐 / 国内 / 聚合平台 / 海外 / 本地）：
 * 选择厂商后自动填好协议、默认地址和官方模型，只需要填 API Key。
 * 模型列表、思考档位、图片支持对照各厂商官方文档（2026-10），模型 ID 会随厂商更新而变化：用户可以修改，
 * 或者用「从服务商拉取模型列表」获取、用「检测模型能力」自动识别。厂商更新时只改这一处（管理后台 llm/index.vue 的 VENDORS 要一起改）。
 */
export interface AiVendorPreset {
  key: string;
  name: string;
  /** 分组：国内 / 聚合平台 / 海外 / 本地 / 自定义 */
  group: 'cn' | 'aggregator' | 'intl' | 'local' | 'custom';
  /** 显示在「推荐服务」里 */
  recommended?: boolean;
  /** 卡片上的计费标签 */
  billing?: '按量' | '免费额度' | '本机';
  type: AiProviderType;
  baseUrl: string;
  thinkingStyle: ThinkingStyle;
  echoReasoning?: boolean;
  /** 获取 API Key 的控制台地址 */
  keyUrl?: string;
  /** 本机服务不需要 Key */
  noKey?: boolean;
  /** 海外服务：国内网络可能需要代理 */
  needsProxy?: boolean;
  models: AiModelConfig[];
  /** 一句话说明 */
  hint?: string;
  /** 头像颜色（没有官方图标时用首字） */
  color?: string;
}

const m = (id: string, contextWindow: number, maxOutput: number, extra: Partial<AiModelConfig> = {}): AiModelConfig => ({ id, contextWindow, maxOutput, ...extra });
/** 五档（低 → 最高） */
const ALL: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const LHM: Effort[] = ['low', 'high', 'max'];
const LMH: Effort[] = ['low', 'medium', 'high'];
/** Qwen3.8：low / medium / xhigh（high、max 映射为 xhigh） */
const QWEN: Effort[] = ['low', 'medium', 'xhigh'];
const M1 = 1_048_576;
const EFFORT: { thinkingControl: ThinkingControl } = { thinkingControl: 'effort' };
const BUDGET: { thinkingControl: ThinkingControl } = { thinkingControl: 'budget' };
const TOGGLE: { thinkingControl: ThinkingControl } = { thinkingControl: 'toggle' };

export const AI_VENDOR_PRESETS: AiVendorPreset[] = [
  // ---------------------------------------------------------------- 国内
  {
    key: 'deepseek',
    name: 'DeepSeek',
    group: 'cn',
    recommended: true,
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api.deepseek.com',
    thinkingStyle: 'thinking-type',
    echoReasoning: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    color: '#4d6bfe',
    hint: 'DeepSeek 官方 API，按量付费',
    // V4.1 Flash 支持图片输入，V4 Pro 不支持；reasoning_effort 官方档位 low / high / max（minimal → low，medium / xhigh → high）
    models: [
      m('deepseek-flash', 1_000_000, 384_000, { displayName: 'DeepSeek V4.1 Flash', reasoning: 'optional', efforts: LHM, ...EFFORT, supportsImages: true }),
      m('deepseek-v4-pro', 1_000_000, 384_000, { displayName: 'DeepSeek V4 Pro', reasoning: 'optional', efforts: LHM, ...EFFORT }),
    ],
  },
  {
    key: 'qwen',
    name: '通义千问（阿里云百炼）',
    group: 'cn',
    recommended: true,
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    thinkingStyle: 'qwen',
    echoReasoning: true,
    keyUrl: 'https://bailian.console.aliyun.com/',
    color: '#615ced',
    hint: '阿里云百炼按量 API，通用 sk- Key',
    models: [
      m('qwen3.8-max', 1_000_000, 131_072, { displayName: 'Qwen3.8 Max', reasoning: 'optional', efforts: QWEN, ...EFFORT, supportsImages: true }),
      m('qwen3.8-flash', 1_000_000, 65_536, { displayName: 'Qwen3.8 Flash', reasoning: 'optional', efforts: QWEN, ...EFFORT, supportsImages: true }),
      m('qwen3.7-plus', 1_000_000, 65_536, { displayName: 'Qwen3.7 Plus', reasoning: 'optional', efforts: ALL, ...BUDGET, supportsImages: true }),
    ],
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    group: 'cn',
    recommended: true,
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    thinkingStyle: 'thinking-type',
    echoReasoning: true,
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    color: '#3859ff',
    hint: '智谱开放平台 API，按实际调用量计费',
    // GLM-5.3 系列思考关不掉（低 / 高 / 最高）；GLM-5.2 能关闭（高 / 最高）；其余只有开关
    models: [
      m('glm-5.3', 1_000_000, 128_000, { displayName: 'GLM-5.3', reasoning: 'always', efforts: LHM, ...EFFORT }),
      m('glm-5.3-flash', 1_000_000, 128_000, { displayName: 'GLM-5.3 Flash', reasoning: 'always', efforts: LHM, ...EFFORT, supportsImages: true }),
      m('glm-5.2', 1_000_000, 128_000, { displayName: 'GLM-5.2', reasoning: 'optional', efforts: ['high', 'max'], ...EFFORT }),
      m('glm-5v-turbo', 202_752, 128_000, { displayName: 'GLM-5V Turbo（图片）', reasoning: 'optional', ...TOGGLE, supportsImages: true }),
    ],
  },
  {
    key: 'moonshot',
    name: 'Kimi（月之暗面）',
    group: 'cn',
    recommended: true,
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api.moonshot.cn/v1',
    thinkingStyle: 'thinking-type',
    echoReasoning: true,
    keyUrl: 'https://platform.kimi.com/console/api-keys',
    color: '#111111',
    hint: '月之暗面开放平台，按量付费',
    models: [
      m('kimi-k3', M1, 131_072, { displayName: 'Kimi K3', reasoning: 'always', efforts: LHM, ...EFFORT, supportsImages: true }),
      m('kimi-k2.7-code', 262_144, 32_768, { displayName: 'Kimi K2.7 Code', reasoning: 'always', ...TOGGLE }),
      m('kimi-k2.6', 262_144, 32_768, { displayName: 'Kimi K2.6', reasoning: 'optional', ...TOGGLE, supportsImages: true }),
    ],
  },
  {
    key: 'doubao',
    name: '豆包（火山方舟）',
    group: 'cn',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    thinkingStyle: 'thinking-type',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    color: '#1e6fff',
    hint: '火山方舟按量 API；模型 ID 也可以填写接入点 ID（ep-…）',
    // Seed 2.1：reasoning_effort minimal / low / medium / high，minimal 就是不思考（用开关关闭）
    models: [
      m('doubao-seed-2-1-pro-260915', M1, 262_144, { displayName: '豆包 Seed 2.1 Pro', reasoning: 'optional', efforts: LMH, ...EFFORT, supportsImages: true }),
      m('doubao-seed-2-1-lite-260915', M1, 262_144, { displayName: '豆包 Seed 2.1 Lite', reasoning: 'optional', efforts: LMH, ...EFFORT, supportsImages: true }),
      m('doubao-seed-2-1-turbo-260628', 262_144, 262_144, { displayName: '豆包 Seed 2.1 Turbo', reasoning: 'optional', efforts: LMH, ...EFFORT, supportsImages: true }),
    ],
  },
  {
    key: 'minimax',
    name: 'MiniMax',
    group: 'cn',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api.minimax.cn/v1',
    thinkingStyle: 'minimax',
    echoReasoning: true,
    keyUrl: 'https://platform.minimax.cn/user-center/basic-information/interface-key',
    color: '#e8336d',
    hint: 'MiniMax 开放平台按量计费 API',
    // M3.1 Flash 预览：原生识图、五档思考且不能关闭；M3 只能开关；M2.7 始终思考
    models: [
      m('MiniMax-M3.1-Flash-Preview', 1_000_000, 131_072, { displayName: 'MiniMax M3.1 Flash（预览）', reasoning: 'always', efforts: ALL, ...EFFORT, supportsImages: true }),
      m('MiniMax-M3', 1_000_000, 131_072, { displayName: 'MiniMax M3', reasoning: 'optional', ...TOGGLE, supportsImages: true }),
      m('MiniMax-M2.7', 204_800, 131_072, { displayName: 'MiniMax M2.7', reasoning: 'always', ...TOGGLE }),
    ],
  },
  {
    key: 'stepfun',
    name: '阶跃星辰',
    group: 'cn',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api.stepfun.com/v1',
    thinkingStyle: 'openai-effort',
    echoReasoning: true,
    keyUrl: 'https://platform.stepfun.com/interface-key',
    color: '#0f172a',
    hint: '阶跃星辰 API，可调用 Step 系列模型',
    models: [
      m('step-3.7-flash', 256_000, 65_536, { displayName: 'Step 3.7 Flash', reasoning: 'always', efforts: LMH, ...EFFORT, supportsImages: true }),
      m('step-3.5-flash', 256_000, 65_536, { displayName: 'Step 3.5 Flash', reasoning: 'always', ...TOGGLE }),
    ],
  },
  {
    key: 'mimo',
    name: '小米 MiMo',
    group: 'cn',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    thinkingStyle: 'thinking-type',
    echoReasoning: true,
    keyUrl: 'https://platform.xiaomimimo.com/',
    color: '#ff6900',
    hint: '小米 MiMo 开放平台，MiMo V2.5 系列原生识图',
    models: [
      m('mimo-v2.5-pro', M1, 131_072, { displayName: 'MiMo V2.5 Pro', reasoning: 'always', ...TOGGLE, supportsImages: true }),
      m('mimo-v2.5', M1, 131_072, { displayName: 'MiMo V2.5', reasoning: 'always', ...TOGGLE, supportsImages: true }),
    ],
  },
  // ---------------------------------------------------------------- 聚合平台
  {
    key: 'openrouter',
    name: 'OpenRouter',
    group: 'aggregator',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://openrouter.ai/api/v1',
    thinkingStyle: 'openrouter',
    echoReasoning: true,
    keyUrl: 'https://openrouter.ai/keys',
    needsProxy: true,
    color: '#6467f2',
    hint: '一个 Key 调用多家模型，用「从服务商拉取模型列表」选择（模型 ID 形如 厂商/模型）',
    models: [],
  },
  {
    key: 'siliconflow',
    name: '硅基流动',
    group: 'aggregator',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api.siliconflow.cn/v1',
    thinkingStyle: 'qwen',
    echoReasoning: true,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    color: '#7c3aed',
    hint: '国内聚合平台，开源模型多；思考用 enable_thinking + thinking_budget',
    models: [],
  },
  {
    key: 'modelscope',
    name: '魔搭 ModelScope',
    group: 'aggregator',
    billing: '免费额度',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    thinkingStyle: 'qwen',
    echoReasoning: true,
    keyUrl: 'https://modelscope.cn/my/myaccesstoken',
    color: '#624aff',
    hint: '魔搭 API-Inference，每天有免费调用额度',
    models: [],
  },
  // ---------------------------------------------------------------- 海外
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    group: 'intl',
    billing: '按量',
    type: 'ANTHROPIC',
    baseUrl: 'https://api.anthropic.com',
    thinkingStyle: 'anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsProxy: true,
    color: '#d97757',
    hint: 'Anthropic 官方 API，原生支持 Claude 全系列模型',
    // adaptive thinking + effort：Fable / Opus 5.5 思考关不掉
    models: [
      m('claude-fable-5-1', 1_000_000, 128_000, { displayName: 'Claude Fable 5.1', reasoning: 'always', efforts: ALL, ...EFFORT, supportsImages: true }),
      m('claude-opus-5-5', 1_000_000, 128_000, { displayName: 'Claude Opus 5.5', reasoning: 'always', efforts: ALL, ...EFFORT, supportsImages: true }),
      m('claude-sonnet-5-5', 1_000_000, 128_000, { displayName: 'Claude Sonnet 5.5', reasoning: 'optional', efforts: ALL, ...EFFORT, supportsImages: true }),
      m('claude-haiku-5-5', 1_000_000, 128_000, { displayName: 'Claude Haiku 5.5', reasoning: 'optional', efforts: ALL, ...EFFORT, supportsImages: true }),
    ],
  },
  {
    key: 'openai',
    name: 'OpenAI GPT',
    group: 'intl',
    billing: '按量',
    type: 'OPENAI',
    baseUrl: 'https://api.openai.com/v1',
    thinkingStyle: 'openai-effort',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsProxy: true,
    color: '#10a37f',
    hint: '智能体模式请用 GPT-6 Astra（Sol、Luna 暂时不能调用工具）',
    models: [
      m('gpt-6-astra', 1_050_000, 128_000, { displayName: 'GPT-6 Astra', reasoning: 'always', efforts: ALL, ...EFFORT, supportsImages: true }),
      m('gpt-6.1-sol', 1_050_000, 128_000, { displayName: 'GPT-6.1 Sol', reasoning: 'optional', efforts: ALL, ...EFFORT, supportsImages: true, supportsTools: false }),
      m('gpt-6-luna', 1_050_000, 128_000, { displayName: 'GPT-6 Luna', reasoning: 'optional', efforts: ALL, ...EFFORT, supportsImages: true, supportsTools: false }),
    ],
  },
  {
    key: 'gemini',
    name: 'Google Gemini',
    group: 'intl',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    thinkingStyle: 'openai-effort',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsProxy: true,
    color: '#4285f4',
    hint: 'Google AI Studio API Key，思考档位低 / 中 / 高（关不掉）',
    models: [
      m('gemini-4-argon', M1, 65_536, { displayName: 'Gemini 4 Argon', reasoning: 'always', efforts: LMH, ...EFFORT, supportsImages: true }),
      m('gemini-3.8-flash', M1, 65_536, { displayName: 'Gemini 3.8 Flash', reasoning: 'always', efforts: LMH, ...EFFORT, supportsImages: true }),
      m('gemini-3.5-flash-lite', M1, 65_536, { displayName: 'Gemini 3.5 Flash-Lite', reasoning: 'always', efforts: LMH, ...EFFORT, supportsImages: true }),
    ],
  },
  {
    key: 'xai',
    name: 'xAI Grok',
    group: 'intl',
    billing: '按量',
    type: 'OPENAI_COMPAT',
    baseUrl: 'https://api.x.ai/v1',
    thinkingStyle: 'none',
    keyUrl: 'https://console.x.ai/',
    needsProxy: true,
    color: '#000000',
    hint: 'xAI 官方 API，Grok 4.7（500K 上下文）',
    models: [
      m('grok-4.7', 500_000, 65_536, { displayName: 'Grok 4.7', reasoning: 'always', ...TOGGLE, supportsImages: true }),
      m('grok-4.6', 500_000, 65_536, { displayName: 'Grok 4.6', reasoning: 'always', ...TOGGLE, supportsImages: true }),
    ],
  },
  // ---------------------------------------------------------------- 本机
  {
    key: 'ollama',
    name: 'Ollama',
    group: 'local',
    billing: '本机',
    type: 'OLLAMA',
    baseUrl: 'http://localhost:11434/v1',
    thinkingStyle: 'openai-effort',
    noKey: true,
    color: '#1f1f1f',
    hint: '本地运行开源模型，无需 API Key；用「拉取模型列表」读取已下载的模型',
    models: [],
  },
  {
    key: 'lmstudio',
    name: 'LM Studio',
    group: 'local',
    billing: '本机',
    type: 'OPENAI_COMPAT',
    baseUrl: 'http://localhost:1234/v1',
    thinkingStyle: 'tags',
    noKey: true,
    color: '#5b4bd6',
    hint: '带桌面界面的本地模型管理器（先在 LM Studio 里启动本地服务）',
    models: [],
  },
  // ---------------------------------------------------------------- 自定义
  {
    key: 'custom',
    name: '自定义供应商',
    group: 'custom',
    type: 'OPENAI_COMPAT',
    baseUrl: '',
    thinkingStyle: 'none',
    color: '#8c8c8c',
    hint: '配置自定义 API 兼容的供应商：vLLM、One API、公司内部网关等（OpenAI / Anthropic 格式）',
    models: [],
  },
];

/** 添加模型时的分类标签页：推荐服务 / 国内服务 / 聚合平台 / 海外平台 / 本地模型（自定义供应商放在本地模型里，和 NewMax 一致） */
export const AI_VENDOR_TABS: { key: 'recommended' | 'cn' | 'aggregator' | 'intl' | 'local'; label: string }[] = [
  { key: 'recommended', label: '推荐服务' },
  { key: 'cn', label: '国内服务' },
  { key: 'aggregator', label: '聚合平台' },
  { key: 'intl', label: '海外平台' },
  { key: 'local', label: '本地模型' },
];

/** 某个标签页里的厂商 */
export function vendorsInTab(tab: (typeof AI_VENDOR_TABS)[number]['key']): AiVendorPreset[] {
  if (tab === 'recommended') return AI_VENDOR_PRESETS.filter((p) => p.recommended);
  if (tab === 'local') return AI_VENDOR_PRESETS.filter((p) => p.group === 'local' || p.group === 'custom');
  return AI_VENDOR_PRESETS.filter((p) => p.group === tab);
}

/** 旧版本用的分组（管理后台、搜索索引） */
export const AI_VENDOR_GROUPS: { key: AiVendorPreset['group']; label: string }[] = [
  { key: 'cn', label: '国内' },
  { key: 'aggregator', label: '聚合平台' },
  { key: 'intl', label: '海外' },
  { key: 'local', label: '本机' },
  { key: 'custom', label: '自定义' },
];

export const vendorPreset = (key: string | null | undefined): AiVendorPreset | undefined => AI_VENDOR_PRESETS.find((p) => p.key === key);

/**
 * 预设之外、常见于网关 / 聚合平台的模型（参考各厂商文档和 NewMax 的模型表）：「拉取模型列表」拿到的模型 ID
 * 能对上时自动填好上下文窗口、图片支持和思考档位，对不上的再用「检测模型能力」。
 */
const EXTRA_MODELS: AiModelConfig[] = [
  m('deepseek-v3.2', 128_000, 8192, { reasoning: 'optional', ...TOGGLE }),
  m('glm-5.1', 202_752, 128_000, { reasoning: 'optional', ...TOGGLE }),
  m('glm-5', 200_000, 128_000, { reasoning: 'optional', ...TOGGLE }),
  m('glm-4.7', 200_000, 128_000, { reasoning: 'optional', ...TOGGLE }),
  m('glm-4.6v', 128_000, 32_768, { reasoning: 'optional', ...TOGGLE, supportsImages: true }),
  m('qwen3.7-max', 1_000_000, 65_536, { reasoning: 'optional', ...TOGGLE, supportsImages: true }),
  m('qwen3.6-plus', 1_000_000, 65_536, { reasoning: 'optional', ...BUDGET, efforts: ALL, supportsImages: true }),
  m('qwen3.5-plus', 1_000_000, 65_536, { reasoning: 'optional', ...BUDGET, efforts: ALL, supportsImages: true }),
  m('qwen3.5-flash', 1_000_000, 65_536, { reasoning: 'optional', ...BUDGET, efforts: ALL, supportsImages: true }),
  m('qwen3-max', 256_000, 65_536, { reasoning: 'optional', ...TOGGLE }),
  m('qwen3-vl-plus', 256_000, 32_768, { reasoning: 'optional', ...TOGGLE, supportsImages: true }),
  m('kimi-k2.5', 256_000, 32_768, { reasoning: 'optional', ...TOGGLE, supportsImages: true }),
  m('minimax-m2.5', 200_000, 131_072, { reasoning: 'always', ...TOGGLE }),
  m('doubao-seed-2.1-pro', 256_000, 131_072, { reasoning: 'optional', efforts: LMH, ...EFFORT, supportsImages: true }),
  m('doubao-seed-2.1-turbo', 256_000, 131_072, { reasoning: 'optional', efforts: LMH, ...EFFORT, supportsImages: true }),
  m('doubao-seed-2.0-lite', 256_000, 131_072, { reasoning: 'optional', efforts: LMH, ...EFFORT, supportsImages: true }),
  m('doubao-seed-2.0-mini', 256_000, 131_072, { reasoning: 'optional', efforts: LMH, ...EFFORT, supportsImages: true }),
  m('hy3', 256_000, 65_536, { reasoning: 'optional', ...TOGGLE, supportsImages: true }),
  m('longcat-2.0', 1_000_000, 65_536, { reasoning: 'optional', ...TOGGLE }),
];

/**
 * 按模型 ID 找已知的模型配置（预设 + 常见模型）：不区分大小写，也认「厂商/模型」形式（OpenRouter）。
 * 找不到时返回 null。
 */
export function knownModel(id: string): AiModelConfig | null {
  const key = id.trim().toLowerCase();
  const bare = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
  for (const list of [AI_VENDOR_PRESETS.flatMap((p) => p.models), EXTRA_MODELS]) {
    const hit = list.find((x) => x.id.toLowerCase() === key) ?? list.find((x) => x.id.toLowerCase() === bare);
    if (hit) return { ...hit, id, efforts: hit.efforts ? [...hit.efforts] : hit.efforts };
  }
  return null;
}

/** 各协议默认的思考参数方式（没有预设的老配置） */
export const DEFAULT_THINKING_STYLE: Record<AiProviderType, ThinkingStyle> = {
  ANTHROPIC: 'anthropic',
  OPENAI: 'openai-effort',
  OPENAI_COMPAT: 'tags',
  OLLAMA: 'openai-effort',
};

/** 没有设置 reasoning 的模型（老配置、「获取模型列表」拉到的）：按模型 ID 推断 */
export function inferReasoning(type: AiProviderType, modelId: string): 'none' | 'optional' | 'always' {
  if (type === 'ANTHROPIC') {
    if (/claude-(fable|mythos)|claude-opus-5-5/.test(modelId)) return 'always';
    return /claude-(opus|sonnet)-(4-[678]|5)|claude-haiku-5/.test(modelId) ? 'optional' : 'none';
  }
  if (/reasoner|thinking|-r1\b|\bo[134](-|$)|qwq|gpt-6-astra|gemini-[34]|glm-5\.3|kimi-k3|kimi-k2\.7|step-3|mimo-v2|grok-4|minimax-m2/i.test(modelId)) return 'always';
  if (/^gpt-[56]|gemini-2\.5|deepseek-(flash|v4)|qwen3|glm-[45]|kimi-k2\.[56]|doubao-seed|seed-2|minimax-m3|hy3|longcat/i.test(modelId)) return 'optional';
  return 'none';
}

/** 按模型 ID 猜是否支持图片（拉取模型列表时的初值，准确结果用「检测模型能力」） */
export function guessImages(modelId: string): boolean {
  return /vl\b|-vl-|vision|4o|gemini|claude|gpt-[56]|glm-[\d.]+v|kimi-k(2\.[56]|3)|qwen3\.[5-8]|doubao-seed|seed-2|minimax-m3|mimo-v2|step-3\.7|grok-4|llava|deepseek-flash|hy3/i.test(modelId);
}

/** 拉取到的模型 ID 的初始配置：已知模型用已知的配置，否则按 ID 推断思考和图片支持 */
export function guessModel(type: AiProviderType, modelId: string): AiModelConfig {
  return knownModel(modelId) ?? { id: modelId, contextWindow: 128_000, maxOutput: 8192, reasoning: inferReasoning(type, modelId), supportsImages: guessImages(modelId) };
}

/** 实际请求地址的预览（OpenAI 兼容接口追加 /chat/completions，Anthropic 追加 /v1/messages） */
export function endpointPreview(type: AiProviderType, baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  if (!b) return '';
  return type === 'ANTHROPIC' ? `${b}/v1/messages` : `${b}/chat/completions`;
}
