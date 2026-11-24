import { describe, expect, it } from 'vitest';
import {
  emptyDataset,
  planMerge,
  planReplace,
  pickGroups,
  type Dataset,
  type DsCredential,
  type DsFolder,
  type DsHost,
  type DsNote,
  type DsSnippet,
  type ImportMap,
  type MergeOp,
  type SyncGroup,
} from '../src/index';

const ALL: SyncGroup[] = ['HOSTS', 'SNIPPETS', 'NOTES', 'CREDENTIALS'];

const folder = (id: string, name: string, parentId: string | null = null, extra: Partial<DsFolder> = {}): DsFolder => ({
  id, parentId, name, sort: 0, defaultCredentialId: null, defaultJumpHostId: null, agentPolicy: null, aiNote: null, defaultSkills: [], production: false, updatedAt: 1, ...extra,
});
const host = (id: string, name: string, address: string, extra: Partial<DsHost> = {}): DsHost => ({
  id, folderId: null, name, protocol: 'SSH', address, port: 22, username: 'root', authMethod: 'PASSWORD', credentialId: null, jumpHostIds: [], jumpInherit: true,
  proxy: null, encoding: 'UTF-8', termType: 'xterm-256color', env: {}, startupScript: null, keepaliveSec: 30, serialOpts: null, agentPolicy: null, cmdDenylist: [],
  tags: [], favorite: false, note: null, monitorScript: null, recordSession: true, portForwards: [], updatedAt: 1, ...extra,
});
const cred = (id: string, name: string, extra: Partial<DsCredential> = {}): DsCredential => ({
  id, type: 'PASSWORD', name, username: 'root', secret: 'pw', passphrase: null, publicKey: null, fingerprint: null, otpSeed: null, aiAccess: 'REFERENCE', rotateDays: null,
  expiresAt: null, note: null, updatedAt: 1, ...extra,
});
const snippet = (id: string, name: string, content: string, extra: Partial<DsSnippet> = {}): DsSnippet => ({
  id, groupId: null, name, content, description: null, tags: [], sort: 0, updatedAt: 1, ...extra,
});
const note = (id: string, title: string, content: string, extra: Partial<DsNote> = {}): DsNote => ({
  id, groupId: null, title, content, format: 'MARKDOWN', pinned: false, sort: 0, updatedAt: 1, ...extra,
});
const ds = (d: Partial<Dataset>): Dataset => ({ ...emptyDataset(), ...d });

let seq = 0;
const share = (importMap: ImportMap = new Map()) => ({ kind: 'share' as const, ownerId: 'u1', importMap, newId: () => `new-${++seq}` });
const adds = (ops: MergeOp[], type: string) => ops.filter((o) => o.op === 'add' && o.type === type).map((o) => (o as { item: { id: string } }).item);
const fills = (ops: MergeOp[], type: string) => ops.filter((o) => o.op === 'fill' && o.type === type) as Extract<MergeOp, { op: 'fill' }>[];
const maps = (ops: MergeOp[]) => new Map(ops.filter((o) => o.op === 'map').map((o) => [`${o.type}:${(o as { remoteId: string }).remoteId}`, (o as { localId: string }).localId]));

describe('planMerge：识别同一条目', () => {
  it('从自己的备份：id 相同即同一条，保留本地地址，只补空', () => {
    const local = ds({ hosts: [host('h1', 'order-01', '10.0.1.1', { note: null, startupScript: 'cd /srv' })] });
    const inc = ds({ hosts: [host('h1', '改了名字', '10.0.0.1', { note: '对方备注', startupScript: 'cd /opt', port: 2222 })] });
    const { ops, report } = planMerge(local, inc, { source: { kind: 'backup' }, groups: ['HOSTS'] });
    expect(adds(ops, 'hosts')).toHaveLength(0);
    expect(fills(ops, 'hosts')).toEqual([{ op: 'fill', type: 'hosts', localId: 'h1', patch: { note: '对方备注' } }]);
    expect(report.perType.hosts).toEqual({ added: 0, kept: 0, filled: 1 });
  });

  it('分享码：同一分组下同名的主机是同一台，保留本地的 IP（文档示例）', () => {
    const local = ds({
      hostGroups: [folder('lf1', '生产'), folder('lf2', '订单', 'lf1')],
      hosts: [host('lh1', 'order-01', '10.0.1.1', { folderId: 'lf2' })],
    });
    const inc = ds({
      hostGroups: [folder('rf1', '生产 '), folder('rf2', 'ORDER', 'rf1'), folder('rf2b', '订单', 'rf1')],
      hosts: [host('rh1', 'Order-01', '10.0.0.1', { folderId: 'rf2b' })],
    });
    const { ops, report } = planMerge(local, inc, { source: share(), groups: ['HOSTS'] });
    // 生产 / 订单 按名称路径命中（忽略大小写和首尾空白），ORDER 是新的
    expect(adds(ops, 'hostGroups').map((f) => f.id)).toEqual([expect.stringMatching(/^new-/)]);
    expect((adds(ops, 'hostGroups')[0] as DsFolder).parentId).toBe('lf1');
    expect(adds(ops, 'hosts')).toHaveLength(0);
    expect(report.perType.hosts.kept).toBe(1);
    expect(maps(ops).get('hosts:rh1')).toBe('lh1');
    expect(maps(ops).get('hostGroups:rf2b')).toBe('lf2');
  });

  it('主机：名称不同但协议 + 地址 + 端口 + 用户名相同也是同一台；所在分组不变', () => {
    const local = ds({ hostGroups: [folder('a', 'A')], hosts: [host('lh', 'web', '10.0.0.5', { folderId: 'a' })] });
    const inc = ds({ hostGroups: [folder('b', 'B')], hosts: [host('rh', 'web-new', '10.0.0.5', { folderId: 'b' })] });
    const { ops } = planMerge(local, inc, { source: share(), groups: ['HOSTS'] });
    expect(adds(ops, 'hosts')).toHaveLength(0);
    expect(fills(ops, 'hosts').some((f) => 'folderId' in f.patch)).toBe(false);
    // 端口不同就是另一台
    const inc2 = ds({ hosts: [host('rh', 'web-new', '10.0.0.5', { port: 2200 })] });
    expect(adds(planMerge(local, inc2, { source: share(), groups: ['HOSTS'] }).ops, 'hosts')).toHaveLength(1);
  });

  it('快捷命令：同一分组下同名、或命令内容相同（统一换行、去首尾空白）', () => {
    const local = ds({
      snippetGroups: [{ id: 'g1', name: '运维', sort: 0, updatedAt: 1 }],
      snippets: [snippet('s1', '看磁盘', 'df -h', { groupId: 'g1' }), snippet('s2', '负载', 'uptime\r\nfree -m\n')],
    });
    const inc = ds({
      snippetGroups: [{ id: 'rg', name: ' 运维 ', sort: 0, updatedAt: 1 }],
      snippets: [
        snippet('r1', '看磁盘', 'df -hT', { groupId: 'rg', description: '对方说明', tags: ['disk'] }),
        snippet('r2', '系统负载', '  uptime\nfree -m', { tags: ['x'] }),
        snippet('r3', '新命令', 'ls'),
      ],
    });
    const { ops, report } = planMerge(local, inc, { source: share(), groups: ['SNIPPETS'] });
    expect(report.perType.snippetGroups).toEqual({ added: 0, kept: 1, filled: 0 });
    expect(adds(ops, 'snippets').map((s) => (s as DsSnippet).name)).toEqual(['新命令']);
    const f = fills(ops, 'snippets');
    expect(f.find((x) => x.localId === 's1')!.patch).toEqual({ description: '对方说明', tags: ['disk'] });
    expect(f.find((x) => x.localId === 's2')!.patch).toEqual({ tags: ['x'] });
    // 命令内容不会被覆盖
    expect(JSON.stringify(ops)).not.toContain('df -hT');
  });

  it('笔记：同一分组下标题相同；正文只在本地为空时补', () => {
    const local = ds({ notes: [note('n1', '值班', ''), note('n2', '部署', '本地正文')] });
    const inc = ds({ notes: [note('r1', '值班', '对方正文'), note('r2', '部署', '对方正文 2'), note('r3', '新笔记', 'x')] });
    const { ops, report } = planMerge(local, inc, { source: share(), groups: ['NOTES'] });
    expect(report.perType.notes).toEqual({ added: 1, kept: 1, filled: 1 });
    expect(fills(ops, 'notes')).toEqual([{ op: 'fill', type: 'notes', localId: 'n1', patch: { content: '对方正文' } }]);
  });

  it('凭证：类型 + 名称；密钥按指纹；密码按用户名 + 密码；秘密绝不覆盖', () => {
    const local = ds({
      credentials: [
        cred('c1', '生产 root', { secret: 'local-pw' }),
        cred('c2', '部署密钥', { type: 'SSH_KEY', secret: 'LOCALKEY', fingerprint: 'SHA256:aaa', username: null }),
        cred('c3', '旧名字', { secret: 'same', username: 'admin' }),
        cred('c4', '空密码', { secret: null }),
      ],
    });
    const inc = ds({
      credentials: [
        cred('r1', '生产 ROOT', { secret: 'remote-pw', note: '对方备注' }),
        cred('r2', '另一个名字', { type: 'SSH_KEY', secret: 'REMOTEKEY', passphrase: 'pp', fingerprint: 'SHA256:aaa', username: null }),
        cred('r3', '新名字', { secret: 'same', username: 'ADMIN' }),
        cred('r4', '空密码', { secret: 'filled' }),
        cred('r5', '全新', { secret: 'new' }),
      ],
    });
    const { ops, report } = planMerge(local, inc, { source: share(), groups: ['CREDENTIALS'] });
    expect(report.perType.credentials).toEqual({ added: 1, kept: 2, filled: 2 });
    const f = fills(ops, 'credentials');
    expect(f.find((x) => x.localId === 'c1')!.patch).toEqual({ note: '对方备注' });
    expect(f.find((x) => x.localId === 'c4')!.patch).toEqual({ secret: 'filled' });
    // 本地已经有私钥：口令也不补，避免和本地私钥不配对
    expect(f.find((x) => x.localId === 'c2')).toBeUndefined();
    expect(JSON.stringify(ops)).not.toContain('remote-pw');
    expect(JSON.stringify(ops)).not.toContain('REMOTEKEY');
  });
});

describe('planMerge：补空与并集', () => {
  it('标签、默认 Skill、端口转发取并集（端口转发按类型 + 绑定地址 + 端口去重）', () => {
    const pf = (bindPort: number, targetPort = 80) => ({ type: 'LOCAL', bindAddr: '127.0.0.1', bindPort, targetAddr: 'db', targetPort, autoStart: false });
    const local = ds({
      hostGroups: [folder('f', 'F', null, { defaultSkills: ['a'] })],
      hosts: [host('h', 'web', '1.1.1.1', { folderId: 'f', tags: ['prod'], portForwards: [pf(8080)] })],
    });
    const inc = ds({
      hostGroups: [folder('f', 'F', null, { defaultSkills: ['a', 'b'], aiNote: '对方说明' })],
      hosts: [host('h', 'web', '1.1.1.1', { folderId: 'f', tags: ['prod', 'web'], portForwards: [pf(8080, 81), pf(9090)] })],
    });
    const { ops } = planMerge(local, inc, { source: { kind: 'backup' }, groups: ['HOSTS'] });
    expect(fills(ops, 'hostGroups')[0].patch).toEqual({ aiNote: '对方说明', defaultSkills: ['a', 'b'] });
    const p = fills(ops, 'hosts')[0].patch;
    expect(p.tags).toEqual(['prod', 'web']);
    expect(p.portForwards).toEqual([pf(8080), pf(9090)]);
  });

  it('跳板机、代理、环境变量：本地有值就保留，为空时才补', () => {
    const local = ds({ hosts: [host('j1', 'jump1', '9.9.9.1'), host('j2', 'jump2', '9.9.9.2'), host('h', 'web', '1.1.1.1', { jumpHostIds: ['j1'], env: { A: '1' } })] });
    const inc = ds({ hosts: [host('j1', 'jump1', '9.9.9.1'), host('j2', 'jump2', '9.9.9.2'), host('h', 'web', '1.1.1.1', { jumpHostIds: ['j2'], env: { B: '2' }, proxy: { type: 'SOCKS5' } })] });
    const p = fills(planMerge(local, inc, { source: { kind: 'backup' }, groups: ['HOSTS'] }).ops, 'hosts').find((f) => f.localId === 'h')!.patch;
    expect(p).toEqual({ proxy: { type: 'SOCKS5' } });
  });

  it('主机自己的密码只在本地为空时补；私钥和口令成对', () => {
    const local = ds({ hosts: [host('a', 'a', '1.1.1.1', { password: null }), host('b', 'b', '1.1.1.2', { authMethod: 'KEY', privateKey: 'K', passphrase: null })] });
    const inc = ds({ hosts: [host('a', 'a', '1.1.1.1', { password: 'p' }), host('b', 'b', '1.1.1.2', { authMethod: 'KEY', privateKey: 'K2', passphrase: 'pp' })] });
    const f = fills(planMerge(local, inc, { source: { kind: 'backup' }, groups: ['HOSTS', 'CREDENTIALS'] }).ops, 'hosts');
    expect(f.find((x) => x.localId === 'a')!.patch).toEqual({ password: 'p' });
    expect(f.find((x) => x.localId === 'b')).toBeUndefined();
  });
});

describe('planMerge：新增与引用重映射', () => {
  it('从备份恢复沿用原 id；按拓扑顺序；引用映射到本地已有的条目', () => {
    const local = ds({ credentials: [cred('lc', '共享')], hostGroups: [folder('lf', '生产')] });
    const inc = ds({
      credentials: [cred('rc', '共享')],
      hostGroups: [folder('rf2', '订单', 'rf'), folder('rf', '生产', null, { defaultCredentialId: 'rc', defaultJumpHostId: 'rj' })],
      hosts: [host('rh', 'order-01', '10.0.0.1', { folderId: 'rf2', authMethod: 'CREDENTIAL', credentialId: 'rc', jumpHostIds: ['rj'] }), host('rj', 'jump', '10.0.0.9')],
    });
    const { ops, report } = planMerge(local, inc, { source: { kind: 'backup' }, groups: ALL });
    const order = ops.filter((o) => o.op === 'add').map((o) => o.type);
    expect(order).toEqual(['hostGroups', 'hosts', 'hosts']);
    expect(adds(ops, 'hostGroups')[0]).toMatchObject({ id: 'rf2', parentId: 'lf' });
    expect(adds(ops, 'hosts')[0]).toMatchObject({ id: 'rh', folderId: 'rf2', credentialId: 'lc', jumpHostIds: ['rj'] });
    // 已存在的分组「生产」：默认凭证本地为空 → 补上（映射成本地 id）；默认跳板机在主机之后补
    const f = fills(ops, 'hostGroups');
    expect(f[0].patch).toEqual({ defaultCredentialId: 'lc' });
    expect(f[1].patch).toEqual({ defaultJumpHostId: 'rj' });
    expect(ops.indexOf(f[1])).toBeGreaterThan(ops.indexOf(ops.find((o) => o.op === 'add' && o.type === 'hosts')!));
    expect(report.unresolvedRefs).toEqual([]);
  });

  it('分享包没带凭证：新增的主机凭证置空，并列入无法映射的引用', () => {
    const inc = ds({ hosts: [host('rh', 'web', '1.1.1.1', { authMethod: 'CREDENTIAL', credentialId: 'rc' })], snippets: [snippet('s', 'x', 'ls', { groupId: 'missing' })] });
    const { ops, report } = planMerge(emptyDataset(), inc, { source: share(), groups: ['HOSTS', 'SNIPPETS'] });
    expect(adds(ops, 'hosts')[0]).toMatchObject({ credentialId: null, id: expect.stringMatching(/^new-/) });
    expect(adds(ops, 'snippets')[0]).toMatchObject({ groupId: null });
    expect(report.unresolvedRefs).toEqual([
      { type: 'hosts', id: 'rh', name: 'web', field: 'credentialId' },
      { type: 'snippets', id: 's', name: 'x', field: 'groupId' },
    ]);
  });

  it('已存在的条目映射不到引用时保留本地的值，不算「无法映射」', () => {
    const local = ds({ hosts: [host('lh', 'web', '1.1.1.1', { authMethod: 'CREDENTIAL', credentialId: 'mine' })], credentials: [cred('mine', 'mine')] });
    const inc = ds({ hosts: [host('rh', 'web', '1.1.1.1', { authMethod: 'CREDENTIAL', credentialId: 'theirs' })] });
    const { ops, report } = planMerge(local, inc, { source: share(), groups: ['HOSTS'] });
    expect(report.unresolvedRefs).toEqual([]);
    expect(fills(ops, 'hosts')).toEqual([]);
  });

  it('同一分享者重复拉取是幂等的：通过导入映射识别，只补充新增', () => {
    const inc = ds({
      hostGroups: [folder('rf', '生产')],
      hosts: [host('rh', 'web', '1.1.1.1', { folderId: 'rf' })],
      snippets: [snippet('rs', 'ls', 'ls -la')],
    });
    const first = planMerge(emptyDataset(), inc, { source: share(), groups: ['HOSTS', 'SNIPPETS'] });
    // 模拟执行：把新增写进本地，映射写进 share_import_map
    const local = ds({
      hostGroups: adds(first.ops, 'hostGroups') as DsFolder[],
      hosts: adds(first.ops, 'hosts') as DsHost[],
      snippets: adds(first.ops, 'snippets') as DsSnippet[],
    });
    const importMap = maps(first.ops);
    // 拉取方在本地改了名字和地址
    local.hosts[0] = { ...local.hosts[0], name: '我的 web', address: '10.9.9.9' };
    const inc2 = ds({ ...inc, snippets: [...inc.snippets, snippet('rs2', 'pwd', 'pwd')] });
    const second = planMerge(local, inc2, { source: share(importMap), groups: ['HOSTS', 'SNIPPETS'] });
    expect(second.report.perType.hosts).toEqual({ added: 0, kept: 1, filled: 0 });
    expect(second.report.perType.hostGroups).toEqual({ added: 0, kept: 1, filled: 0 });
    expect(adds(second.ops, 'snippets').map((s) => (s as DsSnippet).name)).toEqual(['pwd']);
    const third = planMerge(local, inc, { source: share(importMap), groups: ['HOSTS', 'SNIPPETS'] });
    expect(third.ops.filter((o) => o.op !== 'map')).toEqual([]);
  });

  it('多级主机分组按路径逐级合并，新建的放在原来的名称路径下', () => {
    const local = ds({ hostGroups: [folder('a', '生产'), folder('b', '订单', 'a')] });
    const inc = ds({ hostGroups: [folder('x', '生产'), folder('y', '订单', 'x'), folder('z', '数据库', 'y'), folder('w', '支付', 'x')] });
    const { ops } = planMerge(local, inc, { source: share(), groups: ['HOSTS'] });
    const added = adds(ops, 'hostGroups') as DsFolder[];
    expect(added.map((f) => [f.name, f.parentId])).toEqual([
      ['支付', 'a'],
      ['数据库', 'b'],
    ]);
  });

  it('没选的分组不处理；没选凭证时主机自己的秘密不进包', () => {
    const d = ds({ hosts: [host('h', 'web', '1.1.1.1', { password: 'p' })], notes: [note('n', 't', 'c')], credentials: [cred('c', 'c')] });
    const picked = pickGroups(d, ['HOSTS']);
    expect(picked.notes).toEqual([]);
    expect(picked.credentials).toEqual([]);
    expect(picked.hosts[0].password).toBeNull();
    const { ops } = planMerge(emptyDataset(), d, { source: { kind: 'backup' }, groups: ['NOTES'] });
    expect(ops.map((o) => o.type)).toEqual(['notes']);
  });
});

describe('planReplace：覆盖本地', () => {
  it('统计新增 / 修改 / 删除，按 id 替换，本地多出的打墓碑', () => {
    const local = ds({ snippets: [snippet('a', 'a', 'ls'), snippet('b', 'b', 'pwd'), snippet('c', 'c', 'df')] });
    const inc = ds({ snippets: [snippet('a', 'a', 'ls', { updatedAt: 99 }), snippet('b', 'b', 'pwd -P'), snippet('d', 'd', 'id')] });
    const plan = planReplace(local, inc, ['SNIPPETS']);
    expect(plan.report.perType.snippets).toEqual({ added: 1, updated: 1, removed: 1, unchanged: 1 });
    expect(plan.removes).toEqual([{ type: 'snippets', id: 'c' }]);
    expect(plan.upserts.map((u) => u.item.id)).toEqual(['a', 'b', 'd']);
  });

  it('只覆盖凭证时，引用了被删凭证的本地主机和分组置空', () => {
    const local = ds({
      credentials: [cred('c1', 'x'), cred('c2', 'y')],
      hostGroups: [folder('f', 'F', null, { defaultCredentialId: 'c2' })],
      hosts: [host('h', 'web', '1.1.1.1', { authMethod: 'CREDENTIAL', credentialId: 'c2' })],
    });
    const plan = planReplace(local, ds({ credentials: [cred('c1', 'x')] }), ['CREDENTIALS']);
    expect(plan.removes).toEqual([{ type: 'credentials', id: 'c2' }]);
    expect(plan.detach).toEqual([
      { type: 'hosts', id: 'h', field: 'credentialId' },
      { type: 'hostGroups', id: 'f', field: 'defaultCredentialId' },
    ]);
  });

  it('父分组先写；引用不到的置空并报告', () => {
    const inc = ds({
      hostGroups: [folder('child', 'c', 'root'), folder('root', 'r')],
      hosts: [host('h', 'web', '1.1.1.1', { folderId: 'child', authMethod: 'CREDENTIAL', credentialId: 'gone' })],
    });
    const plan = planReplace(emptyDataset(), inc, ['HOSTS']);
    expect(plan.upserts.map((u) => u.item.id)).toEqual(['root', 'child', 'h']);
    expect(plan.upserts[2].item).toMatchObject({ credentialId: null, folderId: 'child' });
    expect(plan.report.unresolvedRefs).toEqual([{ type: 'hosts', id: 'h', name: 'web', field: 'credentialId' }]);
  });
});
