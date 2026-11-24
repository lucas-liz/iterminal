import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PRESET, loadPreset, parseRegQuery } from '../src/main/app/preset';

describe('企业预置配置', () => {
  const saved = process.env.ITM_PRESET_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ITM_PRESET_FILE;
    else process.env.ITM_PRESET_FILE = saved;
  });

  it('解析 reg query 的输出', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\Software\\iTerminal\r\n    ServerUrl    REG_SZ    https://ops.corp/\r\n    RequireLogin    REG_DWORD    0x1\r\n    AllowLocalExport    REG_DWORD    0x0\r\n';
    expect(parseRegQuery(out)).toEqual({ ServerUrl: 'https://ops.corp/', RequireLogin: 1, AllowLocalExport: 0 });
  });

  it('JSON 文件：键名不区分大小写，地址去掉末尾的 /，非法地址忽略', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'itm-preset-'));
    try {
      const f = join(dir, 'config.json');
      writeFileSync(f, JSON.stringify({ serverurl: 'https://ops.corp/', REQUIRELOGIN: 'true', allowPersonalProvider: false }));
      process.env.ITM_PRESET_FILE = f;
      expect(await loadPreset('linux')).toEqual({ serverUrl: 'https://ops.corp', requireLogin: true, allowLocalExport: true, allowPersonalProvider: false, updateChannel: null, source: 'file' });
      // 管理员锁定更新渠道（文档一 11.5）；不认识的渠道忽略
      writeFileSync(f, JSON.stringify({ UpdateChannel: 'beta' }));
      expect((await loadPreset('linux')).updateChannel).toBe('beta');
      writeFileSync(f, JSON.stringify({ updateChannel: 'nightly' }));
      expect((await loadPreset('linux')).updateChannel).toBeNull();
      writeFileSync(f, JSON.stringify({ ServerUrl: 'ftp://x' }));
      expect((await loadPreset('linux')).serverUrl).toBeNull();
      writeFileSync(f, '{ broken');
      expect(await loadPreset('linux')).toEqual(DEFAULT_PRESET);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
