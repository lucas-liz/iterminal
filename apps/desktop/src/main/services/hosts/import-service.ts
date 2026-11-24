import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { AuthMethod, Host, ImportItem, ImportPreview, ImportResult, ImportSource } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';
import type { FolderRepo } from './folder-repo';
import type { HostRepo } from './host-repo';
import { CSV_HEADER, parseImport, toCsvField, type HostsJson, type ParsedHost } from './importers';

/** 预览结果在主进程里保留 15 分钟，提交时用 token 取回（密码 / 私钥不经过渲染进程） */
const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_IMPORT = 5000;

interface PendingImport {
  source: ImportSource;
  hosts: ParsedHost[];
  expires: number;
}

/** 识别同一台主机：协议 + 地址 + 端口 + 用户名（和 6.10.7 合并规则一致） */
export function hostIdentity(h: { protocol: string; address: string; port: number; username: string }): string {
  return `${h.protocol}|${h.address.trim().toLowerCase()}|${h.port}|${h.username.trim().toLowerCase()}`;
}

export class ImportService {
  private readonly pending = new Map<string, PendingImport>();

  constructor(
    private readonly db: Db,
    private readonly hosts: HostRepo,
    private readonly folders: FolderRepo,
    private readonly now: () => number = Date.now,
  ) {}

  preview(source: ImportSource, path: string): ImportPreview {
    if (source !== 'SSH_CONFIG' && (!path || !existsSync(path))) throw new UserError('文件或目录不存在');
    let parsed;
    try {
      parsed = parseImport(source, path);
    } catch (e) {
      throw new UserError(`无法解析：${(e as Error).message}`);
    }
    if (parsed.hosts.length > MAX_IMPORT) throw new UserError(`一次最多导入 ${MAX_IMPORT} 台主机`);
    for (const [k, v] of this.pending) if (v.expires < this.now()) this.pending.delete(k);
    const token = randomUUID();
    this.pending.set(token, { source, hosts: parsed.hosts, expires: this.now() + PREVIEW_TTL_MS });
    const existing = new Map(this.hosts.list().map((h) => [hostIdentity(h), h.id]));
    const items: ImportItem[] = parsed.hosts.map((h) => ({
      key: h.key,
      folderPath: h.folderPath,
      name: h.name,
      protocol: h.protocol,
      address: h.address,
      port: h.port,
      username: h.username,
      authMethod: h.authMethod,
      hasPassword: !!h.password,
      hasPrivateKey: !!h.privateKey,
      jumpKeys: h.jumps,
      tags: h.tags,
      note: h.note,
      duplicateOf: existing.get(hostIdentity(h)) ?? null,
    }));
    return { token, source, items, warnings: parsed.warnings };
  }

  /**
   * 导入选中的主机：按原分组路径在 targetFolderId 下逐级建分组；跳板机在第二遍按同一批导入的主机
   * （或者按 user@host:port 匹配的已有主机）映射。
   */
  commit(token: string, keys: string[], targetFolderId: string | null, skipDuplicates: boolean): ImportResult {
    const p = this.pending.get(token);
    if (!p || p.expires < this.now()) throw new UserError('导入预览已过期，请重新选择文件');
    if (targetFolderId) this.folders.require(targetFolderId);
    const wanted = new Set(keys);
    const selected = p.hosts.filter((h) => wanted.has(h.key));
    const existingHosts = this.hosts.list();
    const existing = new Map(existingHosts.map((h) => [hostIdentity(h), h.id]));
    const foldersBefore = this.folders.list().length;
    const created = new Map<string, string>();
    let skipped = 0;
    this.db.transaction(() => {
      for (const h of selected) {
        const dup = existing.get(hostIdentity(h));
        if (dup && skipDuplicates) {
          created.set(h.key, dup);
          skipped++;
          continue;
        }
        const folderId = h.folderPath.length ? this.folders.ensurePath(h.folderPath, targetFolderId) : targetFolderId;
        const host = this.hosts.create({
          folderId,
          name: h.name.slice(0, 64),
          protocol: h.protocol,
          address: h.address,
          port: h.port,
          username: h.username,
          authMethod: h.protocol === 'SSH' && !h.username ? 'INTERACTIVE' : h.authMethod,
          password: h.password ?? null,
          privateKey: h.privateKey ?? null,
          passphrase: h.passphrase ?? null,
          keepaliveSec: 30,
          startupScript: null,
          note: h.note,
          jumpHostIds: [],
          tags: h.tags,
        });
        created.set(h.key, host.id);
      }
      // 第二遍：跳板机
      for (const h of selected) {
        if (h.jumps.length === 0) continue;
        const id = created.get(h.key);
        if (!id || existingHosts.some((x) => x.id === id)) continue;
        const jumpIds = h.jumps.map((j) => created.get(j) ?? matchByAddress(existingHosts, j)).filter((x): x is string => !!x && x !== id);
        if (jumpIds.length === 0) continue;
        const host = this.hosts.require(id);
        this.hosts.update(id, { ...host, proxy: undefined, jumpHostIds: jumpIds });
      }
    })();
    this.pending.delete(token);
    return { createdHosts: selected.length - skipped, createdFolders: this.folders.list().length - foldersBefore, skipped };
  }

  /**
   * 导出主机列表（CSV / JSON）。默认不含密码和私钥；传了 secretsOf 时（「包含敏感信息」）带上每台主机实际使用的
   * 用户名、密码、私钥：使用凭证的主机展开成主机自己的密码 / 私钥，导入到别的电脑时不依赖原来的凭证。
   */
  async exportHosts(format: 'CSV' | 'JSON', path: string, hostIds: string[] | null, secretsOf?: (h: Host) => ExportSecrets | null): Promise<{ count: number; secrets: number }> {
    const all = this.hosts.list();
    const list = hostIds ? all.filter((h) => hostIds.includes(h.id)) : all;
    const folders = this.folders.list();
    const pathOf = (folderId: string | null): string[] => {
      const names: string[] = [];
      for (let f = folders.find((x) => x.id === folderId); f; f = folders.find((x) => x.id === f!.parentId)) names.unshift(f.name);
      return names;
    };
    const fullName = (h: Host): string => [...pathOf(h.folderId), h.name].join('/');
    const jumpNames = (h: Host): string[] => h.jumpHostIds.map((id) => all.find((x) => x.id === id)).filter((x): x is Host => !!x).map(fullName);
    const secrets = new Map<string, ExportSecrets>();
    if (secretsOf) for (const h of list) {
      const s = secretsOf(h);
      if (s && (s.password || s.privateKey)) secrets.set(h.id, s);
    }
    /** 带上秘密时认证方式按实际使用的来（凭证展开成密码 / 私钥） */
    const authOf = (h: Host): AuthMethod => secrets.get(h.id)?.authMethod ?? h.authMethod;
    const userOf = (h: Host): string => secrets.get(h.id)?.username || h.username;
    if (format === 'JSON') {
      const data: HostsJson = {
        format: 'itm-hosts',
        version: 1,
        exportedAt: new Date(this.now()).toISOString(),
        ...(secretsOf ? { containsSecrets: true } : {}),
        hosts: list.map((h) => {
          const s = secrets.get(h.id);
          return {
            name: h.name,
            folderPath: pathOf(h.folderId),
            protocol: h.protocol === 'SERIAL' ? 'SSH' : h.protocol,
            address: h.address,
            port: h.port,
            username: userOf(h),
            authMethod: authOf(h),
            tags: h.tags,
            note: h.note,
            jumps: jumpNames(h),
            ...(s?.password ? { password: s.password } : {}),
            ...(s?.privateKey ? { privateKey: s.privateKey } : {}),
            ...(s?.passphrase ? { passphrase: s.passphrase } : {}),
          };
        }),
      };
      await writeFile(path, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: secretsOf ? 0o600 : 0o644 });
    } else {
      const header = secretsOf ? [...CSV_HEADER, 'password', 'privateKey', 'passphrase'] : CSV_HEADER;
      const rows = [
        header,
        ...list.map((h) => {
          const base = [h.name, pathOf(h.folderId).join('/'), h.protocol, h.address, String(h.port), userOf(h), authOf(h), h.tags.join(';'), h.note ?? '', jumpNames(h).join(';')];
          const s = secrets.get(h.id);
          return secretsOf ? [...base, s?.password ?? '', s?.privateKey ?? '', s?.passphrase ?? ''] : base;
        }),
      ];
      // 带 BOM，Excel 打开中文不乱码
      await writeFile(path, '\uFEFF' + rows.map((r) => r.map(toCsvField).join(',')).join('\r\n') + '\r\n', { encoding: 'utf8', mode: secretsOf ? 0o600 : 0o644 });
    }
    return { count: list.length, secrets: secrets.size };
  }
}

/** 「包含敏感信息」导出时一台主机的秘密（使用凭证的主机已经展开） */
export interface ExportSecrets {
  authMethod: AuthMethod;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

/** user@host:port 或 host 形式的跳板机，按地址匹配已有主机 */
function matchByAddress(hosts: Host[], spec: string): string | undefined {
  const m = /^(?:([^@]+)@)?(\[[^\]]+]|[^:]+)(?::(\d+))?$/.exec(spec.trim());
  if (!m) return undefined;
  const user = m[1];
  const addr = m[2].replace(/^\[|]$/g, '').toLowerCase();
  const port = m[3] ? Number(m[3]) : 22;
  return hosts.find((h) => (h.address.toLowerCase() === addr || h.name.toLowerCase() === addr) && h.port === port && (!user || h.username === user))?.id;
}
