import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IpcEventName, IpcEvents, PromptAnswer, PromptRequest } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import type { HostRepo } from '../src/main/services/hosts/host-repo';
import { PromptBroker } from '../src/main/services/connection/prompt-broker';
import { SshPool } from '../src/main/services/connection/ssh-pool';
import { combine, parseHistory, parseRemote, ShellHistoryService, unmetafy } from '../src/main/services/ai/shell-history';
import { CompletionService, mergeHistory } from '../src/main/services/ai/completion-service';
import { checkExecutable, parseExecCheck } from '../src/main/services/connection/file-check';
import { AiProviderRepo } from '../src/main/services/ai/provider-repo';
import type { AgentRuntime } from '../src/main/services/ai/runtime';
import type { SessionManager } from '../src/main/services/connection/session-manager';
import { absoluteOf, isShPath, shCommands } from '../src/renderer/src/util/sh-exec';
import { createRepos } from './support/repos';
import { startTestSshServer, type TestSshServer } from './support/ssh-server';

const OWNER = 3;

describe('shell 历史文件解析', () => {
  it('bash：跳过时间戳行；zsh：去掉扩展格式前缀、拼回多行命令；fish', () => {
    expect(parseHistory('ls -la\n#1700000000\ndf -h\n\n', 'bash')).toEqual(['ls -la', 'df -h']);
    expect(parseHistory(': 1700000000:0;git status\n: 1700000001:0;for i in 1 2; do\\\necho $i\\\ndone\nplain\n', 'zsh')).toEqual(['git status', 'for i in 1 2; do\necho $i\ndone', 'plain']);
    expect(parseHistory('- cmd: ls /tmp\n  when: 1700000000\n- cmd: echo a\\nb\n  when: 1700000001\n', 'fish')).toEqual(['ls /tmp', 'echo a\nb']);
  });

  it('zsh 的 metafy 字节还原成 UTF-8（中文命令不乱码）', () => {
    const raw = Buffer.from('echo 中文', 'utf8');
    const meta: number[] = [];
    for (const b of raw) if (b >= 0x83 && b <= 0xa2) meta.push(0x83, b ^ 0x20);
    else meta.push(b);
    expect(unmetafy(Buffer.from(meta)).toString('utf8')).toBe('echo 中文');
  });

  it('合并多个历史文件：新文件在后、整体最近的在前、去重保留最近一次', () => {
    const r = combine([
      { path: '/h/.zsh_history', mtime: 2000, text: ': 1:0;docker ps\n: 2:0;uptime\n' },
      { path: '/h/.bash_history', mtime: 1000, text: 'ls\ndocker ps\nfree -m\n' },
    ]);
    expect(r.entries).toEqual(['uptime', 'docker ps', 'free -m', 'ls']);
    expect(r.mtime).toBe(2000);
  });

  it('解析远端脚本的输出（base64 和明文两种）', () => {
    const b64 = Buffer.from('ls\ncat /etc/hosts\n').toString('base64');
    const out = `\n@@ITM-HIST b64 1700000000 /root/.bash_history\n${b64}\n\n@@ITM-HIST raw 1700000100 /root/.zsh_history\n: 1:0;top\n`;
    const files = parseRemote(out);
    expect(files.map((f) => [f.path, f.mtime])).toEqual([
      ['/root/.bash_history', 1700000000000],
      ['/root/.zsh_history', 1700000100000],
    ]);
    expect(combine(files).entries).toEqual(['top', 'cat /etc/hosts', 'ls']);
  });

  it('和 iTerminal 的记录合并：比历史文件新的记录在最前，其次 shell 历史，最后是只有 iTerminal 记过的', () => {
    const app = [
      { command: 'systemctl restart nginx', count: 2, lastUsed: 5000 },
      { command: 'docker ps', count: 3, lastUsed: 900 },
      { command: 'old-only', count: 1, lastUsed: 100 },
    ];
    const items = mergeHistory(app, ['uptime', 'docker ps', 'ls'], 1000);
    expect(items.map((i) => [i.command, i.source])).toEqual([
      ['systemctl restart nginx', 'app'],
      ['uptime', 'shell'],
      ['docker ps', 'shell'],
      ['ls', 'shell'],
      ['old-only', 'app'],
    ]);
    expect(items[2].count).toBe(3);
    // 没有 shell 历史：只有 iTerminal 的记录
    expect(mergeHistory(app, null, null).map((i) => i.command)).toEqual(['systemctl restart nginx', 'docker ps', 'old-only']);
  });
});

describe('历史命令服务（本机文件 + 远端 SSH）', () => {
  let dir: string;
  let db: Db;
  let hosts: HostRepo;
  let broker: PromptBroker;
  let pool: SshPool;
  let ssh: TestSshServer | null = null;
  let now = 1_700_000_000_000;

  function emit<E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void {
    if (event !== 'prompt.request') return;
    const req = payload as PromptRequest;
    const answer: PromptAnswer = req.kind === 'hostKey' ? { kind: 'hostKey', accept: true } : { kind: 'password', value: 'pw', remember: false };
    setTimeout(() => broker.answer(owner, req.promptId, answer), 1);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'itm-r33-'));
    db = openDatabase(join(dir, 'db'), randomBytes(32));
    ({ hosts } = createRepos(db, randomBytes(32)));
    broker = new PromptBroker(emit);
    pool = new SshPool(hosts, broker, 5000);
  });
  afterEach(async () => {
    pool.closeAll();
    await ssh?.close();
    ssh = null;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function completion(shell: ShellHistoryService): CompletionService {
    const key = randomBytes(32);
    const repos = createRepos(db, key);
    const runtime = { complete: async () => null } as unknown as AgentRuntime;
    const sessions = { recentOutput: () => null } as unknown as SessionManager;
    return new CompletionService(db, hosts, sessions, repos.settings, new AiProviderRepo(db, key), runtime, () => now, undefined, shell);
  }

  it('本机：读 ~/.bash_history，分页、搜索；输入提示里 shell 历史排在前面，带密码的命令不显示', async () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    const lines = Array.from({ length: 250 }, (_, i) => `echo line-${i}`);
    writeFileSync(join(home, '.bash_history'), [...lines, 'mysql -uroot -pSecret123', 'git status', 'git log --oneline'].join('\n') + '\n');
    const shell = new ShellHistoryService(pool, () => true, () => now, () => [join(home, '.bash_history'), join(home, '.zsh_history')]);
    const svc = completion(shell);
    const p1 = await svc.history(OWNER, null, { limit: 100 });
    expect(p1.total).toBe(252);
    expect(p1.items).toHaveLength(100);
    expect(p1.items[0]).toEqual({ command: 'git log --oneline', source: 'shell' });
    expect(p1.shell?.files).toEqual([join(home, '.bash_history')]);
    const p3 = await svc.history(OWNER, null, { offset: 200, limit: 100 });
    expect(p3.items).toHaveLength(52);
    expect(p3.items.at(-1)?.command).toBe('echo line-0');
    expect(p1.items.some((i) => i.command.includes('Secret123'))).toBe(false);
    expect((await svc.history(OWNER, null, { q: 'line-24' })).items.map((i) => i.command)).toEqual(['echo line-249', 'echo line-248', 'echo line-247', 'echo line-246', 'echo line-245', 'echo line-244', 'echo line-243', 'echo line-242', 'echo line-241', 'echo line-240', 'echo line-24']);
    // iTerminal 刚记录的命令（比历史文件新，bash 还没写进文件）排在最前，然后是 shell 历史里最近的
    now = Date.now() + 60_000;
    svc.record(null, 'git checkout main');
    expect((await svc.matches(OWNER, null, 'git ')).history).toEqual(['git checkout main', 'git log --oneline', 'git status']);
  });

  it('远端：通过 exec 通道读 ~/.bash_history 和 ~/.zsh_history（HOME 是测试目录）；不是已连接的主机不在后台读取', async () => {
    const root = join(dir, 'remote');
    mkdirSync(root);
    writeFileSync(join(root, '.bash_history'), 'ls -l\nuptime\n');
    writeFileSync(join(root, '.zsh_history'), ': 1700000000:0;tail -f /var/log/messages\n: 1700000001:0;uptime\n');
    ssh = await startTestSshServer({ root });
    const hostId = hosts.create({
      folderId: null,
      name: 'box',
      address: '127.0.0.1',
      port: ssh.port,
      username: 'tester',
      authMethod: 'PASSWORD',
      password: 'pw',
      keepaliveSec: 0,
      startupScript: null,
      note: null,
      jumpHostIds: [],
    }).id;
    const shell = new ShellHistoryService(pool, () => true, () => now);
    expect(shell.canPrefetch(hostId)).toBe(false);
    expect(await shell.quick(OWNER, hostId, 100)).toBeNull();
    const conn = await pool.acquire(hostId, OWNER);
    try {
      expect(shell.canPrefetch(hostId)).toBe(true);
      const h = await shell.load(OWNER, hostId);
      expect(h.error).toBeUndefined();
      expect(h.files.sort()).toEqual([join(root, '.bash_history'), join(root, '.zsh_history')].sort());
      expect(new Set(h.entries)).toEqual(new Set(['ls -l', 'uptime', 'tail -f /var/log/messages']));
      // 执行权限检查
      writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho hi\n');
      writeFileSync(join(root, 'noexec.sh'), 'echo hi\n');
      chmodSync(join(root, 'run.sh'), 0o755);
      chmodSync(join(root, 'noexec.sh'), 0o644);
      expect(await checkExecutable(pool, OWNER, hostId, join(root, 'run.sh'))).toEqual({ exists: true, isFile: true, executable: true });
      expect(await checkExecutable(pool, OWNER, hostId, join(root, 'noexec.sh'))).toEqual({ exists: true, isFile: true, executable: false });
      expect(await checkExecutable(pool, OWNER, hostId, '~/run.sh')).toEqual({ exists: true, isFile: true, executable: true });
      expect(await checkExecutable(pool, OWNER, hostId, join(root, 'missing.sh'))).toEqual({ exists: false, isFile: false, executable: false });
      expect(await checkExecutable(pool, OWNER, hostId, root)).toEqual({ exists: true, isFile: false, executable: false });
    } finally {
      pool.release(conn);
    }
  });

  it('本机文件的执行权限检查', async () => {
    const f = join(dir, 'a.sh');
    writeFileSync(f, 'echo hi\n');
    chmodSync(f, 0o644);
    expect(await checkExecutable(pool, OWNER, null, f)).toEqual({ exists: true, isFile: true, executable: false });
    chmodSync(f, 0o755);
    expect(await checkExecutable(pool, OWNER, null, f)).toEqual({ exists: true, isFile: true, executable: true });
    expect(parseExecCheck('motd\nX\n')).toEqual({ exists: true, isFile: true, executable: true });
    expect(parseExecCheck('')).toEqual({ exists: false, isFile: false, executable: false });
  });
});

describe('执行 .sh 脚本的命令', () => {
  it('识别终端里选中的脚本路径', () => {
    expect(isShPath('deploy.sh')).toBe(true);
    expect(isShPath(' ./bin/start.sh \n')).toBe(true);
    expect(isShPath('~/tools/x.SH')).toBe(true);
    expect(isShPath('rm -rf /; a.sh')).toBe(false);
    expect(isShPath('my file.sh')).toBe(false);
    expect(isShPath('$(curl x).sh')).toBe(false);
    expect(isShPath('run.py')).toBe(false);
  });

  it('到目录下执行 / 直接执行；没有执行权限时 chmod 或 bash；相对路径按终端当前目录', () => {
    expect(shCommands('/opt/app/deploy.sh', null)).toEqual({ inDir: 'cd /opt/app && ./deploy.sh', direct: '/opt/app/deploy.sh' });
    expect(shCommands('/opt/my app/a b.sh', null)).toEqual({ inDir: "cd '/opt/my app' && ./'a b.sh'", direct: "'/opt/my app/a b.sh'" });
    expect(shCommands('/run.sh', null).inDir).toBe('cd / && ./run.sh');
    expect(shCommands('/opt/app/deploy.sh', null, 'chmod')).toEqual({ inDir: 'cd /opt/app && chmod u+x ./deploy.sh && ./deploy.sh', direct: 'chmod u+x /opt/app/deploy.sh && /opt/app/deploy.sh' });
    expect(shCommands('/opt/app/deploy.sh', null, 'bash')).toEqual({ inDir: 'cd /opt/app && bash ./deploy.sh', direct: 'bash /opt/app/deploy.sh' });
    expect(shCommands('bin/start.sh', '/srv/www')).toEqual({ inDir: 'cd /srv/www/bin && ./start.sh', direct: '/srv/www/bin/start.sh' });
    expect(shCommands('../x.sh', '/srv/www').direct).toBe('/srv/x.sh');
    expect(shCommands('x.sh', null)).toEqual({ inDir: './x.sh', direct: './x.sh' });
    expect(shCommands('bin/x.sh', null)).toEqual({ inDir: 'cd bin && ./x.sh', direct: 'bin/x.sh' });
    expect(shCommands('~/s/x.sh', null).inDir).toBe('cd ~/s && ./x.sh');
    expect(absoluteOf('a.sh', '/home/u/')).toBe('/home/u/a.sh');
  });
});
