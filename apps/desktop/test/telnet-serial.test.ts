import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import iconv from 'iconv-lite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SERIAL, type HostInput, type IpcEventName, type IpcEvents, type SerialSessionState } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { SessionManager, SerialView, parseHex, serialOpenError } from '../src/main/services/connection/session-manager';
import { createCodec } from '../src/main/services/connection/codec';
import { AutoLogin, IAC, OPT, TelnetProtocol } from '../src/main/services/connection/telnet';
import { ByteQueue, crc16, xmodemSend, ymodemSend, type ByteChannel } from '../src/main/services/connection/xmodem';
import { mockSerial } from '../src/main/services/connection/serial';
import type { SshPool } from '../src/main/services/connection/ssh-pool';
import { createRepos } from './support/repos';
import { startTestTelnetServer, type TestTelnetServer } from './support/telnet-server';

const OWNER = 3;

describe('终端编码', () => {
  it('GBK：跨数据块的多字节字符也能正确解码；输入按 GBK 编码', () => {
    const c = createCodec('GBK');
    const bytes = iconv.encode('中文设备 OK', 'gbk');
    expect(c.decode(bytes.subarray(0, 3)) + c.decode(bytes.subarray(3))).toBe('中文设备 OK');
    expect(c.encode('显示')).toEqual(iconv.encode('显示', 'gbk'));
    expect(createCodec('not-a-charset').encoding).toBe('UTF-8');
    const u = createCodec('utf8');
    const b = Buffer.from('终端');
    expect(u.decode(b.subarray(0, 2)) + u.decode(b.subarray(2))).toBe('终端');
  });
});

describe('Telnet 协议', () => {
  it('剥掉 IAC 命令并应答协商：终端类型、窗口大小、回显；不支持的选项拒绝', () => {
    const sent: Buffer[] = [];
    const p = new TelnetProtocol((b) => sent.push(b), 'xterm-256color', 120, 40);
    const data = p.receive(Buffer.from([0x41, IAC, 253, OPT.TTYPE, IAC, 253, OPT.NAWS, IAC, 251, OPT.ECHO, IAC, 253, 39, 0x42, IAC, IAC, 0x43]));
    expect([...data]).toEqual([0x41, 0x42, IAC, 0x43]);
    expect(Buffer.concat(sent)).toEqual(
      Buffer.from([
        IAC, 251, OPT.TTYPE,
        IAC, 251, OPT.NAWS, IAC, 250, OPT.NAWS, 0, 120, 0, 40, IAC, 240,
        IAC, 253, OPT.ECHO,
        IAC, 252, 39,
      ]),
    );
    expect(p.remoteEcho).toBe(true);
    // 同样的协商再来一次不重复应答（避免死循环）
    sent.length = 0;
    p.receive(Buffer.from([IAC, 251, OPT.ECHO]));
    expect(sent).toEqual([]);
    // TTYPE SEND → TTYPE IS
    p.receive(Buffer.from([IAC, 250, OPT.TTYPE, 1, IAC, 240]));
    expect(sent[0]).toEqual(Buffer.from([IAC, 250, OPT.TTYPE, 0, ...Buffer.from('xterm-256color'), IAC, 240]));
    // 窗口变化时上报
    sent.length = 0;
    p.resize(255, 50);
    expect(sent[0]).toEqual(Buffer.from([IAC, 250, OPT.NAWS, 0, 255, 255, 0, 50, IAC, 240]));
    // 跨数据块的命令
    sent.length = 0;
    expect([...p.receive(Buffer.from([0x31, IAC]))]).toEqual([0x31]);
    expect([...p.receive(Buffer.from([254, OPT.TTYPE, 0x32]))]).toEqual([0x32]);
    expect(sent[0]).toEqual(Buffer.from([IAC, 252, OPT.TTYPE]));
  });

  it('发送：0xFF 转义成 IAC IAC，单独的回车写成 CR NUL', () => {
    const p = new TelnetProtocol(() => undefined, 'vt100', 80, 24);
    expect([...p.encode(Buffer.from([0x61, 0xff, 13, 13, 10]))]).toEqual([0x61, IAC, IAC, 13, 0, 13, 10]);
  });

  it('自动登录：login: 填用户名、Password: 填密码，各填一次', () => {
    const a = new AutoLogin('admin', 'secret');
    expect(a.feed('Welcome\r\n\x1b[1mlogin:\x1b[0m ')).toBe('admin\r');
    expect(a.feed('admin\r\nPassword:')).toBe('secret\r');
    expect(a.done).toBe(true);
    expect(a.feed('\r\nPassword: ')).toBeNull();
    const noPass = new AutoLogin('ops', undefined);
    expect(noPass.feed('Username: ')).toBe('ops\r');
    expect(noPass.feed('Password: ')).toBeNull();
    expect(noPass.done).toBe(true);
  });
});

/** 测试用的 XMODEM / YMODEM 接收方：校验块号和 CRC / 校验和，收齐数据 */
function receiver(mode: 'crc' | 'sum' | 'ymodem', opts: { nakFirst?: boolean } = {}): { ch: ByteChannel; files: { name: string; size: number; data: Buffer }[]; data: () => Buffer } {
  const incoming: number[] = [];
  const queue = new ByteQueue((b) => {
    for (const x of b) incoming.push(x);
    void pump();
  });
  const files: { name: string; size: number; data: Buffer }[] = [];
  let chunks: Buffer[] = [];
  let expected = mode === 'ymodem' ? 0 : 1;
  let nakFirst = !!opts.nakFirst;
  let eots = 0;
  let current: { name: string; size: number } | null = null;
  const send = (b: number): void => queue.push(Buffer.from([b]));
  send(mode === 'sum' ? 0x15 : 0x43);
  const pump = async (): Promise<void> => {
    while (incoming.length) {
      const h = incoming[0];
      if (h === 0x04) {
        incoming.shift();
        // YMODEM：第一次 EOT 回 NAK，第二次回 ACK，然后要下一个文件
        if (mode === 'ymodem' && eots++ === 0) {
          send(0x15);
          continue;
        }
        eots = 0;
        send(0x06);
        if (mode === 'ymodem') {
          files.push({ ...current!, data: Buffer.concat(chunks).subarray(0, current!.size) });
          chunks = [];
          expected = 0;
          send(0x43);
        }
        continue;
      }
      const size = h === 0x02 ? 1024 : 128;
      const total = 3 + size + (mode === 'sum' ? 1 : 2);
      if (incoming.length < total) return;
      const pkt = Buffer.from(incoming.splice(0, total));
      expect(pkt[1]).toBe(expected & 0xff);
      expect(pkt[2]).toBe(0xff - (expected & 0xff));
      const payload = pkt.subarray(3, 3 + size);
      if (mode === 'sum') {
        let sum = 0;
        for (const b of payload) sum = (sum + b) & 0xff;
        expect(pkt[3 + size]).toBe(sum);
      } else {
        expect((pkt[3 + size] << 8) | pkt[4 + size]).toBe(crc16(payload));
      }
      if (nakFirst) {
        nakFirst = false;
        send(0x15);
        continue;
      }
      if (mode === 'ymodem' && expected === 0) {
        const nul = payload.indexOf(0);
        const name = payload.subarray(0, nul).toString();
        send(0x06);
        if (!name) return; // 空的块 0：批量结束
        current = { name, size: Number(payload.subarray(nul + 1).toString().split(/[ \0]/)[0]) };
        expected = 1;
        send(0x43);
        continue;
      }
      chunks.push(Buffer.from(payload));
      expected++;
      send(0x06);
    }
  };
  return { ch: queue, files, data: () => Buffer.concat(chunks) };
}

describe('XMODEM / YMODEM 发送', () => {
  const file = randomBytes(1000);

  it('XMODEM-CRC：128 字节块，最后一块用 SUB 补齐；NAK 后重发', async () => {
    const r = receiver('crc', { nakFirst: true });
    const progress: number[] = [];
    await xmodemSend(r.ch, file, { onProgress: (s) => progress.push(s) });
    expect(r.data().subarray(0, 1000)).toEqual(file);
    expect(r.data().length).toBe(1024);
    expect([...r.data().subarray(1000)].every((b) => b === 0x1a)).toBe(true);
    expect(progress.at(-1)).toBe(1000);
  });

  it('XMODEM 校验和模式（接收方发 NAK 开始）', async () => {
    const r = receiver('sum');
    await xmodemSend(r.ch, file);
    expect(r.data().subarray(0, 1000)).toEqual(file);
  });

  it('YMODEM：块 0 带文件名和大小，1K 数据块，结束发空块 0', async () => {
    const r = receiver('ymodem');
    const big = randomBytes(2500);
    await ymodemSend(r.ch, [{ name: 'firmware.bin', data: big, mtime: Date.now() }]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ name: 'firmware.bin', size: 2500 });
    expect(r.files[0].data).toEqual(big);
  });

  it('取消：发送 CAN 并报错', async () => {
    const written: Buffer[] = [];
    const q = new ByteQueue((b) => written.push(b));
    const ac = new AbortController();
    q.push(Buffer.from([0x43]));
    // 接收方一直不应答，取消后应该发出 CAN
    const p = xmodemSend(q, file, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow();
    expect(Buffer.concat(written).includes(Buffer.from([0x18, 0x18]))).toBe(true);
  });
});

describe('串口显示', () => {
  it('十六进制显示：每行 16 字节，遇到换行另起一行；时间戳加在每行开头', () => {
    const v = new SerialView((b) => b.toString(), () => new Date(2026, 9, 13, 9, 5, 7, 12).getTime());
    v.hex = true;
    expect(v.render(Buffer.from('AB\n'))).toBe('41 42 0A \r\n');
    expect(v.render(Buffer.alloc(17, 0x30))).toBe(`${'30 '.repeat(16)}\r\n30 `);
    v.reset();
    v.hex = false;
    v.timestamp = true;
    expect(v.render(Buffer.from('ok\r\nnext'))).toBe('\x1b[90m[09:05:07.012] \x1b[0mok\r\n\x1b[90m[09:05:07.012] \x1b[0mnext');
  });

  it('解析十六进制输入', () => {
    expect(parseHex('48 65 6c 6C')).toEqual(Buffer.from('Hell'));
    expect(parseHex('0x0D,0x0A')).toEqual(Buffer.from('\r\n'));
    expect(() => parseHex('4')).toThrow('十六进制格式不对');
    expect(() => parseHex('zz')).toThrow('十六进制格式不对');
  });
});

// ---------------------------------------------------------------- 会话（真实的 Telnet 服务器和模拟串口）

let dir: string;
let db: Db;
let hosts: HostRepo;
let sessions: SessionManager;
let events: { event: IpcEventName; payload: unknown }[];
let telnet: TestTelnetServer;

function emit<E extends IpcEventName>(_owner: number, event: E, payload: IpcEvents[E]): void {
  events.push({ event, payload });
}
function output(id: string): string {
  return events
    .filter((e) => e.event === 'session.data' && (e.payload as { sessionId: string }).sessionId === id)
    .map((e) => (e.payload as { data: string }).data)
    .join('');
}
function statusOf(id: string): string | undefined {
  return events.filter((e) => e.event === 'session.status' && (e.payload as { sessionId: string }).sessionId === id).map((e) => (e.payload as { status: string }).status).at(-1);
}
async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}
function addHost(over: Partial<HostInput>): string {
  return hosts.create({
    folderId: null,
    name: 'dev',
    address: '127.0.0.1',
    port: 23,
    username: '',
    authMethod: 'PASSWORD',
    keepaliveSec: 0,
    startupScript: null,
    note: null,
    jumpHostIds: [],
    ...(over.protocol === 'SERIAL' ? { serial: DEFAULT_SERIAL } : {}),
    ...over,
  }).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'itm-ts-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
  ({ hosts } = createRepos(db, randomBytes(32)));
  events = [];
  sessions = new SessionManager({} as SshPool, hosts, emit, () => {
    throw new Error('no pty');
  }, mockSerial(['/dev/ITM-T0']));
  telnet = await startTestTelnetServer();
});

afterEach(async () => {
  await telnet.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Telnet 会话', () => {
  it('自动登录、上报终端类型和窗口大小、执行登录后命令；serial_send 等待提示符', async () => {
    const id = sessions.openTelnet(
      OWNER,
      addHost({ protocol: 'TELNET', port: telnet.port, username: 'admin', password: 'pw', startupScript: 'show version', termType: 'vt220' }),
      100,
      30,
    );
    await waitFor(() => statusOf(id) === 'ready');
    await waitFor(() => telnet.lines.includes('show version'));
    expect(telnet.logins).toEqual([{ username: 'admin', password: 'pw' }]);
    expect(telnet.termTypes).toEqual(['vt220']);
    expect(telnet.sizes[0]).toEqual({ cols: 100, rows: 30 });
    expect(output(id)).toContain('Welcome to test router');
    // 密码不会出现在输出里（服务器不回显）
    expect(output(id)).not.toContain('pw\r');
    sessions.resize(OWNER, id, 132, 43);
    await waitFor(() => telnet.sizes.some((s) => s.cols === 132 && s.rows === 43));

    const res = await sessions.sendAndWait(id, 'display interface', 'router> $', 5000, new AbortController().signal);
    expect(res).toContain('echo:display interface');
    expect(telnet.lines).toContain('display interface');
    sessions.close(OWNER, id);
    await waitFor(() => statusOf(id) === 'closed');
  });

  it('连接失败时给出明确的错误', async () => {
    const id = sessions.openTelnet(OWNER, addHost({ protocol: 'TELNET', port: 1, username: 'x' }), 80, 24);
    await waitFor(() => statusOf(id) === 'error');
    const last = events.filter((e) => e.event === 'session.status').at(-1)!.payload as { message: string };
    expect(last.message).toContain('127.0.0.1:1');
  });
});

describe('串口会话', () => {
  it('回车按设置发送 CRLF；十六进制显示、时间戳；DTR / RTS；发送十六进制；录制日志', async () => {
    const hostId = addHost({
      protocol: 'SERIAL',
      address: '/dev/ITM-T0',
      port: 0,
      serial: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', eol: 'CRLF', localEcho: false },
    });
    const id = sessions.openSerial(OWNER, hostId);
    await waitFor(() => statusOf(id) === 'ready');
    expect(output(id)).toContain('9600 8N1');
    const log = join(dir, 'serial.log');
    sessions.setLog(OWNER, id, log);

    // 模拟串口会回显：发出去的是 hello\r\n
    sessions.write(OWNER, id, 'hello\r');
    await waitFor(() => output(id).includes('hello\r\n'));

    const st: SerialSessionState = await sessions.serial(OWNER, id).set({ hex: true, dtr: false });
    expect(st).toMatchObject({ hex: true, dtr: false, rts: true });
    sessions.serial(OWNER, id).sendBytes(parseHex('01 02 FF'));
    await waitFor(() => output(id).includes('01 02 FF '));
    await sessions.serial(OWNER, id).set({ hex: false, timestamp: true });
    sessions.write(OWNER, id, 'ts\r');
    await waitFor(() => /\[\d\d:\d\d:\d\d\.\d{3}\] \x1b\[0mts/.test(output(id)));
    expect(events.some((e) => e.event === 'session.serial')).toBe(true);

    // Agent 的 serial_send：没有提示符时等输出停下来
    const r = await sessions.sendAndWait(id, 'AT', null, 3000, new AbortController().signal, 200);
    expect(r).toContain('AT');

    sessions.setLog(OWNER, id, null);
    await new Promise((res) => setTimeout(res, 50));
    const text = readFileSync(log, 'utf8');
    expect(text).toContain('开始录制');
    expect(text).toContain('hello');
    expect(text).not.toContain('\x1b[');
    sessions.close(OWNER, id);
    await waitFor(() => statusOf(id) === 'closed');
  });

  it('串口不存在时报错；发送文件时检查文件', async () => {
    const id = sessions.openSerial(OWNER, addHost({ protocol: 'SERIAL', address: '/dev/NOPE', port: 0 }));
    await waitFor(() => statusOf(id) === 'error');
    const ok = sessions.openSerial(OWNER, addHost({ protocol: 'SERIAL', address: '/dev/ITM-T0', port: 0, name: 'dev2' }));
    await waitFor(() => statusOf(ok) === 'ready');
    await expect(sessions.serial(OWNER, ok).sendFile(join(dir, 'missing.bin'), 'xmodem', new AbortController().signal)).rejects.toThrow('文件不存在');
    writeFileSync(join(dir, 'a.bin'), randomBytes(10));
    // 模拟串口只会回显，不会发 C：取消后结束
    const p = sessions.serial(OWNER, ok).sendFile(join(dir, 'a.bin'), 'xmodem', new AbortController().signal);
    await waitFor(() => events.some((e) => e.event === 'session.serial' && (e.payload as { state: SerialSessionState }).state.transferring));
    sessions.serial(OWNER, ok).cancelTransfer();
    await expect(p).rejects.toThrow('已取消');
    sessions.close(OWNER, ok);
  });

  it('同一个串口不能同时打开两次；关闭后立即重连会等旧连接关完', async () => {
    const hostId = addHost({ protocol: 'SERIAL', address: '/dev/ITM-T0', port: 0 });
    const a = sessions.openSerial(OWNER, hostId);
    await waitFor(() => statusOf(a) === 'ready');
    expect(() => sessions.openSerial(OWNER, hostId)).toThrow('已经在另一个标签中打开');
    // 重新连接：先关旧的再马上打开
    sessions.close(OWNER, a);
    const b = sessions.openSerial(OWNER, hostId);
    await waitFor(() => statusOf(b) === 'ready' || statusOf(b) === 'error');
    expect(statusOf(b)).toBe('ready');
    // 连接中就关闭：串口被释放，可以再次打开
    sessions.close(OWNER, b);
    const c = sessions.openSerial(OWNER, hostId);
    sessions.close(OWNER, c);
    const d = sessions.openSerial(OWNER, hostId);
    await waitFor(() => statusOf(d) === 'ready');
    sessions.close(OWNER, d);
  });

  it('串口错误翻译成可操作的提示', () => {
    expect(serialOpenError('COM3', 'Opening COM3: Access denied')).toContain('端口被占用');
    expect(serialOpenError('/dev/ttyUSB0', 'Error: Permission denied, cannot open /dev/ttyUSB0')).toContain('dialout');
    expect(serialOpenError('COM9', 'Opening COM9: File not found')).toContain('找不到这个串口');
  });
});
