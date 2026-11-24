import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerConfig, McpServerStatus, McpToolInfo } from '@itm/protocol';
import { UserError } from '../../util/errors';
import type { McpRepo } from './mcp-repo';

const CONNECT_TIMEOUT = 20_000;
const CALL_TIMEOUT = 120_000;
/** 返回给模型的工具结果上限 */
const MAX_RESULT = 64 * 1024;

interface Conn {
  client: Client | null;
  transport: Transport | null;
  status: McpServerStatus;
  /** 配置变化后需要重连 */
  updatedAt: number;
  connecting: Promise<Client> | null;
}

/** 把 MCP 工具返回的 content 转成文字（图片、二进制只标注类型） */
export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : JSON.stringify(content ?? '');
  return content
    .map((c: { type?: string; text?: string; resource?: { uri?: string; text?: string }; mimeType?: string }) => {
      if (c.type === 'text') return c.text ?? '';
      if (c.type === 'resource') return c.resource?.text ?? `[资源 ${c.resource?.uri ?? ''}]`;
      if (c.type === 'image') return `[图片 ${c.mimeType ?? ''}]`;
      if (c.type === 'audio') return `[音频 ${c.mimeType ?? ''}]`;
      if (c.type === 'resource_link') return `[资源链接 ${(c as { uri?: string }).uri ?? ''}]`;
      return JSON.stringify(c);
    })
    .join('\n');
}

/**
 * MCP Client（文档一 6.8）：按需连接配置的 MCP Server（stdio 启动子进程 / SSE / Streamable HTTP），缓存工具列表。
 * 配置修改或删除后断开，下次使用时按新配置重连。
 */
export class McpClientManager {
  private readonly conns = new Map<string, Conn>();

  constructor(
    private readonly repo: McpRepo,
    private readonly clientVersion = '0.4.0',
  ) {}

  status(id: string): McpServerStatus {
    return this.conns.get(id)?.status ?? { id, state: 'idle', message: null, tools: [] };
  }

  /** 连接（如果还没连）并返回工具列表 */
  async tools(id: string, refresh = false): Promise<McpToolInfo[]> {
    const cfg = this.repo.get(id);
    if (!cfg) throw new UserError('MCP Server 不存在');
    const client = await this.client(cfg);
    const conn = this.conns.get(id)!;
    if (refresh || conn.status.tools.length === 0) {
      const r = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT });
      conn.status = {
        id,
        state: 'connected',
        message: null,
        tools: r.tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: (t.inputSchema ?? {}) as Record<string, unknown> })),
      };
    }
    return conn.status.tools;
  }

  async test(id: string): Promise<McpServerStatus> {
    this.disconnect(id);
    try {
      await this.tools(id, true);
    } catch (e) {
      // 状态里已经记下错误
      if (!this.conns.get(id)) return { id, state: 'error', message: (e as Error).message, tools: [] };
    }
    return this.status(id);
  }

  async call(id: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ content: string; isError: boolean }> {
    const cfg = this.repo.get(id);
    if (!cfg) throw new UserError('MCP Server 不存在');
    const client = await this.client(cfg);
    const r = await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT });
    const text = 'content' in r ? contentToText(r.content) : JSON.stringify((r as { toolResult?: unknown }).toolResult ?? '');
    return { content: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n…（已截断）` : text, isError: !!(r as { isError?: boolean }).isError };
  }

  disconnect(id: string): void {
    const c = this.conns.get(id);
    if (!c) return;
    this.conns.delete(id);
    void c.client?.close().catch(() => undefined);
  }

  closeAll(): void {
    for (const id of [...this.conns.keys()]) this.disconnect(id);
  }

  private async client(cfg: McpServerConfig): Promise<Client> {
    if (!cfg.enabled) throw new UserError(`MCP Server「${cfg.name}」已停用`);
    let conn = this.conns.get(cfg.id);
    if (conn && conn.updatedAt !== cfg.updatedAt) {
      this.disconnect(cfg.id);
      conn = undefined;
    }
    if (conn?.client && conn.status.state === 'connected') return conn.client;
    if (conn?.connecting) return conn.connecting;
    const c: Conn = conn ?? { client: null, transport: null, status: { id: cfg.id, state: 'connecting', message: null, tools: [] }, updatedAt: cfg.updatedAt, connecting: null };
    c.status = { ...c.status, state: 'connecting', message: null };
    this.conns.set(cfg.id, c);
    c.connecting = (async () => {
      const transport = this.transport(cfg);
      const client = new Client({ name: 'iTerminal', version: this.clientVersion }, { capabilities: {} });
      transport.onclose = () => {
        if (this.conns.get(cfg.id) === c && c.status.state === 'connected') c.status = { ...c.status, state: 'error', message: '连接已断开' };
      };
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise((_r, rej) => {
            timer = setTimeout(() => rej(new Error(`连接超时（${CONNECT_TIMEOUT / 1000} 秒）`)), CONNECT_TIMEOUT);
          }),
        ]);
      } catch (e) {
        void client.close().catch(() => undefined);
        c.status = { ...c.status, state: 'error', message: `连接 ${cfg.name} 失败：${(e as Error).message}` };
        throw new UserError(c.status.message!);
      } finally {
        clearTimeout(timer);
        c.connecting = null;
      }
      c.client = client;
      c.transport = transport;
      c.status = { ...c.status, state: 'connected', message: null };
      return client;
    })();
    return c.connecting;
  }

  private transport(cfg: McpServerConfig): Transport {
    const s = this.repo.secrets(cfg.id);
    if (cfg.transport === 'STDIO') {
      return new StdioClientTransport({ command: cfg.command!, args: cfg.args, env: { ...getDefaultEnvironment(), ...s.env }, stderr: 'ignore' });
    }
    const url = new URL(cfg.url!);
    const requestInit = { headers: s.headers };
    return cfg.transport === 'SSE' ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
  }
}
