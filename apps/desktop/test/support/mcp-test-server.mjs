// 测试用的 stdio MCP Server：echo（原样返回）、add（两数相加）、fail（返回错误）、env（返回环境变量 MCP_TOKEN）
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'itm-test', version: '1.0.0' });
server.registerTool('echo', { description: '原样返回文字', inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));
server.registerTool('add', { description: '两数相加', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }));
server.registerTool('fail', { description: '总是失败' }, async () => ({ content: [{ type: 'text', text: '出错了' }], isError: true }));
server.registerTool('env', { description: '读取环境变量 MCP_TOKEN' }, async () => ({ content: [{ type: 'text', text: process.env.MCP_TOKEN ?? '(none)' }] }));
await server.connect(new StdioServerTransport());
