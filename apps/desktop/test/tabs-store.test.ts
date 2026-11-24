import { beforeEach, describe, expect, it } from 'vitest';
import { activePane, leaves, useTabs } from '../src/renderer/src/store/tabs';

const t = () => useTabs.getState();

beforeEach(() => {
  useTabs.setState({ tabs: [], activeId: null, layouts: {}, focused: {}, broadcast: { on: false, targets: [] } });
});

describe('标签与分屏', () => {
  it('分屏：窗格不出现在标签栏，布局树记录位置，焦点在新窗格', () => {
    const a = t().open({ kind: 'ssh', title: 'web', hostId: 'h1' });
    const b = t().split(a, 'h', { kind: 'local', title: '本地' });
    const c = t().split(b, 'v', { kind: 'ssh', title: 'db', hostId: 'h2' });
    expect(t().tabs.filter((x) => !x.parentId).map((x) => x.id)).toEqual([a]);
    expect(t().layouts[a]).toEqual({
      type: 'split', dir: 'h', children: [{ type: 'leaf', tabId: a }, { type: 'split', dir: 'v', children: [{ type: 'leaf', tabId: b }, { type: 'leaf', tabId: c }] }],
    });
    expect(activePane(t())?.id).toBe(c);
    // 同方向继续分：并列，不嵌套
    const d = t().split(a, 'h', { kind: 'local', title: '本地 2' });
    expect(leaves(t().layouts[a])).toEqual([a, d, b, c]);
  });

  it('关闭窗格：剩一个时退回普通标签；关闭根窗格时由下一个窗格接替', () => {
    const a = t().open({ kind: 'ssh', title: 'web' });
    const b = t().split(a, 'h', { kind: 'local', title: 'x' });
    t().closePane(b);
    expect(t().layouts[a]).toBeUndefined();
    expect(t().tabs.map((x) => x.id)).toEqual([a]);

    const c = t().split(a, 'h', { kind: 'local', title: 'y' });
    const d = t().split(c, 'v', { kind: 'local', title: 'z' });
    t().setBroadcast(true, [a, c, d]);
    t().closePane(a);
    expect(t().activeId).toBe(c);
    expect(t().tabs.find((x) => x.id === c)?.parentId).toBeUndefined();
    expect(t().tabs.find((x) => x.id === d)?.parentId).toBe(c);
    expect(leaves(t().layouts[c])).toEqual([c, d]);
    expect(t().broadcast.targets).toEqual([c, d]);
  });

  it('关闭整个标签：连同所有窗格，激活相邻的标签', () => {
    const a = t().open({ kind: 'ssh', title: 'a' });
    t().split(a, 'h', { kind: 'local', title: 'x' });
    const b = t().open({ kind: 'ssh', title: 'b' });
    t().activate(a);
    t().close(a);
    expect(t().tabs.map((x) => x.id)).toEqual([b]);
    expect(t().activeId).toBe(b);
    expect(t().layouts).toEqual({});
  });
});
