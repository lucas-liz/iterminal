import { connect, type Socket } from 'node:net';
import { UserError } from '../../util/errors';
import type { ConnectInfo } from '../hosts/host-repo';

type Proxy = NonNullable<ConnectInfo['proxy']>;

/**
 * 从 socket 里读满 n 个字节（或者读到 \r\n\r\n 为止）。读完后暂停 socket，多读到的字节退回缓冲区：
 * ssh2 接手 socket 时会先 pause 再 resume，这样目标服务器的第一批数据不会在两个监听器之间丢失。
 */
function readFrom(sock: Socket, until: number | 'headers', timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new UserError('代理响应超时')), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('close', onClose);
      sock.off('error', fail);
      sock.pause();
    };
    const finish = (end: number, skip = 0): void => {
      cleanup();
      const rest = buf.subarray(end + skip);
      if (rest.length) sock.unshift(rest);
      resolve(buf.subarray(0, end + skip));
    };
    function onData(b: Buffer): void {
      buf = Buffer.concat([buf, b]);
      if (until === 'headers') {
        const i = buf.indexOf('\r\n\r\n');
        if (i >= 0) finish(i, 4);
        else if (buf.length > 16 * 1024) fail(new UserError('代理响应过长'));
      } else if (buf.length >= until) {
        finish(until);
      }
    }
    function onClose(): void {
      fail(new UserError('代理关闭了连接'));
    }
    function fail(e: Error): void {
      cleanup();
      reject(e);
    }
    sock.on('data', onData);
    sock.once('close', onClose);
    sock.once('error', fail);
    sock.resume();
  });
}

const SOCKS_ERRORS: Record<number, string> = {
  1: '代理服务器内部错误',
  2: '代理规则不允许连接',
  3: '网络不可达',
  4: '主机不可达',
  5: '目标拒绝连接',
  6: 'TTL 过期',
  7: '代理不支持这个命令',
  8: '代理不支持这种地址类型',
};

async function socks5(sock: Socket, p: Proxy, host: string, port: number, timeoutMs: number): Promise<void> {
  const withAuth = !!p.username;
  sock.write(Buffer.from(withAuth ? [5, 2, 0, 2] : [5, 1, 0]));
  const choice = await readFrom(sock, 2, timeoutMs);
  if (choice[0] !== 5) throw new UserError('代理不是 SOCKS5 服务器');
  if (choice[1] === 2) {
    const u = Buffer.from(p.username ?? '', 'utf8');
    const pw = Buffer.from(p.password ?? '', 'utf8');
    if (u.length > 255 || pw.length > 255) throw new UserError('代理用户名或密码太长');
    sock.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([pw.length]), pw]));
    const r = await readFrom(sock, 2, timeoutMs);
    if (r[1] !== 0) throw new UserError('代理认证失败：用户名或密码不正确');
  } else if (choice[1] !== 0) {
    throw new UserError(withAuth ? '代理不接受用户名密码认证' : '代理要求认证，请填写代理用户名和密码');
  }
  const h = Buffer.from(host, 'utf8');
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, portBuf]));
  const head = await readFrom(sock, 4, timeoutMs);
  if (head[1] !== 0) throw new UserError(`代理无法连接 ${host}:${port}：${SOCKS_ERRORS[head[1]] ?? `错误 ${head[1]}`}`);
  const addrLen = head[3] === 1 ? 4 : head[3] === 4 ? 16 : (await readFrom(sock, 1, timeoutMs))[0];
  await readFrom(sock, addrLen + 2, timeoutMs);
}

async function httpConnect(sock: Socket, p: Proxy, host: string, port: number, timeoutMs: number): Promise<void> {
  const target = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${p.username}:${p.password ?? ''}`).toString('base64')}\r\n` : '';
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
  const head = (await readFrom(sock, 'headers', timeoutMs)).toString('latin1');
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (status === '407') throw new UserError('代理认证失败：用户名或密码不正确');
  if (status !== '200') throw new UserError(`代理无法连接 ${target}（${head.split('\r\n')[0] || '无响应'}）`);
}

/** 通过 SOCKS5 / HTTP CONNECT 代理建立到目标的 TCP 连接（文档一 6.2） */
export function connectViaProxy(p: Proxy, host: string, port: number, timeoutMs = 20_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host: p.host, port: p.port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new UserError(`连接代理 ${p.host}:${p.port} 超时`));
    }, timeoutMs);
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(new UserError(`无法连接代理 ${p.host}:${p.port}：${(e as NodeJS.ErrnoException).code ?? e.message}`));
    });
    sock.once('connect', () => {
      clearTimeout(timer);
      const handshake = p.type === 'SOCKS5' ? socks5(sock, p, host, port, timeoutMs) : httpConnect(sock, p, host, port, timeoutMs);
      handshake.then(
        () => {
          sock.removeAllListeners('error');
          resolve(sock);
        },
        (e) => {
          sock.destroy();
          reject(e);
        },
      );
    });
  });
}
