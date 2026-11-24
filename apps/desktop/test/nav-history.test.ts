import { describe, expect, it } from 'vitest';
import {
  AI_PRIMARY_NAV_KEYS,
  MAX_NAV_HISTORY,
  OVERFLOW_NAV_KEYS,
  PRIMARY_NAV_KEYS,
  pageHasSecondarySider,
  pushNavHistory,
  type NavEntry,
} from '../src/renderer/src/util/nav';

describe('侧边栏与导航历史（第三十四轮）', () => {
  it('终端模式常驻 5 项（终端在首位、批量执行在末位，第三十五轮去掉定时任务）；AI 模式首位切换为 AI 且隐藏主机', () => {
    expect(PRIMARY_NAV_KEYS).toEqual(['workspace', 'hosts', 'notes', 'audit', 'batch']);
    expect(AI_PRIMARY_NAV_KEYS).toEqual(['ai', 'notes', 'audit', 'batch']);
    expect(AI_PRIMARY_NAV_KEYS).not.toContain('hosts');
    expect(OVERFLOW_NAV_KEYS).toEqual(['databases', 'snippets', 'monitor', 'approvals']);
    expect(PRIMARY_NAV_KEYS).not.toContain('settings');
    expect(OVERFLOW_NAV_KEYS).not.toContain('settings');
  });

  it('准确识别带次级侧边栏的页面', () => {
    for (const p of ['ai', 'hosts', 'databases', 'snippets', 'notes', 'settings'] as const) {
      expect(pageHasSecondarySider(p)).toBe(true);
    }
    for (const p of ['workspace', 'monitor', 'audit', 'batch', 'approvals'] as const) {
      expect(pageHasSecondarySider(p)).toBe(false);
    }
  });

  it('导航历史支持模式切换记录、去重、设置分组区分、截断前进栈并限制上限', () => {
    let state: { navHistory: NavEntry[]; navIndex: number } = {
      navHistory: [{ mode: 'terminal', page: 'workspace', aiView: 'chat' }],
      navIndex: 0,
    };
    state = pushNavHistory(state.navHistory, state.navIndex, { mode: 'terminal', page: 'hosts', aiView: 'chat' });
    state = pushNavHistory(state.navHistory, state.navIndex, { mode: 'terminal', page: 'hosts', aiView: 'chat' }); // 连续重复不入栈
    state = pushNavHistory(state.navHistory, state.navIndex, { mode: 'ai', page: 'ai', aiView: 'chat' });
    state = pushNavHistory(state.navHistory, state.navIndex, { mode: 'ai', page: 'settings', aiView: 'chat', settingsSection: 'terminal' });
    state = pushNavHistory(state.navHistory, state.navIndex, { mode: 'ai', page: 'settings', aiView: 'chat', settingsSection: 'security' });

    expect(state.navHistory.map((x) => `${x.mode}:${x.page}${x.page === 'settings' ? `:${x.settingsSection}` : ''}`)).toEqual([
      'terminal:workspace',
      'terminal:hosts',
      'ai:ai',
      'ai:settings:terminal',
      'ai:settings:security',
    ]);
    expect(state.navIndex).toBe(4);

    // 回到索引 2（ai）后再跳转 notes，截断后面的前进历史
    state = pushNavHistory(state.navHistory, 2, { mode: 'ai', page: 'notes', aiView: 'chat' });
    expect(state.navHistory.map((x) => `${x.mode}:${x.page}`)).toEqual(['terminal:workspace', 'terminal:hosts', 'ai:ai', 'ai:notes']);
    expect(state.navIndex).toBe(3);

    // 超过上限时裁剪最早记录
    for (let i = 0; i < MAX_NAV_HISTORY + 10; i++) {
      state = pushNavHistory(state.navHistory, state.navIndex, { mode: 'terminal', page: i % 2 === 0 ? 'hosts' : 'notes', aiView: 'chat' });
    }
    expect(state.navHistory.length).toBe(MAX_NAV_HISTORY);
    expect(state.navIndex).toBe(MAX_NAV_HISTORY - 1);
  });
});
