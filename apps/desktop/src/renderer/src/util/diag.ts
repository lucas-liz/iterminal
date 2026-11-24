import type { DiagEntry } from '@itm/protocol';
import { useApp } from '../store/app';

/**
 * 界面的操作轨迹（第十三轮，文档一 6.27.1），参考 Sentry 的 breadcrumbs：切换页面、点了哪个按钮 / 菜单项、
 * 未捕获的异常、未处理的 Promise 拒绝、console.error / warn。每 2 秒批量交给主进程（diag.push），由主进程脱敏后写日志。
 * 不记输入框的内容。
 */
const queue: DiagEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  timer = null;
  if (!queue.length) return;
  const entries = queue.splice(0, 200);
  void window.itm.invoke('diag.push', { entries }).catch(() => undefined);
  if (queue.length) schedule();
}

function schedule(): void {
  timer ??= setTimeout(flush, 2000);
}

export function crumb(e: Omit<DiagEntry, 't' | 'src'>): void {
  queue.push({ ...e, t: Date.now() });
  if (queue.length > 500) queue.splice(0, queue.length - 500);
  if (e.level === 'error') {
    if (timer) clearTimeout(timer);
    flush();
  } else schedule();
}

/** 点击的目标：按钮文字、data-testid、aria-label、菜单项文字（最多 60 个字） */
function describe(el: Element): string | null {
  const target = el.closest('button, a, [role="menuitem"], [role="tab"], [role="option"], .ant-dropdown-menu-item, .ant-menu-item, .ant-segmented-item, .ant-tabs-tab, [data-testid]');
  if (!target) return null;
  const testid = target.getAttribute('data-testid');
  const aria = target.getAttribute('aria-label') ?? target.getAttribute('title');
  const text = (target.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const kind = target.getAttribute('role') ?? target.tagName.toLowerCase();
  const parts = [kind, text && `「${text}」`, testid && `#${testid}`, !text && aria ? `(${aria.slice(0, 40)})` : null].filter(Boolean);
  return parts.join(' ').slice(0, 120);
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : (() => {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })()))
    .join(' ')
    .slice(0, 1000);
}

let installed = false;

/**
 * 浮层探针（第三十五轮，排查 Windows 包里提示 / 下拉 / 右键菜单不显示）：antd 的浮层节点出现后 400ms，记下它的位置、大小、
 * 透明度、可见性，以及浮层中心点最上面是哪个元素；右键、悬停、点击之后 700ms 还没有可见的浮层也记一条。每次启动最多 60 条。
 */
const POPUP_SEL = '.ant-tooltip, .ant-popover, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown';
let probeLeft = 60;
function probe(msg: string, data: Record<string, unknown>): void {
  if (probeLeft-- <= 0) return;
  crumb({ level: 'warn', cat: 'ui', msg: `[浮层] ${msg}`, data });
}
function elDesc(el: Element | null): string {
  if (!el) return 'null';
  const cls = typeof el.className === 'string' ? el.className : '';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls ? `.${cls.trim().split(/\s+/).slice(0, 4).join('.')}` : ''}`.slice(0, 160);
}
function popupState(el: Element): Record<string, unknown> {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return {
    el: elDesc(el),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    style: (el.getAttribute('style') ?? '').slice(0, 200),
    display: cs.display,
    visibility: cs.visibility,
    opacity: cs.opacity,
    zIndex: cs.zIndex,
    pointer: cs.pointerEvents,
    animation: `${cs.animationName} ${cs.animationDuration}`,
    top: r.width > 0 && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight ? elDesc(document.elementFromPoint(cx, cy)) : 'offscreen',
    view: [innerWidth, innerHeight, devicePixelRatio],
  };
}
function visiblePopups(): number {
  return [...document.querySelectorAll(POPUP_SEL)].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight;
  }).length;
}
function installPopupProbe(): void {
  new MutationObserver((list) => {
    for (const m of list)
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue;
        const el = n.matches(POPUP_SEL) ? n : n.querySelector(POPUP_SEL);
        if (el) setTimeout(() => probe('浮层出现', popupState(el)), 400);
      }
  }).observe(document.body, { childList: true, subtree: true });
  const after = (kind: string, target: EventTarget | null, pointerType?: string): void => {
    const what = target instanceof Element ? (describe(target) ?? elDesc(target)) : null;
    setTimeout(() => {
      if (visiblePopups() > 0) return;
      probe(`${kind}后没有可见的浮层`, { target: what, pointerType, popups: [...document.querySelectorAll(POPUP_SEL)].slice(-3).map(popupState) });
    }, 700);
  };
  document.addEventListener('contextmenu', (ev) => after('右键', ev.target, (ev as PointerEvent).pointerType), true);
  document.addEventListener(
    'pointerover',
    (ev) => {
      const t = ev.target instanceof Element ? ev.target.closest('[data-testid="rail-more"], .icon-rail .rail-btn, [data-testid="avatar-trigger"]') : null;
      if (t) after('悬停', t, ev.pointerType);
    },
    true,
  );
  document.addEventListener(
    'click',
    (ev) => {
      const t = ev.target instanceof Element ? ev.target.closest('[data-testid="tab-new"], [data-testid="avatar-trigger"]') : null;
      if (t) after('点击', t, (ev as PointerEvent).pointerType);
    },
    true,
  );
}

export function installDiag(): void {
  if (installed) return;
  installed = true;
  crumb({ level: 'info', cat: 'app', msg: '界面加载', data: { url: location.pathname.split('/').pop(), width: innerWidth, height: innerHeight, dpr: devicePixelRatio, ua: navigator.userAgent.slice(0, 160), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, hover: matchMedia('(hover: hover)').matches, pointer: matchMedia('(pointer: fine)').matches ? 'fine' : matchMedia('(pointer: coarse)').matches ? 'coarse' : 'none' } });
  try {
    installPopupProbe();
  } catch {
    // 探针失败不影响界面
  }
  // 点击（捕获阶段，不影响页面自己的处理）
  document.addEventListener(
    'click',
    (ev) => {
      const d = ev.target instanceof Element ? describe(ev.target) : null;
      if (d) crumb({ level: 'info', cat: 'ui', msg: `点击 ${d}` });
    },
    true,
  );
  // 键盘快捷键（只记组合键，不记输入的字符）
  document.addEventListener(
    'keydown',
    (ev) => {
      if (!(ev.metaKey || ev.ctrlKey || ev.altKey) || ['Meta', 'Control', 'Alt', 'Shift'].includes(ev.key)) return;
      const combo = [ev.metaKey && 'Meta', ev.ctrlKey && 'Ctrl', ev.altKey && 'Alt', ev.shiftKey && 'Shift', ev.key.length === 1 ? ev.key.toUpperCase() : ev.key].filter(Boolean).join('+');
      crumb({ level: 'debug', cat: 'ui', msg: `快捷键 ${combo}` });
    },
    true,
  );
  window.addEventListener('error', (ev) => {
    crumb({ level: 'error', cat: 'error', msg: `界面异常：${ev.message}`, data: { source: String(ev.filename ?? '').split('/').pop(), line: ev.lineno, col: ev.colno, stack: ev.error instanceof Error ? ev.error.stack?.split('\n').slice(0, 12).join('\n') : undefined } });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as unknown;
    crumb({ level: 'error', cat: 'error', msg: `界面未处理的 Promise 拒绝：${r instanceof Error ? r.message : String(r)}`, data: r instanceof Error ? { stack: r.stack?.split('\n').slice(0, 12).join('\n') } : undefined });
  });
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      try {
        const msg = fmt(args);
        // React / antd 的开发提示太多：只记一次
        if (level === 'warn' && /^Warning: |\[antd/.test(msg) && seen.has(msg.slice(0, 80))) return;
        seen.add(msg.slice(0, 80));
        crumb({ level, cat: 'console', msg, ...(args.find((a) => a instanceof Error) ? { data: { stack: (args.find((a) => a instanceof Error) as Error).stack?.split('\n').slice(0, 12).join('\n') } } : {}) });
      } catch {
        // 记日志失败不影响 console
      }
    };
  }
  // 页面和设置模块的切换
  let last = '';
  useApp.subscribe((s) => {
    const where = `${s.page}${s.page === 'ai' ? `/${s.aiView}` : ''}${s.page === 'settings' || s.aiView === 'settings' ? `/${s.settingsSection}` : ''}`;
    if (where !== last) {
      last = where;
      crumb({ level: 'info', cat: 'ui', msg: `切换到 ${where}` });
    }
  });
  window.addEventListener('beforeunload', () => flush());
}

const seen = new Set<string>();
