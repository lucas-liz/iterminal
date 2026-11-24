import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'ssh2';
import { execCommand } from '../src/main/services/connection/exec';
import { runLocal, untilStopped } from '../src/main/services/ai/agent-service';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

/** 第十四轮：Agent 执行命令——标准输入关闭、没有输出的超时、停止立即生效 */
let dir: string;
let server: TestSshServer;
let client: Client;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-r14-'));
  server = await startTestSshServer({ root: dir });
  client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => resolve()).once('error', reject);
    client.connect({ host: '127.0.0.1', port: server.port, username: 'tester', password: 'pw' });
  });
});

afterAll(async () => {
  client?.end();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const timed = async <T,>(p: Promise<T>): Promise<{ r: T; ms: number }> => {
  const t = Date.now();
  const r = await p;
  return { r, ms: Date.now() - t };
};

describe('远端命令（exec 通道）', () => {
  it('标准输入关闭：等待输入的命令马上结束，不会卡到超时', async () => {
    const { r, ms } = await timed(execCommand(client, 'read x; echo "got:[$x]"', { timeoutMs: 10_000, closeStdin: true }));
    expect(r.stdout.trim()).toBe('got:[]');
    expect(ms).toBeLessThan(3000);
  });

  it('连续没有输出就终止，并标出原因；有输出时重新计时', async () => {
    const idle = await timed(execCommand(client, 'sleep 20', { timeoutMs: 30_000, idleTimeoutMs: 500, closeStdin: true }));
    expect(idle.r).toMatchObject({ idle: true, timedOut: false });
    expect(idle.ms).toBeLessThan(3000);
    const busy = await execCommand(client, 'for i in 1 2 3 4; do echo $i; sleep 0.3; done', { timeoutMs: 10_000, idleTimeoutMs: 800, closeStdin: true });
    expect(busy).toMatchObject({ code: 0 });
    expect(busy.idle).toBeUndefined();
    expect(busy.stdout.trim().split('\n')).toEqual(['1', '2', '3', '4']);
  });

  it('停止立即返回，不等远端确认关闭', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const { r, ms } = await timed(execCommand(client, 'sleep 20', { timeoutMs: 30_000, signal: ctl.signal }));
    expect(r.aborted).toBe(true);
    expect(ms).toBeLessThan(1000);
    // 已经停止时直接返回
    expect((await execCommand(client, 'echo never', { timeoutMs: 1000, signal: ctl.signal })).aborted).toBe(true);
    // 通道照常可以继续用
    expect((await execCommand(client, 'echo ok', { timeoutMs: 5000 })).stdout.trim()).toBe('ok');
  });
});

describe('本机命令', () => {
  const env = { HOME: process.env.HOME, SHELL: process.env.SHELL };
  beforeAll(() => {
    // 不读用户自己的 shell 启动文件
    process.env.HOME = dir;
    process.env.SHELL = '/bin/sh';
  });
  afterAll(() => {
    process.env.HOME = env.HOME;
    process.env.SHELL = env.SHELL;
  });

  it('标准输入关闭；没有输出就终止；停止时连子进程一起结束并立即返回', async () => {
    const read = await timed(runLocal('read x; echo "got:[$x]"', 10_000, new AbortController().signal));
    expect(read.r.stdout.trim()).toBe('got:[]');
    expect(read.ms).toBeLessThan(3000);

    const idle = await timed(runLocal('sleep 20', 30_000, new AbortController().signal, 500));
    expect(idle.r.idle).toBe(true);
    expect(idle.ms).toBeLessThan(3500);

    // shell 里再起一个子进程：只结束 shell 的话子进程占着输出管道，要等它自己退出
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const stopped = await timed(runLocal('sleep 20 & wait', 30_000, ctl.signal));
    expect(stopped.r.aborted).toBe(true);
    expect(stopped.ms).toBeLessThan(1000);
  });
});

describe('停止时不等工具收尾', () => {
  it('工具一直不返回：停止后立即得到「用户已停止执行」', async () => {
    const ctl = new AbortController();
    const call = { id: 'c1', name: 'mcp_call', args: { server: 's' } };
    const never = new Promise<never>(() => undefined);
    setTimeout(() => ctl.abort(), 50);
    const r = await untilStopped(call, ctl.signal, never);
    expect(r).toMatchObject({ callId: 'c1', isError: true, content: '用户已停止执行' });
    // 正常返回的结果原样透传
    const ok = { callId: 'c2', name: 'x', content: 'done', isError: false, step: r.step };
    expect(await untilStopped({ ...call, id: 'c2' }, new AbortController().signal, Promise.resolve(ok))).toBe(ok);
  });
});
