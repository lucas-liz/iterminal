import { useEffect, useState } from 'react';
import { Button, Checkbox, Input, Tag, Tooltip, Typography } from 'antd';
import {
  CaretRightOutlined,
  CheckCircleFilled,
  CheckOutlined,
  CloseCircleFilled,
  CloudServerOutlined,
  CopyOutlined,
  DatabaseOutlined,
  ExclamationCircleFilled,
  GlobalOutlined,
  SafetyCertificateFilled,
  WarningFilled,
  LoadingOutlined,
  MinusCircleFilled,
  PauseCircleOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { AgentStep, BatchItem, RiskLevel } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { matchShortcut } from '../../util/shortcuts';
import { DbResultView } from './DbResultView';
import { QuestionCard } from './QuestionCard';

const LEVEL: Record<RiskLevel, { text: string; color: string }> = {
  L0: { text: '只读', color: 'green' },
  L1: { text: '写操作', color: 'orange' },
  L2: { text: '高危', color: 'red' },
  DENY: { text: '已禁止', color: 'default' },
};

/** 执行卡片头部的风险标签（文档一 6.15.1）：安全 / 需注意 / 高危 / 已拒绝 */
const BANNER: Record<RiskLevel, { text: string; icon: React.ReactNode }> = {
  L0: { text: '安全', icon: <SafetyCertificateFilled /> },
  L1: { text: '需注意', icon: <WarningFilled /> },
  L2: { text: '高危', icon: <ExclamationCircleFilled /> },
  DENY: { text: '已拒绝', icon: <StopOutlined /> },
};

/** 带说明的执行类工具 */
const EXPLAINED = new Set(['run_command', 'ssh_exec_batch', 'serial_send', 'sftp_write', 'schedule_task', 'note_save', 'skill_save', 'db_query', 'db_execute']);
/** 审批时可以修改的命令 / SQL（修改后按新内容重新判定） */
const EDITABLE = new Set(['run_command', 'serial_send', 'db_query', 'db_execute']);

const STATUS_TEXT: Partial<Record<AgentStep['status'], string>> = {
  running: '执行中…',
  approval: '等待批准',
  pending: '等待中',
  rejected: '已拒绝',
  error: '执行失败',
  done: '执行成功',
};

/** 只显示成功 / 失败（退出码不为 0 也算失败），不显示耗时和退出码 */
function statusText(step: AgentStep): string {
  if (step.status === 'done' && (step.exitCode ?? 0) !== 0) return '执行失败';
  return STATUS_TEXT[step.status] ?? '';
}

/** 命令块右上角的复制按钮 */
function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <Tooltip title={done ? '已复制' : '复制命令'}>
      <button
        type="button"
        className="step-copy"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
        data-testid="step-copy"
      >
        {done ? <CheckOutlined /> : <CopyOutlined />}
      </button>
    </Tooltip>
  );
}

const HOST_COLORS = ['#4da3ff', '#36cfc9', '#ff9c6e', '#b37feb', '#5cdbd3', '#ffc53d', '#ff85c0', '#95de64'];

/** 同一个编号在对话里始终用同一种颜色 */
export function hostColor(label: string): string {
  const n = Number(label.replace(/\D/g, '')) || label.length;
  return HOST_COLORS[((label.startsWith('h') ? n + 3 : label.startsWith('d') ? n + 5 : n) - 1 + HOST_COLORS.length) % HOST_COLORS.length];
}

export function HostBadge({ label, name }: { label: string; name: string }): React.JSX.Element {
  const color = hostColor(label);
  return (
    <span className="host-badge" style={{ borderColor: color, color }} data-testid={`host-badge-${label}`}>
      {/^d\d+$/.test(label) ? <DatabaseOutlined /> : <CloudServerOutlined />}
      <b>{label}</b>
      {name && <span>{name}</span>}
    </span>
  );
}

function StatusIcon({ status }: { status: AgentStep['status'] | BatchItem['status'] }): React.JSX.Element {
  switch (status) {
    case 'done':
      return <CheckCircleFilled style={{ color: '#52c41a' }} />;
    case 'error':
      return <CloseCircleFilled style={{ color: '#ff4d4f' }} />;
    case 'rejected':
    case 'skipped':
      return <MinusCircleFilled style={{ color: '#8c8c8c' }} />;
    case 'approval':
      return <PauseCircleOutlined style={{ color: '#faad14' }} />;
    case 'pending':
      return <PauseCircleOutlined style={{ color: '#8c8c8c' }} />;
    default:
      return <LoadingOutlined />;
  }
}

const TOOL_LABEL: Record<string, string> = {
  run_command: '执行命令',
  ssh_exec_batch: '批量执行',
  read_terminal: '读取终端',
  get_metrics: '读取监控',
  host_list: '查找主机',
  sftp_list: '列出目录',
  sftp_read: '读取文件',
  sftp_write: '写入文件',
  file_upload: '上传文件',
  file_download: '下载文件',
  serial_send: '串口发送',
  kb_search: '检索知识库',
  skill_load: '读取 Skill',
  mcp_call: 'MCP 工具',
  ask_user: '提问',
  memory_propose: '主机记忆',
  schedule_task: '创建定时任务',
  schedule_list: '查看定时任务',
  note_list: '查找笔记',
  note_read: '读取笔记',
  note_save: '保存笔记',
  skill_save: '保存 Skill',
  db_schema: '列出库表',
  db_describe: '查看表结构',
  db_query: '查询数据库',
  db_explain: '执行计划',
  db_execute: '修改数据库',
  web_search: '联网搜索',
  web_fetch: '读取网页',
};

/** 联网搜索的结果 / 读取的网页（第二十四轮）：标题是链接，点击用系统浏览器打开 */
function WebResults({ step }: { step: AgentStep }): React.JSX.Element {
  const results = step.web?.results ?? [];
  return (
    <div className="step-output web" data-testid="step-web">
      <div className="step-output-title">
        <GlobalOutlined />
        {step.output}
      </div>
      {results.length > 0 && (
        <ol className="web-results">
          {results.map((r, i) => (
            <li key={`${r.url}-${i}`} data-testid="web-result">
              <a href={r.url} target="_blank" rel="noreferrer" title={r.url}>
                {r.title || r.url}
              </a>
              <span className="web-result-meta">{[r.site || hostOf(r.url), r.date?.slice(0, 10)].filter(Boolean).join(' · ')}</span>
              {r.snippet && <div className="web-result-snippet">{r.snippet}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** unified diff：按行着色 */
function DiffView({ diff }: { diff: string }): React.JSX.Element {
  return (
    <pre className="diff-view mono selectable" data-testid="step-diff">
      {diff.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

export function StepCard({ step, conversationId, settled }: { step: AgentStep; conversationId: string; settled?: boolean }): React.JSX.Element {
  const [command, setCommand] = useState(step.command);
  const [confirm, setConfirm] = useState('');
  const [memory, setMemory] = useState(step.memory?.after ?? '');
  const [hosts, setHosts] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  /** 一轮对话结束后执行结果默认收起，只显示「执行结果 展开（N 行）」；点开后看完整输出（第三十一轮） */
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 二次确认（参考 iShell）：点「执行」后，需注意 / 高危的命令再确认一次 */
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setCommand(step.command), [step.command, step.approvalId]);
  useEffect(() => {
    setConfirming(false);
    setConfirm('');
  }, [step.approvalId]);
  useEffect(() => setMemory(step.memory?.after ?? ''), [step.memory?.after, step.approvalId]);
  useEffect(() => setHosts((step.batch ?? []).filter((b) => b.selected).map((b) => b.label)), [step.approvalId]);

  const waiting = step.status === 'approval' && !!step.approvalId;
  const needConfirm = !!step.confirmText;
  const canApprove = (!needConfirm || confirm.trim() === step.confirmText) && (!step.batch || hosts.length > 0);
  const editable = EDITABLE.has(step.tool);

  const respond = async (decision: 'approve' | 'reject', extra: { answer?: string } = {}): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await invoke('agent.approve', {
        id: conversationId,
        approvalId: step.approvalId!,
        decision,
        command: decision === 'approve' && editable && command.trim() !== step.command ? command : undefined,
        confirmText: needConfirm ? confirm : undefined,
        hosts: step.batch ? hosts : undefined,
        memory: step.memory && decision === 'approve' ? memory : undefined,
        ...extra,
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const lines = step.output.replace(/\n+$/, '').split('\n');
  const long = lines.length > 12;
  const isBatch = !!step.batch;
  const explained = EXPLAINED.has(step.tool);

  // ask_user：问题卡片（第二十六轮：选项列表、多选、数字键）
  if (step.question) {
    return <QuestionCard step={step} waiting={waiting} busy={busy} error={error} onAnswer={(a) => void respond('approve', { answer: a })} onSkip={() => void respond('reject')} />;
  }

  const failed = step.status === 'error' || (step.status === 'done' && (step.exitCode ?? 0) !== 0);
  const shownStatus: AgentStep['status'] = failed ? 'error' : step.status;
  // 需注意 / 高危的命令点「执行」后再确认一次；只读命令、主机记忆直接执行
  const needSecond = !step.memory && (needConfirm || step.level === 'L1' || step.level === 'L2');
  const runLabel = step.memory ? '保存记忆' : isBatch ? `执行 ${hosts.length} 台` : editable && command.trim() !== step.command ? '执行修改后的命令' : '执行';
  const onRun = (): void => {
    if (needSecond && !confirming) setConfirming(true);
    else if (canApprove) void respond('approve');
  };
  const copyText = waiting && editable ? command : step.command;

  return (
    <div className={`step-card ${waiting ? 'waiting' : ''} level-${step.level ?? 'none'} ${explained ? 'with-banner' : ''}`} data-testid="agent-step" data-status={step.status}>
      {explained ? (
        <Tooltip
          title={
            <>
              <div>{step.explanation || `${TOOL_LABEL[step.tool] ?? step.tool}（模型没有说明这条命令的作用）`}</div>
              {step.reasons.length > 0 && <div style={{ opacity: 0.75, marginTop: 4 }}>判定依据：{step.reasons.join('；')}</div>}
            </>
          }
          placement="topLeft"
          mouseEnterDelay={0.3}
        >
          <div className={`step-banner level-${step.level ?? 'none'}`} data-testid="step-banner">
            <span className="step-banner-tag">
              {step.level ? BANNER[step.level].icon : <LoadingOutlined />}
              {step.level ? BANNER[step.level].text : '判定中'}
            </span>
            <span className="step-banner-text" data-testid="step-explanation">
              {step.explanation ? `— ${step.explanation}` : `— ${TOOL_LABEL[step.tool] ?? step.tool}（模型没有说明这条命令的作用）`}
            </span>
            {step.hostLabel && !isBatch && <HostBadge label={step.hostLabel} name={step.hostName} />}
          </div>
        </Tooltip>
      ) : (
        <div className="step-head">
          {step.hostLabel && !isBatch ? <HostBadge label={step.hostLabel} name={step.hostName} /> : <Typography.Text strong style={{ fontSize: 12 }}>{step.hostName}</Typography.Text>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {TOOL_LABEL[step.tool] ?? step.tool}
          </Typography.Text>
          {step.level && (
            <Tooltip title={step.reasons.join('；')}>
              <Tag color={LEVEL[step.level].color} bordered={false} icon={step.level === 'DENY' ? <StopOutlined /> : undefined} style={{ marginLeft: 'auto', marginRight: 0 }}>
                {step.level === 'DENY' ? LEVEL.DENY.text : `${step.level} ${LEVEL[step.level].text}`}
              </Tag>
            </Tooltip>
          )}
        </div>
      )}

      {waiting && editable ? (
        <Input.TextArea
          className="mono step-command-edit"
          variant="borderless"
          autoSize={{ minRows: 1, maxRows: 8 }}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (matchShortcut(e, 'approveStep')) {
              e.preventDefault();
              onRun();
            }
          }}
          data-testid="approval-command"
        />
      ) : step.tool !== 'memory_propose' && step.command ? (
        <pre className="step-command mono selectable" data-testid="step-command">
          {step.command}
        </pre>
      ) : null}

      {step.reviewed && (
        <Typography.Text type="warning" className="step-note">
          <ExclamationCircleFilled /> {step.reviewed}
        </Typography.Text>
      )}
      {step.diff && <DiffView diff={step.diff} />}
      {step.memory && (
        <div className="step-memory">
          {step.memory.before && (
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 4 }} ellipsis={{ rows: 2, expandable: true }}>
              {`已有的 Agent 记忆：${step.memory.before.replace(/\n/g, '；')}`}
            </Typography.Paragraph>
          )}
          {step.memory.replaced && (
            <Typography.Paragraph type="secondary" delete style={{ fontSize: 12, marginBottom: 4 }} data-testid="memory-replaced">
              {step.memory.replaced}
            </Typography.Paragraph>
          )}
          {waiting ? (
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 8 }} value={memory} onChange={(e) => setMemory(e.target.value)} data-testid="memory-input" />
          ) : (
            <Typography.Paragraph style={{ fontSize: 12, marginBottom: 0 }}>
              {step.memory.auto && (
                <Tag bordered={false} color="green" style={{ marginInlineEnd: 6 }} data-testid="memory-auto">
                  已验证 · 自动记录
                </Tag>
              )}
              {step.memory.after}
            </Typography.Paragraph>
          )}
        </div>
      )}
      {step.batch && (
        <div className="step-batch" data-testid="step-batch">
          {step.batch.map((b) => (
            <div key={b.label} className="batch-row">
              {waiting ? (
                <Checkbox
                  disabled={b.status === 'skipped'}
                  checked={hosts.includes(b.label)}
                  onChange={(e) => setHosts((h) => (e.target.checked ? [...h, b.label] : h.filter((x) => x !== b.label)))}
                />
              ) : (
                <StatusIcon status={b.status} />
              )}
              <HostBadge label={b.label} name={b.hostName} />
              {b.level && <Tag color={LEVEL[b.level].color} bordered={false}>{b.level === 'DENY' ? '已禁止' : b.level}</Tag>}
              {b.command ? (
                // Skill 并行执行：每台主机的命令不同
                <Tooltip title={b.reasons.join('；')}>
                  <code className="batch-cmd mono" data-testid="batch-command">
                    {b.command}
                  </code>
                </Tooltip>
              ) : (
                <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, flex: 1 }}>
                  {b.status === 'skipped' || b.status === 'pending' ? b.reasons.join('；') || b.output : b.status === 'running' ? '执行中…' : ''}
                </Typography.Text>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 底栏（参考 iShell）：左边是状态，右边是复制；等待批准时是「执行」，需注意 / 高危的再确认一次 */}
      {waiting && confirming ? (
        <div className={`step-foot confirm level-${step.level ?? 'none'}`} data-testid="step-confirm">
          <span className="step-foot-warn">
            <WarningFilled />
            {step.level === 'L2' ? '高危命令，可能造成不可恢复的影响，确认执行？' : '此命令存在潜在风险，确认执行？'}
          </span>
          {needConfirm && (
            <Input
              size="small"
              className="step-confirm-input"
              placeholder={`输入「${step.confirmText}」确认`}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onPressEnter={() => canApprove && void respond('approve')}
              status={confirm && !canApprove ? 'error' : undefined}
              autoFocus
              data-testid="approval-confirm"
            />
          )}
          <Button size="small" type="primary" danger={step.level === 'L2'} className="step-run-btn" disabled={!canApprove} loading={busy} onClick={() => void respond('approve')} data-testid="approve-confirm">
            确认执行
          </Button>
          <Button size="small" className="step-cancel-btn" disabled={busy} onClick={() => setConfirming(false)} data-testid="approve-cancel">
            取消
          </Button>
        </div>
      ) : waiting ? (
        <div className="step-foot">
          <span className="step-foot-status">
            <span className="step-icon" data-testid="step-icon" data-status="approval">
              <StatusIcon status="approval" />
            </span>
            <span data-testid="step-status">{step.memory ? '等待你确认' : '等待你执行'}</span>
            {step.expiresAt && <Countdown until={step.expiresAt} />}
            {step.level && step.level !== 'L0' && !step.reviewed && step.reasons.length > 0 && (
              <Tooltip title={step.reasons.join('；')}>
                <Typography.Text type="secondary" ellipsis className="step-foot-reason">
                  {step.reasons.join('；')}
                </Typography.Text>
              </Tooltip>
            )}
          </span>
          <Button size="small" type="text" className="step-reject-btn" disabled={busy} onClick={() => void respond('reject')} data-testid="reject">
            {step.memory ? '不保存' : '拒绝'}
          </Button>
          {!step.memory && copyText && <CopyButton text={copyText} />}
          <Tooltip title={step.memory ? undefined : '⌘ / Ctrl + Enter'}>
            <Button size="small" type="primary" className={`step-run-btn level-${step.level ?? 'none'}`} icon={step.memory ? undefined : <CaretRightOutlined />} disabled={!step.batch ? false : hosts.length === 0} loading={busy && !needSecond} onClick={onRun} data-testid="approve">
              {runLabel}
            </Button>
          </Tooltip>
        </div>
      ) : (
        <div className={`step-foot status-${shownStatus}`}>
          <span className="step-foot-status">
            <span className="step-icon" data-testid="step-icon" data-status={shownStatus} aria-label={statusText(step)}>
              <StatusIcon status={shownStatus} />
            </span>
            {shownStatus === 'done' ? (
              <span>{step.memory ? '已记录' : '已执行'}</span>
            ) : shownStatus === 'error' ? (
              <span>执行失败{step.exitCode !== null && step.exitCode !== undefined && step.exitCode !== 0 ? `（退出码 ${step.exitCode}）` : ''}</span>
            ) : (
              <span data-testid="step-status">{statusText(step)}</span>
            )}
          </span>
          {step.command && step.tool !== 'memory_propose' && <CopyButton text={step.command} />}
        </div>
      )}
      {error && <Typography.Text type="danger" className="step-note">{error}</Typography.Text>}

      {step.web && step.status === 'done' ? (
        <WebResults step={step} />
      ) : step.table && step.status === 'done' ? (
        <div className="step-output db" data-testid="step-output">
          <DbResultView table={step.table} summary={step.output} name={step.hostName || '数据库'} />
        </div>
      ) : step.output && step.status !== 'approval' && !step.question && (settled && step.status !== 'rejected' ? (
        <div className={`step-output ${failed ? 'failed' : ''} ${opened ? '' : 'folded'}`} data-testid="step-output" data-folded={opened ? '0' : '1'}>
          <div className="step-output-title">
            <SafetyCertificateFilled />
            执行结果
            <Button type="link" size="small" onClick={() => setOpened((v) => !v)} data-testid="step-output-toggle">
              {opened ? '收起' : `展开（${lines.length} 行）`}
            </Button>
          </div>
          {opened && (
            <pre className="mono selectable" style={{ maxHeight: 480 }}>
              {step.output}
            </pre>
          )}
        </div>
      ) : (
        <div className={`step-output ${failed ? 'failed' : ''}`} data-testid="step-output">
          <div className="step-output-title">
            <SafetyCertificateFilled />
            {step.status === 'rejected' ? '原因' : '执行结果'}
            {long && (
              <Button type="link" size="small" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '收起' : `展开（${lines.length} 行）`}
              </Button>
            )}
          </div>
          <pre className="mono selectable" style={{ maxHeight: expanded ? 480 : 220 }}>
            {step.output}
          </pre>
        </div>
      ))}
    </div>
  );
}

/** 自动跳过的倒计时（不确定的主机记忆 10 秒没有回应就不保存，第二十八轮） */
function Countdown({ until }: { until: number }): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((until - now) / 1000));
  return (
    <Typography.Text type="secondary" className="step-countdown" data-testid="step-countdown">
      {`${left} 秒后跳过，不保存`}
    </Typography.Text>
  );
}
