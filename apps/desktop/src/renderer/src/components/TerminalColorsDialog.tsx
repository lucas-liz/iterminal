import { useEffect, useState } from 'react';
import { App, Button, ColorPicker, Input, Modal, Popconfirm, Segmented, Select, Space, Tag, Tooltip, Typography } from 'antd';
import { CopyOutlined, DeleteOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { create } from 'zustand';
import {
  isDarkColor,
  resolveTerminalScheme,
  TERMINAL_COLOR_KEYS,
  TERMINAL_COLOR_LABEL,
  TERMINAL_SCHEMES,
  type TerminalColorKey,
  type TerminalColorSettings,
  type TerminalScheme,
} from '@itm/protocol';
import { errorMessage } from '../api';
import { useApp } from '../store/app';
import { useResolvedTheme, useTerminalScheme } from '../util/theme';

export const useColorsDialog = create<{ open: boolean; show(): void; hide(): void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

const ANSI: TerminalColorKey[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const BRIGHT: TerminalColorKey[] = ['brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

/** 一排色块：背景上的 8 个常用颜色 */
export function SchemeSwatch({ s }: { s: TerminalScheme }): React.JSX.Element {
  return (
    <span className="scheme-swatch" style={{ background: s.colors.background }}>
      {(['foreground', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as TerminalColorKey[]).map((k) => (
        <i key={k} style={{ background: s.colors[k] }} />
      ))}
    </span>
  );
}

/** 用方案的颜色模拟一段终端输出 */
function Preview({ s }: { s: TerminalScheme }): React.JSX.Element {
  const c = s.colors;
  const C = ({ k, children, bold }: { k: TerminalColorKey; children: React.ReactNode; bold?: boolean }): React.JSX.Element => <span style={{ color: c[k], fontWeight: bold ? 700 : undefined }}>{children}</span>;
  return (
    <div className="scheme-preview mono" style={{ background: c.background, color: c.foreground }} data-testid="scheme-preview">
      <div>
        <C k="brightGreen" bold>
          root@web-01
        </C>
        :<C k="brightBlue">~</C># ls -l
      </div>
      <div>
        drwxr-xr-x 2 root root 4096 <C k="blue" bold>logs</C>
      </div>
      <div>
        -rwxr-xr-x 1 root root &nbsp;820 <C k="green" bold>deploy.sh</C>
      </div>
      <div>
        lrwxrwxrwx 1 root root &nbsp;&nbsp;12 <C k="cyan">current</C> -&gt; releases/v2
      </div>
      <div>
        -rw-r--r-- 1 root root 1.2G <C k="red">backup.tar.gz</C>
      </div>
      <div>
        <C k="yellow">WARN</C> &nbsp;disk usage 82% on /data
      </div>
      <div>
        <C k="brightRed" bold>ERROR</C> connection refused: <C k="magenta">10.0.0.12:3306</C>
      </div>
      <div>
        <C k="green">●</C> nginx.service - <C k="brightGreen">active (running)</C> <C k="brightBlack">since 09:30</C>
      </div>
      <div>
        <C k="brightGreen" bold>
          root@web-01
        </C>
        :<C k="brightBlue">~</C># <span style={{ background: c.selectionBackground }}>tail -n 100 app.log</span>
        <span className="scheme-cursor" style={{ background: c.cursor }} />
      </div>
      <div className="scheme-palette">
        {[ANSI, BRIGHT].map((row, i) => (
          <div key={i}>
            {row.map((k) => (
              <Tooltip key={k} title={TERMINAL_COLOR_LABEL[k]}>
                <i style={{ background: c[k] }} />
              </Tooltip>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 终端配色（第四轮）：内置方案（iTerminal 深色 / 浅色、MobaXterm、Solarized、Dracula 等）和自定义方案；
 * 深色界面、浅色界面各选一个。修改立即生效。
 */
export function TerminalColorsDialog(): React.JSX.Element {
  const { message } = App.useApp();
  const open = useColorsDialog((s) => s.open);
  const cfg = useApp((s) => s.settings['terminal.colors']);
  const update = useApp((s) => s.updateSetting);
  const mode = useResolvedTheme();
  // 终端现在用的方案（跟随应用主题时是主题配套的方案）
  const using = useTerminalScheme();
  const follow = cfg.follow !== false;
  const all = [...TERMINAL_SCHEMES, ...cfg.custom];
  const [sel, setSel] = useState<string>(() => using.id);
  useEffect(() => {
    if (open) setSel(using.id);
    // 打开时选中当前使用的方案
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // 切回跟随应用主题时，左边选中正在使用的方案
  useEffect(() => {
    if (open && follow) setSel(using.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [follow, using.id]);
  const cur = all.find((s) => s.id === sel) ?? all[0];
  const custom = cur.id.startsWith('custom-');

  const save = (next: TerminalColorSettings): void => {
    update('terminal.colors', next).catch((e) => message.error(errorMessage(e)));
  };
  const copy = (): void => {
    const id = `custom-${Date.now().toString(36)}`;
    const name = `${cur.name} 副本`.slice(0, 40);
    save({ ...cfg, custom: [...cfg.custom, { id, name, colors: { ...cur.colors } }] });
    setSel(id);
  };
  const patch = (p: Partial<TerminalScheme>): void => save({ ...cfg, custom: cfg.custom.map((s) => (s.id === cur.id ? { ...s, ...p, colors: { ...s.colors, ...(p.colors ?? {}) } } : s)) });
  const remove = (): void => {
    const next = cfg.custom.filter((s) => s.id !== cur.id);
    save({ ...cfg, custom: next, dark: cfg.dark === cur.id ? 'itm-dark' : cfg.dark, light: cfg.light === cur.id ? 'mobaxterm' : cfg.light });
    setSel(resolveTerminalScheme({ ...cfg, custom: next }, mode).id);
  };

  const usedBy = (id: string): React.ReactNode =>
    follow ? (
      id === using.id && (
        <Tag bordered={false} className="scheme-used">
          使用中
        </Tag>
      )
    ) : (
    <>
      {cfg.dark === id && (
        <Tag bordered={false} icon={<MoonOutlined />} className="scheme-used">
          深色
        </Tag>
      )}
      {cfg.light === id && (
        <Tag bordered={false} icon={<SunOutlined />} className="scheme-used">
          浅色
        </Tag>
      )}
    </>
    );

  return (
    <Modal open={open} title="终端配色" width={880} footer={null} onCancel={() => useColorsDialog.getState().hide()} destroyOnHidden className="scheme-modal">
      {/* 第十二轮：终端配色默认跟随「外观 → 主题」；选「用于深色 / 浅色界面」即改为单独设置 */}
      <div className="scheme-follow" data-testid="scheme-follow">
        <Segmented
          size="small"
          value={follow ? 'follow' : 'own'}
          onChange={(v) => save({ ...cfg, follow: v === 'follow' })}
          options={[
            { label: '跟随应用主题', value: 'follow' },
            { label: '单独设置', value: 'own' },
          ]}
          data-testid="scheme-follow-mode"
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {follow ? `终端跟着「外观 → 主题」变化，当前是「${using.name}」；点「用于深色 / 浅色界面」改为单独设置` : '终端配色和应用主题无关：深色界面、浅色界面各用一套'}
        </Typography.Text>
      </div>
      <div className="scheme-body">
        <div className="scheme-list" data-testid="scheme-list">
          {all.map((s) => (
            <button key={s.id} type="button" className={`scheme-item ${s.id === cur.id ? 'on' : ''}`} onClick={() => setSel(s.id)} data-testid={`scheme-${s.id}`}>
              <SchemeSwatch s={s} />
              <span className="scheme-name ellipsis">{s.name}</span>
              {usedBy(s.id)}
            </button>
          ))}
        </div>
        <div className="scheme-main">
          <div className="scheme-head">
            {custom ? (
              <Input
                key={cur.id}
                defaultValue={cur.name}
                maxLength={40}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== cur.name && patch({ name: e.target.value.trim() })}
                onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                style={{ width: 220 }}
                data-testid="scheme-name"
              />
            ) : (
              <Typography.Text strong>{cur.name}</Typography.Text>
            )}
            <Space style={{ marginLeft: 'auto' }}>
              <Button size="small" icon={<MoonOutlined />} type={!follow && cfg.dark === cur.id ? 'primary' : 'default'} onClick={() => save({ ...cfg, follow: false, dark: cur.id })} data-testid="scheme-use-dark">
                用于深色界面
              </Button>
              <Button size="small" icon={<SunOutlined />} type={!follow && cfg.light === cur.id ? 'primary' : 'default'} onClick={() => save({ ...cfg, follow: false, light: cur.id })} data-testid="scheme-use-light">
                用于浅色界面
              </Button>
            </Space>
          </div>
          <Preview s={cur} />
          {custom ? (
            <>
              <div className="scheme-colors" data-testid="scheme-colors">
                {TERMINAL_COLOR_KEYS.map((k) => (
                  <label key={k} className="scheme-color">
                    <ColorPicker size="small" disabledAlpha value={cur.colors[k]} onChangeComplete={(c) => patch({ colors: { ...cur.colors, [k]: c.toHexString() } })} />
                    <span>{TERMINAL_COLOR_LABEL[k]}</span>
                  </label>
                ))}
              </div>
              <Space>
                <Button size="small" icon={<CopyOutlined />} onClick={copy}>
                  复制一份
                </Button>
                <Popconfirm title={`删除配色「${cur.name}」？`} okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={remove}>
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            </>
          ) : (
            <Space>
              <Button size="small" icon={<CopyOutlined />} onClick={copy} data-testid="scheme-copy">
                复制为自定义方案
              </Button>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                内置方案不能修改，复制后可以逐个调整颜色{isDarkColor(cur.colors.background) ? '' : '（浅色背景）'}
              </Typography.Text>
            </Space>
          )}
        </div>
      </div>
    </Modal>
  );
}
