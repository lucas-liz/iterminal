import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { searchSettings, SETTINGS_INDEX } from '../src/renderer/src/pages/settings/search-index';

/** 设置页的源文件：所有写死的设置行名称（label="…"）和分组标题（title="…"） */
const DIR = join(__dirname, '../src/renderer/src/pages/settings');
function staticLabels(): { file: string; label: string }[] {
  const out: { file: string; label: string }[] = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.tsx'))) {
    const src = readFileSync(join(DIR, file), 'utf8');
    for (const m of src.matchAll(/<(SettingRow|SettingGroup)\s+(?:key=\{[^}]+\}\s+)?(?:label|title)="([^"]+)"/g)) out.push({ file, label: m[2] });
  }
  return out;
}

/** 不是设置项的行（反馈表单的输入框、只用来展示的信息） */
const NOT_SETTINGS = new Set(['类型', '标题', '描述', '联系方式', '不提交也可以', '平台', '地址', '还没有规则', '开启分享码', '分享范围', '传输', '同名文件', '本地数据']);

describe('设置搜索（第二十二轮）', () => {
  it('每个写死的设置行和分组都在搜索索引里（新加设置时要加到 search-index.ts）', () => {
    const known = new Set(SETTINGS_INDEX.flatMap((i) => [i.label, i.group ?? '']));
    const missing = staticLabels().filter((x) => !known.has(x.label) && !NOT_SETTINGS.has(x.label));
    expect(missing).toEqual([]);
    expect(staticLabels().length).toBeGreaterThan(80);
  });

  it('按名称、说明、关键词搜索，名称命中的排在前面；多个词都要命中', () => {
    expect(searchSettings('右键')[0]).toMatchObject({ section: 'terminal', cat: 'display', label: '右键粘贴' });
    expect(searchSettings('深色')[0]).toMatchObject({ section: 'appearance', label: '主题' });
    expect(searchSettings('导航').map((r) => r.label)).toContain('显示的页面');
    expect(searchSettings('超时').map((r) => r.section)).toEqual(expect.arrayContaining(['terminal', 'models', 'agent']));
    expect(searchSettings('超时 数据库').map((r) => r.label)).toEqual(['查询超时']);
    expect(searchSettings('DeepSeek')[0].label).toBe('模型提供商');
    expect(searchSettings('切换终端')[0]).toMatchObject({ section: 'shortcuts' });
    expect(searchSettings('   ')).toEqual([]);
    expect(searchSettings('不存在的设置项xyz')).toEqual([]);
  });
});
