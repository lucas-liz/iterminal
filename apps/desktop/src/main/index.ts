import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, net, Notification, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences, webContents, type MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { AccountSession, accountLogin, fetchAvatar, normalizeServerUrl } from './services/server/account-session';
import { ServerConfigStore } from './services/server/server-config';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { clipboardFiles, type ClipboardLike } from './util/clipboard-files';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import appIcon from '../../resources/icon.png?asset';
import {
  DEFAULT_SERVER_URL,
  LEGACY_SERVER_URLS,
  LOCKED_CHANNELS,
  PRE_UNLOCK_CHANNELS,
  type AccountState,
  type AppInfo,
  type FeedbackEnv,
  type FileFilter,
  type IpcChannel,
  type IpcEventName,
  type IpcEvents,
} from '@itm/protocol';
import { KeyStore, type KeyProtector } from './services/vault/keystore';
import { LOCAL_PROFILE, ProfileStore, type ProfileEntry } from './services/profile/profile-store';
import { registerIpc } from './ipc/router';
import { createHandlers } from './app/handlers';
import { ProfileContext } from './app/profile-context';
import { mockSerial, realSerial } from './services/connection/serial';
import { SecurityManager } from './app/security-manager';
import { UserError } from './util/errors';
import { BACKGROUND_FILE, setDefaultOverrides } from './services/settings/settings-repo';
import { DEFAULT_PRESET, loadPreset } from './app/preset';
import { buildDefaultServerUrl, buildLegacyServerUrls } from './app/build-config';
import { redactServers, setServerSource } from './util/redact-server';
import { applyDataLocation, locationError, scheduleDataMove } from './app/data-location';
import { autoUpdater } from 'electron-updater';
import { UpdaterService, type UpdaterLike } from './services/update/updater-service';
import { macDirectFactory } from './services/update/mac-direct';
import { relaxUnsignedUpdateCheck, type VerifySignature } from './services/update/win-signature';
import { createApprovalEngine, type ApprovalEngine } from '@itm/approval';
import { UtilityRuntime } from './services/ai/utility-runtime';
import type { PresetConfig } from '@itm/protocol';
import { diag } from './services/diag/diag-log';
import { FeedbackService } from './services/diag/feedback';

// E2E 测试用独立的数据目录，不碰开发者自己的数据
if (process.env.ITM_USER_DATA) {
  app.setPath('userData', process.env.ITM_USER_DATA);
}
// 自定义本地数据目录（设置 → 存储位置）：在打开任何数据之前完成待迁移的复制并切换
const defaultDataDir = app.getPath('userData');
const dataDir = applyDataLocation(defaultDataDir);
if (dataDir !== defaultDataDir) app.setPath('userData', dataDir);

const isMac = process.platform === 'darwin';

// 诊断日志（第十三轮，文档一 6.27.1）：应用级，{userData}/logs/main.log；反馈时附带操作轨迹和日志尾部
diag.init(join(app.getPath('userData'), 'logs'));
diag.info('app', '启动', {
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  packaged: app.isPackaged,
  customDataDir: dataDir !== defaultDataDir,
});
// uncaughtExceptionMonitor 只旁听，不改变 Electron 默认的处理（弹出错误框）
process.on('uncaughtExceptionMonitor', (e, origin) => diag.error('error', `主进程未捕获的异常（${origin}）：${e?.message ?? e}`, e));
process.on('unhandledRejection', (reason) => {
  diag.error('error', `主进程未处理的 Promise 拒绝：${(reason as Error)?.message ?? String(reason)}`, reason);
  console.error('Unhandled rejection:', reason);
});
app.on('render-process-gone', (_e, _wc, details) => diag.error('error', `界面进程退出：${details.reason}`, { reason: details.reason, exitCode: details.exitCode }));
app.on('child-process-gone', (_e, details) => diag.log(details.reason === 'clean-exit' ? 'info' : 'error', 'error', `子进程退出：${details.type} ${details.reason}`, { type: details.type, name: details.name, reason: details.reason, exitCode: details.exitCode }));
app.on('before-quit', () => {
  diag.info('app', '退出');
  diag.flush();
});

// 终端背景图片 / 视频（第十二轮）：itm-media://bg/{文件名}，只能读当前档案 appearance/ 目录里由主进程复制进去的文件。
// 必须在 ready 之前登记；stream 让视频可以边读边放
protocol.registerSchemesAsPrivileged([{ scheme: 'itm-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
/** 本地模式（无需配置后台/无需登录）默认允许直接配置个人 API Key 或连接 Ollama 使用 AI；仅当显式设置 ITM_ALLOW_LOCAL_AI=0 时才限制必须登录 */
const allowLocalAi = process.env.ITM_ALLOW_LOCAL_AI !== '0';
// 左侧导航默认隐藏数据库、监控等页面；E2E 大多直接点这些页面，测试时（没有打包）可以用 ITM_NAV_ALL=1 让默认全部显示
if (process.env.ITM_NAV_ALL === '1' && !app.isPackaged) setDefaultOverrides({ 'ui.navHidden': [] });
const devServerUrl = process.env.ELECTRON_RENDERER_URL;
const rendererHtml = join(__dirname, '../renderer/index.html');
const rendererUrl = pathToFileURL(rendererHtml).href;

function isTrustedUrl(url: string): boolean {
  return devServerUrl ? url.startsWith(devServerUrl) : url.startsWith(rendererUrl);
}

/**
 * 系统钥匙串保护本地密钥。ITM_INSECURE_KEYSTORE=1 只给自动化测试用（避免 CI 弹出钥匙串授权框），
 * 此时密钥只做混淆，设置页会显示「保护较弱」。
 */
function createProtector(): { protector: KeyProtector; forceMaster: boolean } {
  const testMode = process.env.ITM_INSECURE_KEYSTORE === '1';
  if (testMode || !safeStorage.isEncryptionAvailable()) {
    return {
      protector: {
        strength: 'weak',
        encrypt: (b) => Buffer.from(b.map((x) => x ^ 0xa5)),
        decrypt: (b) => Buffer.from(b.map((x) => x ^ 0xa5)),
      },
      // 没有系统钥匙串时必须用主密码保护（文档一 10.2）；自动化测试除外
      forceMaster: !testMode,
    };
  }
  const weak = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
  return {
    protector: {
      strength: weak ? 'weak' : 'os',
      // 和 v0.2 相同：按 UTF-8 文本加解密（KeyStore 自己负责把二进制编码成文本）
      encrypt: (b) => safeStorage.encryptString(b.toString('utf8')),
      decrypt: (b) => Buffer.from(safeStorage.decryptString(b), 'utf8'),
    },
    forceMaster: weak,
  };
}

/** 推给界面的状态事件里，这些记进操作轨迹（同一个对象的内容没变时不重复记） */
const LOGGED_EVENTS: Partial<Record<IpcEventName, (p: never) => { key: string; level?: 'info' | 'warn' | 'error'; msg: string; data: unknown } | null>> = {
  'session.status': (p: IpcEvents['session.status']) => ({ key: p.sessionId, level: p.status === 'error' ? 'warn' : 'info', msg: `会话 ${p.status}`, data: p }),
  'server.state': (p: IpcEvents['server.state']) => ({ key: 'server', level: p.status === 'offline' ? 'warn' : 'info', msg: `服务端连接 ${p.status}`, data: { status: p.status, lastError: p.lastError } }),
  'account.state': (p: IpcEvents['account.state']) => ({ key: 'account', msg: `账号 ${p.status}`, data: { status: p.status, message: p.message } }),
  'update.state': (p: IpcEvents['update.state']) => ({ key: 'update', level: p.status === 'error' ? 'warn' : 'info', msg: `自动更新 ${p.status}`, data: { status: p.status, error: p.error, available: p.available?.version ?? null } }),
  'security.state': (p: IpcEvents['security.state']) => ({ key: 'security', msg: p.locked ? '界面已锁定' : p.ready ? '已解锁' : '等待解锁', data: { ready: p.ready, locked: p.locked } }),
  'agent.attention': (p: IpcEvents['agent.attention']) => ({ key: `${Date.now()}`, msg: `需要注意：${p.title}`, data: { conversationId: p.conversationId } }),
  'portforward.status': (p: IpcEvents['portforward.status']) => ({ key: `pf:${p.id}`, level: p.state === 'error' ? 'warn' : 'info', msg: `端口转发 ${p.state}`, data: { id: p.id, state: p.state, message: p.message } }),
};
const lastLogged = new Map<string, string>();
function logEvent<E extends IpcEventName>(event: E, payload: IpcEvents[E]): void {
  const f = LOGGED_EVENTS[event] as ((p: IpcEvents[E]) => { key: string; level?: 'info' | 'warn' | 'error'; msg: string; data: unknown } | null) | undefined;
  if (!f) return;
  try {
    const r = f(payload);
    if (!r) return;
    const k = `${event}:${r.key}`;
    const v = JSON.stringify(r.data);
    if (lastLogged.get(k) === v) return;
    lastLogged.set(k, v);
    if (lastLogged.size > 500) lastLogged.delete(lastLogged.keys().next().value!);
    diag.log(r.level ?? 'info', 'event', r.msg, r.data);
  } catch {
    // 记日志失败不影响事件
  }
}

const broadcast = <E extends IpcEventName>(event: E, payload: IpcEvents[E]): void => {
  logEvent(event, payload);
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.send(event, payload);
  }
};

const emit = <E extends IpcEventName>(owner: number, event: E, payload: IpcEvents[E]): void => {
  logEvent(event, payload);
  const wc = webContents.fromId(owner);
  if (wc && !wc.isDestroyed()) {
    wc.send(event, payload);
  }
};

function windowOf(owner: number): BrowserWindow | null {
  const wc = webContents.fromId(owner);
  return wc ? BrowserWindow.fromWebContents(wc) : null;
}

let current: ProfileContext | null = null;
let security: SecurityManager | null = null;
let runtime: UtilityRuntime | null = null;

/** 本机设备 ID（服务端连接的 hello、灰度哈希），第一次使用时生成 */
function deviceId(): string {
  const file = join(app.getPath('userData'), 'device-id');
  try {
    const v = readFileSync(file, 'utf8').trim();
    if (/^[\w-]{8,64}$/.test(v)) return v;
  } catch {
    // 还没有
  }
  const id = randomUUID();
  writeFileSync(file, id, { mode: 0o600 });
  return id;
}

/**
 * ITM_SERVER_URL + ITM_SERVER_TOKEN 只给自动化测试用：本地档案也连接模拟服务端。
 * 账号档案由档案自己的登录会话（AccountSession）连接，这里返回 null。
 */
function serverConfig(entry: ProfileEntry): { url: string; token(): Promise<string | null>; deviceId: string } | null {
  const testUrl = process.env.ITM_SERVER_URL;
  if (testUrl && entry.kind === 'local') {
    const token = process.env.ITM_SERVER_TOKEN ?? null;
    return { url: testUrl, token: async () => token, deviceId: deviceId() };
  }
  return null;
}

/** 问题反馈的环境信息里和档案有关的部分：设置摘要、数据条数、打开的会话（不含地址、密码） */
function profileEnv(c: ProfileContext): FeedbackEnv {
  const s = c.settings.getAll();
  const counts = c.sync.stats().counts;
  let providers: string;
  try {
    const list = c.providers.list();
    providers = list.length ? `${list.length} 个（${[...new Set(list.map((p) => p.type))].join('、')}）` : '没有';
  } catch {
    providers = '不可用（本地模式不能使用 AI）';
  }
  const sessions = c.sessions.summary();
  const kinds = [...new Set(sessions.map((x) => x.kind))].map((k) => `${k} ${sessions.filter((x) => x.kind === k).length}`).join('、');
  const server = c.serverState();
  return {
    设置: {
      主题: `${s['ui.theme']}（深色 ${s['ui.themeDark']} / 浅色 ${s['ui.themeLight']}）`,
      终端字号: s['terminal.fontSize'],
      AI模型: providers,
      默认Agent权限: s['ai.defaultAgentPolicy'],
      只读命令自动执行: s['ai.autoApproveReadonly'],
      MCP服务: s['mcp.server.enabled'] ? `开启（写操作${s['mcp.server.allowWrite'] ? '允许' : '不允许'}、高危${s['mcp.server.allowDanger'] ? '允许' : '不允许'}）` : '关闭',
    },
    数据: { 主机: counts.hosts, 主机分组: counts.hostGroups, 凭证: counts.credentials, 快捷命令: counts.snippets, 笔记: counts.notes },
    会话: { 打开的会话: sessions.length, 已连接: sessions.filter((x) => x.ready).length, 类型: kinds || '—' },
    服务端连接: { 状态: server.status, 最近的错误: server.lastError ?? '—' },
  };
}

function bootstrap(preset: PresetConfig, approval: ApprovalEngine): { onWindowClosed: (owner: number) => void } {
  // Agent 在独立的 utilityProcess 里运行（文档一 5.1）；审批引擎在主进程（tree-sitter-bash 的 WASM 随应用打包）
  runtime = new UtilityRuntime(join(__dirname, 'agent.js'));
  const agentRuntime = runtime;
  const builtDefaultServer = buildDefaultServerUrl() || DEFAULT_SERVER_URL || null;
  const builtLegacyServers = buildLegacyServerUrls().length ? buildLegacyServerUrls() : LEGACY_SERVER_URLS;
  const profiles = new ProfileStore(join(app.getPath('userData'), 'profiles'), Date.now, {
    defaultUrl: builtDefaultServer,
    legacyUrls: builtLegacyServers,
  });
  const { protector, forceMaster } = createProtector();
  const keystore = new KeyStore(app.getPath('userData'), protector);
  const touchIdAvailable = (): boolean => isMac && systemPreferences.canPromptTouchID();
  // ITM_SERIAL_MOCK=1 只给自动化测试用：两个会回显的模拟串口
  const serialProvider = process.env.ITM_SERIAL_MOCK === '1' ? mockSerial(['/dev/ITM-MOCK0', '/dev/ITM-MOCK1']) : realSerial;

  const openProfile = (): void => {
    const entry = profiles.current();
    diag.info('app', '打开档案', { kind: entry.kind });
    current?.close();
    current = new ProfileContext({
      downloadsDir: () => app.getPath('downloads'),
      profile: entry,
      dir: profiles.dir(entry.id),
      keystore,
      emit,
      trashItem: (p) => shell.trashItem(p),
      revealItem: (p) => shell.showItemInFolder(p),
      openPath: (p) => shell.openPath(p),
      approval,
      runtime: agentRuntime,
      serialProvider,
      owner: () => BrowserWindow.getAllWindows()[0]?.webContents.id ?? null,
      locked: () => security?.state().locked ?? false,
      appVersion: app.getVersion(),
      server: serverConfig(entry),
      deviceId: deviceId(),
      requireLoginForAi: !allowLocalAi,
      onAccount: () => broadcast('account.state', accountState()),
      broadcast,
      notify: (title, body) => {
        // 定时任务失败、等待批准：应用不在前台时发系统通知
        if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
        const n = new Notification({ title: `iTerminal：${title}`, body: body.slice(0, 200) });
        n.on('click', () => BrowserWindow.getAllWindows()[0]?.focus());
        n.show();
      },
      notifyApproval: (a) => {
        // 应用不在前台时发系统通知（文档一 6.11 远程审批）
        if (BrowserWindow.getFocusedWindow() || !Notification.isSupported()) return;
        const n = new Notification({ title: 'iTerminal：有命令等你审批', body: `${a.taskName ? `${a.taskName} · ` : ''}${a.host}：${a.command}`.slice(0, 200) });
        n.on('click', () => BrowserWindow.getAllWindows()[0]?.focus());
        n.show();
      },
    });
  };

  const sec = new SecurityManager({
    keystore,
    forceMaster,
    touchIdAvailable,
    promptTouchId: (reason) => systemPreferences.promptTouchID(reason),
    openProfile,
    broadcast: (state) => broadcast('security.state', state),
    lockSettings: () => {
      if (!current) return null;
      const s = current.settings.getAll();
      return { autoLockMin: s['security.autoLockMin'], touchId: s['security.touchId'] };
    },
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
  });
  security = sec;
  powerMonitor.on('lock-screen', () => sec.onSystemLock());
  powerMonitor.on('suspend', () => sec.onSystemLock());

  const ctx = (): ProfileContext => {
    if (!current) throw new UserError('请先输入主密码解锁');
    return current;
  };

  const appInfo = (): AppInfo => {
    const entry = current?.profile ?? profiles.current();
    return {
      version: app.getVersion(),
      platform: process.platform,
      profile: {
        id: entry.id,
        kind: entry.kind,
        displayName: entry.kind === 'local' ? '本地模式' : (entry.displayName ?? entry.username ?? '账号'),
      },
      dataDir: current?.dir ?? profiles.root,
      keyProtection: protector.strength,
      security: sec.state(),
      // 界面上不显示服务端地址
      preset: { ...preset, serverUrl: null },
      aiLocal: allowLocalAi,
    };
  };

  const dialogOpts = <T extends object>(owner: number, opts: T): Promise<Electron.OpenDialogReturnValue> => {
    const win = windowOf(owner);
    return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts);
  };
  const filtersOf = (f?: FileFilter[]) => f?.map((x) => ({ name: x.name, extensions: x.extensions }));

  // 服务端地址只在主进程里使用（界面上不显示，登录框也不能填写）：管理员在隐藏设置里改的地址 > 企业预置 > 默认地址。
  // ITM_DEFAULT_SERVER_URL 只给自动化测试和本地开发用（没有打包时），让登录连接模拟服务端 / 本机后端
  const serverAddr = new ServerConfigStore({
    file: join(app.getPath('userData'), 'server-config.json'),
    presetUrl: () => preset.serverUrl,
    testPassword: !app.isPackaged ? process.env.ITM_ADMIN_PASSWORD || null : null,
  });
  const defaultServer = (): string | null => {
    const raw = (!app.isPackaged && process.env.ITM_DEFAULT_SERVER_URL) || serverAddr.custom() || preset.serverUrl || builtDefaultServer;
    return raw ? normalizeServerUrl(raw) : null;
  };
  // 发给界面的错误提示、诊断信息里出现的这些地址换成「服务端」
  setServerSource(() => [
    builtDefaultServer,
    ...builtLegacyServers,
    preset.serverUrl,
    serverAddr.custom(),
    process.env.ITM_DEFAULT_SERVER_URL,
    process.env.ITM_SERVER_URL,
    process.env.ITM_UPDATE_SERVER,
    ...profiles.list().map((p) => p.serverUrl),
  ]);

  // 自动更新（文档一 11.5）：整个应用一个，解锁前也能检查
  const updater = new UpdaterService({
    updater: autoUpdater as unknown as UpdaterLike,
    preset,
    version: app.getVersion(),
    configDir: app.getPath('userData'),
    emit: (state) => broadcast('update.state', state),
    // 只给自动化测试用：指定发布服务地址、在没打包的开发模式下也检查
    serverOverride: process.env.ITM_UPDATE_SERVER || null,
    adminServer: () => serverAddr.custom(),
    accountServer: () => {
      const entry = current?.profile ?? profiles.current();
      return entry.kind === 'account' ? (entry.serverUrl ?? null) : null;
    },
    forceDev: process.env.ITM_UPDATE_FORCE_DEV === '1',
    defaultServer: builtDefaultServer,
    // 第十九轮：ad-hoc 签名的 mac 包 Squirrel.Mac 装不了，自己下载 zip、退出后替换 .app
    direct: macDirectFactory({ exe: app.getPath('exe'), workDir: join(app.getPath('userData'), 'pending-update'), fetch: (url) => net.fetch(url), packaged: app.isPackaged }),
    manual: {
      dir: () => app.getPath('downloads'),
      fetch: (url) => net.fetch(url),
      // exe / msi / dmg 直接打开（运行安装程序、挂载磁盘映像），其他的在文件夹里显示
      open: (file) => (/\.(exe|msi|dmg)$/i.test(file) ? void shell.openPath(file) : shell.showItemInFolder(file)),
    },
    quit: () => app.quit(),
  });
  // 第十九轮：Windows 内测包没签名时不校验新版本的签名（当前程序签了名才校验）
  if (process.platform === 'win32' && app.isPackaged) {
    relaxUnsignedUpdateCheck(autoUpdater as unknown as { verifyUpdateCodeSignature: VerifySignature }, process.execPath, (msg) => diag.info('app', `自动更新：${msg}`));
  }
  app.on('will-quit', () => updater.installOnQuit());
  updater.start(Number(process.env.ITM_UPDATE_CHECK_DELAY_MS) || 10_000);

  // ---------------------------------------------------------------- 账号（文档一 2.3 / 6.10.8）

  const accountState = (): AccountState => {
    const entry = current?.profile ?? profiles.current();
    const list = profiles
      .list()
      .filter((p) => p.kind === 'account' && p.serverUrl)
      .map((p) => ({ id: p.id, username: p.username ?? '', displayName: p.displayName ?? p.username ?? '' }));
    if (entry.kind !== 'account') {
      return { status: 'none', profileId: entry.id, username: null, displayName: null, email: null, avatar: null, message: null, profiles: list, team: null };
    }
    const st = current?.account?.state() ?? { status: 'expired' as const, message: null };
    const tp = current?.team() ?? null;
    return {
      status: st.status,
      profileId: entry.id,
      username: entry.username ?? null,
      displayName: entry.displayName ?? null,
      email: entry.email ?? null,
      avatar: entry.avatar ?? null,
      message: st.message ? redactServers(st.message) : null,
      profiles: list,
      team: { models: tp?.providers.length ?? 0, allowPersonalProvider: tp?.allowPersonalProvider !== false },
    };
  };

  /** 切换档案：关闭当前档案的全部会话，打开新档案，窗口重新加载（主机、设置、对话都属于档案） */
  const switchTo = (id: string): void => {
    profiles.setCurrent(id);
    openProfile();
    updater.refreshFeed();
    broadcast('account.state', accountState());
    for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
  };

  const account = {
    state: accountState,
    login: async (a: { username: string; password: string; importLocal?: boolean }): Promise<AccountState> => {
      const username = String(a?.username ?? '').trim();
      if (!username || !a?.password) throw new UserError('请填写用户名和密码');
      // 连接哪个服务端由主进程决定：重新登录当前账号时用档案自己的地址，否则用企业预置 / 本地 .env 注入的默认地址
      const cur = current?.profile;
      const serverUrl =
        cur?.kind === 'account' && cur.serverUrl && cur.username?.toLowerCase() === username.toLowerCase() ? cur.serverUrl : defaultServer();
      if (!serverUrl) throw new UserError('当前未配置服务端地址：请在「设置 → 关于」连续点击图标 5 次配置服务端，或在本地打包前通过 .env 配置 ITM_DEFAULT_SERVER_URL');
      const r = await accountLogin({ serverUrl, username, password: a.password, deviceId: deviceId(), clientVersion: app.getVersion() });
      const avatar = await fetchAvatar(serverUrl, r.user.avatar);
      const entry = profiles.ensureAccount({
        userId: String(r.user.userId),
        username: r.user.userName || username,
        displayName: r.user.nickName || r.user.userName || username,
        serverUrl,
        ...(r.user.email ? { email: r.user.email } : {}),
        ...(avatar ? { avatar } : {}),
      });
      // 当前就是这个账号（令牌过期后重新登录）：换上新令牌，不用重新打开档案
      if (current?.profile.id === entry.id && current.account) {
        current.resumeAccount(r);
        broadcast('account.state', accountState());
        return accountState();
      }
      const dir = profiles.dir(entry.id);
      AccountSession.write(dir, keystore.profileKeys(dir, entry.id).vaultKey, r);
      // 首次登录导入本地数据：先从本地档案取出（切换后本地档案就关闭了）
      const snapshot = a.importLocal && current?.profile.kind === 'local' ? current.sync.snapshot() : null;
      switchTo(entry.id);
      if (snapshot && current) current.sync.mergeFrom(snapshot, '导入本地模式的数据之前');
      return accountState();
    },
    logout: async (a: { wipe?: boolean }): Promise<void> => {
      const entry = current?.profile;
      if (!entry || entry.kind !== 'account') return;
      await current?.account?.logout();
      switchTo(LOCAL_PROFILE);
      // 退出并清除本机数据：删除账号档案（档案已经关闭）
      if (a.wipe) profiles.remove(entry.id);
      broadcast('account.state', accountState());
    },
    switch: (a: { profileId: string }): void => {
      const id = String(a?.profileId ?? '');
      if (!profiles.get(id)) throw new UserError('这个档案不存在');
      if (preset.requireLogin && id === LOCAL_PROFILE) throw new UserError('管理员要求必须登录，不能切换到本地模式');
      if (current?.profile.id === id) return;
      switchTo(id);
    },
  };

  // 问题反馈（第十三轮）：应用级；账号模式用档案的登录连接，本地模式走预置 / 默认服务端的匿名接口
  const feedback = new FeedbackService({
    diag,
    version: app.getVersion(),
    profile: () => {
      const e = current?.profile ?? profiles.current();
      return { kind: e.kind, serverUrl: e.kind === 'account' ? (e.serverUrl ?? null) : null, email: e.email ?? null };
    },
    link: () => (current?.profile.kind === 'account' ? (current.server?.link ?? null) : null),
    anonymousServer: defaultServer,
    appEnv: () => {
      const d = screen.getPrimaryDisplay();
      return {
        系统: { 语言: app.getLocale(), 屏幕: `${d.size.width}×${d.size.height} @${d.scaleFactor}x` },
        运行时: { Electron: process.versions.electron, Chrome: process.versions.chrome, Node: process.versions.node, 打包: app.isPackaged, 钥匙串: protector.strength },
      };
    },
    profileEnv: () => (current ? profileEnv(current) : {}),
    capture: async (owner) => {
      const wc = webContents.fromId(owner);
      if (!wc) throw new UserError('窗口不存在');
      const img = await wc.capturePage();
      return { png: img.toPNG(), jpeg: () => img.toJPEG(85) };
    },
  });

  // 隐藏的服务端地址设置：保存后重新确定更新源；已登录的账号仍连接原来的服务端，退出后重新登录才切换
  const admin = {
    unlock: (password: string) => serverAddr.unlock(password),
    get: (token: string) => serverAddr.get(token),
    set: (token: string, url: string | null) => {
      const r = serverAddr.set(token, url);
      diag.info('app', '管理员修改了服务端地址', { source: r.source });
      updater.refreshFeed();
      return r;
    },
    test: (token: string, url: string) => serverAddr.test(token, url),
  };

  // 拖到本机（第十六轮）：先下载到临时目录再开始系统拖拽；临时目录里超过 1 小时的旧文件每次拖拽前清理
  const dragRoot = join(app.getPath('temp'), 'iterminal-drag');
  const dragIcon = (): Electron.NativeImage => nativeImage.createFromPath(appIcon).resize({ width: 40, height: 40 });

  const handlers = createHandlers({
    ctx,
    feedback,
    admin,
    logDir: () => diag.logDir,
    drag: {
      cacheDir: () => {
        try {
          for (const name of readdirSync(dragRoot)) {
            const p = join(dragRoot, name);
            if (Date.now() - statSync(p).mtimeMs > 3600_000) rmSync(p, { recursive: true, force: true });
          }
        } catch {
          // 还没有临时目录
        }
        const dir = join(dragRoot, randomUUID());
        mkdirSync(dir, { recursive: true });
        return dir;
      },
      start: (owner, files) => {
        const wc = webContents.fromId(owner);
        if (!wc || !files.length) return;
        wc.startDrag({ file: files[0], files, icon: dragIcon() });
      },
    },
    clipboardFiles: () => clipboardFiles(clipboard as unknown as ClipboardLike),
    security: sec,
    updater,
    appInfo,
    account,
    preset,
    downloadsDir: () => app.getPath('downloads'),
    openPath: (p) => void shell.openPath(p),
    storage: {
      defaultDir: defaultDataDir,
      dataDir: () => app.getPath('userData'),
      error: () => locationError(defaultDataDir),
      move: (target) => {
        try {
          scheduleDataMove(defaultDataDir, app.getPath('userData'), target);
        } catch (e) {
          throw new UserError((e as Error).message);
        }
        // 先回复渲染进程，再重启（重启后复制数据）
        setTimeout(() => {
          app.relaunch();
          app.quit();
        }, 300);
      },
    },
    dialogs: {
      openFiles: async (owner, opts) => {
        const r = await dialogOpts(owner, { title: opts?.title ?? '选择要上传的文件', properties: ['openFile', 'multiSelections'] as ('openFile' | 'multiSelections')[], ...(opts?.filters ? { filters: filtersOf(opts.filters) } : {}) });
        return r.canceled ? [] : r.filePaths;
      },
      openFile: async (owner, title, filters) => {
        const r = await dialogOpts(owner, { title, properties: ['openFile', 'showHiddenFiles'] as ('openFile' | 'showHiddenFiles')[], filters: filtersOf(filters) });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      openDirectory: async (owner, title) => {
        const r = await dialogOpts(owner, { title, properties: ['openDirectory', 'showHiddenFiles'] as ('openDirectory' | 'showHiddenFiles')[] });
        return r.canceled ? null : (r.filePaths[0] ?? null);
      },
      saveFile: async (owner, title, defaultName, filters) => {
        const win = windowOf(owner);
        const opts = { title, defaultPath: join(app.getPath('documents'), defaultName), filters: filtersOf(filters) };
        const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
        return r.canceled || !r.filePath ? null : r.filePath;
      },
    },
    window: {
      minimize: (owner) => windowOf(owner)?.minimize(),
      maximizeToggle: (owner) => {
        const win = windowOf(owner);
        if (!win) return false;
        if (win.isMaximized()) {
          win.unmaximize();
          return false;
        }
        win.maximize();
        return true;
      },
      close: (owner) => windowOf(owner)?.close(),
      isMaximized: (owner) => windowOf(owner)?.isMaximized() ?? false,
    },
  });

  const preUnlock = new Set<IpcChannel>(PRE_UNLOCK_CHANNELS);
  const lockedAllowed = new Set<IpcChannel>(LOCKED_CHANNELS);
  registerIpc(handlers, isTrustedUrl, (channel) => {
    if (!sec.isReady()) return preUnlock.has(channel) ? null : '请先输入主密码解锁';
    if (sec.isLocked()) return lockedAllowed.has(channel) ? null : 'iTerminal 已锁定，请先解锁';
    return null;
  });

  void sec.start().catch((e: Error) => {
    dialog.showErrorBox('iTerminal 无法打开本地数据', e.message);
  });

  return { onWindowClosed: (owner) => current?.windowClosed(owner) };
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

/**
 * 窗口大小：第一次启动时按屏幕可用区域的 86% × 88%（上限 1600 × 1020，不小于最小尺寸）；
 * 之后记住上次关闭时的大小和位置（{userData}/window-state.json），位置不在任何屏幕上时居中。
 */
function windowState(): WindowState {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const fallback: WindowState = {
    width: Math.max(1024, Math.min(1600, Math.round(area.width * 0.86))),
    height: Math.max(640, Math.min(1020, Math.round(area.height * 0.88))),
  };
  try {
    const raw = JSON.parse(readFileSync(join(app.getPath('userData'), 'window-state.json'), 'utf8')) as WindowState;
    if (!(raw.width >= 1024 && raw.height >= 640)) return fallback;
    const visible =
      raw.x === undefined ||
      raw.y === undefined ||
      screen.getAllDisplays().some((d) => raw.x! < d.workArea.x + d.workArea.width - 100 && raw.x! + raw.width > d.workArea.x + 100 && raw.y! >= d.workArea.y - 20 && raw.y! < d.workArea.y + d.workArea.height - 100);
    return visible ? raw : { width: raw.width, height: raw.height, maximized: raw.maximized };
  } catch {
    return fallback;
  }
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const b = win.getNormalBounds();
    writeFileSync(join(app.getPath('userData'), 'window-state.json'), JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    // 保存失败不影响退出
  }
}

function createWindow(onWindowClosed: (owner: number) => void): BrowserWindow {
  const state = windowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'iTerminal',
    // Windows / Linux 的窗口和任务栏图标（macOS 用应用包里的 icns）
    ...(isMac ? {} : { icon: appIcon }),
    backgroundColor: '#141415',
    // macOS 保留原生红绿灯（与 44px 顶部栏垂直居中）；Windows / Linux 隐藏原生标题栏和菜单栏，由界面右上角提供最小化 / 最大化 / 关闭按钮
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 16, y: 16 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const owner = win.webContents.id;
  if (!isMac) win.setMenuBarVisibility(false);
  if (state.maximized) win.maximize();
  win.on('maximize', () => emit(owner, 'window.maximized', { maximized: true }));
  win.on('unmaximize', () => emit(owner, 'window.maximized', { maximized: false }));
  win.on('close', () => saveWindowState(win));
  win.once('ready-to-show', () => win.show());
  // 排查问题用（第三十五轮）：Ctrl+Shift+I（macOS ⌥⌘I）打开开发者工具，打包后也能用（Windows 是无边框窗口，没有菜单栏）。
  // 不用 F12：终端里的程序（mc、htop 等）要用
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const combo = key === 'i' && input.shift && (isMac ? input.meta && input.alt : input.control);
    if (!combo) return;
    e.preventDefault();
    win.webContents.toggleDevTools();
  });
  win.webContents.on('destroyed', () => onWindowClosed(owner));
  // 页面只能是应用自己的界面：禁止跳转，外部链接交给系统浏览器
  win.webContents.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url)) {
      e.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(rendererHtml);
  }
  return win;
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'reload', visible: !app.isPackaged },
        { role: 'toggleDevTools', visible: !app.isPackaged },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      // 自己写窗口菜单：⌘W 关闭当前标签页（像浏览器），关闭窗口改成 ⇧⌘W。Windows / Linux 上 Ctrl+W 是 shell 的删词键，用 Ctrl+Shift+W
      role: 'windowMenu',
      submenu: [
        { id: 'close-tab', label: '关闭标签页', accelerator: isMac ? 'Cmd+W' : 'Ctrl+Shift+W', click: () => broadcast('app.command', { command: 'closeTab' }) },
        { role: 'minimize' },
        ...(isMac ? ([{ role: 'zoom' }, { type: 'separator' }, { role: 'close', accelerator: 'Shift+Cmd+W' }, { type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[]) : [{ role: 'close' } as MenuItemConstructorOptions]),
      ],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        { label: '问题反馈…', click: () => broadcast('app.command', { command: 'feedback' }) },
        { label: '打开日志目录', click: () => diag.logDir && void shell.openPath(diag.logDir) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) {
        win.restore();
      }
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    // 开发时 Dock 里显示应用图标（打包后用应用包里的 icns）
    if (isMac && !app.isPackaged) app.dock?.setIcon(appIcon);
    // 「关于 iTerminal」面板、Windows 通知和任务栏里显示的名称
    app.setAboutPanelOptions({ applicationName: 'iTerminal', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 Corp.', ...(isMac ? {} : { iconPath: appIcon }) });
    if (process.platform === 'win32') app.setAppUserModelId('com.corp.iterminal');
    // 渲染进程只需要读写剪贴板（终端复制粘贴），其余权限一律拒绝；页面只能是应用自己的界面（见 will-navigate）
    const allowed = new Set(['clipboard-sanitized-write', 'clipboard-read']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

    protocol.handle('itm-media', (req) => {
      const u = new URL(req.url);
      const file = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      if (u.host !== 'bg' || !BACKGROUND_FILE.test(file) || !current) return new Response('Not found', { status: 404 });
      const path = join(current.dir, 'appearance', file);
      if (!existsSync(path)) return new Response('Not found', { status: 404 });
      // 带上 Range 头：视频可以拖动、循环播放时不用整个读进内存
      return net.fetch(pathToFileURL(path).toString(), { headers: req.headers });
    });

    const preset = await loadPreset().catch(() => DEFAULT_PRESET);
    const approval = await createApprovalEngine({
      bashWasm: join(__dirname, 'wasm', 'tree-sitter-bash.wasm'),
      treeSitterWasm: join(__dirname, 'wasm', 'web-tree-sitter.wasm'),
    });
    let boot: ReturnType<typeof bootstrap>;
    try {
      boot = bootstrap(preset, approval);
    } catch (e) {
      dialog.showErrorBox('iTerminal 无法启动', (e as Error).message);
      app.quit();
      return;
    }
    buildMenu();
    createWindow(boot.onWindowClosed);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow(boot.onWindowClosed);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) {
      app.quit();
    }
  });

  app.on('before-quit', () => {
    security?.stop();
    current?.close();
    current = null;
    runtime?.dispose();
  });
}
