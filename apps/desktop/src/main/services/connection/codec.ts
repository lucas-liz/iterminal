import { StringDecoder } from 'node:string_decoder';
import iconv from 'iconv-lite';

/** 终端字符编码（主机设置里的 encoding）：把远端字节流解码成字符串、把输入编码成字节 */
export interface Codec {
  readonly encoding: string;
  /** 流式解码：多字节字符跨两个数据块时会等到下一块再输出 */
  decode(b: Buffer): string;
  end(): string;
  encode(s: string): Buffer;
}

const UTF8 = /^utf-?8$/i;

/** 不认识的编码按 UTF-8 处理 */
export function createCodec(encoding: string | null | undefined): Codec {
  const enc = (encoding || 'UTF-8').trim();
  if (UTF8.test(enc) || !iconv.encodingExists(enc)) {
    const d = new StringDecoder('utf8');
    return { encoding: 'UTF-8', decode: (b) => d.write(b), end: () => d.end(), encode: (s) => Buffer.from(s, 'utf8') };
  }
  const d = iconv.getDecoder(enc);
  return {
    encoding: enc,
    decode: (b) => d.write(b),
    end: () => d.end() ?? '',
    encode: (s) => iconv.encode(s, enc),
  };
}
