import { createServer, type Server, type Socket } from 'node:net';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join, posix } from 'node:path';

export interface TestFtpServer {
  port: number;
  /** 收到的命令（PASS 的参数替换成 ***） */
  commands: string[];
  close(): Promise<void>;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 测试用的极简 FTP 服务器（只用于单元测试）：被动模式（EPSV / PASV）、二进制传输，
 * 支持 LIST、RETR（含 REST 续传）、STOR、APPE、SIZE、MDTM、MKD、RMD、DELE、RNFR / RNTO；
 * 不支持 AUTH TLS（回复 502，用来测试「先试 TLS、不支持时退回明文」）。
 */
export async function startTestFtpServer(opts: { root: string; user: string; password: string }): Promise<TestFtpServer> {
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((ctl) => {
    sockets.add(ctl);
    ctl.on('close', () => sockets.delete(ctl));
    ctl.on('error', () => undefined);
    let cwd = '/';
    let user = '';
    let authed = false;
    let rest = 0;
    let renameFrom: string | null = null;
    let data: Promise<Socket> | null = null;
    const reply = (s: string): void => void ctl.write(`${s}\r\n`);
    const virt = (p: string): string => posix.normalize(p.startsWith('/') ? p : posix.join(cwd, p || '.'));
    const real = (p: string): string => join(opts.root, virt(p));
    const passive = (): Promise<number> =>
      new Promise((resolve) => {
        const ds = createServer();
        data = new Promise<Socket>((res) =>
          ds.once('connection', (s) => {
            sockets.add(s);
            s.on('close', () => sockets.delete(s));
            ds.close();
            res(s);
          }),
        );
        ds.listen(0, '127.0.0.1', () => resolve((ds.address() as { port: number }).port));
      });
    const withData = async (fn: (s: Socket) => Promise<void>): Promise<void> => {
      if (!data) return reply('425 Use PASV first');
      const p = data;
      data = null;
      reply('150 Opening data connection');
      const s = await p;
      await fn(s);
      reply('226 Transfer complete');
    };
    const line = (st: Stats, name: string): string => {
      const d = st.mtime;
      const mode = (st.isDirectory() ? 'd' : '-') + 'rwxr-xr-x';
      return `${mode} 1 ftp ftp ${String(st.size).padStart(10)} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${name}`;
    };

    reply('220 iTerminal test FTP');
    let buf = '';
    ctl.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const sp = raw.indexOf(' ');
        const cmd = (sp < 0 ? raw : raw.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? '' : raw.slice(sp + 1);
        commands.push(cmd === 'PASS' ? 'PASS ***' : raw);
        void handle(cmd, arg).catch((e: Error) => reply(`550 ${e.message}`));
      }
    });

    async function handle(cmd: string, arg: string): Promise<void> {
      if (cmd === 'USER') {
        user = arg;
        return reply('331 Password required');
      }
      if (cmd === 'PASS') {
        authed = user === opts.user && arg === opts.password;
        return reply(authed ? '230 Logged in' : '530 Login incorrect');
      }
      if (cmd === 'AUTH') return reply('502 TLS not supported');
      if (cmd === 'QUIT') {
        reply('221 Bye');
        ctl.end();
        return;
      }
      if (!authed) return reply('530 Please login');
      switch (cmd) {
        case 'FEAT':
          return reply('211-Features:\r\n EPSV\r\n PASV\r\n SIZE\r\n MDTM\r\n REST STREAM\r\n UTF8\r\n211 End');
        case 'OPTS':
        case 'TYPE':
        case 'NOOP':
        case 'PBSZ':
        case 'PROT':
          return reply('200 OK');
        case 'SYST':
          return reply('215 UNIX Type: L8');
        case 'PWD':
          return reply(`257 "${cwd}" is current directory`);
        case 'CWD': {
          const target = virt(arg);
          if (!existsSync(join(opts.root, target)) || !statSync(join(opts.root, target)).isDirectory()) return reply('550 No such directory');
          cwd = target;
          return reply('250 OK');
        }
        case 'CDUP':
          cwd = posix.dirname(cwd);
          return reply('250 OK');
        case 'EPSV': {
          const port = await passive();
          return reply(`229 Entering Extended Passive Mode (|||${port}|)`);
        }
        case 'PASV': {
          const port = await passive();
          return reply(`227 Entering Passive Mode (127,0,0,1,${port >> 8},${port & 255})`);
        }
        case 'LIST': {
          const path = arg.replace(/^-a\s*/, '');
          const dir = real(path);
          if (!existsSync(dir)) return reply('550 No such directory');
          return withData(async (s) => {
            const lines = statSync(dir).isDirectory() ? readdirSync(dir).map((n) => line(statSync(join(dir, n)), n)) : [line(statSync(dir), posix.basename(path))];
            await new Promise<void>((r) => s.end(lines.map((l) => `${l}\r\n`).join(''), () => r()));
          });
        }
        case 'REST':
          rest = Number(arg) || 0;
          return reply(`350 Restarting at ${rest}`);
        case 'RETR': {
          const file = real(arg);
          if (!existsSync(file)) return reply('550 No such file');
          const start = rest;
          rest = 0;
          return withData(
            (s) =>
              new Promise<void>((r) => {
                const rs = createReadStream(file, { start });
                rs.pipe(s);
                s.on('close', () => r());
              }),
          );
        }
        case 'STOR':
        case 'APPE': {
          const file = real(arg);
          // 同步清空（异步打开会在数据写入之后才截断文件）
          if (cmd === 'STOR') writeFileSync(file, '');
          return withData(
            (s) =>
              new Promise<void>((r) => {
                s.on('data', (c: Buffer) => appendFileSync(file, c));
                s.on('end', () => r());
              }),
          );
        }
        case 'SIZE': {
          const file = real(arg);
          if (!existsSync(file) || statSync(file).isDirectory()) return reply('550 No such file');
          return reply(`213 ${statSync(file).size}`);
        }
        case 'MDTM': {
          const file = real(arg);
          if (!existsSync(file)) return reply('550 No such file');
          const d = statSync(file).mtime;
          const p = (n: number): string => String(n).padStart(2, '0');
          return reply(`213 ${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`);
        }
        case 'MKD':
          mkdirSync(real(arg));
          return reply(`257 "${virt(arg)}" created`);
        case 'RMD':
          rmdirSync(real(arg));
          return reply('250 Removed');
        case 'DELE':
          if (!existsSync(real(arg))) return reply('550 No such file');
          unlinkSync(real(arg));
          return reply('250 Deleted');
        case 'RNFR':
          if (!existsSync(real(arg))) return reply('550 No such file');
          renameFrom = real(arg);
          return reply('350 Ready for RNTO');
        case 'RNTO':
          if (!renameFrom) return reply('503 RNFR first');
          renameSync(renameFrom, real(arg));
          renameFrom = null;
          return reply('250 Renamed');
        default:
          return reply('502 Not implemented');
      }
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as { port: number }).port,
    commands,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
