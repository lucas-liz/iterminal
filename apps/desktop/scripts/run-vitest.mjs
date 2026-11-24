// 用 Electron 自带的 Node 运行 Vitest（ELECTRON_RUN_AS_NODE），保证测试和应用加载的是同一套原生模块 ABI。
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const electron = require('electron');
// vitest 的 exports 没有暴露 vitest.mjs，按 package.json 所在目录定位 CLI
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const result = spawnSync(electron, [vitest, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(result.status ?? 1);
