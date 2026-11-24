import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HostInput } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { KeyStore, type KeyProtector } from '../src/main/services/vault/keystore';
import { base32Decode, normalizeOtpSeed, totp } from '../src/main/util/totp';
import { ImportService } from '../src/main/services/hosts/import-service';
import { parseCsvRows, parseElecterm, parseMobaXterm, parseSecureCrt, parseSshConfig, parseXshell, parseFinalShell } from '../src/main/services/hosts/importers';
import { createRepos } from './support/repos';
import { generateEd25519 } from './support/keys';

const fakeProtector: KeyProtector = {
  strength: 'weak',
  encrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
  decrypt: (b) => Buffer.from(b.map((x) => x ^ 0x5a)),
};

let dir: string;
let db: Db;
let repos: ReturnType<typeof createRepos>;
const vaultKey = randomBytes(32);

function hostInput(over: Partial<HostInput> = {}): HostInput {
  return {
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
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-vault-'));
  db = openDatabase(join(dir, 'iterminal.db'), randomBytes(32));
  repos = createRepos(db, vaultKey);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('主密码与密钥层级', () => {
  it('设置主密码后，冷启动必须输入正确的主密码；档案密钥不变', async () => {
    const ks = new KeyStore(dir, fakeProtector);
    await ks.unlock();
    const keys = ks.profileKeys(join(dir, 'local'), 'local');
    await ks.setMasterPassword('correct horse');
    expect(ks.hasMasterPassword()).toBe(true);

    const cold = new KeyStore(dir, fakeProtector);
    await expect(cold.unlock()).rejects.toThrow('主密码不正确');
    await expect(cold.unlock('wrong password')).rejects.toThrow('主密码不正确');
    await cold.unlock('correct horse');
    expect(cold.profileKeys(join(dir, 'local'), 'local').dbKey.equals(keys.dbKey)).toBe(true);
    expect(await cold.verify('correct horse')).toBe(true);
    expect(await cold.verify('nope')).toBe(false);

    // 修改主密码只重新包装 KEK
    await expect(cold.setMasterPassword('new password 1', 'wrong')).rejects.toThrow();
    await cold.setMasterPassword('new password 1', 'correct horse');
    const again = new KeyStore(dir, fakeProtector);
    await again.unlock('new password 1');
    expect(again.profileKeys(join(dir, 'local'), 'local').vaultKey.equals(keys.vaultKey)).toBe(true);

    // 取消主密码后不需要密码
    await again.removeMasterPassword('new password 1');
    const plain = new KeyStore(dir, fakeProtector);
    await plain.unlock();
    expect(plain.profileKeys(join(dir, 'local'), 'local').dbKey.equals(keys.dbKey)).toBe(true);
    // kek.json 里不含明文 KEK 和主密码
    expect(readFileSync(join(dir, 'kek.json'), 'utf8')).not.toContain('new password');
  });

  it('v0.2 的档案密钥文件自动迁移为 v2，数据库照常打开', async () => {
    const pdir = join(dir, 'profiles', 'local');
    mkdirSync(pdir, { recursive: true });
    const dbKey = randomBytes(32);
    const old = { v: 1, dbKey: dbKey.toString('hex'), vaultKey: randomBytes(32).toString('hex') };
    writeFileSync(join(pdir, 'keys.bin'), fakeProtector.encrypt(Buffer.from(JSON.stringify(old), 'utf8')));
    openDatabase(join(pdir, 'iterminal.db'), dbKey).close();

    const ks = new KeyStore(dir, fakeProtector);
    await ks.unlock();
    const keys = ks.profileKeys(pdir, 'local');
    expect(keys.dbKey.equals(dbKey)).toBe(true);
    expect(existsSync(join(pdir, 'keys.bin.v1.bak'))).toBe(true);
    openDatabase(join(pdir, 'iterminal.db'), keys.dbKey).close();
    ks.confirmMigration(pdir);
    expect(existsSync(join(pdir, 'keys.bin.v1.bak'))).toBe(false);
    // 第二次直接按 v2 读取
    const again = new KeyStore(dir, fakeProtector);
    await again.unlock();
    expect(again.profileKeys(pdir, 'local').dbKey.equals(dbKey)).toBe(true);
  });
});

describe('TOTP', () => {
  it('RFC 6238 测试向量', () => {
    const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
    expect(base32Decode(seed).toString()).toBe('12345678901234567890');
    expect(totp(seed, 59_000, 30, 8).code).toBe('94287082');
    expect(totp(seed, 1_111_111_109_000, 30, 8).code).toBe('07081804');
    expect(totp(seed, 59_000).code).toBe('287082');
  });

  it('接受 otpauth 链接、忽略空格和大小写', () => {
    expect(normalizeOtpSeed('otpauth://totp/corp:me?secret=gezd gnbv gy3t qojq&issuer=corp')).toBe('GEZDGNBVGY3TQOJQ');
    expect(() => normalizeOtpSeed('not base32 !')).toThrow();
  });
});

describe('凭证', () => {
  it('共享密码凭证：列表不含密码，查看明文返回密码', () => {
    const { credentials } = repos;
    const c = credentials.save(null, { type: 'PASSWORD', name: '运维账号', username: 'ops', secret: 'P@ss', aiAccess: 'REFERENCE', rotateDays: 90, expiresAt: null, note: null });
    expect(c).toMatchObject({ hasSecret: true, ownerHostId: null, usedByHosts: 0, rotateDays: 90 });
    expect(JSON.stringify(credentials.list())).not.toContain('P@ss');
    expect(credentials.reveal(c.id)).toMatchObject({ secret: 'P@ss', ttlSec: 30 });
    // undefined 保持不变，空串清除
    credentials.save(c.id, { type: 'PASSWORD', name: '运维账号2', username: 'ops', aiAccess: 'DENY', rotateDays: null, expiresAt: null, note: '备注' });
    expect(credentials.reveal(c.id).secret).toBe('P@ss');
    expect(credentials.require(c.id)).toMatchObject({ name: '运维账号2', aiAccess: 'DENY', note: '备注' });
    expect(() => credentials.save(c.id, { type: 'SSH_KEY', name: 'x', username: null, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null })).toThrow('类型');
  });

  it('生成 ed25519 / RSA 密钥：只返回公钥和指纹', () => {
    const { credentials } = repos;
    const ed = credentials.save(null, { type: 'SSH_KEY', name: '部署密钥', username: 'deploy', generate: { algorithm: 'ed25519', comment: 'me@corp' }, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    expect(ed.publicKey).toMatch(/^ssh-ed25519 \S+ me@corp$/);
    expect(ed.fingerprint).toMatch(/^SHA256:/);
    expect(ed.keyType).toBe('ssh-ed25519');
    expect(JSON.stringify(ed)).not.toContain('PRIVATE KEY');
    expect(credentials.reveal(ed.id).secret).toContain('PRIVATE KEY');
    const rsa = credentials.save(null, { type: 'SSH_KEY', name: 'rsa', username: null, generate: { algorithm: 'rsa', bits: 2048 }, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    expect(rsa.keyType).toBe('ssh-rsa');
  });

  it('只保存公钥、TOTP 凭证、查看验证码', () => {
    const { credentials } = repos;
    const pub = generateEd25519().public;
    const onlyPub = credentials.save(null, { type: 'SSH_KEY', name: '只有公钥', username: null, publicKey: pub, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    expect(onlyPub).toMatchObject({ hasSecret: false, fingerprint: expect.stringMatching(/^SHA256:/) });
    expect(() => credentials.save(null, { type: 'OTP', name: 'mfa', username: null, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null })).toThrow('TOTP');
    const otp = credentials.save(null, { type: 'OTP', name: 'mfa', username: null, otpSeed: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    expect(otp.hasOtp).toBe(true);
    expect(credentials.totp(otp.id).code).toMatch(/^\d{6}$/);
  });

  it('被主机或分组使用的凭证不能删除；主机专属凭证不能在凭证页修改', () => {
    const { credentials, hosts, folders } = repos;
    const c = credentials.save(null, { type: 'PASSWORD', name: 'shared', username: 'ops', secret: 'pw', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    const f = folders.create(null, '生产');
    folders.update(f.id, { defaultCredentialId: c.id, defaultJumpHostId: null, agentPolicy: null, aiNote: null, defaultSkills: [], production: false });
    expect(() => credentials.delete(c.id)).toThrow('1 个分组');
    const own = hosts.create(hostInput());
    const dedicated = credentials.list().find((x) => x.ownerHostId === own.id)!;
    expect(dedicated).toBeTruthy();
    expect(() => credentials.save(dedicated.id, { type: 'PASSWORD', name: 'x', username: null, aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null })).toThrow('主机专属');
    expect(() => hosts.create(hostInput({ authMethod: 'CREDENTIAL', credentialId: dedicated.id }))).toThrow('专属凭证');
  });
});

describe('分组设置与继承', () => {
  it('凭证、跳板机继承最近的分组；Agent 权限就近生效；说明从上到下拼接', () => {
    const { credentials, hosts, folders, settings } = repos;
    settings.set('ai.defaultAgentPolicy', 'AUTO');
    const cred = credentials.save(null, { type: 'PASSWORD', name: 'ops', username: 'ops', secret: 'pw', aiAccess: 'REFERENCE', rotateDays: null, expiresAt: null, note: null });
    const bastion = hosts.create(hostInput({ name: 'bastion' }));
    const prod = folders.create(null, '生产');
    const order = folders.create(prod.id, '订单');
    folders.update(prod.id, { defaultCredentialId: cred.id, defaultJumpHostId: bastion.id, agentPolicy: 'READONLY', aiNote: '生产环境，禁止重启', defaultSkills: ['health'], production: true });
    folders.update(order.id, { defaultCredentialId: null, defaultJumpHostId: null, agentPolicy: 'APPROVE', aiNote: '订单服务 Java', defaultSkills: ['jvm'], production: false });
    const h = hosts.create(hostInput({ folderId: order.id, username: '', authMethod: 'CREDENTIAL', credentialId: null, password: undefined }));

    const eff = hosts.effective(h.id, null);
    expect(eff.credentialId).toBe(cred.id);
    expect(eff.credentialFrom).toMatchObject({ kind: 'folder', folderName: '生产' });
    expect(eff.jumpHostIds).toEqual([bastion.id]);
    // 就近生效：子分组的 APPROVE 覆盖父分组的 READONLY
    expect(eff.agentPolicy).toBe('APPROVE');
    expect(eff.agentPolicyFrom).toMatchObject({ kind: 'folder', folderName: '订单' });
    expect(eff.aiNotes.map((n) => n.note)).toEqual(['生产环境，禁止重启', '订单服务 Java']);
    expect(eff.defaultSkills).toEqual(['health', 'jvm']);
    expect(eff.production).toBe(true);
    expect(eff.folderPath).toBe('生产 / 订单');

    // 连接时使用继承的凭证和跳板；用户名取自凭证；共享凭证不能被「记住」改写
    const info = hosts.connectInfo(h.id);
    expect(info.auth).toMatchObject({ method: 'PASSWORD', username: 'ops', password: 'pw', rememberable: false, credentialId: cred.id });
    expect(info.jumpHostIds).toEqual([bastion.id]);

    // 跳板机自己也在分组里时不经过自己；主机可以关闭继承
    hosts.move([bastion.id], order.id);
    expect(hosts.connectInfo(bastion.id).jumpHostIds).toEqual([]);
    const direct = hosts.update(h.id, { ...hostInput({ folderId: order.id, username: 'root', authMethod: 'CREDENTIAL', credentialId: null }), jumpInherit: false });
    expect(hosts.connectInfo(direct.id).jumpHostIds).toEqual([]);

    // 全局默认只在主机和分组都没有设置时生效
    settings.set('ai.defaultAgentPolicy', 'AI_REVIEW');
    expect(hosts.effective(h.id, null)).toMatchObject({ agentPolicy: 'APPROVE', agentPolicyFrom: { kind: 'folder', folderName: '订单' } });
    folders.update(order.id, { defaultCredentialId: null, defaultJumpHostId: null, agentPolicy: null, aiNote: '订单服务 Java', defaultSkills: ['jvm'], production: false });
    folders.update(prod.id, { defaultCredentialId: cred.id, defaultJumpHostId: bastion.id, agentPolicy: null, aiNote: '生产环境，禁止重启', defaultSkills: ['health'], production: true });
    expect(hosts.effective(h.id, null)).toMatchObject({ agentPolicy: 'AI_REVIEW', agentPolicyFrom: { kind: 'global' } });
  });

  it('分组的默认跳板机不能直接删除，连同分组一起删除时可以', () => {
    const { hosts, folders } = repos;
    const f = folders.create(null, '机房');
    const j = hosts.create(hostInput({ name: 'jump', folderId: f.id }));
    folders.update(f.id, { defaultCredentialId: null, defaultJumpHostId: j.id, agentPolicy: null, aiNote: null, defaultSkills: [], production: false });
    expect(() => hosts.delete([j.id])).toThrow('「jump」是分组「机房」的默认跳板机');
    folders.delete(f.id, 'CASCADE');
    expect(hosts.get(j.id)).toBeNull();
  });

  it('拖拽排序：放到指定分组前面，没有空间时整体重排', () => {
    const { folders } = repos;
    const a = folders.create(null, 'A');
    const b = folders.create(null, 'B');
    const c = folders.create(null, 'C');
    folders.move(c.id, null, a.id);
    expect(folders.list().map((f) => f.name)).toEqual(['C', 'A', 'B']);
    for (let i = 0; i < 12; i++) folders.move(b.id, null, i % 2 ? a.id : c.id);
    expect(new Set(folders.list().map((f) => f.sort)).size).toBe(3);
    folders.move(a.id, null, null);
    expect(folders.list().at(-1)!.name).toBe('A');
  });
});

describe('标签与收藏', () => {
  it('主机标签（不区分大小写去重）、批量增删、标签统计、收藏', () => {
    const { hosts, tags } = repos;
    const h1 = hosts.create(hostInput({ name: 'a', tags: ['prod', 'Web', 'web'] }));
    const h2 = hosts.create(hostInput({ name: 'b', tags: ['web'], favorite: true }));
    expect(h1.tags).toEqual(['prod', 'Web']);
    expect(h2.favorite).toBe(true);
    expect(tags.list().map((t) => [t.name, t.hostCount])).toEqual([['prod', 1], ['Web', 2]]);
    tags.addRemove([h1.id, h2.id], ['db'], ['web']);
    expect(hosts.get(h1.id)!.tags).toEqual(['db', 'prod']);
    expect(hosts.get(h2.id)!.tags).toEqual(['db']);
    const prod = tags.list().find((t) => t.name === 'prod')!;
    tags.update(prod.id, '生产', '#ff0000');
    expect(hosts.get(h1.id)!.tags).toContain('生产');
    tags.delete(prod.id);
    expect(hosts.get(h1.id)!.tags).toEqual(['db']);
    hosts.setFavorite(h2.id, false);
    expect(hosts.get(h2.id)!.favorite).toBe(false);
    // 修改主机时不传 tags / favorite 保持不变
    hosts.setFavorite(h1.id, true);
    expect(hosts.update(h1.id, hostInput({ name: 'a2', password: undefined }))).toMatchObject({ tags: ['db'], favorite: true });
  });

  it('主机扩展字段：协议、编码、环境变量、代理、命令黑名单、串口参数', () => {
    const { hosts } = repos;
    const h = hosts.create(
      hostInput({
        protocol: 'SSH',
        encoding: 'gbk',
        env: { LANG: 'zh_CN.GBK' },
        proxy: { type: 'SOCKS5', host: '127.0.0.1', port: 1080, username: 'u' },
        proxyPassword: 'pp',
        cmdDenylist: ['^reboot'],
        agentPolicy: 'READONLY',
        aiMemory: '这台是 MySQL 主库',
      }),
    );
    expect(h).toMatchObject({ encoding: 'GBK', env: { LANG: 'zh_CN.GBK' }, proxy: { type: 'SOCKS5', hasPassword: true }, cmdDenylist: ['^reboot'], agentPolicy: 'READONLY' });
    expect(hosts.connectInfo(h.id).proxy).toMatchObject({ host: '127.0.0.1', port: 1080, username: 'u', password: 'pp' });
    expect(() => hosts.create(hostInput({ cmdDenylist: ['('] }))).toThrow('正则');
    expect(() => hosts.create(hostInput({ encoding: 'EBCDIC' }))).toThrow('编码');
    const serial = hosts.create(
      hostInput({ protocol: 'SERIAL', address: '/dev/ttyUSB0', port: 0, username: '', serial: { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1, flowControl: 'none', eol: 'CRLF', localEcho: false } }),
    );
    expect(serial).toMatchObject({ protocol: 'SERIAL', port: 0, authMethod: 'INTERACTIVE', serial: { baudRate: 9600, eol: 'CRLF' }, jumpHostIds: [] });
    const telnet = hosts.create(hostInput({ protocol: 'TELNET', port: 23, username: '' }));
    expect(telnet.protocol).toBe('TELNET');
    expect(() => hosts.create(hostInput({ protocol: 'TELNET', authMethod: 'KEY' }))).toThrow('Telnet');
  });
});

describe('导入', () => {
  it('~/.ssh/config：别名、通配默认值、Include、私钥、ProxyJump', () => {
    const key = generateEd25519().private;
    writeFileSync(join(dir, 'id_test'), key);
    writeFileSync(join(dir, 'extra.conf'), 'Host extra\n  HostName 10.9.9.9\n');
    writeFileSync(
      join(dir, 'config'),
      [
        `Include ${join(dir, 'extra.conf')}`,
        'Host bastion',
        '  HostName 1.2.3.4',
        '  User jump',
        `  IdentityFile ${join(dir, 'id_test')}`,
        'Host app-*',
        '  User deploy',
        'Host app-01 app-02',
        '  HostName 10.0.0.%h',
        '  Port 2222',
        '  ProxyJump bastion',
        'Host *',
        '  User fallback',
        'Host legacy',
        '  ProxyCommand nc %h %p',
      ].join('\n'),
    );
    const r = parseSshConfig(join(dir, 'config'));
    const byName = Object.fromEntries(r.hosts.map((h) => [h.name, h]));
    expect(Object.keys(byName).sort()).toEqual(['app-01', 'app-02', 'bastion', 'extra', 'legacy']);
    expect(byName.bastion).toMatchObject({ address: '1.2.3.4', username: 'jump', authMethod: 'KEY' });
    expect(byName.bastion.privateKey).toContain('PRIVATE KEY');
    expect(byName['app-01']).toMatchObject({ address: '10.0.0.app-01', port: 2222, username: 'deploy', jumps: ['ssh:bastion'], authMethod: 'AGENT' });
    expect(byName.extra).toMatchObject({ address: '10.9.9.9', username: 'fallback' });
    expect(r.warnings.join()).toContain('ProxyCommand');
  });

  it('Xshell（UTF-16）、SecureCRT（十六进制端口）、MobaXterm、Electerm、FinalShell', () => {
    const xsh = join(dir, 'xshell');
    mkdirSync(join(xsh, '生产', '订单'), { recursive: true });
    const xshText = '[CONNECTION]\r\nHost=10.1.1.1\r\nPort=2200\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=root\r\n';
    writeFileSync(join(xsh, '生产', '订单', 'order-01.xsh'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xshText, 'utf16le')]));
    expect(parseXshell(xsh).hosts[0]).toMatchObject({ name: 'order-01', folderPath: ['生产', '订单'], address: '10.1.1.1', port: 2200, username: 'root' });

    const crt = join(dir, 'crt');
    mkdirSync(join(crt, 'IDC'), { recursive: true });
    writeFileSync(join(crt, 'IDC', 'db-01.ini'), 'S:"Hostname"=10.2.2.2\nS:"Username"=dba\nS:"Protocol Name"=SSH2\nD:"[SSH2] Port"=00000016\n');
    writeFileSync(join(crt, '__FolderData__.ini'), 'x');
    expect(parseSecureCrt(crt).hosts).toEqual([expect.objectContaining({ name: 'db-01', folderPath: ['IDC'], address: '10.2.2.2', port: 22, username: 'dba' })]);

    writeFileSync(join(dir, 's.mxtsessions'), '[Bookmarks]\nSubRep=\nImgNum=42\n[Bookmarks_1]\nSubRep=机房\\A区\nImgNum=41\nweb-01=#109#0%10.3.3.3%22%admin%%-1%-1%%%22%%0%0%0\nsw-01=#98#1%10.3.3.4%23%%%2%%%%%0%0%0\n');
    const moba = parseMobaXterm(join(dir, 's.mxtsessions')).hosts;
    expect(moba.map((h) => [h.name, h.protocol, h.folderPath.join('/'), h.username])).toEqual([
      ['web-01', 'SSH', '机房/A区', 'admin'],
      ['sw-01', 'TELNET', '机房/A区', ''],
    ]);

    writeFileSync(
      join(dir, 'electerm.json'),
      JSON.stringify({
        bookmarks: [{ id: 'b1', title: 'redis', host: '10.4.4.4', port: 22, username: 'r', password: 'rpw' }],
        bookmarkGroups: [
          { id: 'default', title: 'default', bookmarkIds: [], bookmarkGroupIds: ['g1'] },
          { id: 'g1', title: '缓存', bookmarkIds: ['b1'], bookmarkGroupIds: [] },
        ],
      }),
    );
    expect(parseElecterm(join(dir, 'electerm.json')).hosts[0]).toMatchObject({ name: 'redis', folderPath: ['缓存'], authMethod: 'PASSWORD', password: 'rpw' });

    const fs = join(dir, 'conn');
    mkdirSync(fs);
    writeFileSync(join(fs, 'f1_folder_config.json'), JSON.stringify({ id: 'f1', name: '测试环境' }));
    writeFileSync(join(fs, 'h1_connect_config.json'), JSON.stringify({ name: 'test-01', host: '10.5.5.5', port: 22, user_name: 'root', parent_id: 'f1', conection_type: 100 }));
    expect(parseFinalShell(fs).hosts[0]).toMatchObject({ name: 'test-01', folderPath: ['测试环境'], address: '10.5.5.5', username: 'root' });
  });

  it('CSV 解析（引号、逗号、换行）', () => {
    expect(parseCsvRows('a,"b,c","d""e"\r\n"multi\nline",x,y\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['multi\nline', 'x', 'y'],
    ]);
  });

  it('预览标出重复，提交时按分组路径建分组、映射跳板机；导出再导入保持一致', async () => {
    const { hosts, folders } = repos;
    hosts.create(hostInput({ name: 'old', address: '10.0.0.5' }));
    const svc = new ImportService(db, hosts, folders);
    writeFileSync(
      join(dir, 'hosts.csv'),
      '\uFEFF名称,分组,地址,端口,用户名,密码,标签,备注,跳板机\n' +
        'j,基础/跳板,10.0.0.9,22,root,jpw,infra,,\n' +
        'app,"业务/订单",10.0.0.10,22,root,,"web;java","订单, 主",j\n' +
        'dup,,10.0.0.5,22,root,,,,\n',
    );
    const preview = svc.preview('CSV', join(dir, 'hosts.csv'));
    expect(preview.items.map((i) => [i.name, i.folderPath.join('/'), i.hasPassword, i.duplicateOf !== null])).toEqual([
      ['j', '基础/跳板', true, false],
      ['app', '业务/订单', false, false],
      ['dup', '', false, true],
    ]);
    expect(JSON.stringify(preview)).not.toContain('jpw');
    const target = folders.create(null, '导入');
    const r = svc.commit(preview.token, preview.items.map((i) => i.key), target.id, true);
    expect(r).toEqual({ createdHosts: 2, createdFolders: 4, skipped: 1 });
    const app = hosts.list().find((h) => h.name === 'app')!;
    const j = hosts.list().find((h) => h.name === 'j')!;
    expect(app).toMatchObject({ jumpHostIds: [j.id], tags: ['java', 'web'], note: '订单, 主', authMethod: 'INTERACTIVE' });
    expect(hosts.connectInfo(j.id).auth.password).toBe('jpw');
    expect(() => svc.commit(preview.token, [], null, true)).toThrow('过期');

    await svc.exportHosts('JSON', join(dir, 'out.json'), null);
    expect(readFileSync(join(dir, 'out.json'), 'utf8')).not.toContain('jpw');
    await svc.exportHosts('CSV', join(dir, 'out.csv'), [app.id]);
    const csv = readFileSync(join(dir, 'out.csv'), 'utf8');
    expect(csv.startsWith('\uFEFFname,group')).toBe(true);
    expect(csv).toContain('"订单, 主"');

    // 导出的 JSON 导入到新库：分组路径、跳板关系保持
    const db2 = openDatabase(join(dir, 'b.db'), randomBytes(32));
    const r2 = createRepos(db2, randomBytes(32));
    const svc2 = new ImportService(db2, r2.hosts, r2.folders);
    const p2 = svc2.preview('JSON', join(dir, 'out.json'));
    svc2.commit(p2.token, p2.items.map((i) => i.key), null, false);
    const app2 = r2.hosts.list().find((h) => h.name === 'app')!;
    const j2 = r2.hosts.list().find((h) => h.name === 'j')!;
    expect(app2.jumpHostIds).toEqual([j2.id]);
    expect(r2.folders.list().map((f) => f.name).sort()).toEqual(['基础', '导入', '业务', '订单', '跳板'].sort());
    db2.close();
  });
});
