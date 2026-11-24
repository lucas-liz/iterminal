import type { ShareContent, ShareImportPick, SharePreview, ShareSelection, ShareSelectionPreview, SyncGroup } from '@itm/protocol';
import { emptyDataset, type Dataset, type DsFolder, type DsHost, type DsSkill } from '@itm/sync-merge';
import { parseSkill } from '../ai/skills';

/**
 * 单项分享和拉取时勾选内容（第十三轮，文档一 6.27.3 / 6.27.4）。纯函数：
 * - pickForShare：分享方从本机全部数据里挑出选中的条目，自动带上依赖（跳板机、分组路径、凭证）；
 * - shareContent / pickForImport：拉取方列出分享包里的条目，按勾选的条目和选项裁剪，再交给 6.10.7 的合并规则。
 */

const hasOwnSecret = (h: DsHost): boolean => !!(h.password || h.privateKey || h.proxyPassword);

/** 分组 id → 名称路径（「生产 / web」） */
function folderPaths(folders: DsFolder[]): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out = new Map<string, string>();
  const path = (f: DsFolder, guard = 0): string => {
    const cached = out.get(f.id);
    if (cached !== undefined) return cached;
    const parent = f.parentId ? byId.get(f.parentId) : undefined;
    const p = parent && guard < 16 ? `${path(parent, guard + 1)} / ${f.name}` : f.name;
    out.set(f.id, p);
    return p;
  };
  folders.forEach((f) => path(f));
  return out;
}

/** 分组和它的全部上级 */
function withAncestors(ids: Iterable<string>, byId: Map<string, DsFolder>): Set<string> {
  const out = new Set<string>();
  for (let id of ids) {
    for (let guard = 0; id && byId.has(id) && !out.has(id) && guard < 32; guard++) {
      out.add(id);
      id = byId.get(id)!.parentId ?? '';
    }
  }
  return out;
}

/** 数据里实际包含的分组（凭证分组：有凭证或主机自己的密码时） */
export function groupsOf(d: Dataset, withSecrets: boolean): SyncGroup[] {
  const g: SyncGroup[] = [];
  if (d.hosts.length || d.hostGroups.length) g.push('HOSTS');
  if (d.snippets.length || d.snippetGroups.length) g.push('SNIPPETS');
  if (d.notes.length || d.noteGroups.length) g.push('NOTES');
  if (d.skills.length) g.push('SKILLS');
  if (withSecrets && (d.credentials.length || d.hosts.some(hasOwnSecret))) g.push('CREDENTIALS');
  return g;
}

/** Skill 的显示名和说明（front matter 的 title / description，没有时用名称） */
function skillMeta(s: DsSkill): { title: string; description: string } {
  try {
    const p = parseSkill(s.id, s.content);
    return { title: p.title || s.id, description: p.description };
  } catch {
    return { title: s.id, description: '' };
  }
}
const skillTitle = (s: DsSkill): string => skillMeta(s).title;

/** 默认标题：「web-01 等 3 台主机、2 篇笔记」 */
function titleOf(d: Dataset, explicitHosts: DsHost[]): string {
  const parts: string[] = [];
  const first = (names: string[]): string => (names.length === 1 ? names[0] : `${names[0]} 等 ${names.length} `);
  if (explicitHosts.length) parts.push(explicitHosts.length === 1 ? `主机 ${explicitHosts[0].name}` : `${first(explicitHosts.map((h) => h.name))}台主机`);
  if (d.snippets.length) parts.push(d.snippets.length === 1 ? `快捷命令 ${d.snippets[0].name}` : `${first(d.snippets.map((s) => s.name))}条快捷命令`);
  if (d.notes.length) parts.push(d.notes.length === 1 ? `笔记 ${d.notes[0].title}` : `${first(d.notes.map((n) => n.title))}篇笔记`);
  if (d.skills.length) parts.push(d.skills.length === 1 ? `Skill ${skillTitle(d.skills[0])}` : `${first(d.skills.map(skillTitle))}个 Skill`);
  return (parts.join('、') || '分享').slice(0, 100);
}

/**
 * 分享方：all 是本机全部数据（带秘密）。teamFolderIds：团队分组（团队主机不能分享）。
 * includeCredentials = false 时去掉主机的密码 / 私钥和凭证（引用保留，拉取方本地有同一个凭证时仍然能对上）。
 */
export function pickForShare(
  all: Dataset,
  sel: ShareSelection,
  o: { includeCredentials: boolean; teamFolderIds: Set<string> },
): { data: Dataset; groups: SyncGroup[]; preview: ShareSelectionPreview } {
  const folderById = new Map(all.hostGroups.map((f) => [f.id, f]));
  const hostById = new Map(all.hosts.map((h) => [h.id, h]));
  const isTeam = (h: DsHost): boolean => !!h.folderId && (o.teamFolderIds.has(h.folderId) || !folderById.has(h.folderId));
  // 整个分组：包含子分组
  const subtree = new Set<string>();
  const queue = (sel.folderIds ?? []).filter((id) => folderById.has(id));
  while (queue.length) {
    const id = queue.shift()!;
    if (subtree.has(id)) continue;
    subtree.add(id);
    for (const f of all.hostGroups) if (f.parentId === id) queue.push(f.id);
  }
  let skippedTeam = 0;
  const explicit = new Set<string>();
  for (const id of sel.hostIds ?? []) if (hostById.has(id)) explicit.add(id);
  for (const h of all.hosts) if (h.folderId && subtree.has(h.folderId)) explicit.add(h.id);
  for (const id of [...explicit]) {
    if (isTeam(hostById.get(id)!)) {
      explicit.delete(id);
      skippedTeam++;
    }
  }
  // 依赖：跳板机（递归）、分组的默认跳板机
  const included = new Set(explicit);
  const jumpQueue = [...explicit].flatMap((id) => hostById.get(id)!.jumpHostIds);
  for (const fid of subtree) {
    const j = folderById.get(fid)?.defaultJumpHostId;
    if (j) jumpQueue.push(j);
  }
  while (jumpQueue.length) {
    const id = jumpQueue.shift()!;
    const h = hostById.get(id);
    if (!h || included.has(id) || isTeam(h)) continue;
    included.add(id);
    jumpQueue.push(...h.jumpHostIds);
  }
  const hosts = all.hosts.filter((h) => included.has(h.id));
  const folders = withAncestors([...subtree, ...hosts.map((h) => h.folderId).filter((x): x is string => !!x)], folderById);
  const hostGroups = all.hostGroups.filter((f) => folders.has(f.id));
  // 凭证：主机引用的、分组默认的
  const credIds = new Set<string>([...hosts.map((h) => h.credentialId), ...hostGroups.map((f) => f.defaultCredentialId)].filter((x): x is string => !!x));
  const credentials = o.includeCredentials ? all.credentials.filter((c) => credIds.has(c.id)) : [];
  const snippetGroupSel = new Set(sel.snippetGroupIds ?? []);
  const snippets = all.snippets.filter((s) => (sel.snippetIds ?? []).includes(s.id) || (!!s.groupId && snippetGroupSel.has(s.groupId)));
  const snippetGroups = all.snippetGroups.filter((g) => snippetGroupSel.has(g.id) || snippets.some((s) => s.groupId === g.id));
  const noteGroupSel = new Set(sel.noteGroupIds ?? []);
  const notes = all.notes.filter((n) => (sel.noteIds ?? []).includes(n.id) || (!!n.groupId && noteGroupSel.has(n.groupId)));
  const noteGroups = all.noteGroups.filter((g) => noteGroupSel.has(g.id) || notes.some((n) => n.groupId === g.id));
  const skillSel = new Set(sel.skillIds ?? []);
  const skills = all.skills.filter((s) => skillSel.has(s.id)).map(({ id, content, updatedAt }) => ({ id, content, updatedAt }));

  const data = emptyDataset();
  data.hostGroups = hostGroups;
  data.hosts = o.includeCredentials ? hosts : hosts.map((h) => ({ ...h, password: null, privateKey: null, passphrase: null, proxyPassword: null }));
  data.credentials = credentials;
  data.snippetGroups = snippetGroups;
  data.snippets = snippets;
  data.noteGroups = noteGroups;
  data.notes = notes;
  data.skills = skills;
  const paths = folderPaths(all.hostGroups);
  const credName = new Map(all.credentials.map((c) => [c.id, c.name]));
  const sgName = new Map(all.snippetGroups.map((g) => [g.id, g.name]));
  const ngName = new Map(all.noteGroups.map((g) => [g.id, g.name]));
  const preview: ShareSelectionPreview = {
    title: titleOf(data, hosts.filter((h) => explicit.has(h.id))),
    hosts: hosts.map((h) => ({
      id: h.id,
      name: h.name,
      address: `${h.username ? `${h.username}@` : ''}${h.address}${h.port && h.protocol !== 'SERIAL' ? `:${h.port}` : ''}`,
      folderPath: h.folderId ? (paths.get(h.folderId) ?? '') : '',
      jump: !explicit.has(h.id),
      hasSecret: hasOwnSecret(h),
      credentialName: h.credentialId ? (credName.get(h.credentialId) ?? null) : null,
    })),
    folders: hostGroups.map((f) => paths.get(f.id) ?? f.name),
    credentials: all.credentials.filter((c) => credIds.has(c.id)).map((c) => ({ id: c.id, name: c.name, type: c.type })),
    snippets: snippets.map((s) => ({ id: s.id, name: s.name, group: s.groupId ? (sgName.get(s.groupId) ?? null) : null })),
    notes: notes.map((n) => ({ id: n.id, title: n.title, group: n.groupId ? (ngName.get(n.groupId) ?? null) : null })),
    skills: skills.map((s) => ({ id: s.id, title: skillTitle(s) })),
    skippedTeam,
    hasSecrets: credIds.size > 0 || hosts.some(hasOwnSecret),
  };
  return { data, groups: groupsOf(data, o.includeCredentials), preview };
}

/** 拉取方：分享包里的全部条目（界面逐条勾选） */
export function shareContent(d: Dataset, preview: SharePreview): ShareContent {
  const paths = folderPaths(d.hostGroups);
  const sg = new Map(d.snippetGroups.map((g) => [g.id, g.name]));
  const ng = new Map(d.noteGroups.map((g) => [g.id, g.name]));
  return {
    preview,
    hosts: d.hosts.map((h) => ({
      id: h.id,
      name: h.name,
      protocol: h.protocol,
      address: h.address,
      port: h.port,
      username: h.username,
      folderId: h.folderId,
      folderPath: h.folderId ? (paths.get(h.folderId) ?? '') : '',
      hasSecret: hasOwnSecret(h),
      credentialId: h.credentialId,
    })),
    folders: d.hostGroups.map((f) => ({ id: f.id, parentId: f.parentId, name: f.name, path: paths.get(f.id) ?? f.name })),
    credentials: d.credentials.map((c) => ({ id: c.id, name: c.name, type: c.type, username: c.username })),
    snippets: d.snippets.map((s) => ({ id: s.id, name: s.name, group: s.groupId ? (sg.get(s.groupId) ?? null) : null })),
    notes: d.notes.map((n) => ({ id: n.id, title: n.title, group: n.groupId ? (ng.get(n.groupId) ?? null) : null })),
    skills: d.skills.map((s) => ({ id: s.id, ...skillMeta(s) })),
    hasSecrets: d.credentials.length > 0 || d.hosts.some(hasOwnSecret),
  };
}

/**
 * 拉取方：按勾选的条目裁剪。withGroups = false 时不导入主机分组，主机放在「未分组」；
 * withCredentials = false 时不导入凭证和主机的密码 / 私钥（合并时引用的凭证置空）。
 */
export function pickForImport(d: Dataset, pick: ShareImportPick): { data: Dataset; groups: SyncGroup[] } {
  const ids = (x: string[] | undefined): Set<string> => new Set(Array.isArray(x) ? x : []);
  const hostIds = ids(pick.hostIds);
  const folderById = new Map(d.hostGroups.map((f) => [f.id, f]));
  const out = emptyDataset();
  const hosts = d.hosts.filter((h) => hostIds.has(h.id));
  if (pick.withGroups) {
    const keep = withAncestors(hosts.map((h) => h.folderId).filter((x): x is string => !!x), folderById);
    out.hostGroups = d.hostGroups.filter((f) => keep.has(f.id));
    out.hosts = hosts;
  } else {
    out.hosts = hosts.map((h) => ({ ...h, folderId: null }));
  }
  if (pick.withCredentials) {
    const credIds = ids(pick.credentialIds);
    out.credentials = d.credentials.filter((c) => credIds.has(c.id));
  } else {
    out.hosts = out.hosts.map((h) => ({ ...h, password: null, privateKey: null, passphrase: null, proxyPassword: null }));
  }
  const snippetIds = ids(pick.snippetIds);
  out.snippets = d.snippets.filter((s) => snippetIds.has(s.id));
  out.snippetGroups = d.snippetGroups.filter((g) => out.snippets.some((s) => s.groupId === g.id));
  const noteIds = ids(pick.noteIds);
  out.notes = d.notes.filter((n) => noteIds.has(n.id));
  out.noteGroups = d.noteGroups.filter((g) => out.notes.some((n) => n.groupId === g.id));
  const skillIds = ids(pick.skillIds);
  out.skills = d.skills.filter((s) => skillIds.has(s.id));
  return { data: out, groups: groupsOf(out, pick.withCredentials) };
}
