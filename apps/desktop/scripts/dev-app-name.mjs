/**
 * 开发时直接运行（pnpm dev / npx electron .）用的是 node_modules 里的 Electron.app，
 * macOS 的 Dock 和菜单栏按这个应用包的 Info.plist 显示名称，所以会显示「Electron」，运行时改不了。
 * 这里把开发用的 Electron.app 的显示名称和图标改成 iTerminal（只改本机 node_modules，打包时 electron-builder 会重新生成，不受影响），
 * 然后用 ad-hoc 身份（-）重新签名，不使用个人钥匙串里的证书。只在 macOS 上执行；已经改过时什么都不做。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const NAME = 'iTerminal';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let exe;
try {
  // require('electron') 返回可执行文件路径：…/Electron.app/Contents/MacOS/Electron
  exe = require('electron');
} catch {
  process.exit(0);
}
const appDir = dirname(dirname(dirname(exe)));
const plist = join(appDir, 'Contents', 'Info.plist');
if (!existsSync(plist)) process.exit(0);

const plistBuddy = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { stdio: 'pipe' }).toString().trim();
const get = (key) => {
  try {
    return plistBuddy(`Print :${key}`);
  } catch {
    return null;
  }
};

let changed = false;
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  const v = get(key);
  if (v === NAME) continue;
  plistBuddy(v === null ? `Add :${key} string ${NAME}` : `Set :${key} ${NAME}`);
  changed = true;
}

// Dock 图标：替换应用包里的 icns（运行后主进程也会 setIcon，这里让启动瞬间和 Finder 里也是 iTerminal 的图标）
const iconFile = get('CFBundleIconFile') ?? 'electron.icns';
const iconDst = join(appDir, 'Contents', 'Resources', iconFile.endsWith('.icns') ? iconFile : `${iconFile}.icns`);
const iconSrc = join(root, 'build', 'icon.icns');
if (existsSync(iconSrc) && (!existsSync(iconDst) || !readFileSync(iconDst).equals(readFileSync(iconSrc)))) {
  copyFileSync(iconSrc, iconDst);
  changed = true;
}

if (changed) {
  // 改了 Info.plist 和资源后原来的签名失效：ad-hoc 重新签名
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'pipe' });
  // 让 Dock / 启动台重新读取名称和图标
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
  if (existsSync(lsregister)) {
    try {
      execFileSync(lsregister, ['-f', appDir], { stdio: 'pipe' });
    } catch {
      // 刷新失败不影响使用，重启 Dock 后也会更新
    }
  }
  console.log(`开发用的 Electron.app 已改为显示「${NAME}」：${appDir}`);
}
