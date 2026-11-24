import type { Client } from 'ssh2';

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** 退出码；被信号终止或超时为 null */
  code: number | null;
  /** 输出超过上限被截断 */
  truncated: boolean;
  timedOut: boolean;
  /** 连续 idleTimeoutMs 没有任何输出被终止（可能在等待输入，或者一直在运行） */
  idle?: boolean;
  /** 被停止（AbortSignal） */
  aborted?: boolean;
}

/**
 * 在 exec 通道上执行一条命令（不占用用户的交互 shell），收集输出直到结束或超时。
 * 超过 maxBytes 的输出丢弃，只标记 truncated。
 */
export function execCommand(
  client: Client,
  command: string,
  opts: {
    timeoutMs: number;
    maxBytes?: number;
    signal?: AbortSignal;
    /** 连续这么久没有任何输出就终止（0 / 不传 = 不检查） */
    idleTimeoutMs?: number;
    /** 打开通道后立即关闭标准输入：等待输入的命令（sudo 要密码、read、确认提示）马上结束，而不是一直等到超时 */
    closeStdin?: boolean;
  } = { timeoutMs: 30_000 },
): Promise<ExecResult> {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ stdout: '', stderr: '', code: null, truncated: false, timedOut: false, aborted: true });
      return;
    }
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      const out: Buffer[] = [];
      const errOut: Buffer[] = [];
      let size = 0;
      let truncated = false;
      let timedOut = false;
      let idle = false;
      let aborted = false;
      let code: number | null = null;
      let done = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (idleTimer) clearTimeout(idleTimer);
        if (graceTimer) clearTimeout(graceTimer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), code, truncated, timedOut, ...(idle ? { idle } : {}), ...(aborted ? { aborted } : {}) });
      };
      /**
       * 终止：先请远端结束进程（signal 请求，OpenSSH 支持），再关闭通道。命令卡住时远端可能迟迟不确认关闭，
       * 不再一直等 close：停止立即返回，超时 / 没有输出时最多再等 1 秒收尾
       */
      const kill = (immediate: boolean): void => {
        try {
          stream.signal('KILL');
        } catch {
          // 服务端不支持 signal 请求
        }
        try {
          stream.close();
        } catch {
          // 通道已经关了
        }
        if (immediate) finish();
        else graceTimer = setTimeout(finish, 1000);
      };
      const take = (target: Buffer[]) => (b: Buffer) => {
        armIdle();
        if (size >= maxBytes) {
          truncated = true;
          return;
        }
        const room = maxBytes - size;
        target.push(b.length > room ? b.subarray(0, room) : b);
        size += Math.min(b.length, room);
        if (b.length > room) truncated = true;
      };
      const armIdle = (): void => {
        if (!opts.idleTimeoutMs || done) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idle = true;
          kill(false);
        }, opts.idleTimeoutMs);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill(false);
      }, opts.timeoutMs);
      const onAbort = (): void => {
        aborted = true;
        kill(true);
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      armIdle();
      if (opts.closeStdin) stream.end();
      stream.on('data', take(out));
      stream.stderr.on('data', take(errOut));
      stream.on('exit', (c: number | null) => {
        code = typeof c === 'number' ? c : null;
      });
      stream.on('close', finish);
    });
  });
}
