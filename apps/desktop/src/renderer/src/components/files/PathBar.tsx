import { useEffect, useRef, useState } from 'react';
import { Button, Dropdown, Input, Tooltip } from 'antd';
import { CheckOutlined, ClockCircleOutlined, CodeOutlined, RightOutlined } from '@ant-design/icons';

/** 最近访问的目录（参考 MobaXterm 路径框的下拉历史）：点一项跳过去 */
function HistoryButton({ path, history, onNavigate, onClear }: { path: string; history: string[]; onNavigate(p: string): void; onClear(): void }): React.JSX.Element {
  return (
    <Dropdown
      trigger={['click']}
      disabled={history.length === 0}
      menu={{
        style: { maxHeight: 380, overflowY: 'auto' },
        items: [
          ...history.map((p) => ({
            key: p,
            icon: p === path ? <CheckOutlined /> : <span className="fp-menu-blank" />,
            label: (
              <span className="mono fp-history-item" title={p}>
                {p}
              </span>
            ),
          })),
          { type: 'divider' as const },
          { key: '__clear', label: '清除历史记录', danger: true },
        ],
        onClick: ({ key }) => (key === '__clear' ? onClear() : key !== path && onNavigate(key)),
      }}
    >
      <Tooltip title={history.length ? '最近访问的目录' : '还没有访问记录'}>
        <Button size="small" type="text" icon={<ClockCircleOutlined />} className="fp-history-btn" data-testid="fp-history" aria-label="最近访问的目录" />
      </Tooltip>
    </Dropdown>
  );
}

/** 在终端里进入这个目录（cd） */
function CdButton({ path, onClick }: { path: string; onClick(): void }): React.JSX.Element {
  return (
    <Tooltip
      title={
        <div className="fp-cd-tip">
          <div>在终端中进入此目录</div>
          <div className="mono">cd {path}</div>
        </div>
      }
    >
      <Button size="small" type="text" icon={<CodeOutlined />} className="fp-cd-btn" onMouseDown={(e) => e.preventDefault()} onClick={onClick} data-testid="fp-cd-here" aria-label="在终端中进入此目录" />
    </Tooltip>
  );
}

/**
 * 完整路径栏（第十六轮，参考 iShell / MobaXterm）：平时显示可以点的面包屑，点空白处变成输入框（全选完整路径），回车跳转、Esc 取消；
 * 路径框最后的终端按钮在终端里 cd 到这个目录；右边的时钟按钮列出这台主机最近访问的目录。路径太长时前面的段折叠，滚动到最右。
 */
export function PathBar({
  path,
  onNavigate,
  history = [],
  onClearHistory,
  onTerminalCd,
}: {
  path: string;
  onNavigate(p: string): void;
  history?: string[];
  onClearHistory?(): void;
  /** 在终端里进入当前目录；不给时不显示按钮（例如 FTP） */
  onTerminalCd?(): void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);
  const crumbs = useRef<HTMLDivElement>(null);
  useEffect(() => setValue(path), [path]);
  useEffect(() => {
    if (crumbs.current) crumbs.current.scrollLeft = crumbs.current.scrollWidth;
  }, [path, editing]);
  const parts = path.split('/').filter(Boolean);
  const historyBtn = (
    <>
      {onTerminalCd && <CdButton path={path} onClick={onTerminalCd} />}
      <HistoryButton path={path} history={history} onNavigate={onNavigate} onClear={() => onClearHistory?.()} />
    </>
  );
  if (editing) {
    return (
      <>
        <Input
          size="small"
          className="mono fp-path-input"
          autoFocus
          value={value}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setValue(path);
              setEditing(false);
            }
          }}
          onPressEnter={() => {
            setEditing(false);
            const v = value.trim();
            if (v && v !== path) onNavigate(v);
          }}
          data-testid="file-panel-path"
        />
        {historyBtn}
      </>
    );
  }
  return (
    <>
      <div className="fp-path" ref={crumbs} onClick={() => setEditing(true)} title={`${path}（点击编辑路径）`} data-testid="file-panel-pathbar">
        <span
          className="fp-crumb"
          onClick={(e) => {
            e.stopPropagation();
            onNavigate('/');
          }}
        >
          /
        </span>
        {parts.map((p, i) => (
          <span key={i} className="fp-crumb-wrap">
            {i > 0 && <RightOutlined className="fp-crumb-sep" />}
            <span
              className={`fp-crumb ${i === parts.length - 1 ? 'last' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                onNavigate(`/${parts.slice(0, i + 1).join('/')}`);
              }}
            >
              {p}
            </span>
          </span>
        ))}
        {/* 末尾留一块空白：路径再长也有地方点了进入编辑 */}
        <span className="fp-path-tail" data-testid="file-panel-path-edit" />
        {/* 测试和读屏用：完整路径 */}
        <input type="hidden" value={path} readOnly data-testid="file-panel-path" />
      </div>
      {historyBtn}
    </>
  );
}
