import { useEffect, useState } from 'react';
import { App, Button, ColorPicker, Input, InputNumber, Segmented, Select, Space, Switch, Typography } from 'antd';
import { BgColorsOutlined, CodeOutlined, DashboardOutlined, HighlightOutlined, LinkOutlined, MoonOutlined, SaveOutlined, SearchOutlined, SunOutlined } from '@ant-design/icons';
import { TERMINAL_SCHEMES, type MonitorConfig, type SearchColors, type Settings, type SuggestSettings, type TerminalMouseSettings } from '@itm/protocol';
import { SchemeSwatch, useColorsDialog } from '../../components/TerminalColorsDialog';
import { errorMessage, isMac } from '../../api';
import { useApp } from '../../store/app';
import { useHighlightDialog } from '../../components/HighlightDialog';
import { FontSelect, TERMINAL_FALLBACK, TERMINAL_FONTS } from './FontSelect';
import { SettingGroup, SettingRow, SettingsSection } from './parts';
import { useSettingsFocus } from './search-index';
import { useTerminalScheme } from '../../util/theme';
import { useAiAllowed } from '../../util/ai-access';
import { SUGGEST_TOTAL } from '../../util/command-library';

type Cat = 'display' | 'connect' | 'smart' | 'monitor';

const CATS: { key: Cat; title: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'display', title: '基础与显示', desc: '字体、字号、回滚行数、输出高亮', icon: <CodeOutlined /> },
  { key: 'connect', title: '连接', desc: '连接超时与自动重试', icon: <LinkOutlined /> },
  { key: 'smart', title: '搜索与智能', desc: '搜索高亮、高亮性能、命令提示、AI 辅助', icon: <SearchOutlined /> },
  { key: 'monitor', title: '监控', desc: '远程采集开关、分区和网卡过滤', icon: <DashboardOutlined /> },
];

function useSet(): <K extends keyof Settings>(key: K, value: Settings[K] | null) => void {
  const { message } = App.useApp();
  const update = useApp((s) => s.updateSetting);
  return (key, value) => {
    if (value === null || value === undefined) return;
    update(key, value).catch((e) => message.error(errorMessage(e)));
  };
}

/** 深色 / 浅色界面使用的终端配色 */
function SchemeSelect({ mode }: { mode: 'dark' | 'light' }): React.JSX.Element {
  const cfg = useApp((s) => s.settings['terminal.colors']);
  const set = useSet();
  return (
    <Select
      value={cfg[mode]}
      onChange={(v) => set('terminal.colors', { ...cfg, [mode]: v })}
      style={{ width: 250 }}
      popupMatchSelectWidth={false}
      prefix={mode === 'dark' ? <MoonOutlined /> : <SunOutlined />}
      options={[...TERMINAL_SCHEMES, ...cfg.custom].map((s) => ({
        value: s.id,
        label: (
          <span className="scheme-option">
            <SchemeSwatch s={s} />
            {s.name}
          </span>
        ),
      }))}
      data-testid={`terminal-scheme-${mode}`}
    />
  );
}

/**
 * 终端配色（第十二轮）：默认跟随「外观 → 主题」（整个软件一起换配色；iTerminal 浅色主题的终端是 MobaXterm 风格）；
 * 单独设置时深色界面、浅色界面各选一个方案，和应用主题无关。
 */
function TerminalColorsRow(): React.JSX.Element {
  const cfg = useApp((s) => s.settings['terminal.colors']);
  const set = useSet();
  const follow = cfg.follow !== false;
  const current = useTerminalScheme();
  return (
    <SettingRow
      label="终端配色"
      block={!follow}
      description={
        follow ? (
          <>
            跟随
            <Typography.Link onClick={() => useApp.getState().openSettings('appearance')}>「外观 → 主题」</Typography.Link>
            ：换主题时终端一起换。当前终端用的是「{current.name}」
          </>
        ) : (
          '和应用主题无关：深色界面和浅色界面各用一套终端配色；可以复制内置方案后自己调整颜色'
        )
      }
    >
      <div className="terminal-colors-row">
        <Segmented
          value={follow ? 'follow' : 'own'}
          onChange={(v) => set('terminal.colors', { ...cfg, follow: v === 'follow' })}
          options={[
            { label: '跟随应用主题', value: 'follow' },
            { label: '单独设置', value: 'own' },
          ]}
          data-testid="terminal-colors-mode"
        />
        {!follow && (
          <>
            <SchemeSelect mode="dark" />
            <SchemeSelect mode="light" />
          </>
        )}
        <Button size="small" icon={<BgColorsOutlined />} onClick={() => useColorsDialog.getState().show()} data-testid="terminal-colors-open">
          配色方案…
        </Button>
      </div>
    </SettingRow>
  );
}

/** 颜色选择（十六进制） */
function Color({ value, onChange, testId }: { value: string; onChange(v: string): void; testId?: string }): React.JSX.Element {
  return <ColorPicker size="small" value={value} disabledAlpha showText onChangeComplete={(c) => onChange(c.toHexString())} data-testid={testId} />;
}

/** 文本框 + 保存按钮（挂载点、网卡这类列表，输入完再保存） */
function SaveInput({ value, placeholder, onSave, testId }: { value: string; placeholder: string; onSave(v: string): void; testId?: string }): React.JSX.Element {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <Space.Compact style={{ width: '100%' }}>
      <Input value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onPressEnter={() => onSave(v.trim())} data-testid={testId} />
      <Button type="primary" icon={<SaveOutlined />} disabled={v.trim() === value} onClick={() => onSave(v.trim())}>
        保存
      </Button>
    </Space.Compact>
  );
}

/**
 * 设置 → 终端（参考 iShell 的分类卡片）：基础与显示、连接、搜索与智能、监控。
 */
export function TerminalSettings(): React.JSX.Element {
  const settings = useApp((s) => s.settings);
  const set = useSet();
  // 搜索设置时切到对应的分类
  const focusCat = useSettingsFocus((s) => (s.target?.section === 'terminal' ? s.target : null));
  const [cat, setCat] = useState<Cat>(focusCat?.cat ?? 'display');
  useEffect(() => {
    if (focusCat?.cat) setCat(focusCat.cat);
  }, [focusCat?.seq]);
  const hl = settings['terminal.highlight'];
  const sg = settings['terminal.suggest'];
  const sc = settings['terminal.search'];
  const mc = settings['monitor.config'];
  const setSg = (p: Partial<SuggestSettings>): void => set('terminal.suggest', { ...sg, ...p });
  const ms = settings['terminal.mouse'];
  const setMs = (p: Partial<TerminalMouseSettings>): void => set('terminal.mouse', { ...ms, ...p });
  const setSc = (p: Partial<SearchColors>): void => set('terminal.search', { ...sc, ...p });
  const setMc = (p: Partial<MonitorConfig>): void => set('monitor.config', { ...mc, ...p });
  const aiAllowed = useAiAllowed();

  return (
    <SettingsSection title="终端">
      <div className="settings-cats" role="tablist">
        {CATS.map((c) => (
          <button key={c.key} type="button" role="tab" aria-selected={cat === c.key} className={`settings-cat ${cat === c.key ? 'on' : ''}`} title={c.desc} onClick={() => setCat(c.key)} data-testid={`term-cat-${c.key}`}>
            <span className="settings-cat-title">
              {c.icon} {c.title}
            </span>
            <span className="settings-cat-desc">{c.desc}</span>
          </button>
        ))}
      </div>

      {cat === 'display' && (
        <SettingGroup title="显示">
          <SettingRow label="字号">
            <InputNumber min={9} max={32} value={settings['terminal.fontSize']} onChange={(v) => set('terminal.fontSize', v)} style={{ width: 120 }} suffix="px" />
          </SettingRow>
          <SettingRow label="字体" description="选择常用的等宽字体，也可以直接输入本机装的其他字体；缺字时自动用后备字体（含中文）">
            <FontSelect value={settings['terminal.fontFamily']} fonts={TERMINAL_FONTS} fallback={TERMINAL_FALLBACK} onChange={(v) => set('terminal.fontFamily', v)} testId="terminal-font" />
          </SettingRow>
          <TerminalColorsRow />
          <SettingRow label="回滚行数" description="每个终端在内存里保留的历史行数">
            <InputNumber min={500} max={100000} step={1000} value={settings['terminal.scrollback']} onChange={(v) => set('terminal.scrollback', v)} style={{ width: 120 }} />
          </SettingRow>
          <SettingRow label="输出高亮" description="给 IP、URL、日期、错误 / 警告等关键字上色">
            <Space>
              <Switch checked={hl.enabled} onChange={(v) => set('terminal.highlight', { ...hl, enabled: v })} data-testid="highlight-switch" />
              <Button size="small" icon={<HighlightOutlined />} onClick={() => useHighlightDialog.getState().show()} data-testid="highlight-open">
                高亮设置…
              </Button>
            </Space>
          </SettingRow>
        </SettingGroup>
      )}
      {cat === 'display' && (
        <SettingGroup title="鼠标与剪贴板（和 MobaXterm 一样）">
          <SettingRow label="选中即复制" description="在终端里选中文字后自动复制到剪贴板">
            <Switch checked={ms.copyOnSelect} onChange={(v) => setMs({ copyOnSelect: v })} data-testid="mouse-copy-on-select" />
          </SettingRow>
          <SettingRow label="中键粘贴" description="按下鼠标滚轮粘贴剪贴板里的内容">
            <Switch checked={ms.middlePaste} onChange={(v) => setMs({ middlePaste: v })} data-testid="mouse-middle-paste" />
          </SettingRow>
          <SettingRow
            label="右键粘贴"
            description={`右键单击粘贴剪贴板里的内容；长按右键（约半秒）或按住 ${isMac ? 'Ctrl / ⌘' : 'Ctrl'} 再右键打开右键菜单。关闭后右键直接打开菜单。vim、htop 等开启了鼠标的全屏程序里，中键和右键交给程序（按住 Shift 仍然粘贴）`}
          >
            <Switch checked={ms.rightPaste} onChange={(v) => setMs({ rightPaste: v })} data-testid="mouse-right-paste" />
          </SettingRow>
        </SettingGroup>
      )}

      {cat === 'connect' && (
        <SettingGroup title="连接">
          <SettingRow label="连接超时" description="TCP 连接和 SSH 握手各自的等待时间">
            <InputNumber min={3} max={120} value={settings['terminal.connectTimeoutSec']} onChange={(v) => set('terminal.connectTimeoutSec', v)} addonAfter="秒" style={{ width: 120 }} data-testid="setting-connect-timeout" />
          </SettingRow>
          <SettingRow label="自动重试" description="TCP 超时、连接被拒、握手超时时自动重试，间隔 400ms、800ms…；认证失败和指纹不一致不重试">
            <InputNumber min={0} max={5} value={settings['terminal.connectRetries']} onChange={(v) => set('terminal.connectRetries', v)} addonAfter="次" style={{ width: 120 }} data-testid="setting-connect-retries" />
          </SettingRow>
        </SettingGroup>
      )}

      {cat === 'smart' && (
        <>
          <SettingGroup title="搜索高亮（⌘F / Ctrl+Shift+F）">
            <SettingRow label="命中背景">
              <Color value={sc.matchBg} onChange={(v) => setSc({ matchBg: v })} testId="search-match-bg" />
            </SettingRow>
            <SettingRow label="命中边框">
              <Color value={sc.matchBorder} onChange={(v) => setSc({ matchBorder: v })} />
            </SettingRow>
            <SettingRow label="概览标尺" description="滚动条旁边标出命中位置">
              <Color value={sc.matchRuler} onChange={(v) => setSc({ matchRuler: v })} />
            </SettingRow>
            <SettingRow label="当前命中背景">
              <Color value={sc.activeBg} onChange={(v) => setSc({ activeBg: v })} />
            </SettingRow>
            <SettingRow label="当前命中边框">
              <Color value={sc.activeBorder} onChange={(v) => setSc({ activeBorder: v })} />
            </SettingRow>
            <SettingRow label="当前概览标尺">
              <Color value={sc.activeRuler} onChange={(v) => setSc({ activeRuler: v })} />
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="高亮性能">
            <SettingRow label="单段最大长度" description="一次输出超过这么多字符时不做关键词高亮（大量输出时保持流畅）">
              <InputNumber min={1000} max={4000000} step={10000} value={hl.maxRun ?? 262144} onChange={(v) => v && set('terminal.highlight', { ...hl, maxRun: v })} style={{ width: 140 }} />
            </SettingRow>
            <SettingRow label="备用缓冲区跳过高亮" description="在 vim / less / top 等全屏程序里不做关键词高亮">
              <Switch checked={hl.skipAltScreen ?? true} onChange={(v) => set('terminal.highlight', { ...hl, skipAltScreen: v })} />
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="命令提示">
            <SettingRow label="智能提示" description="输入停顿 1 秒后先列出常用命令（带中文说明）和快捷命令，后面是这台主机的历史命令；↑↓ 选择、回车补全、Esc 关闭，Tab 留给 shell 补全；不请求 AI">
              <Switch checked={sg.enabled} onChange={(v) => setSg({ enabled: v })} data-testid="suggest-switch" />
            </SettingRow>
            <SettingRow label="触发最小字符数">
              <InputNumber min={1} max={10} value={sg.minChars} onChange={(v) => v && setSg({ minChars: v })} style={{ width: 120 }} disabled={!sg.enabled} />
            </SettingRow>
            <SettingRow label="每页显示条数" description={`超出的向下滚动查看，最多 ${SUGGEST_TOTAL} 条`}>
              <InputNumber min={1} max={30} value={sg.maxItems} onChange={(v) => v && setSg({ maxItems: v })} style={{ width: 120 }} disabled={!sg.enabled} />
            </SettingRow>
            <SettingRow label="显示历史命令" description="在常用命令后面列出这台主机执行过的命令">
              <Switch checked={sg.history} onChange={(v) => setSg({ history: v })} disabled={!sg.enabled} />
            </SettingRow>
            <SettingRow label="显示命令库" description="从内置的常用命令库提供建议（带中文说明）">
              <Switch checked={sg.library} onChange={(v) => setSg({ library: v })} disabled={!sg.enabled} />
            </SettingRow>
            <SettingRow label="显示快捷命令" description="从指令集中提供建议">
              <Switch checked={sg.snippets} onChange={(v) => setSg({ snippets: v })} disabled={!sg.enabled} />
            </SettingRow>
            <SettingRow label="串口命令提示" description="串口会话也显示命令提示">
              <Switch checked={sg.serial} onChange={(v) => setSg({ serial: v })} disabled={!sg.enabled} />
            </SettingRow>
          </SettingGroup>
          <SettingGroup title={aiAllowed ? 'AI 辅助' : 'AI 辅助（登录后可用）'}>
            <div className={aiAllowed ? undefined : 'ai-greyed'}>
            <SettingRow label="行内补全" description="输入停顿时用灰色显示历史命令的后半截，按 → 接受（Tab 留给 shell 补全；显示命令提示列表时不显示）">
              <Segmented
                value={settings['ai.inlineCompletion']}
                onChange={(v) => set('ai.inlineCompletion', v as Settings['ai.inlineCompletion'])}
                options={[
                  { label: '关闭', value: 'off' },
                  { label: '历史命令', value: 'local' },
                  { label: '历史 + AI', value: 'ai' },
                ]}
              />
            </SettingRow>
            <SettingRow label="# 问 AI" description="在终端行首输入 # 开头的问题，回车后发给 AI，不会发送到服务器">
              <Switch checked={settings['ai.hashAsk']} onChange={(v) => set('ai.hashAsk', v)} />
            </SettingRow>
            </div>
          </SettingGroup>
        </>
      )}

      {cat === 'monitor' && (
        <SettingGroup title="系统监控">
          <SettingRow label="启用 SSH 远程工具" description="关闭后不再在服务器上运行监控采集和终端目录跟随，适合堡垒机等受限环境（文件面板仍可使用）">
            <Switch checked={mc.enabled} onChange={(v) => setMc({ enabled: v })} data-testid="monitor-enabled" />
          </SettingRow>
          <SettingRow label="隐藏特殊分区" description="默认隐藏 EFI、/run、/snap 等伪文件系统和很小的分区，避免误导">
            <Switch checked={mc.hideSpecialFs} onChange={(v) => setMc({ hideSpecialFs: v })} />
          </SettingRow>
          <SettingRow label="隐藏 Docker 相关分区" description="默认隐藏 /var/lib/docker、/var/lib/kubelet 等挂载点">
            <Switch checked={mc.hideDockerFs} onChange={(v) => setMc({ hideDockerFs: v })} />
          </SettingRow>
          <SettingRow label="仅监测指定挂载点" description="留空表示不过滤；多个用空格 / 逗号 / 分号分隔（例如：/ /home）" block>
            <SaveInput value={mc.mounts} placeholder="例如：/ /home" onSave={(v) => setMc({ mounts: v })} testId="monitor-mounts" />
          </SettingRow>
          <SettingRow label="隐藏 Docker / 虚拟网卡" description="默认隐藏 docker0、br-、veth、cni、flannel 等虚拟接口，减少噪声">
            <Switch checked={mc.hideVirtualNics} onChange={(v) => setMc({ hideVirtualNics: v })} />
          </SettingRow>
          <SettingRow label="仅监测指定网卡" description="留空表示不过滤；多个用空格 / 逗号 / 分号分隔（例如：eth0;wlan0）" block>
            <SaveInput value={mc.nics} placeholder="例如：eth0;wlan0" onSave={(v) => setMc({ nics: v })} testId="monitor-nics" />
          </SettingRow>
        </SettingGroup>
      )}
    </SettingsSection>
  );
}
