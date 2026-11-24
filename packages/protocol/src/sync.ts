/**
 * 云同步、备份与分享码（文档一 6.10）。本期在本地模式下提供：本地数据统计、本地文件导出 / 导入（合并或覆盖）、
 * 写入前的自动备份和撤回；云端备份、分享码、增量同步需要登录后才能使用。
 */
export type SyncGroup = 'HOSTS' | 'SNIPPETS' | 'NOTES' | 'SKILLS' | 'CREDENTIALS';
/** 与备份包 header 的 counts 同一组键名 */
export type SyncItemType = 'hosts' | 'hostGroups' | 'snippets' | 'snippetGroups' | 'notes' | 'noteGroups' | 'skills' | 'credentials';
export type ItemCounts = Record<SyncItemType, number>;

/** Skill（第二十二轮）：Skill 目录里的 SKILL.md */
export const SYNC_GROUPS: readonly SyncGroup[] = ['HOSTS', 'SNIPPETS', 'NOTES', 'SKILLS', 'CREDENTIALS'];
export const SYNC_GROUP_LABEL: Record<SyncGroup, string> = { HOSTS: '主机', SNIPPETS: '快捷命令', NOTES: '笔记', SKILLS: 'Skill', CREDENTIALS: '凭证' };
export const SYNC_ITEM_LABEL: Record<SyncItemType, string> = {
  hosts: '主机',
  hostGroups: '主机分组',
  snippets: '命令',
  snippetGroups: '命令分组',
  notes: '笔记',
  noteGroups: '笔记分组',
  skills: 'Skill',
  credentials: '凭证',
};
export const SYNC_ITEM_TYPES: readonly SyncItemType[] = ['hosts', 'hostGroups', 'snippets', 'snippetGroups', 'notes', 'noteGroups', 'skills', 'credentials'];

export interface LocalStats {
  counts: ItemCounts;
  /** 最近一次导出 / 上传备份的时间 */
  lastBackupAt: number | null;
}

/** 备份文件的明文 header（不需要密码就能看到） */
export interface BackupFileInfo {
  kind: 'backup' | 'share' | 'export' | 'auto';
  formatVersion: number;
  createdAt: number;
  deviceName: string;
  platform: string;
  clientVersion: string;
  groups: SyncGroup[];
  counts: ItemCounts;
  /** 文件大小（字节） */
  size: number;
}

export interface UnresolvedRef {
  type: SyncItemType;
  id: string;
  name: string;
  field: string;
}

/** 合并（6.10.7）：每类新增 / 已存在保留本地 / 补充字段 */
export interface MergeReportView {
  mode: 'merge';
  perType: Record<SyncItemType, { added: number; kept: number; filled: number }>;
  unresolvedRefs: UnresolvedRef[];
}

/** 覆盖本地：每类新增 / 修改 / 删除 */
export interface ReplaceReportView {
  mode: 'replace';
  perType: Record<SyncItemType, { added: number; updated: number; removed: number; unchanged: number }>;
  unresolvedRefs: UnresolvedRef[];
}

export type SyncReport = (MergeReportView | ReplaceReportView) & {
  /** dryRun 时为 false */
  applied: boolean;
  /** 写入前自动生成的本地备份文件名 */
  autoBackup: string | null;
  groups: SyncGroup[];
};

/** {档案目录}/backups/auto-*.itmbak：合并 / 覆盖之前自动生成，保留最近 5 份 */
export interface AutoBackupInfo {
  name: string;
  createdAt: number;
  groups: SyncGroup[];
  counts: ItemCounts;
  size: number;
  /** 生成原因，例如「导入 xxx.itmbak 之前」 */
  reason: string;
}

/** 每个分组包含的数据（第一个是主数据，第二个是它的分组） */
export const GROUP_ITEM_TYPES: Record<SyncGroup, SyncItemType[]> = {
  HOSTS: ['hosts', 'hostGroups'],
  SNIPPETS: ['snippets', 'snippetGroups'],
  NOTES: ['notes', 'noteGroups'],
  SKILLS: ['skills'],
  CREDENTIALS: ['credentials'],
};

// ------------------------------------------------------------------ 云备份、分享码（文档一 6.10.2 / 6.10.4 / 6.10.6）

export interface CloudStatus {
  /** 服务端是否设置了同步密码（托管了 CDK） */
  configured: boolean;
  /** 本机是否有当前版本的 CDK（这台设备输入过同步密码） */
  unlocked: boolean;
  keyVersion: number | null;
}

export interface CloudBackupInfo {
  id: string;
  createdAt: number;
  formatVersion: number;
  deviceName: string;
  platform: string;
  clientVersion: string;
  groups: SyncGroup[];
  counts: ItemCounts;
  size: number;
  remark: string;
  pinned: boolean;
  keyVersion: number;
  /** 这台设备上没有这份备份用的密钥（CDK 轮换过） */
  keyMissing: boolean;
}

export interface CloudShareInfo {
  enabled: boolean;
  dataGroups: SyncGroup[];
  /** 打码的分享码（本机解锁了同步密码时才有），例如 ITM-7K2QD-•••••-•••••-•••••-J6B2E */
  maskedCode: string | null;
  content: { groups: SyncGroup[]; counts: ItemCounts; size: number; updatedAt: number | null } | null;
  pullCount: number;
  lastPulledAt: number | null;
  createdAt: number | null;
}

export interface SharePreview {
  /** PERSONAL = 个人分享码；LINK = 单项分享（第十三轮），带标题、有效期和拉取次数 */
  kind?: 'PERSONAL' | 'LINK';
  title?: string;
  expiresAt?: number | null;
  maxPulls?: number;
  pullCount?: number;
  ownerUsername: string;
  ownerDisplayName: string;
  groups: SyncGroup[];
  counts: ItemCounts;
  size: number;
  updatedAt: number | null;
  deviceName: string;
  platform: string;
  clientVersion: string;
}

// ------------------------------------------------------------------ 单项分享、拉取时勾选内容（第十三轮，文档一 6.27.3 / 6.27.4）

/** 要分享的条目：主机、整个分组（含子分组）、快捷命令、命令分组、笔记、笔记分组 */
export interface ShareSelection {
  hostIds?: string[];
  folderIds?: string[];
  snippetIds?: string[];
  snippetGroupIds?: string[];
  noteIds?: string[];
  noteGroupIds?: string[];
  /** Skill 的 ID（目录名，第二十二轮） */
  skillIds?: string[];
}

/** 分享前列出的内容（含自动带上的跳板机、分组路径、凭证） */
export interface ShareSelectionPreview {
  /** 默认标题，例如「web-01 等 3 台主机」 */
  title: string;
  hosts: { id: string; name: string; address: string; folderPath: string; jump: boolean; hasSecret: boolean; credentialName: string | null }[];
  folders: string[];
  credentials: { id: string; name: string; type: string }[];
  snippets: { id: string; name: string; group: string | null }[];
  notes: { id: string; title: string; group: string | null }[];
  skills: { id: string; title: string }[];
  /** 团队主机不能分享，跳过的台数 */
  skippedTeam: number;
  /** 包含密码 / 私钥（主机自己保存的或引用的凭证） */
  hasSecrets: boolean;
}

export interface ShareLinkOptions {
  title: string;
  /** 连同凭证（主机的密码 / 私钥、引用的凭证）一起分享 */
  includeCredentials: boolean;
  /** 有效天数，null = 永久 */
  expiresDays: number | null;
  /** 可拉取次数，0 = 不限 */
  maxPulls: number;
}

export interface ShareLinkInfo {
  id: string;
  title: string;
  groups: SyncGroup[];
  counts: Partial<ItemCounts>;
  expiresAt: number | null;
  maxPulls: number;
  pullCount: number;
  lastPulledAt: number | null;
  expired: boolean;
  /** 拉取次数用完了 */
  exhausted: boolean;
  size: number;
  createdAt: number;
  /** 这台设备能复制分享码（本机保存过，或者用同步密码托管了） */
  codeAvailable: boolean;
}

export interface ShareLinkCreated extends ShareLinkInfo {
  code: string;
}

/** 拉取方：下载解密后的内容（逐条勾选） */
export interface ShareContent {
  preview: SharePreview;
  hosts: { id: string; name: string; protocol: string; address: string; port: number; username: string; folderId: string | null; folderPath: string; hasSecret: boolean; credentialId: string | null }[];
  folders: { id: string; parentId: string | null; name: string; path: string }[];
  credentials: { id: string; name: string; type: string; username: string | null }[];
  snippets: { id: string; name: string; group: string | null }[];
  notes: { id: string; title: string; group: string | null }[];
  skills: { id: string; title: string; description: string }[];
  /** 分享包里有密码 / 私钥 */
  hasSecrets: boolean;
}

/** 拉取方勾选的条目和选项 */
export interface ShareImportPick {
  hostIds: string[];
  credentialIds: string[];
  snippetIds: string[];
  noteIds: string[];
  /** 旧版本客户端没有这个字段 */
  skillIds?: string[];
  /** 同时导入主机分组（默认是）：放进同名路径的分组，没有时创建；否则主机放在「未分组」 */
  withGroups: boolean;
  /** 连同凭证导入（默认是）：否则不写密码 / 私钥，引用的凭证置空 */
  withCredentials: boolean;
}
