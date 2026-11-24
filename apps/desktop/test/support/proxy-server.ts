import { createServer, connect, type AddressInfo, type Socket } from 'node:net';

export interface TestProxy {
  port: number;
  /** 经过代理建立的目标（host:port） */
  targets: string[];
  close(): Promise<void>;
}

function pipe(client: Socket, host: string, port: number, onReady: (upstream: Socket) => void, onFail: () => void): void {
  const upstream = connect(port, host);
  upstream.once('error', onFail);
  upstream.once('connect', () => {
    upstream.removeListener('error', onFail);
    onReady(upstream);
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
  });
}

/** 测试用 SOCKS5 代理（RFC 1928 / 1929），auth 不为空时要求用户名密码 */
export async function startSocks5(auth?: { username: string; password: string }): Promise<TestProxy> {
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    let buf = Buffer.alloc(0);
    let stage: 'greet' | 'auth' | 'request' = 'greet';
    const onData = (b: Buffer): void => {
      buf = Buffer.concat([buf, b]);
      if (stage === 'greet' && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (auth) {
          if (!methods.includes(2)) return void c.end(Buffer.from([5, 0xff]));
          c.write(Buffer.from([5, 2]));
          stage = 'auth';
        } else {
          c.write(Buffer.from([5, 0]));
          stage = 'request';
        }
      }
      if (stage === 'auth' && buf.length >= 2) {
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const u = buf.subarray(2, 2 + ulen).toString();
        const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        if (u !== auth!.username || p !== auth!.password) return void c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        stage = 'request';
      }
      if (stage === 'request' && buf.length >= 5 && buf[3] === 3 && buf.length >= 7 + buf[4]) {
        const host = buf.subarray(5, 5 + buf[4]).toString();
        const port = buf.readUInt16BE(5 + buf[4]);
        c.off('data', onData);
        targets.push(`${host}:${port}`);
        pipe(
          c,
          host,
          port,
          () => c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])),
          () => c.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])),
        );
      }
    };
    c.on('data', onData);
    c.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    targets,
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}

/** 测试用 HTTP CONNECT 代理 */
export async function startHttpProxy(auth?: { username: string; password: string }): Promise<TestProxy> {
  const targets: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((c) => {
    sockets.add(c);
    c.on('close', () => sockets.delete(c));
    let buf = '';
    const onData = (b: Buffer): void => {
      buf += b.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      c.off('data', onData);
      const head = buf.slice(0, i);
      const m = /^CONNECT ([^:\s]+):(\d+) HTTP/.exec(head);
      if (!m) return void c.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      if (auth) {
        const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
        if (!head.includes(`Proxy-Authorization: ${expected}`)) return void c.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      }
      targets.push(`${m[1]}:${m[2]}`);
      pipe(
        c,
        m[1],
        Number(m[2]),
        () => c.write('HTTP/1.1 200 Connection established\r\n\r\n'),
        () => c.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'),
      );
    };
    c.on('data', onData);
    c.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    targets,
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}
