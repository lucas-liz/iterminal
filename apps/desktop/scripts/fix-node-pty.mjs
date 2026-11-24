// pnpm 解压 node-pty 预编译包时会丢掉 spawn-helper 的可执行权限，导致本地终端报 posix_spawnp failed。
// 安装后补上权限；electron-builder 打包时会保留文件权限。
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('node-pty/package.json'));
for (const base of [join(root, 'prebuilds'), join(root, 'build', 'Release')]) {
  if (!existsSync(base)) continue;
  const dirs = base.endsWith('Release') ? [base] : readdirSync(base).map((d) => join(base, d));
  for (const dir of dirs) {
    const helper = join(dir, 'spawn-helper');
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
      console.log(`[fix-node-pty] chmod +x ${helper}`);
    }
  }
}
