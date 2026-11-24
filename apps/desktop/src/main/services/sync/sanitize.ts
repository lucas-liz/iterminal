import { AGENT_POLICIES, SYNC_GROUPS, type SyncGroup } from '@itm/protocol';
import { normalizeFileTransfer } from '../hosts/host-repo';
import { NAME_RE as SKILL_NAME_RE } from '../ai/skills';
import { emptyDataset, GROUP_TYPES, type Dataset, type DsCredential, type DsFolder, type DsGroup, type DsHost, type DsNote, type DsPortForward, type DsSkill, type DsSnippet } from '@itm/sync-merge';

/**
 * 备份包可能来自别人（分享包、同事发来的导出文件）：逐字段校验类型和长度，不合法的字段回退默认值，缺少必填字段的条目丢弃。
 * SQL 都是参数化的，这里防的是脏数据把界面或连接逻辑弄坏。
 */
const PROTOCOLS = ['SSH', 'TELNET', 'SERIAL'];
const AUTH = ['PASSWORD', 'KEY', 'AGENT', 'INTERACTIVE', 'CREDENTIAL'];
const POLICIES: string[] = [...AGENT_POLICIES];
const CRED_TYPES = ['PASSWORD', 'SSH_KEY', 'CERT', 'OTP', 'CLOUD_AK', 'DB'];
const FWD_TYPES = ['LOCAL', 'REMOTE', 'DYNAMIC'];
const MAX_ITEMS = 50_000;

type O = Record<string, unknown>;
const obj = (v: unknown): O | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : null);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const name = (v: unknown, max = 128): string | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= max ? s : null;
};
const id = (v: unknown): string | null => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null);
const int = (v: unknown, min: number, max: number, def: number): number => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : def);
const intOrNull = (v: unknown, min: number, max: number): number | null => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : null);
const oneOf = (v: unknown, list: string[], def: string | null): string | null => (typeof v === 'string' && list.includes(v) ? v : def);
const strArr = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= maxLen).map((x) => x.trim()))].slice(0, maxItems) : [];
const idArr = (v: unknown, maxItems: number): string[] => (Array.isArray(v) ? v.map(id).filter((x): x is string => !!x).slice(0, maxItems) : []);
const time = (v: unknown): number => int(v, 0, 8_640_000_000_000_000, Date.now());
const smallJson = (v: unknown, max = 16 * 1024): unknown => {
  const o = obj(v);
  if (!o) return null;
  return JSON.stringify(o).length <= max ? o : null;
};

function list<T extends { id: string }>(raw: unknown, f: (o: O) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of raw.slice(0, MAX_ITEMS)) {
    const o = obj(x);
    const item = o ? f(o) : null;
    const key = item ? item.id : null;
    if (item && key && !seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

const folder = (o: O): DsFolder | null => {
  const i = id(o.id);
  const n = name(o.name, 64)?.replace(/\//g, '／');
  if (!i || !n) return null;
  return {
    id: i,
    parentId: id(o.parentId),
    name: n,
    sort: int(o.sort, -1e12, 1e12, 0),
    defaultCredentialId: id(o.defaultCredentialId),
    defaultJumpHostId: id(o.defaultJumpHostId),
    agentPolicy: oneOf(o.agentPolicy, POLICIES, null),
    aiNote: str(o.aiNote, 4000),
    defaultSkills: strArr(o.defaultSkills, 50, 128),
    production: o.production === true,
    updatedAt: time(o.updatedAt),
  };
};

const forward = (o: O): DsPortForward | null => {
  const type = oneOf(o.type, FWD_TYPES, null);
  const bindAddr = name(o.bindAddr, 255);
  const bindPort = intOrNull(o.bindPort, 0, 65535);
  if (!type || !bindAddr || bindPort === null) return null;
  return { type, bindAddr, bindPort, targetAddr: name(o.targetAddr, 255), targetPort: intOrNull(o.targetPort, 1, 65535), autoStart: o.autoStart === true };
};

const host = (o: O): DsHost | null => {
  const i = id(o.id);
  const n = name(o.name);
  const protocol = oneOf(o.protocol, PROTOCOLS, null);
  if (!i || !n || !protocol) return null;
  const env = obj(o.env) ?? {};
  return {
    id: i,
    folderId: id(o.folderId),
    name: n,
    protocol,
    address: name(o.address, 255) ?? '',
    port: int(o.port, 0, 65535, protocol === 'TELNET' ? 23 : 22),
    username: name(o.username, 128) ?? '',
    authMethod: oneOf(o.authMethod, AUTH, 'PASSWORD')!,
    credentialId: id(o.credentialId),
    jumpHostIds: idArr(o.jumpHostIds, 5),
    jumpInherit: o.jumpInherit !== false,
    proxy: smallJson(o.proxy),
    encoding: name(o.encoding, 32) ?? 'UTF-8',
    termType: name(o.termType, 64) ?? 'xterm-256color',
    env: Object.fromEntries(Object.entries(env).filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string' && v.length <= 4096).slice(0, 100)) as Record<string, string>,
    startupScript: str(o.startupScript, 64 * 1024),
    keepaliveSec: int(o.keepaliveSec, 0, 3600, 30),
    serialOpts: smallJson(o.serialOpts),
    agentPolicy: oneOf(o.agentPolicy, POLICIES, null),
    cmdDenylist: strArr(o.cmdDenylist, 200, 512),
    tags: strArr(o.tags, 20, 32),
    favorite: o.favorite === true,
    note: str(o.note, 4000),
    monitorScript: str(o.monitorScript, 64 * 1024),
    fileTransfer: normalizeFileTransfer(o.fileTransfer),
    recordSession: o.recordSession !== false,
    portForwards: (Array.isArray(o.portForwards) ? o.portForwards : [])
      .slice(0, 50)
      .map((x) => (obj(x) ? forward(obj(x)!) : null))
      .filter((x): x is DsPortForward => !!x),
    password: str(o.password, 4096),
    privateKey: str(o.privateKey, 64 * 1024),
    passphrase: str(o.passphrase, 4096),
    proxyPassword: str(o.proxyPassword, 4096),
    updatedAt: time(o.updatedAt),
  };
};

const group = (o: O): DsGroup | null => {
  const i = id(o.id);
  const n = name(o.name, 64);
  return i && n ? { id: i, name: n, sort: int(o.sort, -1e12, 1e12, 0), updatedAt: time(o.updatedAt) } : null;
};

const snippet = (o: O): DsSnippet | null => {
  const i = id(o.id);
  const n = name(o.name);
  const content = str(o.content, 64 * 1024);
  if (!i || !n || !content?.trim()) return null;
  return { id: i, groupId: id(o.groupId), name: n, content, description: str(o.description, 1000), tags: strArr(o.tags, 20, 32), sort: int(o.sort, -1e12, 1e12, 0), updatedAt: time(o.updatedAt) };
};

const note = (o: O): DsNote | null => {
  const i = id(o.id);
  const t = name(o.title, 200);
  if (!i || !t) return null;
  return {
    id: i,
    groupId: id(o.groupId),
    title: t,
    content: str(o.content, 1024 * 1024) ?? '',
    format: oneOf(o.format, ['MARKDOWN', 'TEXT'], 'MARKDOWN')!,
    pinned: o.pinned === true,
    sort: int(o.sort, -1e12, 1e12, 0),
    updatedAt: time(o.updatedAt),
  };
};

const credential = (o: O): DsCredential | null => {
  const i = id(o.id);
  const n = name(o.name, 64);
  const type = oneOf(o.type, CRED_TYPES, null);
  if (!i || !n || !type) return null;
  return {
    id: i,
    type,
    name: n,
    username: name(o.username, 128),
    secret: str(o.secret, 64 * 1024),
    passphrase: str(o.passphrase, 4096),
    publicKey: str(o.publicKey, 16 * 1024),
    fingerprint: str(o.fingerprint, 128),
    otpSeed: str(o.otpSeed, 1024),
    aiAccess: oneOf(o.aiAccess, ['REFERENCE', 'DENY'], 'REFERENCE')!,
    rotateDays: intOrNull(o.rotateDays, 1, 3650),
    expiresAt: intOrNull(o.expiresAt, 0, 8_640_000_000_000_000),
    note: str(o.note, 1000),
    updatedAt: time(o.updatedAt),
  };
};

/** Skill：名称和本机 Skill 目录名的规则一样，内容要有 front matter，最多 256KB */
const skill = (o: O): DsSkill | null => {
  const i = typeof o.id === 'string' && SKILL_NAME_RE.test(o.id) ? o.id : null;
  const content = str(o.content, 256 * 1024);
  if (!i || !content || !/^---\s*\r?\n/.test(content)) return null;
  return { id: i, content, updatedAt: time(o.updatedAt) };
};

/** 解析备份包 body；只保留 header 声明过的分组 */
export function sanitizeDataset(raw: unknown, groups: SyncGroup[]): Dataset {
  const o = obj(raw) ?? {};
  const keep = new Set(groups.filter((g) => SYNC_GROUPS.includes(g)).flatMap((g) => GROUP_TYPES[g]));
  const d = emptyDataset();
  if (keep.has('hostGroups')) d.hostGroups = list(o.hostGroups, folder);
  if (keep.has('hosts')) d.hosts = list(o.hosts, host);
  if (keep.has('snippetGroups')) d.snippetGroups = list(o.snippetGroups, group);
  if (keep.has('snippets')) d.snippets = list(o.snippets, snippet);
  if (keep.has('noteGroups')) d.noteGroups = list(o.noteGroups, group);
  if (keep.has('notes')) d.notes = list(o.notes, note);
  if (keep.has('credentials')) d.credentials = list(o.credentials, credential);
  if (keep.has('skills')) d.skills = list(o.skills, skill);
  // 分组的父子关系不能成环：沿 parentId 走超过 8 层或回到自己时断开
  const byId = new Map(d.hostGroups.map((f) => [f.id, f]));
  for (const f of d.hostGroups) {
    let p = f.parentId;
    for (let depth = 0; p; depth++) {
      if (p === f.id || depth >= 8 || !byId.has(p)) {
        if (p === f.id || depth >= 8) f.parentId = null;
        break;
      }
      p = byId.get(p)!.parentId;
    }
  }
  return d;
}

/** 写出前统一的 body：没选的分组不出现（6.10.5） */
export function bodyOf(d: Dataset, groups: SyncGroup[]): Record<string, unknown> {
  const keep = new Set(groups.flatMap((g) => GROUP_TYPES[g]));
  return Object.fromEntries(Object.entries(d).filter(([k]) => keep.has(k as keyof Dataset)));
}
