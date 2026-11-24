declare const __ITM_BUILD_DEFAULT_SERVER_URL__: string | undefined;
declare const __ITM_BUILD_LEGACY_SERVER_URLS__: readonly string[] | undefined;

/**
 * 打包时由 `electron.vite.config.ts` 从本地 `.env`（`ITM_DEFAULT_SERVER_URL`）注入的默认后台地址。
 * 未配置 `.env` 时返回 `null`（纯本地模式，不内置任何后台地址）。
 */
export function buildDefaultServerUrl(): string | null {
  const v = typeof __ITM_BUILD_DEFAULT_SERVER_URL__ === 'string' ? __ITM_BUILD_DEFAULT_SERVER_URL__.trim() : '';
  return v ? v.replace(/\/+$/, '') : null;
}

/**
 * 打包时可选从本地 `.env`（`ITM_LEGACY_SERVER_URLS`，逗号分隔）注入的旧默认后台地址列表。
 */
export function buildLegacyServerUrls(): readonly string[] {
  if (typeof __ITM_BUILD_LEGACY_SERVER_URLS__ === 'undefined' || !Array.isArray(__ITM_BUILD_LEGACY_SERVER_URLS__)) return [];
  return __ITM_BUILD_LEGACY_SERVER_URLS__.map((s) => String(s).trim().replace(/\/+$/, '')).filter(Boolean);
}
