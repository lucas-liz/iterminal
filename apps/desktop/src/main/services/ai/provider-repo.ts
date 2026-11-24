import { randomUUID } from 'node:crypto';
import { DEFAULT_THINKING_STYLE, EFFORTS, THINKING_CONTROLS, THINKING_STYLES, inferReasoning, vendorPreset, type AiModelConfig, type AiProvider, type AiProviderInput, type AiProviderType, type Effort, type ModelProbe, type ModelRef, type ReasoningSupport, type ThinkingStyle } from '@itm/protocol';
import type { Db } from '../db/database';
import { open, seal } from '../vault/vault';
import { UserError } from '../../util/errors';

const TYPES: readonly AiProviderType[] = ['ANTHROPIC', 'OPENAI', 'OPENAI_COMPAT', 'OLLAMA'];
const REASONING: readonly ReasoningSupport[] = ['none', 'optional', 'always'];

/** 各类型的默认地址 */
export const DEFAULT_BASE_URL: Record<AiProviderType, string> = {
  ANTHROPIC: 'https://api.anthropic.com',
  OPENAI: 'https://api.openai.com/v1',
  OPENAI_COMPAT: '',
  OLLAMA: 'http://localhost:11434/v1',
};

interface Row {
  id: string;
  name: string;
  type: AiProviderType;
  base_url: string;
  api_key_enc: Buffer | null;
  models: string | null;
  enabled: number;
  vendor: string | null;
  thinking_style: string | null;
  echo_reasoning: number;
  updated_at: number;
}

/** 主进程内部使用：带解密后的 Key */
export interface ResolvedModel {
  provider: AiProvider;
  apiKey: string | null;
  model: AiModelConfig;
}

/** 团队模型（账号模式，服务端下发）：经服务端代理调用，用登录令牌鉴权 */
export interface TeamModelSource {
  providers(): { id: string; name: string; type: 'ANTHROPIC' | 'OPENAI' | 'OPENAI_COMPAT'; thinkingStyle: ThinkingStyle; echoReasoning: boolean; models: AiModelConfig[] }[];
  /** 服务端地址和当前的访问令牌；没登录或令牌失效时返回 null */
  endpoint(): { serverUrl: string; token: string | null } | null;
  /** 是否还允许个人模型 */
  allowPersonal(): boolean;
}

export const TEAM_PREFIX = 'team:';
const isTeam = (id: string | null | undefined): boolean => !!id && id.startsWith(TEAM_PREFIX);
const PERSONAL_BLOCKED = '管理员只允许使用团队模型';

/** 个人模型提供商（文档一 7.9）。API Key 用保险库密钥加密保存，不会返回给渲染进程；账号模式下还会列出团队模型。 */
export class AiProviderRepo {
  private team: TeamModelSource | null = null;
  /** 不能使用 AI 的原因（本地模式没有登录，第十二轮）；null 表示可以使用 */
  private gate: () => string | null = () => null;

  constructor(
    private readonly db: Db,
    private readonly vaultKey: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  /** 账号档案打开时设置团队模型来源 */
  setTeam(team: TeamModelSource | null): void {
    this.team = team;
  }

  /** 所有模型调用和模型配置都先经过这里：本地模式（没有登录）时拒绝 */
  setGate(gate: () => string | null): void {
    this.gate = gate;
  }

  private checkGate(): void {
    const reason = this.gate();
    if (reason) throw new UserError(reason);
  }

  private teamProviders(): AiProvider[] {
    return (this.team?.providers() ?? []).map((p) => ({
      id: `${TEAM_PREFIX}${p.id}`,
      name: p.name,
      type: p.type,
      baseUrl: '',
      hasKey: true,
      models: p.models,
      enabled: true,
      vendor: null,
      thinkingStyle: p.thinkingStyle,
      echoReasoning: p.echoReasoning,
      updatedAt: 0,
      source: 'team' as const,
      blocked: null,
    }));
  }

  /** 团队模型在前；管理员只允许团队模型时，个人模型标记为不能使用 */
  list(): AiProvider[] {
    const blocked = this.team && !this.team.allowPersonal() ? PERSONAL_BLOCKED : null;
    const personal = this.db
      .prepare<[], Row>('SELECT * FROM ai_provider WHERE deleted = 0 ORDER BY sort, name COLLATE NOCASE')
      .all()
      .map(toProvider)
      .map((p) => (blocked ? { ...p, enabled: false, blocked } : p));
    return [...this.teamProviders(), ...personal];
  }

  get(id: string): AiProvider | null {
    if (isTeam(id)) return this.teamProviders().find((p) => p.id === id) ?? null;
    const row = this.db.prepare<[string], Row>('SELECT * FROM ai_provider WHERE id = ? AND deleted = 0').get(id);
    return row ? toProvider(row) : null;
  }

  save(id: string | null, input: AiProviderInput): AiProvider {
    this.checkGate();
    if (isTeam(id)) throw new UserError('团队模型由管理员在管理后台配置，不能在这里修改');
    const v = validate(input);
    const now = this.now();
    if (id) {
      const current = this.db.prepare<[string], Row>('SELECT * FROM ai_provider WHERE id = ? AND deleted = 0').get(id);
      if (!current) throw new UserError('模型提供商不存在');
      const key = input.apiKey === undefined ? current.api_key_enc : input.apiKey ? seal(this.vaultKey, input.apiKey, `ai_provider:${id}`) : null;
      this.db
        .prepare('UPDATE ai_provider SET name = ?, type = ?, base_url = ?, api_key_enc = ?, models = ?, enabled = ?, vendor = ?, thinking_style = ?, echo_reasoning = ?, updated_at = ? WHERE id = ?')
        .run(v.name, v.type, v.baseUrl, key, JSON.stringify(v.models), v.enabled ? 1 : 0, v.vendor, v.thinkingStyle, v.echoReasoning ? 1 : 0, now, id);
      return this.get(id)!;
    }
    const newId = randomUUID();
    const key = input.apiKey ? seal(this.vaultKey, input.apiKey, `ai_provider:${newId}`) : null;
    this.db
      .prepare(
        'INSERT INTO ai_provider (id, name, type, base_url, api_key_enc, models, enabled, vendor, thinking_style, echo_reasoning, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(newId, v.name, v.type, v.baseUrl, key, JSON.stringify(v.models), v.enabled ? 1 : 0, v.vendor, v.thinkingStyle, v.echoReasoning ? 1 : 0, now);
    return this.get(newId)!;
  }

  delete(id: string): void {
    this.checkGate();
    if (isTeam(id)) throw new UserError('团队模型由管理员在管理后台配置，不能在这里删除');
    this.db.prepare('UPDATE ai_provider SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
  }

  /** 解析模型引用（带 Key），找不到或已停用时报错 */
  resolve(ref: ModelRef): ResolvedModel {
    this.checkGate();
    if (isTeam(ref.providerId)) return this.resolveTeam(ref);
    if (this.team && !this.team.allowPersonal()) throw new UserError(`${PERSONAL_BLOCKED}，请在「设置 → AI 模型」里选择团队模型`);
    const row = this.db.prepare<[string], Row>('SELECT * FROM ai_provider WHERE id = ? AND deleted = 0').get(ref.providerId);
    if (!row) throw new UserError('选择的模型提供商不存在，请在「设置 → AI 模型」里重新选择');
    const provider = toProvider(row);
    if (!provider.enabled) throw new UserError(`模型提供商「${provider.name}」已停用`);
    const model = provider.models.find((m) => m.id === ref.modelId);
    if (!model) throw new UserError(`「${provider.name}」里没有模型 ${ref.modelId}`);
    return { provider, apiKey: row.api_key_enc ? open(this.vaultKey, row.api_key_enc, `ai_provider:${row.id}`) : null, model };
  }

  /** 团队模型：接口地址换成服务端的代理，Key 用当前的访问令牌 */
  private resolveTeam(ref: ModelRef): ResolvedModel {
    const provider = this.teamProviders().find((p) => p.id === ref.providerId);
    if (!provider) throw new UserError('这个团队模型已经不可用（管理员可能删除或停用了），请在「设置 → AI 模型」里重新选择');
    const model = provider.models.find((m) => m.id === ref.modelId);
    if (!model) throw new UserError(`团队模型「${provider.name}」里没有模型 ${ref.modelId}`);
    const ep = this.team?.endpoint();
    if (!ep?.token) throw new UserError('团队模型需要登录服务端，登录已过期时请重新登录');
    const id = provider.id.slice(TEAM_PREFIX.length);
    return { provider: { ...provider, baseUrl: `${ep.serverUrl.replace(/\/+$/, '')}/api/v1/llm/proxy/${encodeURIComponent(id)}` }, apiKey: ep.token, model };
  }

  /** 测试连接用：按表单内容（可能还没保存）构造，留空的 Key 沿用已保存的 */
  resolveDraft(id: string | null, input: AiProviderInput, modelId: string): ResolvedModel {
    this.checkGate();
    if (isTeam(id)) return this.resolveTeam({ providerId: id!, modelId });
    const v = validate(input);
    let apiKey: string | null = input.apiKey ?? null;
    if (input.apiKey === undefined && id) {
      const row = this.db.prepare<[string], Row>('SELECT * FROM ai_provider WHERE id = ?').get(id);
      apiKey = row?.api_key_enc ? open(this.vaultKey, row.api_key_enc, `ai_provider:${id}`) : null;
    }
    const model = v.models.find((m) => m.id === modelId) ?? v.models[0];
    const provider: AiProvider = { id: id ?? '__draft__', ...v, hasKey: !!apiKey, updatedAt: this.now() };
    return { provider, apiKey, model };
  }
}

function validate(input: AiProviderInput): Omit<AiProvider, 'id' | 'hasKey' | 'updatedAt'> {
  const name = (input.name ?? '').trim();
  if (!name) throw new UserError('请填写名称');
  if (!TYPES.includes(input.type)) throw new UserError('不支持的提供商类型');
  const baseUrl = ((input.baseUrl ?? '').trim() || DEFAULT_BASE_URL[input.type]).replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/.test(baseUrl)) throw new UserError('接口地址必须以 http:// 或 https:// 开头');
  if (!Array.isArray(input.models) || input.models.length === 0) throw new UserError('至少添加一个模型');
  const ids = new Set<string>();
  const models = input.models.map((m): AiModelConfig => {
    const id = (m.id ?? '').trim();
    if (!id) throw new UserError('模型 ID 不能为空');
    if (ids.has(id)) throw new UserError(`模型 ${id} 重复`);
    ids.add(id);
    const contextWindow = Math.floor(Number(m.contextWindow));
    const maxOutput = Math.floor(Number(m.maxOutput));
    if (!(contextWindow >= 1000)) throw new UserError(`模型 ${id} 的上下文窗口不合法`);
    if (!(maxOutput >= 256 && maxOutput <= contextWindow)) throw new UserError(`模型 ${id} 的最大输出不合法`);
    const effort = m.effort && EFFORTS.includes(m.effort) ? m.effort : null;
    const num = (x: unknown, min: number, max: number, label: string): number | null => {
      if (x === null || x === undefined || x === '') return null;
      const n = Number(x);
      if (!Number.isFinite(n) || n < min || n > max) throw new UserError(`模型 ${id} 的${label}应在 ${min}–${max} 之间`);
      return n;
    };
    const reasoning = m.reasoning && REASONING.includes(m.reasoning) ? m.reasoning : inferReasoning(input.type, id);
    const thinkingBudget = num(m.thinkingBudget, 128, 1_000_000, '思考预算');
    return {
      id,
      displayName: m.displayName?.trim() || undefined,
      contextWindow,
      maxOutput,
      effort,
      reasoning,
      thinkingDefault: typeof m.thinkingDefault === 'boolean' ? m.thinkingDefault : null,
      efforts: Array.isArray(m.efforts) && m.efforts.length ? EFFORTS.filter((e) => m.efforts!.includes(e)) : null,
      thinkingBudget: thinkingBudget === null ? null : Math.floor(thinkingBudget),
      temperature: num(m.temperature, 0, 2, '温度'),
      topP: num(m.topP, 0, 1, 'Top-P'),
      supportsImages: !!m.supportsImages,
      thinkingControl: m.thinkingControl && THINKING_CONTROLS.includes(m.thinkingControl) ? m.thinkingControl : null,
      supportsTools: typeof m.supportsTools === 'boolean' ? m.supportsTools : null,
      imageFormat: m.imageFormat === 'base64' ? 'base64' : null,
      probe: cleanProbe(m.probe),
    };
  });
  const vendor = input.vendor && vendorPreset(input.vendor) ? input.vendor : null;
  const thinkingStyle = styleOf(input.thinkingStyle, vendor, input.type);
  return { name, type: input.type, baseUrl, models, enabled: input.enabled !== false, vendor, thinkingStyle, echoReasoning: !!input.echoReasoning };
}

/** 检测结果只保留认识的字段（来自渲染进程的表单） */
function cleanProbe(p: unknown): ModelProbe | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  const notes: Record<string, string> = {};
  if (o.notes && typeof o.notes === 'object') {
    for (const [k, v] of Object.entries(o.notes as Record<string, unknown>)) if (['connect', 'context', 'images', 'tools', 'thinking'].includes(k) && typeof v === 'string') notes[k] = v.slice(0, 300);
  }
  return {
    at: Number(o.at) || 0,
    contextWindow: Number.isInteger(o.contextWindow) && (o.contextWindow as number) >= 1000 ? (o.contextWindow as number) : null,
    images: bool(o.images),
    imageFormat: o.imageFormat === 'base64' ? 'base64' : o.imageFormat === 'data-url' ? 'data-url' : null,
    tools: bool(o.tools),
    reasoning: REASONING.includes(o.reasoning as ReasoningSupport) ? (o.reasoning as ReasoningSupport) : null,
    thinkingControl: THINKING_CONTROLS.includes(o.thinkingControl as never) ? (o.thinkingControl as ModelProbe['thinkingControl']) : null,
    efforts: Array.isArray(o.efforts) ? EFFORTS.filter((e) => (o.efforts as unknown[]).includes(e)) : null,
    notes,
  };
}

/** 发送方式：不认识的（例如已经去掉的 model-switch）换成厂商预设的方式，没有预设时用协议默认的 */
function styleOf(style: string | null | undefined, vendor: string | null, type: AiProviderType): ThinkingStyle {
  if (style && THINKING_STYLES.includes(style as ThinkingStyle)) return style as ThinkingStyle;
  return vendorPreset(vendor)?.thinkingStyle ?? DEFAULT_THINKING_STYLE[type];
}

function toProvider(r: Row): AiProvider {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    baseUrl: r.base_url,
    hasKey: !!r.api_key_enc,
    models: (r.models ? (JSON.parse(r.models) as AiModelConfig[]) : []).map((m) => ({ ...m, reasoning: m.reasoning ?? inferReasoning(r.type, m.id) })),
    enabled: !!r.enabled,
    vendor: r.vendor,
    thinkingStyle: styleOf(r.thinking_style, r.vendor, r.type),
    echoReasoning: !!r.echo_reasoning,
    updatedAt: r.updated_at,
  };
}
