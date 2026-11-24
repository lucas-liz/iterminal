import { createServer, type Socket } from 'node:net';

const IAC = 255;
const DO = 253;
const WILL = 251;
const SB = 250;
const SE = 240;
const TTYPE = 24;
const NAWS = 31;
const ECHO = 1;

export interface TestTelnetServer {
  port: number;
  /** 登录成功后收到的命令行 */
  lines: string[];
  /** 客户端上报的终端类型和窗口大小 */
  termTypes: string[];
  sizes: { cols: number; rows: number }[];
  logins: { username: string; password: string }[];
  close(): Promise<void>;
}

/**
 * 测试用的 Telnet 服务器：要求终端类型和窗口大小、自己回显；先问 login: 和 Password:（密码 pw），
 * 登录后显示提示符 "router> "，收到的每一行原样回显 "echo:行"。
 */
export async function startTestTelnetServer(opts: { password?: string } = {}): Promise<TestTelnetServer> {
  const password = opts.password ?? 'pw';
  const lines: string[] = [];
  const termTypes: string[] = [];
  const sizes: { cols: number; rows: number }[] = [];
  const logins: { username: string; password: string }[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => undefined);
    // 协商：要终端类型、窗口大小；服务器负责回显
    sock.write(Buffer.from([IAC, DO, TTYPE, IAC, DO, NAWS, IAC, WILL, ECHO]));
    let stage: 'user' | 'pass' | 'shell' = 'user';
    let user = '';
    let line = '';
    let state: 'data' | 'iac' | 'opt' | 'sb' | 'sb_iac' = 'data';
    let sb: number[] = [];
    let askedTtype = false;
    const handleSb = (d: number[]): void => {
      if (d[0] === TTYPE && d[1] === 0) termTypes.push(Buffer.from(d.slice(2)).toString('ascii'));
      if (d[0] === NAWS) sizes.push({ cols: (d[1] << 8) | d[2], rows: (d[3] << 8) | d[4] });
    };
    const onLine = (l: string): void => {
      if (stage === 'user') {
        user = l;
        stage = 'pass';
        sock.write('\r\nPassword: ');
      } else if (stage === 'pass') {
        logins.push({ username: user, password: l });
        if (l === password) {
          stage = 'shell';
          sock.write('\r\nWelcome to test router\r\nrouter> ');
        } else {
          stage = 'user';
          sock.write('\r\nLogin incorrect\r\nlogin: ');
        }
      } else {
        lines.push(l);
        sock.write(`\r\necho:${l}\r\nrouter> `);
      }
    };
    sock.on('data', (chunk: Buffer) => {
      for (const b of chunk) {
        if (state === 'data') {
          if (b === IAC) state = 'iac';
          else if (b === 13) {
            onLine(line);
            line = '';
          } else if (b === 0 || b === 10) {
            // CR NUL / CR LF 的第二个字节
          } else if (b === 0x7f) {
            line = line.slice(0, -1);
          } else {
            line += String.fromCharCode(b);
            // 用户名回显，密码不回显
            if (stage !== 'pass') sock.write(Buffer.from([b]));
          }
        } else if (state === 'iac') {
          if (b === SB) {
            sb = [];
            state = 'sb';
          } else if (b >= 251 && b <= 254) state = 'opt';
          else state = 'data';
        } else if (state === 'opt') {
          // 客户端同意终端类型后，请它发送
          if (b === TTYPE && !askedTtype) {
            askedTtype = true;
            sock.write(Buffer.from([IAC, SB, TTYPE, 1, IAC, SE]));
          }
          state = 'data';
        } else if (state === 'sb') {
          if (b === IAC) state = 'sb_iac';
          else sb.push(b);
        } else if (state === 'sb_iac') {
          if (b === SE) {
            handleSb(sb);
            state = 'data';
          } else {
            sb.push(b);
            state = 'sb';
          }
        }
      }
    });
    setTimeout(() => sock.write('\r\nTest Router\r\nlogin: '), 50);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    lines,
    termTypes,
    sizes,
    logins,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
