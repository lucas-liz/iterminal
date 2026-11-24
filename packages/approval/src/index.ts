import { classifyText, compileRules, DEFAULT_RULES, maxLevel, rankOf } from './classify';
import { createTreeSitterParser, fallbackParser, type ShellParser } from './parse';
import { applyPolicy } from './policy';
import type { Classification, CommandRule, EvaluateContext, Evaluation, LlmReviewer } from './types';

export * from './types';
export { DEFAULT_RULES, compileRules, unwrap, writeUsage, sedScriptSafe, sedScripts, maxLevel, rankOf } from './classify';
export { createTreeSitterParser, fallbackParser, splitCommand, tokenize, type ShellParser, type ParsedShell, type SimpleCommand } from './parse';
export { applyPolicy, inWindow } from './policy';
export { resolveHostPolicy } from './inherit';
export { classifySql, splitSql, statementAt, referencedTables, MAX_SQL_BYTES, type SqlClassification, type SqlDialect, type SqlPiece } from './sql';

/**
 * 审批引擎（文档一 7.5）。在 Main 进程执行，判定完全不依赖模型（LLM 复核只能升级），Agent 无法绕过。
 */
export class ApprovalEngine {
  private compiled;
  /** 用户自己的命令规则（文档一 6.15.7）：排在内置规则前面先匹配，id 以 u: 开头 */
  private userCompiled: ReturnType<typeof compileRules> = [];
  private userRules: CommandRule[] = [];
  /** 服务端下发的团队规则（账号模式）：最先匹配，用户规则不能放宽 */
  private teamCompiled: ReturnType<typeof compileRules> = [];
  private teamRules: CommandRule[] = [];

  constructor(
    private parser: ShellParser = fallbackParser,
    private rules: CommandRule[] = DEFAULT_RULES,
  ) {
    this.compiled = compileRules(rules);
  }

  get parserKind(): ShellParser['kind'] {
    return this.parser.kind;
  }

  /** 服务端下发新规则时替换（空数组表示回到内置默认规则） */
  setRules(rules: CommandRule[]): void {
    this.rules = rules.length ? rules : DEFAULT_RULES;
    this.compiled = compileRules(this.rules);
  }

  getRules(): CommandRule[] {
    return this.rules;
  }

  /** 设置用户规则（每个档案一套，打开档案时设置） */
  setUserRules(rules: CommandRule[]): void {
    this.userRules = rules;
    this.userCompiled = compileRules(rules);
  }

  getUserRules(): CommandRule[] {
    return this.userRules;
  }

  /** 设置团队规则（账号档案打开时、服务端策略更新时；本地模式为空） */
  setTeamRules(rules: CommandRule[]): void {
    this.teamRules = rules;
    this.teamCompiled = compileRules(rules);
  }

  getTeamRules(): CommandRule[] {
    return this.teamRules;
  }

  setParser(parser: ShellParser): void {
    this.parser = parser;
  }

  /** 只判定命令本身的风险。extraRules：主机 / 分组级的覆盖规则，优先于全局规则 */
  classify(command: string, extraRules: CommandRule[] = []): Classification {
    const extra = extraRules.length ? compileRules(extraRules) : [];
    // 团队规则排在最前面（文档一 6.15.7：登录后服务端下发的团队规则优先级最高）
    const builtin = [...extra, ...this.teamCompiled, ...this.compiled];
    if (!this.userCompiled.length) return classifyText(command, { rules: builtin, parser: this.parser });
    const withUser = classifyText(command, { rules: [...extra, ...this.teamCompiled, ...this.userCompiled, ...this.compiled], parser: this.parser });
    // 保护：内置规则或团队规则判定为高危（L2）的命令，不能被用户白名单降级（文档一 6.15.7）
    if (rankOf(withUser.level) < rankOf('L2')) {
      const base = classifyText(command, { rules: builtin, parser: this.parser });
      if (rankOf(base.level) >= rankOf('L2')) return { ...base, reasons: [...base.reasons, '内置规则判定为高危，自定义白名单不能放宽'] };
    }
    return withUser;
  }

  /**
   * 判定 + LLM 复核（可选）+ 策略。复核只在 L1、或者是复杂的 L0 命令时调用，结果只能升级风险。
   */
  async evaluate(
    command: string,
    ctx: EvaluateContext,
    opts: { autoReadonly: boolean; reviewer?: LlmReviewer; extraRules?: CommandRule[] } = { autoReadonly: true },
  ): Promise<Evaluation> {
    let c = this.classify(command, opts.extraRules);
    let reviewed: Evaluation['reviewed'];
    if (ctx.policy.allowLlmReview && opts.reviewer && (c.level === 'L1' || (c.level === 'L0' && c.complex))) {
      try {
        const r = await opts.reviewer(command, c);
        if (r && rankOf(r.level) > rankOf(c.level)) {
          reviewed = { from: c.level, to: r.level, reason: r.reason };
          c = { ...c, level: maxLevel(c.level, r.level), reasons: [...c.reasons.filter((x) => x !== '只读命令'), `AI 复核：${r.reason}`] };
        }
      } catch {
        // 复核失败不影响判定（规则判定本身已经足够保守）
      }
    }
    const e = applyPolicy(c, command, ctx, opts.autoReadonly);
    return reviewed ? { ...e, reviewed } : e;
  }
}

/** 创建使用 tree-sitter 的引擎；WASM 加载失败时退回简化解析（并在 parserKind 里体现） */
export async function createApprovalEngine(wasm: { bashWasm: string; treeSitterWasm?: string } | null, rules?: CommandRule[]): Promise<ApprovalEngine> {
  if (!wasm) return new ApprovalEngine(fallbackParser, rules);
  try {
    return new ApprovalEngine(await createTreeSitterParser(wasm), rules);
  } catch {
    return new ApprovalEngine(fallbackParser, rules);
  }
}
