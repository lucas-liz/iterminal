/**
 * 发送给模型之前的脱敏（文档一 7.7）。按顺序处理：
 * | 规则              | 示例                                   | 还原 |
 * | 私钥 / 证书块     | -----BEGIN … PRIVATE KEY----- → [已隐藏私钥] | 永不 |
 * | 密码、Token、AK   | 赋值写法、Bearer、JWT、高熵字符串 → **** / [SECRET_n] | 永不 |
 * | IP 地址（可选）   | 10.12.3.21 → HOST_IP_1                 | 模型在工具参数里用到时，执行前还原 |
 * | 手机号 / 身份证   | → [PII_n]                              | 永不 |
 * 只作用于发给模型的内容，界面上仍然显示原文。
 */

/** 服务端下发的脱敏规则（ai_mask_rule） */
export interface MaskRule {
  id: number | string;
  name: string;
  kind: 'REGEX' | 'ENTROPY' | 'BUILTIN';
  pattern?: string | null;
  /** 例如 [SECRET_{n}]；{n} 按不同的原文编号 */
  replacement: string;
  /** 能否在工具参数里还原（例如 IP） */
  reversible: boolean;
  /** 命中后这个会话强制使用内网模型 */
  forcePrivateModel: boolean;
  enabled?: boolean;
}

export interface MaskOptions {
  /** 把 IPv4 地址替换成 HOST_IP_n（模型调用工具时自动还原） */
  maskIps: boolean;
  /** 手机号、身份证号 */
  maskPii: boolean;
  /** 服务端规则（在内置规则之后执行） */
  rules?: MaskRule[];
}

/** 可以持久化的映射表（保存在本地加密库里，重启后编号保持一致） */
export interface MaskerState {
  /** 占位符 → 原文（只有可还原的才保存） */
  reversible: Record<string, string>;
  /** 每种占位符前缀的下一个编号，以及原文 → 占位符（不可还原的只保存原文的哈希，不保存原文） */
  counters: Record<string, number>;
  seen: Record<string, string>;
}

export interface MaskResult {
  text: string;
  /** 命中的规则名称和次数 */
  hits: Record<string, number>;
  /** 命中了「强制内网模型」的规则 */
  forcePrivate: boolean;
}

const emptyState = (): MaskerState => ({ reversible: {}, counters: {}, seen: {} });

/** 字符串的香农熵（每个字符的比特数） */
export function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** 看起来像随机生成的密钥：够长、大小写和数字都有、熵高（排除纯十六进制的哈希、路径、普通单词） */
export function looksLikeSecret(token: string): boolean {
  if (token.length < 32 || token.length > 512) return false;
  if (/^[0-9a-f]+$/i.test(token)) return false;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false;
  return entropy(token) >= 4.3;
}

/** 18 位身份证校验码 */
function validIdCard(id: string): boolean {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const codes = '10X98765432';
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(id[i]) * w[i];
  return codes[sum % 11] === id[17].toUpperCase();
}

function hashKey(s: string): string {
  // 不需要密码学强度：只用来让同一个原文得到同一个编号，避免在内存 / 库里保存不可还原的原文
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}${s.length}`;
}

type Replacer = (m: string, ...groups: string[]) => string;

/**
 * 一个会话一个 Masker：同一个原文在整个会话里得到同一个占位符（模型能分清「这台」和「那台」）。
 */
export class Masker {
  private state: MaskerState;
  private readonly custom: { rule: MaskRule; re: RegExp }[];

  constructor(
    private readonly opts: MaskOptions = { maskIps: false, maskPii: true },
    state?: MaskerState,
  ) {
    this.state = state ? { reversible: { ...state.reversible }, counters: { ...state.counters }, seen: { ...state.seen } } : emptyState();
    this.custom = [];
    for (const rule of opts.rules ?? []) {
      if (rule.enabled === false || rule.kind !== 'REGEX' || !rule.pattern) continue;
      let src = rule.pattern;
      let flags = 'g';
      if (src.startsWith('(?i)')) {
        src = src.slice(4);
        flags += 'i';
      }
      try {
        this.custom.push({ rule, re: new RegExp(src, flags) });
      } catch {
        // 不兼容的正则跳过
      }
    }
  }

  snapshot(): MaskerState {
    return { reversible: { ...this.state.reversible }, counters: { ...this.state.counters }, seen: { ...this.state.seen } };
  }

  /** 为原文分配占位符（同一原文同一编号） */
  private placeholder(template: string, original: string, reversible: boolean): string {
    const key = `${template}\u0000${hashKey(original)}`;
    const existing = this.state.seen[key];
    if (existing) return existing;
    const prefix = template.replace('{n}', '');
    const n = (this.state.counters[prefix] ?? 0) + 1;
    this.state.counters[prefix] = n;
    const ph = template.includes('{n}') ? template.replace('{n}', String(n)) : `${template}${n}`;
    this.state.seen[key] = ph;
    if (reversible) this.state.reversible[ph] = original;
    return ph;
  }

  mask(text: string): MaskResult {
    const hits: Record<string, number> = {};
    let forcePrivate = false;
    const hit = (name: string): void => {
      hits[name] = (hits[name] ?? 0) + 1;
    };
    let out = text;
    const apply = (name: string, re: RegExp, to: Replacer): void => {
      out = out.replace(re, (...args: unknown[]) => {
        hit(name);
        const [m, ...groups] = args as string[];
        return to(m, ...groups);
      });
    };

    apply('私钥', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, () => '[已隐藏私钥]');
    // 前面不能是字母（DB_PASSWORD、MYSQL_PWD 这类带前缀的变量名也要命中）
    apply(
      '密码',
      /(?<![a-z])((?:password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|auth|credential)["']?\s*[:=]\s*["']?)([^\s"',;]{3,})/gi,
      (_m, k) => `${k}****`,
    );
    apply('云 AK', /\b(AKIA|ASIA|LTAI)[0-9A-Za-z]{12,}/g, (m) => `${m.slice(0, 4)}****`);
    apply('Bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g, () => 'Bearer ****');
    apply('JWT', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => '[JWT]');
    apply('API Key', /\b(sk|pk|rk|ghp|gho|glpat|xox[abp])[-_][A-Za-z0-9_-]{16,}/g, (m) => `${m.slice(0, 3)}****`);
    apply('URL 密码', /(\w+:\/\/[^\s:/@]+:)[^\s@/]+@/g, (_m, p) => `${p}****@`);
    apply('mysql 密码', /(mysql(?:dump|admin)?\s+[^\n]*?\s-p)(\S+)/g, (_m, p) => `${p}****`);
    // 高熵字符串（随机生成的密钥、令牌）
    apply('高熵字符串', /[A-Za-z0-9_+=-]{32,}/g, (m) => (looksLikeSecret(m) ? this.placeholder('[SECRET_{n}]', m, false) : (hits['高熵字符串']--, m)));

    if (this.opts.maskPii) {
      apply('手机号', /(?<!\d)1[3-9]\d{9}(?!\d)/g, (m) => this.placeholder('[PII_{n}]', m, false));
      apply('身份证号', /(?<![\dXx])\d{17}[\dXx](?![\dXx])/g, (m) => (validIdCard(m) ? this.placeholder('[PII_{n}]', m, false) : (hits['身份证号']--, m)));
    }

    for (const { rule, re } of this.custom) {
      const before = out;
      apply(rule.name, re, (m) => (rule.replacement.includes('{n}') ? this.placeholder(rule.replacement, m, rule.reversible) : rule.replacement));
      if (before !== out && rule.forcePrivateModel) forcePrivate = true;
    }

    if (this.opts.maskIps) {
      apply('IP 地址', /(?<![\d.])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?![\d.])/g, (m) =>
        /^(127\.|0\.0\.0\.0$|255\.)/.test(m) ? (hits['IP 地址']--, m) : this.placeholder('HOST_IP_{n}', m, true),
      );
    }
    for (const k of Object.keys(hits)) if (hits[k] <= 0) delete hits[k];
    return { text: out, hits, forcePrivate };
  }

  /** 模型在工具参数里使用了可还原的占位符（HOST_IP_1）：执行前换回原文 */
  restore(text: string): string {
    const keys = Object.keys(this.state.reversible).sort((a, b) => b.length - a.length);
    if (keys.length === 0) return text;
    let out = text;
    for (const k of keys) out = out.split(k).join(this.state.reversible[k]);
    return out;
  }

  /** 递归还原对象里的字符串（工具参数） */
  restoreArgs<T>(value: T): T {
    if (typeof value === 'string') return this.restore(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.restoreArgs(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.restoreArgs(v)])) as T;
    }
    return value;
  }
}

/** 不需要会话状态的一次性脱敏（日志、错误信息） */
export function mask(text: string): string {
  return new Masker({ maskIps: false, maskPii: false }).mask(text).text;
}
