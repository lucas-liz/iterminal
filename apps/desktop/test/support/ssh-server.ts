import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, statSync, lstatSync, unlinkSync, writeSync, fchmodSync, type Stats as FsStats } from 'node:fs';
import { join, posix } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect as tcpConnect, createServer as createNetServer, type AddressInfo, type Server as NetServer, type Socket } from 'node:net';
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateEd25519 } from './keys';
import { Server, utils, type Connection, type ParsedKey, type SFTPWrapper, type Attributes, type ServerChannel } from 'ssh2';

const { STATUS_CODE } = utils.sftp;

export interface TestSshServerOptions {
  /** SFTP 根目录（客户端看到的 /） */
  root: string;
  username?: string;
  password?: string;
  /** 允许登录的公钥（OpenSSH 公钥格式，例如 ssh-ed25519 AAAA...） */
  authorizedPublicKey?: string;
  /** 每次 SFTP WRITE 人为延迟（毫秒），用于测试取消传输 */
  writeDelayMs?: number;
  /** 指定主机密钥（测试指纹变化时换一把） */
  hostKey?: string;
  /** 允许作为跳板机：接受 direct-tcpip 转发 */
  allowForward?: boolean;
  /**
   * 跳板机不回 CHANNEL_CLOSE（模拟 OpenSSH 跳板机到已宕目标的 TCP 还没超时、通道迟迟关不掉）：
   * 配合 dropForwards，客户端只收到 EOF、收不到 close
   */
  stallForwardClose?: boolean;
  /**
   * 收到监控采集脚本时，按 Linux /proc 的格式每 500ms 返回一块模拟数据（测试机不是 Linux）。
   * cwd 为交互 shell 的当前目录（右侧文件面板跟随它）。
   */
  fakeLinuxMonitor?: { cwd: string };
  /** 公钥认证时额外接受 {root}/.ssh/authorized_keys 里的公钥（测试部署公钥、密钥轮换） */
  authorizedKeysFromHome?: boolean;
  /** SFTP 直接使用真实路径（不映射到 root 下），和 exec 看到的文件系统一致（测试 Agent 的 sftp_write + 备份） */
  sftpRealPaths?: boolean;
  /** 不提供 SFTP 子系统（模拟服务器没有启用 SFTP） */
  noSftp?: boolean;
  /** exec 时提供 GNU 风格的 stat -c（macOS 自带的是 BSD stat；用来测试 SSH 命令通道） */
  gnuStat?: boolean;
  /** 只允许 keyboard-interactive：第一轮要密码，第二轮要 TOTP 验证码（测试两步验证的堡垒机） */
  kbdOtp?: { totp: () => string };
}

export interface TestSshServer {
  port: number;
  /** 已建立的 TCP 连接数（验证连接复用） */
  connections: number;
  /** shell 里收到的每一行输入（E2E 用来确认终端输入确实送达） */
  lines: string[];
  /** 经过本服务器转发的目标（host:port） */
  forwards: string[];
  /** 远程端口转发时服务器监听的端口 */
  remoteForwards: number[];
  /** 收到的 exec 命令 */
  execs: string[];
  hostKey: string;
  /** 断掉所有转发的目标连接（模拟目标机重启）：通道上发 EOF，stallForwardClose 时不发 CHANNEL_CLOSE */
  dropForwards(): void;
  close(): Promise<void>;
}

function attrsOf(st: FsStats): Attributes {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function statusFor(e: unknown): number {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return STATUS_CODE.NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

/**
 * 测试用 SSH 服务器：密码 / 公钥认证；shell 先输出 welcome，再回显输入，输入 exit 关闭；
 * SFTP 子系统把客户端路径映射到 root 目录下。
 */
export async function startTestSshServer(opts: TestSshServerOptions): Promise<TestSshServer> {
  const username = opts.username ?? 'tester';
  const password = opts.password ?? 'pw';
  const hostKey = opts.hostKey ?? generateEd25519().private;
  const allowedKey = opts.authorizedPublicKey ? (utils.parseKey(opts.authorizedPublicKey) as ParsedKey) : null;
  const state = { connections: 0, lines: [] as string[], forwards: [] as string[], execs: [] as string[], remoteForwards: [] as number[] };
  const shimDir = opts.gnuStat && process.platform === 'darwin' ? gnuStatShim() : null;

  const clients = new Set<Connection>();
  const forwarded = new Set<{ ch: ServerChannel; sock: Socket }>();
  const server = new Server({ hostKeys: [hostKey] }, (client: Connection) => {
    state.connections++;
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('authentication', (ctx) => {
      if (ctx.username !== username) {
        ctx.reject();
        return;
      }
      if (opts.kbdOtp) {
        if (ctx.method !== 'keyboard-interactive') {
          ctx.reject(['keyboard-interactive']);
          return;
        }
        ctx.prompt([{ prompt: 'Password: ', echo: false }], (a1) => {
          if (a1[0] !== password) {
            ctx.reject(['keyboard-interactive']);
            return;
          }
          ctx.prompt([{ prompt: 'Verification code: ', echo: true }], (a2) => (a2[0] === opts.kbdOtp!.totp() ? ctx.accept() : ctx.reject(['keyboard-interactive'])));
        });
        return;
      }
      if (ctx.method === 'password' && ctx.password === password) {
        ctx.accept();
        return;
      }
      if (ctx.method === 'publickey') {
        const candidates: ParsedKey[] = allowedKey ? [allowedKey] : [];
        const file = join(opts.root, '.ssh', 'authorized_keys');
        if (opts.authorizedKeysFromHome && existsSync(file)) {
          for (const line of readFileSync(file, 'utf8').split('\n')) {
            const k = line.trim() ? utils.parseKey(line.trim()) : null;
            if (k && !(k instanceof Error)) candidates.push(Array.isArray(k) ? k[0] : k);
          }
        }
        for (const key of candidates) {
          if (ctx.key.algo !== key.type) continue;
          const pub = key.getPublicSSH();
          if (ctx.key.data.length === pub.length && timingSafeEqual(ctx.key.data, pub)) {
            if (!ctx.signature || key.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true) {
              ctx.accept();
              return;
            }
          }
        }
      }
      ctx.reject(['password', 'publickey']);
    });
    client.on('error', () => undefined);
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        if (!opts.allowForward) {
          reject();
          return;
        }
        state.forwards.push(`${info.destIP}:${info.destPort}`);
        const sock = tcpConnect(info.destPort, info.destIP);
        sock.once('error', () => reject());
        sock.once('connect', () => {
          const ch = accept();
          if (opts.stallForwardClose) ch.close = () => undefined;
          const f = { ch, sock };
          forwarded.add(f);
          ch.pipe(sock).pipe(ch);
          ch.on('close', () => sock.destroy());
          sock.on('close', () => {
            forwarded.delete(f);
            ch.close();
          });
        });
      });
      // 远程端口转发（ssh -R）：服务器替客户端监听端口，有连接时开 forwarded-tcpip 通道回客户端
      const remoteServers = new Map<string, NetServer>();
      client.on('request', (accept, reject, name, info) => {
        const key = `${info.bindAddr}:${info.bindPort}`;
        if (name === 'tcpip-forward' && opts.allowForward) {
          const srv = createNetServer((sock) => {
            client.forwardOut(info.bindAddr, (srv.address() as { port: number }).port, sock.remoteAddress ?? '127.0.0.1', sock.remotePort ?? 0, (err, ch) => {
              if (err) return void sock.destroy();
              ch.pipe(sock).pipe(ch);
              ch.on('close', () => sock.destroy());
              sock.on('close', () => ch.close());
            });
          });
          srv.listen(info.bindPort, '127.0.0.1', () => {
            const port = (srv.address() as { port: number }).port;
            remoteServers.set(`${info.bindAddr}:${port}`, srv);
            state.remoteForwards.push(port);
            accept?.(port);
          });
          srv.on('error', () => reject?.());
        } else if (name === 'cancel-tcpip-forward') {
          remoteServers.get(key)?.close();
          remoteServers.delete(key);
          accept?.();
        } else {
          reject?.();
        }
      });
      client.on('close', () => remoteServers.forEach((s) => s.close()));
      client.on('session', (accept) => {
        const session = accept();
        let size = { cols: 80, rows: 24 };
        session.on('pty', (acc, _rej, info) => {
          size = { cols: info.cols, rows: info.rows };
          acc?.();
        });
        session.on('window-change', (acc, _rej, info) => {
          size = { cols: info.cols, rows: info.rows };
          acc?.();
        });
        session.on('shell', (acc) => {
          const stream = acc();
          stream.write('welcome to test server\r\n$ ');
          let line = '';
          let esc = '';
          stream.on('data', (d: Buffer) => {
            for (const ch of d.toString('utf8')) {
              // 方向键等转义序列：照样回显（光标跟着移动），不算进这一行
              if (esc || ch === '\x1b') {
                esc += ch;
                stream.write(ch);
                if (esc.length > 2 && /[A-Za-z~]/.test(ch)) esc = '';
                continue;
              }
              if (ch === '\r') {
                state.lines.push(line);
                if (line === 'exit') {
                  stream.exit(0);
                  stream.end();
                  return;
                }
                const reply = line === 'size' ? `${size.cols}x${size.rows}` : `echo:${line}`;
                stream.write(`\r\n${reply}\r\n$ `);
                line = '';
              } else if (ch === '\x7f' || ch === '\x17' || ch === '\x15') {
                // 像 readline 一样：退格删一个字符，Ctrl+W 删一个词，Ctrl+U 清空整行（回显 \b \b 擦掉）
                const keep = ch === '\x7f' ? [...line].slice(0, -1).join('') : ch === '\x17' ? line.replace(/\S*\s*$/, '') : '';
                stream.write('\b \b'.repeat([...line].length - [...keep].length));
                line = keep;
              } else if (ch === '\t') {
                // Tab 补全命令名（只认识几个）
                const m = /^(\S+)$/.exec(line);
                const hit = m && ['docker', 'systemctl'].find((w) => w.startsWith(m[1]) && w !== m[1]);
                if (hit) {
                  const add = `${hit.slice(line.length)} `;
                  line += add;
                  stream.write(add);
                }
              } else {
                line += ch;
                stream.write(ch);
              }
            }
          });
        });
        session.on('sftp', (acc, rej) => (opts.noSftp ? rej() : serveSftp(acc(), opts.sftpRealPaths ? '/' : opts.root, opts.writeDelayMs ?? 0)));
        // exec：在本机用 /bin/sh 执行（工作目录为 root），用于监控和 Agent 的命令执行测试
        session.on('exec', (acc, _rej, info) => {
          const stream = acc();
          if (opts.fakeLinuxMonitor && info.command.includes('@@BEGIN')) {
            let tick = 0;
            const send = (): void => {
              tick++;
              stream.write(fakeMonitorBlock(tick, opts.fakeLinuxMonitor!.cwd));
            };
            send();
            const timer = setInterval(send, 500);
            stream.on('close', () => clearInterval(timer));
            return;
          }
          // 监控详情命令（ps --sort、ss 等在 macOS 上没有）：返回模拟的 Linux 输出
          const detail = opts.fakeLinuxMonitor ? /@@ITM-DETAIL (\w+)/.exec(info.command)?.[1] : undefined;
          if (detail) {
            state.execs.push(info.command);
            stream.write(fakeMonitorDetail(detail, info.command));
            stream.exit(0);
            stream.end();
            return;
          }
          state.execs.push(info.command);
          // HOME 指向测试目录：部署公钥等命令绝不能改到开发者自己的 ~/.ssh
          const env = { ...process.env, HOME: opts.root, ...(shimDir ? { PATH: `${shimDir}:${process.env.PATH ?? ''}` } : {}) };
          const child = spawn('/bin/sh', ['-c', info.command], { cwd: opts.root, env });
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          // 客户端写进 exec 通道的数据交给命令的标准输入（和真实的 sshd 一样），客户端 EOF 时关闭标准输入
          stream.pipe(child.stdin);
          child.stdin.on('error', () => undefined);
          stream.on('close', () => child.kill());
          child.on('close', (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
        });
      });
    });
  });

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    hostKey,
    get connections() {
      return state.connections;
    },
    lines: state.lines,
    forwards: state.forwards,
    remoteForwards: state.remoteForwards,
    execs: state.execs,
    dropForwards: () => {
      for (const { ch, sock } of [...forwarded]) {
        sock.unpipe(ch);
        ch.unpipe(sock);
        ch.end();
        sock.destroy();
      }
    },
    // 主动断开还连着的客户端，否则 server.close 会一直等下去
    close: () =>
      new Promise<void>((res) => {
        clients.forEach((c) => c.end());
        server.close(() => res());
      }),
  };
}

function serveSftp(sftp: SFTPWrapper, root: string, writeDelayMs: number): void {
  const handles = new Map<number, { fd?: number; dir?: string; listed?: boolean }>();
  let nextHandle = 1;
  const local = (p: string): string => join(root, posix.normalize('/' + p));
  const newHandle = (h: { fd?: number; dir?: string }): Buffer => {
    const id = nextHandle++;
    handles.set(id, h);
    const b = Buffer.alloc(4);
    b.writeUInt32BE(id);
    return b;
  };
  const getHandle = (b: Buffer) => handles.get(b.readUInt32BE(0));
  const guard = (reqid: number, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      sftp.status(reqid, statusFor(e));
    }
  };

  sftp.on('REALPATH', (reqid, p) => {
    const resolved = posix.normalize('/' + (p === '.' ? '' : p));
    sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }]);
  });
  sftp.on('STAT', (reqid, p) => guard(reqid, () => sftp.attrs(reqid, attrsOf(statSync(local(p))))));
  sftp.on('LSTAT', (reqid, p) => guard(reqid, () => sftp.attrs(reqid, attrsOf(lstatSync(local(p))))));
  sftp.on('OPENDIR', (reqid, p) =>
    guard(reqid, () => {
      if (!statSync(local(p)).isDirectory()) {
        throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' });
      }
      sftp.handle(reqid, newHandle({ dir: local(p) }));
    }),
  );
  sftp.on('READDIR', (reqid, handle) =>
    guard(reqid, () => {
      const h = getHandle(handle);
      if (!h?.dir) {
        sftp.status(reqid, STATUS_CODE.FAILURE);
        return;
      }
      if (h.listed) {
        sftp.status(reqid, STATUS_CODE.EOF);
        return;
      }
      h.listed = true;
      const names = readdirSync(h.dir).map((filename) => {
        const st = lstatSync(join(h.dir!, filename));
        return { filename, longname: filename, attrs: attrsOf(st) };
      });
      sftp.name(reqid, names);
    }),
  );
  sftp.on('OPEN', (reqid, p, flags) =>
    guard(reqid, () => {
      const mode = utils.sftp.flagsToString(flags) ?? 'r';
      sftp.handle(reqid, newHandle({ fd: openSync(local(p), mode) }));
    }),
  );
  sftp.on('READ', (reqid, handle, offset, length) =>
    guard(reqid, () => {
      const h = getHandle(handle);
      const buf = Buffer.alloc(length);
      const n = readSync(h!.fd!, buf, 0, length, offset);
      if (n === 0) {
        sftp.status(reqid, STATUS_CODE.EOF);
      } else {
        sftp.data(reqid, buf.subarray(0, n));
      }
    }),
  );
  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const run = (): void =>
      guard(reqid, () => {
        const h = getHandle(handle);
        if (h?.fd === undefined) {
          sftp.status(reqid, STATUS_CODE.FAILURE);
          return;
        }
        writeSync(h.fd, data, 0, data.length, offset);
        sftp.status(reqid, STATUS_CODE.OK);
      });
    if (writeDelayMs > 0) {
      setTimeout(run, writeDelayMs);
    } else {
      run();
    }
  });
  sftp.on('FSTAT', (reqid, handle) => guard(reqid, () => sftp.attrs(reqid, attrsOf(fstatSync(getHandle(handle)!.fd!)))));
  sftp.on('FSETSTAT', (reqid, handle, attrs) =>
    guard(reqid, () => {
      const h = getHandle(handle);
      if (h?.fd !== undefined && attrs.mode !== undefined) {
        fchmodSync(h.fd, attrs.mode & 0o777);
      }
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on('CLOSE', (reqid, handle) =>
    guard(reqid, () => {
      const id = handle.readUInt32BE(0);
      const h = handles.get(id);
      handles.delete(id);
      if (h?.fd !== undefined) {
        closeSync(h.fd);
      }
      sftp.status(reqid, STATUS_CODE.OK);
    }),
  );
  sftp.on('MKDIR', (reqid, p) => guard(reqid, () => (mkdirSync(local(p)), sftp.status(reqid, STATUS_CODE.OK))));
  sftp.on('RMDIR', (reqid, p) => guard(reqid, () => (rmdirSync(local(p)), sftp.status(reqid, STATUS_CODE.OK))));
  sftp.on('REMOVE', (reqid, p) => guard(reqid, () => (unlinkSync(local(p)), sftp.status(reqid, STATUS_CODE.OK))));
  sftp.on('RENAME', (reqid, from, to) => guard(reqid, () => (renameSync(local(from), local(to)), sftp.status(reqid, STATUS_CODE.OK))));
}

/** GNU 风格的 stat -c（只支持 %f %s %Y %U %G %n），在 macOS 上转成 BSD 的 stat -f；返回放脚本的目录 */
function gnuStatShim(): string {
  const dir = mkdtempSync(join(tmpdir(), 'itm-gnustat-'));
  const script = [
    '#!/bin/sh',
    'follow=""; fmt="%n"',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -L) follow="-L"; shift;;',
    '    -c) fmt="$2"; shift 2;;',
    '    --) shift; break;;',
    '    *) break;;',
    '  esac',
    'done',
    `bsd=$(printf '%s' "$fmt" | sed -e 's/%f/%Xp/g' -e 's/%s/%z/g' -e 's/%Y/%m/g' -e 's/%U/%Su/g' -e 's/%G/%Sg/g' -e 's/%n/%N/g')`,
    'exec /usr/bin/stat $follow -f "$bsd" "$@"',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'stat'), script, { mode: 0o755 });
  return dir;
}

/** 模拟的监控详情输出（格式同 monitor-detail.ts 里各命令在 Linux 上的输出） */
function fakeMonitorDetail(kind: string, command: string): string {
  switch (kind) {
    case 'procs':
      return command.includes('-rss')
        ? [' 1022 mysql     3.1 10.4 1700000 /usr/sbin/mysqld --defaults-file=/etc/my.cnf', '23811 root     12.5  1.2  204800 java -jar /opt/app/app.jar --spring.profiles.active=prod', ''].join('\n')
        : ['23811 root     12.5  1.2  204800 java -jar /opt/app/app.jar --spring.profiles.active=prod', ' 1022 mysql     3.1 10.4 1700000 /usr/sbin/mysqld --defaults-file=/etc/my.cnf', '  811 root      0.4  0.1   20480 sshd: root@pts/0', ''].join('\n');
    case 'static':
      return ['@os', 'Ubuntu 22.04.4 LTS', '@cpu', ' Intel(R) Xeon(R) Gold 6248R CPU @ 3.00GHz', '@gpu', '00:02.0 VGA compatible controller: Cirrus Logic GD 5446', ''].join('\n');
    case 'net':
      return [
        '@sockstat',
        'sockets: used 507',
        '@filenr',
        '7776\t0\t1048576',
        '@tcp',
        '     30 01',
        '      1 06',
        '     37 0A',
        '@udp',
        '65',
        '@listen',
        'tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    users:(("sshd",pid=1207,fd=3))',
        'tcp   LISTEN 0      151          0.0.0.0:3306      0.0.0.0:*    users:(("mysqld",pid=1022,fd=21))',
        'udp   UNCONN 0      0          0.0.0.0:111       0.0.0.0:*    users:(("rpcbind",pid=1,fd=5))',
        '',
      ].join('\n');
    case 'bigfiles':
      return ['2097152\t/var/log/app/huge.log', '524288\t/home/deploy/backup.tar.gz', ''].join('\n');
    default:
      return '';
  }
}

/** 模拟的 Linux 监控数据块（格式同 MONITOR_SCRIPT 的输出），计数器随 tick 增长以产生速率 */
function fakeMonitorBlock(tick: number, cwd: string): string {
  // 计数器必须单调递增（真实的 /proc/stat 也是如此），波动体现在每次的增量上
  const busy = 1000 + tick * 50 + Math.floor((tick * tick) / 3);
  const idle = 8000 + tick * 100;
  return [
    '@@BEGIN',
    '@host web-01 5.15.0-105-generic',
    '@stat',
    `cpu  ${busy} 0 ${500 + tick * 10} ${idle} ${100 + tick} 0 0 0 0 0`,
    // 每个核心忙闲不同
    ...[0, 1, 2, 3].map((c) => `cpu${c} ${250 + tick * (5 + c * 6)} 0 ${100 + tick * 2} ${2000 + tick * 25} ${25 + tick} 0 0 0 0 0`),
    '@cores 4',
    '@mem',
    'MemTotal:       16266280 kB',
    'MemFree:         1900000 kB',
    'Buffers:          160000 kB',
    'Cached:          4960000 kB',
    `MemAvailable:    ${4229232 - (tick % 7) * 20000} kB`,
    'SwapTotal:       2097148 kB',
    'SwapFree:        1900000 kB',
    '@load 0.42 0.35 0.30 1/512 23811',
    '@uptime 5925661.21 23380000.00',
    '@net',
    `  ens160: ${5000000 + tick * 68000} 100 0 0 0 0 0 0 ${2000000 + tick * 34000} 50 0 0 0 0 0 0`,
    '@ip',
    'ens160 10.10.0.91/24',
    '@route',
    'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask',
    'ens160\t00000000\t01000A0A\t0003\t0\t0\t100\t00000000',
    '@diskstats',
    `   8       0 sda 1000 0 ${20000 + tick * 400} 0 500 0 ${10000 + tick * 200} 0 0 0 0`,
    '@df',
    '/dev/mapper/root  52403200 15203200 37200000  30% /',
    '/dev/sda1          1038336   155000   883336  15% /boot',
    '@temp',
    '48000',
    '@ps',
    '23811 root 12.5  1.2 204800 java',
    ' 1022 mysql  3.1 10.4 1700000 mysqld',
    '  811 root  0.4  0.1 20480 sshd',
    '@gpu',
    '@shells',
    `4242 pts/0 ${cwd}`,
    '@@END',
    '',
  ].join('\n');
}
