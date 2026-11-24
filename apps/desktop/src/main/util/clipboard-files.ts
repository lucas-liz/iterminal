import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Electron 44 的 clipboard（异步，类似 W3C ClipboardItem）里用到的部分（便于测试） */
export interface ClipboardItemLike {
  readonly types: string[];
  getType(type: string): Promise<unknown>;
}
export interface ClipboardLike {
  read(): Promise<ClipboardItemLike[]>;
}

/** 系统原始格式：Electron 用 `electron application/osclipboard;format="…"` 读取 */
const os = (format: string): string => `electron application/osclipboard;format="${format}"`;
const RAW: Record<string, string[]> = {
  darwin: ['NSFilenamesPboardType', 'public.file-url'],
  win32: ['FileNameW', 'FileName'],
  linux: ['x-special/gnome-copied-files'],
};

const decodeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function textOf(v: unknown, utf16: boolean): Promise<string> {
  if (typeof v === 'string') return v;
  if (v && typeof (v as Blob).arrayBuffer === 'function') {
    const buf = Buffer.from(await (v as Blob).arrayBuffer());
    return utf16 ? buf.toString('utf16le') : buf.toString('utf8');
  }
  return '';
}

/** 从一段剪贴板文本里取出文件路径：plist 的 <string>、file:// 地址、Windows 的 UTF-16 路径 */
export function pathsFromText(text: string, type: string): string[] {
  const out: string[] = [];
  // Windows 的 FileName / FileNameW（注意 macOS 的 NSFilenamesPboardType 不是）
  if (/(^|")FileNameW?("|$)/.test(type)) {
    const p = text.replace(/\0[\s\S]*$/, '').trim();
    if (p) out.push(p);
    return out;
  }
  for (const m of text.matchAll(/<string>([\s\S]*?)<\/string>/g)) out.push(decodeXml(m[1]));
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith('file://')) {
      try {
        out.push(fileURLToPath(l));
      } catch {
        // 不是合法的 file:// 地址
      }
    }
  }
  return out;
}

/**
 * 系统剪贴板里复制的本机文件（在访达 / 资源管理器里「复制」的文件），「从剪贴板上传」用（第十六轮）：
 * macOS 读 NSFilenamesPboardType / public.file-url，Windows 读 FileNameW，Linux 读 text/uri-list 和 GNOME 的格式。
 * 只返回本机存在的路径。
 */
export async function clipboardFiles(cb: ClipboardLike, platform: string = process.platform): Promise<string[]> {
  const out: string[] = [];
  let items: ClipboardItemLike[] = [];
  try {
    items = await cb.read();
  } catch {
    return [];
  }
  const raw = (RAW[platform] ?? RAW.linux).map(os);
  for (const item of items) {
    const types = [...new Set([...item.types.filter((t) => /uri-list|file-url|FilenamesPboard|FileName|copied-files/i.test(t)), ...raw])];
    for (const t of types) {
      try {
        const v = await item.getType(t);
        out.push(...pathsFromText(await textOf(v, /FileNameW/.test(t)), t));
      } catch {
        // 没有这种格式
      }
      if (out.length) break;
    }
    if (out.length) break;
  }
  return [...new Set(out)].filter((p) => p && existsSync(p));
}
