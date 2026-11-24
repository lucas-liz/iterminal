import { maxLevel, rankOf } from './classify';
import type { Classification, RuleLevel } from './types';

/**
 * SQL 分级（文档一 6.31.5）：和 shell 命令一样完全不依赖模型。
 * 先把注释、字符串和带引号的名称换成空格（保留长度），再在剩下的「骨架」上按语句类型判断：
 * L0 只读 / L1 写操作 / L2 高危 / DENY 直接拒绝。判不准的一律从严（无法识别的语句按 L2）。
 * 这不是完整的 SQL 解析器：只读语句另外在数据库的只读事务里执行，分级漏判时数据库自己也会拒绝写入。
 */
export type SqlDialect = 'mysql' | 'postgres' | 'sqlite';

/** SQL 最长 50 KB */
export const MAX_SQL_BYTES = 50 * 1024;

export interface SqlClassification extends Classification {
  /** 语句类型（第一个关键字，大写），例如 SELECT、UPDATE；WITH 开头时是主语句的类型 */
  verb: string;
  /** 去掉结尾分号的语句（执行时用） */
  statement: string;
  /** PostgreSQL 可以用游标分批读取（SELECT / VALUES / TABLE，不带 INTO 和加锁） */
  cursorable: boolean;
  /** UPDATE / DELETE：可以用 EXPLAIN 估算影响行数 */
  estimable: boolean;
}

interface Tok {
  t: string;
  u: string;
  i: number;
  d: number;
}

interface Verdict {
  level: RuleLevel;
  reasons: string[];
  verb: string;
  unknown?: boolean;
  cursorable?: boolean;
  estimable?: boolean;
}

const isIdentChar = (c: string | undefined): boolean => !!c && /[\p{L}\p{N}_$]/u.test(c);

/** 去掉注释、字符串和带引号的名称（换成空格，保留换行和长度）；无法安全判断时返回错误 */
function strip(src: string, dialect: SqlDialect, backslash: boolean): { skel: string } | { error: string } {
  const out = src.split('');
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    // 行注释：MySQL 的 -- 后面必须是空白（--1 是两个减号）；MySQL 的 # 也是行注释
    if ((c === '-' && d === '-' && (dialect !== 'mysql' || i + 2 >= n || /\s/.test(src[i + 2]))) || (c === '#' && dialect === 'mysql')) {
      let j = i + 1;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      // MySQL 会执行 /*! … */ 里的内容，不能当注释去掉
      if (dialect === 'mysql' && src[i + 2] === '!') return { error: 'MySQL 的可执行注释（/*! … */）会被当成 SQL 执行，不允许使用' };
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return { error: '注释没有结束（缺少 */）' };
      if (src.slice(i + 2, end).includes('/*')) return { error: '不支持嵌套的块注释' };
      blank(i, end + 2);
      i = end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // MySQL 默认支持反斜杠转义；PostgreSQL 只有 E'…' 支持
      const esc = (backslash && dialect === 'mysql' && c !== '`') || (c === "'" && dialect === 'postgres' && (src[i - 1] === 'E' || src[i - 1] === 'e') && !isIdentChar(src[i - 2]));
      let j = i + 1;
      let ok = false;
      while (j < n) {
        if (esc && src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j += 2;
            continue;
          }
          ok = true;
          j++;
          break;
        }
        j++;
      }
      if (!ok) return { error: c === '`' ? '带反引号的名称没有结束' : '字符串或带引号的名称没有结束' };
      blank(i, j);
      i = j;
      continue;
    }
    // SQLite 的 [名称]
    if (c === '[' && dialect === 'sqlite') {
      const end = src.indexOf(']', i + 1);
      if (end < 0) return { error: '带方括号的名称没有结束' };
      blank(i, end + 1);
      i = end + 1;
      continue;
    }
    // PostgreSQL 的 $tag$ … $tag$
    if (c === '$' && dialect === 'postgres' && !isIdentChar(src[i - 1])) {
      const m = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(src.slice(i));
      if (m) {
        const end = src.indexOf(m[0], i + m[0].length);
        if (end < 0) return { error: '美元符号引用的字符串没有结束' };
        blank(i, end + m[0].length);
        i = end + m[0].length;
        continue;
      }
    }
    i++;
  }
  return { skel: out.join('') };
}

function lex(skel: string): Tok[] {
  const out: Tok[] = [];
  let depth = 0;
  for (const m of skel.matchAll(/[\p{L}_][\p{L}\p{N}_$]*|\p{N}+(?:\.\p{N}+)?|\S/gu)) {
    const t = m[0];
    if (t === ')') depth = Math.max(0, depth - 1);
    out.push({ t, u: t.toUpperCase(), i: m.index ?? 0, d: depth });
    if (t === '(') depth++;
  }
  return out;
}

const isWord = (t: Tok | undefined): boolean => !!t && /^[\p{L}_]/u.test(t.t);

/** 读写服务器文件、结束其他会话、连接其他库：高危 */
const FUNCS_L2: Record<string, string> = {
  load_file: '读取服务器上的文件',
  pg_read_file: '读取服务器上的文件',
  pg_read_binary_file: '读取服务器上的文件',
  pg_ls_dir: '列出服务器上的目录',
  pg_stat_file: '读取服务器上的文件信息',
  pg_file_write: '写服务器上的文件',
  pg_logdir_ls: '列出服务器上的目录',
  lo_import: '读取服务器上的文件',
  lo_export: '写服务器上的文件',
  load_extension: '加载扩展',
  readfile: '读取文件',
  writefile: '写文件',
  dblink: '连接其他数据库',
  dblink_exec: '在其他数据库上执行语句',
  dblink_connect: '连接其他数据库',
  pg_terminate_backend: '结束其他会话',
  pg_cancel_backend: '取消其他会话的查询',
  pg_reload_conf: '重新加载数据库配置',
  pg_rotate_logfile: '切换日志文件',
  pg_promote: '提升备库',
  sys_exec: '执行系统命令',
  sys_eval: '执行系统命令',
};

/** 有副作用或长时间占用连接：写操作 */
const FUNCS_L1: Record<string, string> = {
  sleep: '会长时间占用连接',
  benchmark: '会长时间占用连接',
  pg_sleep: '会长时间占用连接',
  pg_sleep_for: '会长时间占用连接',
  pg_sleep_until: '会长时间占用连接',
  get_lock: '加锁',
  release_lock: '释放锁',
  release_all_locks: '释放锁',
  pg_advisory_lock: '加锁',
  pg_advisory_xact_lock: '加锁',
  pg_try_advisory_lock: '加锁',
  pg_try_advisory_xact_lock: '加锁',
  pg_advisory_lock_shared: '加锁',
  nextval: '修改序列',
  setval: '修改序列',
  set_config: '修改会话设置',
  pg_notify: '发送通知',
  lo_create: '创建大对象',
  lo_unlink: '删除大对象',
  lo_from_bytea: '创建大对象',
  lo_put: '修改大对象',
  pg_switch_wal: '切换 WAL 文件',
};

/** WITH 主语句 / EXPLAIN 目标可以是这些 */
const MAIN_VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'VALUES', 'TABLE', 'REPLACE']);
const EXPLAIN_TARGETS = new Set([...MAIN_VERBS, 'WITH', 'CREATE', 'DECLARE', 'EXECUTE']);
/** WHERE 条件里不算「引用了列」的词 */
const CONST_WORDS = new Set(['TRUE', 'FALSE', 'NULL', 'NOT', 'AND', 'IS', 'XOR', 'UNKNOWN', 'BETWEEN', 'LIKE', 'IN']);
const TXN_VERBS = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'XA', 'ABORT']);
const MAINT_VERBS = new Set(['ANALYZE', 'ANALYSE', 'OPTIMIZE', 'VACUUM', 'REINDEX', 'CLUSTER', 'REPAIR', 'CHECK', 'CHECKSUM', 'REFRESH', 'CHECKPOINT']);
const SERVER_VERBS = new Set(['KILL', 'SHUTDOWN', 'RESTART', 'FLUSH', 'PURGE', 'INSTALL', 'UNINSTALL', 'LOAD', 'STOP', 'CHANGE', 'REASSIGN', 'SECURITY', 'IMPORT']);
const DENY_VERBS: Record<string, string> = {
  USE: '每次执行都是新的连接，切换库请用 database / schema 参数',
  LOCK: '每次执行都是新的连接，锁表不会保留',
  UNLOCK: '每次执行都是新的连接，不能单独解锁',
  COPY: '不支持 COPY，请用 SELECT 查询或 INSERT 写入',
  DECLARE: '不支持游标，直接查询即可（结果会自动限制行数）',
  FETCH: '不支持游标',
  CLOSE: '不支持游标',
  MOVE: '不支持游标',
  PREPARE: '不支持预处理语句，直接执行 SQL 即可',
  EXECUTE: '不支持预处理语句，直接执行 SQL 即可',
  DEALLOCATE: '不支持预处理语句',
  DISCARD: '每次执行都是新的连接，不需要 DISCARD',
  LISTEN: '不支持 LISTEN',
  UNLISTEN: '不支持 UNLISTEN',
  ATTACH: '不允许挂载其他数据库文件',
  DETACH: '不允许卸载数据库文件',
  GET: '不支持 GET DIAGNOSTICS',
  SIGNAL: '不支持 SIGNAL',
  RESIGNAL: '不支持 RESIGNAL',
  HANDLER: '不支持 HANDLER，请用 SELECT 查询',
};

class Judge {
  constructor(
    private readonly toks: Tok[],
    private readonly dialect: SqlDialect,
  ) {}

  /** 从 start 开始的一条（子）语句 */
  judge(start: number): Verdict {
    const toks = this.toks;
    let s = start;
    while (toks[s]?.t === '(') s++;
    const head = toks[s];
    if (!head) return { level: 'DENY', reasons: ['空语句'], verb: '' };
    const base = head.d;
    const verb = head.u;
    const next = (k = 1): string => toks[s + k]?.u ?? '';
    const words = toks.slice(s + 1).map((t) => t.u);
    let v: Verdict;
    switch (verb) {
      case 'SELECT':
      case 'VALUES':
      case 'TABLE':
        v = this.read(s, base, verb);
        break;
      case 'WITH':
        v = this.withClause(s, base);
        break;
      case 'SHOW':
      case 'DESCRIBE':
      case 'DESC':
        v = { level: 'L0', reasons: ['只读：查看数据库信息'], verb };
        break;
      case 'EXPLAIN':
        v = this.explain(s, base);
        break;
      case 'PRAGMA':
        if (this.dialect !== 'sqlite') v = { level: 'L2', reasons: ['无法识别的 SQL 语句'], verb, unknown: true };
        else if (words.includes('=')) v = { level: 'L1', reasons: ['修改 PRAGMA 设置'], verb };
        else if (['OPTIMIZE', 'WAL_CHECKPOINT', 'INCREMENTAL_VACUUM', 'SHRINK_MEMORY'].includes(next())) v = { level: 'L1', reasons: ['维护操作'], verb };
        else v = { level: 'L0', reasons: ['只读：查看 PRAGMA'], verb };
        break;
      case 'INSERT':
      case 'REPLACE':
      case 'MERGE':
      case 'UPSERT':
        v = { level: 'L1', reasons: ['写入数据'], verb };
        break;
      case 'UPDATE':
      case 'DELETE':
        v = this.updateDelete(s, base, verb);
        break;
      case 'TRUNCATE':
        v = { level: 'L2', reasons: ['清空整张表'], verb };
        break;
      case 'DROP':
        v = { level: 'L2', reasons: [`删除${objectName(next(), next(2))}`], verb };
        break;
      case 'CREATE': {
        const rest = words.slice(0, 6);
        if (rest.some((w) => w === 'USER' || w === 'ROLE')) v = { level: 'L2', reasons: ['创建数据库账号 / 角色'], verb };
        else if (next() === 'OR' && next(2) === 'REPLACE') v = { level: 'L1', reasons: ['创建或替换数据库对象（会覆盖已有的定义）'], verb };
        else v = { level: 'L1', reasons: ['创建数据库对象'], verb };
        break;
      }
      case 'ALTER': {
        const obj = next();
        const top = toks.slice(s + 1).filter((t) => t.d === base).map((t) => t.u);
        if (['USER', 'ROLE', 'SYSTEM', 'INSTANCE', 'SERVER'].includes(obj)) v = { level: 'L2', reasons: [obj === 'SYSTEM' || obj === 'INSTANCE' ? '修改数据库全局配置' : '修改数据库账号 / 角色'], verb };
        else if (top.some((w) => w === 'DROP' || w === 'TRUNCATE' || w === 'DISCARD' || w === 'REMOVE' || w === 'EXCHANGE')) v = { level: 'L2', reasons: ['删除列 / 约束 / 索引 / 分区'], verb };
        else v = { level: 'L1', reasons: [obj === 'TABLE' ? '修改表结构' : '修改数据库对象'], verb };
        break;
      }
      case 'RENAME':
        v = next() === 'USER' ? { level: 'L2', reasons: ['重命名数据库账号'], verb } : { level: 'L1', reasons: ['重命名表'], verb };
        break;
      case 'COMMENT':
        v = { level: 'L1', reasons: ['修改注释'], verb };
        break;
      case 'GRANT':
      case 'REVOKE':
        v = { level: 'L2', reasons: ['修改数据库权限'], verb };
        break;
      case 'SET':
        if (words.some((w) => w === 'GLOBAL' || w === 'PERSIST' || w === 'PERSIST_ONLY')) v = { level: 'L2', reasons: ['修改数据库全局设置'], verb };
        else v = { level: 'DENY', reasons: ['每次执行都是新的连接，SET 设置的会话变量不会保留；切换库请用 database / schema 参数'], verb };
        break;
      case 'START':
        if (next() === 'TRANSACTION') v = { level: 'DENY', reasons: ['每次执行会自动放在事务里，不能自己控制事务'], verb };
        else v = { level: 'L2', reasons: ['影响数据库服务器（复制 / 组复制）'], verb };
        break;
      case 'RESET':
        v = this.dialect === 'mysql' ? { level: 'L2', reasons: ['重置数据库服务器状态'], verb } : { level: 'DENY', reasons: ['每次执行都是新的连接，不需要 RESET'], verb };
        break;
      case 'NOTIFY':
        v = { level: 'L1', reasons: ['发送通知'], verb };
        break;
      case 'CALL':
      case 'EXEC':
      case 'DO':
        v = { level: 'L2', reasons: ['存储过程 / 代码块的影响无法判断'], verb };
        break;
      default:
        if (TXN_VERBS.has(verb)) v = { level: 'DENY', reasons: ['每次执行会自动放在事务里，不能自己控制事务'], verb };
        else if (MAINT_VERBS.has(verb)) v = { level: 'L1', reasons: ['维护操作（可能锁表、占用较多资源）'], verb };
        else if (SERVER_VERBS.has(verb)) v = { level: 'L2', reasons: ['影响数据库服务器'], verb };
        else if (DENY_VERBS[verb]) v = { level: 'DENY', reasons: [DENY_VERBS[verb]], verb };
        else v = { level: 'L2', reasons: ['无法识别的 SQL 语句'], verb, unknown: true };
    }
    if (v.level === 'DENY') return v;
    return this.sideEffects(start, v);
  }

  /** SELECT / VALUES / TABLE：只读，SELECT INTO 升级（加锁读在 sideEffects 里判断） */
  private read(s: number, base: number, verb: string): Verdict {
    const toks = this.toks;
    for (let k = s + 1; k < toks.length; k++) {
      const t = toks[k];
      if (t.u !== 'INTO' || t.d !== base || verb !== 'SELECT') continue;
      const n = toks[k + 1];
      if (n && (n.u === 'OUTFILE' || n.u === 'DUMPFILE')) return { level: 'L2', reasons: ['SELECT … INTO OUTFILE 会在数据库服务器上写文件'], verb };
      if (n?.t !== '@') return { level: 'L1', reasons: ['SELECT … INTO 会创建新表或写入变量'], verb };
    }
    return { level: 'L0', reasons: ['只读查询'], verb, cursorable: true };
  }

  private withClause(s: number, base: number): Verdict {
    const toks = this.toks;
    let main = -1;
    let dml = false;
    for (let k = s + 1; k < toks.length; k++) {
      const t = toks[k];
      if (t.d > base && this.isDml(k)) dml = true;
      if (t.d === base && MAIN_VERBS.has(t.u) && toks[k + 1]?.t !== '(') {
        main = k;
        break;
      }
    }
    if (main < 0) return { level: 'L2', reasons: ['无法识别的 SQL 语句（WITH 后面没有找到主语句）'], verb: 'WITH', unknown: true };
    const inner = this.judge(main);
    if (dml) return { ...inner, level: maxLevel(inner.level, 'L2'), reasons: [...inner.reasons.filter((r) => r !== '只读查询'), 'WITH 里带写操作（INSERT / UPDATE / DELETE）'], cursorable: false, estimable: false };
    return inner;
  }

  /** CTE 里的 INSERT / UPDATE / DELETE / MERGE（排除 FOR UPDATE、ON DELETE、INSERT() 函数等） */
  private isDml(k: number): boolean {
    const t = this.toks[k];
    const prev = this.toks[k - 1]?.u ?? '';
    const next = this.toks[k + 1];
    if (next?.t === '(' && t.u !== 'MERGE') return false;
    if (t.u === 'INSERT') return true;
    if (t.u === 'UPDATE') return !['FOR', 'KEY', 'ON'].includes(prev);
    if (t.u === 'DELETE') return prev !== 'ON';
    if (t.u === 'MERGE') return next?.u === 'INTO';
    return false;
  }

  private explain(s: number, base: number): Verdict {
    const toks = this.toks;
    let target = -1;
    let analyze = false;
    for (let k = s + 1; k < toks.length; k++) {
      const t = toks[k];
      if (t.d === base && EXPLAIN_TARGETS.has(t.u)) {
        target = k;
        break;
      }
      if (t.u === 'ANALYZE' || t.u === 'ANALYSE') analyze = true;
    }
    if (!analyze) return { level: 'L0', reasons: ['只查看执行计划，不执行语句'], verb: 'EXPLAIN' };
    if (target < 0) return { level: 'L2', reasons: ['无法识别的 SQL 语句'], verb: 'EXPLAIN', unknown: true };
    const inner = this.judge(target);
    if (inner.level === 'L0') return { level: 'L0', reasons: ['EXPLAIN ANALYZE 会实际执行这条查询'], verb: 'EXPLAIN' };
    return { ...inner, reasons: [`EXPLAIN ANALYZE 会实际执行这条语句：${inner.reasons.join('；')}`], verb: 'EXPLAIN', cursorable: false, estimable: false };
  }

  /** UPDATE / DELETE：没有 WHERE、或者 WHERE 恒为真（没有引用任何列）时按高危处理 */
  private updateDelete(s: number, base: number, verb: string): Verdict {
    const toks = this.toks;
    const act = verb === 'UPDATE' ? '修改' : '删除';
    const where = toks.findIndex((t, k) => k > s && t.d === base && t.u === 'WHERE');
    if (where < 0) return { level: 'L2', reasons: [`不带 WHERE 条件的 ${verb} 会${act}整张表的数据`], verb, estimable: true };
    if (toks[where + 1]?.u === 'CURRENT' && toks[where + 2]?.u === 'OF') return { level: 'L1', reasons: [`${act}数据`], verb };
    const cond: Tok[] = [];
    for (let k = where + 1; k < toks.length; k++) {
      const t = toks[k];
      if (t.d === base && ['ORDER', 'LIMIT', 'RETURNING'].includes(t.u)) break;
      cond.push(t);
    }
    // 按最外层的 OR 分开：任何一段没有引用列（恒为真或恒为假），整个条件就可能恒为真
    const branches: Tok[][] = [[]];
    for (const t of cond) {
      if (t.d === base && t.u === 'OR') branches.push([]);
      else branches[branches.length - 1].push(t);
    }
    const constant = branches.some((b) => !b.some((t) => isWord(t) && !CONST_WORDS.has(t.u)));
    if (constant) return { level: 'L2', reasons: [`WHERE 条件没有引用任何列（例如 1=1），${verb} 可能${act}整张表的数据`], verb, estimable: true };
    return { level: 'L1', reasons: [`${act}数据（带 WHERE 条件）`], verb, estimable: true };
  }

  /** 加锁读、语句里调用的函数（读写服务器文件、结束会话 → L2；加锁、改序列、sleep → L1）；包括 WITH 里的子查询 */
  private sideEffects(s: number, v: Verdict): Verdict {
    const toks = this.toks;
    let level = v.level;
    const reasons = [...v.reasons];
    const up = (l: RuleLevel, reason: string): void => {
      level = maxLevel(level, l);
      reasons.push(reason);
    };
    for (let k = s; k < toks.length; k++) {
      const t = toks[k];
      const n1 = toks[k + 1]?.u ?? '';
      if (t.u === 'FOR' && (n1 === 'UPDATE' || n1 === 'SHARE' || (n1 === 'NO' && toks[k + 2]?.u === 'KEY') || (n1 === 'KEY' && toks[k + 2]?.u === 'SHARE'))) up('L1', '加锁读取（FOR UPDATE / FOR SHARE）会锁住行');
      else if (t.u === 'LOCK' && n1 === 'IN' && toks[k + 2]?.u === 'SHARE') up('L1', '加锁读取（LOCK IN SHARE MODE）会锁住行');
      if (!isWord(t) || toks[k + 1]?.t !== '(') continue;
      const name = t.t.toLowerCase();
      if (FUNCS_L2[name]) up('L2', `${name}()：${FUNCS_L2[name]}`);
      else if (FUNCS_L1[name]) up('L1', `${name}()：${FUNCS_L1[name]}`);
    }
    if (level === v.level && reasons.length === v.reasons.length) return v;
    const out = [...new Set(reasons)];
    return { ...v, level, reasons: level === 'L0' ? out : out.filter((r) => r !== '只读查询' && r !== '只读：查看数据库信息'), cursorable: false };
  }
}

function objectName(a: string, b: string): string {
  const map: Record<string, string> = { DATABASE: '整个数据库', SCHEMA: '整个 schema', TABLE: '表', VIEW: '视图', INDEX: '索引', USER: '数据库账号', ROLE: '角色', FUNCTION: '函数', PROCEDURE: '存储过程', TRIGGER: '触发器', SEQUENCE: '序列', COLUMN: '列', EVENT: '事件', TABLESPACE: '表空间', EXTENSION: '扩展' };
  if (a === 'TEMPORARY' || a === 'TEMP') return map[b] ?? '数据库对象';
  if (a === 'MATERIALIZED') return '物化视图';
  return map[a] ?? '数据库对象';
}

function deny(sql: string, reason: string, parseError = false): SqlClassification {
  return {
    level: 'DENY',
    reasons: [reason],
    matchedRules: [],
    segments: [{ text: sql.trim().slice(0, 200), level: 'DENY', reasons: [reason] }],
    complex: false,
    parseError,
    verb: '',
    statement: sql.trim(),
    cursorable: false,
    estimable: false,
  };
}

function once(sql: string, dialect: SqlDialect, backslash: boolean): SqlClassification {
  const st = strip(sql, dialect, backslash);
  if ('error' in st) return deny(sql, st.error, true);
  const toks = lex(st.skel);
  const semi = toks.findIndex((t) => t.t === ';');
  if (semi >= 0 && semi < toks.length - 1) {
    // 结尾连续的分号也算一条
    if (toks.slice(semi + 1).some((t) => t.t !== ';')) return deny(sql, '一次只能执行一条 SQL 语句');
  }
  const body = semi >= 0 ? toks.slice(0, semi) : toks;
  const statement = (semi >= 0 ? sql.slice(0, toks[semi].i) : sql).trim();
  if (body.length === 0) return deny(sql, '空语句');
  const v = new Judge(body, dialect).judge(0);
  return {
    level: v.level,
    reasons: v.reasons,
    matchedRules: [],
    segments: [{ text: statement.slice(0, 200), level: v.level, reasons: v.reasons, ...(v.unknown ? { unknown: true } : {}) }],
    complex: false,
    parseError: false,
    verb: v.verb,
    statement,
    cursorable: v.level === 'L0' && !!v.cursorable,
    estimable: !!v.estimable,
  };
}

/** SQL 分级（文档一 6.31.5）。MySQL 按「反斜杠转义」和 NO_BACKSLASH_ESCAPES 两种方式各判断一次，取更严格的 */
export function classifySql(sql: string, dialect: SqlDialect): SqlClassification {
  const text = String(sql ?? '');
  if (new TextEncoder().encode(text).length > MAX_SQL_BYTES) return deny(text, `SQL 太长（超过 ${MAX_SQL_BYTES / 1024} KB）`);
  const a = once(text, dialect, true);
  if (dialect !== 'mysql') return a;
  const b = once(text, dialect, false);
  if (rankOf(b.level) > rankOf(a.level)) return { ...b, reasons: [...b.reasons, '（按 NO_BACKSLASH_ESCAPES 模式解析时更严格）'] };
  return a;
}

/** 拆出来的一条语句：原文和在整段 SQL 里的位置（不含结尾的分号） */
export interface SqlPiece {
  text: string;
  start: number;
  end: number;
}

/**
 * 按分号把一段 SQL 拆成多条（SQL 工作台的「执行全部」，文档一 6.32.1）：字符串、注释、带引号的名称里的分号不算。
 * 去不掉注释 / 字符串（例如没有结束的字符串）时整段作为一条返回，交给 classifySql 报错。只有空白和注释的片段丢掉。
 */
export function splitSql(sql: string, dialect: SqlDialect): SqlPiece[] {
  const src = String(sql ?? '');
  const st = strip(src, dialect, true);
  if ('error' in st) return src.trim() ? [{ text: src.trim(), start: 0, end: src.length }] : [];
  const out: SqlPiece[] = [];
  let from = 0;
  const push = (end: number): void => {
    const skel = st.skel.slice(from, end);
    if (skel.trim()) {
      const lead = src.slice(from, end).length - src.slice(from, end).trimStart().length;
      const text = src.slice(from, end).trim();
      out.push({ text, start: from + lead, end: from + lead + text.length });
    }
  };
  for (let i = 0; i < st.skel.length; i++) {
    if (st.skel[i] !== ';') continue;
    push(i);
    from = i + 1;
  }
  push(src.length);
  return out;
}

/** 光标所在的那条语句（光标在两条语句之间的空白里时取前一条） */
export function statementAt(sql: string, dialect: SqlDialect, offset: number): SqlPiece | null {
  const pieces = splitSql(sql, dialect);
  if (!pieces.length) return null;
  return pieces.find((p) => offset >= p.start && offset <= p.end + 1) ?? [...pieces].reverse().find((p) => p.start <= offset) ?? pieces[0];
}

/**
 * SQL 里引用的表（FROM / JOIN / UPDATE / INTO / TABLE / DESCRIBE 后面的名字），给 AI 挑表结构用（文档一 6.32.2）。
 * 带库名 / schema 的写法（db.t）只取最后一段；带引号的名称原样取出（去掉引号）。
 */
export function referencedTables(sql: string, dialect: SqlDialect): string[] {
  const src = String(sql ?? '');
  // 这里要保留带引号的名称：只去掉注释和字符串
  const st = strip(src, dialect, true);
  if ('error' in st) return [];
  const names = new Set<string>();
  const re = /\b(?:from|join|update|into|table|describe|desc)\s+((?:[`"[]?[\p{L}\p{N}_$]+[`"\]]?\s*\.\s*)*[`"[]?[\p{L}\p{N}_$]+[`"\]]?)/giu;
  // 骨架里带引号的名称已经被换成空格：在原文上找，但只接受骨架里关键字的位置
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0;
    if (st.skel.slice(at, at + 4).trim() === '') continue;
    const last = m[1].split('.').pop()!.trim().replace(/^[`"[]|[`"\]]$/g, '');
    if (last && !/^(select|lateral|unnest|dual|only)$/i.test(last)) names.add(last);
  }
  return [...names];
}
