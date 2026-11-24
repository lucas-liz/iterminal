import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Alert, App, Button, Dropdown, Empty, Input, Modal, Radio, Space, Spin, Tag, Tooltip, type MenuProps } from 'antd';
import {
  AimOutlined,
  ArrowUpOutlined,
  CloudUploadOutlined,
  CodeOutlined,
  CopyOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileAddOutlined,
  FileZipOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FormOutlined,
  HomeOutlined,
  LinkOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyOutlined,
  ScissorOutlined,
  SearchOutlined,
  SnippetsOutlined,
  StarFilled,
  StarOutlined,
  UploadOutlined,
  CaretUpOutlined,
  CaretDownOutlined,
  CheckOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import type { ConflictPolicy, FileEntry } from '@itm/protocol';
import { useEdits } from '../store/edits';
import { errorMessage, invoke } from '../api';
import type { Tab } from '../store/tabs';
import { useApp } from '../store/app';
import { useTransfers } from '../store/transfers';
import { formatSize, formatTime, joinRemote, parentRemote } from '../util/format';
import { COLS, formatKb, useFilePrefs, type ColDef, type ColKey } from '../store/file-prefs';
import { useAgent } from '../store/agent';
import { useAiAllowed } from '../util/ai-access';
import { FileIcon, opensInEditor } from '../util/file-icon';
import { TransferBar } from './files/TransferBar';
import { UploadConflictDialog, type ConflictRow } from './files/UploadConflictDialog';
import { ChmodDialog, modeOfPerms } from './files/ChmodDialog';
import { PathBar } from './files/PathBar';
import { useShExec } from './files/ShExecDialog';
import { runInTab } from '../util/run-in-terminal';
import { shArg } from '../util/sh-exec';
import { FILES_MIME } from '../pages/workspace/FilePane';

const isWin = window.itm.platform === 'win32';
const isMac = window.itm.platform === 'darwin';
const localJoin = (dir: string, name: string): string => (isWin ? `${dir.replace(/\\+$/, '')}\\${name}` : joinRemote(dir, name));
const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** 下载目录里已有同名文件时，改名为「名称 (1).扩展名」，不覆盖用户的文件 */
function uniqueName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const m = /^(.+?)(\.tar\.(?:gz|bz2|xz|zst)|\.[^.]+)$/i.exec(name);
  const base = m ? m[1] : name;
  const ext = m ? m[2] : '';
  for (let i = 1; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** 文件栏前面的协议标记（SFTP 时不显示） */
export const PROTOCOL_LABEL = { sftp: 'SFTP', shell: 'SSH', ftp: 'FTP', ftps: 'FTPS' } as const;
const PROTOCOL_TIP = {
  sftp: '',
  shell: '服务器没有 SFTP，通过 SSH 命令通道（stat / cat）传输文件',
  ftp: '通过 FTP 访问文件（明文传输）',
  ftps: '通过 FTPS（加密）访问文件',
} as const;

/** 列表时间：今天只显示时分，其他显示月 / 日 时:分，不是今年的显示年 */
function shortTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** 选择器里不能每次返回新的空数组（zustand 会认为状态变了，无限重渲染） */
const NONE: string[] = [];

/** 文件面板里的「复制 / 剪切」（远端文件，同一台主机里粘贴；第十六轮） */
interface FileClip {
  mode: 'copy' | 'cut';
  hostId: string;
  paths: string[];
}
const useFileClip = create<{ clip: FileClip | null; set(c: FileClip | null): void }>((set) => ({ clip: null, set: (clip) => set({ clip }) }));

/** 和断开有关的错误：提示重新连接 */
const DISCONNECTED = /连接已断开|会话已关闭|请重新打开|Not connected|No response from server|ECONNRESET|channel|socket|closed/i;

/**
 * 右侧文件面板（第十六轮按 iShell / MobaXterm 重做）：当前终端所在主机的远端文件，默认跟随终端目录。
 * - 第一行是功能按钮：新建文件夹 / 文件、显示隐藏文件、与终端目录同步、刷新、上传文件 / 文件夹、下载选中、删除选中、收藏的目录；
 * - 第二行是完整路径（面包屑，点击可以直接输入）；表头可以点击按名称 / 大小 / 时间升降序排列；文件按类型显示图标；
 * - 单击选中，⌘ / Ctrl 单击加选，Shift 单击选一段，按住拖过几行，⌘ / Ctrl + A 全选；双击目录进入、双击文件打开；
 * - 右键文件 / 空白处的菜单、从访达拖进来上传、拖到访达下载、底部传输条和传输列表；
 * - 终端断开重连后自动重新打开，操作时发现连接断开会提示重新连接。
 */
export function FilePanel({
  tab,
  variant = 'side',
  onReady,
  onListing,
  onDownload,
}: {
  tab: Tab;
  /**
   * side：终端右侧的文件面板；sftp：SFTP 标签页的远端窗格（第二十六轮起和右侧面板共用同一个列表，功能一致）——
   * 没有「与终端目录同步」，下载默认放到左边的本地目录，可以和本地窗格互相拖动
   */
  variant?: 'side' | 'sftp';
  onReady?(info: { sftpId: string; protocol: 'sftp' | 'shell' | 'ftp' | 'ftps' } | { error: string }): void;
  /** 列出目录后：当前路径和内容（SFTP 标签页上传前检查同名用） */
  onListing?(path: string, entries: FileEntry[]): void;
  /** SFTP 标签页：「下载」交给外层（下载到左边的本地目录，同名时询问） */
  onDownload?(entries: FileEntry[]): void;
}): React.JSX.Element {
  const sftpTab = variant === 'sftp';
  const { message, modal } = App.useApp();
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [home, setHome] = useState('/');
  const [protocol, setProtocol] = useState<'sftp' | 'shell' | 'ftp' | 'ftps'>('sftp');
  const [notice, setNotice] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /** 连接断开了（终端断开，或者操作时发现）：显示「重新连接」 */
  const [lost, setLost] = useState<string | null>(null);
  const [follow, setFollow] = useState(variant === 'side');
  const [selected, setSelected] = useState<string[]>([]);
  const anchorRef = useRef<string | null>(null);
  const dragRef = useRef<string | null>(null);
  /** 按下时这一行已经选中：拖动就是拖到本机（没选中的行拖动是框选） */
  const armedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState('');
  const [dropOver, setDropOver] = useState<string | null>(null);
  const [nameDialog, setNameDialog] = useState<{ kind: 'rename' | 'mkdir' | 'touch' | 'archive'; entry?: FileEntry; name: string; format?: 'tar.gz' | 'zip' } | null>(null);
  const [destDialog, setDestDialog] = useState<{ mode: 'copy' | 'move'; entries: FileEntry[]; dest: string } | null>(null);
  const [chmodOf, setChmodOf] = useState<FileEntry[] | null>(null);
  const [conflict, setConflict] = useState<{ rows: ConflictRow[]; resolve(c: Record<string, ConflictPolicy> | null): void } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'files' | 'blank' } | null>(null);
  // 排序、列宽、显示哪些列、最近目录：所有文件面板共用，保存在本机（store/file-prefs.ts）
  const sort = useFilePrefs((s) => s.sort);
  const colPrefs = useFilePrefs((s) => s.cols);
  const history = useFilePrefs((s) => s.history[tab.hostId ?? ''] ?? NONE);
  /** 刚拖完列宽：松开鼠标时的 click 不算点击表头排序 */
  const justResized = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const sftpRef = useRef<string | null>(null);
  /** 重新连接时回到原来的目录 */
  const lastPath = useRef<string | null>(null);
  const transfers = useTransfers((s) => s.items);
  const showHidden = useApp((s) => s.settings['sftp.showHidden']);
  const favorites = useApp((s) => s.settings['sftp.favorites']?.[tab.hostId ?? ''] ?? NONE);
  const clip = useFileClip((s) => s.clip);
  const aiOk = useAiAllowed();
  /** 上传完成后刷新列表（下载不改变远端目录，不用刷新） */
  const doneCount = useMemo(() => transfers.filter((t) => t.sftpId === sftpId && t.direction === 'upload' && t.status === 'done').length, [transfers, sftpId]);

  const fail = useCallback(
    (e: unknown): void => {
      const msg = errorMessage(e);
      if (DISCONNECTED.test(msg)) setLost(msg);
      else message.error(msg);
    },
    [message],
  );

  const list = useCallback(
    async (p: string, id = sftpRef.current) => {
      if (!id) return;
      setLoading(true);
      try {
        const rows = await invoke('sftp.list', { sftpId: id, path: p });
        setEntries(rows);
        setPath(p);
        onListing?.(p, rows);
        if (p !== lastPath.current) {
          setSelected([]);
          anchorRef.current = null;
        } else {
          // 刷新同一个目录：保留还在的选中项
          const still = new Set(rows.map((r) => r.path));
          setSelected((s) => s.filter((x) => still.has(x)));
        }
        lastPath.current = p;
        if (tab.hostId) useFilePrefs.getState().remember(tab.hostId, p);
        setLost(null);
      } catch (e) {
        fail(e);
      } finally {
        setLoading(false);
      }
    },
    [fail],
  );

  // 打开这台主机的文件会话（复用终端的 SSH 连接）；重新连接时回到原来的目录
  useEffect(() => {
    let alive = true;
    setOpenError(null);
    void (async () => {
      try {
        const res = await invoke('sftp.open', { hostId: tab.hostId! });
        if (!alive) {
          void invoke('sftp.close', { sftpId: res.sftpId });
          return;
        }
        sftpRef.current = res.sftpId;
        setSftpId(res.sftpId);
        setHome(res.home);
        setProtocol(res.protocol);
        setNotice(res.notice ?? null);
        setLost(null);
        if (res.notice && attempt === 0) message.info({ content: res.notice, duration: 6 });
        onReady?.({ sftpId: res.sftpId, protocol: res.protocol });
        await list(lastPath.current ?? tab.cwd ?? res.home, res.sftpId);
      } catch (e) {
        if (alive) {
          setOpenError(errorMessage(e));
          onReady?.({ error: errorMessage(e) });
        }
      }
    })();
    return () => {
      alive = false;
      if (sftpRef.current) void invoke('sftp.close', { sftpId: sftpRef.current });
      sftpRef.current = null;
    };
  }, [tab.hostId, attempt]);

  // 跟随终端：终端断开时提示，重新连上（会话 ID 变了）时自动重新打开文件会话
  const seenSession = useRef(tab.sessionId);
  useEffect(() => {
    if (!sftpTab && (tab.status === 'closed' || tab.status === 'error')) setLost('终端已断开，重新连接后文件会自动恢复');
  }, [tab.status]);
  useEffect(() => {
    if (sftpTab || tab.status !== 'ready' || !tab.sessionId) return;
    if (seenSession.current && seenSession.current !== tab.sessionId) setAttempt((n) => n + 1);
    seenSession.current = tab.sessionId;
  }, [tab.sessionId, tab.status]);

  useEffect(() => {
    if (doneCount > 0 && path) void list(path);
  }, [doneCount]);

  useEffect(() => {
    if (follow && tab.cwd && sftpId && tab.cwd !== path) void list(tab.cwd);
  }, [tab.cwd, follow, sftpId]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const rows = entries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
    const dir = sort.desc ? -1 : 1;
    const byName = (a: FileEntry, b: FileEntry): number => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    const text = (x?: string, y?: string): number => (x ?? '').localeCompare(y ?? '', 'zh-CN', { numeric: true });
    return rows.sort((a, b) => {
      // 目录始终在前面
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
      const r =
        sort.key === 'size'
          ? a.size - b.size
          : sort.key === 'mtime'
            ? a.mtime - b.mtime
            : sort.key === 'owner'
              ? text(a.owner, b.owner)
              : sort.key === 'group'
                ? text(a.group, b.group)
                : sort.key === 'perms'
                  ? text(a.perms, b.perms)
                  : byName(a, b);
      return (r || byName(a, b)) * dir;
    });
  }, [entries, filter, showHidden, sort]);
  const picked = useMemo(() => visible.filter((e) => selected.includes(e.path)), [visible, selected]);
  const toggleSort = (key: ColKey): void => {
    if (justResized.current) return;
    // 大小、时间第一次点是从大到小 / 从新到旧
    useFilePrefs.getState().setSort({ key, desc: sort.key === key ? !sort.desc : key === 'size' || key === 'mtime' });
  };

  // ---------------------------------------------------------------- 列（MobaXterm 风格：可以拖动调整列宽，右键表头选择显示哪些列）
  const cols = useMemo(() => COLS.filter((c) => !colPrefs.hidden.includes(c.key)), [colPrefs.hidden]);
  /** 列表不左右滚动：名称列填满剩余空间；面板窄时各列按比例收窄（不小于最小宽度），再窄时右边的列被遮住 */
  const cellStyle = (c: ColDef): React.CSSProperties => {
    const w = colPrefs.widths[c.key] ?? c.width;
    return c.key === 'name' ? { flex: `1 1 ${w}px`, minWidth: c.min } : { flex: `0 1 ${w}px`, minWidth: c.min };
  };
  const startResize = (ev: React.MouseEvent, c: ColDef): void => {
    ev.preventDefault();
    ev.stopPropagation();
    const startW = (ev.currentTarget as HTMLElement).parentElement?.getBoundingClientRect().width ?? c.width;
    const startX = ev.clientX;
    document.body.classList.add('fp-resizing');
    const move = (e: MouseEvent): void => useFilePrefs.getState().setWidth(c.key, Math.max(c.min, Math.round(startW + e.clientX - startX)));
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('fp-resizing');
      justResized.current = true;
      setTimeout(() => (justResized.current = false), 0);
      useFilePrefs.getState().persistCols();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const cellOf = (c: ColDef, e: FileEntry): React.ReactNode => {
    const style = cellStyle(c);
    switch (c.key) {
      case 'name':
        return (
          <span key="name" className="fp-cell fp-cell-name" style={style}>
            <FileIcon entry={e} />
            <span className="file-row-name" title={e.type === 'link' ? `${e.name}（链接）` : e.name}>
              {e.name}
            </span>
          </span>
        );
      case 'size':
        return (
          <span key="size" className="fp-cell right file-row-meta" style={style} title={e.type === 'dir' ? undefined : `${formatSize(e.size)}（${e.size.toLocaleString('en-US')} 字节）`}>
            {e.type === 'dir' ? '' : formatKb(e.size)}
          </span>
        );
      case 'mtime':
        return (
          <span key="mtime" className="fp-cell file-row-meta" style={style} title={formatTime(e.mtime)}>
            {shortTime(e.mtime)}
          </span>
        );
      case 'perms':
        return (
          <span key="perms" className="fp-cell file-row-meta mono" style={style} title={e.perms ? `0${modeOfPerms(e.perms).toString(8).padStart(3, '0')}` : undefined}>
            {e.perms}
          </span>
        );
      default:
        return (
          <span key={c.key} className="fp-cell file-row-meta" style={style} title={e[c.key]}>
            {e[c.key] ?? ''}
          </span>
        );
    }
  };

  // ---------------------------------------------------------------- 选择
  useEffect(() => {
    const up = (): void => {
      dragRef.current = null;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  const rangeOf = (from: string, to: string): string[] => {
    const ids = visible.map((x) => x.path);
    const a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0 || b < 0) return [to];
    return ids.slice(Math.min(a, b), Math.max(a, b) + 1);
  };
  const onRowMouseDown = (ev: React.MouseEvent, e: FileEntry): void => {
    // 让列表拿到键盘焦点（⌘ / Ctrl + A、删除、复制粘贴）
    listRef.current?.focus({ preventScroll: true });
    armedRef.current = false;
    // 只有按下时已经选中的行才可以拖到本机；没选中的行不可拖，按住移动就是框选
    (ev.currentTarget as HTMLElement).draggable = ev.button === 0 && !(ev.metaKey || ev.ctrlKey || ev.shiftKey) && selected.includes(e.path);
    if (ev.button === 2) {
      if (!selected.includes(e.path)) {
        setSelected([e.path]);
        anchorRef.current = e.path;
      }
      return;
    }
    if (ev.button !== 0) return;
    if (ev.metaKey || ev.ctrlKey) {
      setSelected((s) => (s.includes(e.path) ? s.filter((x) => x !== e.path) : [...s, e.path]));
      anchorRef.current = e.path;
      return;
    }
    if (ev.shiftKey && anchorRef.current) {
      ev.preventDefault();
      setSelected(rangeOf(anchorRef.current, e.path));
      return;
    }
    if (selected.includes(e.path)) {
      // 已经选中：可能是要拖到本机，松开时再变成只选这一行
      armedRef.current = true;
      anchorRef.current = e.path;
      return;
    }
    anchorRef.current = e.path;
    dragRef.current = e.path;
    setSelected([e.path]);
  };
  const onRowMouseUp = (ev: React.MouseEvent, e: FileEntry): void => {
    if (armedRef.current && ev.button === 0 && !(ev.metaKey || ev.ctrlKey || ev.shiftKey)) setSelected([e.path]);
    armedRef.current = false;
  };
  const onRowMouseEnter = (ev: React.MouseEvent, e: FileEntry): void => {
    if (dragRef.current && ev.buttons & 1) setSelected(rangeOf(dragRef.current, e.path));
  };

  // ---------------------------------------------------------------- 上传 / 下载
  /**
   * 上传到 dir（默认当前目录）：有同名时先让用户逐个选择处理方式。
   * 同名判断每次都重新列一遍远端目录（第三十一轮）：列表不会自动刷新，在终端里删掉 / 新建的文件不能按旧列表算
   */
  const upload = async (localPaths: string[], dir = path): Promise<void> => {
    if (!sftpId || !dir || localPaths.length === 0) return;
    let existing: FileEntry[];
    try {
      existing = await invoke('sftp.list', { sftpId, path: dir });
    } catch (e) {
      return fail(e);
    }
    // 顺便把当前目录的列表更新成最新的
    if (dir === path) {
      setEntries(existing);
      onListing?.(dir, existing);
    }
    const byName = new Map(existing.map((e) => [e.name, e]));
    const items = localPaths.map((lp) => ({ localPath: lp, remotePath: joinRemote(dir, baseName(lp)), name: baseName(lp) }));
    const rows: ConflictRow[] = items.filter((i) => byName.has(i.name)).map((i) => ({ ...i, type: byName.get(i.name)!.type === 'dir' ? 'dir' : 'file' }));
    let choices: Record<string, ConflictPolicy> = {};
    if (rows.length) {
      const r = await new Promise<Record<string, ConflictPolicy> | null>((resolve) => setConflict({ rows, resolve }));
      setConflict(null);
      if (!r) return;
      choices = r;
    }
    try {
      await invoke('transfer.start', { sftpId, direction: 'upload', items: items.map(({ localPath, remotePath }) => ({ localPath, remotePath, conflict: choices[localPath] ?? 'overwrite' })) });
    } catch (e) {
      fail(e);
    }
  };

  /**
   * 下载（可以多选）：默认保存到「下载」目录；pick 先选文件夹；compress 先在服务器上打成一个 tar.gz。
   * 下载到「下载」目录、打包下载先二次确认（「下载到…」选择文件夹本身就是确认）；note 是确认框里额外的说明
   */
  const download = async (targets: FileEntry[], mode: 'default' | 'pick' | 'compress' = 'default', note?: string): Promise<void> => {
    if (!sftpId || targets.length === 0) return;
    // SFTP 标签页：下载到左边的本地目录（外层处理同名）
    if (mode === 'default' && onDownload) return onDownload(targets);
    const label = targets.length === 1 ? `「${targets[0].name}」` : `选中的 ${targets.length} 项`;
    if (mode !== 'pick') {
      const dirs = targets.filter((e) => e.type === 'dir').length;
      const ok = await new Promise<boolean>((resolve) =>
        modal.confirm({
          title: mode === 'compress' ? `打包下载${label}？` : `下载${label}？`,
          content: [
            note,
            mode === 'compress' ? '先在服务器上打包成一个 tar.gz，再下载到本机的「下载」目录。' : `保存到本机的「下载」目录${dirs ? `（包含 ${dirs} 个目录，会连同里面的内容一起下载）` : ''}，同名文件自动改名，不会覆盖。`,
          ]
            .filter(Boolean)
            .join(''),
          okText: '下载',
          cancelText: '取消',
          okButtonProps: { 'data-testid': 'fp-download-ok' } as never,
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        }),
      );
      if (!ok) return;
    }
    try {
      const dir = mode === 'pick' ? await invoke('dialog.openDirectory', { title: `选择${label}保存到的本机文件夹` }) : await invoke('local.downloadsDir');
      if (!dir) return;
      let items: { remotePath: string; name: string; cleanupRemote?: boolean }[] = targets.map((e) => ({ remotePath: e.path, name: e.name }));
      if (mode === 'compress') {
        const hide = message.loading({ content: `正在服务器上压缩${label}…`, duration: 0, key: 'compress' });
        try {
          const r = await invoke('sftp.compress', { sftpId, paths: targets.map((e) => e.path) });
          items = [{ remotePath: r.path, name: r.name, cleanupRemote: true }];
        } finally {
          hide();
        }
      }
      const existing = new Set((await invoke('local.list', { path: dir })).map((e) => e.name));
      const planned = items.map((it) => {
        const name = uniqueName(it.name, existing);
        existing.add(name);
        return { localPath: localJoin(dir, name), remotePath: it.remotePath, cleanupRemote: it.cleanupRemote };
      });
      await invoke('transfer.start', { sftpId, direction: 'download', items: planned });
      const first = planned[0].localPath;
      message.info({
        content: (
          <span>
            {`正在下载到${mode === 'pick' ? `「${dir}」` : '「下载」目录'}：${planned.length === 1 ? baseName(first) : `${planned.length} 项`}`}
            <Button type="link" size="small" onClick={() => void invoke('local.reveal', { path: first })}>
              显示
            </Button>
          </span>
        ),
      });
    } catch (e) {
      fail(e);
    }
  };
  /** 在服务器上执行命令的操作（压缩、复制、权限）需要 SSH（FTP 不支持） */
  const canExec = protocol === 'sftp' || protocol === 'shell';

  /** 拖到访达 / 资源管理器：先下载到临时目录再开始系统拖拽；太大时改为下载到「下载」目录 */
  const dragOut = async (targets: FileEntry[]): Promise<void> => {
    if (!sftpId || !targets.length) return;
    const hide = message.loading({ content: '正在准备拖出…（松开鼠标前请保持按住）', duration: 0, key: 'drag-out' });
    try {
      const r = await invoke('sftp.dragOut', { sftpId, paths: targets.map((e) => e.path) });
      hide();
      if (r.tooLarge) await download(targets, 'default', `选中的内容较大（${formatSize(r.total ?? 0)}），不能直接拖出，改为下载。`);
    } catch (e) {
      fail(e);
    } finally {
      hide();
    }
  };

  /** 双击文件：文本类用内置编辑器打开，其他用本机程序打开（下载到临时目录，保存后自动回传） */
  const openFile = (e: FileEntry): void => {
    if (!sftpId) return;
    if (e.type === 'dir' || (e.type === 'link' && e.size === 0)) return void list(e.path);
    if (opensInEditor(e)) useEdits.getState().openEditor(sftpId, e.path);
    else void useEdits.getState().editExternal(sftpId, e.path).catch(fail);
  };

  const remove = (targets: FileEntry[]): void => {
    if (!targets.length || !sftpId) return;
    const one = targets.length === 1 ? targets[0] : null;
    modal.confirm({
      title: one ? `永久删除「${one.name}」？` : `永久删除选中的 ${targets.length} 项？`,
      content: targets.some((e) => e.type === 'dir') ? '目录会连同里面的内容一起删除，无法恢复。' : '删除后无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true, 'data-testid': 'fp-delete-ok' } as never,
      cancelText: '取消',
      onOk: async () => {
        try {
          await invoke('sftp.delete', { sftpId, paths: targets.map((e) => e.path) });
          if (path) await list(path);
        } catch (e) {
          fail(e);
        }
      },
    });
  };

  const paste = async (): Promise<void> => {
    if (!clip || !sftpId || !path) return;
    if (clip.hostId !== tab.hostId) return void message.warning('只能粘贴到同一台主机（不同主机之间请下载后上传）');
    try {
      if (clip.mode === 'copy') {
        const r = await invoke('sftp.copy', { sftpId, paths: clip.paths, destDir: path });
        message.success(`已复制 ${r.copied.length} 项`);
      } else {
        const r = await invoke('sftp.move', { sftpId, paths: clip.paths, destDir: path });
        useFileClip.getState().set(null);
        message.success(r.moved.length ? `已移动 ${r.moved.length} 项` : '已经在这个目录里了');
      }
      await list(path);
    } catch (e) {
      fail(e);
    }
  };

  /** 从系统剪贴板上传：访达 / 资源管理器里复制的文件 */
  const uploadFromClipboard = async (): Promise<void> => {
    const files = await invoke('local.clipboardFiles').catch(() => [] as string[]);
    if (!files.length) return void message.info('剪贴板里没有文件：先在访达 / 资源管理器里复制文件，或者直接把文件拖进来');
    await upload(files);
  };

  const toggleFavorite = async (dir: string): Promise<void> => {
    const host = tab.hostId ?? '';
    const all = { ...useApp.getState().settings['sftp.favorites'] };
    const cur = all[host] ?? [];
    all[host] = cur.includes(dir) ? cur.filter((x) => x !== dir) : [...cur, dir].slice(-50);
    if (!all[host].length) delete all[host];
    await useApp.getState().updateSetting('sftp.favorites', all);
    message.success(cur.includes(dir) ? '已取消收藏' : `已收藏 ${dir}`);
  };

  const submitName = async (): Promise<void> => {
    if (!nameDialog || !sftpId || !path) return;
    const name = nameDialog.name.trim();
    if (!name || name.includes('/')) return;
    try {
      if (nameDialog.kind === 'rename' && nameDialog.entry) await invoke('sftp.rename', { sftpId, from: nameDialog.entry.path, to: joinRemote(path, name) });
      else if (nameDialog.kind === 'mkdir') await invoke('sftp.mkdir', { sftpId, path: joinRemote(path, name) });
      else if (nameDialog.kind === 'touch') await invoke('sftp.createFile', { sftpId, path: joinRemote(path, name) });
      else if (nameDialog.kind === 'archive') {
        const hide = message.loading({ content: '正在压缩…', duration: 0, key: 'archive' });
        try {
          const r = await invoke('sftp.archive', { sftpId, paths: picked.map((e) => e.path), name, format: nameDialog.format ?? 'tar.gz' });
          message.success(`已压缩为 ${baseName(r.path)}`);
        } finally {
          hide();
        }
      }
      setNameDialog(null);
      await list(path);
    } catch (e) {
      fail(e);
    }
  };

  const submitDest = async (): Promise<void> => {
    if (!destDialog || !sftpId || !path) return;
    const dest = destDialog.dest.trim();
    if (!dest) return;
    try {
      const paths = destDialog.entries.map((e) => e.path);
      if (destDialog.mode === 'copy') await invoke('sftp.copy', { sftpId, paths, destDir: dest });
      else await invoke('sftp.move', { sftpId, paths, destDir: dest });
      message.success(destDialog.mode === 'copy' ? `已复制到 ${dest}` : `已移动到 ${dest}`);
      setDestDialog(null);
      await list(path);
    } catch (e) {
      fail(e);
    }
  };

  // ---------------------------------------------------------------- 在终端进入当前目录
  // 右键空白处、文件、文件夹都是进入文件面板当前所在的目录（菜单里写明路径）；
  // FTP 的路径可能和服务器上的实际路径不一致（chroot 到主目录），不提供
  const canCd = !!tab.hostId && protocol !== 'ftp' && protocol !== 'ftps';
  const cdHere = (): void => {
    if (!path || !tab.hostId) return;
    void runInTab(`cd ${shArg(path)}`, tab.kind !== 'sftp' ? tab.id : null, tab.hostId).catch(fail);
  };
  const cdItem = (dirPicked: boolean): NonNullable<MenuProps['items']>[number] => ({
    key: 'cdHere',
    icon: <CodeOutlined />,
    label: (
      <span className="fp-cd-item" title={`在终端执行 cd ${path ?? ''}`} data-testid="fp-cd-item">
        在终端进入当前目录
        <span className="fp-cd-path mono">{path}</span>
        {dirPicked && <span className="fp-cd-note">进入的是当前所在目录，不是所选的文件夹</span>}
      </span>
    ),
  });

  // ---------------------------------------------------------------- 右键菜单
  const fileMenu = (): MenuProps['items'] => {
    const many = picked.length > 1;
    const one = picked.length === 1 ? picked[0] : null;
    const file = one && one.type !== 'dir' ? one : null;
    const n = many ? ` ${picked.length} 项` : '';
    return [
      ...(one?.type === 'dir' ? [{ key: 'open', label: '打开', icon: <FolderOpenOutlined /> }] : []),
      ...(canCd ? [cdItem(picked.some((e) => e.type === 'dir')), { type: 'divider' as const }] : []),
      { key: 'copy', label: `复制${n}`, icon: <CopyOutlined />, disabled: !canExec },
      { key: 'cut', label: `剪切${n}`, icon: <ScissorOutlined /> },
      { key: 'copyTo', label: '复制到…', icon: <CopyOutlined />, disabled: !canExec },
      { key: 'moveTo', label: '移动到…', icon: <ScissorOutlined /> },
      { key: 'copyPath', label: '复制路径', icon: <LinkOutlined /> },
      { key: 'archive', label: '压缩…', icon: <FileZipOutlined />, disabled: !canExec },
      ...(file && /\.sh$/i.test(file.name) && protocol !== 'ftp' && protocol !== 'ftps'
        ? [{ key: 'execSh', label: '执行…', icon: <PlayCircleOutlined /> }]
        : []),
      ...(file
        ? [
            { key: 'edit', label: '编辑', icon: <FormOutlined /> },
            { key: 'openLocal', label: '用本地程序打开', icon: <ExportOutlined /> },
          ]
        : []),
      { type: 'divider' as const },
      { key: 'download', label: `下载${n}`, icon: <DownloadOutlined /> },
      { key: 'downloadTo', label: '下载到…', icon: <DownloadOutlined /> },
      ...(canExec && (many || one?.type === 'dir') ? [{ key: 'downloadZip', label: '打包下载（tar.gz）', icon: <FileZipOutlined /> }] : []),
      { key: 'fav', label: one?.type === 'dir' ? (favorites.includes(one.path) ? '取消收藏这个目录' : '收藏这个目录') : favorites.includes(path ?? '') ? '取消收藏所在目录' : '收藏所在目录', icon: <StarOutlined /> },
      ...(one ? [{ key: 'rename', label: '重命名…', icon: <EditOutlined /> }] : []),
      { key: 'chmod', label: '修改权限…', icon: <SafetyOutlined />, disabled: !canExec },
      ...(file && tab.hostId
        ? [
            { type: 'divider' as const },
            { key: 'ref', label: `引用到 AI（尾部 500 行）${aiOk ? '' : '（登录后可用）'}`, icon: <RobotOutlined />, disabled: !aiOk },
            { key: 'analyze', label: `让 AI 分析这个文件${aiOk ? '' : '（登录后可用）'}`, icon: <RobotOutlined />, disabled: !aiOk },
          ]
        : []),
      { type: 'divider' as const },
      { key: 'delete', label: `删除${n}`, danger: true, icon: <DeleteOutlined /> },
    ];
  };
  const onFileMenu = (key: string): void => {
    const one = picked[0];
    if (!one || !sftpId || !path) return;
    if (key === 'open') void list(one.path);
    if (key === 'cdHere') cdHere();
    if (key === 'copy' || key === 'cut') {
      useFileClip.getState().set({ mode: key, hostId: tab.hostId ?? '', paths: picked.map((e) => e.path) });
      message.success(`${key === 'copy' ? '已复制' : '已剪切'} ${picked.length} 项，到目标目录右键「粘贴」`);
    }
    if (key === 'copyTo' || key === 'moveTo') setDestDialog({ mode: key === 'copyTo' ? 'copy' : 'move', entries: picked, dest: path });
    if (key === 'copyPath') void navigator.clipboard.writeText(picked.map((e) => e.path).join('\n')).then(() => message.success('已复制路径'));
    if (key === 'archive') setNameDialog({ kind: 'archive', name: picked.length === 1 ? one.name : `${baseName(path) || 'files'}-${picked.length}项`, format: 'tar.gz' });
    if (key === 'execSh' && tab.hostId)
      useShExec.getState().show({ hostId: tab.hostId, path: one.path, cwd: null, tabId: tab.kind !== 'sftp' ? tab.id : null, perms: one.perms });
    if (key === 'edit') useEdits.getState().openEditor(sftpId, one.path);
    if (key === 'openLocal') void useEdits.getState().editExternal(sftpId, one.path).catch(fail);
    if (key === 'download') void download(picked);
    if (key === 'downloadTo') void download(picked, 'pick');
    if (key === 'downloadZip') void download(picked, 'compress');
    if (key === 'fav') void toggleFavorite(picked.length === 1 && one.type === 'dir' ? one.path : path);
    if (key === 'rename') setNameDialog({ kind: 'rename', entry: one, name: one.name });
    if (key === 'chmod') setChmodOf(picked);
    if ((key === 'ref' || key === 'analyze') && tab.hostId) {
      useAgent.getState().addFile({ hostId: tab.hostId, path: one.path, tailLines: 500 });
      if (key === 'analyze') useAgent.getState().ask(`分析这个文件，指出其中的错误、异常和需要关注的地方：${one.path}`, 'ask');
      else message.success('已加入 AI 的引用，发送下一条消息时带上');
    }
    if (key === 'delete') remove(picked);
  };
  const blankMenu = (): MenuProps['items'] => [
    ...(canCd ? [cdItem(false), { type: 'divider' as const }] : []),
    { key: 'refresh', label: '刷新', icon: <ReloadOutlined /> },
    { key: 'clipUpload', label: '从剪贴板上传', icon: <UploadOutlined /> },
    ...(clip ? [{ key: 'paste', label: `粘贴（${clip.mode === 'copy' ? '复制' : '移动'} ${clip.paths.length} 项）`, icon: <SnippetsOutlined />, disabled: clip.hostId !== tab.hostId }] : []),
    { type: 'divider' as const },
    { key: 'mkdir', label: '新建文件夹', icon: <FolderAddOutlined /> },
    { key: 'touch', label: '新建文件', icon: <FileAddOutlined /> },
    { type: 'divider' as const },
    { key: 'uploadFiles', label: '上传文件到此处', icon: <UploadOutlined /> },
    { key: 'uploadDir', label: '上传文件夹到此处', icon: <CloudUploadOutlined /> },
  ];
  const onBlankMenu = (key: string): void => {
    if (key === 'cdHere') cdHere();
    if (key === 'refresh' && path) void list(path);
    if (key === 'clipUpload') void uploadFromClipboard();
    if (key === 'paste') void paste();
    if (key === 'mkdir') setNameDialog({ kind: 'mkdir', name: '' });
    if (key === 'touch') setNameDialog({ kind: 'touch', name: '' });
    if (key === 'uploadFiles') void pickAndUpload('files');
    if (key === 'uploadDir') void pickAndUpload('dir');
  };
  const pickAndUpload = async (what: 'files' | 'dir'): Promise<void> => {
    if (what === 'files') return upload(await invoke('dialog.openFiles'));
    const dir = await invoke('dialog.openDirectory', { title: '选择要上传的文件夹' });
    if (dir) await upload([dir]);
  };

  const onListKey = (ev: React.KeyboardEvent): void => {
    const mod = isMac ? ev.metaKey : ev.ctrlKey;
    const k = ev.key.toLowerCase();
    if (mod && k === 'a') {
      ev.preventDefault();
      setSelected(visible.map((x) => x.path));
    } else if (ev.key === 'Escape') setSelected([]);
    else if ((ev.key === 'Delete' || (isMac && mod && ev.key === 'Backspace')) && picked.length) {
      ev.preventDefault();
      remove(picked);
    } else if (mod && (k === 'c' || k === 'x') && picked.length) {
      ev.preventDefault();
      onFileMenu(k === 'c' ? 'copy' : 'cut');
    } else if (ev.key === 'Enter' && picked.length === 1) {
      ev.preventDefault();
      openFile(picked[0]);
    } else if (ev.key === 'F2' && picked.length === 1) setNameDialog({ kind: 'rename', entry: picked[0], name: picked[0].name });
  };

  // ---------------------------------------------------------------- 界面
  if (openError) {
    return (
      <div className="side-empty">
        <Empty description={openError}>
          <Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>
        </Empty>
      </div>
    );
  }
  if (!sftpId || path === null) {
    return (
      <div className="side-empty">
        <Spin />
      </div>
    );
  }

  const favorited = favorites.includes(path);
  const sortIcon = (k: ColKey): React.ReactNode => (sort.key === k ? sort.desc ? <CaretDownOutlined /> : <CaretUpOutlined /> : null);
  const tool = (title: string, icon: React.ReactNode, onClick: () => void, opts: { active?: boolean; disabled?: boolean; testId?: string } = {}): React.JSX.Element => (
    <Tooltip title={title}>
      <Button size="small" type="text" className={`fp-tool ${opts.active ? 'active' : ''}`} icon={icon} disabled={opts.disabled} onClick={onClick} data-testid={opts.testId} aria-label={title} />
    </Tooltip>
  );

  return (
    <div
      className={`file-panel ${sftpTab ? 'in-sftp' : ''} ${dropOver === '' ? 'drop-over' : ''}`}
      data-testid="file-panel"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files') || (sftpTab && e.dataTransfer.types.includes(FILES_MIME))) {
          e.preventDefault();
          if (dropOver === null) setDropOver('');
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropOver(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const dir = dropOver || path;
        setDropOver(null);
        // SFTP 标签页：从左边的本地窗格拖过来
        const raw = sftpTab ? e.dataTransfer.getData(FILES_MIME) : '';
        if (raw) {
          const data = JSON.parse(raw) as { side: string; paths: string[] };
          if (data.side === 'local') void upload(data.paths, dir);
          return;
        }
        void upload(Array.from(e.dataTransfer.files).map((f) => window.itm.getPathForFile(f)).filter(Boolean), dir);
      }}
    >
      {/* 第一行：功能按钮 */}
      <div className="fp-toolbar">
        {tool('新建文件夹', <FolderAddOutlined />, () => setNameDialog({ kind: 'mkdir', name: '' }), { testId: 'fp-mkdir' })}
        {tool('新建文件', <FileAddOutlined />, () => setNameDialog({ kind: 'touch', name: '' }), { testId: 'fp-touch' })}
        {tool(showHidden ? '隐藏以 . 开头的文件' : '显示隐藏文件（以 . 开头）', showHidden ? <EyeOutlined /> : <EyeInvisibleOutlined />, () => void useApp.getState().updateSetting('sftp.showHidden', !showHidden), { active: showHidden, testId: 'fp-hidden' })}
        {!sftpTab &&
          tool(follow ? '与终端目录同步（已开启）' : '与终端目录同步（已关闭）', <AimOutlined />, () => {
            setFollow((f) => !f);
            if (!follow && tab.cwd) void list(tab.cwd);
          }, { active: follow, testId: 'file-panel-follow' })}
        {tool('刷新', <ReloadOutlined spin={loading} />, () => void list(path), { testId: 'fp-refresh' })}
        {tool('上传文件（也可以拖进来）', <UploadOutlined />, () => void pickAndUpload('files'), { testId: 'file-panel-upload' })}
        {tool('上传文件夹', <CloudUploadOutlined />, () => void pickAndUpload('dir'), { testId: 'fp-upload-dir' })}
        <Dropdown
          trigger={['contextMenu']}
          disabled={!picked.length}
          menu={{
            items: [
              { key: 'pick', label: '下载到…', icon: <FolderOpenOutlined /> },
              ...(canExec ? [{ key: 'compress', label: '打包下载（tar.gz）', icon: <FileZipOutlined /> }] : []),
            ],
            onClick: ({ key }) => void download(picked, key as 'pick' | 'compress'),
          }}
        >
          <span>
            {tool(picked.length ? `下载选中的 ${picked.length} 项（右键：下载到… / 打包下载）` : '下载选中的文件（先选择文件）', <DownloadOutlined />, () => void download(picked), {
              disabled: !picked.length,
              testId: 'file-panel-download',
            })}
          </span>
        </Dropdown>
        {tool(picked.length ? `删除选中的 ${picked.length} 项` : '删除选中的文件', <DeleteOutlined />, () => remove(picked), { disabled: !picked.length, testId: 'fp-delete' })}
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: '__toggle', label: favorited ? '取消收藏当前目录' : '收藏当前目录', icon: favorited ? <StarFilled /> : <StarOutlined /> },
              ...(favorites.length ? [{ type: 'divider' as const }, ...favorites.map((f) => ({ key: f, label: <span className="mono">{f}</span> }))] : []),
            ],
            onClick: ({ key }) => (key === '__toggle' ? void toggleFavorite(path) : void list(key)),
          }}
        >
          <span>{tool('收藏的目录', favorited ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />, () => undefined, { testId: 'fp-favorites' })}</span>
        </Dropdown>
        <span className="fp-download-label" data-testid="file-panel-download-count">
          {picked.length > 1 ? `下载 ${picked.length}` : picked.length === 1 ? '下载' : ''}
        </span>
      </div>
      {/* 第二行：完整路径 */}
      <div className="fp-pathrow">
        <Tooltip title="上一级">
          <Button size="small" type="text" icon={<ArrowUpOutlined />} onClick={() => void list(parentRemote(path))} data-testid="fp-up" />
        </Tooltip>
        <Tooltip title="主目录">
          <Button size="small" type="text" icon={<HomeOutlined />} onClick={() => void list(home)} />
        </Tooltip>
        {protocol !== 'sftp' && (
          <Tooltip title={notice ?? PROTOCOL_TIP[protocol]}>
            <Tag color={protocol === 'ftp' ? 'orange' : protocol === 'ftps' ? 'green' : 'blue'} bordered={false} className="proto-tag" data-testid="file-proto">
              {PROTOCOL_LABEL[protocol]}
            </Tag>
          </Tooltip>
        )}
        <PathBar
          path={path}
          onNavigate={(p) => void list(p)}
          history={history}
          onClearHistory={() => tab.hostId && useFilePrefs.getState().clearHistory(tab.hostId)}
          onTerminalCd={canCd ? cdHere : undefined}
        />
      </div>
      <div className="fp-search">
        <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索…" value={filter} onChange={(e) => setFilter(e.target.value)} data-testid="fp-search" />
      </div>
      {lost && (
        <Alert
          className="fp-lost"
          type="warning"
          showIcon
          icon={<DisconnectOutlined />}
          message={lost}
          action={
            <Button size="small" type="primary" onClick={() => setAttempt((n) => n + 1)} data-testid="fp-reconnect">
              重新连接
            </Button>
          }
          data-testid="fp-lost"
        />
      )}
      <div
        className="file-panel-list"
        ref={listRef}
        tabIndex={-1}
        onKeyDown={onListKey}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).map((f) => window.itm.getPathForFile(f)).filter(Boolean);
          if (files.length) {
            e.preventDefault();
            void upload(files);
          } else if (clip) {
            e.preventDefault();
            void paste();
          }
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            listRef.current?.focus({ preventScroll: true });
            if (e.button === 0) setSelected([]);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // 表头有自己的右键菜单（选择显示哪些列）
          if ((e.target as HTMLElement).closest('.fp-header')) return;
          const onRow = (e.target as HTMLElement).closest('.file-row');
          setMenu({ x: e.clientX, y: e.clientY, kind: onRow ? 'files' : 'blank' });
        }}
        data-testid="file-panel-list"
      >
        {/* 表头（在滚动区域里，上下滚动时固定在顶部）：点击排序，拖动边线调整列宽（名称列填满剩余空间），右键选择显示哪些列 */}
        <Dropdown
          trigger={['contextMenu']}
          menu={{
            items: [
              ...COLS.filter((c) => c.key !== 'name').map((c) => ({ key: c.key, label: c.label, icon: colPrefs.hidden.includes(c.key) ? <span className="fp-menu-blank" /> : <CheckOutlined /> })),
              { type: 'divider' as const },
              { key: '__reset', label: '恢复默认的列和列宽' },
            ],
            onClick: ({ key }) => (key === '__reset' ? useFilePrefs.getState().resetCols() : useFilePrefs.getState().toggleCol(key as ColKey)),
          }}
        >
          <div className="fp-header" data-testid="fp-header">
            {cols.map((c) => (
              <span
                key={c.key}
                className={`fp-th fp-cell ${c.right ? 'right' : ''} ${c.key === 'name' ? 'fp-th-name' : ''} ${sort.key === c.key ? 'sorted' : ''}`}
                style={cellStyle(c)}
                onClick={() => toggleSort(c.key)}
                data-testid={`fp-sort-${c.key}`}
              >
                <span className="fp-th-label">{c.label}</span>
                {sortIcon(c.key)}
                {c.key !== 'name' && <span
                  className="fp-col-resize"
                  title="拖动调整列宽，双击恢复默认"
                  onMouseDown={(ev) => startResize(ev, c)}
                  onClick={(ev) => ev.stopPropagation()}
                  onDoubleClick={(ev) => {
                    ev.stopPropagation();
                    useFilePrefs.getState().setWidth(c.key, null);
                    useFilePrefs.getState().persistCols();
                  }}
                  data-testid={`fp-resize-${c.key}`}
                />}
              </span>
            ))}
          </div>
        </Dropdown>
        {visible.length === 0 && !loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter ? '没有匹配的文件' : '空目录'} />}
        {visible.map((e) => (
          <div
            key={e.path}
            className={`file-row ${selected.includes(e.path) ? 'selected' : ''} ${dropOver === e.path ? 'drop-target' : ''} ${clip?.mode === 'cut' && clip.paths.includes(e.path) ? 'cut' : ''}`}
            data-testid={`panel-file-${e.name}`}
            onMouseDown={(ev) => onRowMouseDown(ev, e)}
            onMouseUp={(ev) => onRowMouseUp(ev, e)}
            onMouseEnter={(ev) => onRowMouseEnter(ev, e)}
            onDoubleClick={(ev) => !(ev.metaKey || ev.ctrlKey || ev.shiftKey) && openFile(e)}
            onDragStart={(ev) => {
              // 只有按下时已经选中的行才拖到本机；没选中的行拖动是框选
              if (sftpTab && armedRef.current) {
                // SFTP 标签页：拖到左边的本地窗格下载
                armedRef.current = false;
                ev.dataTransfer.setData(FILES_MIME, JSON.stringify({ side: 'remote', paths: (selected.includes(e.path) ? picked : [e]).map((x) => x.path) }));
                ev.dataTransfer.effectAllowed = 'copy';
                return;
              }
              ev.preventDefault();
              if (!armedRef.current) return;
              armedRef.current = false;
              void dragOut(selected.includes(e.path) ? picked : [e]);
            }}
            onDragOver={(ev) => {
              if (e.type === 'dir' && (ev.dataTransfer.types.includes('Files') || (sftpTab && ev.dataTransfer.types.includes(FILES_MIME)))) {
                ev.preventDefault();
                ev.stopPropagation();
                if (dropOver !== e.path) setDropOver(e.path);
              }
            }}
          >
            {cols.map((c) => cellOf(c, e))}
          </div>
        ))}
      </div>
      {/* SFTP 标签页底部有完整的传输列表 */}
      {!sftpTab && <TransferBar sftpId={sftpId} />}

      {/* 右键菜单：放在鼠标位置的锚点 */}
      <Dropdown
        open={!!menu}
        onOpenChange={(o) => !o && setMenu(null)}
        trigger={['contextMenu']}
        menu={{
          items: menu?.kind === 'files' && picked.length ? fileMenu() : blankMenu(),
          onClick: ({ key }) => {
            const kind = menu?.kind;
            setMenu(null);
            if (kind === 'files' && picked.length) onFileMenu(key);
            else onBlankMenu(key);
          },
        }}
        overlayClassName="fp-menu"
      >
        <div className="ctx-anchor" style={{ left: menu?.x ?? -10, top: menu?.y ?? -10 }} />
      </Dropdown>

      <Modal
        open={!!nameDialog}
        title={nameDialog?.kind === 'rename' ? '重命名' : nameDialog?.kind === 'mkdir' ? '新建文件夹' : nameDialog?.kind === 'touch' ? '新建文件' : `压缩 ${picked.length} 项`}
        okText="确定"
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setNameDialog(null)}
        onOk={() => void submitName()}
      >
        {nameDialog?.kind === 'archive' && (
          <Radio.Group value={nameDialog.format} onChange={(e) => setNameDialog((d) => d && { ...d, format: e.target.value as 'tar.gz' | 'zip' })} style={{ marginBottom: 10 }}>
            <Radio value="tar.gz">tar.gz</Radio>
            <Radio value="zip">zip（需要服务器上有 zip 命令）</Radio>
          </Radio.Group>
        )}
        <Input
          autoFocus
          value={nameDialog?.name ?? ''}
          placeholder={nameDialog?.kind === 'archive' ? '压缩包名称（不用写扩展名）' : '名称'}
          suffix={nameDialog?.kind === 'archive' ? `.${nameDialog.format}` : undefined}
          onChange={(ev) => setNameDialog((r) => r && { ...r, name: ev.target.value })}
          onPressEnter={() => void submitName()}
          data-testid="fp-name-input"
        />
      </Modal>
      <Modal
        open={!!destDialog}
        title={destDialog?.mode === 'copy' ? `复制 ${destDialog.entries.length} 项到…` : `移动 ${destDialog?.entries.length ?? 0} 项到…`}
        okText={destDialog?.mode === 'copy' ? '复制' : '移动'}
        cancelText="取消"
        destroyOnHidden
        onCancel={() => setDestDialog(null)}
        onOk={() => void submitDest()}
      >
        <Input
          className="mono"
          autoFocus
          value={destDialog?.dest ?? ''}
          placeholder="目标目录的完整路径，例如 /data/backup"
          onChange={(ev) => setDestDialog((d) => d && { ...d, dest: ev.target.value })}
          onPressEnter={() => void submitDest()}
          data-testid="fp-dest-input"
        />
        {favorites.length > 0 && (
          <Space wrap style={{ marginTop: 10 }}>
            {favorites.map((f) => (
              <Tag key={f} className="mono" style={{ cursor: 'pointer' }} onClick={() => setDestDialog((d) => d && { ...d, dest: f })}>
                {f}
              </Tag>
            ))}
          </Space>
        )}
      </Modal>
      <ChmodDialog
        entries={chmodOf}
        onCancel={() => setChmodOf(null)}
        onOk={async (mode, recursive) => {
          try {
            await invoke('sftp.chmod', { sftpId, paths: (chmodOf ?? []).map((e) => e.path), mode, recursive });
            setChmodOf(null);
            message.success('权限已修改');
            await list(path);
          } catch (e) {
            fail(e);
          }
        }}
      />
      <UploadConflictDialog rows={conflict?.rows ?? null} onOk={(c) => conflict?.resolve(c)} onCancel={() => conflict?.resolve(null)} />
    </div>
  );
}
