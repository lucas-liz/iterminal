import { DEFAULT_HIGHLIGHT, type HighlightSettings } from './highlight';
import { DEFAULT_APP_THEME, DEFAULT_TERMINAL_COLORS, type TerminalColorSettings } from './terminal-colors';
import type { ShortcutMap } from './shortcuts';
import type { Effort, ModelRef } from './ai';

/** AI 规则（自定义指令，文档一 6.15.6）：追加到系统提示词的「用户规则」 */
export interface AiRule {
  id: string;
  text: string;
  enabled: boolean;
}
import type { AgentPolicy } from './core';
import { DEFAULT_MONITOR_ALERT, type MonitorAlertConfig } from './monitor';

export type ThemeMode = 'dark' | 'light' | 'system';

/** 左侧导航里可以隐藏的页面（主机、终端、设置必须常驻）；第三十五轮去掉定时任务、加入批量执行 */
export const NAV_OPTIONAL = ['databases', 'monitor', 'snippets', 'notes', 'audit', 'batch', 'approvals'] as const;
export type NavOptional = (typeof NAV_OPTIONAL)[number];

/**
 * 终端里的鼠标复制粘贴（参考 MobaXterm，默认都开启）：选中即复制、按下滚轮粘贴、右键单击粘贴。
 * 右键粘贴时，长按右键（约半秒）或按住 Ctrl（macOS 也可以按住 ⌘）再右键打开右键菜单；全屏程序开启了鼠标模式时，中键 / 右键交给程序（按住 Shift 仍然粘贴）。
 */
export interface TerminalMouseSettings {
  copyOnSelect: boolean;
  middlePaste: boolean;
  rightPaste: boolean;
}

export interface SuggestSettings {
  enabled: boolean;
  /** 输入几个字符后开始提示 */
  minChars: number;
  /** 一页显示几条（总共最多 20 条，超出的滚动查看） */
  maxItems: number;
  /** 这台主机的历史命令 */
  history: boolean;
  /** 内置命令库（带中文说明） */
  library: boolean;
  /** 快捷命令（指令集） */
  snippets: boolean;
  /** 串口会话也提示 */
  serial: boolean;
}

export interface SearchColors {
  matchBg: string;
  matchBorder: string;
  /** 滚动条旁边的概览标尺 */
  matchRuler: string;
  activeBg: string;
  activeBorder: string;
  activeRuler: string;
}

export interface MonitorConfig {
  /** 关闭后不再在服务器上运行监控采集和目录跟随（适合堡垒机等受限环境） */
  enabled: boolean;
  /** 隐藏 EFI、/run、/snap、很小的分区等 */
  hideSpecialFs: boolean;
  /** 隐藏 /var/lib/docker、/var/lib/kubelet 等容器相关的挂载点 */
  hideDockerFs: boolean;
  /** 只显示这些挂载点（空格 / 逗号 / 分号分隔；空表示不过滤） */
  mounts: string;
  /** 隐藏 docker0、br-、veth 等虚拟网卡 */
  hideVirtualNics: boolean;
  /** 只显示这些网卡（空表示不过滤） */
  nics: string;
}

/** 终端背景媒体（设置 → 外观，第十二轮）：图片或视频铺在终端下面，上面盖一层终端底色 */
export interface TerminalBackground {
  kind: 'none' | 'image' | 'video';
  /** 档案目录 appearance/ 里的文件名（选择背景时复制进来） */
  file: string;
  /** 终端底色盖在媒体上的不透明度：越大媒体越淡、文字越清楚（0–0.95） */
  dim: number;
  /** 媒体模糊（px，0–20） */
  blur: number;
  /** 填充方式：铺满（裁剪）/ 完整显示 / 拉伸 / 平铺（只对图片） */
  fit: 'cover' | 'contain' | 'fill' | 'tile';
}
export const DEFAULT_TERMINAL_BACKGROUND: TerminalBackground = { kind: 'none', file: '', dim: 0.7, blur: 0, fit: 'cover' };
/** 背景媒体支持的格式（视频建议 MP4 / H.264） */
export const BACKGROUND_IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
export const BACKGROUND_VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v'];

/** 本地设置（只存本地，不上云）。新增键必须同时在 DEFAULT_SETTINGS 和主进程的校验表里登记。 */
/** 引用终端最近输出（AI 对话 + 里的开关和行数） */
export interface TerminalContextSetting {
  enabled: boolean;
  lines: number;
}
export const TERMINAL_CONTEXT_LINES = { min: 10, max: 2000 };

/**
 * 联网搜索（文档一 6.39，第二十五轮改为独立的工具）：输入框的「联网」开关打开时，Agent 多出 web_search / web_fetch 两个工具。
 * source：server = 用服务端的默认配置（管理员配置，Key 不下发）；personal = 自己的配置（Key 加密保存在本机，不在这里）。
 * format：deepseek（baseUrl 留空 = 官方地址）或 custom（searchUrl / fetchUrl 填完整地址）。
 * count：每次搜索返回的条数；defaultOn：新对话默认打开（默认关闭）。
 */
export interface WebSearchSetting {
  source: 'server' | 'personal';
  format: 'deepseek' | 'custom';
  baseUrl: string;
  searchUrl: string;
  fetchUrl: string;
  count: number;
  defaultOn: boolean;
}

/** 图片识别 Fallback（第二十五轮）：当前模型不能看图时，先用这个模型把图片转成文字描述，再交给当前模型 */
export interface VisionFallbackSetting {
  enabled: boolean;
  model: ModelRef | null;
}
export const WEB_SEARCH_COUNT = { min: 1, max: 20 };

export interface Settings {
  /** 界面模式：深色 / 浅色 / 跟随系统 */
  'ui.theme': ThemeMode;
  /** 应用主题（第十二轮）：深色模式、浅色模式各用哪个配色方案，决定整个界面的配色（终端默认跟随） */
  'ui.themeDark': string;
  'ui.themeLight': string;
  /** 界面字体（CSS font-family）；空字符串表示跟随系统 */
  'ui.fontFamily': string;
  /** 左侧导航里隐藏的页面（第二十二轮）；主机、终端、设置始终显示 */
  'ui.navHidden': NavOptional[];
  /** 终端输出高亮（预设规则开关、自定义规则、彩虹括号） */
  'terminal.highlight': HighlightSettings;
  /** 终端里输入命令时的提示（历史命令、内置命令库、快捷命令；不请求 AI） */
  'terminal.suggest': SuggestSettings;
  /** 终端里的鼠标复制粘贴（参考 MobaXterm，第二十一轮） */
  'terminal.mouse': TerminalMouseSettings;
  /** 终端搜索（Ctrl / ⌘ + F）的命中颜色 */
  'terminal.search': SearchColors;
  /** 终端配色方案：深色界面、浅色界面各选一个，可以自定义 */
  'terminal.colors': TerminalColorSettings;
  /** 主机监控：是否运行远程采集、隐藏哪些分区 / 网卡 */
  'monitor.config': MonitorConfig;
  /** 默认模型 */
  'ai.defaultModel': ModelRef | null;
  /** 一次任务最多进行多少轮工具调用（对话循环次数上限） */
  'ai.maxRounds': number;
  /** 只读命令（L0）自动执行 */
  'ai.autoApproveReadonly': boolean;
  /** 上下文占用达到这个百分比时自动压缩 */
  'ai.autoCompressPct': number;
  /** 主机和所有上级分组都没有设置 Agent 权限时使用 */
  'ai.defaultAgentPolicy': AgentPolicy;
  /** 规则判定之后再让模型复核一次（只能升级风险） */
  'ai.llmReview': boolean;
  /** 夜间窗口：这段时间里禁止 Agent 执行写操作 */
  'ai.nightWindow': { enabled: boolean; from: string; to: string };
  /** 快速模型：命令复核、终端补全使用（不设置时用对话的模型） */
  'ai.fastModel': ModelRef | null;
  /** 发给模型前把 IP 地址替换成 HOST_IP_n */
  'ai.maskIps': boolean;
  /**
   * 主机记忆（第二十八轮）：auto = 本次验证过的结论直接记录，不确定的问你（10 秒没回应就不记）；
   * ask = 每条都问你（10 秒没回应就不记）；off = 不让 Agent 记录主机记忆
   */
  'ai.memoryPolicy': 'auto' | 'ask' | 'off';
  /** Agent 执行命令时在对应的终端里显示一行提示 */
  'ai.echoToTerminal': boolean;
  /** 命中「强制内网模型」的脱敏规则时改用这个模型 */
  'ai.sensitiveModel': ModelRef | null;
  /** 深度思考默认开启（模型自己的设置优先，文档一 6.15.5）；第三十一轮起默认关闭 */
  'ai.thinkingDefault': boolean;
  /** 默认思考强度；null = 模型默认 */
  'ai.thinkingEffort': Effort | null;
  /** 默认温度；null = 模型默认 */
  'ai.temperature': number | null;
  /** 模型请求超时（秒） */
  'ai.requestTimeoutSec': number;
  /** 应用不在前台时，等待审批发系统通知 */
  'ai.notifyApproval': boolean;
  /** AI 对话 + 里的「引用终端最近 N 行」：每次发送带上引用终端里模型还没看过的最近输出（最多 lines 行） */
  'ai.terminalContext': TerminalContextSetting;
  /** 联网搜索：搜索服务、结果条数、新对话默认开关 */
  'ai.webSearch': WebSearchSetting;
  /** 图片识别 Fallback（第二十五轮） */
  'ai.visionFallback': VisionFallbackSetting;
  /** 设置里「启用的模型」的拖拽顺序（提供商 ID，团队模型也在里面），第二十五轮 */
  'ai.providerOrder': string[];
  /** AI 规则（自定义指令） */
  'ai.rules': AiRule[];
  /** 会话录像（asciicast，只记录输出，按主机的「会话录制」设置） */
  'audit.recordSessions': boolean;
  /** 本机 Shell 也录像 */
  'audit.recordLocal': boolean;
  /** 本机命令审计和安全事件保留天数（默认 180 天） */
  'audit.retentionDays': number;
  /** 本机会话录像保留天数（默认 30 天） */
  'audit.recordingRetentionDays': number;
  /** 命令安全（文档一 6.15.7）：高危命令处理 / 黑名单处理 / 严格模式 / 最大命令长度 */
  'security.l2Decision': 'CONFIRM' | 'APPROVE' | 'DENY';
  'security.blacklistDecision': 'DENY' | 'CONFIRM';
  'security.strict': boolean;
  'security.maxLength': number;
  /** 终端行内补全：关闭 / 只用本机历史命令 / 历史 + AI 补全模型 */
  'ai.inlineCompletion': 'off' | 'local' | 'ai';
  /** 终端里以 # 开头的输入不发送到远端，转给 AI 面板 */
  'ai.hashAsk': boolean;
  'terminal.fontSize': number;
  'terminal.fontFamily': string;
  'terminal.scrollback': number;
  /** 终端缩放（Ctrl / ⌘ + 滚轮）的字号范围 */
  'terminal.fontSizeMin': number;
  'terminal.fontSizeMax': number;
  /** 光标样式和闪烁 */
  'terminal.cursorStyle': 'block' | 'underline' | 'bar';
  'terminal.cursorBlink': boolean;
  /** 行高（倍数）和字间距（px） */
  'terminal.lineHeight': number;
  'terminal.letterSpacing': number;
  /** 本机终端的环境：对齐系统终端（登录 shell，读取 .zshrc 等）或干净终端（不读启动文件、精简环境变量） */
  'terminal.localEnv': 'system' | 'clean';
  /** 终端背景图片 / 视频 */
  'terminal.background': TerminalBackground;
  /** 连接超时（秒）：TCP 连接和 SSH 握手各自的超时 */
  'terminal.connectTimeoutSec': number;
  /** 网络错误（超时、连接被拒、握手超时）自动重试的次数 */
  'terminal.connectRetries': number;
  /** 无操作多少分钟后自动锁定（需要主密码；0 = 不自动锁定） */
  'security.autoLockMin': number;
  /** 锁定后允许用 Touch ID 解锁（macOS） */
  'security.touchId': boolean;
  /** SFTP 传输限速（KB/s，所有传输共用；0 = 不限速） */
  'sftp.rateLimitKBps': number;
  /** 同一个 SFTP 会话同时进行的传输数 */
  'sftp.concurrency': number;
  /** 常驻监控的主机（第二十七轮起应用运行期间在后台持续采集，不用打开终端或监控页） */
  'monitor.dashboardHosts': string[];
  /** 主机加入常驻监控的时间（主机 ID → 毫秒） */
  'monitor.residentSince': Record<string, number>;
  /** 常驻监控的告警阈值和通知 */
  'monitor.alert': MonitorAlertConfig;
  /** 文件面板显示隐藏文件（. 开头），第十六轮 */
  'sftp.showHidden': boolean;
  /** 文件面板收藏的目录：主机 ID → 路径 */
  'sftp.favorites': Record<string, string[]>;
  /** 本机 MCP 服务（外部 Agent 使用 iTerminal 的主机和命令） */
  'mcp.server.enabled': boolean;
  'mcp.server.port': number;
  /** 本机 MCP 服务开放给外部 Agent 的工具 */
  'mcp.server.tools': string[];
  /** 外部 Agent 可以执行写操作（L1 命令、写文件、改笔记 / Skill），第十三轮；不弹审批 */
  'mcp.server.allowWrite': boolean;
  /** 外部 Agent 可以执行高危指令（L2），需要同时允许写操作 */
  'mcp.server.allowDanger': boolean;
  /** 开放工具列表的版本：小于 2 时把第十三轮新增的工具加进去（只加一次） */
  'mcp.server.toolsRev': number;
  /** 最近一次导出 / 上传备份的时间（云同步页的「上次备份」） */
  'sync.lastBackupAt': number | null;
  /** 用户改过的快捷键（没改的用默认值） */
  'ui.shortcuts': ShortcutMap;
  /** 笔记同时保存为 Markdown 文件的目录（空表示只保存在本机数据库里） */
  'storage.notesDir': string;
  /** 会话录像的存储目录（空表示放在数据目录里） */
  'storage.recordingsDir': string;
  /** 数据库查询（文档一 6.31）：每次最多返回的行数（最大 1000） */
  'db.maxRows': number;
  /** 数据库查询超时（秒，最大 300） */
  'db.timeoutSec': number;
  /** 发给模型前按列名脱敏（密码 / 密钥列 → ****，手机号 / 邮箱 / 身份证等列 → [PII]） */
  'db.maskColumns': boolean;
  /** SQL 工作台每个结果最多显示的行数（第十八轮，最大 5000） */
  'db.workbenchRows': number;
}

export const DEFAULT_SETTINGS: Settings = {
  'ui.theme': 'dark',
  'ui.themeDark': DEFAULT_APP_THEME.dark,
  'ui.themeLight': DEFAULT_APP_THEME.light,
  'ui.shortcuts': {},
  'storage.notesDir': '',
  'storage.recordingsDir': '',
  'ui.fontFamily': '',
  'ui.navHidden': [],
  'terminal.highlight': DEFAULT_HIGHLIGHT,
  'terminal.suggest': { enabled: true, minChars: 2, maxItems: 8, history: true, library: true, snippets: true, serial: false },
  'terminal.mouse': { copyOnSelect: true, middlePaste: true, rightPaste: true },
  'terminal.search': { matchBg: '#4d4100', matchBorder: '#8a7500', matchRuler: '#ffd60a', activeBg: '#8f4a00', activeBorder: '#ff9f0a', activeRuler: '#ff9f0a' },
  'monitor.config': { enabled: true, hideSpecialFs: true, hideDockerFs: true, mounts: '', hideVirtualNics: true, nics: '' },
  'terminal.colors': DEFAULT_TERMINAL_COLORS,
  'ai.defaultModel': null,
  'ai.maxRounds': 50,
  'ai.autoApproveReadonly': true,
  'ai.autoCompressPct': 90,
  'ai.defaultAgentPolicy': 'APPROVE',
  'ai.llmReview': true,
  'ai.nightWindow': { enabled: false, from: '00:00', to: '08:00' },
  'ai.fastModel': null,
  'ai.maskIps': false,
  'ai.memoryPolicy': 'auto',
  'ai.echoToTerminal': true,
  'ai.sensitiveModel': null,
  'ai.thinkingDefault': false,
  'ai.thinkingEffort': null,
  'ai.temperature': null,
  'ai.requestTimeoutSec': 120,
  'ai.notifyApproval': true,
  'ai.terminalContext': { enabled: true, lines: 200 },
  'ai.webSearch': { source: 'server', format: 'deepseek', baseUrl: '', searchUrl: '', fetchUrl: '', count: 8, defaultOn: false },
  'ai.visionFallback': { enabled: false, model: null },
  'ai.providerOrder': [],
  'ai.rules': [],
  'audit.recordSessions': true,
  'audit.recordLocal': false,
  'audit.retentionDays': 180,
  'audit.recordingRetentionDays': 30,
  'security.l2Decision': 'CONFIRM',
  'security.blacklistDecision': 'DENY',
  'security.strict': false,
  'security.maxLength': 10000,
  'ai.inlineCompletion': 'local',
  'ai.hashAsk': true,
  'terminal.fontSize': 14,
  'terminal.fontFamily': 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace',
  'terminal.scrollback': 5000,
  'terminal.fontSizeMin': 8,
  'terminal.fontSizeMax': 40,
  'terminal.cursorStyle': 'block',
  'terminal.cursorBlink': true,
  'terminal.lineHeight': 1,
  'terminal.letterSpacing': 0,
  'terminal.localEnv': 'system',
  'terminal.background': DEFAULT_TERMINAL_BACKGROUND,
  'terminal.connectTimeoutSec': 15,
  'terminal.connectRetries': 2,
  'security.autoLockMin': 15,
  'security.touchId': false,
  'sftp.rateLimitKBps': 0,
  'sftp.concurrency': 3,
  'monitor.dashboardHosts': [],
  'monitor.residentSince': {},
  'monitor.alert': DEFAULT_MONITOR_ALERT,
  'sftp.showHidden': true,
  'sftp.favorites': {},
  'mcp.server.enabled': false,
  'mcp.server.port': 7788,
  'mcp.server.tools': ['list_hosts', 'get_metrics', 'sftp_read', 'ssh_exec', 'sftp_write', 'run_skill', 'note_list', 'note_read', 'note_save', 'skill_list', 'skill_read', 'skill_save', 'kb_search'],
  'mcp.server.allowWrite': false,
  'mcp.server.allowDanger': false,
  'mcp.server.toolsRev': 1,
  'sync.lastBackupAt': null,
  'db.maxRows': 200,
  'db.timeoutSec': 30,
  'db.maskColumns': true,
  'db.workbenchRows': 1000,
};

/** 设置 → 存储位置：各个目录和占用的空间 */
export interface StorageInfo {
  /** 当前的本地数据目录（数据库、密钥、录像、Skill 等都在这里） */
  dataDir: string;
  defaultDataDir: string;
  /** 上一次更换数据目录失败的原因 */
  dataError: string | null;
  /** 当前档案的目录（数据目录下的 profiles/…） */
  profileDir: string;
  /** 笔记同时保存为 Markdown 文件的目录（空表示没有开启） */
  notesDir: string;
  /** 实际的录像目录 */
  recordingsDir: string;
  recordingsCustom: boolean;
  usage: { dataDir: number; database: number; recordings: number; recordingsCount: number; notesDir: number; notesCount: number };
}
