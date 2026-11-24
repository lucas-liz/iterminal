/**
 * 第三十轮：监控卡片「引用当前状态到 AI」的文字；主机列表「导出主机记忆」的 Markdown、「AI 汇总为笔记」发给模型的资料、
 * 某台主机最近执行过的命令（去重）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AlertEvent, MetricSample, MetricsSnapshot, TaskRunView } from '@itm/protocol';
import { openDatabase, type Db } from '../src/main/services/db/database';
import { AuditRepo } from '../src/main/services/audit/audit-repo';
import { hostMemoryMarkdown, hostProfileText, memoryFileName, metricsSummary } from '../src/main/services/hosts/host-profile';
import { cardQuoteText } from '../src/renderer/src/util/monitor-attention';
import { createRepos } from './support/repos';

const NOW = new Date(2026, 9, 22, 10, 0, 0).getTime();

function withRepos(fn: (r: ReturnType<typeof createRepos> & { db: Db }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'itm-r30-'));
  const db = openDatabase(join(dir, 'db'), randomBytes(32));
  try {
    fn({ ...createRepos(db, randomBytes(32)), db });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = { port: 22, username: 'root', authMethod: 'PASSWORD' as const, password: 'secret-pw', keepaliveSec: 0, startupScript: null, note: null, jumpHostIds: [] };

describe('第三十轮：监控卡片引用到 AI', () => {
  it('当前状态的文字：CPU / 内存 / 分区按使用率排序 / 网络 / 运行时长和需要注意的地方', () => {
    const snap = {
      state: 'ok',
      hostId: 'h1',
      ts: NOW,
      cpu: { usage: 91.24, cores: 4, iowait: 3, user: 80, system: 11 },
      load: [3.2, 2.1, 1.5],
      mem: { total: 1000, used: 850, swapTotal: 100, swapUsed: 60 },
      disks: [
        { mount: '/', usePct: 40 },
        { mount: '/data', usePct: 93 },
      ],
      net: [{ iface: 'eth0', rxBps: 2048, txBps: 1024 }],
      uptimeSec: 3 * 86400 + 7200,
    } as unknown as MetricsSnapshot;
    const t = cardQuoteText({ name: 'web-1', address: '10.0.0.1' }, snap, [
      { level: 'crit', kind: 'cpu', text: 'CPU 91%' },
      { level: 'crit', kind: 'disk', text: '/data 93%' },
    ]);
    expect(t).toContain('主机「web-1」（10.0.0.1）当前监控状态');
    expect(t).toContain('CPU 91.2%（4 核');
    expect(t).toContain('内存 85%，swap 60%');
    expect(t).toContain('分区：/data 93%，/ 40%');
    expect(t).toContain('已运行 3天 2小时');
    expect(t).toContain('需要注意：CPU 91%；/data 93%');
    expect(t.endsWith('需要注意：CPU 91%；/data 93%')).toBe(true);
  });

  it('连不上 / 还没有数据时也能引用', () => {
    const off = { state: 'error', hostId: 'h1', ts: NOW, message: '连接超时' } as unknown as MetricsSnapshot;
    expect(cardQuoteText({ name: 'db', address: '10.0.0.2' }, off, [{ level: 'crit', kind: 'offline', text: '连接超时' }])).toContain('连不上：连接超时');
    expect(cardQuoteText({ name: 'db', address: '10.0.0.2' }, undefined, [])).toContain('还没有采集到数据');
  });
});

describe('第三十轮：导出主机记忆', () => {
  it('一台主机：标题、基本信息、手工记忆按引用块原样保留、Agent 记忆带时间；不含密码', () => {
    withRepos(({ hosts, folders }) => {
      const prod = folders.create(null, '生产');
      const db = folders.create(prod.id, '数据库');
      const h = hosts.create({ ...base, folderId: db.id, name: 'mysql-01', address: '10.0.0.5', port: 2222, note: '主库', aiMemory: '# 端口 3306\n数据目录 /data/mysql' } as never);
      hosts.saveAgentMemory(null, h.id, 'binlog 保留 7 天');
      const host = hosts.require(h.id);
      const md = hostMemoryMarkdown([{ host, folderPath: '生产 / 数据库', memories: hosts.agentMemories(h.id) }], NOW);
      expect(md.startsWith('# mysql-01 · 主机记忆\n')).toBe(true);
      expect(md).toContain('- 地址：`root@10.0.0.5:2222`');
      expect(md).toContain('- 分组：生产 / 数据库');
      expect(md).toContain('- 备注：主库');
      expect(md).toContain('## 主机记忆（手工填写）\n\n> # 端口 3306\n> 数据目录 /data/mysql');
      expect(md).toContain('## Agent 记忆\n\n- binlog 保留 7 天');
      expect(md).not.toContain('secret-pw');
      expect(memoryFileName([host], NOW)).toBe('mysql-01-主机记忆.md');
    });
  });

  it('多台主机：每台一节，没有记忆的主机跳过；全部都没有时列出并注明', () => {
    withRepos(({ hosts }) => {
      const a = hosts.create({ ...base, folderId: null, name: 'a', address: '10.0.0.1', aiMemory: 'nginx 在 /opt/nginx' } as never);
      const b = hosts.create({ ...base, folderId: null, name: 'b', address: '10.0.0.2' } as never);
      const entries = [a, b].map((h) => ({ host: hosts.require(h.id), folderPath: '', memories: hosts.agentMemories(h.id) }));
      const md = hostMemoryMarkdown(entries, NOW);
      expect(md).toContain('# 主机记忆');
      expect(md).toContain('共 1 台主机');
      expect(md).toContain('## a');
      expect(md).toContain('### 主机记忆（手工填写）');
      expect(md).not.toContain('## b');
      expect(memoryFileName(entries.map((e) => e.host), NOW)).toBe('主机记忆-20261022.md');
      const none = hostMemoryMarkdown([entries[1]], NOW);
      expect(none).toContain('_这些主机都还没有记忆。_');
    });
  });
});

describe('第三十轮：AI 汇总主机为笔记', () => {
  it('最近 7 天监控概况：平均 / 最高、分区变化、写满预测', () => {
    const s = (ts: number, cpu: number, mem: number, root: number): MetricSample => ({ ts, cpu, mem, load1: cpu / 50, disk: { '/': root }, netRx: null, netTx: null });
    const lines = metricsSummary([s(NOW - 7 * 86400_000, 10, 40, 60), s(NOW - 3600_000, 30, 60, 75)], [{ mount: '/', usedPct: 75, slopePerDay: 2.1, daysToFull: 11.9, samples: 160 }]);
    expect(lines[0]).toContain('采样 2 个整点');
    expect(lines).toContain('CPU 平均 20.0%，最高 30.0%');
    expect(lines).toContain('内存 平均 50.0%，最高 60.0%');
    expect(lines).toContain('分区：/ 75%（7 天前 60%）');
    expect(lines).toContain('/ 每天增长约 2.1 个百分点，预计 11.9 天后写满');
    expect(metricsSummary([], [])).toEqual([]);
  });

  it('一台主机的资料：基本信息、记忆、告警（带 AI 排查）、定时任务、命令；不含密码', () => {
    withRepos(({ hosts }) => {
      const h = hosts.create({ ...base, folderId: null, name: 'web-1', address: '10.0.0.1', aiMemory: '站点在 /srv/www' } as never);
      const host = hosts.require(h.id);
      const alert = {
        createdAt: NOW - 86400_000,
        level: 'CRIT',
        title: 'CPU 超过 90%',
        count: 3,
        status: 'RESOLVED',
        diagnosis: { status: 'DONE', conversationId: null, report: '结论：异常\njava 进程 GC 频繁', level: 'ERROR', message: null, startedAt: null, endedAt: null },
      } as unknown as AlertEvent;
      const run = { runId: 'r', taskId: 't', taskName: '每日巡检', type: 'AI', status: 'SUCCESS', target: '', startedAt: NOW - 3600_000, endedAt: NOW, summary: '结论：正常', reportLevel: 'OK', hosts: [] } as unknown as TaskRunView;
      const text = hostProfileText({
        host,
        folderPath: '',
        memories: [{ id: 'm', hostId: h.id, content: 'nginx 只能 reload', conversationId: null, createdAt: NOW, updatedAt: NOW }],
        jumpNames: ['bastion'],
        samples: [],
        forecast: [],
        alerts: [alert],
        runs: [run],
        commands: [{ command: 'systemctl  reload nginx', source: 'AGENT', exitCode: 0, createdAt: NOW }],
      });
      expect(text).toContain('## 主机：web-1');
      expect(text).toContain('- 经跳板机：bastion');
      expect(text).toContain('### 主机记忆（手工填写）\n站点在 /srv/www');
      expect(text).toContain('- nginx 只能 reload');
      expect(text).toContain('[CRIT] CPU 超过 90%（3 次），已恢复；AI 排查：结论：异常 java 进程 GC 频繁');
      expect(text).toContain('每日巡检 · SUCCESS · 结论 OK：结论：正常');
      expect(text).toContain('- `systemctl reload nginx` (AGENT)');
      expect(text).not.toContain('最近 7 天监控');
      expect(text).not.toContain('secret-pw');
    });
  });

  it('某台主机最近执行过的命令：同一条只取最近一次，新的在前，按数量截断，只看这台主机和时间范围内的', () => {
    withRepos(({ db }) => {
      let t = NOW - 10_000;
      const repo = new AuditRepo(db, () => (t += 1000));
      repo.command({ source: 'USER', hostId: 'h1', hostName: 'a', command: 'df -h' });
      repo.command({ source: 'AGENT', hostId: 'h1', hostName: 'a', command: 'free -m', exitCode: 0 });
      repo.command({ source: 'USER', hostId: 'h2', hostName: 'b', command: 'uptime' });
      repo.command({ source: 'USER', hostId: 'h1', hostName: 'a', command: 'df -h', exitCode: 1 });
      expect(repo.hostCommands('h1', 0, 10).map((c) => [c.command, c.exitCode])).toEqual([
        ['df -h', 1],
        ['free -m', 0],
      ]);
      expect(repo.hostCommands('h1', 0, 1)).toHaveLength(1);
      expect(repo.hostCommands('h1', NOW, 10)).toEqual([]);
    });
  });
});
