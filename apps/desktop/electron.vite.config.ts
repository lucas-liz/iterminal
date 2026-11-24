import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { loadEnv, type Plugin } from 'vite';

/**
 * 生产构建时注入 CSP（文档一 10.1）：只允许加载应用自身的脚本。antd 的 CSS-in-JS 需要内联样式。
 * 开发模式下 Vite 热更新需要内联脚本和 WebSocket，所以不注入。
 */
function contentSecurityPolicy(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // 终端背景图片 / 视频：主进程的 itm-media 协议（只能读档案里复制进去的背景文件）
    "img-src 'self' data: itm-media:",
    "media-src 'self' itm-media:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'itm-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`),
  };
}

/**
 * 审批引擎的 tree-sitter-bash 解析器是 WASM：构建主进程时把两个 .wasm 复制到 out/main/wasm/（打包后在 asar 里，fs 可以直接读）。
 */
function copyWasm(): Plugin {
  const require = createRequire(__filename);
  return {
    name: 'itm-copy-wasm',
    apply: 'build',
    writeBundle(opts) {
      const out = join(opts.dir ?? resolve(__dirname, 'out/main'), 'wasm');
      mkdirSync(out, { recursive: true });
      copyFileSync(require.resolve('web-tree-sitter/web-tree-sitter.wasm'), join(out, 'web-tree-sitter.wasm'));
      copyFileSync(join(dirname(require.resolve('tree-sitter-bash/package.json')), 'tree-sitter-bash.wasm'), join(out, 'tree-sitter-bash.wasm'));
    },
  };
}

// 主进程和 preload 默认只把 package.json 的 dependencies（ssh2、node-pty、SQLCipher）外置，
// devDependencies 里的 @itm/protocol 等会被打进 bundle。
// 默认后台地址只从本机 .env（iterminal/.env 或 apps/desktop/.env，均已加入 .gitignore）或构建环境变量读取，
// 未配置时写入空值，不把私有后台地址提交到 Git 仓库。
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, resolve(__dirname, '../..'), 'ITM_');
  const desktopEnv = loadEnv(mode, __dirname, 'ITM_');
  const rawDefaultServer =
    process.env.ITM_DEFAULT_SERVER_URL !== undefined
      ? process.env.ITM_DEFAULT_SERVER_URL
      : desktopEnv.ITM_DEFAULT_SERVER_URL || rootEnv.ITM_DEFAULT_SERVER_URL || '';
  const rawLegacyServers =
    process.env.ITM_LEGACY_SERVER_URLS !== undefined
      ? process.env.ITM_LEGACY_SERVER_URLS
      : desktopEnv.ITM_LEGACY_SERVER_URLS || rootEnv.ITM_LEGACY_SERVER_URLS || '';
  const buildDefaultServerUrl = rawDefaultServer.trim().replace(/\/+$/, '');
  const buildLegacyServerUrls = rawLegacyServers
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return {
    main: {
      plugins: [copyWasm()],
      define: {
        __ITM_BUILD_DEFAULT_SERVER_URL__: JSON.stringify(buildDefaultServerUrl),
        __ITM_BUILD_LEGACY_SERVER_URLS__: JSON.stringify(buildLegacyServerUrls),
      },
      build: {
        rollupOptions: {
          // agent：Agent 进程（utilityProcess）的入口，和主进程共用依赖的 chunk
          input: { index: resolve(__dirname, 'src/main/index.ts'), agent: resolve(__dirname, 'src/agent/index.ts') },
        },
      },
    },
    preload: {
      build: {
        rollupOptions: {
          input: { index: resolve(__dirname, 'src/preload/index.ts') },
          // sandbox: true 的 preload 只能是 CommonJS 单文件
          output: { format: 'cjs', entryFileNames: '[name].cjs' },
        },
      },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      plugins: [react(), contentSecurityPolicy()],
      resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
      build: {
        rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
        chunkSizeWarningLimit: 4096,
      },
    },
  };
});
