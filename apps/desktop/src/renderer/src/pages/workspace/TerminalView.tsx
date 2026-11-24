import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Dropdown, Space, Tooltip } from 'antd';
import {
  BookOutlined,
  FontSizeOutlined,
  BorderHorizontalOutlined,
  BorderVerticleOutlined,
  ClearOutlined,
  SearchOutlined,
  HighlightOutlined,
  BgColorsOutlined,
  CopyOutlined,
  FileTextOutlined,
  MessageOutlined,
  RobotOutlined,
  SaveOutlined,
  PlayCircleOutlined,
  SelectOutlined,
  SnippetsOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useShExec } from '../../components/files/ShExecDialog';
import { isShPath } from '../../util/sh-exec';
import { Terminal, type IDecoration, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { SerialSessionState, SessionStatus } from '@itm/protocol';
import { errorMessage, invoke, isMac, subscribeSession } from '../../api';
import { ConnectProgress, EMPTY_PROGRESS, mergeProgress, type ProgressState } from '../../components/ConnectProgress';
import { useHosts } from '../../store/hosts';
import { useAgent } from '../../store/agent';
import { useLibrary } from '../../store/library';
import { useApp } from '../../store/app';
import { useTabs, type Tab } from '../../store/tabs';
import { useTerminalTheme } from '../../util/theme';
import { useColorsDialog } from '../../components/TerminalColorsDialog';
import { compileHighlight, Highlighter } from '../../util/highlight';
import { matchLibrary, mergeSuggestions, SUGGEST_TOTAL } from '../../util/command-library';
import { TermSearch } from './TermSearch';
import { TermSuggest, type SuggestState, type SuggestItem } from './TermSuggest';

import { useHighlightDialog } from '../../components/HighlightDialog';
import { releasePane } from './panes';
import { SerialToolbar } from './SerialToolbar';
import { matchShortcut } from '../../util/shortcuts';
import { useAddSnippet } from '../../components/AddSnippetDialog';
import { TerminalBackdrop } from '../../components/TerminalBackdrop';
import { aiAllowed as aiAllowedNow, useAiAllowed } from '../../util/ai-access';
import { stripPrompt } from '../../util/format';

/** 输入停顿多久之后弹出命令提示 */
const SUGGEST_DELAY_MS = 1000;

interface Props {
  tab: Tab;
  /** 标签可见并且是获得焦点的窗格 */
  active: boolean;
}

/** 括号粘贴模式的起止标记 */
const PASTE_MARKS = /\x1b\[20[01]~/g;
/** 终端里占两列的字符（中日韩、全角） */
function wide(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || c >= 0x20000;
}
/** 当前屏幕上的文字（去掉末尾的空行） */
function screenText(term: Terminal): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = buf.viewportY; y < buf.viewportY + term.rows; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines.join('\n');
}
const erase = (s: string): string => [...s].map((ch) => (wide(ch) ? '\b\b  \b\b' : '\b \b')).join('');
/** 终端的全部输出（回滚区 + 屏幕，折行的接回一行，去掉末尾的空行），断开后按 S 保存 */
function bufferText(term: Terminal): string {
  const buf = term.buffer.normal;
  const out: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const l = buf.getLine(y);
    if (!l) continue;
    const t = l.translateToString(!buf.getLine(y + 1)?.isWrapped);
    if (l.isWrapped && out.length) out[out.length - 1] += t;
    else out.push(t);
  }
  while (out.length && !out.at(-1)!.trim()) out.pop();
  return `${out.join('\n')}\n`;
}
/** 文件名里的时间：20261019-1530 */
function stampNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
/** 长按右键多久打开菜单（右键粘贴时） */
const LONG_PRESS_MS = 450;
/** 第一次右键粘贴时提示过怎么打开菜单 */
const RIGHT_PASTE_TIP = 'itm.term.rightPasteTip';

/**
 * 一个终端窗格：xterm.js + 主进程里的会话（SSH shell 或本地 Shell）。会话结束后保留屏幕内容，可以在原位置重新连接。
 *
 * 文档一 6.1 的终端增强：
 * - 跟踪当前输入行（只在能确定内容时：没有用过方向键、Tab 补全等），回车时记入本机历史；
 * - 行首输入 # 时不发送到远端，在本地显示，回车后转给 AI 面板（# 问 AI）；
 * - 输入停顿约 150ms 后按前缀补全（本机历史 / AI 补全模型），灰色显示，→ 接受（Tab 留给 shell）；
 * - 鼠标（参考 MobaXterm，设置 terminal.mouse）：选中即复制、按下滚轮粘贴、右键单击粘贴；右键粘贴时长按右键或 Ctrl + 右键打开右键菜单；
 * - 右键菜单：复制、粘贴、全选、引用到 AI 对话框（选中内容或当前屏幕）、让 AI 解释选中内容、分屏、清屏；
 * - 会话结束后在终端里提示（参考 MobaXterm）：按 R 重新连接，按 S 把终端输出保存到文件；
 * - 广播输入：在广播组里的窗格输入时，同时写到组里所有会话。
 * 全屏程序（vim、less、top 使用备用屏幕）里不拦截 #、不补全。
 */
export function TerminalView({ tab, active }: Props): React.JSX.Element {
  const { message } = App.useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [searching, setSearching] = useState(false);
  // 命令提示（历史命令 / 内置命令库 / 快捷命令）：sugRef 给按键处理用，sug 给界面用
  const sugRef = useRef<SuggestState | null>(null);
  const [sug, setSug] = useState<SuggestState | null>(null);
  const acceptRef = useRef<(item: SuggestItem) => void>(() => undefined);
  const hlRef = useRef(new Highlighter());
  const fitRef = useRef<FitAddon | null>(null);
  /** 读剪贴板粘贴（带防重复），右键菜单也用 */
  const pasteRef = useRef<() => void>(() => undefined);
  const sessionRef = useRef<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  // 打开右键菜单时的选中内容（用 state，菜单项的可用状态随之刷新）
  const [menuSel, setMenuSel] = useState('');
  /** 右键菜单的位置（菜单挂在这个位置的锚点上，可以由右键、长按右键或 Ctrl + 右键打开） */
  const [ctxAt, setCtxAt] = useState<{ x: number; y: number } | null>(null);
  const openMenuRef = useRef<(x: number, y: number) => void>(() => undefined);
  /** 会话已经结束（断开、失败）：终端里按 R 重新连接、按 S 保存输出 */
  const endedRef = useRef(false);
  const connectRef = useRef<() => Promise<void>>(async () => undefined);
  const saveOutputRef = useRef<() => Promise<void>>(async () => undefined);
  const [serial, setSerial] = useState<SerialSessionState | null>(null);
  /** 正在录制的日志文件 */
  const [logPath, setLogPath] = useState<string | null>(null);

  const toggleLog = async (): Promise<void> => {
    const id = sessionRef.current;
    if (!id) return;
    try {
      if (logPath) {
        await invoke('session.log', { sessionId: id, path: null });
        setLogPath(null);
        message.success('已停止录制日志');
        return;
      }
      const path = await invoke('dialog.saveFile', { title: '录制终端日志到文件', defaultName: `${tab.title.replace(/[\\/:*?"<>|]/g, '_')}-${stampNow()}.log`, filters: [{ name: '日志', extensions: ['log', 'txt'] }] });
      if (!path) return;
      await invoke('session.log', { sessionId: id, path });
      setLogPath(path);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  /** 把终端的全部输出保存到文件（右键菜单、断开后按 S） */
  const saveOutput = async (): Promise<void> => {
    const term = termRef.current;
    if (!term) return;
    try {
      const path = await invoke('dialog.saveText', {
        title: '保存终端输出到文件',
        defaultName: `${tab.title.replace(/[\\/:*?"<>|]/g, '_')}-${stampNow()}.log`,
        content: bufferText(term),
        filters: [{ name: '日志', extensions: ['log', 'txt'] }],
      });
      if (path)
        message.success({
          content: (
            <span>
              {`终端输出已保存到 ${path}`}
              <Button type="link" size="small" onClick={() => void invoke('local.reveal', { path })}>
                显示
              </Button>
            </span>
          ),
        });
    } catch (e) {
      message.error(errorMessage(e));
    }
    term.focus();
  };
  saveOutputRef.current = saveOutput;

  const again = tab.kind === 'local' ? '重新打开' : '重新连接';
  /** 会话结束时写在终端里的提示（参考 MobaXterm 的「Session stopped」） */
  const writeEndHint = (term: Terminal, msg: string, error: boolean): void => {
    endedRef.current = true;
    const rule = '─'.repeat(Math.max(10, Math.min(60, term.cols - 1)));
    term.write(
      `\r\n\x1b[${error ? '31' : '90'}m[${msg}]\x1b[0m\r\n\x1b[90m${rule}\x1b[0m\r\n\r\n` +
        `\x1b[1m会话已结束\x1b[0m\r\n    - 按 \x1b[1;33mR\x1b[0m ${again}\r\n    - 按 \x1b[1;33mS\x1b[0m 把终端输出保存到文件\r\n`,
    );
  };

  const [status, setStatus] = useState<{ status: SessionStatus; message?: string }>({ status: 'connecting' });
  // 连接进度小窗（文档一 6.15.3）：连接超过 250ms 才显示，避免一闪而过；失败时停留
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [overlay, setOverlay] = useState(false);
  const overlayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showsProgress = tab.kind === 'ssh' || tab.kind === 'telnet';
  const setTabStatus = useTabs((s) => s.setStatus);
  const patchTab = useTabs((s) => s.patch);
  const settings = useApp((s) => s.settings);
  const baseTheme = useTerminalTheme();
  // 有背景图片 / 视频时终端透明，底色由 TerminalBackdrop 盖在媒体上
  const bg = settings['terminal.background'];
  const hasBg = bg.kind !== 'none' && !!bg.file;
  const theme = useMemo(() => (hasBg ? { ...baseTheme, background: '#00000000' } : baseTheme), [baseTheme, hasBg]);
  const aiAllowed = useAiAllowed();
  const webglRef = useRef<WebglAddon | null>(null);

  const connect = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    unsubRef.current?.();
    endedRef.current = false;
    setStatus({ status: 'connecting' });
    setTabStatus(tab.id, 'connecting');
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
    setOverlay(false);
    setProgress(showsProgress ? EMPTY_PROGRESS : null);
    if (showsProgress) overlayTimer.current = setTimeout(() => setOverlay(true), 250);
    try {
      const { sessionId } =
        tab.kind === 'ssh'
          ? await invoke('session.openSsh', { hostId: tab.hostId!, cols: term.cols, rows: term.rows })
          : tab.kind === 'telnet'
            ? await invoke('session.openTelnet', { hostId: tab.hostId!, cols: term.cols, rows: term.rows })
            : tab.kind === 'serial'
              ? await invoke('session.openSerial', { hostId: tab.hostId! })
              : await invoke('session.openLocal', { cols: term.cols, rows: term.rows });
      // 连接期间标签已关闭：关掉这个会话，否则串口等资源会一直被占用
      if (termRef.current !== term) {
        void invoke('session.close', { sessionId }).catch(() => undefined);
        return;
      }
      sessionRef.current = sessionId;
      patchTab(tab.id, { sessionId });
      unsubRef.current = subscribeSession(sessionId, {
        onData: (d) => term.write(hlRef.current.process(d)),
        onCwd: (cwd) => patchTab(tab.id, { cwd }),
        onSerial: setSerial,
        onProgress: (p) => {
          setProgress((prev) => mergeProgress(prev ?? EMPTY_PROGRESS, p));
          if (p.state === 'error') {
            if (overlayTimer.current) clearTimeout(overlayTimer.current);
            setOverlay(true);
          } else if (p.state === 'ready' || p.state === 'cancelled') {
            if (overlayTimer.current) clearTimeout(overlayTimer.current);
            overlayTimer.current = setTimeout(() => setOverlay(false), p.state === 'ready' ? 400 : 0);
          }
        },
        onStatus: (st, message) => {
          setStatus({ status: st, message });
          setTabStatus(tab.id, st);
          if (st === 'closed' || st === 'error') {
            sessionRef.current = null;
            setSerial(null);
            setLogPath(null);
            patchTab(tab.id, { sessionId: undefined });
            writeEndHint(term, message ?? '连接已关闭', st === 'error');
          }
          if (st === 'ready' && useTabs.getState().activeId && active) {
            term.focus();
          }
        },
      });
    } catch (e) {
      const message = errorMessage(e);
      setStatus({ status: 'error', message });
      setTabStatus(tab.id, 'error');
      writeEndHint(term, message, true);
    }
  }, [tab.id, tab.kind, tab.hostId, setTabStatus, patchTab, showsProgress]);
  connectRef.current = connect;
  useEffect(() => () => {
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
  }, []);

  // 创建终端（每个窗格只创建一次）
  useEffect(() => {
    const container = containerRef.current!;
    const { settings: s } = useApp.getState();
    const term = new Terminal({
      fontSize: s['terminal.fontSize'],
      fontFamily: s['terminal.fontFamily'],
      scrollback: s['terminal.scrollback'],
      cursorBlink: s['terminal.cursorBlink'],
      cursorStyle: s['terminal.cursorStyle'],
      lineHeight: s['terminal.lineHeight'],
      letterSpacing: s['terminal.letterSpacing'],
      allowTransparency: hasBg,
      allowProposedApi: true,
      macOptionIsMeta: true,
      // 右键单击选中单词（macOS 默认）会改掉选区，选中即复制、右键粘贴时不要
      rightClickSelectsWord: isMac && !s['terminal.mouse'].copyOnSelect && !s['terminal.mouse'].rightPaste,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    term.open(container);
    loadWebgl(term);
    termRef.current = term;
    fitRef.current = fit;
    fit.fit();

    // 粘贴（快捷键、右键菜单）：读剪贴板后交给 xterm。刚刚自己粘贴过同样的内容时，忽略随后到达的原生 paste 事件，
    // 不管它来自浏览器的默认粘贴还是系统菜单，都不会粘两次
    const lastPaste = { text: '', at: 0 };
    const pasteFromClipboard = (): void => {
      void navigator.clipboard.readText().then((t) => {
        if (!t) return;
        lastPaste.text = t;
        lastPaste.at = Date.now();
        term.paste(t);
      });
    };
    pasteRef.current = pasteFromClipboard;
    const onNativePaste = (ev: ClipboardEvent): void => {
      const t = ev.clipboardData?.getData('text/plain') ?? '';
      if (Date.now() - lastPaste.at < 800 && t && t === lastPaste.text) {
        ev.preventDefault();
        ev.stopImmediatePropagation();
      }
    };
    term.textarea?.addEventListener('paste', onNativePaste, true);

    // ---------------------------------------------------------------- 输入行跟踪
    const line = { text: '', reliable: true };
    // 这一行输入开始的位置（提示符之后，缓冲区的绝对行号）：按键跟踪不可靠时（Tab 补全、方向键、↑ 历史、Ctrl+W 等）从屏幕上读回当前输入
    let inputAt: { row: number; col: number } | null = null;
    const hash = { on: false, buf: '' };
    let ghost: { deco: IDecoration; marker: IMarker; suffix: string; x: number } | null = null;
    let compTimer: ReturnType<typeof setTimeout> | null = null;
    let compSeq = 0;

    const fullScreen = (): boolean => term.buffer.active.type === 'alternate';
    const broadcasting = (): boolean => {
      const b = useTabs.getState().broadcast;
      return b.on && b.targets.includes(tab.id);
    };
    const clearGhost = (): void => {
      if (compTimer) clearTimeout(compTimer);
      compTimer = null;
      compSeq++;
      if (ghost) {
        ghost.deco.dispose();
        ghost.marker.dispose();
        ghost = null;
      }
    };
    const record = (cmd: string): void => {
      if (tab.kind === 'ssh' || tab.kind === 'local' || tab.kind === 'telnet') {
        void invoke('completion.record', { hostId: tab.hostId ?? null, command: cmd, sessionId: sessionRef.current }).catch(() => undefined);
      }
    };
    const track = (data: string): void => {
      const d = data.replace(PASTE_MARKS, '');
      for (const ch of d) {
        if (ch === '\r') {
          if (line.reliable && line.text.trim()) record(line.text);
          line.text = '';
          line.reliable = true;
        } else if (ch === '\x7f' || ch === '\b') line.text = line.text.slice(0, -1);
        else if (ch === '\x03' || ch === '\x15') {
          line.text = '';
          line.reliable = true;
        } else if (ch === '\x0c') {
          // Ctrl+L 清屏后提示符重画在别的位置，输入开始的位置不再可信
          inputAt = null;
          line.reliable = false;
        } else if (ch === '\x1b') {
          // 方向键、历史命令等：不再知道这一行的真实内容
          line.reliable = false;
          return;
        } else if (ch < ' ') line.reliable = false;
        else line.text += ch;
      }
    };
    /** 从屏幕上读出提示符之后、光标之前的输入；光标不在输入末尾（移到了中间、右侧有 RPROMPT）或位置对不上时返回 null */
    const screenInput = (): string | null => {
      if (!inputAt || fullScreen()) return null;
      const buf = term.buffer.active;
      const row = buf.baseY + buf.cursorY;
      if (row < inputAt.row || (row === inputAt.row && buf.cursorX < inputAt.col)) return null;
      let text = '';
      for (let r = inputAt.row; r <= row; r++) {
        const l = buf.getLine(r);
        // 中间有真正的换行（多行命令、远端输出了内容）：对不上
        if (!l || (r > inputAt.row && !l.isWrapped)) return null;
        text += l.translateToString(false, r === inputAt.row ? inputAt.col : 0, r === row ? buf.cursorX : term.cols);
      }
      if (buf.getLine(row)?.translateToString(true, buf.cursorX).trim() || buf.getLine(row + 1)?.isWrapped) return null;
      return text;
    };
    /** 当前输入行：按键跟踪可靠时用跟踪结果，否则从屏幕上读 */
    const currentInput = (): string | null => (line.reliable ? line.text : screenInput());
    const sendRaw = (data: string): void => {
      const id = sessionRef.current;
      if (!id) return;
      const b = useTabs.getState().broadcast;
      if (b.on && b.targets.includes(tab.id)) {
        // 广播输入：同时写到广播组里所有已连接的会话
        for (const t of useTabs.getState().tabs) {
          if (b.targets.includes(t.id) && t.sessionId && t.status === 'ready') void invoke('session.write', { sessionId: t.sessionId, data });
        }
        return;
      }
      void invoke('session.write', { sessionId: id, data });
    };

    // # 问 AI：本地显示问题，回车后转给 AI 面板，不发送到远端
    const startHash = (): void => {
      hash.on = true;
      hash.buf = '';
      term.write('\x1b[36m# ');
    };
    const endHash = (): void => {
      hash.on = false;
      term.write('\x1b[0m');
    };
    const handleHash = (data: string): void => {
      for (const ch of data.replace(PASTE_MARKS, '')) {
        if (ch === '\r') {
          const q = hash.buf.trim();
          endHash();
          term.write('\r\n');
          if (q) {
            const agent = useAgent.getState();
            agent.ask(q, agent.mode);
          }
          // 让远端重新输出提示符（发送一个空行，不会执行任何命令）
          const id = sessionRef.current;
          if (id) void invoke('session.write', { sessionId: id, data: '\r' });
          return;
        }
        if (ch === '\x7f' || ch === '\b') {
          if (!hash.buf) {
            term.write('\b \b\b \b');
            endHash();
            return;
          }
          const chars = [...hash.buf];
          const last = chars.pop()!;
          hash.buf = chars.join('');
          term.write(erase(last));
        } else if (ch === '\x03' || ch === '\x1b') {
          term.write(erase(`# ${hash.buf}`));
          endHash();
          return;
        } else if (ch >= ' ') {
          hash.buf += ch;
          term.write(ch);
        }
      }
    };

    // 行内补全
    const showGhost = (suffix: string): void => {
      clearGhost();
      const buf = term.buffer.active;
      const room = term.cols - buf.cursorX;
      const text = suffix.slice(0, Math.max(0, room));
      if (!text) return;
      const marker = term.registerMarker(0);
      if (!marker) return;
      const deco = term.registerDecoration({ marker, x: buf.cursorX, width: [...text].reduce((n, c) => n + (wide(c) ? 2 : 1), 0), layer: 'top' });
      if (!deco) {
        marker.dispose();
        return;
      }
      deco.onRender((el) => {
        el.textContent = text;
        el.classList.add('ghost-text');
        el.style.fontFamily = String(term.options.fontFamily);
        el.style.fontSize = `${term.options.fontSize}px`;
        el.style.lineHeight = el.style.height;
      });
      ghost = { deco, marker, suffix: text, x: buf.cursorX };
    };
    const scheduleCompletion = (): void => {
      if (compTimer) clearTimeout(compTimer);
      if (useApp.getState().settings['ai.inlineCompletion'] === 'off') return;
      compTimer = setTimeout(() => {
        compTimer = null;
        const prefix = currentInput();
        if (prefix === null || prefix.trim().length < 2 || hash.on || fullScreen() || broadcasting() || !sessionRef.current) return;
        const seq = ++compSeq;
        void invoke('completion.suggest', { hostId: tab.hostId ?? null, sessionId: sessionRef.current, prefix })
          .then((r) => {
            if (seq !== compSeq || currentInput() !== prefix || !r.suggestion?.startsWith(prefix) || sugRef.current) return;
            showGhost(r.suggestion.slice(prefix.length));
          })
          .catch(() => undefined);
      }, 150);
    };

    // 命令提示：输入停顿 1 秒后列出内置命令库（带中文说明）、快捷命令和这台主机的历史命令（不请求 AI）。
    // 不立刻弹出：很多人输入 ls 之后紧接着就按回车，提示框弹得太快，回车会被拿去补全
    let sugTimer: ReturnType<typeof setTimeout> | null = null;
    let sugSeq = 0;
    // 刚用回车补全了一条：这次补全写入的内容不再触发提示，下一次回车直接执行
    let sugMute = false;
    // 按键跟踪不可靠时提示靠读屏幕，远端回显晚到时要再匹配一次：输入后这段时间内有输出就重新匹配
    let sugEchoUntil = 0;
    // 提示框里的列表是按更早的输入过滤出来的（继续输入时先就地缩小），停顿后要重新匹配
    let sugStale = false;
    const showSug = (v: SuggestState | null): void => {
      sugRef.current = v;
      setSug(v);
    };
    const closeSug = (): void => {
      if (sugTimer) clearTimeout(sugTimer);
      sugTimer = null;
      sugSeq++;
      if (sugRef.current) showSug(null);
    };
    const scheduleSuggest = (): void => {
      const cfg = useApp.getState().settings['terminal.suggest'];
      if (!cfg.enabled || (tab.kind === 'serial' && !cfg.serial)) return;
      if (sugTimer) clearTimeout(sugTimer);
      sugTimer = setTimeout(() => {
        sugTimer = null;
        const prefix = currentInput();
        if (prefix === null || prefix.trim().length < cfg.minChars || hash.on || fullScreen() || broadcasting() || !sessionRef.current) return closeSug();
        // 提示框已经是这个输入的结果：不重新匹配（保留 ↑↓ 选中的位置）
        if (sugRef.current?.prefix === prefix && !sugStale) return;
        const seq = ++sugSeq;
        const remote = cfg.history || cfg.snippets ? invoke('completion.matches', { hostId: tab.hostId ?? null, prefix, limit: SUGGEST_TOTAL }).catch(() => ({ history: [], snippets: [] })) : Promise.resolve({ history: [], snippets: [] });
        void remote.then((m) => {
          if (seq !== sugSeq || currentInput() !== prefix) return;
          // 系统推荐（命令库带说明、快捷命令）在前，历史命令在后；一页显示 cfg.maxItems 条，超出的滚动查看
          const items: SuggestItem[] = mergeSuggestions(prefix, {
            library: cfg.library ? matchLibrary(prefix, SUGGEST_TOTAL) : [],
            snippets: cfg.snippets ? m.snippets : [],
            history: cfg.history ? m.history : [],
          });
          if (!items.length) return closeSug();
          // 提示框跟着光标：光标在下半屏时显示在这一行上方
          const screen = container.querySelector('.xterm-screen')?.getBoundingClientRect();
          // 提示框放在 terminal-wrap 里（终端上方可能有横幅、串口工具条），按它计算位置
          const wrap = (container.parentElement ?? container).getBoundingClientRect();
          if (!screen) return;
          const cw = screen.width / term.cols;
          const ch = screen.height / term.rows;
          const buf = term.buffer.active;
          const startX = Math.max(0, buf.cursorX - [...prefix].reduce((n, c) => n + (wide(c) ? 2 : 1), 0));
          const left = Math.max(4, Math.min(screen.left - wrap.left + startX * cw, wrap.width - 460));
          const rowTop = screen.top - wrap.top + buf.cursorY * ch;
          const above = buf.cursorY > term.rows / 2;
          sugStale = false;
          showSug({ items, rows: cfg.maxItems, active: 0, left, top: above ? undefined : rowTop + ch + 2, bottom: above ? wrap.height - rowTop + 2 : undefined, prefix, cursorY: buf.cursorY });
          // 有提示框时不再显示灰色的行内补全，避免两个提示重复
          clearGhost();
        });
      }, SUGGEST_DELAY_MS);
    };
    // 提示框开着时继续输入：马上用新的输入缩小列表（避免回车补全成过时的命令），停顿后再完整匹配
    const narrowSug = (): void => {
      const cur = sugRef.current;
      if (!cur) return;
      // 读屏幕的输入行要等回显，先关掉
      const prefix = line.reliable ? line.text : null;
      const items = prefix === null ? [] : cur.items.filter((it) => it.command.startsWith(prefix) && it.command !== prefix);
      if (!items.length) return closeSug();
      const was = cur.items[cur.active]?.command;
      sugStale = true;
      showSug({ ...cur, items, prefix: prefix!, active: Math.max(0, items.findIndex((it) => it.command === was)) });
    };
    acceptRef.current = (item: SuggestItem): void => {
      const prefix = currentInput();
      closeSug();
      sugEchoUntil = 0;
      if (prefix !== null && item.command.startsWith(prefix) && item.command.length > prefix.length) {
        sugMute = true;
        term.input(item.command.slice(prefix.length));
      }
      term.focus();
    };
    const suggestKeys = (e: KeyboardEvent): boolean | null => {
      const cur = sugRef.current;
      if (!cur || e.type !== 'keydown') return null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = cur.items.length;
        showSug({ ...cur, active: (cur.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
        return false;
      }
      // 回车补全选中的命令（不执行，再按一次回车执行）；Tab 留给 shell 自己的补全
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
        e.preventDefault();
        acceptRef.current(cur.items[cur.active]);
        return false;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSug();
        sugEchoUntil = 0;
        return false;
      }
      if (e.key === 'Tab') {
        closeSug();
        return true;
      }
      return null;
    };

    // 快捷键可以在设置里改。默认：Windows / Linux 的 Ctrl+C 留给远端（中断），复制粘贴用 Ctrl+Shift+C / V；macOS 由 ⌘C / ⌘V 菜单处理
    term.attachCustomKeyEventHandler((e) => {
      const handled = suggestKeys(e);
      if (handled !== null) return handled;
      // 搜索：macOS ⌘F，其他系统 Ctrl+Shift+F（Ctrl+F 留给 shell）
      if (e.type === 'keydown' && matchShortcut(e, 'termSearch')) {
        e.preventDefault();
        setSearching(true);
        return false;
      }
      // 灰色行内补全只用 → 接受；Tab 留给 shell 自己的补全（容易误按）
      if (e.type === 'keydown' && ghost && e.key === 'ArrowRight' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const s2 = ghost.suffix;
        clearGhost();
        term.input(s2);
        return false;
      }
      if (e.type !== 'keydown') return true;
      // 复制 / 粘贴快捷键要 preventDefault：Windows / Linux 上 Chromium 会把 Ctrl+Shift+V 当成「粘贴为纯文本」再粘贴一次
      // （xterm 收到原生的 paste 事件又粘一次，表现为粘贴两次）；Ctrl+Shift+C 同理
      if (matchShortcut(e, 'termCopy')) {
        e.preventDefault();
        const text = term.getSelection();
        if (text) void navigator.clipboard.writeText(text);
        return false;
      }
      if (matchShortcut(e, 'termPaste')) {
        e.preventDefault();
        pasteFromClipboard();
        return false;
      }
      return true;
    });

    const dataSub = term.onData((data) => {
      if (!sessionRef.current) {
        // 会话已结束（参考 MobaXterm）：R 重新连接，S 把终端输出保存到文件
        if (endedRef.current && (data === 'r' || data === 'R')) {
          endedRef.current = false;
          term.write(`\r\n\x1b[90m[${tab.kind === 'local' ? '重新打开' : '重新连接'}…]\x1b[0m\r\n`);
          void connectRef.current();
        } else if (endedRef.current && (data === 's' || data === 'S')) void saveOutputRef.current();
        return;
      }
      clearGhost();
      if (hash.on) {
        handleHash(data);
        return;
      }
      if (
        data === '#' &&
        useApp.getState().settings['ai.hashAsk'] &&
        aiAllowedNow() &&
        line.reliable &&
        line.text === '' &&
        !fullScreen() &&
        !broadcasting() &&
        tab.kind !== 'serial'
      ) {
        startHash();
        return;
      }
      if (!fullScreen()) {
        // 一行的第一个按键：记下输入开始的位置
        if (line.reliable && line.text === '') {
          const b = term.buffer.active;
          inputAt = { row: b.baseY + b.cursorY, col: b.cursorX };
        }
        track(data);
      }
      sendRaw(data);
      if (!fullScreen()) {
        scheduleCompletion();
        // 回车、Ctrl+C 等控制字符：关掉提示；普通输入：重新匹配
        // 回车、Ctrl+C 等控制字符：关掉提示；Tab 交给 shell 补全，也先不提示；普通输入（含退格、删词）：重新匹配
        sugEchoUntil = 0;
        if (/[\r\x03\x04\x15\x1b\t]/.test(data)) closeSug();
        else if (sugMute) sugMute = false;
        else {
          sugEchoUntil = Date.now() + SUGGEST_DELAY_MS + 1000;
          narrowSug();
          scheduleSuggest();
        }
      }
    });
    const outSub = term.onWriteParsed(() => {
      // 远端有新的输出时补全提示的位置可能已经不对，先撤掉
      if (ghost && term.buffer.active.cursorX !== ghost.x) clearGhost();
      // 光标换了行（命令执行了、远端输出了内容）：提示框不再对得上
      if (sugRef.current && term.buffer.active.cursorY !== sugRef.current.cursorY) closeSug();
      // 读屏幕的输入行：回显到了再匹配一次
      else if (!line.reliable && Date.now() < sugEchoUntil && !fullScreen()) scheduleSuggest();
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      const id = sessionRef.current;
      if (id) void invoke('session.resize', { sessionId: id, cols, rows });
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit();
      });
    });
    observer.observe(container);

    // ---------------------------------------------------------------- 鼠标复制粘贴（参考 MobaXterm）
    const mouse = (): { copyOnSelect: boolean; middlePaste: boolean; rightPaste: boolean } => useApp.getState().settings['terminal.mouse'];
    // 选中即复制：拖动选择时选区一直在变，停一下再写剪贴板
    let copyTimer: ReturnType<typeof setTimeout> | null = null;
    const selSub = term.onSelectionChange(() => {
      if (!mouse().copyOnSelect) return;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        const t = term.getSelection();
        if (t) void navigator.clipboard.writeText(t).catch(() => undefined);
      }, 150);
    });
    /** 全屏程序开启了鼠标模式（vim mouse=a、htop 等）：中键 / 右键交给程序，按住 Shift 时仍然由终端处理 */
    const appMouse = (e: MouseEvent): boolean => term.modes.mouseTrackingMode !== 'none' && !e.shiftKey;
    const rightPaste = (): void => {
      pasteFromClipboard();
      if (!localStorage.getItem(RIGHT_PASTE_TIP)) {
        localStorage.setItem(RIGHT_PASTE_TIP, '1');
        message.info({ content: `右键单击是粘贴（MobaXterm 风格）；长按右键或 ${isMac ? 'Ctrl / ⌘' : 'Ctrl'} + 右键打开右键菜单。可以在 设置 → 终端 里修改`, duration: 6 });
      }
    };
    // 右键：mousedown 开始计时，短按松开时粘贴，长按到时间打开菜单；Ctrl / ⌘ + 右键、关闭右键粘贴时由 contextmenu 打开菜单。
    // （Windows 的 contextmenu 在松开之后，macOS 在按下时，两种顺序都按这个流程走）
    let right: { at: number; ctrl: boolean; done: boolean; ctxSeen: boolean; timer: ReturnType<typeof setTimeout> | null } | null = null;
    const onDown = (e: MouseEvent): void => {
      if (e.button === 1 && mouse().middlePaste && !appMouse(e)) e.preventDefault(); // 不要自动滚动 / Linux 的选区粘贴
      if (e.button !== 2) return;
      if (right?.timer) clearTimeout(right.timer);
      const r = { at: Date.now(), ctrl: e.ctrlKey || e.metaKey, done: false, ctxSeen: false, timer: null as ReturnType<typeof setTimeout> | null };
      right = r;
      if (mouse().rightPaste && !r.ctrl) {
        const { clientX: x, clientY: y } = e;
        r.timer = setTimeout(() => {
          r.timer = null;
          r.done = true;
          openMenuRef.current(x, y);
        }, LONG_PRESS_MS);
      }
    };
    const onUp = (e: MouseEvent): void => {
      if (e.button === 1 && mouse().middlePaste && !appMouse(e) && container.contains(e.target as Node)) {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
      const r = right;
      if (e.button !== 2 || !r) return;
      if (r.timer) clearTimeout(r.timer);
      r.timer = null;
      if (r.done) return;
      r.done = true;
      if (mouse().rightPaste && !r.ctrl && !appMouse(e) && container.contains(e.target as Node)) rightPaste();
    };
    const onContext = (e: MouseEvent): void => {
      e.preventDefault();
      const r = right;
      // 右键粘贴的那一次右键自带的 contextmenu：忽略（短按在松开时粘贴，长按在计时结束时打开菜单）
      if (mouse().rightPaste && !(e.ctrlKey || e.metaKey) && r && !r.ctxSeen && !r.ctrl && Date.now() - r.at < 10_000) {
        r.ctxSeen = true;
        return;
      }
      // Ctrl / ⌘ + 右键、关闭了右键粘贴、键盘的菜单键
      if (r?.timer) clearTimeout(r.timer);
      if (r) r.done = true;
      openMenuRef.current(e.clientX, e.clientY);
    };
    const onAux = (e: MouseEvent): void => {
      if (e.button === 1 && mouse().middlePaste && !appMouse(e)) e.preventDefault();
    };
    container.addEventListener('mousedown', onDown, true);
    window.addEventListener('mouseup', onUp, true);
    container.addEventListener('contextmenu', onContext, true);
    container.addEventListener('auxclick', onAux, true);

    void connect();

    const blurSub = term.textarea ? (() => {
      const onBlur = (): void => closeSug();
      term.textarea!.addEventListener('blur', onBlur);
      return () => term.textarea!.removeEventListener('blur', onBlur);
    })() : () => undefined;

    return () => {
      term.textarea?.removeEventListener('paste', onNativePaste, true);
      container.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('mouseup', onUp, true);
      container.removeEventListener('contextmenu', onContext, true);
      container.removeEventListener('auxclick', onAux, true);
      if (right?.timer) clearTimeout(right.timer);
      if (copyTimer) clearTimeout(copyTimer);
      selSub.dispose();
      clearGhost();
      closeSug();
      blurSub();
      observer.disconnect();
      cancelAnimationFrame(frame);
      dataSub.dispose();
      outSub.dispose();
      resizeSub.dispose();
      unsubRef.current?.();
      if (sessionRef.current) void invoke('session.close', { sessionId: sessionRef.current });
      term.dispose();
      termRef.current = null;
      releasePane(tab.id);
    };
    // 只在挂载时创建；主题和字体的变化由下面的 effect 同步
  }, []);

  /** WebGL 渲染（不支持时自动用 DOM 渲染）；切换背景透明时要重新创建 */
  function loadWebgl(term: Terminal): void {
    webglRef.current?.dispose();
    webglRef.current = null;
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl.dispose();
        if (webglRef.current === webgl) webglRef.current = null;
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
    } catch {
      // 不支持 WebGL 时自动使用 DOM 渲染
    }
  }

  // 开关背景：透明需要重建渲染器
  const firstBg = useRef(true);
  useEffect(() => {
    if (firstBg.current) {
      firstBg.current = false;
      return;
    }
    const term = termRef.current;
    if (!term) return;
    term.options.allowTransparency = hasBg;
    loadWebgl(term);
    term.refresh(0, term.rows - 1);
  }, [hasBg]);

  // 标签右键「重新连接」：断开旧会话（如果还在）再连
  const reconnectSeq = useTabs((s) => s.reconnectSeq[tab.id] ?? 0);
  useEffect(() => {
    if (!reconnectSeq) return;
    const old = sessionRef.current;
    if (old) void invoke('session.close', { sessionId: old }).catch(() => undefined);
    termRef.current?.write('\r\n\x1b[90m[重新连接…]\x1b[0m\r\n');
    void connect();
  }, [reconnectSeq]);

  // 输出高亮（每个终端一个，保存转义序列和颜色状态）；设置变化时只换规则
  const highlight = settings['terminal.highlight'];
  useEffect(() => {
    hlRef.current.configure(compileHighlight(highlight));
  }, [highlight]);

  // 缩放：Ctrl / ⌘ + 滚轮（触控板双指捏合也是）调整这个终端的字号，只影响当前终端、不改全局设置
  const [zoom, setZoom] = useState(0);
  const [zoomTip, setZoomTip] = useState(false);
  const baseFont = settings['terminal.fontSize'];
  // 缩放的字号范围（设置 → 外观：最小 / 最大）
  const minFont = Math.min(settings['terminal.fontSizeMin'], baseFont);
  const maxFont = Math.max(settings['terminal.fontSizeMax'], baseFont);
  const fontSize = Math.min(maxFont, Math.max(minFont, baseFont + zoom));
  const zoomBy = (step: number | 'reset'): void => {
    setZoom((z) => (step === 'reset' ? 0 : Math.min(maxFont, Math.max(minFont, baseFont + z + step)) - baseFont));
    setZoomTip(true);
  };
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;
  useEffect(() => {
    if (!zoomTip) return;
    const t = setTimeout(() => setZoomTip(false), 1400);
    return () => clearTimeout(t);
  }, [zoomTip, zoom]);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      // 不让 xterm 滚动、也不让页面缩放
      e.preventDefault();
      e.stopPropagation();
      // 鼠标滚轮一格一个字号；触控板是很多个小的增量，累计到一定量再变。
      // 主线程忙时浏览器会把连续几格合并成一个事件（deltaY 是几格的和），按格数算
      acc += e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      if (Math.abs(acc) < 40) return;
      const steps = Math.min(4, Math.max(1, Math.round(Math.abs(acc) / 100)));
      zoomRef.current(acc < 0 ? steps : -steps);
      acc = 0;
    };
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => el.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // 设置变化：字体、字号、回滚行数、配色
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = settings['terminal.fontFamily'];
    term.options.scrollback = settings['terminal.scrollback'];
    term.options.cursorStyle = settings['terminal.cursorStyle'];
    term.options.cursorBlink = settings['terminal.cursorBlink'];
    term.options.lineHeight = settings['terminal.lineHeight'];
    term.options.letterSpacing = settings['terminal.letterSpacing'];
    term.options.rightClickSelectsWord = isMac && !settings['terminal.mouse'].copyOnSelect && !settings['terminal.mouse'].rightPaste;
    term.options.theme = theme;
    fitRef.current?.fit();
  }, [settings, theme, fontSize]);

  // 切换到这个窗格时聚焦
  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      });
    }
  }, [active]);

  const ended = status.status === 'closed' || status.status === 'error';
  // 右键菜单打开时 Esc 关闭菜单（不发给终端）
  useEffect(() => {
    if (!ctxAt) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setCtxAt(null);
      termRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctxAt]);
  const shSel = (tab.kind === 'ssh' || (tab.kind === 'local' && window.itm.platform !== 'win32')) && isShPath(menuSel) ? menuSel.trim() : null;
  openMenuRef.current = (x: number, y: number): void => {
    setMenuSel(termRef.current?.getSelection() ?? '');
    // 已经打开时先关再在新位置打开（锚点移动后菜单不会自己重新定位）
    if (ctxAt) {
      setCtxAt(null);
      requestAnimationFrame(() => setCtxAt({ x, y }));
    } else setCtxAt({ x, y });
  };
  const split = (dir: 'h' | 'v'): void => {
    useTabs.getState().split(tab.id, dir, { kind: tab.kind, title: tab.title, hostId: tab.hostId });
  };

  return (
    <div className={`terminal-wrap ${hasBg ? 'has-backdrop' : ''}`} data-testid={`terminal-${tab.title}`}>
      {hasBg && <TerminalBackdrop bg={bg} color={baseTheme.background ?? '#000000'} />}
      {overlay && progress && showsProgress && (
        <ConnectProgress
          kind={tab.kind as 'ssh' | 'telnet'}
          title={tab.title}
          progress={progress}
          onCancel={() => {
            if (sessionRef.current) void invoke('session.close', { sessionId: sessionRef.current });
            setOverlay(false);
          }}
          onRetry={() => void connect()}
          onEdit={
            tab.hostId
              ? () => {
                  const host = useHosts.getState().hosts.find((h) => h.id === tab.hostId);
                  if (host) useHosts.getState().openEditor({ mode: 'edit', host });
                }
              : undefined
          }
          onDismiss={() => setOverlay(false)}
        />
      )}
      {ended && !overlay && (
        <Alert
          className="terminal-banner"
          banner
          type={status.status === 'error' ? 'error' : 'info'}
          message={`${status.message ?? '会话已结束'}（在终端里按 R ${again}，按 S 保存终端输出）`}
          action={
            <Space>
              <Button size="small" type="primary" onClick={() => void connect()} data-testid="reconnect">
                {again}
              </Button>
              <Button size="small" onClick={() => useTabs.getState().close(tab.id)}>
                {tab.parentId || useTabs.getState().layouts[tab.id] ? '关闭窗格' : '关闭标签'}
              </Button>
            </Space>
          }
        />
      )}
      {tab.kind === 'serial' && <SerialToolbar sessionId={sessionRef.current} state={serial} />}
      {logPath && (
        <div className="terminal-log-badge" data-testid="log-badge">
          <span className="rec-dot" />
          <Tooltip title={logPath}>
            <span>录制日志中</span>
          </Tooltip>
          <Button size="small" type="link" onClick={() => void toggleLog()}>
            停止
          </Button>
        </div>
      )}
      {searching && termRef.current && searchRef.current && (
        <TermSearch
          term={termRef.current}
          search={searchRef.current}
          onClose={() => {
            setSearching(false);
            termRef.current?.focus();
          }}
        />
      )}
      {sug && <TermSuggest state={sug} onPick={(it) => acceptRef.current(it)} onHover={(i) => sugRef.current && (sugRef.current = { ...sugRef.current, active: i }, setSug(sugRef.current))} />}
      <div
        className="terminal-host"
        ref={containerRef}
        style={{ background: hasBg ? 'transparent' : theme.background }}
        onMouseDown={() => useTabs.getState().focus(tab.id)}
        data-testid={`xterm-${tab.id}`}
      />
      {/* 右键菜单：挂在鼠标位置的锚点上（右键、长按右键或 Ctrl + 右键打开，见上面的鼠标处理） */}
      <Dropdown
        open={!!ctxAt}
        onOpenChange={(open) => !open && setCtxAt(null)}
        trigger={['contextMenu']}
        menu={{
          items: [
            { key: 'copy', label: '复制', extra: isMac ? '⌘C' : 'Ctrl+Shift+C', icon: <CopyOutlined />, disabled: !menuSel },
            { key: 'paste', label: '粘贴', extra: isMac ? '⌘V' : 'Ctrl+Shift+V', icon: <SnippetsOutlined /> },
            { key: 'selectAll', label: '全选', icon: <SelectOutlined /> },
            // 选中的是 .sh 脚本（例如 ls 列出来的文件名）：可以直接执行（第三十三轮）
            ...(shSel ? [{ type: 'divider' as const }, { key: 'execSh', label: `执行脚本 ${shSel.split('/').pop()}…`, icon: <PlayCircleOutlined />, 'data-testid': 'term-exec-sh' }] : []),
            { type: 'divider' },
            { key: 'snippet', label: '选中内容添加到快捷指令…', icon: <ThunderboltOutlined />, disabled: !menuSel.trim() },
            { key: 'quote', label: `${menuSel ? '引用选中内容到 AI 对话框' : '引用当前屏幕到 AI 对话框'}${aiAllowed ? '' : '（登录后可用）'}`, icon: <MessageOutlined />, disabled: !aiAllowed },
            { key: 'explain', label: `让 AI 解释选中内容${aiAllowed ? '' : '（登录后可用）'}`, icon: <RobotOutlined />, disabled: !menuSel || !aiAllowed },
            { key: 'note', label: menuSel ? '选中内容存为笔记' : '当前屏幕存为笔记', icon: <BookOutlined /> },
            { type: 'divider' },
            { key: 'log', label: logPath ? '停止录制日志' : '录制日志到文件…', icon: <FileTextOutlined />, disabled: !sessionRef.current },
            { key: 'saveOutput', label: '保存终端输出到文件…', icon: <SaveOutlined /> },
            { type: 'divider' },
            { key: 'split-h', label: '向右分屏', icon: <BorderHorizontalOutlined /> },
            { key: 'split-v', label: '向下分屏', icon: <BorderVerticleOutlined /> },
            { type: 'divider' },
            { key: 'search', label: '搜索…', extra: isMac ? '⌘F' : 'Ctrl+Shift+F', icon: <SearchOutlined /> },
            { key: 'highlight', label: '高亮设置…', icon: <HighlightOutlined /> },
            { key: 'colors', label: '终端配色…', icon: <BgColorsOutlined /> },
            {
              key: 'zoom',
              label: `字号 ${fontSize}${zoom ? `（默认 ${baseFont}）` : ''}`,
              icon: <FontSizeOutlined />,
              children: [
                { key: 'zoom-in', label: '放大', extra: isMac ? '⌘ + 滚轮' : 'Ctrl + 滚轮' },
                { key: 'zoom-out', label: '缩小' },
                { key: 'zoom-reset', label: '还原默认字号', disabled: !zoom },
              ],
            },
            { key: 'clear', label: '清屏（只清本机显示）', icon: <ClearOutlined /> },
          ],
          onClick: ({ key }) => {
            setCtxAt(null);
            const term = termRef.current;
            const sel = menuSel;
            if (key === 'copy' && sel) void navigator.clipboard.writeText(sel);
            if (key === 'paste') pasteRef.current();
            if (key === 'selectAll') term?.selectAll();
            if (key === 'execSh' && shSel) {
              const cur = useTabs.getState().tabs.find((t) => t.id === tab.id);
              useShExec.getState().show({ hostId: tab.hostId ?? null, path: shSel, cwd: cur?.cwd ?? null, tabId: tab.id });
              return;
            }
            if (key === 'highlight') useHighlightDialog.getState().show();
            if (key === 'colors') useColorsDialog.getState().show();
            if (key === 'search') setSearching(true);
            if (key === 'snippet' && sel.trim()) {
              // 选中的是提示符后面的命令时去掉提示符（$ / # / > 结尾的前缀）
              useAddSnippet.getState().show({ content: stripPrompt(sel.trim()), context: term ? screenText(term).slice(-3000) : undefined });
              return;
            }
            if (key === 'quote' && term) {
              const text = (sel || screenText(term)).slice(0, 8000);
              if (text.trim()) useAgent.getState().quote(text);
              return;
            }
            if (key === 'note' && term) {
              const text = (sel || screenText(term)).slice(0, 100_000);
              if (text.trim()) {
                const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
                useLibrary
                  .getState()
                  .saveAsNote(`${tab.title} · ${stamp}`, `\`\`\`\n${text}\n\`\`\``)
                  .then((n) =>
                    message.success({
                      key: 'note-saved',
                      content: (
                        <span>
                          已存为笔记
                          <Button type="link" size="small" onClick={() => useLibrary.getState().openNote(n.id)}>
                            查看
                          </Button>
                        </span>
                      ),
                    }),
                  )
                  .catch((e) => message.error(errorMessage(e)));
              }
            }
            if (key === 'explain' && sel) {
              useAgent.getState().ask(`解释下面这段终端内容：含义是什么、有没有异常、可能的原因和建议。\n\`\`\`\n${sel.slice(0, 8000)}\n\`\`\``, 'ask');
            }
            if (key === 'split-h') split('h');
            if (key === 'split-v') split('v');
            if (key === 'clear') term?.clear();
            if (key === 'zoom-in') zoomBy(1);
            if (key === 'zoom-out') zoomBy(-1);
            if (key === 'zoom-reset') zoomBy('reset');
            if (key === 'log') void toggleLog();
            if (key === 'saveOutput') return void saveOutput();
            term?.focus();
          },
        }}
      >
        <div className="ctx-anchor" style={{ left: ctxAt?.x ?? -10, top: ctxAt?.y ?? -10 }} />
      </Dropdown>
      {zoomTip && (
        <div className="term-zoom-tip" data-testid="term-zoom-tip">
          字号 {fontSize}
          {zoom !== 0 && <span>（默认 {baseFont}，右键可以还原）</span>}
        </div>
      )}
    </div>
  );
}
