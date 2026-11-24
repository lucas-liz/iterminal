import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { classifySql, referencedTables, splitSql, type SqlClassification } from '@itm/approval';
import type { Masker } from '@itm/masking';
import type { DbAsset, DbColumnInfo, DbObjectList, SqlAiAction, SqlExecItem, SqlExecResult, SqlPlan, SqlPlanItem } from '@itm/protocol';
import type { AuditRepo } from '../audit/audit-repo';
import type { SettingsRepo } from '../settings/settings-repo';
import { UserError } from '../../util/errors';
import type { DbAssetRepo } from './db-asset-repo';
import type { DbService, DbSession } from './db-service';
import { DbAbortError, describeDbError } from './drivers';
import { cellText, columnsOf, describeTable, dialectOf, objectsOf, schemaLine, toCsv, toWorkbenchRows } from './db-tools';

/** 导出全部：最多 10 万行 */
const EXPORT_ROWS = 100_000;
/** 一次最多执行的语句数 */
const MAX_STATEMENTS = 200;
/** 给 AI 的表结构最多约 6000 字、15 张表 */
const SCHEMA_CHARS = 6000;
const SCHEMA_TABLES = 15;
/** 库里不超过这么多张表时全部带上 */
const SMALL_SCHEMA = 30;

const TXN_VERBS = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT', 'XA']);

export interface WorkbenchDeps {
  databases: DbService;
  repo: DbAssetRepo;
  audit: AuditRepo;
  settings: SettingsRepo;
  /** 单次 AI 请求（快速模型，没有时用默认模型）；没有时 AI 按钮不可用 */
  ask?: (system: string, text: string, timeoutMs: number) => Promise<string>;
  masker: () => Masker;
}

interface Where {
  database?: string | null;
  schema?: string | null;
}

const dialectName = (a: DbAsset): string => (a.type === 'MYSQL' ? 'MySQL' : a.type === 'POSTGRES' ? 'PostgreSQL' : 'SQLite');

/**
 * SQL 工作台（第十八轮，文档一 6.32.1）：库表树、执行（按分号拆开、逐条提交、写操作要确认）、停止、导出全部、AI 写 / 解释 / 优化 / 诊断 SQL。
 * 人自己执行，不受数据库的 Agent 权限限制；分级和确认规则同 6.31.5。
 */
export class SqlWorkbench {
  private readonly runs = new Map<string, AbortController>();

  constructor(private readonly d: WorkbenchDeps) {}

  private async withSession<T>(owner: number, id: string, w: Where, fn: (s: DbSession) => Promise<T>): Promise<T> {
    const s = await this.d.databases.open(owner, id, w.database || undefined);
    try {
      return await fn(s);
    } finally {
      await s.close();
    }
  }

  // ---------------------------------------------------------------- 库表树

  objects(owner: number, id: string, w: Where): Promise<DbObjectList> {
    const asset = this.d.repo.require(id);
    // 列出库时用默认库连接（PostgreSQL 必须连到某个库才能列出所有库）
    const listDatabases = asset.type !== 'SQLITE' && !w.database;
    return this.withSession(owner, id, listDatabases ? {} : w, (s) => objectsOf(s, { database: w.database ?? undefined, schema: w.schema ?? undefined, listDatabases }));
  }

  columns(owner: number, id: string, w: Where, tables: string[]): Promise<DbColumnInfo[]> {
    return this.withSession(owner, id, w, (s) => columnsOf(s, Array.isArray(tables) ? tables : [], { database: w.database ?? undefined, schema: w.schema ?? undefined }));
  }

  async describe(owner: number, id: string, w: Where, table: string): Promise<string> {
    const r = await this.withSession(owner, id, w, (s) => describeTable(s, String(table ?? ''), { database: w.database ?? undefined, schema: w.schema ?? undefined }));
    if (!r) throw new UserError(`表 ${table} 不存在`);
    return r.text;
  }

  // ---------------------------------------------------------------- 执行

  /** 分级：拆成语句，每条判断能不能执行、要不要确认（主进程执行前会再算一次） */
  plan(id: string, sql: string): SqlPlan & { classes: SqlClassification[] } {
    const asset = this.d.repo.require(id);
    const dialect = dialectOf(asset.type);
    const pieces = splitSql(sql, dialect);
    if (!pieces.length) return { items: [], confirm: 'none', error: '没有可以执行的 SQL', classes: [] };
    if (pieces.length > MAX_STATEMENTS) return { items: [], confirm: 'none', error: `一次最多执行 ${MAX_STATEMENTS} 条语句`, classes: [] };
    const classes = pieces.map((p) => classifySql(p.text, dialect));
    const items: SqlPlanItem[] = pieces.map((p, i) => {
      const c = classes[i];
      const base = { text: p.text, start: p.start, end: p.end, level: c.level, verb: c.verb, reasons: c.reasons };
      if (c.level === 'L0') return { ...base, kind: 'read' };
      if (c.level === 'L1') return { ...base, kind: 'write' };
      if (c.level === 'L2') return { ...base, kind: 'danger' };
      // 工作台里同一次执行共用一个连接：USE、SET（不是全局的）对后面的语句有效
      if (c.verb === 'USE' || c.verb === 'SET' || (c.verb === 'RESET' && dialect !== 'mysql') || c.verb === 'DISCARD') return { ...base, kind: 'session', reasons: ['会话设置（只对这一次执行里后面的语句有效）'] };
      if (TXN_VERBS.has(c.verb)) return { ...base, kind: 'error', reasons: ['工作台里每条语句自动提交，不需要 BEGIN / COMMIT / ROLLBACK'] };
      return { ...base, kind: 'error' };
    });
    const bad = items.find((x) => x.kind === 'error');
    const writes = items.some((x) => x.kind === 'write' || x.kind === 'danger');
    const confirm = items.some((x) => x.kind === 'danger') || (writes && asset.production) ? 'type' : writes ? 'click' : 'none';
    return { items, confirm, error: bad ? `「${short(bad.text)}」不能执行：${bad.reasons.join('；')}` : null, classes };
  }

  /** 依次执行（同一个连接，每条语句单独提交），出错或停止时不再执行后面的语句；每条写一条审计 */
  async exec(owner: number, a: { id: string; sql: string; runId: string; confirmed?: boolean; confirmText?: string } & Where): Promise<SqlExecResult> {
    const asset = this.d.repo.require(a.id);
    const plan = this.plan(a.id, a.sql);
    if (plan.error) throw new UserError(plan.error);
    if (plan.confirm !== 'none' && a.confirmed !== true) throw new UserError('这次执行包含写操作，需要确认后才能执行');
    if (plan.confirm === 'type' && String(a.confirmText ?? '').trim() !== asset.name) throw new UserError(`需要输入数据库名称「${asset.name}」确认`);
    const runId = String(a.runId || '');
    const abort = new AbortController();
    this.runs.get(runId)?.abort();
    this.runs.set(runId, abort);
    const maxRows = this.d.settings.get('db.workbenchRows');
    const timeoutMs = this.d.settings.get('db.timeoutSec') * 1000;
    const out: SqlExecResult = { items: [], stopped: false, database: '' };
    let s: DbSession | null = null;
    try {
      s = await this.d.databases.open(owner, a.id, a.database || undefined);
      out.database = s.database;
      for (let i = 0; i < plan.items.length; i++) {
        const item = plan.items[i];
        const c = plan.classes[i];
        if (abort.signal.aborted) {
          out.stopped = true;
          break;
        }
        try {
          const r = await s.run(c.statement, { readOnly: item.kind === 'read', maxRows, timeoutMs, signal: abort.signal, cursorable: c.cursorable, ...(a.schema ? { schema: a.schema } : {}) });
          const rows = toWorkbenchRows(r.rows);
          out.items.push({ text: item.text, ok: true, columns: r.columns, rows, rowCount: rows.length, truncated: r.truncated, affected: r.affected, durationMs: r.durationMs });
          this.audit(asset, item, plan.confirm !== 'none', 0, { database: s.database, rows: rows.length, affected: r.affected, durationMs: r.durationMs });
        } catch (e) {
          const msg = e instanceof UserError ? e.message : describeDbError(e);
          out.items.push({ text: item.text, ok: false, columns: [], rows: [], rowCount: 0, truncated: false, affected: null, durationMs: 0, error: msg });
          this.audit(asset, item, plan.confirm !== 'none', 1, { database: s.database, error: msg.slice(0, 500) });
          if (e instanceof DbAbortError) out.stopped = true;
          break;
        }
      }
    } finally {
      await s?.close();
      if (this.runs.get(runId) === abort) this.runs.delete(runId);
    }
    return out;
  }

  cancel(runId: string): void {
    this.runs.get(runId)?.abort();
  }

  private audit(asset: DbAsset, item: SqlPlanItem, confirmed: boolean, exitCode: number, extra: Record<string, unknown>): void {
    this.d.audit.command({
      source: 'USER',
      hostId: null,
      hostName: `数据库 · ${asset.name}`,
      sessionId: null,
      command: item.text,
      risk: item.level === 'DENY' ? 'L1' : item.level,
      decision: confirmed && item.kind !== 'read' ? 'APPROVED' : 'AUTO',
      exitCode,
      detail: { tool: 'sql_workbench', dbId: asset.id, dbType: asset.type, reasons: item.reasons, ...extra },
    });
  }

  /** 导出全部：只读查询重新执行一次，结果写成 CSV（最多 10 万行） */
  async exportQuery(owner: number, a: { id: string; sql: string; path: string } & Where): Promise<{ rows: number; truncated: boolean }> {
    if (typeof a.path !== 'string' || !isAbsolute(a.path)) throw new UserError('导出路径不正确');
    const plan = this.plan(a.id, a.sql);
    if (plan.error) throw new UserError(plan.error);
    if (plan.items.length !== 1 || plan.items[0].kind !== 'read') throw new UserError('导出全部只支持一条只读查询');
    const c = plan.classes[0];
    const timeoutMs = Math.max(this.d.settings.get('db.timeoutSec') * 1000, 120_000);
    const r = await this.withSession(owner, a.id, a, (s) => s.run(c.statement, { readOnly: true, maxRows: EXPORT_ROWS, timeoutMs, cursorable: c.cursorable, ...(a.schema ? { schema: a.schema } : {}) }));
    writeFileSync(a.path, toCsv(r.columns, r.rows.map((row) => row.map((v) => cellText(v)))), 'utf8');
    return { rows: r.rows.length, truncated: r.truncated };
  }

  // ---------------------------------------------------------------- AI（文档一 6.32.2）

  async ai(owner: number, a: { id: string; action: SqlAiAction; sql?: string; question?: string; error?: string; tables?: string[] } & Where): Promise<{ text: string }> {
    if (!this.d.ask) throw new UserError('没有可用的 AI 模型');
    const asset = this.d.repo.require(a.id);
    const sql = String(a.sql ?? '').trim();
    const question = String(a.question ?? '').trim();
    if (a.action === 'nl2sql' ? !question : !sql) throw new UserError(a.action === 'nl2sql' ? '请输入要查询什么' : '请先在编辑器里写好（或选中）要处理的 SQL');
    const m = this.d.masker();
    const parts: string[] = [];
    await this.withSession(owner, a.id, a, async (s) => {
      parts.push(`数据库：${dialectName(asset)}（${s.driver.version}），当前库：${s.database || '（未指定）'}${a.schema ? `，schema：${a.schema}` : ''}`);
      parts.push(`表结构：\n${await this.schemaContext(s, a, sql, question)}`);
      if (a.action === 'optimize') parts.push(await this.planText(s, asset, sql, a.schema ?? undefined));
    });
    if (a.action === 'nl2sql') parts.push(`需求：${m.mask(question).text}`);
    if (sql) parts.push(`SQL：\n\`\`\`sql\n${m.mask(sql.slice(0, 20_000)).text}\n\`\`\``);
    if (a.action === 'diagnose' && a.error) parts.push(`数据库返回的错误：\n${m.mask(String(a.error).slice(0, 4000)).text}`);
    const text = await this.d.ask(sqlAssistSystem(a.action, dialectName(asset)), parts.join('\n\n'), 120_000);
    return { text };
  }

  /** SQL 工作台 AI 对话的上下文（第二十九轮）：数据库说明 + 按问题挑出的表结构 */
  async chatContext(owner: number, c: { dbId: string; database: string | null; schema: string | null; tables?: string[]; sql?: string }, question: string): Promise<{ head: string; schema: string }> {
    const asset = this.d.repo.require(c.dbId);
    const w = { database: c.database, schema: c.schema, tables: Array.isArray(c.tables) ? c.tables.slice(0, 50).map(String) : [] };
    return this.withSession(owner, c.dbId, w, async (s) => ({
      head: `数据库「${asset.name}」：${dialectName(asset)}（${s.driver.version}），当前库：${s.database || '（未指定）'}${c.schema ? `，schema：${c.schema}` : ''}${asset.production ? '，生产环境' : ''}`,
      schema: await this.schemaContext(s, w, String(c.sql ?? ''), question),
    }));
  }

  /** 挑表结构：选中的表 → SQL 里引用的表 → 问题里的词匹配的表 → 小库全部（文档一 6.32.2） */
  private async schemaContext(s: DbSession, w: Where & { tables?: string[] }, sql: string, question: string): Promise<string> {
    const list = await objectsOf(s, { database: w.database ?? undefined, schema: w.schema ?? (s.asset.type === 'POSTGRES' ? 'public' : undefined), listDatabases: false });
    const tables = list.items;
    const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
    const pick: string[] = [];
    const add = (name: string): void => {
      const t = byName.get(name.toLowerCase());
      if (t && !pick.includes(t.name)) pick.push(t.name);
    };
    (w.tables ?? []).forEach(add);
    if (sql) referencedTables(sql, dialectOf(s.asset.type)).forEach(add);
    if (question) {
      const words = question.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((x) => x.length >= 2);
      for (const t of tables) {
        const hay = `${t.name} ${t.comment ?? ''}`.toLowerCase();
        if (words.some((wd) => hay.includes(wd) || (wd.length >= 3 && t.name.toLowerCase().includes(wd.replace(/s$/, ''))))) add(t.name);
      }
    }
    if (tables.length <= SMALL_SCHEMA) tables.forEach((t) => add(t.name));
    const chosen = pick.slice(0, SCHEMA_TABLES);
    const cols = chosen.length ? await columnsOf(s, chosen, { database: w.database ?? undefined, schema: w.schema ?? undefined }) : [];
    const lines: string[] = [];
    let size = 0;
    for (const name of chosen) {
      const line = schemaLine(name, cols.filter((c) => c.table === name), byName.get(name.toLowerCase())?.comment ?? null);
      if (size + line.length > SCHEMA_CHARS) break;
      lines.push(line);
      size += line.length;
    }
    const others = tables.filter((t) => !chosen.includes(t.name)).map((t) => t.name);
    if (others.length) lines.push(`（库里还有这些表，没有列出结构：${others.slice(0, 200).join(', ')}${others.length > 200 ? ' …' : ''}）`);
    return lines.join('\n') || '（这个库里没有表）';
  }

  /** 优化用的执行计划：只读语句自动 EXPLAIN（不执行语句），失败时说明 */
  private async planText(s: DbSession, asset: DbAsset, sql: string, schema: string | undefined): Promise<string> {
    const piece = splitSql(sql, dialectOf(asset.type))[0];
    if (!piece) return '';
    const c = classifySql(piece.text, dialectOf(asset.type));
    if (c.level !== 'L0' || c.verb === 'EXPLAIN') return '（不是只读查询，没有自动获取执行计划）';
    try {
      const r = await s.run(`${asset.type === 'SQLITE' ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'} ${c.statement}`, { readOnly: true, maxRows: 200, timeoutMs: 15_000, ...(schema ? { schema } : {}) });
      const rows = r.rows.map((row) => row.map((v) => cellText(v) ?? 'NULL').join(' | '));
      return `执行计划（EXPLAIN）：\n${r.columns.join(' | ')}\n${rows.join('\n')}`.slice(0, 8000);
    } catch (e) {
      return `（获取执行计划失败：${describeDbError(e).slice(0, 300)}）`;
    }
  }
}

const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 60)}…` : s).replace(/\s+/g, ' ');

/** 四个 AI 按钮的系统提示词 */
export function sqlAssistSystem(action: SqlAiAction, dialect: string): string {
  const base =
    `你是 ${dialect} 数据库专家，帮助运维和开发人员写、看、改 SQL。只能使用「表结构」里出现的表和列，不要编造；表结构里没有的信息就说明需要确认。` +
    `SQL 必须是 ${dialect} 的语法，放在 \`\`\`sql 代码块里。用中文回答，简洁、分点。`;
  switch (action) {
    case 'nl2sql':
      return `${base}\n任务：把用户的需求写成一条 SQL（优先只读查询；需求是修改数据时也只写出 SQL，不要假设已经执行）。先给出 SQL（只有一个 \`\`\`sql 代码块），再用一两句话说明思路和要注意的地方（例如大表要带时间条件、结果可能很多时加 LIMIT）。`;
    case 'explain':
      return `${base}\n任务：逐段解释这条 SQL 在做什么——用到哪些表、怎么连接、过滤和分组排序的条件、最后返回什么；最后指出潜在问题（性能、NULL 的处理、结果可能和预期不符的地方）。没有明显错误时不要重写。`;
    case 'optimize':
      return `${base}\n任务：分析这条 SQL 的性能。结合执行计划和索引指出问题（全表扫描、索引用不上、文件排序 / 临时表、隐式类型转换、函数包住索引列等），给出具体建议（需要加索引时给出 CREATE INDEX 语句，并说明对写入的影响），最后给出改写后的 SQL（一个 \`\`\`sql 代码块，语义必须和原来一致）。已经足够好时直接说明，不要硬改。`;
    default:
      return `${base}\n任务：这条 SQL 执行失败了。根据数据库返回的错误和表结构说明原因，然后给出修正后的 SQL（一个 \`\`\`sql 代码块）。`;
  }
}
