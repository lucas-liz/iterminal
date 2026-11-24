import { isAbsolute } from 'node:path';
import { EFFORTS, AGENT_POLICIES, checkHighlightPattern, DEFAULT_SETTINGS, NAV_OPTIONAL, isHexColor, isShortcutMap, TERMINAL_COLOR_KEYS, TERMINAL_CONTEXT_LINES, WEB_SEARCH_COUNT, type HighlightSettings, type Settings, type TerminalColorSettings } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';

type Validator<K extends keyof Settings> = (v: unknown) => v is Settings[K];

/** 终端背景媒体在档案目录 appearance/ 里的文件名（选择背景时由主进程生成） */
export const BACKGROUND_FILE = /^bg-[\w-]{1,64}\.(png|jpe?g|gif|webp|bmp|mp4|webm|mov|m4v)$/i;

function isModelRef(v: unknown): v is Settings['ai.defaultModel'] {
  return (
    v === null ||
    (typeof v === 'object' && typeof (v as { providerId?: unknown }).providerId === 'string' && typeof (v as { modelId?: unknown }).modelId === 'string')
  );
}

function isTerminalColors(v: unknown): v is TerminalColorSettings {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<TerminalColorSettings>;
  if (typeof c.dark !== 'string' || typeof c.light !== 'string' || !Array.isArray(c.custom) || c.custom.length > 50) return false;
  if (c.follow !== undefined && typeof c.follow !== 'boolean') return false;
  return c.custom.every(
    (s) =>
      s &&
      typeof s.id === 'string' &&
      /^custom-[\w-]{1,40}$/.test(s.id) &&
      typeof s.name === 'string' &&
      s.name.trim().length > 0 &&
      s.name.length <= 40 &&
      !!s.colors &&
      TERMINAL_COLOR_KEYS.every((k) => isHexColor(s.colors[k])),
  );
}

function isHighlight(v: unknown): v is HighlightSettings {
  if (!v || typeof v !== 'object') return false;
  const h = v as Partial<HighlightSettings>;
  if (typeof h.enabled !== 'boolean' || typeof h.rainbow !== 'boolean') return false;
  if (h.skipAltScreen !== undefined && typeof h.skipAltScreen !== 'boolean') return false;
  if (h.maxRun !== undefined && !(Number.isInteger(h.maxRun) && h.maxRun >= 1000 && h.maxRun <= 4_000_000)) return false;
  if (!h.presets || typeof h.presets !== 'object' || Object.values(h.presets).some((x) => typeof x !== 'boolean')) return false;
  if (!Array.isArray(h.custom) || h.custom.length > 100) return false;
  return h.custom.every(
    (r) =>
      r &&
      typeof r.id === 'string' &&
      typeof r.name === 'string' &&
      r.name.length <= 60 &&
      isHexColor(r.color) &&
      typeof r.enabled === 'boolean' &&
      typeof r.ignoreCase === 'boolean' &&
      typeof r.pattern === 'string' &&
      checkHighlightPattern(r.pattern, r.ignoreCase) === null,
  );
}

const VALIDATORS: { [K in keyof Settings]: Validator<K> } = {
  'ui.theme': (v): v is Settings['ui.theme'] => v === 'dark' || v === 'light' || v === 'system',
  // 应用主题：配色方案 ID（内置或 custom-…）；方案不存在时界面回退到默认主题
  'ui.themeDark': (v): v is string => typeof v === 'string' && /^[\w-]{1,48}$/.test(v),
  'ui.themeLight': (v): v is string => typeof v === 'string' && /^[\w-]{1,48}$/.test(v),
  'ui.shortcuts': (v): v is Settings['ui.shortcuts'] => isShortcutMap(v),
  // 目录：空字符串（默认位置）或绝对路径；目录本身在保存前由 storage.* 接口检查
  'storage.notesDir': (v): v is string => typeof v === 'string' && v.length <= 1024 && (v === '' || isAbsolute(v)),
  'storage.recordingsDir': (v): v is string => typeof v === 'string' && v.length <= 1024 && (v === '' || isAbsolute(v)),
  'ui.fontFamily': (v): v is string => typeof v === 'string' && v.length <= 256 && !/[;{}<>]/.test(v),
  'ui.navHidden': (v): v is Settings['ui.navHidden'] => Array.isArray(v) && v.length <= NAV_OPTIONAL.length && v.every((x) => (NAV_OPTIONAL as readonly string[]).includes(x as string)),
  'terminal.highlight': (v): v is Settings['terminal.highlight'] => isHighlight(v),
  'terminal.suggest': (v): v is Settings['terminal.suggest'] => {
    const o = v as Settings['terminal.suggest'];
    return !!o && typeof o === 'object' && ['enabled', 'history', 'library', 'snippets', 'serial'].every((k) => typeof (o as unknown as Record<string, unknown>)[k] === 'boolean') && Number.isInteger(o.minChars) && o.minChars >= 1 && o.minChars <= 10 && Number.isInteger(o.maxItems) && o.maxItems >= 1 && o.maxItems <= 30;
  },
  'terminal.search': (v): v is Settings['terminal.search'] => !!v && typeof v === 'object' && ['matchBg', 'matchBorder', 'matchRuler', 'activeBg', 'activeBorder', 'activeRuler'].every((k) => isHexColor((v as Record<string, unknown>)[k])),
  'monitor.config': (v): v is Settings['monitor.config'] => {
    const o = v as Settings['monitor.config'];
    return !!o && typeof o === 'object' && ['enabled', 'hideSpecialFs', 'hideDockerFs', 'hideVirtualNics'].every((k) => typeof (o as unknown as Record<string, unknown>)[k] === 'boolean') && typeof o.mounts === 'string' && o.mounts.length <= 1000 && typeof o.nics === 'string' && o.nics.length <= 1000;
  },
  'terminal.fontSize': (v): v is number => Number.isInteger(v) && (v as number) >= 9 && (v as number) <= 32,
  'terminal.fontFamily': (v): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 256,
  'terminal.scrollback': (v): v is number => Number.isInteger(v) && (v as number) >= 500 && (v as number) <= 100_000,
  'terminal.fontSizeMin': (v): v is number => Number.isInteger(v) && (v as number) >= 6 && (v as number) <= 30,
  'terminal.fontSizeMax': (v): v is number => Number.isInteger(v) && (v as number) >= 12 && (v as number) <= 72,
  'terminal.cursorStyle': (v): v is Settings['terminal.cursorStyle'] => v === 'block' || v === 'underline' || v === 'bar',
  'terminal.cursorBlink': (v): v is boolean => typeof v === 'boolean',
  'terminal.mouse': (v): v is Settings['terminal.mouse'] => {
    const o = v as Settings['terminal.mouse'];
    return !!o && typeof o === 'object' && typeof o.copyOnSelect === 'boolean' && typeof o.middlePaste === 'boolean' && typeof o.rightPaste === 'boolean';
  },
  'terminal.lineHeight': (v): v is number => typeof v === 'number' && v >= 1 && v <= 2,
  'terminal.letterSpacing': (v): v is number => typeof v === 'number' && v >= -2 && v <= 10,
  'terminal.localEnv': (v): v is Settings['terminal.localEnv'] => v === 'system' || v === 'clean',
  'terminal.background': (v): v is Settings['terminal.background'] => {
    const o = v as Settings['terminal.background'];
    return (
      !!o &&
      typeof o === 'object' &&
      (o.kind === 'none' || o.kind === 'image' || o.kind === 'video') &&
      typeof o.file === 'string' &&
      (o.kind === 'none' ? o.file === '' || BACKGROUND_FILE.test(o.file) : BACKGROUND_FILE.test(o.file)) &&
      typeof o.dim === 'number' &&
      o.dim >= 0 &&
      o.dim <= 0.95 &&
      typeof o.blur === 'number' &&
      o.blur >= 0 &&
      o.blur <= 20 &&
      ['cover', 'contain', 'fill', 'tile'].includes(o.fit)
    );
  },
  'terminal.connectTimeoutSec': (v): v is number => Number.isInteger(v) && (v as number) >= 3 && (v as number) <= 120,
  'terminal.connectRetries': (v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 5,
  'terminal.colors': (v): v is Settings['terminal.colors'] => isTerminalColors(v),
  'ai.defaultModel': (v): v is Settings['ai.defaultModel'] => isModelRef(v),
  'ai.maxRounds': (v): v is number => Number.isInteger(v) && (v as number) >= 5 && (v as number) <= 500,
  'db.maxRows': (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1000,
  'db.timeoutSec': (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 300,
  'db.maskColumns': (v): v is boolean => typeof v === 'boolean',
  'db.workbenchRows': (v): v is number => Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 5000,
  'ai.autoApproveReadonly': (v): v is boolean => typeof v === 'boolean',
  'ai.autoCompressPct': (v): v is number => Number.isInteger(v) && (v as number) >= 50 && (v as number) <= 95,
  'ai.defaultAgentPolicy': (v): v is Settings['ai.defaultAgentPolicy'] => AGENT_POLICIES.includes(v as Settings['ai.defaultAgentPolicy']),
  'ai.llmReview': (v): v is boolean => typeof v === 'boolean',
  'ai.nightWindow': (v): v is Settings['ai.nightWindow'] => {
    const o = v as Settings['ai.nightWindow'];
    const hhmm = (s: unknown): boolean => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
    return !!o && typeof o === 'object' && typeof o.enabled === 'boolean' && hhmm(o.from) && hhmm(o.to);
  },
  'ai.fastModel': (v): v is Settings['ai.fastModel'] => isModelRef(v),
  'ai.maskIps': (v): v is boolean => typeof v === 'boolean',
  'ai.memoryPolicy': (v): v is Settings['ai.memoryPolicy'] => v === 'auto' || v === 'ask' || v === 'off',
  'ai.echoToTerminal': (v): v is boolean => typeof v === 'boolean',
  'ai.sensitiveModel': (v): v is Settings['ai.sensitiveModel'] => isModelRef(v),
  'ai.thinkingDefault': (v): v is boolean => typeof v === 'boolean',
  'ai.thinkingEffort': (v): v is Settings['ai.thinkingEffort'] => v === null || (EFFORTS as readonly string[]).includes(v as string),
  'ai.temperature': (v): v is number | null => v === null || (typeof v === 'number' && v >= 0 && v <= 2),
  'ai.requestTimeoutSec': (v): v is number => Number.isInteger(v) && (v as number) >= 10 && (v as number) <= 900,
  'ai.notifyApproval': (v): v is boolean => typeof v === 'boolean',
  'ai.terminalContext': (v): v is Settings['ai.terminalContext'] => {
    const o = v as Settings['ai.terminalContext'];
    return !!o && typeof o === 'object' && typeof o.enabled === 'boolean' && Number.isInteger(o.lines) && o.lines >= TERMINAL_CONTEXT_LINES.min && o.lines <= TERMINAL_CONTEXT_LINES.max;
  },
  'ai.webSearch': (v): v is Settings['ai.webSearch'] => {
    const o = v as Settings['ai.webSearch'];
    const url = (x: unknown): boolean => typeof x === 'string' && x.length <= 500 && (x === '' || /^https?:\/\/\S+$/i.test(x));
    return (
      !!o &&
      typeof o === 'object' &&
      (o.source === 'server' || o.source === 'personal') &&
      (o.format === 'deepseek' || o.format === 'custom') &&
      url(o.baseUrl) &&
      url(o.searchUrl) &&
      url(o.fetchUrl) &&
      Number.isInteger(o.count) &&
      o.count >= WEB_SEARCH_COUNT.min &&
      o.count <= WEB_SEARCH_COUNT.max &&
      typeof o.defaultOn === 'boolean'
    );
  },
  'ai.visionFallback': (v): v is Settings['ai.visionFallback'] => {
    const o = v as Settings['ai.visionFallback'];
    return !!o && typeof o === 'object' && typeof o.enabled === 'boolean' && (o.model === null || isModelRef(o.model));
  },
  'ai.providerOrder': (v): v is string[] => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length <= 100),
  'ai.rules': (v): v is Settings['ai.rules'] =>
    Array.isArray(v) &&
    v.length <= 50 &&
    v.every((r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id.length <= 64 && typeof r.text === 'string' && r.text.length <= 2000 && typeof r.enabled === 'boolean'),
  'audit.recordSessions': (v): v is boolean => typeof v === 'boolean',
  'audit.recordLocal': (v): v is boolean => typeof v === 'boolean',
  'audit.retentionDays': (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
  'audit.recordingRetentionDays': (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3650,
  'security.l2Decision': (v): v is Settings['security.l2Decision'] => v === 'CONFIRM' || v === 'APPROVE' || v === 'DENY',
  'security.blacklistDecision': (v): v is Settings['security.blacklistDecision'] => v === 'DENY' || v === 'CONFIRM',
  'security.strict': (v): v is boolean => typeof v === 'boolean',
  'security.maxLength': (v): v is number => Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 100_000,
  'ai.inlineCompletion': (v): v is Settings['ai.inlineCompletion'] => v === 'off' || v === 'local' || v === 'ai',
  'ai.hashAsk': (v): v is boolean => typeof v === 'boolean',
  'security.autoLockMin': (v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 240,
  'security.touchId': (v): v is boolean => typeof v === 'boolean',
  'sftp.rateLimitKBps': (v): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000,
  'sftp.concurrency': (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 8,
  'sftp.showHidden': (v): v is boolean => typeof v === 'boolean',
  'sftp.favorites': (v): v is Record<string, string[]> =>
    !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 2000 && Object.values(v).every((x) => Array.isArray(x) && x.length <= 100 && x.every((p) => typeof p === 'string' && p.length <= 4096)),
  'mcp.server.enabled': (v): v is boolean => typeof v === 'boolean',
  'mcp.server.port': (v): v is number => Number.isInteger(v) && (v as number) >= 1024 && (v as number) <= 65535,
  'mcp.server.tools': (v): v is string[] => Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length <= 60),
  'mcp.server.allowWrite': (v): v is boolean => typeof v === 'boolean',
  'mcp.server.allowDanger': (v): v is boolean => typeof v === 'boolean',
  'mcp.server.toolsRev': (v): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 100,
  'sync.lastBackupAt': (v): v is number | null => v === null || (Number.isInteger(v) && (v as number) > 0),
  'monitor.dashboardHosts': (v): v is string[] => Array.isArray(v) && v.length <= 200 && v.every((x) => typeof x === 'string' && x.length <= 64),
  'monitor.residentSince': (v): v is Record<string, number> =>
    !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 500 && Object.entries(v).every(([k, t]) => k.length <= 64 && Number.isFinite(t) && (t as number) > 0),
  'monitor.alert': (v): v is Settings['monitor.alert'] => {
    const o = v as Settings['monitor.alert'];
    const pct = (n: unknown): boolean => typeof n === 'number' && n >= 10 && n <= 100;
    return (
      !!o &&
      typeof o === 'object' &&
      typeof o.notify === 'boolean' &&
      pct(o.cpu) &&
      pct(o.mem) &&
      pct(o.disk) &&
      Number.isInteger(o.sustainMin) &&
      o.sustainMin >= 0 &&
      o.sustainMin <= 60 &&
      Number.isInteger(o.cooldownMin) &&
      o.cooldownMin >= 5 &&
      o.cooldownMin <= 1440 &&
      (o.offline === undefined || typeof o.offline === 'boolean') &&
      (o.email === undefined || typeof o.email === 'boolean')
    );
  },
};

/** 默认值的覆盖：只给自动化测试用（例如 E2E 里左侧导航显示全部页面），由主进程在没有打包时设置 */
let defaultOverrides: Partial<Settings> = {};
export function setDefaultOverrides(p: Partial<Settings>): void {
  defaultOverrides = { ...p };
}

/** 本地设置（setting 表，值为 JSON）。未设置的键使用默认值；存了非法值时也回退到默认值。 */
export class SettingsRepo {
  /** 设置只通过 set() 修改，读到的结果缓存起来（传输限速等每个数据块都要读一次） */
  private cache: Settings | null = null;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  getAll(): Settings {
    if (this.cache) return { ...this.cache };
    const result: Settings = { ...DEFAULT_SETTINGS, ...defaultOverrides };
    const rows = this.db.prepare<[], { key: string; value: string }>('SELECT key, value FROM setting').all();
    for (const { key, value } of rows) {
      if (!(key in VALIDATORS)) {
        continue;
      }
      const k = key as keyof Settings;
      try {
        const parsed: unknown = JSON.parse(value);
        if (VALIDATORS[k](parsed)) {
          (result as unknown as Record<string, unknown>)[k] = parsed;
        }
      } catch {
        // 忽略损坏的值，使用默认值
      }
    }
    this.cache = result;
    return { ...result };
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.getAll()[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const validator = VALIDATORS[key] as Validator<K> | undefined;
    if (!validator) {
      throw new UserError(`不支持的设置项 ${String(key)}`);
    }
    if (!validator(value)) {
      throw new UserError(`设置项 ${String(key)} 的值不合法`);
    }
    this.db
      .prepare(
        `INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), this.now());
    this.cache = null;
  }
}
