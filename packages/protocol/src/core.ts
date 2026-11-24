// ------------------------------------------------------------------ 主机分组、主机（文档一 6.5）

/**
 * Agent 权限（文档一 6.5 继承规则：主机 → 分组 → 全局默认，就近生效；团队主机取最严格）。界面上只有三档（AGENT_POLICY_CHOICES，第三十五轮改名）：
 * 只读 APPROVE（只读命令自动执行，写操作人工审批）/ 自动 AI_REVIEW（AI 审核，判断不能自动时转人工审批）/ 完全允许 AUTO
 * （AUTO_ALL = 完全允许并取消高危命令的二次确认）。内部取值不变，旧数据直接沿用。
 * DENY / READONLY 是旧版本的选项（READONLY = 严格只读，写操作直接拒绝）：旧数据、Skill 的权限上限、无人值守的上限仍然会用到。
 */
export type AgentPolicy = 'DENY' | 'READONLY' | 'APPROVE' | 'AI_REVIEW' | 'AUTO' | 'AUTO_ALL';

export const AGENT_POLICIES: readonly AgentPolicy[] = ['DENY', 'READONLY', 'APPROVE', 'AI_REVIEW', 'AUTO', 'AUTO_ALL'];

/** 越大越严格（AI 自动审批的写操作要 AI 判断，比完全允许严格） */
export const AGENT_POLICY_STRICTNESS: Record<AgentPolicy, number> = { AUTO_ALL: 0, AUTO: 1, AI_REVIEW: 2, APPROVE: 3, READONLY: 4, DENY: 5 };

/** 设置、分组、主机、数据库、对话里统一的三档 Agent 权限；选「完全允许」时另有「高危命令需要二次确认」（取消勾选 = AUTO_ALL） */
export const AGENT_POLICY_CHOICES: { value: 'APPROVE' | 'AI_REVIEW' | 'AUTO'; short: string; label: string; description: string }[] = [
  { value: 'APPROVE', short: '只读', label: '只读', description: '只允许只读命令自动执行；写操作等都需要你人工审批确认；高危命令需要输入主机名确认' },
  { value: 'AI_REVIEW', short: '自动', label: '自动', description: '只读命令直接执行；写操作由 AI 审核是否可以自动执行，AI 判断不能自动时转为人工审批（文件写入仍需批准）' },
  { value: 'AUTO', short: '全允许', label: '完全允许', description: '写操作自动执行；高危命令默认仍需要输入主机名二次确认（可以取消勾选）' },
];

const AGENT_POLICY_LABELS: Record<AgentPolicy, string> = {
  DENY: '禁止',
  READONLY: '严格只读',
  APPROVE: '只读',
  AI_REVIEW: '自动',
  AUTO: '完全允许',
  AUTO_ALL: '完全允许（高危命令不确认）',
};

export function agentPolicyLabel(p: AgentPolicy): string {
  return AGENT_POLICY_LABELS[p] ?? p;
}

/** 主机分组（多级文件夹） */
export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  /** 物化路径 /rootId/.../selfId/ */
  path: string;
  sort: number;
  /** 以下为文件夹设置，逐级继承（null = 继承上级） */
  defaultCredentialId: string | null;
  defaultJumpHostId: string | null;
  agentPolicy: AgentPolicy | null;
  /** 文件夹说明：逐级拼接后作为 Agent 上下文 */
  aiNote: string | null;
  /** 默认 Skill：逐级合并 */
  defaultSkills: string[];
  /** 生产环境：Agent 在其中的主机上执行命令最低按 L1 审批（向下继承） */
  production: boolean;
  updatedAt: number;
  /** 团队主机分组（服务端同步下来的，只读） */
  team?: boolean;
}

export interface FolderSettingsInput {
  defaultCredentialId: string | null;
  defaultJumpHostId: string | null;
  agentPolicy: AgentPolicy | null;
  aiNote: string | null;
  defaultSkills: string[];
  production: boolean;
}

export type FolderDeleteStrategy = 'MOVE_TO_PARENT' | 'CASCADE';

export type HostProtocol = 'SSH' | 'TELNET' | 'SERIAL';

/**
 * 认证方式：
 * - PASSWORD：主机自己保存的密码；
 * - KEY：主机自己保存的私钥（可带口令）；
 * - AGENT：本机 ssh-agent（SSH_AUTH_SOCK / Windows OpenSSH Agent）；
 * - INTERACTIVE：不保存任何秘密，每次连接时询问密码；
 * - CREDENTIAL：引用保险库里的凭证（credentialId 为空时继承分组的默认凭证）。
 */
export type AuthMethod = 'PASSWORD' | 'KEY' | 'AGENT' | 'INTERACTIVE' | 'CREDENTIAL';

export interface SerialOptions {
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  stopBits: 1 | 1.5 | 2;
  flowControl: 'none' | 'hardware' | 'software';
  /** 回车键发送的换行符 */
  eol: 'CR' | 'LF' | 'CRLF';
  /** 本地回显（设备不回显时打开） */
  localEcho: boolean;
}

/**
 * 端口转发（主机的附属数据，文档一 6.10.1）：
 * LOCAL = ssh -L（本机端口 → 经过主机 → 目标）；REMOTE = ssh -R（主机上的端口 → 经过本机 → 目标）；DYNAMIC = ssh -D（本机 SOCKS5 代理）
 */
export type PortForwardType = 'LOCAL' | 'REMOTE' | 'DYNAMIC';

export interface PortForwardInput {
  type: PortForwardType;
  /** LOCAL / DYNAMIC：本机监听地址；REMOTE：主机上的监听地址 */
  bindAddr: string;
  bindPort: number;
  /** LOCAL：从主机看到的目标；REMOTE：从本机看到的目标；DYNAMIC 不用 */
  targetAddr: string | null;
  targetPort: number | null;
  /** 打开这台主机的终端时自动启动 */
  autoStart: boolean;
}

export interface PortForward extends PortForwardInput {
  id: string;
  hostId: string;
}

export interface PortForwardStatus {
  id: string;
  hostId: string;
  state: 'stopped' | 'starting' | 'running' | 'error';
  message: string | null;
  /** 当前经过这条转发的连接数 */
  connections: number;
  /** 实际监听的端口（bindPort 填 0 时由系统分配） */
  boundPort: number | null;
}

/** 本机的串口（设置串口主机时选择） */
export interface SerialPortInfo {
  path: string;
  manufacturer: string | null;
  serialNumber: string | null;
  vendorId: string | null;
  productId: string | null;
}

/** 打开着的串口会话的显示和控制状态 */
export interface SerialSessionState {
  /** 接收按十六进制显示 */
  hex: boolean;
  /** 每行前加时间戳 */
  timestamp: boolean;
  dtr: boolean;
  rts: boolean;
  /** 正在用 XMODEM / YMODEM 发送的文件 */
  transferring: { name: string; protocol: 'xmodem' | 'ymodem'; sent: number; total: number } | null;
}

export const DEFAULT_SERIAL: SerialOptions = { baudRate: 115200, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', eol: 'CR', localEcho: false };

export interface ProxyConfig {
  type: 'SOCKS5' | 'HTTP';
  host: string;
  port: number;
  username: string | null;
  /** 是否保存了代理密码（不返回密码本身） */
  hasPassword: boolean;
}

export interface Host {
  id: string;
  folderId: string | null;
  name: string;
  protocol: HostProtocol;
  /** SSH / Telnet：主机名或 IP；串口：端口名（COM3、/dev/ttyUSB0） */
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** CREDENTIAL 时引用的凭证；为空表示继承分组默认凭证 */
  credentialId: string | null;
  /** 主机自己是否保存了密码（不返回密码本身） */
  hasPassword: boolean;
  /** 主机自己是否保存了私钥（不返回私钥本身） */
  hasPrivateKey: boolean;
  keepaliveSec: number;
  startupScript: string | null;
  note: string | null;
  /** 跳板机（按顺序依次跳转）：本机 → jumpHostIds[0] → … → 本主机 */
  jumpHostIds: string[];
  /** jumpHostIds 为空时，是否使用分组的默认跳板机 */
  jumpInherit: boolean;
  proxy: ProxyConfig | null;
  /** 终端字符编码，例如 UTF-8、GBK、GB18030、BIG5 */
  encoding: string;
  termType: string;
  env: Record<string, string>;
  serial: SerialOptions | null;
  /** null = 继承分组 */
  agentPolicy: AgentPolicy | null;
  /** 主机级命令黑名单（正则），命中时 Agent 直接拒绝执行 */
  cmdDenylist: string[];
  /** 主机记忆：Agent 引用这台主机时作为上下文 */
  aiMemory: string | null;
  /** 记录会话录像 */
  recordSession: boolean;
  /** 自定义监控采集脚本（非 Linux 设备）：输出 cpu=12.5、mem=63、load=0.1 0.2 0.3、disk./=71 这样的行 */
  monitorScript: string | null;
  /** 文件传输方式；null = 自动（先 SFTP，服务器没有 SFTP 时改用 FTP） */
  fileTransfer: FileTransfer | null;
  tags: string[];
  favorite: boolean;
  /** 最近一次探测到的系统信息（uname） */
  osInfo: string | null;
  lastConnectedAt: number | null;
  updatedAt: number;
  /** 团队主机（管理员在服务端维护，只读）；allowReveal：是否允许查看密码。个人主机为 null */
  team?: { allowReveal: boolean } | null;
}

/**
 * 新建 / 修改主机。秘密字段：undefined = 保持不变（修改时），null 或空串 = 清除，字符串 = 覆盖。
 * 可选的非秘密字段不传时使用默认值（新建）或保持不变（修改）。
 */
export interface HostInput {
  folderId: string | null;
  name: string;
  protocol?: HostProtocol;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  credentialId?: string | null;
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  keepaliveSec: number;
  startupScript: string | null;
  note: string | null;
  /** 跳板机，按顺序；为空表示直连（或继承分组默认跳板机） */
  jumpHostIds: string[];
  jumpInherit?: boolean;
  proxy?: Omit<ProxyConfig, 'hasPassword'> | null;
  proxyPassword?: string | null;
  encoding?: string;
  termType?: string;
  env?: Record<string, string>;
  serial?: SerialOptions | null;
  agentPolicy?: AgentPolicy | null;
  cmdDenylist?: string[];
  aiMemory?: string | null;
  recordSession?: boolean;
  monitorScript?: string | null;
  fileTransfer?: FileTransfer | null;
  tags?: string[];
  favorite?: boolean;
}

/**
 * 文件传输方式（文件面板、SFTP 标签、上传下载、在线编辑、Agent 的文件工具共用）：
 * AUTO 先用 SFTP；打不开（服务器没有 sftp-server）时用 SSH 命令通道（stat / cat）；还不行再用同样的用户名密码连 FTP。
 * SHELL 只用 SSH 命令通道；FTPS 是显式 TLS（AUTH TLS）。
 */
export type FileTransferMode = 'AUTO' | 'SFTP' | 'SHELL' | 'FTP' | 'FTPS';
export interface FileTransfer {
  mode: FileTransferMode;
  ftpPort: number;
}

/** 主机继承分组设置后的有效配置（文档一 6.5） */
export interface EffectiveHostPolicy {
  credentialId: string | null;
  /** 凭证来自哪里：主机自己 / 某个分组 */
  credentialFrom: { kind: 'host' } | { kind: 'folder'; folderId: string; folderName: string } | null;
  jumpHostIds: string[];
  jumpFrom: { kind: 'host' } | { kind: 'folder'; folderId: string; folderName: string } | null;
  agentPolicy: AgentPolicy;
  /** 决定有效 Agent 权限的来源 */
  agentPolicyFrom: { kind: 'host' } | { kind: 'folder'; folderId: string; folderName: string } | { kind: 'global' };
  /** 从顶层到所在分组的说明 */
  aiNotes: { folderName: string; note: string }[];
  defaultSkills: string[];
  production: boolean;
  /** 分组路径，例如「生产 / 订单」 */
  folderPath: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  /** 使用这个标签的主机数 */
  hostCount: number;
}

/** 测试连接的结果（失败时 invoke 直接抛出带原因的错误） */
export interface HostTestResult {
  /** 从发起到认证完成的耗时 */
  latencyMs: number;
  /** uname -srm 的结果；非 Linux / Unix 设备可能为空 */
  os: string | null;
  /** 经过的跳板机名称 */
  via: string[];
}

/**
 * 连接过程（文档一 6.15.2 / 6.15.3）：四个步骤和一条条连接日志。测试连接和打开终端共用。
 * - connect：TCP + SSH 握手 + 主机指纹（经过跳板机时每一跳的日志都在这一步里）
 * - auth：身份验证
 * - channel：打开终端通道
 * - ready：连接就绪
 */
export type ConnStep = 'connect' | 'auth' | 'channel' | 'ready';
export type ConnStepStatus = 'pending' | 'active' | 'done' | 'error';
export interface ConnLogEntry {
  t: number;
  step: ConnStep;
  level: 'info' | 'success' | 'warn' | 'error';
  /** 日志前缀，例如 TCP、重试、错误、跳板 1/2 jump-01 */
  tag: string;
  text: string;
}
export interface ConnProgress {
  sessionId: string;
  steps: Record<ConnStep, ConnStepStatus>;
  /** 新增的一条日志；第一次推送时带上之前的全部日志 */
  entries: ConnLogEntry[];
  state: 'connecting' | 'ready' | 'error' | 'cancelled';
  error?: string;
}

/** 主机列表的延迟（TCP 连接耗时）；经跳板机 / 代理、串口不直接测量 */
export interface HostPing {
  id: string;
  /** 毫秒；没测（跳板机、代理、串口）或失败时为 null */
  ms: number | null;
  /** 失败原因（超时、连接被拒…） */
  error: string | null;
  /** 没有直接测量的原因 */
  skipped: 'jump' | 'proxy' | 'serial' | null;
}

/** 测试连接的结果：成功或失败都带完整的连接日志 */
export type HostTestOutcome = ({ ok: true } & HostTestResult & { log: ConnLogEntry[] }) | { ok: false; error: string; log: ConnLogEntry[] };

// ------------------------------------------------------------------ 导入导出（文档一 6.5）

export type ImportSource = 'SSH_CONFIG' | 'XSHELL' | 'SECURECRT' | 'FINALSHELL' | 'MOBAXTERM' | 'ELECTERM' | 'CSV' | 'JSON';

export interface ImportItem {
  /** 预览内的临时 ID */
  key: string;
  /** 相对导入目标的分组路径，例如 ["生产", "订单"] */
  folderPath: string[];
  name: string;
  protocol: HostProtocol;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** 导入文件里带了密码 / 私钥（只在主进程里保存，预览只显示有没有） */
  hasPassword: boolean;
  hasPrivateKey: boolean;
  jumpKeys: string[];
  tags: string[];
  note: string | null;
  /** 和已有主机重复（协议 + 地址 + 端口 + 用户名相同） */
  duplicateOf: string | null;
}

export interface ImportPreview {
  token: string;
  source: ImportSource;
  items: ImportItem[];
  warnings: string[];
}

export interface ImportResult {
  createdHosts: number;
  createdFolders: number;
  skipped: number;
}

// ------------------------------------------------------------------ 文件

export type FileType = 'file' | 'dir' | 'link' | 'other';

export interface FileEntry {
  name: string;
  path: string;
  type: FileType;
  size: number;
  /** 毫秒时间戳 */
  mtime: number;
  /** 例如 drwxr-xr-x；本地文件在 Windows 上为空 */
  perms: string;
  /** 所有者、所属组（用户名 / 组名；服务器没有给出名字时是 uid / gid；第十六轮） */
  owner?: string;
  group?: string;
}

// ------------------------------------------------------------------ 交互式提示（主机指纹、密码）

export type PromptRequest =
  | {
      promptId: string;
      kind: 'hostKey';
      hostName: string;
      address: string;
      port: number;
      keyType: string;
      fingerprint: string;
      /** 已记录过该主机，但指纹变了：可能是重装系统，也可能是中间人攻击 */
      previousFingerprint: string | null;
    }
  | {
      promptId: string;
      kind: 'password';
      hostName: string;
      username: string;
      /** keyboard-interactive 时服务器给出的提示语 */
      message: string | null;
      /** 私钥口令 */
      forPassphrase: boolean;
      /** 输入的是一次性验证码（OTP），不提供「记住」 */
      otp?: boolean;
      /** 可以记住（使用共享凭证时不能把输入写回凭证） */
      rememberable?: boolean;
    };

export type PromptAnswer =
  | { kind: 'hostKey'; accept: boolean }
  | { kind: 'password'; value: string | null; remember: boolean };

// ------------------------------------------------------------------ 会话与传输

export type SessionStatus = 'connecting' | 'ready' | 'closed' | 'error';

/**
 * 目标已有同名文件时怎么办（文档一 6.3）：覆盖 / 跳过 / 改名为「名称 (1).扩展名」/ 断点续传（目标比源小时从目标的大小继续写）
 */
export type ConflictPolicy = 'overwrite' | 'skip' | 'rename' | 'resume';

export interface TransferItem {
  localPath: string;
  remotePath: string;
  /** 默认 overwrite（渲染进程在发起前已经让用户选择过） */
  conflict?: ConflictPolicy;
  /** 下载完成（或失败、取消）后删除服务器上的这个文件：sftp.compress 打的临时压缩包 */
  cleanupRemote?: boolean;
}

/** paused：暂停（保留已经传了的部分，继续时从断点续传，第十六轮） */
export type TransferStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled';

export interface TransferState {
  transferId: string;
  sftpId: string;
  direction: 'upload' | 'download';
  /** 展示用的名称（文件或目录名） */
  name: string;
  transferred: number;
  total: number;
  status: TransferStatus;
  message?: string;
  /** 当前速度（字节 / 秒） */
  speed?: number;
  /** 因为已存在而跳过的文件数 */
  skipped?: number;
  /** 出错后自动重试的次数 */
  retries?: number;
  /** 本机路径 / 远端路径（传输列表里显示、打开所在文件夹，第十六轮） */
  localPath?: string;
  remotePath?: string;
  /** 开始 / 结束时间（毫秒） */
  createdAt?: number;
  finishedAt?: number | null;
}

/** 在线编辑远端文件（文档一 6.3）：用系统默认程序打开，保存时自动回传 */
export interface RemoteEditState {
  editId: string;
  sftpId: string;
  path: string;
  /** 本机临时文件 */
  localPath: string;
  state: 'watching' | 'uploading' | 'uploaded' | 'conflict' | 'error' | 'stopped';
  message: string | null;
  /** 最近一次回传的时间 */
  savedAt: number | null;
}

/** Agent 记下的一条主机记忆（第二十六轮）：按条目保存，可以在主机编辑框里查看、修改、删除 */
export interface HostAgentMemory {
  id: string;
  hostId: string;
  content: string;
  /** 记下这条记忆的对话（可能已删除） */
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
}
