import { useMemo, useState } from 'react';
import { App, Button, Checkbox, InputNumber, Popover, Segmented, Select, Slider, Switch, Typography } from 'antd';
import { BgColorsOutlined, CheckOutlined, DesktopOutlined, DownOutlined, FontSizeOutlined, MoonOutlined, PictureOutlined, SunOutlined, UpOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { appThemeScheme, isDarkColor, NAV_OPTIONAL, TERMINAL_SCHEMES, type Settings, type TerminalBackground, type TerminalScheme, type ThemeMode } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useApp } from '../../store/app';
import { useResolvedTheme, useTerminalScheme } from '../../util/theme';
import { appPalette } from '../../util/palette';
import { backgroundUrl } from '../../components/TerminalBackdrop';
import { useColorsDialog } from '../../components/TerminalColorsDialog';
import { FontSelect, firstFamily, fontInstalled, TERMINAL_FALLBACK, TERMINAL_FONTS, UI_FALLBACK, UI_FONTS } from './FontSelect';
import { SettingGroup, SettingRow, SettingsSection } from './parts';
import { NAV_PAGES } from '../../util/nav';

function useSet(): <K extends keyof Settings>(key: K, value: Settings[K] | null) => void {
  const { message } = App.useApp();
  const update = useApp((s) => s.updateSetting);
  return (key, value) => {
    if (value === null || value === undefined) return;
    update(key, value).catch((e) => message.error(errorMessage(e)));
  };
}

/** 主题卡片：一个缩小的窗口（侧栏 + 终端里的 $ ls -la + 强调色）、八个 ANSI 颜色、名称 */
function ThemeCard({ s, active, badge, onPick }: { s: TerminalScheme; active: boolean; badge?: React.ReactNode; onPick(): void }): React.JSX.Element {
  const c = s.colors;
  const p = useMemo(() => appPalette(s).vars, [s]);
  return (
    <button type="button" className={`theme-card ${active ? 'on' : ''}`} onClick={onPick} data-testid={`theme-card-${s.id}`} title={s.name}>
      <span className="theme-card-window" style={{ background: p['--itm-bg'], borderColor: p['--itm-border'] }}>
        <span className="theme-card-sider" style={{ background: p['--itm-sider-bg'], borderColor: p['--itm-border'] }}>
          <i style={{ background: p['--itm-primary'] }} />
          <i style={{ background: p['--itm-text-secondary'] }} />
          <i style={{ background: p['--itm-text-secondary'] }} />
        </span>
        <span className="theme-card-screen mono" style={{ color: c.foreground }}>
          <span style={{ color: c.green }}>$</span> ls -la
          <span className="theme-card-cursor" style={{ background: c.cursor }} />
        </span>
      </span>
      <span className="theme-card-dots">
        {(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const).map((k) => (
          <i key={k} style={{ background: c[k] }} />
        ))}
      </span>
      <span className="theme-card-name">
        {s.name}
        {badge}
        {active && <CheckOutlined className="theme-card-check" />}
      </span>
    </button>
  );
}

/**
 * 主题（第十二轮，参考 Chaterm）：整个软件的配色——侧栏、面板、文字、强调色，终端默认也跟着变。
 * 下拉面板里按背景深浅分成「深色主题」「浅色主题」两组卡片；深色模式和浅色模式各记一个主题（跟随系统时自动切换）。
 * 选了另一种深浅的主题时，界面模式跟着切换。
 */
function ThemePicker(): React.JSX.Element {
  const mode = useApp((s) => s.settings['ui.theme']);
  const resolved = useResolvedTheme();
  const cfg = useApp((s) => s.settings['terminal.colors']);
  const darkId = useApp((s) => s.settings['ui.themeDark']);
  const lightId = useApp((s) => s.settings['ui.themeLight']);
  const set = useSet();
  const [open, setOpen] = useState(false);
  const darkTheme = appThemeScheme(cfg, darkId, 'dark');
  const lightTheme = appThemeScheme(cfg, lightId, 'light');
  const current = resolved === 'dark' ? darkTheme : lightTheme;
  const all = [...TERMINAL_SCHEMES, ...cfg.custom];
  const dark = all.filter((s) => isDarkColor(s.colors.background));
  const light = all.filter((s) => !isDarkColor(s.colors.background));
  const system = mode === 'system';
  const pick = (s: TerminalScheme): void => {
    const isDark = isDarkColor(s.colors.background);
    set(isDark ? 'ui.themeDark' : 'ui.themeLight', s.id);
    // 固定深色 / 浅色时，选了另一种主题就切换过去；跟随系统时只记下来
    if (!system && (mode === 'dark') !== isDark) set('ui.theme', isDark ? 'dark' : 'light');
  };
  const card = (s: TerminalScheme, isDark: boolean): React.ReactNode => {
    const chosen = s.id === (isDark ? darkTheme.id : lightTheme.id);
    return (
      <ThemeCard
        key={s.id}
        s={s}
        active={chosen && (system || (resolved === 'dark') === isDark)}
        badge={system && chosen ? <span className="theme-card-badge">{isDark ? <MoonOutlined /> : <SunOutlined />}</span> : undefined}
        onPick={() => pick(s)}
      />
    );
  };
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      overlayClassName="theme-popover"
      content={
        <div className="theme-panel" data-testid="theme-panel">
          <div className="theme-group-title">深色主题</div>
          <div className="theme-grid">{dark.map((s) => card(s, true))}</div>
          <div className="theme-group-title">浅色主题</div>
          <div className="theme-grid">{light.map((s) => card(s, false))}</div>
          <div className="theme-panel-foot">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {system ? '跟随系统：深色、浅色主题各选一个，随系统自动切换' : '选另一种深浅的主题时，界面模式会跟着切换'}
            </Typography.Text>
            <Button
              size="small"
              icon={<BgColorsOutlined />}
              onClick={() => {
                setOpen(false);
                useColorsDialog.getState().show();
              }}
            >
              自定义配色…
            </Button>
          </div>
        </div>
      }
    >
      <button type="button" className={`theme-trigger ${open ? 'open' : ''}`} data-testid="theme-trigger">
        <span className="theme-trigger-icon mono" style={{ background: current.colors.background, color: current.colors.foreground }}>
          &gt;_
        </span>
        <span className="theme-trigger-name">{system ? `${darkTheme.name} / ${lightTheme.name}` : current.name}</span>
        {open ? <UpOutlined className="theme-trigger-arrow" /> : <DownOutlined className="theme-trigger-arrow" />}
      </button>
    </Popover>
  );
}

const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** 背景媒体：选择图片 / 视频，调整遮罩、模糊、填充方式 */
function BackgroundMedia(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const bg = useApp((s) => s.settings['terminal.background']);
  const scheme = useTerminalBase();
  const set = useSet();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const has = bg.kind !== 'none' && !!bg.file;
  const patch = (p: Partial<TerminalBackground>): void => set('terminal.background', { ...bg, ...p });

  const choose = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await invoke('appearance.pickBackground');
      if (!r) return;
      const { name, size, ...value } = r;
      await useApp.getState().updateSetting('terminal.background', value);
      setPicked({ name, size });
      if (value.kind === 'video' && !/\.mp4$|\.m4v$/i.test(value.file)) message.info('视频建议使用 MP4（H.264），其他格式解码开销更大');
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const clear = (): void => {
    modal.confirm({
      title: '移除终端背景？',
      okText: '移除',
      cancelText: '取消',
      onOk: async () => {
        try {
          await useApp.getState().updateSetting('terminal.background', await invoke('appearance.clearBackground'));
          setPicked(null);
        } catch (e) {
          message.error(errorMessage(e));
        }
      },
    });
  };

  return (
    <div className="bg-media" data-testid="bg-media">
      <div className="bg-media-main">
        <div className={`bg-media-thumb ${has ? 'has' : ''}`} style={{ background: has ? scheme.background : undefined }}>
          {has && bg.kind === 'image' && <img src={backgroundUrl(bg.file)} alt="" style={{ objectFit: bg.fit === 'tile' ? 'cover' : bg.fit, filter: bg.blur ? `blur(${bg.blur / 3}px)` : undefined }} data-testid="bg-thumb" />}
          {has && bg.kind === 'video' && <video src={backgroundUrl(bg.file)} muted loop autoPlay playsInline style={{ objectFit: bg.fit === 'tile' ? 'cover' : bg.fit, filter: bg.blur ? `blur(${bg.blur / 3}px)` : undefined }} data-testid="bg-thumb" />}
          {has && (
            <span className="bg-media-dim" style={{ background: scheme.background, opacity: bg.dim }}>
              <span className="mono" style={{ color: scheme.foreground }}>
                <span style={{ color: scheme.green }}>$</span> ls -la
              </span>
            </span>
          )}
          {!has && <DesktopOutlined />}
        </div>
        <div className="bg-media-actions">
          <div className="bg-media-btns">
            <Button icon={bg.kind === 'video' ? <VideoCameraOutlined /> : <PictureOutlined />} loading={busy} onClick={() => void choose()} data-testid="bg-pick">
              {has ? '更换背景' : '选择背景'}
            </Button>
            {has && (
              <Button danger onClick={clear} data-testid="bg-clear">
                移除
              </Button>
            )}
          </div>
          {has && (
            <Typography.Text type="secondary" className="bg-media-name">
              {bg.kind === 'video' ? '视频' : '图片'}
              {picked ? ` · ${picked.name} · ${fmtSize(picked.size)}` : ''}
            </Typography.Text>
          )}
        </div>
      </div>
      {has && (
        <div className="bg-media-opts">
          <div className="bg-media-opt">
            <span className="bg-media-opt-label">遮罩</span>
            <Slider min={0} max={95} value={Math.round(bg.dim * 100)} onChange={(v) => patch({ dim: v / 100 })} tooltip={{ formatter: (v) => `${v}%` }} style={{ flex: 1 }} data-testid="bg-dim" />
            <span className="bg-media-opt-val">{Math.round(bg.dim * 100)}%</span>
          </div>
          <div className="bg-media-opt">
            <span className="bg-media-opt-label">模糊</span>
            <Slider min={0} max={20} value={bg.blur} onChange={(v) => patch({ blur: v })} tooltip={{ formatter: (v) => `${v}px` }} style={{ flex: 1 }} data-testid="bg-blur" />
            <span className="bg-media-opt-val">{bg.blur}px</span>
          </div>
          <div className="bg-media-opt">
            <span className="bg-media-opt-label">填充</span>
            <Segmented
              size="small"
              value={bg.fit}
              onChange={(v) => patch({ fit: v as TerminalBackground['fit'] })}
              options={[
                { value: 'cover', label: '铺满' },
                { value: 'contain', label: '完整显示' },
                { value: 'fill', label: '拉伸' },
                ...(bg.kind === 'image' ? [{ value: 'tile', label: '平铺' }] : []),
              ]}
              data-testid="bg-fit"
            />
          </div>
        </div>
      )}
      <Typography.Text type="secondary" className="bg-media-hint">
        视频建议使用 MP4（H.264）；4K 动态 GIF / WebP 解码开销较高，可能导致卡顿。遮罩越大，背景越淡、文字越清楚。
      </Typography.Text>
    </div>
  );
}

/** 终端实际使用的配色（背景缩略图、遮罩颜色用） */
function useTerminalBase(): TerminalScheme['colors'] {
  return useTerminalScheme().colors;
}

/** 实际渲染用的字体：font-family 列表里第一个本机装了的 */
function renderedFont(value: string): string {
  const names = value.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const generic = ['monospace', 'sans-serif', 'serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont'];
  return names.find((n) => !generic.includes(n) && fontInstalled(n)) ?? '系统默认等宽字体';
}

/**
 * 设置 → 外观（第十二轮，参考 Chaterm）：主题（整个软件的配色，卡片选择）和界面字体、终端背景图片 / 视频、
 * 终端字体、本地终端环境、字号和缩放范围、光标、行高和字间距。
 */
export function AppearanceSettings(): React.JSX.Element {
  const settings = useApp((s) => s.settings);
  const set = useSet();
  const termFont = settings['terminal.fontFamily'];
  const min = settings['terminal.fontSizeMin'];
  const max = settings['terminal.fontSizeMax'];
  const terminalFollows = settings['terminal.colors'].follow !== false;
  return (
    <SettingsSection title="外观">
      <SettingGroup title="界面">
        <SettingRow
          label={<span className="row-with-icon"><BgColorsOutlined /> 主题</span>}
          description={
            <>
              整个软件的配色（侧栏、面板、文字、强调色），支持多种流行的主题风格；跟随系统时深色、浅色主题各选一个。
              <br />
              终端默认跟着主题变，也可以在
              <Typography.Link onClick={() => useApp.getState().openSettings('terminal')} data-testid="goto-terminal-colors">
                「终端 → 终端配色」
              </Typography.Link>
              里单独设置{terminalFollows ? '' : '（当前是单独设置）'}。
            </>
          }
        >
          <div className="theme-picker-row">
            <Segmented<ThemeMode>
              value={settings['ui.theme']}
              onChange={(v) => set('ui.theme', v)}
              options={[
                { label: '深色', value: 'dark' },
                { label: '浅色', value: 'light' },
                { label: '跟随系统', value: 'system' },
              ]}
              data-testid="ui-theme"
            />
            <ThemePicker />
          </div>
        </SettingRow>
        <SettingRow label="界面字体" description="菜单、列表、对话框等界面文字使用的字体">
          <FontSelect value={settings['ui.fontFamily']} fonts={UI_FONTS} fallback={UI_FALLBACK} systemOption onChange={(v) => set('ui.fontFamily', v)} testId="ui-font" />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="左侧导航">
        <SettingRow
          label="显示的页面"
          description="终端（AI 模式下切换为 AI 对话）、主机、笔记、运维审计、批量执行固定展示在最左侧常驻图标栏，设置位于左下角头像菜单；其余页面收在 ··· 更多菜单里，可按需取消勾选隐藏"
          block
        >
          <Checkbox.Group
            value={NAV_PAGES.filter((n) => n.required || !(settings['ui.navHidden'] as string[]).includes(n.key)).map((n) => n.key)}
            onChange={(v) => set('ui.navHidden', NAV_OPTIONAL.filter((k) => !(v as string[]).includes(k)))}
            options={NAV_PAGES.map((n) => ({ value: n.key, label: n.key === 'approvals' ? '审批（登录后）' : n.label, disabled: n.required }))}
            data-testid="nav-visible"
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="背景媒体">
        <SettingRow label={<span className="row-with-icon"><DesktopOutlined /> 终端背景</span>} description="为终端设置自定义图片或视频背景" block>
          <BackgroundMedia />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="终端外观">
        <SettingRow
          label="字体"
          description={
            <>
              支持手动输入；也可以点右侧箭头从本机字体中选择
              <br />
              实际渲染字体：<span data-testid="rendered-font">{renderedFont(termFont)}</span>
              {!fontInstalled(firstFamily(termFont)) && firstFamily(termFont) && <Typography.Text type="warning">（本机没有安装 {firstFamily(termFont)}）</Typography.Text>}
            </>
          }
        >
          <FontSelect value={termFont} fonts={TERMINAL_FONTS} fallback={TERMINAL_FALLBACK} onChange={(v) => set('terminal.fontFamily', v)} testId="appearance-terminal-font" />
        </SettingRow>
        <SettingRow label="本地终端环境" description="只影响本机终端：对齐系统终端（登录 shell，读取 .zshrc / .bash_profile 等，和系统终端一样）或干净终端（不读启动文件、只保留基本的环境变量）">
          <Select
            value={settings['terminal.localEnv']}
            onChange={(v) => set('terminal.localEnv', v)}
            style={{ width: 200 }}
            options={[
              { value: 'system', label: '对齐系统终端' },
              { value: 'clean', label: '干净终端' },
            ]}
            data-testid="local-env"
          />
        </SettingRow>
        <SettingRow label={<span className="row-with-icon"><FontSizeOutlined /> 字号</span>} description="默认字号；按住 Ctrl（macOS 上 ⌘）滚动滚轮缩放时，在最小和最大之间变化">
          <div className="font-size-trio">
            <label>
              <span>字号</span>
              <InputNumber min={9} max={32} value={settings['terminal.fontSize']} onChange={(v) => set('terminal.fontSize', v)} data-testid="font-size" />
            </label>
            <label>
              <span>最小</span>
              <InputNumber min={6} max={Math.min(30, max - 1)} value={min} onChange={(v) => set('terminal.fontSizeMin', v)} data-testid="font-size-min" />
            </label>
            <label>
              <span>最大</span>
              <InputNumber min={Math.max(12, min + 1)} max={72} value={max} onChange={(v) => set('terminal.fontSizeMax', v)} data-testid="font-size-max" />
            </label>
          </div>
        </SettingRow>
        <SettingRow label="光标样式">
          <Segmented
            value={settings['terminal.cursorStyle']}
            onChange={(v) => set('terminal.cursorStyle', v as Settings['terminal.cursorStyle'])}
            options={[
              { value: 'block', label: <span className="cursor-opt"><i className="block" /> 方块</span> },
              { value: 'underline', label: <span className="cursor-opt"><i className="underline" /> 下划线</span> },
              { value: 'bar', label: <span className="cursor-opt"><i className="bar" /> 竖线</span> },
            ]}
            data-testid="cursor-style"
          />
        </SettingRow>
        <SettingRow label="光标闪烁">
          <Switch checked={settings['terminal.cursorBlink']} onChange={(v) => set('terminal.cursorBlink', v)} data-testid="cursor-blink" />
        </SettingRow>
        <SettingRow label="行高" description="行与行之间的距离（倍数）">
          <div className="slider-with-value">
            <Slider min={1} max={2} step={0.05} value={settings['terminal.lineHeight']} onChange={(v) => set('terminal.lineHeight', Math.round(v * 100) / 100)} style={{ width: 180 }} data-testid="line-height" />
            <span>{settings['terminal.lineHeight'].toFixed(2)}</span>
          </div>
        </SettingRow>
        <SettingRow label="字间距" description="字符之间额外的距离（像素）">
          <InputNumber min={-2} max={10} step={0.5} value={settings['terminal.letterSpacing']} onChange={(v) => set('terminal.letterSpacing', v)} suffix="px" style={{ width: 120 }} data-testid="letter-spacing" />
        </SettingRow>
      </SettingGroup>
    </SettingsSection>
  );
}
