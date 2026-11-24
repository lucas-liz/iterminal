import { connect } from 'node:net';
import type { HostPing } from '@itm/protocol';

/** 主机列表的延迟（第十二轮）：TCP 三次握手的耗时，不做 SSH 握手、不认证 */
export function tcpPing(host: string, port: number, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const sock = connect({ host, port });
    const done = (err: Error | null): void => {
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.on('error', () => undefined);
      sock.destroy();
      if (err) reject(err);
      else resolve(Math.max(1, Math.round(Number(process.hrtime.bigint() - started) / 1e6)));
    };
    const timer = setTimeout(() => done(new Error('超时')), timeoutMs);
    sock.once('connect', () => done(null));
    sock.once('error', (e: NodeJS.ErrnoException) => done(new Error(PING_ERRORS[e.code ?? ''] ?? e.message)));
  });
}

const PING_ERRORS: Record<string, string> = {
  ECONNREFUSED: '连接被拒绝',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ENOTFOUND: '域名解析失败',
  EAI_AGAIN: '域名解析失败',
  ETIMEDOUT: '超时',
  ECONNRESET: '连接被重置',
};

export interface PingTarget {
  id: string;
  address: string;
  port: number;
  /** 不直接测量的原因（经跳板机、代理、串口） */
  skipped: HostPing['skipped'];
}

/** 并发测一批主机（默认同时 16 个） */
export async function pingHosts(targets: PingTarget[], opts: { concurrency?: number; timeoutMs?: number; ping?: typeof tcpPing } = {}): Promise<HostPing[]> {
  const ping = opts.ping ?? tcpPing;
  const out: HostPing[] = new Array(targets.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < targets.length) {
      const i = next++;
      const t = targets[i];
      if (t.skipped) {
        out[i] = { id: t.id, ms: null, error: null, skipped: t.skipped };
        continue;
      }
      try {
        out[i] = { id: t.id, ms: await ping(t.address, t.port, opts.timeoutMs ?? 3000), error: null, skipped: null };
      } catch (e) {
        out[i] = { id: t.id, ms: null, error: (e as Error).message, skipped: null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 16, targets.length) }, worker));
  return out;
}
