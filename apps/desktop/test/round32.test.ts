/**
 * 第三十二轮：只读白名单的写用法（在 packages/approval 里测）、本机终端不能访问 iTerminal 自己的 MCP 接口、
 * 搜索词里去掉引用主机的名字和地址。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@itm/protocol';
import { DEFAULT_POLICY, createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { Masker } from '@itm/masking';
import type { AgentStep } from '@itm/protocol';
import type { ToolCall } from '@itm/agent-core';
import { ToolGateway, referencesLocalPort, type ToolContext } from '../src/main/services/ai/tool-gateway';
import { hostTerms, scrubQuery } from '../src/main/services/ai/web-search';
import type { SettingsRepo } from '../src/main/services/settings/settings-repo';

const require = createRequire(import.meta.url);
const wasm = {
  bashWasm: join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'),
  treeSitterWasm: require.resolve('web-tree-sitter/web-tree-sitter.wasm'),
};
let approval: ApprovalEngine;
beforeAll(async () => {
  approval = await createApprovalEngine(wasm);
});

describe('本机 MCP 接口的防护（第三十二轮）', () => {
  it('同时出现回环地址和端口才算（各种写法都认）', () => {
    for (const cmd of [
      'curl http://127.0.0.1:7788/mcp',
      'curl -s http://localhost:7788/mcp -d @-',
      "wget -qO- --header='Authorization: Bearer x' http://127.0.0.1:7788/mcp",
      'curl -g "http://[::1]:7788/mcp"',
      'nc 127.0.0.1 7788',
      'curl http://127.1:7788/',
      'curl http://2130706433:7788/',
      'ssh -L 7788:localhost:7788 jump',
    ])
      expect(referencesLocalPort(cmd, 7788), cmd).toBe(true);
    // 只有地址、只有端口、或者端口号只是数字的一部分：不算
    for (const cmd of ['curl http://127.0.0.1:8080/health', 'curl https://example.com:7788/x', 'curl http://127.0.0.1:17788/x', 'echo 7788', 'df -h'])
      expect(referencesLocalPort(cmd, 7788), cmd).toBe(false);
    expect(referencesLocalPort('curl http://127.0.0.1:9000/mcp', 9000)).toBe(true);
    expect(referencesLocalPort('curl http://127.0.0.1:9000/mcp', 0)).toBe(false);
  });

  it('本机终端执行访问 MCP 接口的命令：直接拒绝，不执行；服务没开时不拦', async () => {
    const steps: AgentStep[] = [];
    let ran = 0;
    const gw = (over: Partial<Settings>): ToolGateway => {
      const values = { ...DEFAULT_SETTINGS, 'ai.defaultAgentPolicy': 'AUTO', ...over } as Settings;
      return new ToolGateway({
        approval,
        hosts: {} as never, credentials: {} as never, audit: { command: () => undefined, event: () => undefined } as never,
        pool: {} as never, sessions: {} as never, monitor: {} as never, skills: {} as never, runtime: {} as never,
        settings: { get: <K extends keyof Settings>(k: K) => values[k] } as unknown as SettingsRepo,
        emit: () => undefined,
        policy: () => ({ ...DEFAULT_POLICY, allowLlmReview: false }),
        runLocal: async () => {
          ran++;
          return { stdout: 'ok', stderr: '', code: 0, truncated: false, timedOut: false };
        },
      });
    };
    const ctx = (): ToolContext => ({
      conversationId: 'c1', owner: 1, mode: 'agent',
      targets: { t1: { tabId: 'tab-1', kind: 'local', title: '本机', sessionId: null, hostId: null } },
      databases: {},
      masker: new Masker({ maskIps: false, maskPii: true }),
      signal: new AbortController().signal,
      reviewModel: null,
      ui: { add: (s) => steps.push(s), update: () => undefined, wait: async () => ({ decision: 'approve' }) },
    });
    const run = (gateway: ToolGateway, command: string): Promise<{ content: string; isError: boolean }> =>
      gateway.execute({ id: 'x1', name: 'run_command', args: { host: 't1', command, explanation: '测试' } } as ToolCall, ctx());

    // 服务开着：拒绝，而且没有执行
    const on = gw({ 'mcp.server.enabled': true, 'mcp.server.port': 7788 });
    const denied = await run(on, 'curl -s http://127.0.0.1:7788/mcp -d @-');
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('本机 MCP 接口');
    expect(steps.at(-1)).toMatchObject({ level: 'DENY', decision: 'DENY', status: 'rejected' });
    expect(ran).toBe(0);
    // 换个端口、或者服务没开：照常执行（「完全允许」的本机，只读命令本来就自动执行）
    expect((await run(on, 'curl -s http://127.0.0.1:8080/health')).isError).toBe(false);
    expect((await run(gw({ 'mcp.server.enabled': false, 'mcp.server.port': 7788 }), 'curl -s http://127.0.0.1:7788/mcp')).isError).toBe(false);
    expect(ran).toBe(2);
  });
});

describe('搜索词里去掉引用主机的名字和地址（第三十二轮）', () => {
  it('地址一律去掉；主机名只去掉带点 / 下划线 / 数字的，通用词不动', () => {
    const terms = hostTerms([
      { name: 'demo_env_10.30', address: '10.10.0.30' },
      { name: 'nginx', address: 'app.corp.example.com' },
      { name: 'web31', address: '10.0.0.5' },
    ]);
    expect(terms).toContain('demo_env_10.30');
    expect(terms).toContain('app.corp.example.com');
    expect(terms).toContain('web31');
    // 通用词不当成主机名（否则会把正常的搜索词也抹掉）
    expect(terms).not.toContain('nginx');
    // 长的排前面，先替换
    expect(terms.indexOf('app.corp.example.com')).toBeLessThan(terms.indexOf('web31'));

    expect(scrubQuery('demo_env_10.30 磁盘满了怎么查', terms)).toBe('[内部主机] 磁盘满了怎么查');
    expect(scrubQuery('app.corp.example.com 502', terms)).toBe('[内部主机] 502');
    expect(scrubQuery('nginx 502 怎么排查', terms)).toBe('nginx 502 怎么排查');
    // 内网地址和占位符照旧
    // 私网 IP 本来就会被换成 [内网地址]（比主机名的替换更早）
    expect(scrubQuery('10.0.0.5 nginx 502 HOST_IP_1', terms)).toBe('[内网地址] nginx 502 [内网地址]');
    expect(scrubQuery('nginx 502', [])).toBe('nginx 502');
  });
});
