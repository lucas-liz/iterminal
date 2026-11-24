import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { RecordingStore } from '../src/main/services/audit/recording-store';
import { AuditRepo } from '../src/main/services/audit/audit-repo';

let dir: string;
let db: Db;
let now = 1_800_000_000_000;
const clock = () => now;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-audit-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('会话录像（asciicast v2，加密落盘）', () => {
  it('记录输出和窗口变化，回放数据完整；文件里没有明文；其他档案的密钥解不开', () => {
    const key = randomBytes(32);
    const store = new RecordingStore(db, dir, key, clock);
    const rec = store.start({ sessionId: 's1', kind: 'ssh', hostId: 'h1', hostName: 'web-01', cols: 80, rows: 24 });
    rec.output('welcome to web-01\r\n$ ');
    now += 1500;
    rec.output('df -h\r\n/dev/sda1  40G  12G  28G  30% /\r\n');
    now += 500;
    rec.resize(120, 40);
    rec.end();
    const list = store.list();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ hostName: 'web-01', kind: 'ssh', durationMs: 2000, truncated: false });
    expect(list.items[0].endedAt).not.toBeNull();
    const data = store.read(list.items[0].id);
    expect(data).toMatchObject({ cols: 80, rows: 24 });
    expect(data.events.map((e) => [e[0], e[1]])).toEqual([
      [0, 'o'],
      [1.5, 'o'],
      [2, 'r'],
    ]);
    expect(data.events[2][2]).toBe('120x40');
    // 标准 asciicast 第一行是 header
    const cast = store.readCast(list.items[0].id).split('\n');
    expect(JSON.parse(cast[0])).toMatchObject({ version: 2, width: 80, height: 24, title: 'web-01' });
    // 文件是加密的
    const files = readdirSync(join(dir, 'recordings'), { recursive: true }).map(String).filter((f) => f.endsWith('.itmrec'));
    const raw = readFileSync(join(dir, 'recordings', files[0]));
    expect(raw.includes(Buffer.from('df -h'))).toBe(false);
    expect(raw.subarray(0, 8).toString()).toBe('ITMREC1\n');
    const other = new RecordingStore(db, dir, randomBytes(32), clock);
    expect(() => other.read(list.items[0].id)).toThrow('录像无法解密');
  });

  it('按保留天数清理；录制中的不能删除', () => {
    const store = new RecordingStore(db, dir, randomBytes(32), clock);
    const old = store.start({ sessionId: 'a', kind: 'telnet', hostId: null, hostName: 'switch', cols: 80, rows: 24 });
    old.output('x');
    old.end();
    now += 31 * 86_400_000;
    const live = store.start({ sessionId: 'b', kind: 'ssh', hostId: null, hostName: 'db', cols: 80, rows: 24 });
    expect(store.cleanup(30)).toBe(1);
    expect(store.list().items.map((r) => r.hostName)).toEqual(['db']);
    expect(() => store.delete([store.list().items[0].id])).toThrow('还在录制中');
    live.end();
    store.delete([store.list().items[0].id]);
    expect(store.list().total).toBe(0);
  });

  it('账号模式：还没上传到服务端的录像过期也先保留', () => {
    const store = new RecordingStore(db, dir, randomBytes(32), clock);
    for (const name of ['uploaded', 'pending']) {
      const r = store.start({ sessionId: name, kind: 'ssh', hostId: null, hostName: name, cols: 80, rows: 24 });
      r.output('x');
      r.end();
    }
    const up = store.list().items.find((r) => r.hostName === 'uploaded')!;
    db.prepare('UPDATE session_recording SET uploaded = 1 WHERE id = ?').run(up.id);
    now += 31 * 86_400_000;
    expect(store.cleanup(30, true)).toBe(1);
    expect(store.list().items.map((r) => r.hostName)).toEqual(['pending']);
    expect(store.cleanup(30)).toBe(1);
    expect(store.list().total).toBe(0);
  });

  it('退出时先结束所有录像再关数据库；数据库关闭后会话才结束也不会抛异常', () => {
    const store = new RecordingStore(db, dir, randomBytes(32), clock);
    const a = store.start({ sessionId: 'a', kind: 'ssh', hostId: null, hostName: 'web', cols: 80, rows: 24 });
    a.output('hello');
    store.endAll();
    expect(store.list().items[0].endedAt).not.toBeNull();
    expect(store.read(store.list().items[0].id).events).toHaveLength(1);
    a.end();
    // 数据库已经关闭（退出过程中连接异步断开）
    const b = store.start({ sessionId: 'b', kind: 'local', hostId: null, hostName: '本机', cols: 80, rows: 24 });
    b.output('late');
    db.close();
    expect(() => b.end()).not.toThrow();
    db = openDatabase(join(dir, 'db2'), randomBytes(32));
  });
});

describe('本地审计查询', () => {
  it('按类型、来源、风险、关键词、时间过滤；保留天数清理', () => {
    const audit = new AuditRepo(db, clock);
    audit.command({ source: 'USER', hostId: 'h1', hostName: 'web-01', command: 'systemctl status nginx' });
    now += 1000;
    audit.command({ source: 'AGENT', hostId: 'h1', hostName: 'web-01', command: 'rm -rf /tmp/cache', risk: 'L2', decision: 'APPROVED', exitCode: 0 });
    audit.event('CREDENTIAL_REVEAL', { name: '生产 root' });
    expect(audit.list({ kind: 'COMMAND' }).total).toBe(2);
    expect(audit.list({ kind: 'COMMAND', source: 'AGENT' }).items.map((e) => e.command)).toEqual(['rm -rf /tmp/cache']);
    expect(audit.list({ kind: 'COMMAND', risk: 'L2' }).total).toBe(1);
    expect(audit.list({ kind: 'COMMAND', q: 'nginx' }).items[0]).toMatchObject({ source: 'USER', hostName: 'web-01' });
    expect(audit.list({ kind: 'COMMAND', q: '100%_' }).total).toBe(0);
    expect(audit.list({ kind: 'EVENT' }).items[0]).toMatchObject({ eventType: 'CREDENTIAL_REVEAL', detail: { name: '生产 root' } });
    expect(audit.list({ kind: 'COMMAND', from: now }).total).toBe(1);
    now += 31 * 86_400_000;
    expect(audit.cleanup(30)).toBe(3);
  });
});
