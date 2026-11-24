import { create } from 'zustand';
import { SHORTCUTS } from '@itm/protocol';
import type { SettingsSectionKey } from '../../util/settings-sections';

/** 终端设置的分类（TerminalSettings 里的卡片） */
export type TerminalCat = 'display' | 'connect' | 'smart' | 'monitor';

/**
 * 设置搜索的索引（第二十二轮）。label 是页面上设置行 / 分组显示的名称，搜到后按它定位并闪一下；
 * keywords 是额外的搜索词（同义词、英文）。新加设置行时记得加到这里（test/settings-search.test.ts 会检查）。
 */
export interface SettingsSearchItem {
  section: SettingsSectionKey;
  cat?: TerminalCat;
  label: string;
  group?: string;
  desc?: string;
  keywords?: string;
}

export const SECTION_LABEL: Record<SettingsSectionKey, string> = {
  appearance: '通用 › 外观',
  terminal: '终端',
  transfer: '终端 › 文件传输',
  security: '安全与锁定',
  shortcuts: '通用 › 快捷键',
  models: 'AI 模型',
  agent: 'Agent 与安全 › 执行与审批',
  cmdsec: 'Agent 与安全 › 命令安全',
  skills: '扩展 › Skill',
  mcp: '扩展 › MCP',
  sync: '账户',
  storage: '数据',
  data: '账户',
  feedback: '关于 › 问题反馈',
  about: '关于',
};

export const TERMINAL_CAT_LABEL: Record<TerminalCat, string> = { display: '基础与显示', connect: '连接', smart: '搜索与智能', monitor: '监控' };

const T = (cat: TerminalCat, group: string, items: [label: string, desc?: string, keywords?: string][]): SettingsSearchItem[] =>
  items.map(([label, desc, keywords]) => ({ section: 'terminal', cat, group, label, desc, keywords }));
const S = (section: SettingsSectionKey, group: string | undefined, items: [label: string, desc?: string, keywords?: string][]): SettingsSearchItem[] =>
  items.map(([label, desc, keywords]) => ({ section, group, label, desc, keywords }));

export const SETTINGS_INDEX: SettingsSearchItem[] = [
  // ---------------------------------------------------------------- 外观
  ...S('appearance', '界面', [
    ['主题', '整个软件的配色，深色、浅色、跟随系统', '深色 浅色 暗色 夜间 dark light 配色 皮肤 颜色 theme'],
    ['界面字体', '菜单、列表、对话框等界面文字使用的字体', 'font 字体'],
  ]),
  ...S('appearance', '左侧导航', [['显示的页面', '隐藏不常用的页面：数据库、监控、指令集、笔记、审计、定时任务、审批', '菜单 侧栏 导航 隐藏 显示 nav']]),
  ...S('appearance', '背景媒体', [['终端背景', '为终端设置自定义图片或视频背景', '壁纸 图片 视频 背景 background']]),
  ...S('appearance', '终端外观', [
    ['字体', '终端使用的等宽字体', 'font 等宽'],
    ['本地终端环境', '本机终端对齐系统终端（读取 .zshrc 等）或干净终端', 'shell zsh bash 登录 环境变量'],
    ['字号', '默认字号和 Ctrl / ⌘ + 滚轮缩放的范围', 'font size 缩放 大小'],
    ['光标样式', '方块、下划线、竖线', 'cursor'],
    ['光标闪烁', undefined, 'cursor blink'],
    ['行高', '行与行之间的距离（倍数）', 'line height'],
    ['字间距', '字符之间额外的距离（像素）', 'letter spacing'],
  ]),
  // ---------------------------------------------------------------- 终端
  ...T('display', '显示', [
    ['字号', undefined, 'font size'],
    ['字体', '常用的等宽字体，缺字时自动用后备字体', 'font 等宽'],
    ['终端配色', '跟随应用主题或单独设置配色方案', '颜色 配色 主题 scheme color'],
    ['回滚行数', '每个终端在内存里保留的历史行数', 'scrollback 历史 缓冲区'],
    ['输出高亮', '给 IP、URL、日期、错误 / 警告等关键字上色', '高亮 关键字 颜色 highlight'],
  ]),
  ...T('display', '鼠标与剪贴板（和 MobaXterm 一样）', [
    ['选中即复制', '在终端里选中文字后自动复制到剪贴板', '复制 剪贴板 copy MobaXterm'],
    ['中键粘贴', '按下鼠标滚轮粘贴剪贴板里的内容', '粘贴 滚轮 中键 paste'],
    ['右键粘贴', '右键单击粘贴；长按右键或 Ctrl + 右键打开右键菜单', '粘贴 右键 菜单 长按 paste'],
  ]),
  ...T('connect', '连接', [
    ['连接超时', 'TCP 连接和 SSH 握手各自的等待时间', 'timeout 超时'],
    ['自动重试', '连接失败时自动重试', 'retry 重连'],
  ]),
  ...T('smart', '搜索高亮（⌘F / Ctrl+Shift+F）', [
    ['命中背景', '终端搜索命中的颜色', '搜索 颜色'],
    ['命中边框', undefined, '搜索 颜色'],
    ['概览标尺', '滚动条旁边标出命中位置', '搜索 滚动条'],
    ['当前命中背景', undefined, '搜索 颜色'],
    ['当前命中边框', undefined, '搜索 颜色'],
    ['当前概览标尺', undefined, '搜索 滚动条'],
  ]),
  ...T('smart', '高亮性能', [
    ['单段最大长度', '一次输出超过这么多字符时不做关键词高亮', '高亮 性能 卡顿'],
    ['备用缓冲区跳过高亮', '在 vim / less / top 等全屏程序里不做关键词高亮', '高亮 vim 全屏'],
  ]),
  ...T('smart', '命令提示', [
    ['智能提示', '输入命令时显示历史命令和常用命令（带中文说明）', '补全 提示 自动完成 历史命令 suggest'],
    ['触发最小字符数', undefined, '补全 提示'],
    ['每页显示条数', undefined, '补全 提示 最大建议数'],
    ['显示历史命令', undefined, '补全 历史'],
    ['显示命令库', '从内置的常用命令库提供建议', '补全 命令库'],
    ['显示快捷命令', '从指令集中提供建议', '补全 指令集 快捷命令'],
    ['串口命令提示', '串口会话也显示命令提示', '串口 serial'],
  ]),
  ...T('smart', 'AI 辅助', [
    ['行内补全', '输入停顿时灰色提示历史命令，按 → 接受', 'AI 补全 copilot'],
    ['# 问 AI', '在终端行首输入 # 开头的问题，回车后发给 AI', 'AI 提问 井号'],
  ]),
  ...T('monitor', '系统监控', [
    ['启用 SSH 远程工具', '关闭后不再在服务器上运行监控采集和终端目录跟随（堡垒机等受限环境）', '监控 采集 堡垒机 目录跟随'],
    ['隐藏特殊分区', '默认隐藏 EFI、/run、/snap 等伪文件系统', '磁盘 分区 监控'],
    ['隐藏 Docker 相关分区', undefined, '磁盘 分区 docker 监控'],
    ['仅监测指定挂载点', undefined, '磁盘 挂载点 监控'],
    ['隐藏 Docker / 虚拟网卡', undefined, '网卡 网络 docker 监控'],
    ['仅监测指定网卡', undefined, '网卡 网络 监控'],
  ]),
  // ---------------------------------------------------------------- 文件传输
  ...S('transfer', '传输', [
    ['同时传输数', '同一个 SFTP 会话最多同时进行几个传输', '并发 SFTP 上传 下载'],
    ['限速', '所有传输共用的速度上限', '速度 带宽 SFTP 上传 下载'],
  ]),
  ...S('transfer', '同名文件', [['冲突处理', '目标已有同名文件时询问覆盖、跳过、保留两者或续传', '覆盖 跳过 续传 同名']]),
  // ---------------------------------------------------------------- 安全与锁定
  ...S('security', '主密码', [['主密码', '启动时需要输入主密码，查看凭证明文前需要再次验证', '密码 解锁 加密 master password']]),
  ...S('security', '锁定', [
    ['自动锁定', '空闲多久后锁定；系统锁屏或睡眠时也会锁定', '锁屏 锁定 lock'],
    ['Touch ID', '锁定后可以用指纹解锁', '指纹 解锁'],
  ]),
  ...S('security', '审计与录像', [
    ['会话录像', '记录终端输出，可以在「审计」里回放', '录像 回放 asciicast 审计'],
    ['本机终端也录像', undefined, '录像 本地终端'],
    ['命令审计保留', '超过这个天数的命令记录会自动删除', '审计 保留 天数'],
    ['录像保留', '超过这个天数的会话录像会自动删除', '录像 保留 天数'],
  ]),
  // ---------------------------------------------------------------- 快捷键（每一项都可以搜到）
  ...SHORTCUTS.map((s) => ({ section: 'shortcuts' as const, group: s.group, label: s.label, keywords: '快捷键 组合键 shortcut' })),
  // ---------------------------------------------------------------- 存储位置
  ...S('storage', '占用空间', [['占用空间', '本地数据、录像、日志占用的磁盘空间', '磁盘 空间 清理']]),
  ...S('storage', '目录', [
    ['本地数据目录', '加密数据库所在的目录，可以搬到其他位置', '数据目录 位置 迁移'],
    ['录像目录', undefined, '录像 目录 位置'],
    ['笔记保存路径', '笔记同时保存为 Markdown 文件的目录', '笔记 Markdown 目录'],
  ]),
  // ---------------------------------------------------------------- AI 模型
  ...S('models', '模型提供商', [['模型提供商', '添加 DeepSeek、千问、Claude、GPT、Ollama 等模型服务；检测模型能力、思考档位、图片支持', '模型 服务商 API Key 密钥 DeepSeek 千问 Claude OpenAI GPT Gemini Kimi 豆包 Ollama provider 检测 能力 思考 档位 图片']]),
  ...S('models', '模型分工', [
    ['对话模型', '新对话默认使用的模型', '默认模型'],
    ['快速模型', '用于命令复核、终端 AI 补全、对话压缩', '小模型 补全'],
    ['内网模型', '命中敏感数据规则时改用的私有模型', '私有 内网 敏感'],
  ]),
  ...S('models', '默认参数', [
    ['默认开启深度思考', undefined, '思考 推理 thinking'],
    ['默认思考强度', undefined, '思考 推理 effort'],
    ['默认温度', '越低回答越稳定', 'temperature 温度'],
    ['请求超时', '单次模型请求最长等待时间', 'timeout 超时'],
  ]),
  ...S('models', '联网搜索', [
    ['搜索服务', '联网搜索用服务端的默认配置，还是自己配置的 Key', '联网 搜索 网页 web search fetch DeepSeek 服务端 Key'],
    ['接口格式', 'DeepSeek 格式或自定义格式（兼容 Kimi 等）', '联网 搜索 DeepSeek Kimi 自定义 格式'],
    ['接口地址', 'DeepSeek 搜索接口的根地址', '联网 搜索 地址 代理'],
    ['搜索接口地址', '自定义搜索服务的搜索接口', '联网 搜索 自定义 地址'],
    ['网页读取接口地址', '自定义搜索服务的网页读取接口', '联网 网页 读取 fetch'],
    ['API Key', '联网搜索服务的 API Key', '联网 搜索 密钥 Key'],
    ['每次搜索的结果数', undefined, '联网 搜索 条数'],
    ['新对话默认打开联网', undefined, '联网 搜索 默认'],
    ['测试搜索', '用当前配置搜一次', '联网 搜索 测试'],
  ]),
  ...S('models', '图片识别 Fallback', [
    ['启用图片识别 Fallback', '当前模型看不了图片时，先用识图模型把图片转成文字', '图片 识图 视觉 vision OCR fallback'],
    ['识图模型', '把图片转成文字用的模型', '图片 识图 视觉 vision OCR'],
  ]),
  // ---------------------------------------------------------------- Agent 与审批
  ...S('agent', '命令执行', [
    ['默认 Agent 权限', '只读 / 自动 / 完全允许，主机和分组没有设置时使用', '权限 审批 只读 自动 完全允许 AI 审核 高危'],
    ['只读命令自动执行', undefined, '只读 自动 审批'],
    ['LLM 复核', '再让快速模型复核一次风险等级', '复核 风险'],
    ['夜间时段', '这段时间里 Agent 不能执行写操作', '夜间 时间段 禁止'],
  ]),
  ...S('agent', '对话', [
    ['最大对话循环次数', '一次任务里 Agent 最多进行多少轮工具调用', '轮数 循环 上限'],
    ['自动压缩阈值', '上下文占用达到这个比例时自动总结', '上下文 压缩 摘要'],
    ['终端里显示执行提示', 'Agent 执行命令时在对应终端里显示一行提示', '终端 提示'],
  ]),
  ...S('agent', '数据库', [
    ['查询最多返回的行数', undefined, '数据库 SQL 行数'],
    ['SQL 工作台显示的行数', undefined, '数据库 SQL 工作台 行数'],
    ['查询超时', undefined, '数据库 SQL 超时'],
    ['按列名脱敏', '查询结果发给模型前把密码、手机号等列打码', '脱敏 隐私 数据库'],
  ]),
  ...S('agent', '提醒', [['需要审批时通知', '不在前台时等你批准会发系统通知', '通知 提醒 审批']]),
  ...S('agent', '隐私', [['隐藏 IP 地址', '发给模型前把 IP 替换成 HOST_IP_n', '脱敏 隐私 IP']]),
  ...S('agent', '主机记忆', [['Agent 记录主机记忆', '验证过的自动记录，不确定的 10 秒不回应就跳过', '记忆 memory 主机记忆']]),
  ...S('agent', 'AI 规则', [['AI 规则', '追加到 Agent 系统提示词的用户规则', '规则 提示词 prompt']]),
  // ---------------------------------------------------------------- 命令安全
  ...S('cmdsec', '命令测试', [['命令测试', '输入命令看会被判定成什么风险等级', '测试 风险 等级']]),
  ...S('cmdsec', '处理策略', [
    ['只读命令（L0）自动执行', undefined, 'L0 只读'],
    ['写操作（L1）', undefined, 'L1 写操作'],
    ['高危命令（L2）', '删除数据、格式化、批量杀进程等不可逆操作', 'L2 高危 危险'],
    ['黑名单命中', undefined, '黑名单 禁止'],
    ['严格模式', '不在任何规则里的未知命令直接拒绝', '严格 未知命令'],
    ['最大命令长度', undefined, '长度'],
  ]),
  ...S('cmdsec', undefined, [
    ['快捷名单（按命令前缀匹配）', '白名单、黑名单、高危命令前缀', '白名单 黑名单 前缀'],
    ['自定义规则', '正则匹配的命令规则', '规则 正则 regex'],
  ]),
  // ---------------------------------------------------------------- Skill / MCP
  ...S('skills', undefined, [['已安装', '新建、导入、编辑、分享 Skill', 'Skill 技能 导入 分享 运维']]),
  ...S('mcp', '本机 MCP 服务（给外部 Agent 用）', [
    ['本机 MCP 服务（给外部 Agent 用）', 'Claude Code、Cursor 等外部 Agent 调用 iTerminal', 'MCP Claude Code Cursor 外部 Agent'],
    ['端口', undefined, 'MCP port'],
    ['令牌', undefined, 'MCP token'],
    ['权限', '外部 Agent 可以执行的操作', 'MCP 写操作 高危'],
    ['开放的工具', undefined, 'MCP 工具 tools'],
    ['在 Claude Code 里添加', undefined, 'MCP Claude Code'],
  ]),
  ...S('mcp', undefined, [['外部 MCP Server（给 iTerminal 的 Agent 用）', '给 iTerminal 的 Agent 接入外部 MCP Server', 'MCP server 外部工具']]),
  // ---------------------------------------------------------------- 云同步
  ...S('sync', undefined, [
    ['云端备份与分享码', '登录后把数据加密备份到云端，或者生成分享码', '云端 备份 分享码 同步密码 恢复码 cloud'],
    ['本地数据统计', undefined, '统计 数量'],
  ]),
  ...S('sync', '本地文件', [
    ['导出到文件', '生成加密的 .itmbak 文件，用于离线迁移', '导出 备份 迁移 itmbak export'],
    ['从文件导入', '合并到本地或覆盖本地', '导入 恢复 itmbak import'],
  ]),
  ...S('sync', undefined, [['自动备份', '合并 / 覆盖之前自动生成的本地备份，可以撤回', '撤回 备份 恢复']]),
  // ---------------------------------------------------------------- 数据与账号 / 反馈 / 关于
  ...S('storage', '目录', [['加密', 'SQLCipher 整库加密，密码和私钥再单独加密', '加密 安全 数据目录']]),
  ...S('sync', undefined, [['账户', '登录、退出登录、切换账号', '登录 退出 账号 account 数据与账号']]),
  ...S('feedback', undefined, [
    ['反馈内容', '提交问题或建议，可以附截图和诊断信息', '反馈 问题 bug 建议'],
    ['诊断信息', undefined, '日志 诊断'],
    ['我的反馈', undefined, '反馈 回复'],
  ]),
  ...S('about', undefined, [['版本', undefined, '版本号 version']]),
  ...S('about', '更新', [
    ['检查更新', undefined, '更新 升级 新版本 update'],
    ['更新渠道', '正式版 / 测试版', 'beta 测试版'],
    ['自动检查', '启动后和每 6 小时检查一次更新', '更新 自动'],
  ]),
];

/** 搜索：所有词都要命中（名称、分组、说明、关键词、页面名），名称命中的排在前面 */
export function searchSettings(query: string, aiAllowed = true): SettingsSearchItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: { item: SettingsSearchItem; score: number }[] = [];
  for (const item of SETTINGS_INDEX) {
    const label = item.label.toLowerCase();
    const hay = [label, item.group, item.desc, item.keywords, SECTION_LABEL[item.section], item.cat ? TERMINAL_CAT_LABEL[item.cat] : ''].join(' ').toLowerCase();
    if (!terms.every((t) => hay.includes(t))) continue;
    const score = terms.reduce((n, t) => n + (label.startsWith(t) ? 3 : label.includes(t) ? 2 : 0), 0) - (aiAllowed || !['models', 'agent', 'cmdsec', 'skills', 'mcp'].includes(item.section) ? 0 : 1);
    scored.push({ item, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 50).map((s) => s.item);
}

/** 搜到后要定位的设置（TerminalSettings 按 cat 切换分类，SettingsPage 滚动到这一行并闪一下） */
export const useSettingsFocus = create<{ target: (SettingsSearchItem & { seq: number }) | null; focus(item: SettingsSearchItem): void }>((set) => ({
  target: null,
  focus: (item) => set((s) => ({ target: { ...item, seq: (s.target?.seq ?? 0) + 1 } })),
}));
