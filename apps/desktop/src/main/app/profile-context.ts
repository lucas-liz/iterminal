import { join } from 'node:path';
import { UserError } from '../util/errors';
import * as pty from 'node-pty';
import { openDatabase, type Db } from '../services/db/database';
import type { Emit } from '../services/connection/emitter';
import { FolderRepo } from '../services/hosts/folder-repo';
import { HostRepo } from '../services/hosts/host-repo';
import { TagRepo } from '../services/hosts/tag-repo';
import { ImportService } from '../services/hosts/import-service';
import { SettingsRepo } from '../services/settings/settings-repo';
import { CredentialRepo } from '../services/vault/credential-repo';
import { KeyDeployService } from '../services/vault/key-deploy';
import type { KeyStore } from '../services/vault/keystore';
import { AuditRepo } from '../services/audit/audit-repo';
import { PromptBroker } from '../services/connection/prompt-broker';
import { SshPool } from '../services/connection/ssh-pool';
import { SessionManager } from '../services/connection/session-manager';
import { SftpService } from '../services/sftp/sftp-service';
import { LocalFs } from '../services/sftp/local-fs';
import { TransferService } from '../services/sftp/transfer-service';
import { RemoteEditService } from '../services/sftp/edit-service';
import { MonitorService } from '../services/monitor/monitor-service';
import { ResidentMonitor } from '../services/monitor/resident';
import { AlertCenter } from '../services/alert/alert-center';
import { redactServers } from '../util/redact-server';
import type { AlertMailStatus } from '@itm/protocol';
import { MetricStore } from '../services/monitor/metric-store';
import { AiProviderRepo } from '../services/ai/provider-repo';
import { SkillStore } from '../services/ai/skills';
import { AgentService } from '../services/ai/agent-service';
import { WebSearchService } from '../services/ai/web-search';
import type { ProfileEntry } from '../services/profile/profile-store';
import { DEFAULT_POLICY, type ApprovalEngine, type PolicyConfig } from '@itm/approval';
import type { AgentRuntime } from '../services/ai/runtime';
import type { KbSearch } from '../services/ai/tool-gateway';
import { CompletionService } from '../services/ai/completion-service';
import { ShellHistoryService } from '../services/ai/shell-history';
import { SnippetRepo } from '../services/library/snippet-repo';
import { NoteRepo } from '../services/library/note-repo';
import type { SerialProvider } from '../services/connection/serial';
import { PortForwardRepo } from '../services/hosts/port-forward-repo';
import { PortForwardService } from '../services/connection/port-forward';
import { DbAssetRepo } from '../services/database/db-asset-repo';
import { DbService } from '../services/database/db-service';
import { SqlWorkbench } from '../services/database/workbench';
import { Masker } from '@itm/masking';
import { McpRepo } from '../services/mcp/mcp-repo';
import { McpClientManager } from '../services/mcp/mcp-client';
import { McpHostService } from '../services/mcp/mcp-host';
import type { McpPermission, McpToolInfo } from '@itm/protocol';
import { DatasetStore } from '../services/sync/dataset-store';
import { CommandRuleRepo } from '../services/ai/command-rule-repo';
import { RecordingStore } from '../services/audit/recording-store';
import { AuditUploader } from '../services/audit/audit-uploader';
import { ServerLink } from '../services/server/server-link';
import { RemoteApprovals } from '../services/server/remote-approvals';
import { TaskExecutor } from '../services/server/task-executor';
import { AccountSession } from '../services/server/account-session';
import { TeamAssetSync, type TeamAssets } from '../services/server/team-assets';
import { CloudService } from '../services/sync/cloud-service';
import { readTeamPolicy, sanitizeTeamPolicy, teamMaskRulesOf, teamRulesOf, writeTeamPolicy, type TeamPolicy } from '../services/server/team-policy';
import { LocalScheduler } from '../services/schedule/scheduler';
import { BatchService } from '../services/batch/batch-service';
import type { IpcEventName, IpcEvents, KbCollectionInfo, RemoteApproval, ServerState } from '@itm/protocol';
import { SyncService } from '../services/sync/sync-service';
import { NoteFileMirror } from '../services/library/note-files';

type KbHit = Awaited<ReturnType<KbSearch>>[number];

/** 本地模式调用 AI 时的提示 */
export const AI_LOGIN_REQUIRED = '登录后才能使用 AI 功能：请在左下角登录 iTerminal 账号';

export interface ProfileContextOptions {
  profile: ProfileEntry;
  dir: string;
  keystore: KeyStore;
  emit: Emit;
  trashItem: (path: string) => Promise<void>;
  revealItem: (path: string) => void;
  /** 用系统默认程序打开文件（在线编辑远端文件） */
  openPath?: (path: string) => Promise<unknown> | void;
  approval: ApprovalEngine;
  runtime: AgentRuntime;
  serialProvider?: SerialProvider | null;
  /** 显示审批的窗口（MCP 服务收到外部 Agent 的调用时） */
  owner?: () => number | null;
  /** 应用是否锁定（锁定时拒绝外部 Agent 的调用） */
  locked?: () => boolean;
  appVersion?: string;
  /** 服务端（只给自动化测试用：本地档案也连接模拟服务端）；账号档案由档案自己的登录会话连接 */
  server?: { url: string; token(): Promise<string | null>; deviceId: string } | null;
  /** 本机设备 ID（账号档案连接服务端用） */
  deviceId?: string;
  /** 本地模式（没有登录）不能使用 AI（第十二轮）；单元测试默认不限制 */
  requireLoginForAi?: boolean;
  /** 账号状态变化：令牌过期、设备被吊销 */
  onAccount?: () => void;
  /** 推送给所有窗口的事件（服务端状态、远程审批） */
  broadcast?: <E extends IpcEventName>(event: E, payload: IpcEvents[E]) => void;
  /** 新的远程审批：系统通知 */
  notifyApproval?: (a: RemoteApproval) => void;
  /** 本机的「下载」目录（Agent 的 file_download 保存到这里） */
  downloadsDir?: () => string;
  /** 系统通知（定时任务失败、等待批准；应用在前台时不发） */
  notify?: (title: string, body: string) => void;
}

/**
 * 一个已打开档案的全部服务。切换档案（登录 / 退出登录）时整体关闭再重新创建，数据互不可见。
 */
export class ProfileContext {
  readonly profile: ProfileEntry;
  readonly dir: string;
  readonly db: Db;
  readonly settings: SettingsRepo;
  readonly audit: AuditRepo;
  readonly credentials: CredentialRepo;
  readonly tags: TagRepo;
  readonly hosts: HostRepo;
  readonly folders: FolderRepo;
  readonly imports: ImportService;
  readonly prompts: PromptBroker;
  readonly pool: SshPool;
  readonly sessions: SessionManager;
  readonly sftp: SftpService;
  readonly localFs: LocalFs;
  readonly transfers: TransferService;
  readonly edits: RemoteEditService;
  readonly monitor: MonitorService;
  /** 常驻监控：后台采集 + 告警（第二十七轮） */
  readonly resident: ResidentMonitor;
  /** 告警中心（第二十八轮） */
  readonly alerts: AlertCenter;
  readonly metrics: MetricStore;
  readonly providers: AiProviderRepo;
  readonly skills: SkillStore;
  readonly agent: AgentService;
  /** 联网搜索（第二十五轮） */
  readonly webSearch: WebSearchService;
  readonly keyDeploy: KeyDeployService;
  readonly runtime: AgentRuntime;
  readonly approval: ApprovalEngine;
  readonly completion: CompletionService;
  readonly snippets: SnippetRepo;
  readonly notes: NoteRepo;
  readonly noteFiles: NoteFileMirror;
  readonly portForwards: PortForwardRepo;
  readonly mcpRepo: McpRepo;
  readonly mcpClient: McpClientManager;
  readonly mcpHost: McpHostService;
  readonly forwarding: PortForwardService;
  /** 数据库资产和连接（第十七轮，文档一 6.31） */
  readonly dbAssets: DbAssetRepo;
  readonly databases: DbService;
  /** SQL 工作台（第十八轮，文档一 6.32） */
  readonly workbench: SqlWorkbench;
  readonly sync: SyncService;
  readonly commandRules: CommandRuleRepo;
  readonly recordings: RecordingStore;
  /** 本机定时任务（第四轮） */
  readonly scheduler: LocalScheduler;
  /** 批量执行（第三十五轮） */
  readonly batch: BatchService;
  /** 服务端连接、远程审批、定时任务执行器、审计上报（文档一 6.11 / 6.12），只在配置了服务端时存在 */
  readonly server: { link: ServerLink; approvals: RemoteApprovals; executor: TaskExecutor; uploader: AuditUploader } | null = null;
  /** 账号档案的登录会话（令牌、刷新、退出登录） */
  readonly account: AccountSession | null = null;
  /** 团队主机同步和只读检查 */
  readonly teamAssets: TeamAssetSync;
  /** 云备份、分享码（账号档案） */
  private cloudService: CloudService | null = null;
  /** 服务端下发的 AI 策略（账号档案；本地模式为空） */
  private teamPolicy: TeamPolicy | null = null;
  private policyTimer: NodeJS.Timeout | null = null;
  private readonly vaultKey: Buffer;
  private readonly appVersion: string;
  /** 推送事件给某个窗口（测试连接的实时日志等） */
  readonly emit: Emit;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(o: ProfileContextOptions) {
    this.profile = o.profile;
    this.dir = o.dir;
    this.emit = o.emit;
    const keys = o.keystore.profileKeys(o.dir, o.profile.id);
    this.vaultKey = keys.vaultKey;
    this.appVersion = o.appVersion ?? '0.0.0';
    this.db = openDatabase(join(o.dir, 'iterminal.db'), keys.dbKey);
    o.keystore.confirmMigration(o.dir);
    // 团队规则（账号档案先用本机缓存，连上服务端后更新）；审批引擎全局一个，本地模式清空
    this.teamPolicy = o.profile.kind === 'account' ? readTeamPolicy(o.dir, keys.vaultKey) : null;
    o.approval.setTeamRules(teamRulesOf(this.teamPolicy));

    this.settings = new SettingsRepo(this.db);
    this.commandRules = new CommandRuleRepo(this.db);
    // 用户命令规则交给审批引擎（每个档案一套，文档一 6.15.7）
    o.approval.setUserRules(this.commandRules.toEngineRules());
    this.snippets = new SnippetRepo(this.db);
    this.mcpRepo = new McpRepo(this.db, keys.vaultKey);
    this.mcpClient = new McpClientManager(this.mcpRepo, o.appVersion);
    this.notes = new NoteRepo(this.db);
    // 笔记同时保存为 Markdown 文件（设置 → 存储位置）
    this.noteFiles = new NoteFileMirror(this.notes, () => this.settings.get('storage.notesDir'), (m) => console.warn(m));
    this.notes.onChange = (ids) => this.noteFiles.sync(ids);
    this.audit = new AuditRepo(this.db);
    this.credentials = new CredentialRepo(this.db, keys.vaultKey);
    this.tags = new TagRepo(this.db);
    this.hosts = new HostRepo(this.db, keys.vaultKey, {
      credentials: this.credentials,
      tags: this.tags,
      globalAgentPolicy: () => this.settings.get('ai.defaultAgentPolicy'),
    });
    this.folders = new FolderRepo(this.db, Date.now, {
      beforeDeleteHosts: (ids, path) => this.hosts.ensureNotUsedAsJump(ids, path),
      deleteHostCredentials: (ids) => this.credentials.deleteDedicatedOf(ids),
      requireSharedCredential: (id) => void this.credentials.requireShared(id),
      requireHost: (id) => void this.hosts.require(id),
    });
    this.teamAssets = new TeamAssetSync({ db: this.db, hosts: this.hosts, folders: this.folders });
    this.broadcastAll = o.broadcast ?? null;
    this.hosts.attachFolders(this.folders);
    this.imports = new ImportService(this.db, this.hosts, this.folders);
    this.prompts = new PromptBroker(o.emit);
    this.pool = new SshPool(this.hosts, this.prompts, 20_000, (id) => this.credentials.markUsed(id), () => ({
      timeoutMs: this.settings.get('terminal.connectTimeoutSec') * 1000,
      retries: this.settings.get('terminal.connectRetries'),
    }));
    this.sessions = new SessionManager(
      this.pool,
      this.hosts,
      o.emit,
      (file, args, opts) => pty.spawn(file, args, { name: 'xterm-256color', ...opts }),
      o.serialProvider ?? null,
    );
    this.sessions.localEnv = () => this.settings.get('terminal.localEnv');
    // 会话录像（文档一 6.12）：全局开关 + 主机的「会话录制」设置；本机 Shell 单独开关
    this.recordings = new RecordingStore(this.db, o.dir, keys.vaultKey);
    this.recordings.setRoot(() => this.settings.get('storage.recordingsDir'));
    this.sessions.recorderFactory = (meta) => {
      if (!this.settings.get('audit.recordSessions')) return null;
      if (meta.kind === 'local') return this.settings.get('audit.recordLocal') ? this.recordings.start(meta) : null;
      const host = meta.hostId ? this.hosts.get(meta.hostId) : null;
      return host && host.recordSession ? this.recordings.start(meta) : null;
    };
    this.cleanupAudit();
    this.cleanupTimer = setInterval(() => this.cleanupAudit(), 6 * 3600_000);
    this.cleanupTimer.unref?.();
    this.portForwards = new PortForwardRepo(this.db);
    this.forwarding = new PortForwardService(this.portForwards, this.pool, o.emit);
    this.sessions.onSshReady = (owner, hostId) => this.forwarding.autoStart(owner, hostId);
    this.dbAssets = new DbAssetRepo(this.db, keys.vaultKey);
    this.databases = new DbService({ repo: this.dbAssets, credentials: this.credentials, hosts: this.hosts, pool: this.pool });
    this.sftp = new SftpService(this.pool, { hosts: this.hosts, prompts: this.prompts });
    this.localFs = new LocalFs(o.trashItem, o.revealItem);
    this.transfers = new TransferService(this.sftp, o.emit, {
      rateLimit: () => this.settings.get('sftp.rateLimitKBps') * 1024,
      concurrency: () => this.settings.get('sftp.concurrency'),
    });
    this.edits = new RemoteEditService(this.sftp, o.emit, o.openPath ?? (() => undefined));
    this.monitor = new MonitorService(this.pool, o.emit, this.sessions);
    this.metrics = new MetricStore(this.db);
    this.monitor.attach({ store: this.metrics, customScript: (hostId) => this.hosts.get(hostId)?.monitorScript ?? null, config: () => this.settings.get('monitor.config') });
    this.resident = new ResidentMonitor({
      monitor: this.monitor,
      hostIds: () => this.settings.get('monitor.dashboardHosts').filter((id) => this.hosts.get(id)?.protocol === 'SSH'),
      config: () => this.settings.get('monitor.alert'),
      disabled: () => this.settings.get('monitor.config').enabled === false,
      hostName: (id) => this.hosts.get(id)?.name ?? id,
      // 第三十五轮去掉了监控告警：只采集和查看，不发系统通知、不记告警日志、不做 AI 排查、不发邮件
      notify: () => undefined,
      emit: (list) => (o.broadcast ?? (() => undefined))('monitor.alerts', list),
    });
    this.resident.start();
    this.providers = new AiProviderRepo(this.db, keys.vaultKey);
    if (o.requireLoginForAi && o.profile.kind === 'local') this.providers.setGate(() => AI_LOGIN_REQUIRED);
    this.skills = new SkillStore(join(o.dir, 'skills'));
    this.runtime = o.runtime;
    this.approval = o.approval;
    // 联网搜索（第二十五轮）：服务端默认配置（登录后）或自己配置的 Key，和模型提供商无关
    this.webSearch = new WebSearchService({
      db: this.db,
      vaultKey: keys.vaultKey,
      setting: () => this.settings.get('ai.webSearch'),
      server: () => (this.server ? { info: this.teamPolicy?.webSearch ?? null, request: (m, path, body, opts) => this.server!.link.request(m, path, body, opts) } : null),
    });
    this.agent = new AgentService({
      db: this.db,
      sqlContext: (owner, c, question) => this.workbench.chatContext(owner, c, question),
      providers: this.providers,
      webSearch: this.webSearch,
      sessions: this.sessions,
      pool: this.pool,
      hosts: this.hosts,
      folders: this.folders,
      credentials: this.credentials,
      monitor: this.monitor,
      skills: this.skills,
      settings: this.settings,
      audit: this.audit,
      approval: o.approval,
      runtime: o.runtime,
      emit: o.emit,
      policy: () => this.policy(),
      maskRules: () => teamMaskRulesOf(this.teamPolicy),
      notes: this.notes,
      mcp: this.mcpBridge(),
      // 团队知识库（服务端）：账号档案才有，本地档案不给模型提供这个工具
      kbSearch: o.profile.kind === 'account' || o.server ? (query, topK, signal, collectionIds) => this.searchKb(query, topK, signal, collectionIds) : undefined,
      // 串口 / Telnet 会话：发送一行命令并等待提示符（Agent 的 serial_send）
      serialSend: (sessionId, data, waitFor, timeoutMs, signal) => this.sessions.sendAndWait(sessionId, data, waitFor, timeoutMs, signal),
      // Agent 的文件工具和文件面板一样：SFTP → SSH 命令通道 → FTP
      files: (owner, hostId) => this.sftp.openTemp(owner, hostId),
      downloadsDir: o.downloadsDir,
      databases: this.databases,
      // 没有打开终端时 Agent 后台执行的命令也录像（第二十六轮）：和终端录像一样受「会话录像」和主机的录像开关控制
      recordings: {
        start: (meta) => {
          if (!this.settings.get('audit.recordSessions')) return null;
          const host = meta.hostId ? this.hosts.get(meta.hostId) : null;
          return host && host.recordSession ? this.recordings.start(meta) : null;
        },
      },
      // 第三十五轮去掉了定时任务：不给 Agent schedule 依赖，schedule_task / schedule_list 不会发给模型
    });
    this.scheduler = new LocalScheduler({
      db: this.db,
      hosts: this.hosts,
      pool: this.pool,
      approval: o.approval,
      policy: () => this.policy(),
      audit: this.audit,
      agent: this.agent,
      owner: () => o.owner?.() ?? 0,
      emitRun: (run) => (o.broadcast ?? (() => undefined))('task.run', run),
      emitTasks: (list) => (o.broadcast ?? (() => undefined))('schedule.changed', list),
      emitApprovals: (list) => (o.broadcast ?? (() => undefined))('schedule.approvals', list),
      notify: (title, body) => o.notify?.(title, body),
      // SQL 报表（第十八轮）：数据库、AI 总结、发给模型前脱敏
      databases: this.databases,
      ask: (system, text, timeoutMs) => this.agent.ask(system, text, timeoutMs),
      masker: () => this.aiMasker(),
      // AI 任务按执行方案执行时的终端录像（第二十七轮）：和终端录像一样受「会话录像」和主机的录像开关控制
      recordings: {
        start: (meta) => {
          if (!this.settings.get('audit.recordSessions')) return null;
          return this.hosts.get(meta.hostId)?.recordSession ? this.recordings.start(meta) : null;
        },
      },
      emitTrial: (token, text) => (o.broadcast ?? (() => undefined))('schedule.trialProgress', { token, text }),
      alerts: { raise: (input) => this.alerts.raise(input), resolvePrefix: (p) => this.alerts.resolvePrefix(p) },
    });
    this.alerts = new AlertCenter({
      db: this.db,
      hosts: this.hosts,
      agent: this.agent,
      owner: () => o.owner?.() ?? 0,
      review: (command, host, level, reasons) => this.scheduler.aiReview(command, host, level, reasons),
      mail: (subject, text) => this.mailMe(subject, text),
      notify: (title, body) => o.notify?.(title, body),
      emit: (firing) => (o.broadcast ?? (() => undefined))('alert.changed', { firing }),
      snapshot: (hostId) => this.monitor.latest(hostId),
    });
    // 第三十五轮去掉了定时任务：不再启动本机调度（旧任务留在数据库里，不会在后台执行）
    this.batch = new BatchService({
      db: this.db,
      hosts: this.hosts,
      pool: this.pool,
      sftp: this.sftp,
      approval: o.approval,
      policy: () => this.policy(),
      audit: this.audit,
      emit: (job) => (o.broadcast ?? (() => undefined))('batch.progress', job),
      owner: () => o.owner?.() ?? 0,
    });
    this.workbench = new SqlWorkbench({
      databases: this.databases,
      repo: this.dbAssets,
      audit: this.audit,
      settings: this.settings,
      ask: (system, text, timeoutMs) => this.agent.ask(system, text, timeoutMs),
      masker: () => this.aiMasker(),
    });
    const shellHistory = new ShellHistoryService(this.pool, (id) => this.hosts.get(id)?.protocol === 'SSH');
    this.completion = new CompletionService(this.db, this.hosts, this.sessions, this.settings, this.providers, o.runtime, Date.now, this.snippets, shellHistory);
    this.keyDeploy = new KeyDeployService(this.pool, this.hosts, this.credentials, o.emit);
    this.mcpHost = new McpHostService({
      hosts: this.hosts,
      folders: this.folders,
      skills: this.skills,
      agent: this.agent,
      settings: this.settings,
      repo: this.mcpRepo,
      owner: o.owner ?? (() => null),
      locked: o.locked ?? (() => false),
      attention: (owner, e) => o.emit(owner, 'agent.attention', e),
      version: o.appVersion ?? '0.0.0',
    });
    void this.mcpHost.apply();
    // 账号档案：用档案自己的登录会话连接服务端（令牌失效时刷新；过期 / 被吊销后停止连接，等用户重新登录）
    let server: { url: string; token(): Promise<string | null>; deviceId: string; onUnauthorized?(): Promise<boolean> } | null = o.server ?? null;
    if (!server && o.profile.kind === 'account' && o.profile.serverUrl && o.deviceId) {
      const account = new AccountSession({
        dir: o.dir,
        vaultKey: keys.vaultKey,
        baseUrl: o.profile.serverUrl,
        deviceId: o.deviceId,
        onDead: () => {
          this.server?.link.stop();
          o.onAccount?.();
        },
      });
      this.account = account;
      server = { url: o.profile.serverUrl, deviceId: o.deviceId, token: () => account.token(), onUnauthorized: () => account.refresh() };
      const serverUrl = o.profile.serverUrl;
      this.providers.setTeam({
        providers: () => this.teamPolicy?.providers ?? [],
        endpoint: () => ({ serverUrl, token: account.currentToken() }),
        allowPersonal: () => this.teamPolicy?.allowPersonalProvider !== false,
      });
      this.onTeamChange = () => o.onAccount?.();
    }
    if (server) {
      const broadcast = o.broadcast ?? (() => undefined);
      const link = new ServerLink({
        baseUrl: server.url,
        token: server.token,
        onUnauthorized: server.onUnauthorized,
        deviceId: server.deviceId,
        clientVersion: o.appVersion ?? '0.0.0',
        onState: (st) => {
          // 界面上不显示服务端地址
          broadcast('server.state', { ...st, url: null });
          // 每次连上服务端时更新团队策略
          if (st.status === 'online') void this.fetchTeamPolicy();
        },
      });
      // 管理员在后台吊销了这台设备：令牌立即失效，需要重新登录
      link.on('device.revoked', (p) => this.account?.revoked(typeof (p as { message?: unknown })?.message === 'string' ? (p as { message: string }).message : undefined));
      const approvals = new RemoteApprovals(link, { emit: (list) => broadcast('approval.pending', list), notify: (a) => o.notifyApproval?.(a) });
      const executor = new TaskExecutor({
        db: this.db,
        link,
        approvals,
        hosts: this.hosts,
        pool: this.pool,
        approval: o.approval,
        policy: () => this.policy(),
        settings: this.settings,
        audit: this.audit,
        agent: this.agent,
        owner: () => o.owner?.() ?? 0,
        emit: (run) => broadcast('task.run', run),
      });
      const uploader = new AuditUploader({ db: this.db, request: (m, path, body) => link.request(m, path, body), recordings: this.recordings, uploadRecordings: () => true });
      this.server = { link, approvals, executor, uploader };
      if (!this.account || this.account.state().status === 'valid') link.start();
      uploader.start();
      if (this.account) {
        this.policyTimer = setInterval(() => void this.fetchTeamPolicy(), 10 * 60_000);
        this.policyTimer.unref?.();
      }
    }
    this.sync = new SyncService({
      db: this.db,
      store: new DatasetStore(this.db, keys.vaultKey, { credentials: this.credentials, tags: this.tags, skills: this.skills }),
      settings: this.settings,
      vaultKey: keys.vaultKey,
      dir: o.dir,
      clientVersion: o.appVersion ?? '0.0.0',
    });
  }

  /** 发给模型前的脱敏（SQL 工作台、SQL 报表）：和对话一样带上服务端下发的脱敏规则 */
  private aiMasker(): Masker {
    return new Masker({ maskIps: this.settings.get('ai.maskIps'), maskPii: true, rules: teamMaskRulesOf(this.teamPolicy) });
  }

  /** Agent 用的 MCP 桥：按 Server 名称查权限、调用工具、列出工具 */
  private mcpBridge(): NonNullable<ConstructorParameters<typeof AgentService>[0]['mcp']> {
    const find = (name: string) => this.mcpRepo.byName(name);
    return {
      permission: async (server, tool) => {
        const cfg = find(server);
        if (!cfg) return `没有名为「${server}」的 MCP Server`;
        if (!cfg.enabled) return `MCP Server「${server}」已停用`;
        const tools = await this.mcpClient.tools(cfg.id).catch((e: Error) => e);
        if (tools instanceof Error) return tools.message;
        if (!tools.some((t) => t.name === tool)) return `MCP Server「${server}」没有工具 ${tool}，可用的：${tools.map((t) => t.name).join('、')}`;
        return this.mcpRepo.permission(cfg, tool);
      },
      call: (server, tool, args, signal) => this.mcpClient.call(find(server)!.id, tool, args, signal),
      catalog: async (ids) => {
        const out: { server: string; tools: (McpToolInfo & { permission: McpPermission })[]; error?: string }[] = [];
        for (const id of ids) {
          const cfg = this.mcpRepo.get(id);
          if (!cfg || !cfg.enabled) continue;
          try {
            out.push({ server: cfg.name, tools: (await this.mcpClient.tools(cfg.id)).map((t) => ({ ...t, permission: this.mcpRepo.permission(cfg, t.name) })) });
          } catch (e) {
            out.push({ server: cfg.name, tools: [], error: (e as Error).message });
          }
        }
        return out;
      },
    };
  }

  /** 拉取服务端下发的 AI 策略（账号档案）；失败时继续用缓存的 */
  async fetchTeamPolicy(): Promise<void> {
    if (!this.server || !this.account) return;
    try {
      const raw = await this.server.link.request<unknown>('GET', '/api/v1/ai/policy');
      // 团队模型：老版本的服务端没有这个接口时当作没有团队模型
      const providers = await this.server.link.request<unknown>('GET', '/api/v1/ai/models').catch(() => []);
      // 服务端的默认联网搜索（第二十五轮）：老版本服务端没有这个接口时当作没有配置
      const web = await this.server.link.request<unknown>('GET', '/api/v1/ai/web').catch(() => null);
      await this.syncTeamAssets().catch(() => undefined);
      const p = sanitizeTeamPolicy(raw, Date.now(), providers, web);
      if (!p) return;
      this.teamPolicy = p;
      writeTeamPolicy(this.dir, this.vaultKey, p);
      this.approval.setTeamRules(teamRulesOf(p));
      this.onTeamChange?.();
    } catch {
      // 离线或者服务端出错：继续用缓存的策略
    }
  }

  /** 账号能检索的团队知识库（AI 引用知识库时选择）；本地模式没有知识库 */
  async kbCollections(): Promise<KbCollectionInfo[]> {
    if (!this.server) return [];
    const raw = await this.server.link.request<unknown>('GET', '/api/v1/kb/collections');
    return (Array.isArray(raw) ? raw : []).flatMap((c): KbCollectionInfo[] => {
      if (!c || typeof c !== 'object') return [];
      const o = c as Record<string, unknown>;
      if (o.id == null || typeof o.name !== 'string') return [];
      return [{ id: String(o.id), name: o.name, description: typeof o.description === 'string' && o.description ? o.description : null }];
    });
  }

  /** 检索团队知识库（Agent 的 kb_search、引用知识库）：服务端按账号角色过滤可见的知识库；collectionIds 为空时检索全部可见的 */
  private async searchKb(query: string, topK: number, signal: AbortSignal, collectionIds?: string[]): Promise<KbHit[]> {
    if (!this.server) throw new UserError('知识库在服务端，登录后才能使用');
    const ids = (collectionIds ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    const raw = await this.server.link.request<unknown>('POST', '/api/v1/kb/search', { query, topK, ...(ids.length ? { collectionIds: ids } : {}) }, { signal });
    return (Array.isArray(raw) ? raw : []).flatMap((h): KbHit[] => {
      if (!h || typeof h !== 'object') return [];
      const o = h as Record<string, unknown>;
      if (typeof o.content !== 'string') return [];
      return [
        {
          title: typeof o.title === 'string' ? o.title : '未命名',
          section: typeof o.section === 'string' && o.section ? o.section : null,
          content: o.content,
          score: typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : 0,
          source: typeof o.source === 'string' ? o.source : '知识库',
        },
      ];
    });
  }

  /** 云备份和分享码（只在账号档案里可用） */
  cloud(): CloudService {
    if (!this.server || !this.account) throw new UserError('云备份和分享码需要登录 iTerminal 服务端');
    this.cloudService ??= new CloudService({ link: this.server.link, sync: this.sync, dir: this.dir, vaultKey: this.vaultKey, clientVersion: this.appVersion });
    return this.cloudService;
  }

  /** 同步团队主机（连上服务端时、每 10 分钟、用户点「立即同步」）；有变化时通知界面重新加载主机 */
  async syncTeamAssets(): Promise<{ added: number; updated: number; removed: number }> {
    if (!this.server || !this.account) return { added: 0, updated: 0, removed: 0 };
    const data = await this.server.link.request<TeamAssets>('GET', '/api/v1/team/assets');
    const r = this.teamAssets.apply(data);
    if (r.added || r.updated || r.removed) this.broadcastAll?.('hosts.changed', { reason: 'team' });
    return r;
  }

  private broadcastAll: ProfileContextOptions['broadcast'] | null = null;

  /** 团队策略更新后通知界面（账号状态里带团队模型数量、是否允许个人模型） */
  private onTeamChange: (() => void) | null = null;

  /** 当前生效的团队策略（界面展示用） */
  team(): TeamPolicy | null {
    return this.teamPolicy;
  }

  /** 重新输入密码登录后：换上新令牌、重新连接服务端（不用重新打开档案） */
  resumeAccount(t: { accessToken: string; refreshToken: string }): void {
    if (!this.account) return;
    this.account.resume(t);
    this.server?.link.start();
  }

  /** 全局 AI 策略：本地模式来自设置；账号档案的无人值守上限和 LLM 复核开关由服务端下发的策略决定 */
  policy(): PolicyConfig {
    const s = this.settings.getAll();
    return {
      ...DEFAULT_POLICY,
      maxToolRounds: s['ai.maxRounds'],
      // 本地模式：无人值守的权限由每个定时任务自己的「Agent 权限」决定
      unattendedCap: this.teamPolicy?.unattendedCap ?? 'AUTO',
      nightWindow: { ...s['ai.nightWindow'] },
      allowLlmReview: s['ai.llmReview'] && (this.teamPolicy?.allowLlmReview ?? true),
      autoReadonlyDefault: s['ai.autoApproveReadonly'],
      security: {
        l2Decision: s['security.l2Decision'],
        blacklistDecision: s['security.blacklistDecision'],
        strict: s['security.strict'],
        maxLength: s['security.maxLength'],
      },
    };
  }

  /** 清理超过保留天数的审计记录（默认 180 天）和录像（默认 30 天）；账号模式下还没上报的先保留 */
  cleanupAudit(): void {
    try {
      const account = this.profile.kind === 'account';
      this.audit.cleanup(this.settings.get('audit.retentionDays'), account);
      this.recordings.cleanup(this.settings.get('audit.recordingRetentionDays'), account);
    } catch {
      // 清理失败不影响使用，下次再试
    }
  }

  /** 用户命令规则变化后重新交给审批引擎 */
  applyCommandRules(): void {
    this.approval.setUserRules(this.commandRules.toEngineRules());
  }

  /** 窗口关闭：结束它名下的会话、提示和任务 */
  windowClosed(owner: number): void {
    this.prompts.cancelAll(owner);
    this.agent.stopAllOf(owner);
    this.monitor.closeAllOf(owner);
    this.forwarding.stopAllOf(owner);
    this.edits.stopAllOf(owner);
    this.sessions.closeAllOf(owner);
    this.sftp.closeAllOf(owner);
  }

  /**
   * 发邮件到当前登录账号的邮箱（第二十八轮，后端 /api/v1/notify/mail-me）：本地模式、登录过期时不发。
   */
  async mailMe(subject: string, text: string): Promise<{ status: AlertMailStatus; message?: string | null }> {
    if (!this.server || !this.account || this.account.state().status !== 'valid') return { status: 'NOT_LOGGED_IN' };
    try {
      const r = await this.server.link.request<{ status?: string }>('POST', '/api/v1/notify/mail-me', { subject, text }, { timeoutMs: 30_000 });
      const st = r?.status;
      return st === 'SENT' || st === 'NO_EMAIL' || st === 'NO_SMTP' || st === 'RATE_LIMITED' ? { status: st } : { status: 'FAILED', message: '服务端返回的结果不认识' };
    } catch (e) {
      const msg = redactServers((e as Error).message);
      return { status: 'FAILED', message: /404|不存在|not found/i.test(msg) ? '服务端版本较旧，还不支持发邮件（需要更新服务端）' : msg.slice(0, 300) };
    }
  }

  /** 服务端连接状态（给界面：不含服务端地址） */
  serverState(): ServerState {
    const st = this.server?.link.get();
    return st ? { ...st, url: null } : { enabled: false, status: 'off', url: null, lastError: null, connectedAt: null };
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    if (this.policyTimer) clearInterval(this.policyTimer);
    this.scheduler.stop();
    this.batch.stopAll();
    this.resident.stop();
    this.alerts.stop();
    if (this.server) {
      this.server.executor.stopAll();
      this.server.uploader.stop();
      this.server.approvals.stop();
      this.server.link.stop();
    }
    this.monitor.stopAll();
    this.metrics.flushAll();
    this.forwarding.stopAll();
    this.edits.stopAll();
    this.mcpClient.closeAll();
    void this.mcpHost.stop();
    // 会话在连接关闭后才异步结束：录像要在关闭数据库之前先收尾
    this.recordings.endAll();
    this.pool.closeAll();
    this.db.close();
  }
}
