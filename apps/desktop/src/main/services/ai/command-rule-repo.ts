import { randomUUID } from 'node:crypto';
import type { CommandRule } from '@itm/approval';
import type { CommandMatchType, CommandRuleList, RiskLevel, UserCommandRule, UserCommandRuleInput } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';

const LEVELS: readonly RiskLevel[] = ['L0', 'L1', 'L2', 'DENY'];
const MATCH: readonly CommandMatchType[] = ['PREFIX', 'REGEX', 'EXACT'];
const LIST_LEVEL: Record<CommandRuleList, RiskLevel> = { WHITE: 'L0', DANGER: 'L2', BLACK: 'DENY' };
/** 快捷名单之间的顺序：黑名单 > 危险命令 > 白名单（同一个前缀同时在多个名单里时，更严格的先匹配） */
const LIST_PRIORITY: Record<CommandRuleList, number> = { BLACK: 1, DANGER: 2, WHITE: 3 };
const MAX_RULES = 500;
const MAX_PATTERN = 500;

interface Row {
  id: string;
  list: CommandRuleList | null;
  level: RiskLevel;
  match_type: CommandMatchType;
  pattern: string;
  priority: number;
  note: string | null;
  enabled: number;
  updated_at: number;
}

const toRule = (r: Row): UserCommandRule => ({
  id: r.id,
  list: r.list,
  level: r.level,
  matchType: r.match_type,
  pattern: r.pattern,
  priority: r.priority,
  note: r.note,
  enabled: !!r.enabled,
  updatedAt: r.updated_at,
});

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 规则匹配的是去掉 sudo、env 等包装后的命令文本，用户填写的前缀也去掉这些包装和多余空白 */
export function normalizePattern(p: string): string {
  return p
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^(sudo|doas)\s+/, '');
}

/**
 * 用户自己的命令规则（文档一 6.15.7）。快捷名单按前缀匹配（按词边界：「ls」不会匹配「lsblk」）；
 * 交给审批引擎时 id 加 u: 前缀，排在内置规则前面。
 */
export class CommandRuleRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(): UserCommandRule[] {
    return this.db
      .prepare<[], Row>('SELECT * FROM command_rule ORDER BY list IS NULL, list, priority, created_at')
      .all()
      .map(toRule);
  }

  save(id: string | null, input: UserCommandRuleInput): UserCommandRule {
    const v = this.validate(input);
    const now = this.now();
    if (id) {
      const cur = this.db.prepare<[string], Row>('SELECT * FROM command_rule WHERE id = ?').get(id);
      if (!cur) throw new UserError('规则不存在');
      if (cur.list) throw new UserError('名单里的条目请在名单里修改');
      this.db
        .prepare('UPDATE command_rule SET level = ?, match_type = ?, pattern = ?, priority = ?, note = ?, enabled = ?, updated_at = ? WHERE id = ?')
        .run(v.level, v.matchType, v.pattern, v.priority, v.note, v.enabled ? 1 : 0, now, id);
      return toRule(this.db.prepare<[string], Row>('SELECT * FROM command_rule WHERE id = ?').get(id)!);
    }
    this.ensureRoom(1);
    const newId = randomUUID();
    this.db
      .prepare('INSERT INTO command_rule (id, list, level, match_type, pattern, priority, note, enabled, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId, v.level, v.matchType, v.pattern, v.priority, v.note, v.enabled ? 1 : 0, now, now);
    return toRule(this.db.prepare<[string], Row>('SELECT * FROM command_rule WHERE id = ?').get(newId)!);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM command_rule WHERE id = ?').run(id);
  }

  /** 替换一个快捷名单（按前缀匹配，自动去重） */
  setList(list: CommandRuleList, patterns: string[]): UserCommandRule[] {
    if (!(list in LIST_LEVEL)) throw new UserError('名单不存在');
    const clean = [...new Set((patterns ?? []).map((p) => normalizePattern(String(p))).filter(Boolean))];
    for (const p of clean) if (p.length > MAX_PATTERN) throw new UserError(`「${p.slice(0, 20)}…」太长`);
    const others = (this.db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM command_rule WHERE list IS NOT ?').get(list)?.n ?? 0) as number;
    if (others + clean.length > MAX_RULES) throw new UserError(`规则最多 ${MAX_RULES} 条`);
    const now = this.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM command_rule WHERE list = ?').run(list);
      const ins = this.db.prepare(
        'INSERT INTO command_rule (id, list, level, match_type, pattern, priority, note, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)',
      );
      clean.forEach((p, i) => ins.run(randomUUID(), list, LIST_LEVEL[list], 'PREFIX', p, i, now + i, now));
    })();
    return this.list().filter((r) => r.list === list);
  }

  /** 清空全部用户规则（恢复默认） */
  reset(): void {
    this.db.prepare('DELETE FROM command_rule').run();
  }

  /** 交给审批引擎的规则 */
  toEngineRules(): CommandRule[] {
    return this.list()
      .filter((r) => r.enabled)
      .map((r) => {
        const pattern = r.matchType === 'PREFIX' ? `^${escapeRe(r.pattern)}(\\s|$)` : r.pattern;
        return {
          id: `u:${r.id}`,
          level: r.level,
          matchType: r.matchType === 'PREFIX' ? 'REGEX' : r.matchType,
          pattern,
          priority: r.list ? LIST_PRIORITY[r.list] : 10 + r.priority,
          note: r.note ?? (r.list === 'WHITE' ? '白名单' : r.list === 'DANGER' ? '危险命令' : r.list === 'BLACK' ? '黑名单' : '自定义规则'),
          enabled: true,
        } satisfies CommandRule;
      });
  }

  private ensureRoom(n: number): void {
    const count = this.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM command_rule').get()?.n ?? 0;
    if (count + n > MAX_RULES) throw new UserError(`规则最多 ${MAX_RULES} 条`);
  }

  private validate(input: UserCommandRuleInput): Required<Omit<UserCommandRuleInput, 'note'>> & { note: string | null } {
    if (!LEVELS.includes(input.level)) throw new UserError('风险等级不合法');
    if (!MATCH.includes(input.matchType)) throw new UserError('匹配方式不合法');
    const pattern = input.matchType === 'REGEX' ? (input.pattern ?? '').trim() : normalizePattern(input.pattern ?? '');
    if (!pattern) throw new UserError('请填写匹配内容');
    if (pattern.length > MAX_PATTERN) throw new UserError('匹配内容太长');
    if (input.matchType === 'REGEX') {
      try {
        new RegExp(pattern.replace(/^\(\?i\)/, ''));
      } catch (e) {
        throw new UserError(`正则表达式不合法：${(e as Error).message}`);
      }
    }
    const priority = Number.isInteger(input.priority) ? Math.max(0, Math.min(9999, input.priority as number)) : 100;
    const note = (input.note ?? '').trim().slice(0, 200) || null;
    return { level: input.level, matchType: input.matchType, pattern, priority, note, enabled: input.enabled !== false };
  }
}
