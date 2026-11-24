import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, Dropdown, Empty, Input, Modal, Segmented, Slider, Space, Switch, Tooltip, Typography } from 'antd';
import {
  BookOutlined,
  CaretRightOutlined,
  CopyOutlined,
  DownOutlined,
  ExportOutlined,
  PauseOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
  SelectOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { AUDIT_SOURCE_LABEL, type RecordingCommand, type RecordingData } from '@itm/protocol';
import dayjs from 'dayjs';
import { errorMessage, invoke } from '../api';
import { useApp } from '../store/app';
import { useLibrary } from '../store/library';
import { useTerminalTheme } from '../util/theme';
import { useAiAllowed } from '../util/ai-access';
import { stripPrompt } from '../util/format';
import { useAddSnippet } from './AddSnippetDialog';

/** 空闲超过这个时长（秒）时压缩成这个时长，避免回放时长时间没有画面 */
const IDLE_CAP = 2;

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** 录像里的原始时间（秒）→ 回放时间轴（跳过空闲时压缩过） */
function toTimeline(data: RecordingData, times: number[], raw: number, skipIdle: boolean): number {
  let lo = 0;
  let hi = data.events.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (data.events[mid][0] <= raw) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const base = idx >= 0 ? times[idx] : 0;
  const gap = raw - (idx >= 0 ? data.events[idx][0] : 0);
  return base + (skipIdle ? Math.min(gap, IDLE_CAP) : gap);
}

/**
 * 会话录像回放（文档一 6.12）：播放 / 暂停、倍速、跳过空闲、拖动进度；可以导出为标准 asciicast（.cast）。
 * 第十二轮：右侧列出这次会话执行过的命令（按命令审计的时间），单击跳到那一刻并暂停，命令后面可以一键加到快捷指令；
 * 回放画面右键可以复制、把选中内容加到快捷指令；导出菜单里可以用 AI 把整段录像汇总为笔记。
 */
export function RecordingPlayer({ id, onClose }: { id: string | null; onClose(): void }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const settings = useApp((s) => s.settings);
  const theme = useTerminalTheme();
  const aiAllowed = useAiAllowed();
  const [data, setData] = useState<RecordingData | null>(null);
  const [commands, setCommands] = useState<RecordingCommand[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skipIdle, setSkipIdle] = useState(true);
  const [pos, setPos] = useState(0);
  const [cmdQuery, setCmdQuery] = useState('');
  const [menuSel, setMenuSel] = useState('');
  /** AI 汇总为笔记的对话框 */
  const [noteOpen, setNoteOpen] = useState(false);
  // 弹窗内容可能比数据晚挂载：用回调 ref，挂载后再创建终端
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const state = useRef({ idx: 0, time: 0 });
  const cmdListRef = useRef<HTMLDivElement>(null);

  // 跳过空闲：把事件时间换算成压缩后的时间轴
  const timeline = useMemo(() => {
    if (!data) return { times: [] as number[], total: 0 };
    const times: number[] = [];
    let prev = 0;
    let acc = 0;
    for (const e of data.events) {
      const gap = Math.max(0, e[0] - prev);
      acc += skipIdle ? Math.min(gap, IDLE_CAP) : gap;
      prev = e[0];
      times.push(acc);
    }
    return { times, total: acc };
  }, [data, skipIdle]);

  /** 每条命令在时间轴上的位置 */
  const cmdTimes = useMemo(() => (data ? commands.map((c) => Math.min(timeline.total, toTimeline(data, timeline.times, c.offsetMs / 1000, skipIdle))) : []), [data, commands, timeline, skipIdle]);
  /** 当前播放到的命令：时间不晚于当前位置的最后一条 */
  const activeCmd = useMemo(() => {
    let a = -1;
    cmdTimes.forEach((t, i) => {
      if (t <= pos + 0.001) a = i;
    });
    return a;
  }, [cmdTimes, pos]);
  const shownCmds = useMemo(() => {
    const q = cmdQuery.trim().toLowerCase();
    return commands.map((c, i) => ({ c, i })).filter(({ c }) => !q || c.command.toLowerCase().includes(q));
  }, [commands, cmdQuery]);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setCommands([]);
    setError(null);
    setPos(0);
    setPlaying(false);
    invoke('recording.read', { id })
      .then((d) => {
        setData(d);
        setPlaying(true);
      })
      .catch((e) => setError(errorMessage(e)));
    invoke('recording.commands', { id })
      .then(setCommands)
      .catch(() => setCommands([]));
  }, [id]);

  // 创建回放用的终端
  useEffect(() => {
    if (!data || !box) return;
    const term = new Terminal({
      cols: data.cols,
      rows: data.rows,
      fontSize: Math.min(settings['terminal.fontSize'], 13),
      fontFamily: settings['terminal.fontFamily'],
      theme,
      disableStdin: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(box);
    termRef.current = term;
    state.current = { idx: 0, time: 0 };
    return () => {
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, box]);

  /** 把事件写到终端，直到时间轴上的 t（快进时一次写入） */
  const advanceTo = (t: number): void => {
    const term = termRef.current;
    if (!term || !data) return;
    let out = '';
    while (state.current.idx < data.events.length && timeline.times[state.current.idx] <= t) {
      const [, kind, payload] = data.events[state.current.idx];
      if (kind === 'o') out += payload;
      else {
        if (out) {
          term.write(out);
          out = '';
        }
        const m = /^(\d+)x(\d+)$/.exec(payload);
        if (m) term.resize(Math.max(2, Number(m[1])), Math.max(1, Number(m[2])));
      }
      state.current.idx++;
    }
    if (out) term.write(out);
    state.current.time = t;
  };

  // 播放
  useEffect(() => {
    if (!playing || !data || !box) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const dt = ((now - last) / 1000) * speed;
      last = now;
      const t = Math.min(timeline.total, state.current.time + dt);
      advanceTo(t);
      setPos(t);
      if (t >= timeline.total) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, data, timeline, box]);

  // 播放时命令列表跟着滚动到当前命令
  useEffect(() => {
    if (activeCmd < 0 || !playing) return;
    cmdListRef.current?.querySelector(`[data-cmd-index="${activeCmd}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeCmd, playing]);

  const seek = (t: number): void => {
    const term = termRef.current;
    if (!term || !data) return;
    if (t < state.current.time) {
      term.reset();
      term.resize(data.cols, data.rows);
      state.current = { idx: 0, time: 0 };
    }
    advanceTo(t);
    setPos(t);
  };

  /** 单击命令：跳到执行这条命令的那一刻（命令行已经输入完）并暂停 */
  const jumpTo = (i: number): void => {
    setPlaying(false);
    seek(Math.min(timeline.total, cmdTimes[i] + 0.01));
    termRef.current?.scrollToBottom();
  };

  const exportCast = async (): Promise<void> => {
    if (!data) return;
    const ok = await modal.confirm({
      title: '导出为明文录像？',
      content: '导出的 .cast 文件是明文，任何人都可以用 asciinema 回放，请妥善保管。',
      okText: '导出',
      cancelText: '取消',
    });
    if (!ok) return;
    const filePath = await invoke('dialog.saveFile', {
      title: '导出录像',
      defaultName: `${data.info.hostName}-${dayjs(data.info.startedAt).format('YYYYMMDD-HHmmss')}.cast`.replace(/[\\/:*?"<>|]/g, '_'),
      filters: [{ name: 'asciicast', extensions: ['cast'] }],
    });
    if (!filePath) return;
    try {
      await invoke('recording.export', { id: data.info.id, filePath });
      message.success('已导出');
    } catch (e) {
      message.error(errorMessage(e));
    }
  };

  const addSnippet = (c: RecordingCommand): void => useAddSnippet.getState().show({ content: c.command });

  return (
    <Modal
      open={!!id}
      title={data ? `${data.info.hostName} · ${dayjs(data.info.startedAt).format('YYYY-MM-DD HH:mm:ss')}` : '会话录像'}
      width="min(1320px, 96vw)"
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      {error ? (
        <Typography.Text type="danger">{error}</Typography.Text>
      ) : (
        <div className="rec-layout">
          <div className="rec-player" data-testid="rec-player">
            <Dropdown
              trigger={['contextMenu']}
              onOpenChange={(open) => open && setMenuSel(termRef.current?.getSelection() ?? '')}
              menu={{
                items: [
                  { key: 'copy', label: '复制', icon: <CopyOutlined />, disabled: !menuSel },
                  { key: 'selectAll', label: '全选', icon: <SelectOutlined /> },
                  { type: 'divider' },
                  { key: 'snippet', label: '选中内容添加到快捷指令…', icon: <ThunderboltOutlined />, disabled: !menuSel.trim() },
                ],
                onClick: ({ key }) => {
                  if (key === 'copy' && menuSel) void navigator.clipboard.writeText(menuSel);
                  if (key === 'selectAll') termRef.current?.selectAll();
                  if (key === 'snippet' && menuSel.trim()) useAddSnippet.getState().show({ content: stripPrompt(menuSel.trim()) });
                },
              }}
            >
              <div className="rec-screen" style={{ background: theme.background }}>
                <div ref={setBox} data-testid="rec-term" />
              </div>
            </Dropdown>
            <div className="rec-controls">
              <Button
                type="text"
                icon={playing ? <PauseOutlined /> : pos >= timeline.total && timeline.total > 0 ? <ReloadOutlined /> : <CaretRightOutlined />}
                onClick={() => {
                  if (!playing && pos >= timeline.total) seek(0);
                  setPlaying((p) => !p);
                }}
                disabled={!data}
                data-testid="rec-play"
              />
              <span className="mono rec-time" data-testid="rec-time">
                {fmt(pos)} / {fmt(timeline.total)}
              </span>
              <div className="rec-track">
                <Slider
                  className="rec-slider"
                  min={0}
                  max={Math.max(timeline.total, 0.001)}
                  step={0.01}
                  value={pos}
                  tooltip={{ formatter: (v) => fmt(v ?? 0) }}
                  onChange={(v) => {
                    setPlaying(false);
                    seek(v);
                  }}
                  disabled={!data}
                />
                {/* 进度条上标出每条命令的位置 */}
                {timeline.total > 0 &&
                  cmdTimes.map((t, i) => (
                    <span key={i} className={`rec-mark ${i === activeCmd ? 'on' : ''}`} style={{ left: `${(t / timeline.total) * 100}%` }} title={commands[i]?.command} onClick={() => jumpTo(i)} />
                  ))}
              </div>
              <Segmented size="small" value={speed} onChange={(v) => setSpeed(v as number)} options={[1, 2, 4, 8].map((x) => ({ value: x, label: `${x}×` }))} />
              <Tooltip title={`空闲超过 ${IDLE_CAP} 秒的部分压缩成 ${IDLE_CAP} 秒`}>
                <Space size={4}>
                  <Switch size="small" checked={skipIdle} onChange={setSkipIdle} />
                  <span style={{ fontSize: 12, whiteSpace: 'nowrap' }}>跳过空闲</span>
                </Space>
              </Tooltip>
              <Dropdown
                trigger={['click']}
                disabled={!data}
                placement="topRight"
                menu={{
                  items: [
                    { key: 'cast', label: '导出为 asciicast（.cast）', icon: <ExportOutlined /> },
                    { key: 'note', label: aiAllowed ? 'AI 汇总为笔记…' : 'AI 汇总为笔记（登录后可用）', icon: <RobotOutlined />, disabled: !aiAllowed },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'cast') void exportCast();
                    if (key === 'note') setNoteOpen(true);
                  },
                }}
              >
                <Button size="small" icon={<ExportOutlined />} data-testid="rec-export">
                  导出 <DownOutlined style={{ fontSize: 10 }} />
                </Button>
              </Dropdown>
            </div>
            {data?.info.truncated && <Typography.Text type="warning">这段录像超过了 100MB，之后的输出没有记录。</Typography.Text>}
          </div>
          <aside className="rec-cmds" data-testid="rec-cmds">
            <div className="rec-cmds-head">
              <span>
                执行的命令 <span className="rec-cmds-count">{commands.length}</span>
              </span>
            </div>
            {commands.length > 6 && (
              <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="过滤命令" value={cmdQuery} onChange={(e) => setCmdQuery(e.target.value)} className="rec-cmds-search" />
            )}
            <div className="rec-cmds-list" ref={cmdListRef}>
              {commands.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这段录像没有记录到命令" style={{ marginTop: 40 }} />}
              {shownCmds.map(({ c, i }) => (
                <div key={i} data-cmd-index={i} className={`rec-cmd ${i === activeCmd ? 'active' : ''}`} onClick={() => jumpTo(i)} data-testid="rec-cmd">
                  <span className="rec-cmd-time mono">{fmt(cmdTimes[i] ?? 0)}</span>
                  <Tooltip title={<span className="mono" style={{ whiteSpace: 'pre-wrap' }}>{c.command}</span>} placement="left" mouseEnterDelay={0.5}>
                    <span className="rec-cmd-text mono">{c.command}</span>
                  </Tooltip>
                  {c.source && c.source !== 'USER' && <span className="rec-cmd-src">{AUDIT_SOURCE_LABEL[c.source]}</span>}
                  <Tooltip title="添加到快捷指令（可以用 AI 生成标题和描述）" placement="left">
                    <button
                      type="button"
                      className="rec-cmd-add"
                      onClick={(e) => {
                        e.stopPropagation();
                        addSnippet(c);
                      }}
                      aria-label="添加到快捷指令"
                      data-testid="rec-cmd-add"
                    >
                      <ThunderboltOutlined />
                    </button>
                  </Tooltip>
                </div>
              ))}
            </div>
          </aside>
        </div>
      )}
      {data && <RecordingNoteDialog open={noteOpen} onClose={() => setNoteOpen(false)} recordingId={data.info.id} defaultTitle={`${data.info.hostName} · ${dayjs(data.info.startedAt).format('YYYY-MM-DD HH:mm')}`} />}
    </Modal>
  );
}

/** 用 AI 把整段录像汇总成笔记：填写笔记标题和描述（描述也交给 AI 作为提示，并放在笔记开头） */
export function RecordingNoteDialog({ open, onClose, recordingId, defaultTitle }: { open: boolean; onClose(): void; recordingId: string; defaultTitle: string }): React.JSX.Element {
  const { message } = App.useApp();
  const [title, setTitle] = useState(defaultTitle);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setTitle(defaultTitle);
      setDesc('');
    }
  }, [open, defaultTitle]);

  const save = async (): Promise<void> => {
    const t = title.trim() || defaultTitle;
    setBusy(true);
    try {
      const body = await invoke('recording.summarizeNote', { id: recordingId, title: t, description: desc.trim() || undefined });
      const content = `${desc.trim() ? `> ${desc.trim().replace(/\n/g, '\n> ')}\n\n` : ''}${body}`;
      const note = await useLibrary.getState().saveAsNote(t, content);
      onClose();
      message.success({
        key: 'rec-note',
        content: (
          <span>
            已用 AI 汇总为笔记
            <Button type="link" size="small" onClick={() => useLibrary.getState().openNote(note.id)}>
              查看
            </Button>
          </span>
        ),
      });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="AI 汇总为笔记"
      okText={busy ? 'AI 汇总中…' : '汇总并保存'}
      cancelText="取消"
      confirmLoading={busy}
      onOk={() => void save()}
      onCancel={() => !busy && onClose()}
      width={480}
      destroyOnHidden
      okButtonProps={{ icon: <BookOutlined />, ['data-testid' as never]: 'rec-note-ok' }}
    >
      <div className="conv-note-form" data-testid="rec-note-dialog">
        <Typography.Text type="secondary">笔记标题</Typography.Text>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} data-testid="rec-note-title" />
        <Typography.Text type="secondary">描述</Typography.Text>
        <Input.TextArea value={desc} onChange={(e) => setDesc(e.target.value)} autoSize={{ minRows: 2, maxRows: 5 }} maxLength={2000} placeholder="这次会话在做什么（可选），AI 会参考它整理笔记，也会放在笔记开头" data-testid="rec-note-desc" />
        <Typography.Text type="secondary" className="conv-note-hint">
          把这段录像执行的命令和终端输出交给 AI，整理成「操作步骤、发现与结果、注意事项」；发送前会脱敏密码、密钥等信息。
        </Typography.Text>
      </div>
    </Modal>
  );
}
