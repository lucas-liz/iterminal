import { randomBytes, randomUUID } from 'node:crypto';
import type { McpPermission, McpServerConfig, McpServerInput, McpTransport } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';
import { open, seal } from '../vault/vault';

const TRANSPORTS: McpTransport[] = ['STDIO', 'SSE', 'HTTP'];
const PERMISSIONS: McpPermission[] = ['AUTO', 'APPROVE', 'DISABLED'];
/** 本机 MCP 服务的令牌：存在 setting 表里但不在设置校验表中，所以不会随 setting.getAll 发给渲染进程 */
const TOKEN_KEY = 'mcp.server.token';

interface Row {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string | null;
  url: string | null;
  env_enc: Buffer | null;
  headers_enc: Buffer | null;
  default_permission: McpPermission;
  tool_policies: string | null;
  enabled: number;
  updated_at: number;
}

const parse = <T>(s: string | null, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

function cleanMap(m: Record<string, string> | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    const key = k.trim();
    if (!key) continue;
    if (!/^[A-Za-z_][\w.-]*$/.test(key)) throw new UserError(`${what}的名称不合法：${key}`);
    out[key] = String(v ?? '');
  }
  return out;
}

/** 解密后的连接参数，只在主进程使用 */
export interface McpServerSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

/** MCP Server 配置（文档一 6.8 / 8.2 mcp_server）：环境变量和请求头加密保存 */
export class McpRepo {
  constructor(
    private readonly db: Db,
    private readonly vaultKey: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  list(): McpServerConfig[] {
    return this.db.prepare<[], Row>('SELECT * FROM mcp_server ORDER BY name COLLATE NOCASE').all().map((r) => this.toConfig(r));
  }

  get(id: string): McpServerConfig | null {
    const r = this.db.prepare<[string], Row>('SELECT * FROM mcp_server WHERE id = ?').get(id);
    return r ? this.toConfig(r) : null;
  }

  byName(name: string): McpServerConfig | null {
    const r = this.db.prepare<[string], Row>('SELECT * FROM mcp_server WHERE lower(name) = lower(?)').get(name.trim());
    return r ? this.toConfig(r) : null;
  }

  secrets(id: string): McpServerSecrets {
    const r = this.db.prepare<[string], Pick<Row, 'env_enc' | 'headers_enc'>>('SELECT env_enc, headers_enc FROM mcp_server WHERE id = ?').get(id);
    return {
      env: r?.env_enc ? parse(open(this.vaultKey, r.env_enc, `mcp_env:${id}`), {}) : {},
      headers: r?.headers_enc ? parse(open(this.vaultKey, r.headers_enc, `mcp_headers:${id}`), {}) : {},
    };
  }

  save(id: string | null, input: McpServerInput): McpServerConfig {
    const name = String(input.name ?? '').trim();
    if (!name) throw new UserError('请填写名称');
    if (!/^[\w一-龥.-]{1,40}$/.test(name)) throw new UserError('名称只能用字母、数字、中文、下划线、点和连字符（Agent 用名称调用）');
    const dup = this.byName(name);
    if (dup && dup.id !== id) throw new UserError(`已经有名为「${name}」的 MCP Server`);
    if (!TRANSPORTS.includes(input.transport)) throw new UserError('不支持的传输方式');
    if (!PERMISSIONS.includes(input.defaultPermission)) throw new UserError('权限不合法');
    let command: string | null = null;
    let url: string | null = null;
    const args = (input.args ?? []).map(String).filter((a) => a !== '').slice(0, 50);
    if (input.transport === 'STDIO') {
      command = String(input.command ?? '').trim();
      if (!command) throw new UserError('请填写启动命令');
    } else {
      url = String(input.url ?? '').trim();
      try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
      } catch {
        throw new UserError('请填写 http(s):// 开头的地址');
      }
    }
    const policies: Record<string, McpPermission> = {};
    for (const [k, v] of Object.entries(input.toolPolicies ?? {})) if (PERMISSIONS.includes(v)) policies[k] = v;
    const now = this.now();
    const newId = id ?? randomUUID();
    this.db.transaction(() => {
      if (id) {
        const r = this.db
          .prepare(
            `UPDATE mcp_server SET name = ?, transport = ?, command = ?, args = ?, url = ?, default_permission = ?, tool_policies = ?, enabled = ?, updated_at = ?
              WHERE id = ?`,
          )
          .run(name, input.transport, command, JSON.stringify(args), url, input.defaultPermission, JSON.stringify(policies), input.enabled ? 1 : 0, now, id);
        if (r.changes === 0) throw new UserError('MCP Server 不存在');
      } else {
        this.db
          .prepare(
            `INSERT INTO mcp_server (id, name, transport, command, args, url, default_permission, tool_policies, enabled, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(newId, name, input.transport, command, JSON.stringify(args), url, input.defaultPermission, JSON.stringify(policies), input.enabled ? 1 : 0, now);
      }
      if (input.env !== undefined) {
        const env = cleanMap(input.env, '环境变量');
        this.db.prepare('UPDATE mcp_server SET env_enc = ? WHERE id = ?').run(Object.keys(env).length ? seal(this.vaultKey, JSON.stringify(env), `mcp_env:${newId}`) : null, newId);
      }
      if (input.headers !== undefined) {
        const headers = cleanMap(input.headers, '请求头');
        this.db
          .prepare('UPDATE mcp_server SET headers_enc = ? WHERE id = ?')
          .run(Object.keys(headers).length ? seal(this.vaultKey, JSON.stringify(headers), `mcp_headers:${newId}`) : null, newId);
      }
    })();
    return this.get(newId)!;
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM mcp_server WHERE id = ?').run(id);
  }

  /** 工具的有效权限 */
  permission(server: McpServerConfig, tool: string): McpPermission {
    return server.toolPolicies[tool] ?? server.defaultPermission;
  }

  /** 本机 MCP 服务的 Bearer 令牌（第一次使用时生成） */
  hostToken(reset = false): string {
    const row = this.db.prepare<[string], { value: string }>('SELECT value FROM setting WHERE key = ?').get(TOKEN_KEY);
    if (row && !reset) {
      try {
        return open(this.vaultKey, Buffer.from(JSON.parse(row.value) as string, 'base64'), TOKEN_KEY);
      } catch {
        // 损坏：重新生成
      }
    }
    const token = `itm_${randomBytes(24).toString('base64url')}`;
    const enc = JSON.stringify(seal(this.vaultKey, token, TOKEN_KEY).toString('base64'));
    this.db
      .prepare(
        `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(TOKEN_KEY, enc, this.now());
    return token;
  }

  private toConfig(r: Row): McpServerConfig {
    const s = this.secrets(r.id);
    return {
      id: r.id,
      name: r.name,
      transport: r.transport,
      command: r.command,
      args: parse<string[]>(r.args, []),
      url: r.url,
      envKeys: Object.keys(s.env),
      headerKeys: Object.keys(s.headers),
      defaultPermission: r.default_permission,
      toolPolicies: parse<Record<string, McpPermission>>(r.tool_policies, {}),
      enabled: !!r.enabled,
      updatedAt: r.updated_at,
    };
  }
}
