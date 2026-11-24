/**
 * 串口文件发送（文档一 6.2）：XMODEM（校验和 / CRC-16，128 字节块）和 YMODEM（批量，1K 块，块 0 带文件名和大小）。
 * 只实现发送方；接收方是设备（例如 U-Boot 的 loadx / loady、单片机 Bootloader）。
 */
const SOH = 0x01;
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const CRC_REQ = 0x43; // 'C'
const SUB = 0x1a;

const MAX_RETRIES = 10;
/** 等待接收方开始（发 C 或 NAK）的时间 */
const START_TIMEOUT = 60_000;
const BLOCK_TIMEOUT = 10_000;

export interface ByteChannel {
  write(b: Buffer): void;
  /** 读一个字节；超时返回 null */
  readByte(timeoutMs: number, signal?: AbortSignal): Promise<number | null>;
}

export interface TransferOptions {
  signal?: AbortSignal;
  onProgress?(sentBytes: number, totalBytes: number): void;
}

export function crc16(data: Buffer): number {
  let crc = 0;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function packet(num: number, payload: Buffer, size: 128 | 1024, crc: boolean, pad = SUB): Buffer {
  const data = Buffer.alloc(size, pad);
  payload.copy(data, 0, 0, Math.min(payload.length, size));
  const head = Buffer.from([size === 1024 ? STX : SOH, num & 0xff, 0xff - (num & 0xff)]);
  if (crc) {
    const c = crc16(data);
    return Buffer.concat([head, data, Buffer.from([c >> 8, c & 0xff])]);
  }
  let sum = 0;
  for (const b of data) sum = (sum + b) & 0xff;
  return Buffer.concat([head, data, Buffer.from([sum])]);
}

export class TransferError extends Error {}

/** 等接收方发出开始信号：'C' = CRC 模式，NAK = 校验和模式 */
async function waitStart(ch: ByteChannel, signal?: AbortSignal, allowNak = true): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT;
  let cans = 0;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new TransferError('已取消');
    const b = await ch.readByte(Math.min(1000, deadline - Date.now()), signal);
    if (b === CRC_REQ) return true;
    if (b === NAK && allowNak) return false;
    if (b === CAN && ++cans >= 2) throw new TransferError('接收方取消了传输');
  }
  throw new TransferError('等待接收方超时：请先在设备上执行接收命令（例如 loadx / loady / rx）');
}

async function sendBlock(ch: ByteChannel, pkt: Buffer, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      ch.write(Buffer.from([CAN, CAN, CAN]));
      throw new TransferError('已取消');
    }
    ch.write(pkt);
    let cans = 0;
    for (;;) {
      const b = await ch.readByte(BLOCK_TIMEOUT, signal);
      if (b === ACK) return;
      if (b === NAK || b === null) break;
      if (b === CAN && ++cans >= 2) throw new TransferError('接收方取消了传输');
      // 其他字节（例如设备打印的提示）忽略，继续等应答
    }
  }
  ch.write(Buffer.from([CAN, CAN, CAN]));
  throw new TransferError(`重试 ${MAX_RETRIES} 次仍然失败，已取消传输`);
}

async function sendEot(ch: ByteChannel, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    ch.write(Buffer.from([EOT]));
    const b = await ch.readByte(BLOCK_TIMEOUT, signal);
    if (b === ACK) return;
  }
  throw new TransferError('结束传输时没有收到确认');
}

/** XMODEM 发送：接收方先发 C 用 CRC-16，发 NAK 用校验和；128 字节块 */
export async function xmodemSend(ch: ByteChannel, data: Buffer, opts: TransferOptions = {}): Promise<void> {
  const crc = await waitStart(ch, opts.signal);
  let num = 1;
  for (let off = 0; off < data.length; off += 128, num++) {
    await sendBlock(ch, packet(num, data.subarray(off, off + 128), 128, crc), opts.signal);
    opts.onProgress?.(Math.min(off + 128, data.length), data.length);
  }
  await sendEot(ch, opts.signal);
}

/** YMODEM 批量发送：块 0 是文件名、大小和修改时间，数据用 1K 块（最后不足 1K 时用 128 字节块），全部发完后发空的块 0 结束 */
export async function ymodemSend(ch: ByteChannel, files: { name: string; data: Buffer; mtime?: number }[], opts: TransferOptions = {}): Promise<void> {
  const total = files.reduce((n, f) => n + f.data.length, 0);
  let sent = 0;
  for (const f of files) {
    await waitStart(ch, opts.signal, false);
    const meta = Buffer.from(`${f.name}\0${f.data.length}${f.mtime ? ` ${Math.floor(f.mtime / 1000).toString(8)}` : ''}\0`, 'utf8');
    await sendBlock(ch, packet(0, meta, 128, true, 0), opts.signal);
    await waitStart(ch, opts.signal, false);
    let num = 1;
    for (let off = 0; off < f.data.length; num++) {
      const left = f.data.length - off;
      const size: 128 | 1024 = left > 128 ? 1024 : 128;
      await sendBlock(ch, packet(num, f.data.subarray(off, off + size), size, true), opts.signal);
      off += size;
      sent += Math.min(size, left);
      opts.onProgress?.(sent, total);
    }
    // YMODEM 的 EOT：接收方通常先回 NAK，再发一次 EOT 才回 ACK
    await sendEot(ch, opts.signal);
  }
  await waitStart(ch, opts.signal, false);
  await sendBlock(ch, packet(0, Buffer.alloc(0), 128, true, 0), opts.signal);
}

/** 把串口收到的字节排队，供传输协议一个个读取 */
export class ByteQueue implements ByteChannel {
  private buf: number[] = [];
  private waiter: ((b: number | null) => void) | null = null;

  constructor(private readonly writer: (b: Buffer) => void) {}

  push(chunk: Buffer): void {
    for (const b of chunk) this.buf.push(b);
    if (this.waiter && this.buf.length) {
      const w = this.waiter;
      this.waiter = null;
      w(this.buf.shift()!);
    }
  }

  write(b: Buffer): void {
    this.writer(b);
  }

  readByte(timeoutMs: number, signal?: AbortSignal): Promise<number | null> {
    if (this.buf.length) return Promise.resolve(this.buf.shift()!);
    return new Promise((resolve) => {
      const done = (b: number | null): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.waiter = null;
        resolve(b);
      };
      const onAbort = (): void => done(null);
      const timer = setTimeout(() => done(null), Math.max(0, timeoutMs));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiter = done;
    });
  }
}
