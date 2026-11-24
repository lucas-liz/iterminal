import type { Readable, Writable } from 'node:stream';

/** 远端文件的属性：mode 用 POSIX 的类型位 + 权限位（FTP 列表里没有时按类型合成） */
export interface RemoteStats {
  mode: number;
  size: number;
  /** 秒 */
  mtime: number;
  /** 所有者、所属组的名字（只有列目录时有；拿不到名字时是 uid / gid） */
  owner?: string;
  group?: string;
}

/**
 * 远端文件系统（文件面板、SFTP 标签、上传下载、在线编辑共用）。
 * 三种实现：SFTP（ssh2 的 SFTPWrapper）；SSH 命令通道（服务器没有 sftp-server 时用 stat / cat 等命令）；FTP / FTPS。
 */
export interface RemoteFs {
  readonly kind: 'sftp' | 'ftp' | 'shell';
  /** 通道已关闭（连接断开、被取消）：传输重试时要重新打开 */
  readonly closed: boolean;
  onClose(fn: () => void): () => void;
  /** 主动关闭：立即让正在进行的读写失败 */
  abort(): void;
  end(): void;
  readdir(path: string): Promise<{ filename: string; attrs: RemoteStats }[]>;
  stat(path: string): Promise<RemoteStats>;
  lstat(path: string): Promise<RemoteStats>;
  realpath(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  /** 不存在时返回 null */
  exists(path: string): Promise<RemoteStats | null>;
  createReadStream(path: string, opts?: { start?: number; highWaterMark?: number }): Readable;
  /** flags 'r+' + start：从 start 处续传（FTP 用 APPE 追加，要求远端文件正好是 start 字节） */
  createWriteStream(path: string, opts?: { flags?: 'w' | 'r+'; start?: number; mode?: number }): Writable;
}
