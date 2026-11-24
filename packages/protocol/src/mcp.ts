/**
 * MCP（文档一 6.8）：
 * - Client：Agent 通过 mcp_call 调用外部 MCP Server 的工具（stdio / SSE / Streamable HTTP），每个工具单独设置权限；
 * - Server：iTerminal 在 127.0.0.1 上提供 MCP 服务，外部 Agent（Claude Code、Cursor 等）的调用同样经过审批引擎。
 */
export type McpTransport = 'STDIO' | 'SSE' | 'HTTP';
/** AUTO = 直接调用；APPROVE = 每次调用前请用户批准；DISABLED = 不允许 */
export type McpPermission = 'AUTO' | 'APPROVE' | 'DISABLED';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  /** STDIO：命令和参数 */
  command: string | null;
  args: string[];
  /** SSE / HTTP：地址 */
  url: string | null;
  /** 环境变量 / 请求头只返回键名（值加密保存，可能是令牌） */
  envKeys: string[];
  headerKeys: string[];
  defaultPermission: McpPermission;
  /** 单个工具的权限，没有设置的用 defaultPermission */
  toolPolicies: Record<string, McpPermission>;
  enabled: boolean;
  updatedAt: number;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  url?: string | null;
  /** undefined = 保持不变；对象 = 整体替换 */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  defaultPermission: McpPermission;
  toolPolicies?: Record<string, McpPermission>;
  enabled: boolean;
}

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerStatus {
  id: string;
  state: 'idle' | 'connecting' | 'connected' | 'error';
  message: string | null;
  tools: McpToolInfo[];
}

/** 本机提供的 MCP 服务 */
export interface McpHostState {
  enabled: boolean;
  port: number;
  url: string;
  /** Bearer 令牌（外部 Agent 配置时填写） */
  token: string;
  running: boolean;
  error: string | null;
  /** 开放给外部 Agent 的工具（没有勾选的工具外部 Agent 看不到，也不能调用） */
  tools: string[];
  /**
   * 权限（第十三轮，文档一 6.27.5）：外部 Agent 的调用不弹审批。只读和安全命令始终允许；
   * 写操作（L1 命令、写文件、改笔记 / Skill）要勾选 allowWrite，高危指令（L2）还要勾选 allowDanger，没勾选时直接拒绝
   */
  allowWrite: boolean;
  allowDanger: boolean;
}

/**
 * 本机 MCP 服务提供的工具（设置里可以逐个开关）。kind = write 的工具（或命令）还受「允许写操作」约束；
 * account = 只有登录后才能用（团队知识库）
 */
export const MCP_SERVER_TOOLS: { name: string; title: string; description: string; kind: 'read' | 'write' | 'mixed'; account?: boolean }[] = [
  { name: 'list_hosts', title: '列出主机', description: '列出 iTerminal 里的主机（名称、地址、系统、分组、标签），不含任何密码和密钥', kind: 'read' },
  { name: 'get_metrics', title: '读取监控', description: '读取主机的监控快照：CPU、内存、磁盘、网络、负载、Top 进程', kind: 'read' },
  { name: 'sftp_read', title: '读取文件', description: '读取主机上的文本文件（可以只读尾部 N 行）', kind: 'read' },
  { name: 'ssh_exec', title: '执行命令', description: '在主机上执行命令并返回输出：只读和安全命令直接执行；写操作、高危指令按下面勾选的权限直接执行或拒绝', kind: 'mixed' },
  { name: 'sftp_write', title: '写入文件', description: '写入主机上的文件（先备份原文件）；需要勾选「允许写操作」', kind: 'write' },
  { name: 'run_skill', title: '运行 Skill', description: '在 iTerminal 里运行 Skill（可以对多台主机并行）；Skill 里的写操作按勾选的权限执行', kind: 'mixed' },
  { name: 'note_list', title: '列出笔记', description: '列出 / 搜索笔记（标题、分组、更新时间、开头）', kind: 'read' },
  { name: 'note_read', title: '引用笔记', description: '读取一篇笔记的全文（排障记录、操作手册）', kind: 'read' },
  { name: 'note_save', title: '创建 / 修改笔记', description: '新建笔记或修改已有笔记（修改时保留上一个版本，可以在笔记页撤回）；需要勾选「允许写操作」', kind: 'write' },
  { name: 'skill_list', title: '列出 Skill', description: '列出 iTerminal 里的 Skill（名称、说明、风险等级、参数）', kind: 'read' },
  { name: 'skill_read', title: '读取 Skill', description: '读取一个 Skill 的完整 SKILL.md（修改前先读）', kind: 'read' },
  { name: 'skill_save', title: '创建 / 修改 Skill', description: '新建或修改 Skill（内容是完整的 SKILL.md，保存前校验 front matter）；需要勾选「允许写操作」', kind: 'write' },
  { name: 'kb_search', title: '引用知识库', description: '检索团队知识库（运维手册、故障复盘），返回片段和出处；登录后可用', kind: 'read', account: true },
];

/** 第十三轮新增的工具：以前保存过开放工具列表的，升级后自动加进去（只加一次） */
export const MCP_SERVER_TOOLS_V2 = ['note_list', 'note_read', 'note_save', 'skill_list', 'skill_read', 'skill_save', 'kb_search'];
