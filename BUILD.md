# iTerminal 桌面客户端构建说明

适用版本：`apps/desktop/package.json` 里的 `version`（当前 1.0.0），Electron 44.5.1，electron-builder 26.15.3。
所有命令都在仓库根目录（`iterminal/`）执行，除非特别说明。需要给 electron-builder 加参数时，统一用 `pnpm --filter @itm/desktop exec electron-builder …`（参数会原样传过去），先用 `pnpm --filter @itm/desktop build` 编译代码。

## 一览

| 平台 | 在哪里构建 | 命令（仓库根目录） | 产物（`apps/desktop/release/<版本>/`） | 签名 |
|---|---|---|---|---|
| macOS 本机试用 | Mac | `pnpm --filter @itm/desktop dist:dir` | `mac-arm64/iTerminal.app`（不打安装包） | ad-hoc |
| macOS 安装包（本机） | Mac | `pnpm --filter @itm/desktop build` 后 `pnpm --filter @itm/desktop exec electron-builder --mac -c.mac.identity=- --publish never` | `.dmg`、`.zip`（arm64 + x64） | ad-hoc |
| macOS 正式发布 | Mac（CI） | `pnpm dist:mac` | `.dmg`、`.zip`（arm64 + x64） | Developer ID + 公证 |
| Windows 正式 | Windows（CI） | `pnpm dist:win` | `iTerminal Setup <版本>.exe`（NSIS）、`.msi` | 证书 / Azure Trusted Signing |
| Windows 内测（在 Mac 上交叉打包） | Mac | `pnpm --filter @itm/desktop dist:win:cross` | `iTerminal Setup <版本>.exe`（只有 NSIS，x64） | 不签名 |
| Linux | Linux x64 / arm64（或 Docker） | `pnpm --filter @itm/desktop build` 后 `pnpm --filter @itm/desktop exec electron-builder --linux --x64 --publish never` | `.AppImage`、`.deb`、`.rpm` | 可选 GPG（发布时） |

产物目录由 `electron-builder.yml` 的 `directories.output: release/${version}` 决定；每个平台还会生成 `latest*.yml` 和 `.blockmap`（自动更新用）。

---

## 1. 通用准备

| 工具 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.12 | `package.json` 的 `engines` |
| pnpm | 10.30.3 | 用 corepack 启用：`corepack enable`（版本由 `packageManager` 字段固定） |
| Python 3 + C/C++ 编译器 | — | 原生模块没有预编译包时用 node-gyp 编译（各平台见下文） |

```bash
corepack enable
pnpm i
```

`pnpm i` 之后 `apps/desktop` 的 `postinstall` 会自动执行：

1. `scripts/fix-node-pty.mjs`：补上 node-pty `spawn-helper` 的可执行权限（否则本地终端报 `posix_spawnp failed`）；
2. `electron-builder install-app-deps`：按 Electron 的 ABI 重新编译 / 下载原生模块（node-pty、better-sqlite3-multiple-ciphers、@serialport/bindings-cpp，以及 ssh2 的可选依赖 cpu-features）；
3. `scripts/dev-app-name.mjs`（只在 macOS）：把开发用的 Electron.app 显示名改成 iTerminal（只影响 `pnpm dev`，不影响打包）。

`.npmrc` 里是 `node-linker=hoisted`（electron-builder 需要扁平的 node_modules），不要改。

### 构建前检查（建议）

```bash
pnpm typecheck
pnpm test
pnpm e2e            # 可选：E2E，2–4 分钟
```

### 下载慢或离线

| 下载什么 | 环境变量 | 本机缓存位置（macOS） |
|---|---|---|
| Electron 本体（`pnpm i` 和打包时） | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` | `~/Library/Caches/electron/` |
| NSIS、Wine、WiX、fpm 等打包工具 | `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` | `~/Library/Caches/electron-builder/` |

Electron 安装时会用 electron 包自带的 `checksums.json` 校验 SHA-256，用镜像不影响安全性。下载失败时可以把对应的 zip 手动下载后放进缓存目录。

---

## 2. macOS

### 2.1 环境

- macOS 13 以上，Apple Silicon 或 Intel；
- Xcode 命令行工具：`xcode-select --install`（提供 `codesign`、`iconutil`、编译器）。

### 2.2 本机试用（不打安装包）

```bash
pnpm --filter @itm/desktop dist:dir
open apps/desktop/release/1.0.0/mac-arm64/iTerminal.app
```

`dist:dir` 用 ad-hoc 身份签名（`-c.mac.identity=-`），直接复用 `node_modules` 里已经下载好的 Electron（`-c.electronDist`），不需要联网，也**不会用到钥匙串里的个人证书**。

### 2.3 本机打安装包（dmg + zip）

```bash
pnpm --filter @itm/desktop build
pnpm --filter @itm/desktop exec electron-builder --mac -c.mac.identity=- --publish never
```

- 默认同时打 arm64 和 x64（`electron-builder.yml` 的 `mac.target`），x64 需要额外下载 x64 版的 Electron；只要本机架构可以加 `--arm64`：
  ```bash
  pnpm --filter @itm/desktop exec electron-builder --mac --arm64 -c.mac.identity=- --publish never
  ```
- **本机打包一定要带 `-c.mac.identity=-`**：不带时 electron-builder 会自动在钥匙串里找 Developer ID 证书并使用它。也可以设置 `CSC_IDENTITY_AUTO_DISCOVERY=false` 关闭自动查找。
- ad-hoc 签名的应用没有公证：从网上下载后打开会提示「已损坏」或「无法验证开发者」。内部试用时右键 →「打开」，或者：
  ```bash
  xattr -dr com.apple.quarantine /Applications/iTerminal.app
  ```

### 2.4 正式发布（CI）

```bash
pnpm dist:mac
```

签名和公证所需的证书、密钥只放在 CI 的受保护变量里，设置了这些变量时 electron-builder 会自动签名并公证：

| 变量 | 说明 |
|---|---|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | Developer ID Application 证书（.p12，base64 或文件路径）和密码 |
| `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` | App Store Connect API Key（.p8），用于公证 |

CI 在 arm64 Mac 上执行 `electron-builder --mac --arm64 --x64`，同时产出两个架构。打包配置：`hardenedRuntime: true`，权限声明在 `build/entitlements.mac.plist`，开启了 Electron Fuses（关闭 RunAsNode、--inspect，校验 asar 完整性）。

---

## 3. Windows

### 3.1 正式安装包（在 Windows 上构建）

环境：

- Windows 10 / 11 x64；
- Node.js 22、corepack；
- Visual Studio 2022 Build Tools，勾选「使用 C++ 的桌面开发」，以及 Python 3（原生模块没有预编译包时 node-gyp 需要）；
- 打 MSI 需要 WiX，electron-builder 第一次打包时会自动下载。

在 PowerShell 里：

```powershell
corepack enable
pnpm i
pnpm dist:win
```

产物：`iTerminal Setup <版本>.exe`（NSIS，可以选安装目录，支持差分更新）和 `iTerminal <版本>.msi`（按机器安装，适合域控 / 软件分发）。

签名（只在 CI 里配置）：

| 变量 | 说明 |
|---|---|
| `CSC_LINK` / `CSC_KEY_PASSWORD` | 代码签名证书（.pfx）和密码 |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | 或者用 Azure Trusted Signing（见 `.gitlab-ci.yml`） |

没有签名的安装包在 Windows 上会被 SmartScreen 提示「未知发布者」，内部测试点「更多信息 → 仍要运行」即可。

### 3.2 在 Mac 上交叉打内测包

```bash
pnpm --filter @itm/desktop dist:win:cross
```

- 只打 NSIS x64 安装包，不签名；MSI 依赖 WiX，只能在 Windows 上打；
- 使用 `electron-builder.win-cross.yml`：不重新编译原生模块（node-gyp 不能交叉编译），直接用各原生模块自带的 `win32-x64` 预编译文件，并排除本机编出来的 macOS 二进制；
- 第一次打包会下载 NSIS 和 Wine（macOS 版，用来生成卸载程序）到 `~/Library/Caches/electron-builder/`，之后离线也能打；
- 正式发版请在 Windows 机器或 CI 上用 `pnpm dist:win`。

---

## 4. Linux

### 4.1 在 Linux 上构建

环境（以 Ubuntu 22.04 / Debian 12 为例）：

```bash
sudo apt-get install -y build-essential python3 rpm
```

- `build-essential`、`python3`：原生模块编译；
- `rpm`：打 `.rpm` 需要 `rpmbuild`；`.deb` 和 `.AppImage` 用 electron-builder 自带的工具。

```bash
corepack enable
pnpm i
pnpm --filter @itm/desktop build
pnpm --filter @itm/desktop exec electron-builder --linux --x64 --publish never
```

- 在 arm64 机器上把 `--x64` 换成 `--arm64`。原生模块要在对应架构上编译，所以 x64 和 arm64 最好分别在各自架构的机器上打（CI 就是这样做的）；不带架构参数时会按 `electron-builder.yml` 同时打两个架构，交叉的那个需要 QEMU，很慢；
- 产物：`.AppImage`、`.deb`、`.rpm`；deb 依赖 `libsecret-1-0 libnotify4 libxtst6 libnss3`，rpm 依赖 `libsecret`；
- Ubuntu 22.04 以上运行 AppImage 需要 FUSE 2：`sudo apt-get install libfuse2`；
- 系统没有 Secret Service（GNOME 钥匙串 / KWallet）时，应用会要求设置主密码来保护本地密钥。

### 4.2 在 Mac 上用 Docker 打 Linux 包

不要直接挂载正在开发的目录：容器里执行 `pnpm i` 会把 `node_modules` 里的原生模块换成 Linux 版本，本机就跑不起来了。先复制一份不含 `node_modules` 的代码：

```bash
rsync -a --delete --exclude node_modules --exclude 'apps/desktop/release' --exclude 'apps/desktop/out' ./ /tmp/itm-linux/
docker run --rm -v /tmp/itm-linux:/project -w /project electronuserland/builder:22 \
  bash -c "corepack enable && pnpm i --frozen-lockfile && pnpm --filter @itm/desktop build && pnpm --filter @itm/desktop exec electron-builder --linux --x64 --publish never"
ls /tmp/itm-linux/apps/desktop/release/*/
```

`electronuserland/builder:22` 已经装好了 Node 22、编译工具和 rpm。Apple Silicon 上打 x64 包时 Docker 会用模拟运行，比较慢。

---

## 5. 其他

### 5.1 版本号

改 `apps/desktop/package.json` 的 `version`。CI 打包时用 `-c.extraMetadata.buildNumber=$CI_PIPELINE_ID` 写入构建号。

### 5.2 应用图标

图标源文件是 `apps/desktop/build/icon-source.png`。替换后重新生成各平台图标（`icon.icns`、`icon.ico`、`icon.png`、窗口图标、界面里的 logo）：

```bash
cd apps/desktop
npx electron scripts/make-icons.cjs build/icon-source.png
```

### 5.3 验证打包后的应用（E2E）

```bash
pnpm --filter @itm/desktop dist:e2e
cd apps/desktop
ITM_E2E_EXECUTABLE="$PWD/release/e2e/mac-arm64/iTerminal.app/Contents/MacOS/iTerminal" npx playwright test
```

`dist:e2e` 只为 Playwright 打开 `--inspect` 这一个 Fuse，其他配置和正式包一致；不要分发这个包。

### 5.4 发布到后端发布服务

CI 的 `publish` 阶段（手动触发）执行：

```bash
ITM_SERVER=https://ops.iterminal.corp ITM_RELEASE_TOKEN=… \
  ./scripts/publish.sh --channel stable --rollout 10 --dir apps/desktop/release
```

- `--channel stable|beta`、`--rollout 1–100`（灰度比例）、`--min-version`（低于这个版本强制升级）、`--dry-run`；
- 可选 `ITM_GPG_KEY_ID`：给 Linux 安装包生成 `.asc` 签名。

在管理后台手动上传时，自动更新需要的文件：

| 系统 | 必须上传 | 可选 |
|---|---|---|
| macOS（每个架构一份） | `iTerminal-<版本>[-arm64]-mac.zip`：自动更新用它 | `.dmg`：「手动下载安装包」优先用它 |
| Windows | `iTerminal Setup <版本>.exe` | `.blockmap`（差量下载）、`.msi` |

- ad-hoc 签名的 mac 包、不签名的 Windows 包也能自动更新（客户端自己下载 zip 替换 .app / 不要求新版本签名，见开发文档一 11.5）；
- **1.0.0 和之前构建的 1.0.1 不能自动更新到新版本**（Windows 报 `is not signed by the application owner`，macOS 报「代码未能满足指定的代码要求」），这些电脑需要手动安装一次新版本。给它们发新版本时先**不要填「最低支持版本」**，否则强制升级窗口关不掉、又装不上。

### 5.5 企业预置配置

安装包本身不带服务端地址；企业可以预置配置：Windows 注册表、macOS MDM 配置描述文件、Linux `/etc/iterminal/config.json`（详见开发文档一的预置配置章节）。

### 5.6 常见问题

| 现象 | 处理 |
|---|---|
| 下载 Electron / 打包工具很慢或失败 | 设置上面的镜像变量；或者手动下载放进缓存目录 |
| 原生模块报 `NODE_MODULE_VERSION` 不匹配 | `pnpm --filter @itm/desktop exec electron-builder install-app-deps` |
| 本地终端打不开，报 `posix_spawnp failed` | `node apps/desktop/scripts/fix-node-pty.mjs` |
| macOS 打包时弹出钥匙串授权、或用了个人证书 | 本机打包加 `-c.mac.identity=-`，或 `CSC_IDENTITY_AUTO_DISCOVERY=false` |
| macOS 打开提示「已损坏」 | 没有公证的包被隔离：`xattr -dr com.apple.quarantine /Applications/iTerminal.app` |
| `pnpm dev` 时 Dock 显示「Electron」 | `node apps/desktop/scripts/dev-app-name.mjs`（`pnpm dev` 会自动执行），然后重新启动；仍不对时 `killall Dock` |
| 自动更新报 `is not signed by the application owner`（Windows）或「代码未能满足指定的代码要求」（macOS） | 装的是 1.0.0 或之前构建的 1.0.1，见 5.4：手动安装一次新版本；新版本的强制升级窗口里也有「手动下载安装包」 |
| 交叉打 Windows 包后在 Windows 上启动报原生模块错误 | 确认用的是 `dist:win:cross`（会排除 macOS 的原生二进制），不要用 `dist:win` 在 Mac 上打 |
