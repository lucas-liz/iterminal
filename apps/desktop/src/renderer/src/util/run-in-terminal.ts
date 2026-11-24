import type { Host } from '@itm/protocol';
import { useApp } from '../store/app';
import { useHosts } from '../store/hosts';
import { activePane, rootOf, useTabs, type Tab } from '../store/tabs';
import { currentTerminal, readyTerminals, sendToTerminals } from '../store/library';

/** 运行目标：某台主机，或者「当前终端」（没有终端时打开本地终端） */
export interface RunTarget {
  hostId: string | null;
  label: string;
}

const CONNECT_TIMEOUT = 60_000;

/** 切到这个终端（分屏里的窗格先切标签再聚焦），并切到终端页 */
function show(tab: Tab): void {
  const s = useTabs.getState();
  s.activate(rootOf(s.tabs, tab.id));
  if (tab.parentId) s.focus(tab.id);
  useApp.getState().setPage('workspace');
}

/** 等终端连上（ready 且有会话 ID）；连接失败、被关闭或超时返回 null */
function waitReady(tabId: string): Promise<Tab | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (t: Tab | null): void => {
      if (done) return;
      done = true;
      unsub();
      clearTimeout(timer);
      resolve(t);
    };
    const check = (tabs: Tab[]): void => {
      const t = tabs.find((x) => x.id === tabId);
      if (!t || t.status === 'closed' || t.status === 'error') finish(null);
      else if (t.status === 'ready' && t.sessionId) finish(t);
    };
    const unsub = useTabs.subscribe((s) => check(s.tabs));
    const timer = setTimeout(() => finish(null), CONNECT_TIMEOUT);
    check(useTabs.getState().tabs);
  });
}

/** 打开一个终端标签并等它连上；shell 刚启动时给它一点时间显示提示符 */
async function openAndWait(tab: Omit<Tab, 'id' | 'status'>): Promise<Tab | null> {
  const id = useTabs.getState().open(tab);
  useApp.getState().setPage('workspace');
  const t = await waitReady(id);
  if (t) await new Promise((r) => setTimeout(r, 400));
  return t;
}

function terminalKind(h: Host): Tab['kind'] {
  return h.protocol === 'TELNET' ? 'telnet' : h.protocol === 'SERIAL' ? 'serial' : 'ssh';
}

/**
 * 在终端里执行一条命令（第十五轮，参考 iShell 运维模式的「在终端运行」）：
 * - 指定了主机：这台主机有已连接的终端就切过去执行（当前看着的优先）；没有就新开这台主机的终端，连上后执行；
 * - 没有指定主机：在当前终端执行；一个已连接的终端都没有时打开本地终端执行。
 * 返回执行所在终端的标题；失败时抛出原因。
 */
export async function runInTerminal(command: string, hostId: string | null): Promise<string> {
  const text = command.trim();
  if (!text) throw new Error('没有要执行的命令');
  let target: Tab | null | undefined = null;
  if (hostId) {
    const host = useHosts.getState().hosts.find((h) => h.id === hostId);
    if (!host) throw new Error('主机已经不存在');
    const cur = currentTerminal();
    target = cur?.hostId === hostId ? cur : readyTerminals().find((t) => t.hostId === hostId);
    if (!target) {
      target = await openAndWait({ kind: terminalKind(host), title: host.name, hostId: host.id });
      if (!target) throw new Error(`连接 ${host.name} 失败，命令没有执行`);
    }
  } else {
    target = currentTerminal() ?? (() => {
      // 当前标签是 SFTP 或者还在连接：用最后一个已连接的终端
      const ready = readyTerminals();
      return ready[ready.length - 1];
    })();
    if (!target) {
      target = await openAndWait({ kind: 'local', title: '本地终端' });
      if (!target) throw new Error('打开本地终端失败，命令没有执行');
    }
  }
  show(target);
  if (sendToTerminals([target.id], text, true) === 0) throw new Error('终端已经断开，命令没有执行');
  return target.title;
}

/** 发到指定的终端执行并切过去；这个终端不可用（没给、断开了、是 SFTP 标签）时按主机找终端执行（同 runInTerminal） */
export async function runInTab(command: string, tabId: string | null, hostId: string | null): Promise<string> {
  const tab = tabId ? useTabs.getState().tabs.find((t) => t.id === tabId && t.kind !== 'sftp' && t.status === 'ready' && t.sessionId) : undefined;
  if (!tab) return runInTerminal(command, hostId);
  show(tab);
  if (sendToTerminals([tab.id], command, true) === 0) throw new Error('终端已经断开，命令没有执行');
  return tab.title;
}

/**
 * 回答里的命令默认在哪里执行：本轮引用的终端只有一台主机时用它；有多台时优先当前看着的；
 * 没有引用主机时在当前终端（没有就打开本地终端）。
 */
export function defaultTarget(targets: RunTarget[]): RunTarget {
  const hosts = targets.filter((t) => t.hostId);
  if (hosts.length === 1) return hosts[0];
  const pane = activePane(useTabs.getState());
  const cur = hosts.find((t) => t.hostId && t.hostId === pane?.hostId);
  return cur ?? hosts[0] ?? { hostId: null, label: '当前终端' };
}
