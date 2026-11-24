import type { AutoBackupInfo, BackupFileInfo, CloudBackupInfo, CloudShareInfo, CloudStatus, LocalStats, ShareContent, ShareImportPick, ShareLinkCreated, ShareLinkInfo, ShareLinkOptions, SharePreview, ShareSelection, ShareSelectionPreview, SyncGroup, SyncReport } from './sync';
import type { DiagEntry, FeedbackImage, FeedbackInput, FeedbackPreview, FeedbackRecord } from './feedback';
import type { AuditEntry, AuditFilter, RecordingCommand, RecordingData, RecordingInfo } from './audit';
import type { UpdateChannel, UpdateState } from './update';
import type { AccountState, AdminServerConfig, AdminServerTest, KbCollectionInfo, LoginInput, RemoteApproval, ServerState, TaskRunFilter, TaskRunView } from './server';
import type { LocalTask, LocalTaskInput, ScheduleApproval, ScheduleCheck, TaskPlanStep, TaskTrialResult } from './schedule';
import type { AlertEvent, AlertFilter } from './alert';
import type { DbAsset, DbAssetInput, DbColumnInfo, DbObjectList, DbTestOutcome, SqlAiAction, SqlExecResult, SqlPlan } from './database';
import type { ReportWebhook } from './schedule';
import type { BatchCheck, BatchExecInput, BatchFilter, BatchJob, BatchLocalItem, BatchUploadInput } from './batch';
import type {
  AgentConversationSummary,
  AgentConversationView,
  AgentMode,
  AgentRefs,
  AiProvider,
  AiProviderInput,
  ContextUsage,
  ModelRef,
  SkillInfo,
  SkillTargets,
  ThinkingChoice,
  BuiltinRuleView,
  CommandRuleList,
  CommandTestResult,
  UserCommandRule,
  UserCommandRuleInput,
  ChatPolicy,
  ModelProbeResult,
} from './ai';
import type { WebSearchStatus } from './web-search';
import type { WebSearchSetting } from './settings';
import type {
  EffectiveHostPolicy,
  FileEntry,
  Folder,
  FolderDeleteStrategy,
  FolderSettingsInput,
  Host,
  HostInput,
  HostPing,
  HostAgentMemory,
  HostTestOutcome,
  ConnLogEntry,
  ImportPreview,
  ImportResult,
  ImportSource,
  PromptAnswer,
  PortForward,
  PortForwardInput,
  RemoteEditState,
  PortForwardStatus,
  PromptRequest,
  SerialPortInfo,
  SerialSessionState,
  SessionStatus,
  ConnProgress,
  Tag,
  TransferItem,
  TransferState,
} from './core';
import type { BigFile, DiskForecast, MetricSample, MetricsSnapshot, MonitorAlert, MonitorStatic, NetDetail, ProcDetail } from './monitor';
import type { Note, NoteInput, NoteLibrary, Snippet, SnippetInput, SnippetLibrary } from './library';
import type { McpHostState, McpServerConfig, McpServerInput, McpServerStatus } from './mcp';
import type { Settings, StorageInfo, TerminalBackground } from './settings';
import type {
  Credential,
  CredentialInput,
  CredentialSecretView,
  DeployResult,
  RotateProgress,
  RotateReport,
  SecurityState,
  TotpCode,
} from './vault';

/** 企业预置配置（文档一 11.6）：系统级预置 > 用户设置 > 编译期默认值 */
export interface PresetConfig {
  serverUrl: string | null;
  /** true 时关闭本地模式，启动后必须登录 */
  requireLogin: boolean;
  /** 锁定更新渠道（null = 用户可以在「关于」里切换） */
  updateChannel: 'stable' | 'beta' | null;
  allowLocalExport: boolean;
  allowPersonalProvider: boolean;
  /** 来自哪里：default（没有预置）/ registry / mdm / file */
  source: 'default' | 'registry' | 'mdm' | 'file';
}

export interface AppInfo {
  version: string;
  platform: string;
  /** 当前档案 */
  profile: { id: string; kind: 'local' | 'account'; displayName: string };
  dataDir: string;
  /** safeStorage 实际使用的后端，weak 表示没有系统钥匙串，保护较弱 */
  keyProtection: 'os' | 'weak';
  security: SecurityState;
  preset: PresetConfig;
  /**
   * 本地模式（未登录）也允许使用 AI。正式版本地模式不能使用 AI 对话、不能配置 AI（第十二轮），
   * 只有自动化测试（ITM_ALLOW_LOCAL_AI=1 且没有打包）时为 true
   */
  aiLocal: boolean;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

// ------------------------------------------------------------------ IPC 通道（invoke）

export interface IpcApi {
  'app.info': () => AppInfo;

  /** 自定义标题栏窗口控制（Windows / Linux 无边框标题栏用；锁屏 / 解锁前也放行） */
  'window.minimize': () => void;
  'window.maximizeToggle': () => boolean;
  'window.close': () => void;
  'window.isMaximized': () => boolean;

  /** 冷启动或锁定后用主密码解锁 */
  'security.unlock': (a: { password: string }) => void;
  'security.unlockTouchId': () => void;
  'security.lock': () => void;
  /** 没有系统钥匙串时（Linux），第一次使用前必须设置主密码 */
  'security.setup': (a: { password: string }) => void;
  'security.setMasterPassword': (a: { newPassword: string; currentPassword?: string }) => void;
  'security.removeMasterPassword': (a: { currentPassword: string }) => void;

  'folder.list': () => Folder[];
  'folder.create': (a: { parentId: string | null; name: string }) => Folder;
  'folder.rename': (a: { id: string; name: string }) => Folder;
  /** 移到新的父分组下；beforeId 为同级里要放在它前面的分组（为空放在末尾） */
  'folder.move': (a: { id: string; parentId: string | null; beforeId?: string | null }) => void;
  'folder.delete': (a: { id: string; strategy: FolderDeleteStrategy }) => void;
  /** 文件夹设置（默认凭证、跳板机、Agent 权限、说明、默认 Skill） */
  'folder.update': (a: { id: string; settings: FolderSettingsInput }) => Folder;

  'host.list': () => Host[];
  'host.create': (a: HostInput) => Host;
  'host.update': (a: { id: string; input: HostInput }) => Host;
  'host.duplicate': (a: { id: string }) => Host;
  'host.delete': (a: { ids: string[] }) => void;
  'host.move': (a: { hostIds: string[]; folderId: string | null }) => void;
  /** 用表单里的配置测试连接（不保存）；id 为已有主机时，留空的密码 / 私钥沿用已保存的 */
  'host.test': (a: { id: string | null; input: HostInput; testId?: string }) => HostTestOutcome;
  /** 主机列表的延迟：直连的主机测 TCP 连接耗时（并发、每台最多 3 秒） */
  'host.ping': (a: { ids: string[] }) => HostPing[];
  /** Agent 记下的主机记忆（第二十六轮）：列出、修改（id 为空 = 手动新增）、删除 */
  'host.agentMemory.list': (a: { hostId: string }) => HostAgentMemory[];
  'host.agentMemory.save': (a: { id: string | null; hostId: string; content: string }) => HostAgentMemory;
  'host.agentMemory.delete': (a: { id: string }) => void;
  /** 主机记忆导出成 Markdown（第三十轮）：返回默认文件名和内容，由渲染进程弹出保存对话框 */
  'host.memoryMarkdown': (a: { ids: string[] }) => { fileName: string; content: string };
  /** AI 把一台或多台主机的资料（信息、记忆、监控、告警、定时任务、命令）汇总成笔记正文（第三十轮） */
  'host.summaryNote': (a: { ids: string[]; model?: ModelRef | null }) => { title: string; body: string };
  /** 继承分组设置后的有效配置；id 为空时按表单里的分组计算（新建主机） */
  'host.effective': (a: { id: string | null; folderId: string | null }) => EffectiveHostPolicy;
  'host.favorite': (a: { id: string; on: boolean }) => void;
  /** 批量增删标签 */
  'host.tag': (a: { hostIds: string[]; add: string[]; remove: string[] }) => void;

  'tag.list': () => Tag[];
  'tag.update': (a: { id: string; name: string; color: string | null }) => void;
  'tag.delete': (a: { id: string }) => void;

  /** 解析导入文件 / 目录，返回预览（不写库） */
  'import.preview': (a: { source: ImportSource; path: string }) => ImportPreview;
  /** 导入预览里选中的主机，按原分组路径建在 targetFolderId 下 */
  'import.commit': (a: { token: string; keys: string[]; targetFolderId: string | null; skipDuplicates: boolean }) => ImportResult;
  /**
   * 导出主机列表。默认是安全导出（不含密码和私钥）；includeSecrets 时连同密码、私钥、凭证（展开成主机自己的密码 / 私钥）一起导出，
   * 先验证主密码（没有主密码时用 Touch ID），并记一条审计
   */
  'export.hosts': (a: { format: 'CSV' | 'JSON'; path: string; hostIds: string[] | null; includeSecrets?: boolean; password?: string }) => { count: number; secrets: number };

  'credential.list': () => Credential[];
  'credential.save': (a: { id: string | null; input: CredentialInput }) => Credential;
  'credential.delete': (a: { id: string }) => void;
  /** 查看明文：开启了主密码时必须提供；没有主密码时在 macOS 上用 Touch ID 验证 */
  'credential.reveal': (a: { id: string; password?: string }) => CredentialSecretView;
  'credential.totp': (a: { id: string }) => TotpCode;
  /** 把公钥部署到主机的 ~/.ssh/authorized_keys（用主机现有的认证方式登录） */
  'credential.deploy': (a: { id: string; hostIds: string[] }) => DeployResult[];
  /** 轮换向导：生成新密钥 → 部署 → 验证 → 吊销旧密钥 → 替换凭证 */
  'credential.rotate': (a: { id: string; hostIds: string[] }) => RotateReport;

  'session.openSsh': (a: { hostId: string; cols: number; rows: number }) => { sessionId: string };
  'session.openLocal': (a: { cols: number; rows: number }) => { sessionId: string };
  'session.write': (a: { sessionId: string; data: string }) => void;
  'session.resize': (a: { sessionId: string; cols: number; rows: number }) => void;
  'session.close': (a: { sessionId: string }) => void;
  /** Telnet（自动登录、选项协商）；连接进度通过 session.status 通知 */
  'session.openTelnet': (a: { hostId: string; cols: number; rows: number }) => { sessionId: string };
  /** 串口：端口参数来自主机设置 */
  'session.openSerial': (a: { hostId: string }) => { sessionId: string };
  /** 串口：十六进制显示、时间戳、DTR / RTS */
  'session.serialSet': (a: { sessionId: string; hex?: boolean; timestamp?: boolean; dtr?: boolean; rts?: boolean }) => SerialSessionState;
  /** 串口：发送十六进制字节（例如 "48 65 6C"） */
  'session.serialSendHex': (a: { sessionId: string; hex: string }) => void;
  /** 串口：用 XMODEM / YMODEM 发送文件，完成或失败后返回 */
  'session.serialSendFile': (a: { sessionId: string; path: string; protocol: 'xmodem' | 'ymodem' }) => void;
  'session.serialCancel': (a: { sessionId: string }) => void;
  /** 开始 / 停止把终端输出录制到日志文件（path 为 null 时停止） */
  'session.log': (a: { sessionId: string; path: string | null }) => void;
  /** 本机的串口列表 */
  'serial.list': () => SerialPortInfo[];

  /** 读远端文本文件（内置编辑器用；最多 2MB，二进制文件拒绝） */
  'sftp.readText': (a: { sftpId: string; path: string }) => { content: string; mtime: number; size: number };
  /** 写回远端文本文件；expectMtime 和远端当前的修改时间不一致时不写入、返回 ok = false（别人改过），传 null 强制覆盖 */
  'sftp.writeText': (a: { sftpId: string; path: string; content: string; expectMtime: number | null }) => { ok: boolean; mtime: number };
  /** 用系统默认程序编辑远端文件：下载到临时目录，监视修改并自动回传 */
  'sftp.editExternal': (a: { sftpId: string; path: string }) => RemoteEditState;
  'sftp.editList': (a: { sftpId: string | null }) => RemoteEditState[];
  /** 远端在编辑期间被别人改过：覆盖远端，或者丢弃本机修改、重新下载 */
  'sftp.editResolve': (a: { editId: string; action: 'overwrite' | 'discard' }) => void;
  'sftp.editStop': (a: { editId: string }) => void;

  /** MCP Client：外部 MCP Server 的配置和连接状态 */
  'mcp.list': () => { servers: McpServerConfig[]; status: McpServerStatus[] };
  'mcp.save': (a: { id: string | null; input: McpServerInput }) => McpServerConfig;
  'mcp.delete': (a: { id: string }) => void;
  /** 连接并列出工具（测试连接、刷新工具列表） */
  'mcp.test': (a: { id: string }) => McpServerStatus;
  /** 本机的 MCP 服务（给外部 Agent 用） */
  'mcp.host.get': () => McpHostState;
  'mcp.host.set': (a: { enabled?: boolean; port?: number; tools?: string[]; allowWrite?: boolean; allowDanger?: boolean }) => McpHostState;
  'mcp.host.resetToken': () => McpHostState;

  /** 本地数据统计（7 类，和备份包 header 的 counts 同名） */
  'sync.localStats': () => LocalStats;
  /** 导出到本地文件（.itmbak），用导出密码加密；包含凭证时需要验证身份（主密码 / Touch ID） */
  'backup.export': (a: { groups: SyncGroup[]; filePath: string; password: string; masterPassword?: string }) => BackupFileInfo;
  /** 只读 header（分组、条数、来源），不需要密码 */
  'backup.inspect': (a: { filePath: string }) => BackupFileInfo;
  /** 导入本地文件：合并（6.10.7）或覆盖本地；dryRun 只计算不写库 */
  'backup.import': (a: { filePath: string; password: string; groups: SyncGroup[]; mode: 'merge' | 'replace'; dryRun?: boolean }) => SyncReport;
  /** 自动备份（合并 / 覆盖之前生成），可以撤回 */
  'backup.autoList': () => AutoBackupInfo[];
  'backup.autoRestore': (a: { name: string; dryRun?: boolean }) => SyncReport;

  /** 端口转发：hostId 为空时列出全部 */
  'portforward.list': (a: { hostId: string | null }) => { forwards: PortForward[]; status: PortForwardStatus[] };
  'portforward.save': (a: { id: string | null; hostId: string; input: PortForwardInput }) => PortForward;
  'portforward.delete': (a: { id: string }) => void;
  'portforward.start': (a: { id: string }) => PortForwardStatus;
  'portforward.stop': (a: { id: string }) => void;

  'prompt.answer': (a: { promptId: string; answer: PromptAnswer }) => void;

  /** protocol：实际使用的协议（服务器没有 SFTP 时自动改用 FTP，notice 说明原因） */
  'sftp.open': (a: { hostId: string }) => { sftpId: string; home: string; protocol: 'sftp' | 'shell' | 'ftp' | 'ftps'; notice?: string };
  'sftp.close': (a: { sftpId: string }) => void;
  'sftp.list': (a: { sftpId: string; path: string }) => FileEntry[];
  'sftp.mkdir': (a: { sftpId: string; path: string }) => void;
  'sftp.rename': (a: { sftpId: string; from: string; to: string }) => void;
  /** 目录递归删除 */
  'sftp.delete': (a: { sftpId: string; paths: string[] }) => void;
  /** 在服务器上把同一目录下的这些文件 / 目录打成 tar.gz（放在 /tmp 的临时目录里），返回压缩包路径；下载时带上 cleanupRemote 自动删除 */
  'sftp.compress': (a: { sftpId: string; paths: string[] }) => { path: string; name: string; size: number };
  /** 文件面板（第十六轮，参考 iShell）：新建文件、修改权限、服务器上复制 / 移动、压缩到当前目录、拖到本机 */
  'sftp.createFile': (a: { sftpId: string; path: string }) => void;
  'sftp.chmod': (a: { sftpId: string; paths: string[]; mode: number; recursive: boolean }) => void;
  'sftp.copy': (a: { sftpId: string; paths: string[]; destDir: string }) => { copied: string[] };
  'sftp.move': (a: { sftpId: string; paths: string[]; destDir: string }) => { moved: string[] };
  'sftp.archive': (a: { sftpId: string; paths: string[]; name: string; format: 'tar.gz' | 'zip' }) => { path: string };
  /** 拖到访达 / 资源管理器：先下载到临时目录再开始系统拖拽（太大时返回 tooLarge，由界面改为普通下载） */
  'sftp.dragOut': (a: { sftpId: string; paths: string[] }) => { started: boolean; tooLarge?: boolean; total?: number };

  'local.home': () => string;
  'local.list': (a: { path: string }) => FileEntry[];
  'local.mkdir': (a: { path: string }) => void;
  'local.rename': (a: { from: string; to: string }) => void;
  /** 移到废纸篓 / 回收站，可以恢复 */
  'local.trash': (a: { paths: string[] }) => void;
  'local.reveal': (a: { path: string }) => void;
  /** 系统「下载」目录 */
  'local.downloadsDir': () => string;
  /** 系统剪贴板里复制的本机文件（访达 / 资源管理器里复制的），第十六轮「从剪贴板上传」 */
  'local.clipboardFiles': () => string[];
  /** 系统文件选择框（多选文件），取消时返回空数组 */
  /** 存储位置（设置 → 存储位置） */
  'storage.info': () => StorageInfo;
  /** 笔记同时保存为 Markdown 文件的目录；空字符串表示关闭。开启时把现有笔记全部导出一次 */
  'storage.setNotesDir': (a: { dir: string }) => { exported: number };
  /** 录像目录；空字符串表示默认位置。move 时把已有录像移过去 */
  'storage.setRecordingsDir': (a: { dir: string; move: boolean }) => { moved: number; failed: number };
  /** 更换本地数据目录（null 表示回到默认目录）：应用会重启，重启时复制数据，原目录的数据保留作为备份 */
  'storage.setDataDir': (a: { dir: string | null }) => void;
  /** 在文件管理器里打开目录 */
  'storage.reveal': (a: { dir: string }) => void;
  'dialog.openFiles': () => string[];
  /** 选择一个文件 / 目录、保存文件；取消时返回 null */
  'dialog.openFile': (a: { title: string; filters?: FileFilter[] }) => string | null;
  'dialog.openDirectory': (a: { title: string }) => string | null;
  'dialog.saveFile': (a: { title: string; defaultName: string; filters?: FileFilter[] }) => string | null;
  /** 选择保存位置并写入文本（终端断开后按 S 保存终端输出，第二十一轮）；取消时返回 null */
  'dialog.saveText': (a: { title: string; defaultName: string; content: string; filters?: FileFilter[] }) => string | null;

  /** 订阅主机监控（同一窗口可以重复订阅，按次数计数） */
  'monitor.subscribe': (a: { hostId: string }) => void;
  /** 常驻主机正在发生的告警（第二十七轮） */
  'monitor.alerts': () => MonitorAlert[];

  /** 告警中心（第二十八轮）：告警日志 */
  'alert.list': (a: AlertFilter) => { items: AlertEvent[]; total: number; firing: number };
  'alert.delete': (a: { ids: string[] }) => void;
  /** 重新做一次 AI 排查 */
  'alert.diagnose': (a: { id: string }) => void;
  'monitor.unsubscribe': (a: { hostId: string }) => void;
  /** 历史采样（每小时一条）和磁盘写满预测 */
  'monitor.history': (a: { hostId: string; days: number }) => { samples: MetricSample[]; forecast: DiskForecast[] };
  /** 结束远端进程（以登录用户身份执行 kill） */
  'monitor.kill': (a: { hostId: string; pid: number; signal: 'TERM' | 'KILL' }) => void;
  /** 监控详情（只读命令，打开对应标签时才执行）：进程排行、主机信息、网络连接和监听端口、大文件扫描 */
  'monitor.procs': (a: { hostId: string; sort: 'cpu' | 'mem'; limit?: number }) => ProcDetail[];
  'monitor.static': (a: { hostId: string }) => MonitorStatic;
  'monitor.net': (a: { hostId: string }) => NetDetail;
  'monitor.bigfiles': (a: { hostId: string; paths: string[]; minMb: number; limit: number }) => { files: BigFile[]; elapsedMs: number };

  /** 目录会递归传输；返回每一项的传输 ID */
  'transfer.start': (a: { sftpId: string; direction: 'upload' | 'download'; items: TransferItem[] }) => { transferIds: string[] };
  'transfer.cancel': (a: { transferId: string }) => void;
  /** 暂停 / 继续（继续时从断点续传），第十六轮 */
  'transfer.pause': (a: { transferId: string }) => void;
  'transfer.resume': (a: { transferId: string }) => void;

  'ai.providers.list': () => AiProvider[];
  'ai.providers.save': (a: { id: string | null; input: AiProviderInput }) => AiProvider;
  'ai.providers.delete': (a: { id: string }) => void;
  /** 用表单配置发一条最短的请求，验证地址、Key 和模型 */
  'ai.providers.test': (a: { id: string | null; input: AiProviderInput; modelId: string }) => { latencyMs: number; reply: string };
  /** 获取模型列表（GET {baseUrl}/models），按表单内容，留空的 Key 沿用已保存的 */
  'ai.providers.fetchModels': (a: { id: string | null; input: AiProviderInput }) => { id: string; ownedBy?: string; contextWindow?: number }[];
  /**
   * 检测模型能力（第二十五轮）：连通、上下文窗口（模型列表接口给出时）、图片、工具调用、思考开关和档位。
   * 会发十次左右很短的请求，费用以厂商计费为准；按表单内容，留空的 Key 沿用已保存的
   */
  'ai.providers.probe': (a: { id: string | null; input: AiProviderInput; modelId: string }) => ModelProbeResult;

  /** 联网搜索（第二十五轮，独立的工具）：当前能不能用、用哪个服务 */
  'web.status': () => WebSearchStatus;
  /** 保存自己配置的搜索服务 Key（null / 空串 = 清除）；加密保存在本机 */
  'web.saveKey': (a: { apiKey: string | null }) => void;
  /** 用表单里的配置搜一次（不保存）；apiKey 留空时用已保存的 */
  'web.test': (a: { setting: WebSearchSetting; apiKey?: string | null; query?: string }) => { latencyMs: number; label: string; results: { title: string; url: string }[] };

  'agent.list': () => AgentConversationSummary[];
  'agent.create': (a: { model: ModelRef | null }) => AgentConversationView;
  'agent.get': (a: { id: string }) => AgentConversationView;
  'agent.delete': (a: { id: string }) => void;
  /** 发送一条消息并开始执行（结果通过 agent.update 事件推送） */
  /** web：这次发送打开了「联网」（文档一 6.38） */
  'agent.send': (a: { id: string; text: string; mode: AgentMode; model: ModelRef; refs: AgentRefs; thinking?: ThinkingChoice; policy?: ChatPolicy; web?: boolean }) => void;
  'agent.stop': (a: { id: string }) => void;
  /**
   * 回应等待中的步骤：批准 / 拒绝命令（可以修改命令）、批量执行时勾选的主机、ask_user 的回答、修改后的主机记忆
   */
  'agent.approve': (a: {
    id: string;
    approvalId: string;
    decision: 'approve' | 'reject';
    command?: string;
    confirmText?: string;
    hosts?: string[];
    answer?: string;
    memory?: string;
  }) => void;
  'agent.compress': (a: { id: string; model: ModelRef }) => void;
  /** 整个对话的 Markdown（存为笔记时不用 AI 汇总） */
  'agent.markdown': (a: { id: string }) => string;
  /**
   * 用 AI 给一条命令起标题、写说明（加到快捷指令时「AI 生成」）：快速模型，发出去前脱敏；
   * context 是命令前后的终端输出（可选，帮助理解）
   */
  'ai.describeCommand': (a: { command: string; context?: string; model?: ModelRef | null }) => { name: string; description: string };
  /** 用 AI 把对话汇总成笔记内容（快速模型，发出去前脱敏） */
  'agent.summarizeNote': (a: { id: string; model: ModelRef | null }) => string;
  /** 把对话导出为 Markdown 文件 */
  'agent.export': (a: { id: string; path: string }) => void;
  /** 按当前引用估算上下文占用（引用变化时刷新环形图） */
  'agent.usage': (a: { id: string; model: ModelRef | null; refs: AgentRefs }) => ContextUsage;

  /** 终端行内补全：本地历史命令优先，开启 AI 补全时再请求补全模型（文档一 6.1） */
  'completion.suggest': (a: { hostId: string | null; sessionId: string | null; prefix: string }) => { suggestion: string | null; source: 'history' | 'snippet' | 'ai' | null };
  /** 记录在终端里执行过的命令（补全的本地候选，只存本地加密库） */
  'completion.record': (a: { hostId: string | null; command: string; sessionId?: string | null }) => void;
  /** 命令提示的候选：历史命令（shell 自己的历史优先）和快捷命令（按前缀，不请求 AI） */
  'completion.matches': (a: { hostId: string | null; prefix: string; limit?: number }) => { history: string[]; snippets: string[] };
  /**
   * 某台主机的历史命令（标签栏的「历史命令」）：shell 自己的历史（~/.bash_history、~/.zsh_history 等）和 iTerminal 的记录合在一起，
   * 最近的在前，分页（offset / limit，默认 100 条）；refresh 时重新读远端的历史文件
   */
  'history.list': (a: { hostId: string | null; q?: string; offset?: number; limit?: number; refresh?: boolean }) => {
    items: { command: string; source: 'shell' | 'app'; count?: number; lastUsed?: number }[];
    total: number;
    shell: { files: string[]; error?: string } | null;
  };
  'history.delete': (a: { hostId: string | null; command: string }) => void;
  /** 执行脚本前检查（文件面板 / 终端右键「执行」）：是否存在、当前登录用户有没有执行权限；hostId 为 null 时是本机文件 */
  'file.execCheck': (a: { hostId: string | null; path: string }) => { exists: boolean; isFile: boolean; executable: boolean };
  'history.clear': (a: { hostId: string | null }) => void;

  'skill.list': () => SkillInfo[];
  'skill.openDir': () => void;
  /** 手动创建 / 修改 Skill（完整的 SKILL.md 内容；id 为空表示新建） */
  'skill.read': (a: { id: string }) => string;
  'skill.save': (a: { id: string | null; content: string }) => SkillInfo;
  'skill.delete': (a: { id: string }) => void;
  /** 运行 Skill（单主机 / 多主机并行，文档一 7.6）：新建一个对话显示进度，返回对话 ID */
  'skill.run': (a: { skillId: string; targets: SkillTargets; params: Record<string, string | number | boolean>; model: ModelRef }) => { conversationId: string };
  /** 预览目标解析出来的主机 */
  'skill.resolveTargets': (a: { targets: SkillTargets }) => { hosts: { id: string; name: string }[]; skipped: number };

  /** 快捷命令（文档一 6.14） */
  'snippet.list': () => SnippetLibrary;
  'snippet.save': (a: { id: string | null; input: SnippetInput }) => Snippet;
  'snippet.delete': (a: { ids: string[] }) => void;
  'snippet.move': (a: { ids: string[]; groupId: string | null }) => void;
  /** 新建 / 改名分组，返回分组 id */
  'snippet.group.save': (a: { id: string | null; name: string }) => string;
  /** 删除分组：组内命令移到「未分组」 */
  'snippet.group.delete': (a: { id: string }) => void;
  'snippet.group.reorder': (a: { ids: string[] }) => void;

  /** 笔记（文档一 6.14） */
  'note.list': () => NoteLibrary;
  'note.save': (a: { id: string | null; input: NoteInput }) => Note;
  /** 从 Markdown / 文本文件导入笔记（第二十二轮）：paths 为空时弹出选择文件（可以多选）；返回导入的笔记和跳过的文件 */
  /** kind：选择文件时的类型（markdown = .md / .txt，word = .docx / .doc，第二十六轮）；paths 给出时按扩展名处理 */
  'note.importFiles': (a: { paths: string[] | null; groupId: string | null; kind?: 'markdown' | 'word' }) => { notes: Note[]; skipped: { name: string; reason: string }[] };
  /** 撤回到上一个版本（只保留一个版本；再撤回一次回到撤回前） */
  'note.revert': (a: { id: string }) => Note;
  'note.delete': (a: { ids: string[] }) => void;
  'note.move': (a: { ids: string[]; groupId: string | null }) => void;
  'note.pin': (a: { id: string; pinned: boolean }) => void;
  'note.group.save': (a: { id: string | null; name: string }) => string;
  'note.group.delete': (a: { id: string }) => void;
  'note.group.reorder': (a: { ids: string[] }) => void;

  /** 账号：登录、退出登录、在本地模式和账号档案之间切换（文档一 2.3 / 6.10.8） */
  'account.state': () => AccountState;
  'account.login': (a: LoginInput) => AccountState;
  'account.logout': (a: { wipe?: boolean }) => void;
  'account.switch': (a: { profileId: string }) => void;
  /** 隐藏的服务端地址设置：先用管理员密码换一个 10 分钟有效的令牌 */
  'admin.unlock': (a: { password: string }) => { token: string; expiresAt: number };
  'admin.serverGet': (a: { token: string }) => AdminServerConfig;
  /** url 为 null 或空 = 恢复默认地址 */
  'admin.serverSet': (a: { token: string; url: string | null }) => AdminServerConfig;
  'admin.serverTest': (a: { token: string; url: string }) => AdminServerTest;
  /** 云备份、分享码（账号模式，文档一 6.10）：同步密码 / CDK、备份上传和恢复、我的分享码、从分享码拉取 */
  'cloud.status': () => CloudStatus;
  'cloud.setupPassword': (a: { password: string }) => { recoveryCode: string };
  'cloud.unlock': (a: { password: string }) => CloudStatus;
  'cloud.recover': (a: { recoveryCode: string; newPassword: string }) => { recoveryCode: string };
  'cloud.changePassword': (a: { newPassword: string }) => void;
  'cloud.backups': () => CloudBackupInfo[];
  'cloud.upload': (a: { groups: SyncGroup[]; remark?: string }) => CloudBackupInfo;
  'cloud.restore': (a: { id: string; groups: SyncGroup[]; mode: 'merge' | 'replace'; dryRun: boolean }) => SyncReport;
  'cloud.backupUpdate': (a: { id: string; remark?: string; pinned?: boolean }) => CloudBackupInfo;
  'cloud.backupDelete': (a: { id: string }) => void;
  'cloud.share': () => CloudShareInfo | null;
  'cloud.shareEnable': (a: { groups: SyncGroup[] }) => CloudShareInfo;
  'cloud.shareUpdate': (a: { groups?: SyncGroup[]; enabled?: boolean }) => CloudShareInfo;
  'cloud.shareReveal': () => string;
  'cloud.shareReset': () => CloudShareInfo;
  'cloud.shareClose': () => void;
  'cloud.shareRefresh': () => CloudShareInfo;
  'cloud.shareLookup': (a: { code: string }) => SharePreview;
  'cloud.sharePull': (a: { code: string; groups: SyncGroup[]; dryRun: boolean }) => SyncReport;
  /** 拉取分享码：下载并解密，列出全部条目（明文只在主进程内存里保留 10 分钟），第十三轮 */
  'cloud.shareOpen': (a: { code: string }) => ShareContent;
  /** 按勾选的条目合并（dryRun 时只预览） */
  'cloud.shareImport': (a: { code: string; pick: ShareImportPick; dryRun: boolean }) => SyncReport;
  /** 关闭拉取对话框：立即清除内存里的明文 */
  'cloud.shareForget': (a: { code: string }) => void;
  /** 单项分享（第十三轮，文档一 6.27.4）：分享前预览、创建、我的分享、撤销、再次查看分享码 */
  'share.preview': (a: { selection: ShareSelection }) => ShareSelectionPreview;
  'share.create': (a: { selection: ShareSelection; options: ShareLinkOptions }) => ShareLinkCreated;
  'share.links': () => ShareLinkInfo[];
  'share.revoke': (a: { id: string }) => void;
  'share.reveal': (a: { id: string }) => string;
  /** 问题反馈（第十三轮，文档一 6.27.1）：预览诊断信息、截取窗口、提交、我的反馈 */
  'feedback.preview': (a: { maskIps: boolean }) => FeedbackPreview;
  'feedback.capture': () => FeedbackImage;
  'feedback.submit': (a: FeedbackInput) => { id: number };
  'feedback.mine': () => FeedbackRecord[];
  /** 界面的操作轨迹批量交给主进程（锁定 / 未解锁时也允许，只写日志） */
  'diag.push': (a: { entries: DiagEntry[] }) => void;
  'diag.openDir': () => void;
  /** 立即同步团队主机（账号模式） */
  'team.sync': () => { added: number; updated: number; removed: number };
  /** 账号能检索的团队知识库（AI 引用知识库时选择；本地模式返回空列表） */
  'kb.collections': () => KbCollectionInfo[];

  /** 服务端连接、远程审批、定时任务执行记录（文档一 6.11） */
  'server.state': () => ServerState;
  'approval.pending': () => RemoteApproval[];
  'approval.decide': (a: { approvalId: string; decision: 'APPROVED' | 'REJECTED'; comment?: string }) => void;
  /** 执行记录（服务端派发的和本机定时任务）；taskId 只看某个任务 */
  'task.runs': (a: TaskRunFilter) => { items: TaskRunView[]; total: number };

  /** 本机定时任务（第四轮） */
  'schedule.list': () => LocalTask[];
  /** generatePlan：AI 任务没有执行方案时在后台生成，生成好后自动设置（第二十九轮） */
  'schedule.save': (a: { id: string | null; input: LocalTaskInput; generatePlan?: boolean }) => LocalTask;
  'schedule.delete': (a: { id: string }) => void;
  'schedule.enable': (a: { id: string; enabled: boolean }) => LocalTask;
  'schedule.runNow': (a: { id: string }) => { runId: string };
  'schedule.cancel': (a: { runId: string }) => void;
  /** 创建前检查命令在每台主机上的风险判定 */
  'schedule.check': (a: { command: string; hostIds: string[] }) => ScheduleCheck[];
  'schedule.approvals': () => ScheduleApproval[];
  'schedule.decide': (a: { id: string; approve: boolean }) => void;
  /** AI 任务试运行（第二十七轮）：AI 用只读命令在目标主机上执行一次，生成执行方案；token 用来取消和接收进度 */
  'schedule.trial': (a: { token: string; input: LocalTaskInput }) => TaskTrialResult;
  'schedule.trialCancel': (a: { token: string }) => void;
  /** 一次执行用 AI 整理成笔记的内容（第二十九轮；渲染进程保存为笔记） */
  'task.runNote': (a: { runId: string }) => { title: string; body: string };
  /** 后台生成执行方案（第二十九轮）：生成好后自动设置到任务上；进度跟着 schedule.changed 推送 */
  'schedule.generatePlan': (a: { id: string }) => LocalTask;
  'schedule.cancelPlan': (a: { id: string }) => LocalTask;
  /** 执行方案每条命令在每台主机上的判定（外层按命令，内层按主机） */
  'schedule.checkPlan': (a: { steps: TaskPlanStep[]; hostIds: string[] }) => ScheduleCheck[][];

  /** 自动更新（文档一 11.5） */
  'update.state': () => UpdateState;
  'update.check': () => UpdateState;
  'update.download': () => UpdateState;
  /** 退出并安装已下载的更新 */
  'update.install': () => void;
  /** 手动下载安装包到「下载」目录并打开（自动安装不了时的兜底） */
  'update.saveInstaller': () => UpdateState;
  'update.configure': (a: { channel?: UpdateChannel; autoCheck?: boolean }) => UpdateState;

  /** 本地审计与会话录像（文档一 6.12） */
  'audit.list': (a: AuditFilter) => { items: AuditEntry[]; total: number };
  /** 批量执行（第三十五轮）：执行前检查风险、执行命令 / 上传文件、执行记录 */
  'batch.check': (a: { hostIds: string[]; command: string }) => BatchCheck;
  'batch.exec': (a: BatchExecInput) => BatchJob;
  'batch.upload': (a: BatchUploadInput) => BatchJob;
  'batch.list': (a: BatchFilter) => { items: BatchJob[]; total: number };
  'batch.get': (a: { id: string }) => BatchJob;
  'batch.cancel': (a: { id: string }) => void;
  'batch.delete': (a: { ids: string[] }) => void;
  /** 选中的本机文件 / 文件夹的大小和文件个数 */
  'batch.inspectLocal': (a: { paths: string[] }) => BatchLocalItem[];
  'recording.list': (a: { q?: string; hostId?: string | null; username?: string; kind?: string | null; from?: number; to?: number; limit?: number; offset?: number }) => { items: RecordingInfo[]; total: number; diskBytes: number };
  'recording.read': (a: { id: string }) => RecordingData;
  /** 导出为明文 asciicast v2（.cast） */
  'recording.export': (a: { id: string; filePath: string }) => void;
  /** 录像里执行过的命令（按命令审计的时间对应到录像时间轴，手动输入和 Agent 执行的都有） */
  'recording.commands': (a: { id: string }) => RecordingCommand[];
  /**
   * 用 AI 把整段录像（执行的命令 + 终端输出节选）汇总成笔记正文（Markdown）；title / description 是用户填的标题和说明，
   * 作为提示交给模型。发出去之前脱敏
   */
  'recording.summarizeNote': (a: { id: string; title: string; description?: string; model?: ModelRef | null }) => string;
  'recording.delete': (a: { ids: string[] }) => void;

  /** 命令安全配置（文档一 6.15.7） */
  /** team：登录后服务端下发的团队规则（只读，最先匹配） */
  'cmdrule.list': () => { user: UserCommandRule[]; builtin: BuiltinRuleView[]; team: BuiltinRuleView[] };
  'cmdrule.save': (a: { id: string | null; input: UserCommandRuleInput }) => UserCommandRule;
  'cmdrule.delete': (a: { id: string }) => void;
  /** 替换一个快捷名单的全部条目（按前缀匹配） */
  'cmdrule.setList': (a: { list: CommandRuleList; patterns: string[] }) => UserCommandRule[];
  /** 按当前规则和策略判定一条命令（不执行） */
  'cmdrule.test': (a: { command: string }) => CommandTestResult;
  /** 导出 / 导入规则和策略（JSON 文件）；reset 恢复默认 */
  'cmdrule.export': (a: { filePath: string }) => { count: number };
  'cmdrule.import': (a: { filePath: string; mode: 'merge' | 'replace' }) => { added: number };
  'cmdrule.reset': () => void;

  /** 数据库资产（文档一 6.31.2） */
  'db.list': () => DbAsset[];
  'db.save': (a: { id: string | null; input: DbAssetInput }) => DbAsset;
  'db.duplicate': (a: { id: string }) => DbAsset;
  'db.delete': (a: { ids: string[] }) => void;
  /** 用表单里当前的值测试连接（id 用来取已保存的密码） */
  'db.test': (a: { id: string | null; input: DbAssetInput }) => DbTestOutcome;
  /** 把结果卡片里的表格导出为 CSV（UTF-8 带 BOM） */
  'db.exportCsv': (a: { path: string; columns: string[]; rows: (string | null)[][] }) => void;
  /** SQL 工作台（文档一 6.32）：库表树的一层（不带库 = 列出库；PostgreSQL 带库不带 schema = 列出 schema；否则列出表） */
  'db.objects': (a: { id: string; database?: string | null; schema?: string | null }) => DbObjectList;
  /** 表的列（库表树展开、编辑器补全、AI 挑表结构） */
  'db.columns': (a: { id: string; database?: string | null; schema?: string | null; tables: string[] }) => DbColumnInfo[];
  /** 表结构说明（列、索引、外键、建表语句） */
  'db.describe': (a: { id: string; database?: string | null; schema?: string | null; table: string }) => string;
  /** 执行前的分级：拆成语句，判断要不要确认 */
  'db.plan': (a: { id: string; sql: string }) => SqlPlan;
  /** 执行（按分号拆开依次执行，出错停下）；需要确认的批次要带 confirmed，高危 / 生产环境还要 confirmText = 数据库名称 */
  'db.exec': (a: { id: string; database?: string | null; schema?: string | null; sql: string; runId: string; confirmed?: boolean; confirmText?: string }) => SqlExecResult;
  'db.cancel': (a: { runId: string }) => void;
  /** 只读查询的全部结果写成 CSV（最多 10 万行） */
  'db.exportQuery': (a: { id: string; database?: string | null; schema?: string | null; sql: string; path: string }) => { rows: number; truncated: boolean };
  /** AI 写 / 解释 / 优化 / 诊断 SQL（单次请求，返回 Markdown） */
  'db.ai': (a: { id: string; database?: string | null; schema?: string | null; action: SqlAiAction; sql?: string; question?: string; error?: string; tables?: string[] }) => { text: string };
  /** 定时 SQL 报表：给机器人 / Webhook 发一条测试消息 */
  'schedule.testWebhook': (a: { webhook: ReportWebhook }) => void;

  'setting.getAll': () => Settings;
  'setting.set': <K extends keyof Settings>(a: { key: K; value: Settings[K] }) => void;

  /**
   * 终端背景（设置 → 外观，第十二轮）：选择图片 / 视频，复制到档案目录 appearance/ 并保存设置（删掉之前的背景文件）；
   * 渲染进程用 itm-media://bg/{文件名} 显示。取消选择时返回 null
   */
  'appearance.pickBackground': () => (TerminalBackground & { name: string; size: number }) | null;
  /** 去掉背景：删除文件，设置恢复为没有背景 */
  'appearance.clearBackground': () => TerminalBackground;
}

export type IpcChannel = keyof IpcApi;
export type IpcArg<C extends IpcChannel> = Parameters<IpcApi[C]> extends [infer A] ? A : void;
export type IpcResult<C extends IpcChannel> = ReturnType<IpcApi[C]>;

/** 每个通道一个键：漏写或多写都会在编译期报错 */
const CHANNELS: { [C in IpcChannel]: 1 } = {
  'app.info': 1,
  'window.minimize': 1, 'window.maximizeToggle': 1, 'window.close': 1, 'window.isMaximized': 1,
  'security.unlock': 1, 'security.unlockTouchId': 1, 'security.lock': 1, 'security.setup': 1,
  'security.setMasterPassword': 1, 'security.removeMasterPassword': 1,
  'folder.list': 1, 'folder.create': 1, 'folder.rename': 1, 'folder.move': 1, 'folder.delete': 1, 'folder.update': 1,
  'host.list': 1, 'host.create': 1, 'host.update': 1, 'host.duplicate': 1, 'host.delete': 1, 'host.move': 1, 'host.test': 1, 'host.ping': 1, 'host.agentMemory.list': 1, 'host.agentMemory.save': 1, 'host.agentMemory.delete': 1, 'host.memoryMarkdown': 1, 'host.summaryNote': 1,
  'host.effective': 1, 'host.favorite': 1, 'host.tag': 1,
  'tag.list': 1, 'tag.update': 1, 'tag.delete': 1,
  'import.preview': 1, 'import.commit': 1, 'export.hosts': 1,
  'credential.list': 1, 'credential.save': 1, 'credential.delete': 1, 'credential.reveal': 1, 'credential.totp': 1,
  'credential.deploy': 1, 'credential.rotate': 1,
  'session.openSsh': 1, 'session.openLocal': 1, 'session.write': 1, 'session.resize': 1, 'session.close': 1,
  'session.openTelnet': 1, 'session.openSerial': 1, 'session.serialSet': 1, 'session.serialSendHex': 1, 'session.serialSendFile': 1,
  'session.serialCancel': 1, 'session.log': 1, 'serial.list': 1,
  'sftp.readText': 1, 'sftp.writeText': 1, 'sftp.editExternal': 1, 'sftp.editList': 1, 'sftp.editResolve': 1, 'sftp.editStop': 1,
  'mcp.list': 1, 'mcp.save': 1, 'mcp.delete': 1, 'mcp.test': 1, 'mcp.host.get': 1, 'mcp.host.set': 1, 'mcp.host.resetToken': 1,
  'sync.localStats': 1, 'backup.export': 1, 'backup.inspect': 1, 'backup.import': 1, 'backup.autoList': 1, 'backup.autoRestore': 1,
  'portforward.list': 1, 'portforward.save': 1, 'portforward.delete': 1, 'portforward.start': 1, 'portforward.stop': 1,
  'prompt.answer': 1,
  'sftp.open': 1, 'sftp.close': 1, 'sftp.list': 1, 'sftp.mkdir': 1, 'sftp.rename': 1, 'sftp.delete': 1, 'sftp.compress': 1,
  'sftp.createFile': 1, 'sftp.chmod': 1, 'sftp.copy': 1, 'sftp.move': 1, 'sftp.archive': 1, 'sftp.dragOut': 1,
  'local.home': 1, 'local.list': 1, 'local.mkdir': 1, 'local.rename': 1, 'local.trash': 1, 'local.reveal': 1, 'local.downloadsDir': 1, 'local.clipboardFiles': 1,
  'storage.info': 1, 'storage.setNotesDir': 1, 'storage.setRecordingsDir': 1, 'storage.setDataDir': 1, 'storage.reveal': 1,
  'dialog.openFiles': 1, 'dialog.openFile': 1, 'dialog.openDirectory': 1, 'dialog.saveFile': 1, 'dialog.saveText': 1,
  'monitor.subscribe': 1, 'monitor.alerts': 1, 'monitor.unsubscribe': 1,
  'alert.list': 1, 'alert.delete': 1, 'alert.diagnose': 1, 'monitor.kill': 1, 'monitor.history': 1, 'monitor.procs': 1, 'monitor.static': 1, 'monitor.net': 1, 'monitor.bigfiles': 1,
  'transfer.start': 1, 'transfer.cancel': 1, 'transfer.pause': 1, 'transfer.resume': 1,
  'ai.providers.list': 1, 'ai.providers.save': 1, 'ai.providers.delete': 1, 'ai.providers.test': 1, 'ai.providers.fetchModels': 1, 'ai.providers.probe': 1,
  'web.status': 1, 'web.saveKey': 1, 'web.test': 1,
  'agent.list': 1, 'agent.create': 1, 'agent.get': 1, 'agent.delete': 1, 'agent.send': 1, 'agent.stop': 1, 'agent.approve': 1,
  'agent.compress': 1, 'agent.usage': 1, 'agent.markdown': 1, 'agent.summarizeNote': 1, 'agent.export': 1, 'ai.describeCommand': 1,
  'completion.suggest': 1, 'completion.record': 1, 'completion.matches': 1, 'history.list': 1, 'history.delete': 1, 'history.clear': 1, 'file.execCheck': 1,
  'skill.list': 1, 'skill.openDir': 1, 'skill.read': 1, 'skill.save': 1, 'skill.delete': 1, 'skill.run': 1, 'skill.resolveTargets': 1,
  'snippet.list': 1, 'snippet.save': 1, 'snippet.delete': 1, 'snippet.move': 1, 'snippet.group.save': 1, 'snippet.group.delete': 1, 'snippet.group.reorder': 1,
  'note.list': 1, 'note.save': 1, 'note.importFiles': 1, 'note.revert': 1, 'note.delete': 1, 'note.move': 1, 'note.pin': 1, 'note.group.save': 1, 'note.group.delete': 1, 'note.group.reorder': 1,
  'server.state': 1, 'approval.pending': 1, 'approval.decide': 1, 'task.runs': 1,
  'account.state': 1, 'account.login': 1, 'account.logout': 1, 'account.switch': 1, 'team.sync': 1, 'kb.collections': 1,
  'admin.unlock': 1, 'admin.serverGet': 1, 'admin.serverSet': 1, 'admin.serverTest': 1,
  'cloud.status': 1, 'cloud.setupPassword': 1, 'cloud.unlock': 1, 'cloud.recover': 1, 'cloud.changePassword': 1, 'cloud.backups': 1, 'cloud.upload': 1, 'cloud.restore': 1,
  'cloud.backupUpdate': 1, 'cloud.backupDelete': 1, 'cloud.share': 1, 'cloud.shareEnable': 1, 'cloud.shareUpdate': 1, 'cloud.shareReveal': 1, 'cloud.shareReset': 1,
  'cloud.shareClose': 1, 'cloud.shareRefresh': 1, 'cloud.shareLookup': 1, 'cloud.sharePull': 1, 'cloud.shareOpen': 1, 'cloud.shareImport': 1, 'cloud.shareForget': 1,
  'share.preview': 1, 'share.create': 1, 'share.links': 1, 'share.revoke': 1, 'share.reveal': 1,
  'feedback.preview': 1, 'feedback.capture': 1, 'feedback.submit': 1, 'feedback.mine': 1, 'diag.push': 1, 'diag.openDir': 1,
  'schedule.list': 1, 'schedule.save': 1, 'schedule.delete': 1, 'schedule.enable': 1, 'schedule.runNow': 1, 'schedule.cancel': 1, 'schedule.check': 1, 'schedule.approvals': 1, 'schedule.decide': 1, 'schedule.trial': 1, 'schedule.trialCancel': 1, 'schedule.generatePlan': 1, 'schedule.cancelPlan': 1, 'task.runNote': 1, 'schedule.checkPlan': 1,
  'update.state': 1, 'update.check': 1, 'update.download': 1, 'update.install': 1, 'update.saveInstaller': 1, 'update.configure': 1,
  'batch.check': 1, 'batch.exec': 1, 'batch.upload': 1, 'batch.list': 1, 'batch.get': 1, 'batch.cancel': 1, 'batch.delete': 1, 'batch.inspectLocal': 1,
  'audit.list': 1, 'recording.list': 1, 'recording.read': 1, 'recording.export': 1, 'recording.delete': 1, 'recording.commands': 1, 'recording.summarizeNote': 1,
  'cmdrule.list': 1, 'cmdrule.save': 1, 'cmdrule.delete': 1, 'cmdrule.setList': 1, 'cmdrule.test': 1, 'cmdrule.export': 1, 'cmdrule.import': 1, 'cmdrule.reset': 1,
  'db.list': 1, 'db.save': 1, 'db.duplicate': 1, 'db.delete': 1, 'db.test': 1, 'db.exportCsv': 1,
  'db.objects': 1, 'db.columns': 1, 'db.describe': 1, 'db.plan': 1, 'db.exec': 1, 'db.cancel': 1, 'db.exportQuery': 1, 'db.ai': 1, 'schedule.testWebhook': 1,
  'setting.getAll': 1, 'setting.set': 1, 'appearance.pickBackground': 1, 'appearance.clearBackground': 1,
};

export const IPC_CHANNELS = Object.keys(CHANNELS) as IpcChannel[];

/** 档案还没打开（冷启动等待主密码）时允许的通道 */
/** 自动更新不属于档案：输入主密码之前、锁定时、没有登录时都能检查和安装（第十五轮） */
const UPDATE_CHANNELS: IpcChannel[] = ['update.state', 'update.check', 'update.download', 'update.install', 'update.saveInstaller'];
const WINDOW_CHANNELS: IpcChannel[] = ['window.minimize', 'window.maximizeToggle', 'window.close', 'window.isMaximized'];
export const PRE_UNLOCK_CHANNELS: readonly IpcChannel[] = ['app.info', 'security.unlock', 'security.setup', 'diag.push', ...UPDATE_CHANNELS, ...WINDOW_CHANNELS];
/** 界面锁定时允许的通道 */
export const LOCKED_CHANNELS: readonly IpcChannel[] = ['app.info', 'security.unlock', 'security.unlockTouchId', 'diag.push', ...UPDATE_CHANNELS, ...WINDOW_CHANNELS];

// ------------------------------------------------------------------ 事件（主进程 → 渲染进程）

export interface IpcEvents {
  'session.data': { sessionId: string; data: string };
  'session.status': { sessionId: string; status: SessionStatus; message?: string };
  /** 连接进度（步骤 + 连接日志），文档一 6.15.3 */
  'session.progress': ConnProgress;
  /** 自动更新的状态变化（文档一 11.5） */
  'update.state': UpdateState;
  /** 服务端连接状态、待审批列表、本设备执行的任务（文档一 6.11） */
  'server.state': ServerState;
  /** 账号状态变化（令牌过期、设备被吊销） */
  'account.state': AccountState;
  /** 测试连接的实时日志（host.test 传了 testId 时推送） */
  'host.testLog': { testId: string; entry: ConnLogEntry };
  /** 主机列表在后台变了（团队主机同步），界面重新加载 */
  'hosts.changed': { reason: 'team' | 'connected' };
  /** 笔记 / Skill 在后台变了（Agent 新建或修改），界面重新加载 */
  'library.changed': { kind: 'note' | 'skill'; id: string };
  'approval.pending': RemoteApproval[];
  'task.run': TaskRunView;
  /** 本机定时任务列表变化（新建、执行、Agent 创建） */
  'schedule.changed': LocalTask[];
  /** 定时任务里等待批准的操作 */
  'schedule.approvals': ScheduleApproval[];
  /** AI 任务试运行的进度（第二十七轮） */
  'schedule.trialProgress': { token: string; text: string };
  /** 常驻监控的告警变化 */
  'monitor.alerts': MonitorAlert[];
  /** 告警日志有变化（新告警、排查进度、恢复），第二十八轮 */
  'alert.changed': { firing: number };
  /** 串口会话的显示 / 控制线 / 文件发送状态 */
  'session.serial': { sessionId: string; state: SerialSessionState };
  'portforward.status': PortForwardStatus;
  'sftp.edit': RemoteEditState;
  /** 需要用户注意的 AI 对话（外部 Agent 通过 MCP 请求执行命令、等待审批） */
  'agent.attention': { conversationId: string; title: string; text: string };
  'prompt.request': PromptRequest;
  'transfer.progress': TransferState;
  'monitor.update': MetricsSnapshot;
  /** 终端当前目录变化（由监控通道采集登录 shell 的 cwd） */
  'session.cwd': { sessionId: string; cwd: string };
  'agent.update': AgentConversationView;
  'security.state': SecurityState;
  'credential.rotateProgress': RotateProgress;
  /** 菜单栏的命令（帮助 → 问题反馈…），第十三轮 */
  'app.command': { command: 'feedback' | 'closeTab' };
  /** 批量执行的进度（第三十五轮）：带每台主机的结果 */
  'batch.progress': BatchJob;
  /** 窗口最大化状态变化（Windows / Linux 自定义标题栏按钮同步） */
  'window.maximized': { maximized: boolean };
}

export type IpcEventName = keyof IpcEvents;

const EVENTS: { [E in IpcEventName]: 1 } = {
  'session.data': 1, 'session.status': 1, 'session.progress': 1, 'update.state': 1, 'server.state': 1, 'approval.pending': 1, 'task.run': 1, 'session.serial': 1, 'portforward.status': 1, 'sftp.edit': 1, 'agent.attention': 1, 'prompt.request': 1, 'transfer.progress': 1, 'monitor.update': 1, 'session.cwd': 1,
  'agent.update': 1, 'security.state': 1, 'credential.rotateProgress': 1, 'schedule.changed': 1, 'schedule.approvals': 1, 'schedule.trialProgress': 1, 'monitor.alerts': 1, 'alert.changed': 1,
  'account.state': 1, 'hosts.changed': 1, 'library.changed': 1, 'host.testLog': 1, 'app.command': 1, 'window.maximized': 1, 'batch.progress': 1,
};

export const IPC_EVENTS = Object.keys(EVENTS) as IpcEventName[];

/** 业务错误以这个前缀开头的 message 传回渲染进程，渲染进程直接展示冒号后面的内容 */
export const USER_ERROR_PREFIX = 'ITM_USER_ERROR:';
