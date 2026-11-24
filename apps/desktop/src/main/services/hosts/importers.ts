import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import type { AuthMethod, HostProtocol, ImportSource } from '@itm/protocol';

/**
 * 主机导入解析（文档一 6.5）：只解析、不写库。密码 / 私钥只保存在主进程里，预览只告诉渲染进程有没有。
 * 各家客户端保存的密码大多是加密的（Xshell、SecureCRT、FinalShell、MobaXterm），这些密码不导入，
 * 导入后按「每次询问」处理，第一次连接时可以勾选记住。
 */
export interface ParsedHost {
  key: string;
  folderPath: string[];
  name: string;
  protocol: HostProtocol;
  address: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /** 跳板机：同一批导入里的 key，或者 user@host:port 形式（之后按地址匹配已有主机） */
  jumps: string[];
  tags: string[];
  note: string | null;
}

export interface ParseResult {
  hosts: ParsedHost[];
  warnings: string[];
}

const MAX_FILES = 5000;
const MAX_FILE_SIZE = 4 * 1024 * 1024;

/** 读取文本：自动识别 UTF-16 LE / BE（Xshell 的 .xsh 常见）和 UTF-8 BOM */
export function readText(file: string): string {
  const b = readFileSync(file);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  // 没有 BOM 的 UTF-16：每隔一个字节是 0
  if (b.length > 4 && b[1] === 0 && b[3] === 0 && b[0] !== 0) return b.toString('utf16le');
  return b.toString('utf8');
}

function expandHome(p: string): string {
  return p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p;
}

/** 递归列出目录里的文件（跳过隐藏目录），返回相对路径 */
function walk(dir: string, accept: (name: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      if (ent.name.startsWith('.')) continue;
      const full = join(d, ent.name);
      if (ent.isDirectory()) visit(full);
      else if (ent.isFile() && accept(ent.name) && statSync(full).size <= MAX_FILE_SIZE) out.push(relative(dir, full));
    }
  };
  visit(dir);
  return out;
}

function folderOf(rel: string): string[] {
  const d = dirname(rel);
  return d === '.' ? [] : d.split(sep).filter(Boolean);
}

/** 简单 INI：[section] + key=value（值不去引号） */
function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let cur = new Map<string, string>();
  sections.set('', cur);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)]$/.exec(line);
    if (sec) {
      cur = sections.get(sec[1]) ?? new Map();
      sections.set(sec[1], cur);
      continue;
    }
    const i = line.indexOf('=');
    if (i > 0) cur.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return sections;
}

function port(v: string | number | undefined, fallback: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

// ---------------------------------------------------------------- ~/.ssh/config

export function parseSshConfig(file: string): ParseResult {
  const warnings: string[] = [];
  const blocks: { aliases: string[]; opts: Map<string, string[]> }[] = [];
  const seenFiles = new Set<string>();
  const load = (f: string, depth: number): void => {
    if (depth > 3 || seenFiles.has(f) || !existsSync(f)) return;
    seenFiles.add(f);
    let cur: { aliases: string[]; opts: Map<string, string[]> } | null = null;
    for (const raw of readText(f).split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) continue;
      const m = /^(\S+?)\s*(?:=\s*|\s+)(.+)$/.exec(line);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      if (key === 'include') {
        for (const inc of value.split(/\s+/)) {
          const p = expandHome(inc);
          const abs = isAbsolute(p) ? p : join(homedir(), '.ssh', p);
          if (abs.includes('*')) {
            const d = dirname(abs);
            const re = new RegExp('^' + basename(abs).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            if (existsSync(d)) readdirSync(d).filter((n) => re.test(n)).forEach((n) => load(join(d, n), depth + 1));
          } else load(abs, depth + 1);
        }
        continue;
      }
      if (key === 'host') {
        cur = { aliases: value.split(/\s+/).map((a) => a.replace(/^"|"$/g, '')), opts: new Map() };
        blocks.push(cur);
        continue;
      }
      if (key === 'match') {
        cur = null;
        continue;
      }
      if (cur) cur.opts.set(key, [...(cur.opts.get(key) ?? []), value.replace(/^"|"$/g, '')]);
    }
  };
  load(file, 0);

  // 通配块（Host *、Host *.corp）里的选项作为默认值，按 ssh 的规则「先出现的优先」
  const wildcard = blocks.filter((b) => b.aliases.some((a) => /[*?]/.test(a) || a.startsWith('!')));
  const hosts: ParsedHost[] = [];
  for (const b of blocks) {
    for (const alias of b.aliases) {
      if (/[*?]/.test(alias) || alias.startsWith('!')) continue;
      const opt = (k: string): string | undefined => {
        const own = b.opts.get(k)?.[0];
        if (own !== undefined) return own;
        for (const w of wildcard) {
          const matches = w.aliases.some((pat) => !pat.startsWith('!') && new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(alias));
          if (matches && w.opts.get(k)?.[0] !== undefined) return w.opts.get(k)![0];
        }
        return undefined;
      };
      const address = opt('hostname') ?? alias;
      const h: ParsedHost = {
        key: `ssh:${alias}`,
        folderPath: [],
        name: alias,
        protocol: 'SSH',
        address: address.replace(/%h/g, alias),
        port: port(opt('port'), 22),
        username: opt('user') ?? '',
        authMethod: 'AGENT',
        jumps: [],
        tags: [],
        note: null,
      };
      const identity = opt('identityfile');
      if (identity) {
        const p = expandHome(identity.replace(/%d/g, homedir()).replace(/%h/g, alias));
        try {
          if (existsSync(p) && statSync(p).size < 64 * 1024) {
            h.privateKey = readFileSync(p, 'utf8');
            h.authMethod = 'KEY';
          } else warnings.push(`「${alias}」的私钥 ${identity} 不存在，改用 SSH Agent`);
        } catch {
          warnings.push(`无法读取「${alias}」的私钥 ${identity}，改用 SSH Agent`);
        }
      }
      const jump = opt('proxyjump');
      if (jump && jump.toLowerCase() !== 'none') {
        h.jumps = jump.split(',').map((j) => {
          const t = j.trim();
          return blocks.some((x) => x.aliases.includes(t)) ? `ssh:${t}` : t;
        });
      }
      if (opt('proxycommand')) warnings.push(`「${alias}」使用了 ProxyCommand，iTerminal 不支持，请改用跳板机或代理`);
      hosts.push(h);
    }
  }
  return { hosts, warnings };
}

// ---------------------------------------------------------------- Xshell（.xsh 会话目录 → 分组）

export function parseXshell(path: string): ParseResult {
  const files = statSync(path).isDirectory() ? walk(path, (n) => n.toLowerCase().endsWith('.xsh')) : [basename(path)];
  const root = statSync(path).isDirectory() ? path : dirname(path);
  const hosts: ParsedHost[] = [];
  const warnings: string[] = [];
  for (const rel of files) {
    const ini = parseIni(readText(join(root, rel)));
    const conn = ini.get('CONNECTION');
    const auth = ini.get('CONNECTION:AUTHENTICATION');
    const address = conn?.get('Host');
    if (!address) continue;
    const proto = (conn?.get('Protocol') ?? 'SSH').toUpperCase();
    if (proto !== 'SSH' && proto !== 'TELNET') {
      warnings.push(`跳过「${rel}」：不支持 ${proto} 协议`);
      continue;
    }
    hosts.push({
      key: `xsh:${rel}`,
      folderPath: folderOf(rel),
      name: basename(rel, extname(rel)),
      protocol: proto === 'TELNET' ? 'TELNET' : 'SSH',
      address,
      port: port(conn?.get('Port'), proto === 'TELNET' ? 23 : 22),
      username: auth?.get('UserName') ?? '',
      authMethod: 'INTERACTIVE',
      jumps: [],
      tags: [],
      note: conn?.get('Description') || null,
    });
  }
  return { hosts, warnings };
}

// ---------------------------------------------------------------- SecureCRT（Sessions 目录下的 .ini）

export function parseSecureCrt(path: string): ParseResult {
  const isDir = statSync(path).isDirectory();
  const root = isDir ? path : dirname(path);
  const files = isDir ? walk(path, (n) => n.toLowerCase().endsWith('.ini') && n !== '__FolderData__.ini' && n !== 'Default.ini') : [basename(path)];
  const hosts: ParsedHost[] = [];
  const warnings: string[] = [];
  for (const rel of files) {
    const fields = new Map<string, string>();
    for (const line of readText(join(root, rel)).split(/\r?\n/)) {
      const m = /^[SD]:"([^"]+)"=(.*)$/.exec(line.trim());
      if (m) fields.set(m[1], m[2]);
    }
    const address = fields.get('Hostname');
    if (!address) continue;
    const proto = (fields.get('Protocol Name') ?? 'SSH2').toUpperCase();
    const isTelnet = proto === 'TELNET';
    if (!isTelnet && !proto.startsWith('SSH')) {
      warnings.push(`跳过「${rel}」：不支持 ${proto} 协议`);
      continue;
    }
    const hexPort = isTelnet ? fields.get('Port') : (fields.get('[SSH2] Port') ?? fields.get('Port'));
    hosts.push({
      key: `crt:${rel}`,
      folderPath: folderOf(rel),
      name: basename(rel, extname(rel)),
      protocol: isTelnet ? 'TELNET' : 'SSH',
      address,
      port: hexPort ? parseInt(hexPort, 16) || (isTelnet ? 23 : 22) : isTelnet ? 23 : 22,
      username: fields.get('Username') ?? '',
      authMethod: 'INTERACTIVE',
      jumps: [],
      tags: [],
      note: null,
    });
  }
  return { hosts, warnings };
}

// ---------------------------------------------------------------- FinalShell（conn 目录下的 *_connect_config.json）

export function parseFinalShell(path: string): ParseResult {
  const isDir = statSync(path).isDirectory();
  const root = isDir ? path : dirname(path);
  const files = isDir ? walk(path, (n) => n.toLowerCase().endsWith('.json')) : [basename(path)];
  const folders = new Map<string, { name: string; parent: string | null }>();
  const raw: { rel: string; o: Record<string, unknown> }[] = [];
  for (const rel of files) {
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(readText(join(root, rel))) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o.host === 'string') raw.push({ rel, o });
    else if (typeof o.id === 'string' && typeof o.name === 'string') folders.set(o.id, { name: o.name, parent: typeof o.parent_id === 'string' ? o.parent_id : null });
  }
  const pathOf = (id: unknown, depth = 0): string[] => {
    const f = typeof id === 'string' ? folders.get(id) : undefined;
    if (!f || depth > 10) return [];
    return [...pathOf(f.parent, depth + 1), f.name];
  };
  const hosts = raw.map(({ rel, o }): ParsedHost => {
    const type = Number(o.conection_type ?? o.connection_type ?? 100);
    const fp = pathOf(o.parent_id);
    return {
      key: `fs:${rel}`,
      folderPath: fp.length ? fp : folderOf(rel).filter((d) => d !== 'conn'),
      name: String(o.name ?? o.host),
      // FinalShell：100 = SSH，101 = 远程桌面，102 = Telnet（不同版本可能不同，按端口兜底）
      protocol: type === 102 || Number(o.port) === 23 ? 'TELNET' : 'SSH',
      address: String(o.host),
      port: port(o.port as number, 22),
      username: String(o.user_name ?? ''),
      authMethod: 'INTERACTIVE',
      jumps: [],
      tags: [],
      note: typeof o.description === 'string' && o.description ? o.description : null,
    };
  });
  return { hosts, warnings: [] };
}

// ---------------------------------------------------------------- MobaXterm（.mxtsessions）

const MOBA_PROTOCOLS: Record<string, HostProtocol> = { '109': 'SSH', '98': 'TELNET' };

export function parseMobaXterm(file: string): ParseResult {
  const ini = parseIni(readText(file));
  const hosts: ParsedHost[] = [];
  const warnings: string[] = [];
  for (const [section, entries] of ini) {
    if (!/^Bookmarks/i.test(section)) continue;
    const sub = entries.get('SubRep') ?? '';
    const folderPath = sub.split('\\').filter(Boolean);
    for (const [name, value] of entries) {
      if (name === 'SubRep' || name === 'ImgNum' || !value.startsWith('#')) continue;
      const m = /^#(\d+)#\d+%([^%]*)%([^%]*)%([^%]*)/.exec(value);
      if (!m) continue;
      const protocol = MOBA_PROTOCOLS[m[1]];
      if (!protocol) {
        warnings.push(`跳过「${name}」：不支持的会话类型`);
        continue;
      }
      hosts.push({
        key: `moba:${section}:${name}`,
        folderPath,
        name,
        protocol,
        address: m[2],
        port: port(m[3], protocol === 'TELNET' ? 23 : 22),
        username: m[4] ?? '',
        authMethod: 'INTERACTIVE',
        jumps: [],
        tags: [],
        note: null,
      });
    }
  }
  return { hosts, warnings };
}

// ---------------------------------------------------------------- Electerm 书签导出

interface ElectermBookmark {
  id?: string;
  title?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  type?: string;
  description?: string;
  authType?: string;
}
interface ElectermGroup {
  id: string;
  title: string;
  bookmarkIds?: string[];
  bookmarkGroupIds?: string[];
}

export function parseElecterm(file: string): ParseResult {
  const data = JSON.parse(readText(file)) as { bookmarks?: ElectermBookmark[]; bookmarkGroups?: ElectermGroup[] };
  const groups = data.bookmarkGroups ?? [];
  const parentOf = new Map<string, string>();
  for (const g of groups) for (const child of g.bookmarkGroupIds ?? []) parentOf.set(child, g.id);
  const groupPath = (id: string, depth = 0): string[] => {
    const g = groups.find((x) => x.id === id);
    if (!g || depth > 10 || g.id === 'default') return [];
    const p = parentOf.get(id);
    return [...(p ? groupPath(p, depth + 1) : []), g.title];
  };
  const hostGroup = new Map<string, string>();
  for (const g of groups) for (const b of g.bookmarkIds ?? []) hostGroup.set(b, g.id);
  const warnings: string[] = [];
  const hosts: ParsedHost[] = [];
  for (const b of data.bookmarks ?? []) {
    const type = (b.type ?? 'ssh').toLowerCase();
    if (!b.host || (type !== 'ssh' && type !== 'telnet')) {
      if (b.host) warnings.push(`跳过「${b.title ?? b.host}」：不支持 ${type} 类型`);
      continue;
    }
    const h: ParsedHost = {
      key: `electerm:${b.id ?? b.host}`,
      folderPath: b.id && hostGroup.has(b.id) ? groupPath(hostGroup.get(b.id)!) : [],
      name: b.title || b.host,
      protocol: type === 'telnet' ? 'TELNET' : 'SSH',
      address: b.host,
      port: port(b.port, type === 'telnet' ? 23 : 22),
      username: b.username ?? '',
      authMethod: 'INTERACTIVE',
      jumps: [],
      tags: [],
      note: b.description || null,
    };
    if (b.privateKey) {
      h.authMethod = 'KEY';
      h.privateKey = b.privateKey;
      h.passphrase = b.passphrase || undefined;
    } else if (b.password) {
      h.authMethod = 'PASSWORD';
      h.password = b.password;
    }
    hosts.push(h);
  }
  return { hosts, warnings };
}

// ---------------------------------------------------------------- CSV / JSON（也是导出格式）

/** RFC 4180 CSV：双引号包裹的字段里可以有逗号、换行，"" 表示一个引号 */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export function toCsvField(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const CSV_COLUMNS: Record<string, string[]> = {
  name: ['name', '名称', '主机名称'],
  group: ['group', 'folder', '分组', '文件夹'],
  protocol: ['protocol', '协议'],
  address: ['address', 'host', 'ip', 'hostname', '地址', '主机'],
  port: ['port', '端口'],
  username: ['username', 'user', '用户名', '用户'],
  auth: ['auth', 'authmethod', '认证', '认证方式'],
  password: ['password', '密码'],
  privateKey: ['privatekey', 'private_key', '私钥'],
  passphrase: ['passphrase', '私钥密码', '口令'],
  tags: ['tags', 'tag', '标签'],
  note: ['note', 'description', '备注', '说明'],
  jumps: ['jump', 'jumps', '跳板机'],
};

export const CSV_HEADER = ['name', 'group', 'protocol', 'address', 'port', 'username', 'auth', 'tags', 'note', 'jumps'];

const AUTH_ALIASES: Record<string, AuthMethod> = {
  password: 'PASSWORD', 密码: 'PASSWORD', key: 'KEY', 私钥: 'KEY', agent: 'AGENT', interactive: 'INTERACTIVE', 询问: 'INTERACTIVE', 每次询问: 'INTERACTIVE',
};

export function parseCsv(file: string): ParseResult {
  const rows = parseCsvRows(readText(file));
  if (rows.length < 2) return { hosts: [], warnings: ['CSV 没有数据行（第一行必须是表头）'] };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (k: string): number => header.findIndex((h) => CSV_COLUMNS[k].includes(h));
  const idx = Object.fromEntries(Object.keys(CSV_COLUMNS).map((k) => [k, col(k)])) as Record<string, number>;
  if (idx.address < 0) return { hosts: [], warnings: ['CSV 缺少地址列（address / host / 地址）'] };
  const warnings: string[] = [];
  const hosts: ParsedHost[] = [];
  rows.slice(1).forEach((r, i) => {
    const get = (k: string): string => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
    const address = get('address');
    if (!address) {
      warnings.push(`第 ${i + 2} 行没有地址，已跳过`);
      return;
    }
    const proto = get('protocol').toUpperCase();
    const protocol: HostProtocol = proto === 'TELNET' ? 'TELNET' : 'SSH';
    const password = get('password');
    // 「包含敏感信息」导出的 CSV 带私钥列（多行，按 CSV 规则用引号包起来）
    const privateKey = idx.privateKey >= 0 ? (r[idx.privateKey] ?? '').trim() : '';
    let authMethod = AUTH_ALIASES[get('auth').toLowerCase()] ?? (privateKey ? 'KEY' : password ? 'PASSWORD' : 'INTERACTIVE');
    if (authMethod === 'KEY' && !privateKey) {
      warnings.push(`第 ${i + 2} 行是私钥认证，CSV 不包含私钥，改为每次询问`);
      authMethod = 'INTERACTIVE';
    }
    hosts.push({
      key: `csv:${i + 2}`,
      folderPath: get('group').split(/[/\\>]/).map((s) => s.trim()).filter(Boolean),
      name: get('name') || address,
      protocol,
      address,
      port: port(get('port'), protocol === 'TELNET' ? 23 : 22),
      username: get('username'),
      authMethod,
      password: authMethod === 'PASSWORD' && password ? password : undefined,
      privateKey: authMethod === 'KEY' ? privateKey : undefined,
      passphrase: authMethod === 'KEY' ? get('passphrase') || undefined : undefined,
      jumps: get('jumps').split(/[;|>]/).map((s) => s.trim()).filter(Boolean),
      tags: get('tags').split(/[;|,，]/).map((s) => s.trim()).filter(Boolean),
      note: get('note') || null,
    });
  });
  // 跳板机按名称（或「分组/名称」）引用同一个文件里的主机；找不到的保留原文，之后按地址匹配已有主机
  for (const h of hosts) {
    h.jumps = h.jumps.map((j) => hosts.find((x) => x !== h && ([...x.folderPath, x.name].join('/') === j || x.name === j))?.key ?? j);
  }
  return { hosts, warnings };
}

export interface HostsJson {
  format: 'itm-hosts';
  version: 1;
  exportedAt: string;
  /** 「包含敏感信息」导出：带密码、私钥 */
  containsSecrets?: boolean;
  hosts: {
    name: string;
    folderPath: string[];
    protocol: HostProtocol;
    address: string;
    port: number;
    username: string;
    authMethod: AuthMethod;
    tags: string[];
    note: string | null;
    /** 跳板机的名称路径（分组路径 + 名称），导入时按同一批里的主机匹配 */
    jumps: string[];
    password?: string;
    privateKey?: string;
    passphrase?: string;
  }[];
}

/** JSON 里的认证：带了私钥 / 密码时（「包含敏感信息」导出）直接使用，否则只保留 Agent，其余改为每次询问 */
function jsonAuth(h: HostsJson['hosts'][number]): Pick<ParsedHost, 'authMethod' | 'password' | 'privateKey' | 'passphrase'> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
  if (str(h.privateKey)) return { authMethod: 'KEY', privateKey: str(h.privateKey), passphrase: str(h.passphrase) };
  if (str(h.password)) return { authMethod: 'PASSWORD', password: str(h.password) };
  return { authMethod: h.authMethod === 'AGENT' ? 'AGENT' : 'INTERACTIVE' };
}

export function parseHostsJson(file: string): ParseResult {
  const data = JSON.parse(readText(file)) as HostsJson;
  if (data?.format !== 'itm-hosts' || !Array.isArray(data.hosts)) return { hosts: [], warnings: ['不是 iTerminal 导出的主机列表（JSON）'] };
  const keyOf = (h: { folderPath: string[]; name: string }): string => `json:${[...h.folderPath, h.name].join('/')}`;
  const hosts = data.hosts.map(
    (h): ParsedHost => ({
      key: keyOf(h),
      folderPath: Array.isArray(h.folderPath) ? h.folderPath.map(String) : [],
      name: String(h.name ?? h.address),
      protocol: h.protocol === 'TELNET' ? 'TELNET' : 'SSH',
      address: String(h.address),
      port: port(h.port, 22),
      username: String(h.username ?? ''),
      ...jsonAuth(h),
      jumps: (h.jumps ?? []).map((j) => `json:${j}`),
      tags: Array.isArray(h.tags) ? h.tags.map(String) : [],
      note: h.note ?? null,
    }),
  );
  return { hosts, warnings: [] };
}

export function parseImport(source: ImportSource, path: string): ParseResult {
  switch (source) {
    case 'SSH_CONFIG':
      return parseSshConfig(path || join(homedir(), '.ssh', 'config'));
    case 'XSHELL':
      return parseXshell(path);
    case 'SECURECRT':
      return parseSecureCrt(path);
    case 'FINALSHELL':
      return parseFinalShell(path);
    case 'MOBAXTERM':
      return parseMobaXterm(path);
    case 'ELECTERM':
      return parseElecterm(path);
    case 'CSV':
      return parseCsv(path);
    case 'JSON':
      return parseHostsJson(path);
  }
}
