import { createContext, useContext, useMemo, useRef, useState, type ComponentProps } from 'react';
import { App, Button, Dropdown, Space, Tooltip } from 'antd';
import { CaretRightOutlined, DownOutlined, EnterOutlined, WarningFilled } from '@ant-design/icons';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CommandTestResult } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { CopyButton } from '../Markdown';
import { useAgent } from '../../store/agent';
import { useHosts } from '../../store/hosts';
import { useTabs } from '../../store/tabs';
import { defaultTarget, runInTerminal, type RunTarget } from '../../util/run-in-terminal';
import { commandOf, runnable } from '../../util/code-run';

/** SQL 工作台的对话里，SQL 代码块可以直接执行（结果显示在左边的结果区）、插入编辑器（第二十九轮） */
export interface SqlRunner {
  run(sql: string): void;
  insert(sql: string): void;
}
export const SqlRunContext = createContext<SqlRunner | null>(null);
const SQL_LANGS = new Set(['sql', 'mysql', 'postgresql', 'postgres', 'psql', 'pgsql', 'sqlite', 'plsql', 'tsql']);

const LANG_LABEL: Record<string, string> = { sql: 'SQL', mysql: 'MySQL', postgresql: 'PostgreSQL', sqlite: 'SQLite', sh: 'shell', bash: 'bash', zsh: 'zsh', shell: 'shell', console: 'shell', powershell: 'PowerShell', ps1: 'PowerShell', cmd: 'cmd', text: '文本', txt: '文本', plaintext: '文本' };
/** 回答里命令的执行目标：本轮引用的主机（和 AI 面板上方的引用一致）+「当前终端」 */
function useRunTargets(): RunTarget[] {
  const tabs = useTabs((s) => s.tabs);
  const hosts = useHosts((s) => s.hosts);
  const excluded = useAgent((s) => s.excludedTabs);
  const extra = useAgent((s) => s.extraHostIds);
  return useMemo(() => {
    const ids: string[] = [];
    for (const t of tabs) {
      if (t.kind === 'sftp' || t.status !== 'ready' || !t.hostId || excluded.includes(t.id) || ids.includes(t.hostId)) continue;
      ids.push(t.hostId);
    }
    for (const id of extra) if (!ids.includes(id)) ids.push(id);
    const out: RunTarget[] = ids.map((id) => ({ hostId: id, label: hosts.find((h) => h.id === id)?.name ?? '主机' })).filter((t) => hosts.some((h) => h.id === t.hostId));
    out.push({ hostId: null, label: '当前终端' });
    return out;
  }, [tabs, hosts, excluded, extra]);
}

/** React 节点里的文字（代码块的内容） */
function textOf(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: React.ReactNode }).children);
  return '';
}

const LEVEL_TEXT: Record<string, string> = { L1: '需注意', L2: '高危', DENY: '命中黑名单' };

/**
 * 回答里的代码块（第十五轮，参考 iShell 运维模式）：右上角显示语言、复制；shell 命令多一个「在终端运行」：
 * 引用了主机时在这台主机的终端执行（没有打开就先连接），没有引用主机时在当前终端执行（没有终端就打开本地终端）。
 * 运行前按命令安全规则判定，需注意 / 高危的命令先确认一次。
 */
function RunnableCodeBlock({ children, node: _node, ...rest }: ComponentProps<'pre'> & { node?: unknown }): React.JSX.Element {
  const { message } = App.useApp();
  const ref = useRef<HTMLPreElement>(null);
  const targets = useRunTargets();
  const [chosen, setChosen] = useState<RunTarget | null>(null);
  const [risk, setRisk] = useState<CommandTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const first = Array.isArray(children) ? children[0] : children;
  const cls = first && typeof first === 'object' && 'props' in first ? String((first.props as { className?: string }).className ?? '') : '';
  const lang = /language-([\w+#.-]+)/.exec(cls)?.[1]?.toLowerCase() ?? '';
  const raw = (): string => (ref.current?.textContent ?? '').replace(/\n$/, '');
  const target = chosen && targets.some((t) => t.hostId === chosen.hostId) ? chosen : defaultTarget(targets);
  const sqlRunner = useContext(SqlRunContext);
  const isSql = !!sqlRunner && SQL_LANGS.has(lang);
  const canRun = !isSql && runnable(textOf(children).replace(/\n$/, ''), lang);

  const exec = async (t: RunTarget): Promise<void> => {
    setRisk(null);
    setBusy(true);
    try {
      const where = await runInTerminal(commandOf(raw(), lang), t.hostId);
      message.success(`已在「${where}」执行`);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const run = async (t: RunTarget): Promise<void> => {
    setChosen(t);
    setBusy(true);
    const r = await invoke('cmdrule.test', { command: commandOf(raw(), lang) }).catch(() => null);
    setBusy(false);
    if (r && r.level !== 'L0') setRisk(r);
    else void exec(t);
  };

  const others = targets.filter((t) => t.hostId !== target.hostId);
  return (
    <div className="code-block" data-testid="code-block">
      <div className="code-block-bar">
        <span className="code-lang">{LANG_LABEL[lang] ?? (lang || '命令')}</span>
        <Space size={2} className="code-block-actions">
          <CopyButton text={() => raw()} title="复制" testId="code-copy" />
          {isSql && (
            <>
              <Tooltip title="插入到编辑器的光标处">
                <Button size="small" type="text" icon={<EnterOutlined />} onClick={() => sqlRunner.insert(raw())} data-testid="code-sql-insert" aria-label="插入编辑器" />
              </Tooltip>
              <Tooltip title="在当前查询里执行，结果显示在左边（写操作会先确认）">
                <Button size="small" type="text" className="code-run" icon={<CaretRightOutlined />} onClick={() => sqlRunner.run(raw())} data-testid="code-sql-run">
                  执行
                </Button>
              </Tooltip>
            </>
          )}
          {canRun && (
            <Space.Compact size="small">
              <Tooltip title={target.hostId ? `在 ${target.label} 的终端里执行（没有打开时先连接）` : '在当前终端执行（没有终端时打开本地终端）'}>
                <Button size="small" type="text" className="code-run" icon={<CaretRightOutlined />} loading={busy} onClick={() => void run(target)} data-testid="code-run">
                  {target.hostId ? `在 ${target.label} 运行` : '在终端运行'}
                </Button>
              </Tooltip>
              {others.length > 0 && (
                <Dropdown trigger={['click']} menu={{ items: others.map((t) => ({ key: t.hostId ?? '', label: t.hostId ? `在 ${t.label} 运行` : '在当前终端运行' })), onClick: ({ key }) => void run(targets.find((t) => (t.hostId ?? '') === key)!) }}>
                  <Button size="small" type="text" className="code-run-more" icon={<DownOutlined />} aria-label="选择在哪台主机运行" data-testid="code-run-more" />
                </Dropdown>
              )}
            </Space.Compact>
          )}
        </Space>
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
      {risk && (
        <div className={`code-run-confirm level-${risk.level}`} data-testid="code-run-confirm">
          <span className="code-run-warn">
            <WarningFilled />
            {LEVEL_TEXT[risk.level] ?? '需注意'}：{risk.reasons.slice(0, 2).join('；') || '这条命令会修改服务器'}。确认在「{target.label}」执行？
          </span>
          <Button size="small" type="primary" danger={risk.level !== 'L1'} onClick={() => void exec(target)} data-testid="code-run-ok">
            确认执行
          </Button>
          <Button size="small" onClick={() => setRisk(null)}>
            取消
          </Button>
        </div>
      )}
    </div>
  );
}

const COMPONENTS: Components = { pre: RunnableCodeBlock };

/** AI 回答（Markdown）：代码块可以复制、可以在终端运行 */
export function AnswerMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="md selectable">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
