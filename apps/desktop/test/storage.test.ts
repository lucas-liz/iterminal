import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isShortcutMap, isValidCombo } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { NoteRepo } from '../src/main/services/library/note-repo';
import { NoteFileMirror } from '../src/main/services/library/note-files';
import { RecordingStore } from '../src/main/services/audit/recording-store';
import { applyDataLocation, dirSize, scheduleDataMove } from '../src/main/app/data-location';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-storage-'));
  db = openDatabase(join(dir, 'db'), randomBytes(32));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('笔记的上一个版本', () => {
  it('只在 snapshot 时记录（编辑过程中的自动保存不覆盖），撤回是互换', () => {
    const notes = new NoteRepo(db);
    const n = notes.save(null, { groupId: null, title: 'a', content: 'v1' });
    expect(n.hasPrev).toBe(false);
    expect(() => notes.revert(n.id)).toThrow('没有可以撤回的版本');
    notes.save(n.id, { groupId: null, title: 'a', content: 'v2', snapshot: true });
    notes.save(n.id, { groupId: null, title: 'a', content: 'v3' });
    expect(notes.get(n.id)).toMatchObject({ content: 'v3', hasPrev: true });
    expect(notes.revert(n.id)).toMatchObject({ content: 'v1' });
    expect(notes.revert(n.id)).toMatchObject({ content: 'v3' });
    // 内容没变时不覆盖上一个版本
    notes.save(n.id, { groupId: null, title: 'a', content: 'v3', snapshot: true });
    expect(notes.revert(n.id).content).toBe('v1');
  });
});

describe('笔记保存为 Markdown 文件', () => {
  it('按「分组 / 标题.md」写入；改标题删旧文件，删除笔记删文件，重名加序号', () => {
    const notes = new NoteRepo(db);
    const out = join(dir, 'notes');
    const mirror = new NoteFileMirror(notes, () => out);
    notes.onChange = (ids) => mirror.sync(ids);
    // 开启前已有的笔记：exportAll 导出
    const a = notes.save(null, { groupId: null, title: '巡检', content: '# 巡检' });
    expect(existsSync(out)).toBe(true);
    const gid = notes.groups.save(null, '运维');
    const b = notes.save(null, { groupId: gid, title: 'a/b:c', content: 'x' });
    const c = notes.save(null, { groupId: null, title: '巡检', content: '另一篇' });
    expect(readFileSync(join(out, '巡检.md'), 'utf8')).toBe('# 巡检\n');
    expect(readFileSync(join(out, '巡检 (2).md'), 'utf8')).toBe('另一篇\n');
    expect(readFileSync(join(out, '运维', 'a_b_c.md'), 'utf8')).toBe('x\n');
    notes.save(a.id, { groupId: null, title: '巡检记录', content: '# 巡检' });
    expect(existsSync(join(out, '巡检.md'))).toBe(false);
    expect(existsSync(join(out, '巡检记录.md'))).toBe(true);
    notes.delete([b.id]);
    expect(existsSync(join(out, '运维'))).toBe(false);
    notes.delete([c.id]);
    expect(readdirSync(out).sort()).toEqual(['.iterminal-notes.json', '巡检记录.md']);
    // 换一个目录：全部导出
    const out2 = join(dir, 'notes2');
    expect(mirror.exportAll(out2)).toBe(1);
    expect(readFileSync(join(out2, '巡检记录.md'), 'utf8')).toBe('# 巡检\n');
  });
});

describe('录像目录', () => {
  it('自定义目录写入绝对路径；moveAll 把已有录像移过去，仍然可以回放', () => {
    const store = new RecordingStore(db, dir, randomBytes(32));
    const r1 = store.start({ sessionId: 's1', kind: 'ssh', hostId: null, hostName: 'web', cols: 80, rows: 24 });
    r1.output('hello\r\n');
    r1.end();
    const id1 = store.list().items[0].id;
    expect(store.root()).toBe(join(dir, 'recordings'));
    const custom = join(dir, 'big-disk', 'rec');
    store.setRoot(() => custom);
    const r2 = store.start({ sessionId: 's2', kind: 'ssh', hostId: null, hostName: 'db', cols: 80, rows: 24 });
    r2.output('world\r\n');
    r2.end();
    const id2 = store.list().items.find((i) => i.id !== id1)!.id;
    expect(readdirSync(custom).length).toBe(1);
    expect(store.readCast(id2)).toContain('world');
    expect(store.moveAll(custom)).toEqual({ moved: 1, failed: 0 });
    expect(existsSync(join(dir, 'recordings'))).toBe(true);
    expect(store.readCast(id1)).toContain('hello');
    expect(store.diskUsage()).toBeGreaterThan(0);
    // 回到默认目录
    store.setRoot(() => '');
    expect(store.moveAll('')).toEqual({ moved: 2, failed: 0 });
    expect(store.readCast(id1)).toContain('hello');
    expect(store.readCast(id2)).toContain('world');
  });
});

describe('本地数据目录', () => {
  it('写入待迁移后，下次启动复制数据并切换；原目录保留；可以回到默认目录', async () => {
    const def = join(dir, 'userData');
    mkdirSync(join(def, 'profiles', 'p1'), { recursive: true });
    writeFileSync(join(def, 'profiles', 'p1', 'iterminal.db'), 'db');
    writeFileSync(join(def, 'SingletonLock'), 'lock');
    expect(applyDataLocation(def)).toBe(def);
    const target = join(dir, 'Data', 'iTerminal');
    // 非空目录不行
    mkdirSync(join(dir, 'busy'));
    writeFileSync(join(dir, 'busy', 'x'), '1');
    expect(() => scheduleDataMove(def, def, join(dir, 'busy'))).toThrow('空目录');
    expect(() => scheduleDataMove(def, def, join(def, 'sub'))).toThrow('里面');
    scheduleDataMove(def, def, target);
    expect(applyDataLocation(def)).toBe(target);
    expect(readFileSync(join(target, 'profiles', 'p1', 'iterminal.db'), 'utf8')).toBe('db');
    expect(existsSync(join(target, 'SingletonLock'))).toBe(false);
    expect(existsSync(join(def, 'profiles', 'p1', 'iterminal.db'))).toBe(true);
    // 之后的启动直接使用新目录
    expect(applyDataLocation(def)).toBe(target);
    expect(await dirSize(target)).toBe(2);
    // 回到默认目录：新目录里的改动复制回来
    writeFileSync(join(target, 'profiles', 'p1', 'iterminal.db'), 'db2');
    scheduleDataMove(def, target, null);
    expect(applyDataLocation(def)).toBe(def);
    expect(readFileSync(join(def, 'profiles', 'p1', 'iterminal.db'), 'utf8')).toBe('db2');
    expect(existsSync(join(def, 'data-location.json'))).toBe(false);
  });
});

describe('快捷键设置', () => {
  it('组合键需要修饰键（功能键除外），不能重复修饰键', () => {
    expect(isValidCombo('Mod+Shift+A')).toBe(true);
    expect(isValidCombo('F5')).toBe(true);
    expect(isValidCombo('')).toBe(true);
    expect(isValidCombo('A')).toBe(false);
    expect(isValidCombo('Mod+Mod+A')).toBe(false);
    expect(isValidCombo('Mod+Shift')).toBe(false);
    expect(isValidCombo('Mod++')).toBe(true);
    expect(isShortcutMap({ toggleMode: 'Mod+K', termSearch: '' })).toBe(true);
    expect(isShortcutMap({ nope: 'Mod+K' })).toBe(false);
    expect(isShortcutMap({ toggleMode: 'K' })).toBe(false);
  });
});
