import type { FileEntry } from '@itm/protocol';

/** 文件类型（第十六轮）：按扩展名和特殊文件名区分，用于图标、双击打开方式 */
export type FileKind =
  | 'dir'
  | 'link'
  | 'archive'
  | 'java'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'word'
  | 'excel'
  | 'ppt'
  | 'markdown'
  | 'script'
  | 'js'
  | 'python'
  | 'code'
  | 'html'
  | 'config'
  | 'log'
  | 'sql'
  | 'db'
  | 'key'
  | 'cert'
  | 'docker'
  | 'binary'
  | 'text'
  | 'file';

const EXT: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string): void => exts.split(' ').forEach((e) => (EXT[e] = kind));
add('archive', 'zip tar gz tgz bz2 tbz2 xz txz 7z rar zst lz4 lzma z');
add('java', 'jar war ear class java kt kts groovy gradle scala');
add('image', 'png jpg jpeg gif bmp webp svg ico tif tiff heic avif psd');
add('video', 'mp4 mkv mov avi wmv flv webm m4v ts');
add('audio', 'mp3 wav flac aac ogg m4a wma opus');
add('pdf', 'pdf');
add('word', 'doc docx odt rtf wps');
add('excel', 'xls xlsx csv ods et');
add('ppt', 'ppt pptx odp dps');
add('markdown', 'md markdown rst adoc');
add('script', 'sh bash zsh fish ksh csh bat cmd ps1 psm1');
add('js', 'js mjs cjs ts tsx jsx vue svelte');
add('python', 'py pyc pyw ipynb');
add('code', 'c h cpp cc cxx hpp go rs rb php pl lua swift m cs vb r dart ex exs erl hs clj elm zig nim');
add('html', 'html htm xhtml css scss sass less');
add('config', 'yml yaml json toml ini conf cfg properties env xml plist service timer socket repo cnf rules');
add('log', 'log out err');
add('sql', 'sql');
add('db', 'db sqlite sqlite3 mdb frm ibd rdb aof dump');
add('key', 'key pem ppk pub gpg asc keystore jks p12 pfx');
add('cert', 'crt cer csr der p7b');
add('binary', 'bin so dll exe dylib o a ko img iso deb rpm apk dmg msi pkg');
add('text', 'txt text nfo readme license');

const NAMES: Record<string, FileKind> = {
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
  makefile: 'code',
  jenkinsfile: 'code',
  readme: 'markdown',
  license: 'text',
  authorized_keys: 'key',
  known_hosts: 'key',
  id_rsa: 'key',
  id_ed25519: 'key',
  id_ecdsa: 'key',
  '.bashrc': 'script',
  '.zshrc': 'script',
  '.profile': 'script',
  '.bash_profile': 'script',
  '.env': 'config',
  '.gitignore': 'config',
  '.dockerignore': 'config',
  crontab: 'config',
  hosts: 'config',
  fstab: 'config',
};

export function fileKind(e: Pick<FileEntry, 'name' | 'type' | 'perms'>): FileKind {
  if (e.type === 'dir') return 'dir';
  if (e.type === 'link') return 'link';
  const name = e.name.toLowerCase();
  if (NAMES[name]) return NAMES[name];
  // 日志轮转文件：app.log.1、app.log.2026-10-17、messages-20261017
  if (/\.log(\.\d+|\.\d{4}-\d{2}-\d{2})?(\.gz)?$/.test(name) || /^(messages|syslog|secure|catalina\.out)/.test(name)) return name.endsWith('.gz') ? 'archive' : 'log';
  if (name.endsWith('.tar.gz') || name.endsWith('.tar.bz2') || name.endsWith('.tar.xz')) return 'archive';
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (ext && EXT[ext]) return EXT[ext];
  // 没有扩展名、有执行权限：可执行文件
  if (!ext && /x/.test(e.perms ?? '')) return 'binary';
  return 'file';
}

/** 双击时用内置编辑器打开的类型（文本类）；其他类型用本机的默认程序打开 */
export const TEXT_KINDS = new Set<FileKind>(['markdown', 'script', 'js', 'python', 'code', 'html', 'config', 'log', 'sql', 'key', 'cert', 'docker', 'text', 'file']);

/** 内置编辑器最大 2MB（和主进程一致） */
const MAX_EDIT = 2 * 1024 * 1024;

/** 双击打开：文本类、不超过 2MB 的用内置编辑器；其他（图片、压缩包、jar、大文件……）下载到临时目录后用本机程序打开 */
export function opensInEditor(e: Pick<FileEntry, 'name' | 'type' | 'perms' | 'size'>): boolean {
  if (e.type !== 'file' || e.size > MAX_EDIT) return false;
  const k = fileKind(e);
  return TEXT_KINDS.has(k) || (k === 'java' && /\.(java|kts?|groovy|gradle|scala)$/i.test(e.name));
}
