/**
 * 合并规则（文档一 6.10.7）：「从备份合并」「从分享码拉取」「本地导入」共用。
 * 原则：只增不删、本地优先、只补空、引用重映射。纯函数，只计算要做什么，由调用方在一个事务里执行。
 */

export type SyncGroup = 'HOSTS' | 'SNIPPETS' | 'NOTES' | 'SKILLS' | 'CREDENTIALS';

export interface DsFolder {
  id: string;
  parentId: string | null;
  name: string;
  sort: number;
  defaultCredentialId: string | null;
  defaultJumpHostId: string | null;
  agentPolicy: string | null;
  aiNote: string | null;
  defaultSkills: string[];
  production: boolean;
  updatedAt: number;
}

export interface DsPortForward {
  type: string;
  bindAddr: string;
  bindPort: number;
  targetAddr: string | null;
  targetPort: number | null;
  autoStart: boolean;
}

export interface DsHost {
  id: string;
  folderId: string | null;
  name: string;
  protocol: string;
  address: string;
  port: number;
  username: string;
  authMethod: string;
  credentialId: string | null;
  jumpHostIds: string[];
  jumpInherit: boolean;
  proxy: unknown;
  encoding: string;
  termType: string;
  env: Record<string, string>;
  startupScript: string | null;
  keepaliveSec: number;
  serialOpts: unknown;
  agentPolicy: string | null;
  cmdDenylist: string[];
  tags: string[];
  favorite: boolean;
  note: string | null;
  monitorScript: string | null;
  /** 文件传输方式（新字段，旧的备份包里没有） */
  fileTransfer?: { mode: string; ftpPort: number } | null;
  recordSession: boolean;
  portForwards: DsPortForward[];
  /** 主机自己保存的密码 / 私钥（只在包含「凭证」分组时导出） */
  password?: string | null;
  privateKey?: string | null;
  passphrase?: string | null;
  proxyPassword?: string | null;
  updatedAt: number;
}

export interface DsGroup {
  id: string;
  name: string;
  sort: number;
  updatedAt: number;
}

export interface DsSnippet {
  id: string;
  groupId: string | null;
  name: string;
  content: string;
  description: string | null;
  tags: string[];
  sort: number;
  updatedAt: number;
}

export interface DsNote {
  id: string;
  groupId: string | null;
  title: string;
  content: string;
  format: string;
  pinned: boolean;
  sort: number;
  updatedAt: number;
}

/** Skill（第二十二轮）：id 是目录名（= front matter 的 name），内容是完整的 SKILL.md */
export interface DsSkill {
  id: string;
  content: string;
  updatedAt: number;
}

export interface DsCredential {
  id: string;
  type: string;
  name: string;
  username: string | null;
  secret: string | null;
  passphrase: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  otpSeed: string | null;
  aiAccess: string;
  rotateDays: number | null;
  expiresAt: number | null;
  note: string | null;
  updatedAt: number;
}

/** 备份包 body 的结构（文档一 6.10.5），没选的分组为空数组 */
export interface Dataset {
  hostGroups: DsFolder[];
  hosts: DsHost[];
  snippetGroups: DsGroup[];
  snippets: DsSnippet[];
  noteGroups: DsGroup[];
  notes: DsNote[];
  skills: DsSkill[];
  credentials: DsCredential[];
}

export type ItemType = keyof Dataset;
export const ITEM_TYPES: ItemType[] = ['credentials', 'hostGroups', 'hosts', 'snippetGroups', 'snippets', 'noteGroups', 'notes', 'skills'];
export const GROUP_TYPES: Record<SyncGroup, ItemType[]> = {
  HOSTS: ['hostGroups', 'hosts'],
  SNIPPETS: ['snippetGroups', 'snippets'],
  NOTES: ['noteGroups', 'notes'],
  SKILLS: ['skills'],
  CREDENTIALS: ['credentials'],
};

export const emptyDataset = (): Dataset => ({ hostGroups: [], hosts: [], snippetGroups: [], snippets: [], noteGroups: [], notes: [], skills: [], credentials: [] });

/** 分享码导入映射：`${type}:${remoteId}` → 本地 id */
export type ImportMap = Map<string, string>;

export interface MergeOptions {
  source: { kind: 'backup' } | { kind: 'share'; ownerId: string; importMap: ImportMap; newId?: () => string };
  groups: SyncGroup[];
}

export type MergeOp =
  /** 新增（item 里的引用已经换成本地 id；backup 沿用原 id，share 用新 id） */
  | { op: 'add'; type: ItemType; item: Dataset[ItemType][number] }
  /** 已存在：把这些字段补上（只补本地为空的；集合取并集） */
  | { op: 'fill'; type: ItemType; localId: string; patch: Record<string, unknown> }
  /** 分享码：记下对方 id 对应的本地 id，下次拉取识别为同一条 */
  | { op: 'map'; type: ItemType; remoteId: string; localId: string };

export interface MergeReport {
  perType: Record<ItemType, { added: number; kept: number; filled: number }>;
  unresolvedRefs: { type: ItemType; id: string; name: string; field: string }[];
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
const normText = (s: string | null | undefined): string => (s ?? '').replace(/\r\n/g, '\n').trim();
/** 集合类字段：命中同一条目时取并集（6.10.7） */
const UNION_FIELDS = new Set(['tags', 'defaultSkills', 'portForwards', 'cmdDenylist']);
const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && v !== null && Object.keys(v).length === 0);

/** 按名称路径（从根到自己，小写）索引分组 */
function folderPaths(folders: DsFolder[], nameOf: (f: DsFolder) => string = (f) => f.name): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  const path = (f: DsFolder, guard = 0): string => {
    if (out.has(f.id)) return out.get(f.id)!;
    const parent = f.parentId ? byId.get(f.parentId) : undefined;
    const p = (parent && guard < 16 ? `${path(parent, guard + 1)}/` : '') + norm(nameOf(f));
    out.set(f.id, p);
    return p;
  };
  folders.forEach((f) => path(f));
  return out;
}

/** 按深度排序（父分组在前） */
function byDepth(folders: DsFolder[]): DsFolder[] {
  const paths = folderPaths(folders);
  return [...folders].sort((a, b) => paths.get(a.id)!.split('/').length - paths.get(b.id)!.split('/').length);
}

const pfKey = (p: DsPortForward): string => `${p.type}|${p.bindAddr}|${p.bindPort}`;

/**
 * 计算合并方案。local 是本机现有的数据（用于识别同一条目，需要带凭证的秘密），incoming 是备份包 / 分享包里的数据。
 */
export function planMerge(local: Dataset, incoming: Dataset, opts: MergeOptions): { ops: MergeOp[]; report: MergeReport } {
  const ops: MergeOp[] = [];
  const perType = Object.fromEntries(ITEM_TYPES.map((t) => [t, { added: 0, kept: 0, filled: 0 }])) as MergeReport['perType'];
  const unresolved: MergeReport['unresolvedRefs'] = [];
  const types = new Set(opts.groups.flatMap((g) => GROUP_TYPES[g]));
  /** 对方 id → 本地 id */
  const idMap: Record<ItemType, Map<string, string>> = Object.fromEntries(ITEM_TYPES.map((t) => [t, new Map()])) as Record<ItemType, Map<string, string>>;
  /** 每类本地已经被匹配过的 id（一条本地数据只匹配一次） */
  const used: Record<ItemType, Set<string>> = Object.fromEntries(ITEM_TYPES.map((t) => [t, new Set()])) as Record<ItemType, Set<string>>;
  const share = opts.source.kind === 'share' ? opts.source : null;

  /** 规则 ①：同一来源（备份：id 相同；分享码：导入映射命中） */
  const sameSource = <T extends { id: string }>(type: ItemType, remote: T, pool: T[]): T | undefined => {
    const id = share ? share.importMap.get(`${type}:${remote.id}`) : remote.id;
    return id ? pool.find((x) => x.id === id && !used[type].has(x.id)) : undefined;
  };
  const makeId = share?.newId ?? (() => globalThis.crypto.randomUUID());
  const newId = (remoteId: string): string => (share ? makeId() : remoteId);
  /** 没选的分组：引用只能指向本地已有的条目（备份：id 相同；分享码：以前导入过的） */
  const keepLocal = (type: ItemType): void => {
    const ids = new Set((local[type] as { id: string }[]).map((x) => x.id));
    if (!share) for (const id of ids) idMap[type].set(id, id);
    else
      for (const [k, v] of share.importMap)
        if (k.startsWith(`${type}:`) && ids.has(v)) idMap[type].set(k.slice(type.length + 1), v);
  };
  const take = (type: ItemType, localId: string, remoteId: string): void => {
    used[type].add(localId);
    idMap[type].set(remoteId, localId);
    if (share) ops.push({ op: 'map', type, remoteId, localId });
  };
  /** 引用重映射：对方 id → 本地 id；映射不到置空并记录 */
  const remap = (type: ItemType, target: ItemType, remoteRef: string | null, owner: { id: string; name: string } | null, field: string): string | null => {
    if (!remoteRef) return null;
    const v = idMap[target].get(remoteRef);
    // owner = null：已存在的条目只用来补空，映射不到时不算「无法映射」（本地的值保持不变）
    if (!v && owner) unresolved.push({ type, id: owner.id, name: owner.name, field });
    return v ?? null;
  };
  /** 命中同一条目：只补本地为空的字段，集合取并集 */
  const fill = (type: ItemType, localItem: Record<string, unknown>, patch: Record<string, unknown>): void => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (isEmpty(v)) continue;
      const cur = localItem[k];
      if (UNION_FIELDS.has(k) && Array.isArray(v) && Array.isArray(cur)) {
        const merged = k === 'portForwards' ? unionBy(cur as DsPortForward[], v as DsPortForward[], pfKey) : [...new Set([...(cur as string[]), ...(v as string[])])];
        if (merged.length !== cur.length) out[k] = merged;
      } else if (isEmpty(cur)) {
        out[k] = v;
      }
    }
    if (Object.keys(out).length) {
      ops.push({ op: 'fill', type, localId: String(localItem.id), patch: out });
      perType[type].filled++;
    } else {
      perType[type].kept++;
    }
  };

  // ---------------------------------------------------------------- 凭证
  if (types.has('credentials')) {
    for (const r of incoming.credentials) {
      const pool = local.credentials;
      const hit =
        sameSource('credentials', r, pool) ??
        pool.find((l) => !used.credentials.has(l.id) && l.type === r.type && norm(l.name) === norm(r.name)) ??
        pool.find(
          (l) =>
            !used.credentials.has(l.id) &&
            l.type === r.type &&
            ((r.fingerprint && l.fingerprint === r.fingerprint) || (!r.fingerprint && r.secret && l.secret === r.secret && norm(l.username) === norm(r.username))),
        );
      if (hit) {
        take('credentials', hit.id, r.id);
        fill('credentials', hit as unknown as Record<string, unknown>, {
          username: r.username,
          // 私钥和口令成对补：本地已经有私钥时不动口令
          secret: r.secret,
          passphrase: hit.secret ? null : r.passphrase,
          publicKey: r.publicKey,
          otpSeed: r.otpSeed,
          rotateDays: r.rotateDays,
          expiresAt: r.expiresAt,
          note: r.note,
        });
      } else {
        const id = newId(r.id);
        idMap.credentials.set(r.id, id);
        if (share) ops.push({ op: 'map', type: 'credentials', remoteId: r.id, localId: id });
        ops.push({ op: 'add', type: 'credentials', item: { ...r, id } });
        perType.credentials.added++;
      }
    }
  }
  // 没有选凭证分组时，凭证引用按 id 能对上本地已有的就保留（自己的备份）
  if (!types.has('credentials')) keepLocal('credentials');

  // ---------------------------------------------------------------- 主机分组（按层级从上到下；同名路径视为同一分组）
  const deferredJump: { localId: string; remoteJump: string; owner: DsFolder | null }[] = [];
  if (types.has('hostGroups')) {
    const localPaths = folderPaths(local.hostGroups);
    const localByPath = new Map([...localPaths.entries()].map(([id, p]) => [p, id]));
    const remotePaths = folderPaths(incoming.hostGroups);
    for (const r of byDepth(incoming.hostGroups)) {
      const hit = sameSource('hostGroups', r, local.hostGroups) ?? local.hostGroups.find((l) => l.id === localByPath.get(remotePaths.get(r.id)!) && !used.hostGroups.has(l.id));
      const defaultCredentialId = remap('hostGroups', 'credentials', r.defaultCredentialId, hit ? null : r, 'defaultCredentialId');
      if (hit) {
        take('hostGroups', hit.id, r.id);
        fill('hostGroups', hit as unknown as Record<string, unknown>, {
          defaultCredentialId,
          agentPolicy: r.agentPolicy,
          aiNote: r.aiNote,
          defaultSkills: r.defaultSkills,
        });
        if (r.defaultJumpHostId && !hit.defaultJumpHostId) deferredJump.push({ localId: hit.id, remoteJump: r.defaultJumpHostId, owner: null });
      } else {
        const id = newId(r.id);
        idMap.hostGroups.set(r.id, id);
        if (share) ops.push({ op: 'map', type: 'hostGroups', remoteId: r.id, localId: id });
        const parentId = r.parentId ? (idMap.hostGroups.get(r.parentId) ?? null) : null;
        ops.push({ op: 'add', type: 'hostGroups', item: { ...r, id, parentId, defaultCredentialId, defaultJumpHostId: null } });
        perType.hostGroups.added++;
        if (r.defaultJumpHostId) deferredJump.push({ localId: id, remoteJump: r.defaultJumpHostId, owner: r });
      }
    }
  } else {
    keepLocal('hostGroups');
  }

  // ---------------------------------------------------------------- 主机
  if (types.has('hosts')) {
    // 先识别再新增：跳板机可能引用后面的主机
    const pending: { r: DsHost; id: string; add: boolean; hit?: DsHost }[] = [];
    for (const r of incoming.hosts) {
      const folderId = r.folderId ? (idMap.hostGroups.get(r.folderId) ?? null) : null;
      const hit =
        sameSource('hosts', r, local.hosts) ??
        local.hosts.find((l) => !used.hosts.has(l.id) && l.folderId === folderId && norm(l.name) === norm(r.name)) ??
        local.hosts.find(
          (l) => !used.hosts.has(l.id) && l.protocol === r.protocol && norm(l.address) === norm(r.address) && l.port === r.port && norm(l.username) === norm(r.username),
        );
      if (hit) {
        take('hosts', hit.id, r.id);
        pending.push({ r, id: hit.id, add: false, hit });
      } else {
        const id = newId(r.id);
        idMap.hosts.set(r.id, id);
        if (share) ops.push({ op: 'map', type: 'hosts', remoteId: r.id, localId: id });
        pending.push({ r, id, add: true });
      }
    }
    for (const p of pending) {
      const r = p.r;
      const owner = p.add ? r : null;
      const credentialId = remap('hosts', 'credentials', r.credentialId, owner, 'credentialId');
      const jumpHostIds = r.jumpHostIds.map((j) => remap('hosts', 'hosts', j, owner, 'jumpHostIds')).filter((x): x is string => !!x);
      if (p.add) {
        const folderId = r.folderId ? remap('hosts', 'hostGroups', r.folderId, r, 'folderId') : null;
        ops.push({ op: 'add', type: 'hosts', item: { ...r, id: p.id, folderId, credentialId, jumpHostIds } });
        perType.hosts.added++;
      } else {
        const l = p.hit!;
        // 地址、端口、用户名、凭证、跳板机、代理、编码、启动脚本……本地有值就保留；所在分组不变
        // 认证方式不同时，对方的凭证 / 密码对本地没有意义，不补
        const sameAuth = l.authMethod === r.authMethod;
        fill('hosts', l as unknown as Record<string, unknown>, {
          username: r.username,
          credentialId: sameAuth && l.authMethod === 'CREDENTIAL' ? credentialId : null,
          jumpHostIds,
          proxy: r.proxy,
          startupScript: r.startupScript,
          env: r.env,
          agentPolicy: r.agentPolicy,
          cmdDenylist: r.cmdDenylist,
          note: r.note,
          monitorScript: r.monitorScript,
          fileTransfer: r.fileTransfer ?? null,
          tags: r.tags,
          portForwards: r.portForwards,
          password: sameAuth && l.authMethod === 'PASSWORD' ? r.password : null,
          privateKey: sameAuth && l.authMethod === 'KEY' ? r.privateKey : null,
          passphrase: sameAuth && l.authMethod === 'KEY' && !l.privateKey ? r.passphrase : null,
          // 代理密码只跟着代理一起补
          proxyPassword: isEmpty(l.proxy) ? r.proxyPassword : null,
        });
      }
    }
  } else {
    keepLocal('hosts');
  }
  // 分组的默认跳板机：主机映射完以后再补
  for (const d of deferredJump) {
    const jump = remap('hostGroups', 'hosts', d.remoteJump, d.owner, 'defaultJumpHostId');
    if (jump) ops.push({ op: 'fill', type: 'hostGroups', localId: d.localId, patch: { defaultJumpHostId: jump } });
  }

  // ---------------------------------------------------------------- 快捷命令 / 笔记（单层分组）
  const groups = (type: 'snippetGroups' | 'noteGroups'): void => {
    if (!types.has(type)) {
      keepLocal(type);
      return;
    }
    for (const r of incoming[type]) {
      const hit = sameSource(type, r, local[type]) ?? local[type].find((l) => !used[type].has(l.id) && norm(l.name) === norm(r.name));
      if (hit) {
        take(type, hit.id, r.id);
        perType[type].kept++;
      } else {
        const id = newId(r.id);
        idMap[type].set(r.id, id);
        if (share) ops.push({ op: 'map', type, remoteId: r.id, localId: id });
        ops.push({ op: 'add', type, item: { ...r, id } });
        perType[type].added++;
      }
    }
  };
  groups('snippetGroups');
  if (types.has('snippets')) {
    for (const r of incoming.snippets) {
      const groupId = remap('snippets', 'snippetGroups', r.groupId, null, 'groupId');
      const hit =
        sameSource('snippets', r, local.snippets) ??
        local.snippets.find((l) => !used.snippets.has(l.id) && l.groupId === groupId && norm(l.name) === norm(r.name)) ??
        local.snippets.find((l) => !used.snippets.has(l.id) && normText(l.content) === normText(r.content));
      if (hit) {
        take('snippets', hit.id, r.id);
        fill('snippets', hit as unknown as Record<string, unknown>, { description: r.description, tags: r.tags });
      } else {
        const id = newId(r.id);
        if (share) ops.push({ op: 'map', type: 'snippets', remoteId: r.id, localId: id });
        if (r.groupId && !groupId) unresolved.push({ type: 'snippets', id: r.id, name: r.name, field: 'groupId' });
        ops.push({ op: 'add', type: 'snippets', item: { ...r, id, groupId } });
        perType.snippets.added++;
      }
    }
  }
  groups('noteGroups');
  if (types.has('notes')) {
    for (const r of incoming.notes) {
      const groupId = remap('notes', 'noteGroups', r.groupId, null, 'groupId');
      const hit =
        sameSource('notes', r, local.notes) ?? local.notes.find((l) => !used.notes.has(l.id) && l.groupId === groupId && norm(l.title) === norm(r.title));
      if (hit) {
        take('notes', hit.id, r.id);
        fill('notes', hit as unknown as Record<string, unknown>, { content: r.content });
      } else {
        const id = newId(r.id);
        if (share) ops.push({ op: 'map', type: 'notes', remoteId: r.id, localId: id });
        if (r.groupId && !groupId) unresolved.push({ type: 'notes', id: r.id, name: r.title, field: 'groupId' });
        ops.push({ op: 'add', type: 'notes', item: { ...r, id, groupId } });
        perType.notes.added++;
      }
    }
  }
  // ---------------------------------------------------------------- Skill：按名称（目录名）识别，本地已有同名的保留本地（不覆盖、不改名）
  if (types.has('skills')) {
    for (const r of incoming.skills) {
      const hit = local.skills.find((l) => !used.skills.has(l.id) && l.id.toLowerCase() === r.id.toLowerCase());
      if (hit) {
        used.skills.add(hit.id);
        perType.skills.kept++;
      } else {
        ops.push({ op: 'add', type: 'skills', item: { id: r.id, content: r.content, updatedAt: r.updatedAt } });
        perType.skills.added++;
      }
    }
  }
  return { ops, report: { perType, unresolvedRefs: unresolved } };
}

function unionBy<T>(a: T[], b: T[], key: (x: T) => string): T[] {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)))];
}

/** 数据集里各类的条数（备份包 header 的 counts） */
export function countDataset(d: Dataset): Record<ItemType, number> {
  return Object.fromEntries(ITEM_TYPES.map((t) => [t, d[t].length])) as Record<ItemType, number>;
}

/** 只保留选中的分组 */
export function pickGroups(d: Dataset, groups: SyncGroup[]): Dataset {
  const keep = new Set(groups.flatMap((g) => GROUP_TYPES[g]));
  const out = emptyDataset();
  for (const t of ITEM_TYPES) if (keep.has(t)) (out[t] as unknown[]) = [...d[t]];
  // 不含凭证时去掉主机自己的秘密
  if (!keep.has('credentials')) out.hosts = out.hosts.map((h) => ({ ...h, password: null, privateKey: null, passphrase: null, proxyPassword: null }));
  return out;
}

export interface ReplacePlan {
  /** 按拓扑顺序写入（id 不变；本地已有同 id 的条目整条替换，墓碑会被恢复） */
  upserts: { type: ItemType; item: Dataset[ItemType][number] }[];
  /** 本地有、包里没有的条目：打墓碑 */
  removes: { type: ItemType; id: string }[];
  /** 没选的分组里引用了被删除条目的字段：置空 */
  detach: { type: ItemType; id: string; field: string }[];
  report: {
    perType: Record<ItemType, { added: number; updated: number; removed: number; unchanged: number }>;
    unresolvedRefs: MergeReport['unresolvedRefs'];
  };
}

const stable = (o: unknown): string =>
  JSON.stringify(o, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== 'updatedAt').sort(([a], [b]) => a.localeCompare(b))) : v,
  );

/**
 * 「覆盖本地」：选中的分组以包里的数据为准（只用于自己的备份 / 本地导出文件，分享码只能合并）。
 * 引用指向的条目既不在包里、本地也没有时置空并报告。
 */
export function planReplace(local: Dataset, incoming: Dataset, groups: SyncGroup[]): ReplacePlan {
  const types = new Set(groups.flatMap((g) => GROUP_TYPES[g]));
  const L = pickGroups(local, groups);
  const R = pickGroups(incoming, groups);
  const perType = Object.fromEntries(ITEM_TYPES.map((t) => [t, { added: 0, updated: 0, removed: 0, unchanged: 0 }])) as ReplacePlan['report']['perType'];
  const unresolved: MergeReport['unresolvedRefs'] = [];
  const upserts: ReplacePlan['upserts'] = [];
  const removes: ReplacePlan['removes'] = [];
  const detach: ReplacePlan['detach'] = [];
  /** 替换完成后每类存在的 id */
  const after = Object.fromEntries(
    ITEM_TYPES.map((t) => [t, new Set(((types.has(t) ? R[t] : local[t]) as { id: string }[]).map((x) => x.id))]),
  ) as Record<ItemType, Set<string>>;
  const ref = (type: ItemType, target: ItemType, v: string | null, owner: { id: string; name: string }, field: string): string | null => {
    if (!v) return null;
    if (after[target].has(v)) return v;
    unresolved.push({ type, id: owner.id, name: owner.name, field });
    return null;
  };
  const fix: Record<ItemType, (x: never) => Dataset[ItemType][number]> = {
    credentials: (c: DsCredential) => c,
    hostGroups: (f: DsFolder) => ({
      ...f,
      parentId: ref('hostGroups', 'hostGroups', f.parentId, f, 'parentId'),
      defaultCredentialId: ref('hostGroups', 'credentials', f.defaultCredentialId, f, 'defaultCredentialId'),
      defaultJumpHostId: ref('hostGroups', 'hosts', f.defaultJumpHostId, f, 'defaultJumpHostId'),
    }),
    hosts: (h: DsHost) => ({
      ...h,
      folderId: ref('hosts', 'hostGroups', h.folderId, h, 'folderId'),
      credentialId: ref('hosts', 'credentials', h.credentialId, h, 'credentialId'),
      jumpHostIds: h.jumpHostIds.map((j) => ref('hosts', 'hosts', j, h, 'jumpHostIds')).filter((x): x is string => !!x),
    }),
    snippetGroups: (g: DsGroup) => g,
    snippets: (s: DsSnippet) => ({ ...s, groupId: ref('snippets', 'snippetGroups', s.groupId, s, 'groupId') }),
    noteGroups: (g: DsGroup) => g,
    notes: (n: DsNote) => ({ ...n, groupId: ref('notes', 'noteGroups', n.groupId, { id: n.id, name: n.title }, 'groupId') }),
    skills: (s: DsSkill) => s,
  };
  for (const t of ITEM_TYPES) {
    if (!types.has(t)) continue;
    const localById = new Map((L[t] as { id: string }[]).map((x) => [x.id, x]));
    const items = t === 'hostGroups' ? byDepth(R.hostGroups) : (R[t] as { id: string }[]);
    for (const raw of items) {
      const item = (fix[t] as (x: unknown) => Dataset[ItemType][number])(raw);
      const cur = localById.get(raw.id);
      if (!cur) perType[t].added++;
      else if (stable(cur) === stable(item)) perType[t].unchanged++;
      else perType[t].updated++;
      upserts.push({ type: t, item });
    }
    for (const x of L[t] as { id: string }[]) {
      if (!after[t].has(x.id)) {
        removes.push({ type: t, id: x.id });
        perType[t].removed++;
      }
    }
  }
  // 没选的分组引用了被删除的条目
  if (types.has('credentials') && !types.has('hosts')) {
    for (const h of local.hosts) if (h.credentialId && !after.credentials.has(h.credentialId)) detach.push({ type: 'hosts', id: h.id, field: 'credentialId' });
    for (const f of local.hostGroups)
      if (f.defaultCredentialId && !after.credentials.has(f.defaultCredentialId)) detach.push({ type: 'hostGroups', id: f.id, field: 'defaultCredentialId' });
  }
  return { upserts, removes, detach, report: { perType, unresolvedRefs: unresolved } };
}
