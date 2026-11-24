import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EFFORTS, THINKING_CONTROLS, THINKING_STYLES, WEB_SEARCH_COUNT, type AgentPolicy, type AiModelConfig, type Effort, type ServerWebSearch, type ThinkingControl, type ThinkingStyle } from '@itm/protocol';
import type { CommandRule } from '@itm/approval';
import type { MaskRule } from '@itm/masking';
import { open, seal } from '../vault/vault';
import { hkdf } from '../../util/kdf';

/**
 * 服务端下发的 AI 策略（GET /api/v1/ai/policy，文档二 6.6）：团队命令规则、脱敏规则、无人值守权限上限、是否允许 LLM 复核。
 * 账号档案打开时先用本机缓存（离线也生效），连上服务端后拉取最新的。
 */
export interface TeamPolicy {
  version: string;
  commandRules: { id: string; name: string; matchType: 'PREFIX' | 'REGEX' | 'EXACT'; pattern: string; level: 'L0' | 'L1' | 'L2' | 'DENY'; reason: string; priority: number }[];
  maskRules: { id: string; name: string; pattern: string; replacement: string; forcePrivate: boolean }[];
  unattendedCap: AgentPolicy;
  allowLlmReview: boolean;
  /** 登录后是否还能用个人模型 */
  allowPersonalProvider: boolean;
  /** 团队模型（GET /api/v1/ai/models） */
  providers: TeamProvider[];
  /** 服务端配置的默认联网搜索（GET /api/v1/ai/web，第二十五轮；老版本服务端没有） */
  webSearch?: ServerWebSearch | null;
  fetchedAt: number;
}

/** 团队模型提供商（不含 Key） */
export interface TeamProvider {
  id: string;
  name: string;
  type: 'ANTHROPIC' | 'OPENAI' | 'OPENAI_COMPAT';
  thinkingStyle: ThinkingStyle;
  echoReasoning: boolean;
  models: AiModelConfig[];
}

const PROVIDER_TYPES = new Set(['ANTHROPIC', 'OPENAI', 'OPENAI_COMPAT']);
const THINKING = new Set<ThinkingStyle>(THINKING_STYLES);

/** 校验团队模型列表；格式不对的丢掉 */
export function sanitizeTeamProviders(raw: unknown): TeamProvider[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === 'object' && PROVIDER_TYPES.has(str((p as Record<string, unknown>).type, 20)))
    .slice(0, 100)
    .map((p: Record<string, unknown>) => ({
      id: str(p.id, 32).replace(/[^\w-]/g, ''),
      name: str(p.name, 100) || '团队模型',
      type: str(p.type, 20) as TeamProvider['type'],
      thinkingStyle: (THINKING.has(str(p.thinkingStyle, 20) as ThinkingStyle) ? str(p.thinkingStyle, 20) : 'none') as ThinkingStyle,
      echoReasoning: p.echoReasoning === true,
      models: (Array.isArray(p.models) ? p.models : [])
        .filter((m: Record<string, unknown>) => m && str(m.id, 200).trim())
        .slice(0, 100)
        .map((m: Record<string, unknown>) => ({
          id: str(m.id, 200).trim(),
          ...(str(m.displayName, 100) ? { displayName: str(m.displayName, 100) } : {}),
          contextWindow: Math.max(1024, Number(m.contextWindow) || 128_000),
          maxOutput: Math.max(256, Number(m.maxOutput) || 8192),
          supportsImages: m.supportsImages === true,
          ...(['none', 'optional', 'always'].includes(str(m.reasoning, 10)) ? { reasoning: str(m.reasoning, 10) as AiModelConfig['reasoning'] } : {}),
          ...(Array.isArray(m.efforts) && m.efforts.some((e) => EFFORTS.includes(e as Effort))
            ? { efforts: EFFORTS.filter((e) => (m.efforts as unknown[]).includes(e)) }
            : {}),
          ...(THINKING_CONTROLS.includes(str(m.thinkingControl, 10) as ThinkingControl) ? { thinkingControl: str(m.thinkingControl, 10) as ThinkingControl } : {}),
          ...(typeof m.supportsTools === 'boolean' ? { supportsTools: m.supportsTools } : {}),
          ...(m.imageFormat === 'base64' ? { imageFormat: 'base64' as const } : {}),
        })),
    }))
    .filter((p) => p.id && p.models.length);
}

const FILE = 'team-policy.bin';
const AAD = 'itm-team-policy-v1';
const MATCH = new Set(['PREFIX', 'REGEX', 'EXACT']);
const LEVELS = new Set(['L0', 'L1', 'L2', 'DENY']);
const CAPS = new Set<AgentPolicy>(['DENY', 'READONLY', 'APPROVE', 'AUTO']);

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max));
const keyOf = (vaultKey: Buffer): Buffer => hkdf(vaultKey, 'itm-team-policy-v1', 'cache');

/** 服务端的默认联网搜索（不含 Key）；没配置、格式不对时返回 null */
export function sanitizeServerWeb(raw: unknown): ServerWebSearch | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.enabled !== true) return null;
  const count = Math.round(Number(o.count));
  return {
    enabled: true,
    format: o.format === 'custom' ? 'custom' : 'deepseek',
    label: str(o.label, 60) || (o.format === 'custom' ? '自定义搜索' : 'DeepSeek'),
    count: count >= WEB_SEARCH_COUNT.min && count <= WEB_SEARCH_COUNT.max ? count : 8,
    fetch: o.fetch !== false,
  };
}

/** 校验服务端返回的策略；格式不对的规则丢掉，整体不对时返回 null（继续用缓存） */
export function sanitizeTeamPolicy(raw: unknown, now = Date.now(), providers?: unknown, web?: unknown): TeamPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  if (!Array.isArray(p.commandRules) || !Array.isArray(p.maskRules)) return null;
  const commandRules = (p.commandRules as Record<string, unknown>[])
    .filter((r) => r && MATCH.has(str(r.matchType, 10)) && LEVELS.has(str(r.level, 10)) && str(r.pattern, 500).trim())
    .slice(0, 1000)
    .map((r) => ({
      id: str(r.id, 64),
      name: str(r.name, 100),
      matchType: str(r.matchType, 10) as TeamPolicy['commandRules'][number]['matchType'],
      pattern: str(r.pattern, 500),
      level: str(r.level, 10) as TeamPolicy['commandRules'][number]['level'],
      reason: str(r.reason, 200),
      priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100,
    }));
  const maskRules = (p.maskRules as Record<string, unknown>[])
    .filter((r) => r && str(r.pattern, 500).trim())
    .slice(0, 500)
    .map((r) => ({ id: str(r.id, 64), name: str(r.name, 100), pattern: str(r.pattern, 500), replacement: str(r.replacement, 100) || '****', forcePrivate: r.forcePrivate === true }));
  const cap = str(p.unattendedCap, 10) as AgentPolicy;
  return {
    version: str(p.version, 64),
    commandRules,
    maskRules,
    unattendedCap: CAPS.has(cap) ? cap : 'READONLY',
    allowLlmReview: p.allowLlmReview !== false,
    allowPersonalProvider: p.allowPersonalProvider !== false,
    providers: sanitizeTeamProviders(providers ?? p.providers),
    webSearch: sanitizeServerWeb(web ?? p.webSearch),
    fetchedAt: now,
  };
}

/** 团队命令规则交给审批引擎：排在用户规则和内置规则前面 */
export function teamRulesOf(p: TeamPolicy | null): CommandRule[] {
  return (p?.commandRules ?? []).map((r) => ({
    id: `t:${r.id}`,
    level: r.level,
    matchType: r.matchType,
    pattern: r.pattern,
    priority: r.priority,
    scopeType: 'GLOBAL',
    note: r.reason || `团队规则：${r.name}`,
    enabled: true,
  }));
}

/** 团队脱敏规则：发给模型之前替换（不可还原） */
export function teamMaskRulesOf(p: TeamPolicy | null): MaskRule[] {
  return (p?.maskRules ?? []).map((r) => ({
    id: `t:${r.id}`,
    name: r.name,
    kind: 'REGEX',
    pattern: r.pattern,
    replacement: r.replacement,
    reversible: false,
    forcePrivateModel: r.forcePrivate,
    enabled: true,
  }));
}

export function readTeamPolicy(dir: string, vaultKey: Buffer): TeamPolicy | null {
  const file = join(dir, FILE);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(open(keyOf(vaultKey), readFileSync(file), AAD)) as { fetchedAt?: number };
    return sanitizeTeamPolicy(raw, Number(raw?.fetchedAt) || Date.now());
  } catch {
    return null;
  }
}

export function writeTeamPolicy(dir: string, vaultKey: Buffer, p: TeamPolicy): void {
  const file = join(dir, FILE);
  writeFileSync(`${file}.tmp`, seal(keyOf(vaultKey), JSON.stringify(p), AAD), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
