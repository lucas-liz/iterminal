import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type AgentConversationView, type AgentStep, type MetricsSnapshot } from '@itm/protocol';
import { conversationToMarkdown } from '../src/main/services/ai/conversation-md';
import { applyMonitorFilters } from '../src/main/services/monitor/monitor-service';
import { SkillStore } from '../src/main/services/ai/skills';

const step = (p: Partial<AgentStep>): AgentStep =>
  ({ id: 's', tool: 'run_command', hostLabel: 't1', hostName: 'web-1', command: '', level: 'L0', reasons: [], status: 'done', exitCode: 0, output: '', startedAt: 1, finishedAt: 2, ...p }) as AgentStep;

describe('对话导出为 Markdown', () => {
  const t = new Date(2026, 9, 15, 9, 30).getTime();
  const view = (): AgentConversationView =>
    ({
      id: 'c1',
      title: 'nginx 502 排查',
      model: { providerId: 'p', modelId: 'gpt-x' },
      running: false,
      streamingText: '',
      streamingThinking: '',
      usage: { window: 1, used: 0, percent: 0, categories: {} },
      error: null,
      updatedAt: t,
      messages: [
        { id: 'u1', role: 'user', text: '为什么 502？', refLabels: ['t1 web-1'], mode: 'agent', createdAt: t, compacted: false },
        {
          id: 'a1',
          role: 'assistant',
          text: '上游 php-fpm 没起来，已重启。',
          thinking: '这里是思考过程，不应该导出',
          model: 'gpt-x',
          createdAt: t,
          compacted: false,
          steps: [
            step({ command: 'systemctl status php-fpm', explanation: '看服务状态', output: 'inactive (dead)\n```\nx' }),
            step({ id: 's2', command: 'systemctl restart php-fpm', level: 'L1', exitCode: 0, output: 'x'.repeat(50) }),
          ],
        },
        { id: 'n1', role: 'notice', text: '达到循环上限', createdAt: t },
      ],
    }) as unknown as AgentConversationView;

  it('包含问题、回答、命令（主机、风险、作用、退出码）和截断的输出；不导出思考过程', () => {
    const md = conversationToMarkdown(view(), { maxOutput: 30, now: t });
    expect(md.startsWith('# nginx 502 排查\n')).toBe(true);
    expect(md).toContain('> 导出于 2026-10-15 09:30 · 模型 gpt-x');
    expect(md).toContain('## 问题 · 2026-10-15 09:30\n\n为什么 502？');
    expect(md).toContain('*引用：t1 web-1*');
    expect(md).toContain('上游 php-fpm 没起来，已重启。');
    expect(md).toContain('**执行命令** · web-1（t1） · 安全 · 完成 · 退出码 0');
    expect(md).toContain('> 作用：看服务状态');
    expect(md).toContain('```bash\nsystemctl restart php-fpm\n```');
    expect(md).toContain('· 需注意 ·');
    // 输出里有 ``` 时用更长的围栏
    expect(md).toContain('````\ninactive (dead)\n```\nx\n````');
    expect(md).toContain('（输出共 50 个字符，已截断）');
    expect(md).toContain('> 达到循环上限');
    expect(md).not.toContain('思考过程');
  });

  it('maxOutput 为 0 时不带输出', () => {
    const md = conversationToMarkdown(view(), { maxOutput: 0, now: t });
    expect(md).not.toContain('<details>');
    expect(md).toContain('systemctl status php-fpm');
  });
});

describe('监控配置', () => {
  const snap = (): MetricsSnapshot =>
    ({
      hostId: 'h',
      ts: 1,
      state: 'ok',
      disks: [
        { mount: '/', size: 50e9 },
        { mount: '/boot/efi', size: 500e6 },
        { mount: '/run/user/0', size: 10e9 },
        { mount: '/var/lib/docker/overlay2/abc/merged', size: 50e9 },
        { mount: '/data', size: 1e12 },
        { mount: '/tiny', size: 100e6 },
      ],
      net: [{ name: 'eth0' }, { name: 'lo' }, { name: 'docker0' }, { name: 'veth12ab' }, { name: 'br-1234' }, { name: 'ens33' }],
    }) as unknown as MetricsSnapshot;
  const mounts = (s: MetricsSnapshot): string[] => (s.state === 'ok' ? s.disks.map((d) => d.mount) : []);
  const nics = (s: MetricsSnapshot): string[] => (s.state === 'ok' ? s.net.map((n) => n.name) : []);
  const cfg = DEFAULT_SETTINGS['monitor.config'];

  it('默认隐藏特殊分区、容器挂载点和虚拟网卡', () => {
    const out = applyMonitorFilters(snap(), cfg);
    expect(mounts(out)).toEqual(['/', '/data']);
    expect(nics(out)).toEqual(['eth0', 'ens33']);
  });

  it('关掉隐藏选项后全部显示；指定挂载点 / 网卡时只显示这些', () => {
    const all = applyMonitorFilters(snap(), { ...cfg, hideSpecialFs: false, hideDockerFs: false, hideVirtualNics: false });
    expect(mounts(all)).toHaveLength(6);
    expect(nics(all)).toHaveLength(6);
    const only = applyMonitorFilters(snap(), { ...cfg, mounts: '/data, /boot/efi', nics: 'docker0;eth0' });
    expect(mounts(only)).toEqual(['/boot/efi', '/data']);
    expect(nics(only)).toEqual(['eth0', 'docker0']);
  });

  it('出错的快照和没有配置时原样返回', () => {
    const err = { hostId: 'h', ts: 1, state: 'error', message: 'x' } as MetricsSnapshot;
    expect(applyMonitorFilters(err, cfg)).toBe(err);
    const s = snap();
    expect(applyMonitorFilters(s, null)).toBe(s);
  });
});

describe('手动创建 Skill', () => {
  let dir: string;
  let store: SkillStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'itm-skill-'));
    store = new SkillStore(join(dir, 'skills'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const md = (name: string, extra = ''): string => `---\nname: ${name}\ntitle: 重载 Nginx\ndescription: 检查语法后重载\nrisk: write-needs-approval\n${extra}---\n# 步骤\n1. nginx -t\n`;

  it('新建：用 name 作目录；读取原文；修改后目录不变；删除整个目录', () => {
    const s = store.save(null, md('nginx-reload', 'params:\n  - { name: port, type: number, default: 80 }\n'));
    expect(s).toMatchObject({ id: 'nginx-reload', name: 'nginx-reload', title: '重载 Nginx', risk: 'write-needs-approval', params: [{ name: 'port', type: 'number', default: 80 }] });
    expect(store.list().map((x) => x.id)).toContain('nginx-reload');
    expect(store.read('nginx-reload')).toContain('nginx -t');

    const edited = store.save('nginx-reload', md('nginx-reload2').replace('检查语法后重载', '改过的说明'));
    expect(edited.id).toBe('nginx-reload');
    expect(edited.description).toBe('改过的说明');
    expect(readFileSync(join(dir, 'skills', 'nginx-reload', 'SKILL.md'), 'utf8')).toContain('改过的说明');

    store.delete('nginx-reload');
    expect(existsSync(join(dir, 'skills', 'nginx-reload'))).toBe(false);
    expect(() => store.read('nginx-reload')).toThrow('Skill 不存在');
  });

  it('校验 front matter、名称、说明和重名；拒绝目录穿越', () => {
    expect(() => store.save(null, '# 没有 front matter')).toThrow('front matter');
    expect(() => store.save(null, '---\nname: [a\n---\nx')).toThrow('不是合法的 YAML');
    expect(() => store.save(null, md('../evil'))).toThrow('name 只能用字母');
    expect(() => store.save(null, '---\nname: ok\n---\nx')).toThrow('请填写 description');
    store.save(null, md('dup'));
    expect(() => store.save(null, md('dup'))).toThrow('已经有名为「dup」的 Skill');
    expect(() => store.save('../x', md('x'))).toThrow('Skill 不存在');
    expect(() => store.save('missing', md('missing'))).toThrow('Skill 不存在');
    expect(() => store.delete('..')).toThrow('Skill 不存在');
    expect(() => store.read('../skills')).toThrow('Skill 不存在');
  });
});
