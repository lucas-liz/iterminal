import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyDataset, planMerge } from '@itm/sync-merge';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { NoteRepo } from '../src/main/services/library/note-repo';
import { importNoteFiles, noteFromFile } from '../src/main/services/library/note-import';
import { SkillStore } from '../src/main/services/ai/skills';
import { DatasetStore } from '../src/main/services/sync/dataset-store';
import { SyncService } from '../src/main/services/sync/sync-service';
import { sanitizeDataset } from '../src/main/services/sync/sanitize';
import { pickForImport, pickForShare, shareContent } from '../src/main/services/sync/share-pick';
import { createRepos } from './support/repos';

/**
 * 第二十二轮：笔记从 Markdown 文件导入、Skill 可以备份和分享（新的 SKILLS 分组）。
 */
let root: string;
const opened: Db[] = [];
let now = 1_700_000_000_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'itm-r22-'));
});
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(root, { recursive: true, force: true });
});

function profile(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const vaultKey = randomBytes(32);
  const db = openDatabase(join(root, `${name}.db`), randomBytes(32));
  opened.push(db);
  const clock = () => now;
  const repos = createRepos(db, vaultKey, clock);
  const notes = new NoteRepo(db, clock);
  const skills = new SkillStore(join(dir, 'skills'));
  const store = new DatasetStore(db, vaultKey, { credentials: repos.credentials, tags: repos.tags, skills }, clock);
  const sync = new SyncService({ db, store, settings: repos.settings, vaultKey, dir, clientVersion: '1.0.1', now: () => (now += 1000) });
  return { db, dir, notes, skills, store, sync };
}

const skillMd = (name: string, desc: string, body = '1. 看磁盘') => `---\nname: ${name}\ntitle: ${desc}\ndescription: ${desc}\n---\n\n${body}\n`;

describe('笔记：从 Markdown 文件导入', () => {
  it('标题依次取 front matter 的 title、开头的一级标题、文件名；正文原样保留；txt 是纯文本', () => {
    expect(noteFromFile('a.md', '---\ntitle: 发布手册\ntags: [ops]\n---\n# 别的标题\n正文')).toMatchObject({ title: '发布手册', format: 'MARKDOWN', content: '---\ntitle: 发布手册\ntags: [ops]\n---\n# 别的标题\n正文' });
    expect(noteFromFile('b.md', '﻿\r\n# 排障记录 #\r\n- 第一步\r\n')).toMatchObject({ title: '排障记录', content: '\n# 排障记录 #\n- 第一步\n' });
    expect(noteFromFile('交接说明.markdown', '## 二级标题不算\n内容').title).toBe('交接说明');
    expect(noteFromFile('readme.txt', 'plain')).toMatchObject({ title: 'readme', format: 'TEXT' });
    expect(noteFromFile('坏的.md', '---\n: : :\n---\n# 好标题').title).toBe('好标题');
  });

  it('批量导入到指定分组；不支持的、太大的、不存在的文件跳过并说明原因', async () => {
    const p = profile('notes');
    const gid = p.notes.groups.save(null, '手册');
    const src = join(root, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'deploy.md'), '# 发布流程\n1. 打包');
    writeFileSync(join(src, 'tips.txt'), 'vim 技巧');
    writeFileSync(join(src, 'image.png'), 'x');
    writeFileSync(join(src, 'huge.md'), 'x'.repeat(1024 * 1024 + 1));
    const r = await importNoteFiles(p.notes, [join(src, 'deploy.md'), join(src, 'tips.txt'), join(src, 'image.png'), join(src, 'huge.md'), join(src, 'missing.md')], gid);
    expect(r.notes.map((n) => [n.title, n.format, n.groupId])).toEqual([
      ['发布流程', 'MARKDOWN', gid],
      ['tips', 'TEXT', gid],
    ]);
    expect(r.skipped.map((s) => s.name)).toEqual(['image.png', 'huge.md', 'missing.md']);
    expect(r.skipped[0].reason).toContain('不是 Markdown');
    expect(r.skipped[1].reason).toContain('1MB');
    expect(p.notes.list().find((n) => n.title === '发布流程')?.content).toBe('# 发布流程\n1. 打包');
  });
});

describe('Skill 的备份和分享（SKILLS 分组）', () => {
  it('导出 / 导入：带上全部 Skill；合并时同名的保留本机；覆盖时删掉本机多出来的', async () => {
    const a = profile('a');
    a.skills.save(null, skillMd('disk-report', '磁盘报告'));
    a.skills.save(null, skillMd('nginx-check', '我写的 Nginx 检查', '自定义步骤'));
    expect(a.store.counts().skills).toBe(2);
    const file = join(root, 'skills.itmbak');
    const info = await a.sync.export(['SKILLS'], file, 'export-pass');
    expect(info).toMatchObject({ groups: ['SKILLS'] });
    expect(info.counts.skills).toBe(2);

    const b = profile('b');
    b.skills.save(null, skillMd('my-own', '本机自己的'));
    b.skills.save(null, skillMd('nginx-check', '本机的 Nginx 检查'));
    const preview = await b.sync.import(file, 'export-pass', ['SKILLS'], 'merge', true);
    expect(preview.perType.skills).toEqual({ added: 1, kept: 1, filled: 0 });
    expect(b.skills.get('disk-report')).toBeNull();
    await b.sync.import(file, 'export-pass', ['SKILLS'], 'merge', false);
    expect(b.skills.get('disk-report')?.title).toBe('磁盘报告');
    expect(b.skills.get('nginx-check')?.title).toBe('本机的 Nginx 检查');

    // 覆盖本地：多出来的 my-own 删除；同名的改成文件里的版本
    const replace = await b.sync.import(file, 'export-pass', ['SKILLS'], 'replace', false);
    expect(replace.perType.skills).toMatchObject({ removed: 1 });
    expect(b.skills.get('my-own')).toBeNull();
    expect(b.skills.read('nginx-check')).toContain('自定义步骤');
    expect(b.skills.list().map((s) => s.id)).toEqual(['disk-report', 'nginx-check']);

    const auto = b.sync.autoList()[0];
    expect(auto.groups).toContain('SKILLS');
  });

  it('没有自己的 Skill 时上云的包不带 SKILLS 分组（还没升级的服务端不认识）', () => {
    const p = profile('empty');
    expect(p.store.counts().skills).toBe(0);
    expect(p.sync.packageData(['NOTES', 'SKILLS']).groups).toEqual(['NOTES']);
    p.skills.save(null, skillMd('x-1', 'x'));
    expect(p.sync.packageData(['NOTES', 'SKILLS']).groups).toEqual(['NOTES', 'SKILLS']);
  });

  it('单项分享：选中的 Skill 进分享包；拉取方逐个勾选；本机同名的保留本机', () => {
    const p = profile('share');
    p.skills.save(null, skillMd('nginx-reload', 'Nginx 平滑重载'));
    p.skills.save(null, skillMd('jvm-dump', 'JVM 堆转储'));
    const all = p.store.load(['SKILLS'], false);
    const r = pickForShare(all, { skillIds: ['nginx-reload'] }, { includeCredentials: false, teamFolderIds: new Set() });
    expect(r.groups).toEqual(['SKILLS']);
    expect(r.preview.title).toBe('Skill Nginx 平滑重载');
    expect(r.preview.skills).toEqual([{ id: 'nginx-reload', title: 'Nginx 平滑重载' }]);
    expect(r.data.skills.map((s) => s.id)).toEqual(['nginx-reload']);

    const body = JSON.parse(JSON.stringify(r.data));
    const incoming = sanitizeDataset(body, r.groups);
    const content = shareContent(incoming, { ownerUsername: 'u', ownerDisplayName: 'U', groups: r.groups, counts: {} as never, size: 1, updatedAt: null, deviceName: 'd', platform: 'mac', clientVersion: '1' });
    expect(content.skills).toEqual([{ id: 'nginx-reload', title: 'Nginx 平滑重载', description: 'Nginx 平滑重载' }]);
    expect(pickForImport(incoming, { hostIds: [], credentialIds: [], snippetIds: [], noteIds: [], skillIds: [], withGroups: true, withCredentials: false }).groups).toEqual([]);
    const picked = pickForImport(incoming, { hostIds: [], credentialIds: [], snippetIds: [], noteIds: [], skillIds: ['nginx-reload'], withGroups: true, withCredentials: false });
    expect(picked.groups).toEqual(['SKILLS']);

    // 拉取方本机有同名的：保留本机；没有的新增（id 就是名称，不换成新 id）
    const local = emptyDataset();
    local.skills = [{ id: 'NGINX-reload', content: '---\nname: NGINX-reload\n---', updatedAt: 1 }];
    const kept = planMerge(local, picked.data, { source: { kind: 'share', ownerId: 'u', importMap: new Map() }, groups: ['SKILLS'] });
    expect(kept.report.perType.skills).toEqual({ added: 0, kept: 1, filled: 0 });
    const added = planMerge(emptyDataset(), picked.data, { source: { kind: 'share', ownerId: 'u', importMap: new Map() }, groups: ['SKILLS'] });
    expect(added.ops).toEqual([{ op: 'add', type: 'skills', item: expect.objectContaining({ id: 'nginx-reload' }) }]);
  });

  it('对方的包逐项校验：名称不合法、没有 front matter、太大的 Skill 丢弃', () => {
    const big = `---\nname: big\n---\n${'x'.repeat(256 * 1024)}`;
    const d = sanitizeDataset(
      { skills: [{ id: '../etc', content: '---\nname: x\n---' }, { id: 'ok-1', content: '---\nname: ok-1\n---\nbody', builtin: true }, { id: 'nofm', content: 'no front matter' }, { id: 'big', content: big }] },
      ['SKILLS'],
    );
    expect(d.skills.map((s) => s.id)).toEqual(['ok-1']);
    expect(Object.keys(d.skills[0]).sort()).toEqual(['content', 'id', 'updatedAt']);
  });

  it('写入 Skill 文件：在数据库事务成功以后（事务失败时不写）', () => {
    const p = profile('tx');
    const data = emptyDataset();
    data.skills = [{ id: 'after-commit', content: skillMd('after-commit', 'x'), updatedAt: 1 }];
    p.store.applyMerge([{ op: 'add', type: 'skills', item: data.skills[0] }], false, null);
    expect(existsSync(join(p.dir, 'skills', 'after-commit'))).toBe(false);
    p.store.discardFiles();
    expect(p.store.flushFiles()).toEqual([]);
    expect(existsSync(join(p.dir, 'skills', 'after-commit'))).toBe(false);
    p.store.applyMerge([{ op: 'add', type: 'skills', item: data.skills[0] }], false, null);
    expect(p.store.flushFiles()).toEqual([]);
    expect(readFileSync(join(p.dir, 'skills', 'after-commit', 'SKILL.md'), 'utf8')).toContain('name: after-commit');
  });
});
