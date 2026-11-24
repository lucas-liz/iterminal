import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_COLORS, terminalSchemeFor, appThemeScheme, type HostInput, type RecordingData, type TerminalColorSettings } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { ImportService } from '../src/main/services/hosts/import-service';
import { pingHosts, tcpPing } from '../src/main/services/hosts/host-ping';
import { recordingTranscript, terminalText } from '../src/main/services/audit/recording-text';
import { parseCommandDescription } from '../src/main/services/ai/agent-service';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { createRepos } from './support/repos';

/** 第十二轮：主机延迟、导出敏感信息、录像命令和文字、命令说明解析、本地模式不能用 AI、外观设置校验 */
let dir: string;
let db: Db;
let repos: ReturnType<typeof createRepos>;
const vaultKey = randomBytes(32);

const hostInput = (over: Partial<HostInput> = {}): HostInput => ({
  folderId: null,
  name: 'web-01',
  address: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'PASSWORD',
  password: 's3cret',
  keepaliveSec: 30,
  startupScript: null,
  note: null,
  jumpHostIds: [],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-r12-'));
  db = openDatabase(join(dir, 'iterminal.db'), randomBytes(32));
  repos = createRepos(db, vaultKey);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('主机延迟', () => {
  let server: Server;
  let port: number;
  beforeEach(async () => {
    server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('TCP 连接耗时；连不上给出中文原因；跳板机 / 代理 / 串口不直接测', async () => {
    expect(await tcpPing('127.0.0.1', port)).toBeGreaterThanOrEqual(1);
    await expect(tcpPing('127.0.0.1', 1, 2000)).rejects.toThrow('连接被拒绝');
    const r = await pingHosts([
      { id: 'a', address: '127.0.0.1', port, skipped: null },
      { id: 'b', address: '127.0.0.1', port: 1, skipped: null },
      { id: 'c', address: '10.0.0.1', port: 22, skipped: 'jump' },
      { id: 'd', address: '/dev/ttyUSB0', port: 0, skipped: 'serial' },
    ]);
    expect(r[0]).toMatchObject({ id: 'a', error: null, skipped: null });
    expect(r[0].ms).toBeGreaterThanOrEqual(1);
    expect(r[1]).toMatchObject({ id: 'b', ms: null, error: '连接被拒绝' });
    expect(r[2]).toEqual({ id: 'c', ms: null, error: null, skipped: 'jump' });
    expect(r[3]).toEqual({ id: 'd', ms: null, error: null, skipped: 'serial' });
  });

  it('超时', async () => {
    const slow = (): Promise<number> => new Promise((_, reject) => setTimeout(() => reject(new Error('超时')), 10));
    expect((await pingHosts([{ id: 'x', address: 'h', port: 1, skipped: null }], { ping: slow }))[0]).toMatchObject({ ms: null, error: '超时' });
  });
});

describe('导出主机：安全导出 / 包含敏感信息', () => {
  it('包含敏感信息时带上密码和私钥（凭证展开），再导入到新库后可以直接连接', async () => {
    const { hosts, folders, credentials } = repos;
    const pw = hosts.create(hostInput({ name: 'pw-host', note: '订单主库' }));
    const cred = credentials.save(null, { name: '运维账号', type: 'PASSWORD', username: 'ops', secret: 'cred-pw', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    const viaCred = hosts.create(hostInput({ name: 'cred-host', address: '10.0.0.2', username: '', authMethod: 'CREDENTIAL', credentialId: cred.id, password: undefined }));
    const svc = new ImportService(db, hosts, folders);
    const secretsOf = (h: { id: string }) => {
      const a = hosts.connectInfo(h.id).auth;
      if (a.method === 'PASSWORD' && a.password) return { authMethod: 'PASSWORD' as const, username: a.username, password: a.password };
      return null;
    };

    // 安全导出：没有密码
    const safe = await svc.exportHosts('JSON', join(dir, 'safe.json'), null);
    expect(safe).toEqual({ count: 2, secrets: 0 });
    expect(readFileSync(join(dir, 'safe.json'), 'utf8')).not.toMatch(/s3cret|cred-pw/);

    // 包含敏感信息：JSON 和 CSV 都带上
    expect(await svc.exportHosts('JSON', join(dir, 'secret.json'), null, secretsOf)).toEqual({ count: 2, secrets: 2 });
    const json = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8')) as { containsSecrets: boolean; hosts: { name: string; username: string; authMethod: string; password?: string }[] };
    expect(json.containsSecrets).toBe(true);
    expect(json.hosts.find((h) => h.name === 'cred-host')).toMatchObject({ username: 'ops', authMethod: 'PASSWORD', password: 'cred-pw' });
    await svc.exportHosts('CSV', join(dir, 'secret.csv'), [pw.id], secretsOf);
    const csv = readFileSync(join(dir, 'secret.csv'), 'utf8');
    expect(csv.split('\r\n')[0]).toBe('﻿name,group,protocol,address,port,username,auth,tags,note,jumps,password,privateKey,passphrase');
    expect(csv).toContain('s3cret');

    // 导入到新库：密码还在（凭证已经展开成主机自己的密码）
    for (const file of ['secret.json', 'secret.csv']) {
      const db2 = openDatabase(join(dir, `${file}.db`), randomBytes(32));
      const r2 = createRepos(db2, randomBytes(32));
      const svc2 = new ImportService(db2, r2.hosts, r2.folders);
      const p = svc2.preview(file.endsWith('.json') ? 'JSON' : 'CSV', join(dir, file));
      expect(p.items.every((i) => i.hasPassword)).toBe(true);
      svc2.commit(p.token, p.items.map((i) => i.key), null, false);
      const imported = r2.hosts.list().find((h) => h.name === 'pw-host')!;
      expect(imported.note).toBe('订单主库');
      expect(r2.hosts.connectInfo(imported.id).auth).toMatchObject({ method: 'PASSWORD', password: 's3cret' });
      if (file.endsWith('.json')) {
        const c2 = r2.hosts.list().find((h) => h.name === 'cred-host')!;
        expect(r2.hosts.connectInfo(c2.id).auth).toMatchObject({ method: 'PASSWORD', username: 'ops', password: 'cred-pw' });
      }
      db2.close();
    }
    expect(viaCred.authMethod).toBe('CREDENTIAL');
  });
});

describe('录像回放：命令列表和交给 AI 的文字', () => {
  it('按会话和时间取命令', () => {
    let now = 1_000_000;
    const audit = new AuditRepo(db, () => now);
    audit.command({ source: 'USER', hostId: null, hostName: 'h', sessionId: 's1', command: 'df -h' });
    now += 2000;
    audit.command({ source: 'AGENT', hostId: null, hostName: 'h', sessionId: 's1', command: 'uptime', exitCode: 0 });
    audit.command({ source: 'USER', hostId: null, hostName: 'h', sessionId: 's2', command: 'other' });
    now += 999_999;
    audit.command({ source: 'USER', hostId: null, hostName: 'h', sessionId: 's1', command: 'later' });
    expect(audit.sessionCommands('s1', 999_000, 1_010_000)).toEqual([
      { command: 'df -h', source: 'USER', exitCode: null, createdAt: 1_000_000 },
      { command: 'uptime', source: 'AGENT', exitCode: 0, createdAt: 1_002_000 },
    ]);
  });

  it('终端输出转成文字：去掉颜色、回车覆盖、退格；太长时保留开头和结尾', () => {
    expect(terminalText('\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\r\nab\bc\r\n\r\n\r\n\r\nend')).toBe('ok\n100%\nac\n\nend');
    const data: RecordingData = {
      info: { id: 'r', sessionId: 's', kind: 'ssh', hostId: null, hostName: 'web-01', username: 'root', cols: 80, rows: 24, bytes: 0, durationMs: 65_000, truncated: false, startedAt: 0, endedAt: 65_000 },
      cols: 80,
      rows: 24,
      events: [
        [0, 'o', '$ df -h\r\n'],
        [1, 'r', '100x30'],
        [2, 'o', 'x'.repeat(200) + '\r\n'],
      ],
    };
    const t = recordingTranscript(data, [{ offsetMs: 61_000, command: 'df -h', source: 'USER', exitCode: null }, { offsetMs: 62_000, command: 'uptime', source: 'AGENT', exitCode: 0 }], 100);
    expect(t).toContain('主机：web-01（ssh）');
    expect(t).toContain('时长 01:05');
    expect(t).toContain('1. [01:01] df -h');
    expect(t).toContain('2. [01:02]（AGENT） uptime');
    expect(t).toContain('中间省略');
  });
});

describe('命令说明（AI 生成快捷指令的名称和描述）', () => {
  it('解析 JSON，也接受代码块和普通文字', () => {
    expect(parseCommandDescription('{"title": "查看磁盘", "description": "看各分区占用"}', 'df -h')).toEqual({ name: '查看磁盘', description: '看各分区占用' });
    expect(parseCommandDescription('```json\n{"title":"重启 Nginx","description":"会中断连接"}\n```', 'x')).toEqual({ name: '重启 Nginx', description: '会中断连接' });
    expect(parseCommandDescription('标题：查看端口\n说明：列出监听端口', 'ss -lnt')).toEqual({ name: '查看端口', description: '列出监听端口' });
    expect(parseCommandDescription('', 'systemctl status nginx --no-pager')).toEqual({ name: 'systemctl status nginx', description: '' });
  });
});

describe('本地模式不能使用 AI', () => {
  it('模型调用和模型配置都被拦下', () => {
    const repo = new AiProviderRepo(db, vaultKey);
    const p = repo.save(null, { name: 'x', type: 'OPENAI_COMPAT', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', enabled: true, models: [{ id: 'm', contextWindow: 8000, maxOutput: 1000 }] });
    expect(repo.resolve({ providerId: p.id, modelId: 'm' }).model.id).toBe('m');
    repo.setGate(() => '登录后才能使用 AI 功能');
    expect(() => repo.resolve({ providerId: p.id, modelId: 'm' })).toThrow('登录后');
    expect(() => repo.save(p.id, { name: 'y', type: 'OPENAI_COMPAT', baseUrl: 'http://127.0.0.1:9', enabled: true, models: [{ id: 'm', contextWindow: 8000, maxOutput: 1000 }] })).toThrow('登录后');
    expect(() => repo.delete(p.id)).toThrow('登录后');
    // 列表仍然可以看（灰色显示）
    expect(repo.list().length).toBe(1);
  });
});

describe('外观设置', () => {
  it('背景只能用主进程复制进来的文件；字号范围、光标、行高有边界', () => {
    const { settings } = repos;
    settings.set('terminal.background', { kind: 'image', file: 'bg-1a2b3c4d.png', dim: 0.5, blur: 4, fit: 'tile' });
    expect(settings.get('terminal.background')).toMatchObject({ kind: 'image', file: 'bg-1a2b3c4d.png' });
    for (const bad of [
      { kind: 'image', file: '../../etc/passwd', dim: 0.5, blur: 0, fit: 'cover' },
      { kind: 'video', file: 'bg-x.exe', dim: 0.5, blur: 0, fit: 'cover' },
      { kind: 'image', file: 'bg-ok.png', dim: 1, blur: 0, fit: 'cover' },
      { kind: 'image', file: '', dim: 0.5, blur: 0, fit: 'cover' },
    ]) {
      expect(() => settings.set('terminal.background', bad as never)).toThrow();
    }
    expect(() => settings.set('terminal.fontSizeMax', 100)).toThrow();
    expect(() => settings.set('terminal.lineHeight', 3)).toThrow();
    settings.set('terminal.cursorStyle', 'bar');
    settings.set('terminal.localEnv', 'clean');
    expect(settings.getAll()).toMatchObject({ 'terminal.cursorStyle': 'bar', 'terminal.localEnv': 'clean', 'terminal.fontSizeMin': 8, 'terminal.fontSizeMax': 40 });
  });
});

describe('主题：整个软件的配色，终端跟随或单独设置', () => {
  const cfg: TerminalColorSettings = { ...DEFAULT_TERMINAL_COLORS, custom: [] };

  it('应用主题按界面模式取；深浅对不上或方案不存在时用默认主题', () => {
    expect(appThemeScheme(cfg, 'dracula', 'dark').id).toBe('dracula');
    expect(appThemeScheme(cfg, 'github-light', 'dark').id).toBe('itm-dark');
    expect(appThemeScheme(cfg, 'custom-gone', 'light').id).toBe('itm-light');
  });

  it('跟随（默认，旧设置没有 follow 也算）：终端用主题配套的方案；iTerminal 浅色主题的终端是 MobaXterm', () => {
    expect(terminalSchemeFor(cfg, 'tokyo-night', 'dark').id).toBe('tokyo-night');
    expect(terminalSchemeFor(cfg, 'one-light', 'light').id).toBe('one-light');
    expect(terminalSchemeFor(cfg, 'itm-light', 'light').id).toBe('mobaxterm');
    const legacy = { dark: 'gruvbox-dark', light: 'solarized-light', custom: [] } as TerminalColorSettings;
    expect(terminalSchemeFor(legacy, 'dracula', 'dark').id).toBe('dracula');
  });

  it('单独设置：和应用主题无关，按界面模式取 dark / light', () => {
    const own: TerminalColorSettings = { ...cfg, follow: false, dark: 'gruvbox-dark', light: 'mobaxterm' };
    expect(terminalSchemeFor(own, 'dracula', 'dark').id).toBe('gruvbox-dark');
    expect(terminalSchemeFor(own, 'github-light', 'light').id).toBe('mobaxterm');
  });

  it('设置校验：主题 ID 和 follow', () => {
    const { settings } = repos;
    settings.set('ui.themeDark', 'tokyo-night');
    settings.set('ui.themeLight', 'custom-abc123');
    expect(() => settings.set('ui.themeDark', '../x' as never)).toThrow();
    settings.set('terminal.colors', { ...cfg, follow: false });
    expect(() => settings.set('terminal.colors', { ...cfg, follow: 'yes' } as never)).toThrow();
    expect(settings.getAll()).toMatchObject({ 'ui.themeDark': 'tokyo-night', 'ui.themeLight': 'custom-abc123', 'terminal.colors': { follow: false } });
  });
});
