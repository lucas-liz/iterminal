import { AGENT_POLICY_STRICTNESS, type AgentPolicy } from '@itm/protocol';
import { maxLevel, rankOf } from './classify';
import { DEFAULT_SECURITY, type Classification, type Decision, type EvaluateContext, type Evaluation, type RuleLevel } from './types';

/** HH:MM → 分钟 */
function minutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : 0;
}

/** 当前时间是否在窗口内（支持跨午夜，例如 22:00-06:00）；tz 为 IANA 时区，空则用本机时区 */
export function inWindow(now: Date, from: string, to: string, tz?: string): boolean {
  let cur: number;
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
      cur = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    } catch {
      cur = now.getHours() * 60 + now.getMinutes();
    }
  } else {
    cur = now.getHours() * 60 + now.getMinutes();
  }
  const a = minutes(from);
  const b = minutes(to);
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

function strictest(a: AgentPolicy, b: AgentPolicy): AgentPolicy {
  return AGENT_POLICY_STRICTNESS[a] >= AGENT_POLICY_STRICTNESS[b] ? a : b;
}

/**
 * 在风险判定的基础上应用策略（文档一 7.5 第 3、5 步），得到最终的执行决定：
 * - 主机级命令黑名单 → DENY；
 * - 生产环境分组：最低 L1（即使是「自动」权限，写操作也要审批）；
 * - 夜间窗口：禁止写操作；
 * - 有效 Agent 权限：DENY / READONLY / APPROVE / AI_REVIEW（按 APPROVE 判定，调用方再交给 AI）/ AUTO / AUTO_ALL（高危也自动）；
 * - 无人值守：权限上限 READONLY，写操作转为远程审批。
 */
export function applyPolicy(c: Classification, rawCommand: string, ctx: EvaluateContext, autoReadonly: boolean): Evaluation {
  const reasons = [...c.reasons];
  let level: RuleLevel = c.level;
  const done = (decision: Decision, extra?: string): Evaluation => {
    if (extra) reasons.push(extra);
    return { ...c, reasons: [...new Set(reasons)], effectiveLevel: level, decision };
  };
  const sec = ctx.policy.security ?? DEFAULT_SECURITY;
  if (rawCommand.length > sec.maxLength) {
    level = 'DENY';
    return done('DENY', `命令太长（超过 ${sec.maxLength} 个字符）`);
  }
  // 用户黑名单可以设置成「输入主机名确认」：只放宽自定义规则造成的禁止（文档一 6.15.7）
  let forceConfirm = false;
  if (level === 'DENY' && sec.blacklistDecision === 'CONFIRM') {
    const denySegs = c.segments.filter((s) => s.level === 'DENY');
    if (denySegs.length > 0 && denySegs.every((s) => String(s.ruleId ?? '').startsWith('u:'))) {
      level = 'L2';
      forceConfirm = true;
      reasons.push('命中黑名单：需要输入主机名确认');
    }
  }

  for (const pattern of ctx.hostDenylist ?? []) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern);
    } catch {
      re = null;
    }
    if (re && (re.test(rawCommand) || c.segments.some((s) => re!.test(s.text)))) {
      level = 'DENY';
      return done('DENY', `命中主机的命令黑名单（${pattern}）`);
    }
  }
  if (level === 'DENY') return done('DENY');

  const production = ctx.production || (ctx.folderNames ?? []).some((n) => ctx.policy.prodFolderNames.includes(n));
  if (production && rankOf(level) < rankOf(ctx.policy.prodFolderMinLevel)) {
    level = maxLevel(level, ctx.policy.prodFolderMinLevel);
    reasons.push(`生产环境：最低按 ${ctx.policy.prodFolderMinLevel} 处理`);
  }

  const nw = ctx.policy.nightWindow;
  if (nw.enabled && rankOf(level) >= 1 && inWindow(ctx.now ?? new Date(), nw.from, nw.to, nw.tz)) {
    level = 'DENY';
    return done('DENY', `夜间窗口（${nw.from}–${nw.to}）禁止写操作`);
  }

  const hostPolicy = ctx.agentPolicy;
  if (hostPolicy === 'DENY') {
    level = 'DENY';
    return done('DENY', 'Agent 在这台主机上被禁止执行命令（Agent 权限：禁止）');
  }
  if (hostPolicy === 'READONLY' && level !== 'L0') {
    level = 'DENY';
    return done('DENY', '这台主机的 Agent 权限是只读，不能执行写操作');
  }
  if (ctx.unattended) {
    const cap = strictest(hostPolicy, ctx.policy.unattendedCap);
    if (cap === 'DENY') {
      level = 'DENY';
      return done('DENY', '无人值守任务不允许执行命令');
    }
    if (cap === 'READONLY' && level !== 'L0') return done('REMOTE', '无人值守任务只允许只读命令，写操作需要远程审批');
    if (level === 'L2') return done('REMOTE', '高危命令需要远程审批');
    if (level === 'L1' && cap !== 'AUTO' && cap !== 'AUTO_ALL') return done('REMOTE', '写操作需要远程审批');
    return done('AUTO');
  }
  if (sec.strict && c.segments.some((s) => s.unknown)) {
    const unknown = c.segments.filter((s) => s.unknown).map((s) => s.text.split(' ')[0]);
    level = 'DENY';
    return done('DENY', `严格模式：「${[...new Set(unknown)].join('、')}」不在任何规则里`);
  }
  if (level === 'L2') {
    if (forceConfirm) return done('CONFIRM');
    if (sec.l2Decision === 'DENY') {
      level = 'DENY';
      return done('DENY', '高危命令：按命令安全设置直接拒绝');
    }
    // 「完全允许」取消了高危命令的二次确认：生产环境仍然要确认
    if (hostPolicy === 'AUTO_ALL' && !production) return done('AUTO', '完全允许：已取消高危命令的二次确认');
    if (sec.l2Decision === 'CONFIRM') return done('CONFIRM');
    return done('APPROVE');
  }
  // 生产环境里「完全允许」也要审批写操作
  const auto = (hostPolicy === 'AUTO' || hostPolicy === 'AUTO_ALL') && !production;
  if (level === 'L1') return done(auto ? 'AUTO' : 'APPROVE');
  return done(autoReadonly ? 'AUTO' : 'APPROVE');
}
