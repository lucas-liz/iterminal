import { createHmac } from 'node:crypto';
import { classifySql } from '@itm/approval';
import type { Masker } from '@itm/masking';
import { DEFAULT_SQL_REPORT, REPORT_WEBHOOK_KINDS, type LocalTask, type ReportWebhook, type SqlReportOptions } from '@itm/protocol';
import { UserError } from '../../util/errors';
import type { DbService } from '../database/db-service';
import { describeDbError } from '../database/drivers';
import { cellText, columnKind, dialectOf, tableForModel, toTable } from '../database/db-tools';

/** 查询最多读取的行数（报表里只列出 maxRows 行，这里用来统计「共 N 行」） */
const QUERY_ROWS = 1000;
const MAX_WEBHOOKS = 10;
/** 报表里每个单元格最多 100 个字符 */
const REPORT_CELL = 100;
/** 企业微信 Markdown 最多 4096 字节，钉钉约 20000 字节 */
const WECOM_BYTES = 4000;
const DINGTALK_BYTES = 18_000;

export interface ReportMessage {
  title: string;
  /** 钉钉 / 飞书用的 Markdown（带表格） */
  markdown: string;
  /** 企业微信 / 系统通知用的纯文本（每行「列：值」） */
  text: string;
  /** 通用 Webhook 的结构化内容 */
  data: Record<string, unknown>;
}

/** 检查并整理报表设置（保存定时任务时） */
export function normalizeReport(r: Partial<SqlReportOptions> | null | undefined): SqlReportOptions {
  const v = { ...DEFAULT_SQL_REPORT, ...(r ?? {}) };
  const maxRows = Number(v.maxRows);
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 200) throw new UserError('报表里的行数必须在 1–200 之间');
  const webhooks = (Array.isArray(v.webhooks) ? v.webhooks : []).map(normalizeWebhook);
  if (webhooks.length > MAX_WEBHOOKS) throw new UserError(`最多 ${MAX_WEBHOOKS} 个机器人 / Webhook`);
  return { when: v.when === 'ROWS' ? 'ROWS' : 'ALWAYS', maxRows, aiSummary: !!v.aiSummary, maskColumns: v.maskColumns !== false, systemNotify: v.systemNotify !== false, webhooks };
}

export function normalizeWebhook(w: Partial<ReportWebhook>): ReportWebhook {
  const kind = REPORT_WEBHOOK_KINDS.some((k) => k.value === w?.kind) ? w.kind! : null;
  if (!kind) throw new UserError('机器人类型不正确');
  const url = String(w.url ?? '').trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UserError(`地址不正确：${url || '（空）'}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UserError('机器人地址只支持 http / https');
  if (url.length > 2000) throw new UserError('机器人地址太长');
  const secret = String(w.secret ?? '').trim() || null;
  if (secret && secret.length > 500) throw new UserError('密钥太长');
  return { kind, url, secret, name: String(w.name ?? '').trim().slice(0, 40) || null };
}

const clipCell = (s: string): string => (s.length > REPORT_CELL ? `${s.slice(0, REPORT_CELL)}…` : s);

/** 发出去的单元格：按列名脱敏（开启时）、NULL、换行和竖线 */
function cellOut(v: string | null, kind: 'secret' | 'pii' | null): string {
  if (v === null) return 'NULL';
  if (kind === 'secret') return '****';
  if (kind === 'pii') return '[PII]';
  return clipCell(v.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|'));
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
function clipBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let out = s;
  while (bytes(out) > max - 20) out = out.slice(0, Math.floor(out.length * 0.9));
  return `${out}\n…（内容太长，已截断）`;
}

/** 报表消息：标题、时间、数据库、行数、AI 总结、结果表格 */
export function buildReport(o: {
  task: Pick<LocalTask, 'name' | 'command'>;
  dbName: string;
  database: string;
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
  report: SqlReportOptions;
  summary: string | null;
  at: number;
}): ReportMessage {
  const kinds = o.columns.map((c) => (o.report.maskColumns ? columnKind(c) : null));
  const shown = o.rows.slice(0, o.report.maxRows);
  const total = `${o.rows.length}${o.truncated ? '+' : ''}`;
  const time = new Date(o.at).toLocaleString('zh-CN', { hour12: false });
  const title = `【SQL 报表】${o.task.name}`;
  const where = `${o.dbName}${o.database ? ` / ${o.database}` : ''}`;
  const more = o.rows.length > shown.length ? `共 ${total} 行，只列出前 ${shown.length} 行` : `共 ${total} 行`;
  const md: string[] = [`### ${title}`, `- 时间：${time}`, `- 数据库：${where}`, `- 结果：${more}`];
  const tx: string[] = [title, `时间：${time}`, `数据库：${where}`, `结果：${more}`];
  if (o.summary) {
    md.push('', `**AI 总结**：${o.summary}`);
    tx.push('', `AI 总结：${o.summary}`);
  }
  if (o.columns.length && shown.length) {
    md.push('', `| ${o.columns.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`, `| ${o.columns.map(() => '---').join(' | ')} |`);
    for (const r of shown) md.push(`| ${r.map((v, i) => cellOut(v, kinds[i])).join(' | ')} |`);
    tx.push('');
    shown.forEach((r, n) => tx.push(`${n + 1}. ${r.map((v, i) => `${o.columns[i]}：${cellOut(v, kinds[i])}`).join('，')}`));
  } else if (!o.columns.length) {
    md.push('', '（这条 SQL 没有返回结果集）');
    tx.push('', '（这条 SQL 没有返回结果集）');
  } else {
    md.push('', '（查询结果为空）');
    tx.push('', '（查询结果为空）');
  }
  const masked = o.columns.filter((_c, i) => kinds[i]);
  if (masked.length) {
    md.push('', `> 这些列已脱敏：${masked.join('、')}`);
    tx.push('', `（这些列已脱敏：${masked.join('、')}）`);
  }
  return {
    title,
    markdown: md.join('\n'),
    text: tx.join('\n'),
    data: {
      task: o.task.name,
      database: where,
      sql: o.task.command,
      at: o.at,
      rowCount: o.rows.length,
      truncated: o.truncated || o.rows.length > shown.length,
      columns: o.columns,
      rows: shown.map((r) => r.map((v, i) => (v === null ? null : kinds[i] === 'secret' ? '****' : kinds[i] === 'pii' ? '[PII]' : v))),
      summary: o.summary,
    },
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const KIND_NAME: Record<ReportWebhook['kind'], string> = { DINGTALK: '钉钉', WECOM: '企业微信', FEISHU: '飞书', WEBHOOK: 'Webhook' };
export const webhookLabel = (w: ReportWebhook): string => w.name || KIND_NAME[w.kind];

/** 发给一个机器人 / Webhook；失败时抛出带原因的错误（文档一 6.32.3） */
export async function sendWebhook(w: ReportWebhook, msg: ReportMessage, opts: { fetch?: Fetch; now?: () => number } = {}): Promise<void> {
  const fetchImpl: Fetch = opts.fetch ?? (fetch as unknown as Fetch);
  const now = (opts.now ?? Date.now)();
  let url = w.url;
  let body: string;
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
  if (w.kind === 'DINGTALK') {
    if (w.secret) {
      const sign = createHmac('sha256', w.secret).update(`${now}\n${w.secret}`).digest('base64');
      url += `${url.includes('?') ? '&' : '?'}timestamp=${now}&sign=${encodeURIComponent(sign)}`;
    }
    body = JSON.stringify({ msgtype: 'markdown', markdown: { title: msg.title, text: clipBytes(msg.markdown, DINGTALK_BYTES) } });
  } else if (w.kind === 'WECOM') {
    // 企业微信的 Markdown 不支持表格：用逐行的「列：值」
    body = JSON.stringify({ msgtype: 'markdown', markdown: { content: clipBytes(msg.text, WECOM_BYTES) } });
  } else if (w.kind === 'FEISHU') {
    const extra: Record<string, string> = {};
    if (w.secret) {
      const ts = String(Math.floor(now / 1000));
      extra.timestamp = ts;
      extra.sign = createHmac('sha256', `${ts}\n${w.secret}`).update('').digest('base64');
    }
    body = JSON.stringify({ ...extra, msg_type: 'text', content: { text: clipBytes(msg.text, 28_000) } });
  } else {
    body = JSON.stringify({ title: msg.title, text: msg.text, markdown: msg.markdown, ...msg.data });
    if (w.secret) headers['x-itm-signature'] = `sha256=${createHmac('sha256', w.secret).update(body).digest('hex')}`;
  }
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    throw new Error(err.name === 'TimeoutError' ? '10 秒内没有响应' : `连不上（${err.cause?.code ?? err.message}）`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`);
  if (w.kind === 'WEBHOOK') return;
  let j: { errcode?: number; errmsg?: string; code?: number; msg?: string; StatusCode?: number };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    throw new Error(`返回的不是 JSON：${text.slice(0, 200)}`);
  }
  const code = w.kind === 'FEISHU' ? (j.code ?? j.StatusCode ?? 0) : (j.errcode ?? 0);
  if (code !== 0) throw new Error(`${KIND_NAME[w.kind]}返回错误 ${code}：${j.errmsg ?? j.msg ?? text.slice(0, 200)}`);
}

/** 测试消息（编辑框里的「发送测试消息」） */
export function testMessage(at: number): ReportMessage {
  const title = '【SQL 报表】测试消息';
  const time = new Date(at).toLocaleString('zh-CN', { hour12: false });
  return {
    title,
    markdown: `### ${title}\n- 时间：${time}\n\n这是 iTerminal 发出的测试消息，收到说明机器人配置正确。`,
    text: `${title}\n时间：${time}\n这是 iTerminal 发出的测试消息，收到说明机器人配置正确。`,
    data: { test: true, at },
  };
}

export interface ReportDeps {
  databases: DbService;
  /** 发给 AI 之前的脱敏 */
  masker: () => Masker;
  /** 单次 AI 请求（AI 总结）；没有时跳过总结 */
  ask?: (system: string, text: string, timeoutMs: number) => Promise<string>;
  notify(title: string, body: string): void;
  fetch?: Fetch;
  now(): number;
}

export interface ReportOutcome {
  status: 'SUCCESS' | 'FAILED';
  /** 发出去的报表正文 + 每个渠道的结果（执行记录里显示） */
  output: string;
  message: string;
  rowCount: number;
}

const SUMMARY_SYSTEM =
  '你是数据分析助手。给你一份定时 SQL 报表的查询结果（部分列已脱敏），用 2–4 句中文总结：数量、主要分布、异常或值得注意的地方。只根据给出的数据，不要编造；不要复述手机号、身份证号等个人信息。只输出总结本身。';

/** 执行一次 SQL 报表：只读查询 → （有结果时 / 每次）生成报表 → AI 总结 → 发送 */
export async function runSqlReport(task: LocalTask, owner: number, signal: AbortSignal, deps: ReportDeps): Promise<ReportOutcome> {
  const report = normalizeReport(task.report);
  const asset = deps.databases.get(task.dbId ?? '');
  if (!asset) return { status: 'FAILED', output: '', message: '数据库已被删除', rowCount: 0 };
  const c = classifySql(task.command ?? '', dialectOf(asset.type));
  if (c.level !== 'L0') return { status: 'FAILED', output: '', message: `SQL 不是只读的，不能执行：${c.reasons.join('；')}`, rowCount: 0 };
  let columns: string[];
  let rows: (string | null)[][];
  let truncated: boolean;
  let database = '';
  try {
    const s = await deps.databases.open(owner, asset.id, task.database || undefined);
    try {
      database = s.database;
      const r = await s.run(c.statement, { readOnly: true, maxRows: QUERY_ROWS, timeoutMs: Math.max(30_000, task.timeoutMin * 60_000), signal, cursorable: c.cursorable });
      columns = r.columns;
      rows = r.rows.map((row) => row.map((v) => cellText(v)));
      truncated = r.truncated;
    } finally {
      await s.close();
    }
  } catch (e) {
    return { status: 'FAILED', output: '', message: `查询失败：${e instanceof UserError ? e.message : describeDbError(e)}`, rowCount: 0 };
  }
  if (report.when === 'ROWS' && rows.length === 0) return { status: 'SUCCESS', output: '查询没有结果，按设置不发送。', message: '没有结果，未发送', rowCount: 0 };
  let summary: string | null = null;
  const notes: string[] = [];
  if (report.aiSummary) {
    if (!deps.ask) notes.push('AI 总结：没有可用的模型，已跳过');
    else {
      try {
        const t = toTable({ columns, rows, truncated, affected: null, durationMs: 0 });
        const forModel = tableForModel(t, true, 12_000).text;
        summary = (await deps.ask(SUMMARY_SYSTEM, `报表：${task.name}\n\n${deps.masker().mask(forModel).text}`, 90_000)).trim().slice(0, 1000) || null;
      } catch (e) {
        notes.push(`AI 总结失败：${(e as Error).message.slice(0, 200)}`);
      }
    }
  }
  const msg = buildReport({ task, dbName: asset.name, database, columns, rows, truncated, report, summary, at: deps.now() });
  const sent: string[] = [];
  const failed: string[] = [];
  if (report.systemNotify) {
    deps.notify(msg.title, `${rows.length}${truncated ? '+' : ''} 行${summary ? `：${summary}` : ''}`.slice(0, 200));
    sent.push('系统通知');
  }
  for (const w of report.webhooks) {
    if (signal.aborted) break;
    try {
      await sendWebhook(w, msg, { fetch: deps.fetch, now: deps.now });
      sent.push(webhookLabel(w));
    } catch (e) {
      failed.push(`${webhookLabel(w)}（${(e as Error).message}）`);
    }
  }
  const lines = [msg.markdown, '', `发送：${sent.length ? `✓ ${sent.join('、')}` : '没有设置通知渠道'}${failed.length ? `；✗ ${failed.join('、')}` : ''}`, ...notes];
  return {
    status: failed.length ? 'FAILED' : 'SUCCESS',
    output: lines.join('\n'),
    message: failed.length ? `${failed.length} 个渠道发送失败` : `${rows.length}${truncated ? '+' : ''} 行，已发送`,
    rowCount: rows.length,
  };
}
