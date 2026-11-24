import type { Page } from '../util/nav';

interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 20 20',
  fill: 'none',
  'aria-hidden': true as const,
  className: 'rail-svg',
});

/** 终端：圆角命令行窗口 */
export function TerminalIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2.5" y="3.5" width="15" height="13" rx="3" stroke="currentColor" strokeWidth="1.55" />
      <path d="M6.2 8.2L8.9 10.4L6.2 12.6" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.8 12.6H13.8" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

/** AI 对话：现代星芒图标 */
export function AiIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path
        d="M9.6 2.8C9.9 6.3 11.7 8.1 15.2 8.4C11.7 8.7 9.9 10.5 9.6 14C9.3 10.5 7.5 8.7 4 8.4C7.5 8.1 9.3 6.3 9.6 2.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M15.1 12.6C15.25 14 16 14.75 17.4 14.9C16 15.05 15.25 15.8 15.1 17.2C14.95 15.8 14.2 15.05 12.8 14.9C14.2 14.75 14.95 14 15.1 12.6Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 主机：双层服务器节点 */
export function HostsIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3.2" width="14" height="5.6" rx="2" stroke="currentColor" strokeWidth="1.55" />
      <rect x="3" y="11.2" width="14" height="5.6" rx="2" stroke="currentColor" strokeWidth="1.55" />
      <circle cx="6.2" cy="6" r="0.9" fill="currentColor" />
      <circle cx="6.2" cy="14" r="0.9" fill="currentColor" />
      <path d="M9.5 6H13.8M9.5 14H13.8" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
    </svg>
  );
}

/** 笔记：极简文档本 */
export function NotesIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M5 3.2H12.2L15.8 6.8V15.3C15.8 16.1 15.1 16.8 14.3 16.8H5.7C4.9 16.8 4.2 16.1 4.2 15.3V4.7C4.2 3.9 4.9 3.2 5 3.2Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M12 3.4V7H15.6" stroke="currentColor" strokeWidth="1.45" strokeLinejoin="round" />
      <path d="M7.2 10.3H12.8M7.2 13.3H10.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** 审计&回放：盾牌与校验轨迹 */
export function AuditIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M10 2.6L16 5.1V9.7C16 13.4 13.5 16.3 10 17.5C6.5 16.3 4 13.4 4 9.7V5.1L10 2.6Z" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" />
      <path d="M7.4 10.1L9.2 11.9L12.8 8.3" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 定时任务：圆形时钟 + 指针 */
/** 批量执行：叠在一起的多台主机 + 闪电 */
export function BatchIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2.5" y="3" width="11" height="4.6" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2.5" y="10" width="11" height="4.6" rx="1.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5 5.3H6.6M5 12.3H6.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M16.6 6.2L14.9 9.6H17.2L15.4 13.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 数据库：经典圆柱叠层 */
export function DatabaseIcon({ size = 17 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <ellipse cx="10" cy="5.2" rx="6.2" ry="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 5.2V14.8C3.8 16.1 6.6 17.2 10 17.2C13.4 17.2 16.2 16.1 16.2 14.8V5.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 10C3.8 11.3 6.6 12.4 10 12.4C13.4 12.4 16.2 11.3 16.2 10" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** 指令集：闪电快捷命令 */
export function SnippetIcon({ size = 17 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M11.1 2.7L4.7 10.8H9.7L8.9 17.3L15.3 9.2H10.3L11.1 2.7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** 监控：心电脉冲折线 */
export function MonitorIcon({ size = 17 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M2.5 10.5H5.7L7.8 5.2L11.4 14.8L13.8 8.8L15 10.5H17.5" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 审批：圆角勾选框 */
export function ApprovalIcon({ size = 17 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="3.2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.8 10.1L9.1 12.4L13.4 7.9" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 更多：三圆点 */
export function MoreDotsIcon({ size = 18 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="5.2" cy="10" r="1.35" fill="currentColor" />
      <circle cx="10" cy="10" r="1.35" fill="currentColor" />
      <circle cx="14.8" cy="10" r="1.35" fill="currentColor" />
    </svg>
  );
}

/** 锁定：极简锁头 */
export function LockSvgIcon({ size = 17 }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="4.2" y="8.8" width="11.6" height="8" rx="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 8.8V6.6C7 4.9 8.3 3.6 10 3.6C11.7 3.6 13 4.9 13 6.6V8.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export const RAIL_PAGE_META: Record<Page, { label: string; icon: React.ReactNode }> = {
  workspace: { label: '终端', icon: <TerminalIcon /> },
  ai: { label: 'AI 对话', icon: <AiIcon /> },
  hosts: { label: '主机', icon: <HostsIcon /> },
  notes: { label: '笔记', icon: <NotesIcon /> },
  audit: { label: '运维审计', icon: <AuditIcon /> },
  batch: { label: '批量执行', icon: <BatchIcon /> },
  databases: { label: '数据库', icon: <DatabaseIcon /> },
  snippets: { label: '指令集', icon: <SnippetIcon /> },
  monitor: { label: '监控', icon: <MonitorIcon /> },
  approvals: { label: '审批', icon: <ApprovalIcon /> },
  settings: { label: '设置', icon: <MoreDotsIcon /> },
};
