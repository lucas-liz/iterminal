import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import type { PresetConfig } from '@itm/protocol';

const run = promisify(execFile);

/** 编译期默认值（文档一 11.6） */
export const DEFAULT_PRESET: PresetConfig = {
  serverUrl: null,
  requireLogin: false,
  updateChannel: null,
  allowLocalExport: true,
  allowPersonalProvider: true,
  source: 'default',
};

/** 键名不区分大小写，和注册表 / MDM 描述文件里的写法（ServerUrl、RequireLogin…）兼容 */
function normalize(raw: Record<string, unknown>, source: PresetConfig['source']): PresetConfig {
  const lower = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  const bool = (k: string, fallback: boolean): boolean => {
    const v = lower[k.toLowerCase()];
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return /^(1|true|yes|on)$/i.test(v.trim()) ? true : /^(0|false|no|off)$/i.test(v.trim()) ? false : fallback;
    return fallback;
  };
  const url = lower.serverurl;
  const serverUrl = typeof url === 'string' && /^https?:\/\/\S+$/i.test(url.trim()) ? url.trim().replace(/\/+$/, '') : null;
  return {
    serverUrl,
    requireLogin: bool('requireLogin', DEFAULT_PRESET.requireLogin),
    updateChannel: lower.updatechannel === 'stable' || lower.updatechannel === 'beta' ? (lower.updatechannel as 'stable' | 'beta') : null,
    allowLocalExport: bool('allowLocalExport', DEFAULT_PRESET.allowLocalExport),
    allowPersonalProvider: bool('allowPersonalProvider', DEFAULT_PRESET.allowPersonalProvider),
    source,
  };
}

/** `reg query` 的输出：    ServerUrl    REG_SZ    https://...  /  RequireLogin    REG_DWORD    0x1 */
export function parseRegQuery(out: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_SZ|REG_DWORD|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (!m) continue;
    result[m[1]] = m[2] === 'REG_DWORD' ? parseInt(m[3], 16) : m[3].trim();
  }
  return result;
}

/**
 * 读取企业预置配置：Windows 注册表 HKLM\Software\iTerminal、macOS 托管偏好 com.corp.iterminal、Linux /etc/iterminal/config.json。
 * 读取失败一律当作没有预置（不影响启动）。ITM_PRESET_FILE 指向 JSON 文件时优先使用（测试和便携部署）。
 */
export async function loadPreset(platform: NodeJS.Platform = process.platform): Promise<PresetConfig> {
  try {
    const override = process.env.ITM_PRESET_FILE;
    if (override && existsSync(override)) return normalize(JSON.parse(readFileSync(override, 'utf8')) as Record<string, unknown>, 'file');
    if (platform === 'win32') {
      const { stdout } = await run('reg', ['query', 'HKLM\\Software\\iTerminal'], { timeout: 5000, windowsHide: true });
      return normalize(parseRegQuery(stdout), 'registry');
    }
    if (platform === 'darwin') {
      const file = '/Library/Managed Preferences/com.corp.iterminal.plist';
      if (!existsSync(file)) return DEFAULT_PRESET;
      const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 5000 });
      return normalize(JSON.parse(stdout) as Record<string, unknown>, 'mdm');
    }
    const file = '/etc/iterminal/config.json';
    if (!existsSync(file)) return DEFAULT_PRESET;
    return normalize(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>, 'file');
  } catch {
    return DEFAULT_PRESET;
  }
}
