import { SerialPort, SerialPortMock } from 'serialport';
import type { SerialPortInfo } from '@itm/protocol';

/** serialport 的最小接口，便于测试时换成模拟串口 */
export interface SerialPortLike {
  readonly isOpen: boolean;
  open(cb: (err: Error | null) => void): void;
  write(data: Buffer): boolean;
  set(opts: { dtr?: boolean; rts?: boolean }, cb?: (err: Error | null) => void): void;
  close(cb?: (err: Error | null) => void): void;
  on(event: 'data', cb: (data: Buffer) => void): this;
  on(event: 'close', cb: (err?: Error | null) => void): this;
  on(event: 'error', cb: (err: Error) => void): this;
}

export interface SerialOpenOptions {
  path: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space';
  stopBits: 1 | 1.5 | 2;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
}

export interface SerialProvider {
  open(o: SerialOpenOptions): SerialPortLike;
  list(): Promise<SerialPortInfo[]>;
}

const toInfo = (p: { path: string; manufacturer?: string; serialNumber?: string; vendorId?: string; productId?: string }): SerialPortInfo => ({
  path: p.path,
  manufacturer: p.manufacturer ?? null,
  serialNumber: p.serialNumber ?? null,
  vendorId: p.vendorId ?? null,
  productId: p.productId ?? null,
});

/** 真实串口（serialport 的 N-API 预编译模块） */
export const realSerial: SerialProvider = {
  open: (o) => new SerialPort({ ...o, autoOpen: false }) as unknown as SerialPortLike,
  list: async () => (await SerialPort.list()).map(toInfo),
};

/**
 * 模拟串口（测试和 E2E 用，ITM_SERIAL_MOCK=1）：写入的内容原样回显，像一台会回显的设备。
 */
export function mockSerial(paths: string[]): SerialProvider {
  const mock = SerialPortMock.binding;
  mock.reset();
  for (const p of paths) mock.createPort(p, { echo: true, record: true });
  return {
    open: (o) => new SerialPortMock({ ...o, autoOpen: false }) as unknown as SerialPortLike,
    list: async () => (await mock.list()).map(toInfo),
  };
}
