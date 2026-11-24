import { runNoteInput } from '../services/schedule/plan';
import { hostMemoryMarkdown, hostProfileText, memoryFileName, type HostMemoryEntry } from '../services/hosts/host-profile';
import { BACKGROUND_IMAGE_EXT, BACKGROUND_VIDEO_EXT, MCP_SERVER_TOOLS, type AccountState, type AdminServerConfig, type AdminServerTest, type AppInfo, type LoginInput, type PresetConfig, type TaskRunFilter } from '@itm/protocol';
import type { Handlers } from '../ipc/router';
import { checkExecutable } from '../services/connection/file-check';
import { UserError } from '../util/errors';
import { parseHex } from '../services/connection/session-manager';
import { ConnTrace } from '../services/connection/conn-trace';
import { pingHosts } from '../services/hosts/host-ping';
import { recordingTranscript } from '../services/audit/recording-text';
import { probeModel } from '../services/ai/model-probe';
import { fetchModelList } from '../services/ai/model-list';
import { Masker } from '@itm/masking';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dirSize } from './data-location';
import type { ProfileContext } from './profile-context';
import type { SecurityManager } from './security-manager';
import type { UpdaterService } from '../services/update/updater-service';
import type { FeedbackService } from '../services/diag/feedback';
import { diag } from '../services/diag/diag-log';
import { toCsv } from '../services/database/db-tools';
import { importNoteFiles, NOTE_IMPORT_EXT, NOTE_WORD_EXT } from '../services/library/note-import';

export interface HandlerDeps {
  ctx: () => ProfileContext;
  /** 问题反馈（应用级，第十三轮） */
  feedback: FeedbackService;
  /** 诊断日志目录 */
  logDir: () => string | null;
  /** 拖到本机（第十六轮）：临时目录、开始系统拖拽 */
  drag: { cacheDir(): string; start(owner: number, files: string[]): void };
  /** 系统剪贴板里复制的本机文件 */
  clipboardFiles(): Promise<string[]>;
  security: SecurityManager;
  updater: UpdaterService;
  appInfo: () => AppInfo;
  preset: PresetConfig;
  downloadsDir: () => string;
  openPath: (path: string) => void;
  /** 账号：登录、退出登录、切换档案（在 index.ts 里实现，需要档案清单和窗口） */
  account: {
    state(): AccountState;
    login(a: LoginInput): Promise<AccountState>;
    logout(a: { wipe?: boolean }): Promise<void>;
    switch(a: { profileId: string }): void;
  };
  /** 隐藏的服务端地址设置（管理员密码；见 services/server/server-config.ts） */
  admin: {
    unlock(password: string): { token: string; expiresAt: number };
    get(token: string): AdminServerConfig;
    set(token: string, url: string | null): AdminServerConfig;
    test(token: string, url: string): Promise<AdminServerTest>;
  };
  /** 本地数据目录（设置 → 存储位置） */
  storage: {
    defaultDir: string;
    dataDir(): string;
    error(): string | null;
    /** 写入待迁移后重启应用 */
    move(target: string | null): void;
  };
  dialogs: {
    openFiles(owner: number, opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string[]>;
    openFile(owner: number, title: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
    openDirectory(owner: number, title: string): Promise<string | null>;
    saveFile(owner: number, title: string, defaultName: string, filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  };
  /** 自定义标题栏窗口控制（Windows / Linux） */
  window: {
    minimize(owner: number): void;
    maximizeToggle(owner: number): boolean;
    close(owner: number): void;
    isMaximized(owner: number): boolean;
  };
}

/** 拖到本机时先下载到临时目录：超过这个大小改为普通下载 */
export const DRAG_OUT_LIMIT = 64 * 1024 * 1024;

/** 用户选的目录：空字符串（默认 / 关闭）或者可以写入的绝对路径 */
function checkDir(dir: string): string {
  const d = String(dir ?? '').trim();
  if (!d) return '';
  if (!isAbsolute(d)) throw new UserError('请选择一个绝对路径');
  const abs = resolve(d);
  try {
    mkdirSync(abs, { recursive: true });
    const probe = join(abs, '.itm-write-test');
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  } catch (e) {
    throw new UserError(`目录不能写入：${(e as Error).message}`);
  }
  return abs;
}

/** 主机列表选中的主机和它们的记忆（导出主机记忆、AI 汇总，第三十轮）：按传入顺序，不存在的跳过 */
function memoryEntries(c: ProfileContext, ids: unknown, max = 500): HostMemoryEntry[] {
  const list = (Array.isArray(ids) ? ids.map(String) : []).slice(0, max);
  const entries = list
    .map((id) => c.hosts.get(id))
    .filter((h): h is NonNullable<typeof h> => !!h)
    .map((host) => ({ host, folderPath: c.folders.chain(host.folderId).map((f) => f.name).join(' / '), memories: c.hosts.agentMemories(host.id) }));
  if (entries.length === 0) throw new UserError('请先选择主机');
  return entries;
}

/** IPC 通道 → 服务。档案相关的调用都通过 ctx() 取当前档案（锁定 / 未解锁时由路由层拦截）。 */
export function createHandlers(d: HandlerDeps): Handlers {
  const { ctx, security } = d;
  return {
    'app.info': () => d.appInfo(),

    'window.minimize': (_a, owner) => d.window.minimize(owner),
    'window.maximizeToggle': (_a, owner) => d.window.maximizeToggle(owner),
    'window.close': (_a, owner) => d.window.close(owner),
    'window.isMaximized': (_a, owner) => d.window.isMaximized(owner),

    'account.state': () => d.account.state(),
    'account.login': (a) => d.account.login(a),
    'account.logout': (a) => d.account.logout(a ?? {}),
    'account.switch': (a) => d.account.switch(a),
    'admin.unlock': (a) => d.admin.unlock(String(a?.password ?? '')),
    'admin.serverGet': (a) => d.admin.get(a?.token),
    'admin.serverSet': (a) => d.admin.set(a?.token, a?.url ?? null),
    'admin.serverTest': (a) => d.admin.test(a?.token, String(a?.url ?? '')),

    'security.unlock': (a) => security.unlock(a.password),
    'security.unlockTouchId': () => security.unlockTouchId(),
    'security.lock': () => security.lock(),
    'security.setup': (a) => security.setup(a.password),
    'security.setMasterPassword': (a) => security.setMasterPassword(a.newPassword, a.currentPassword),
    'security.removeMasterPassword': (a) => security.removeMasterPassword(a.currentPassword),

    'folder.list': () => ctx().folders.list(),
    // 团队主机和分组只读（管理员在服务端维护，见 TeamAssetSync）
    'folder.create': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableFolder(a.parentId);
      return c.folders.create(a.parentId, a.name);
    },
    'folder.rename': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableFolder(a.id);
      return c.folders.rename(a.id, a.name);
    },
    'folder.move': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableFolder(a.id);
      c.teamAssets.assertEditableFolder(a.parentId);
      return c.folders.move(a.id, a.parentId, a.beforeId);
    },
    'folder.delete': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableFolder(a.id);
      return c.folders.delete(a.id, a.strategy);
    },
    'folder.update': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableFolder(a.id);
      return c.folders.update(a.id, a.settings);
    },

    'host.list': () => ctx().hosts.list(),
    'host.create': (a) => {
      const c = ctx();
      c.teamAssets.assertPersonalTarget(a.folderId);
      return c.hosts.create(a);
    },
    'host.update': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableHosts([a.id]);
      c.teamAssets.assertPersonalTarget(a.input.folderId);
      return c.hosts.update(a.id, a.input);
    },
    'host.duplicate': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableHosts([a.id]);
      return c.hosts.duplicate(a.id);
    },
    'host.delete': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableHosts(a.ids);
      // 数据库经过这台主机连接时不能删除（文档一 6.31.2）
      for (const id of a.ids) {
        const used = c.dbAssets.usingHost(id);
        if (used.length) throw new UserError(`「${c.hosts.get(id)?.name ?? id}」是数据库「${used.map((d) => d.name).join('、')}」经过的 SSH 主机，请先修改这些数据库的连接设置`);
      }
      a.ids.forEach((id) => c.forwarding.stopHost(id));
      c.hosts.delete(a.ids);
      c.resident.sync();
    },
    'host.move': (a) => {
      const c = ctx();
      c.teamAssets.assertEditableHosts(a.hostIds);
      c.teamAssets.assertPersonalTarget(a.folderId);
      return c.hosts.move(a.hostIds, a.folderId);
    },
    'team.sync': () => ctx().syncTeamAssets(),
    'kb.collections': () => ctx().kbCollections(),

    'cloud.status': () => ctx().cloud().status(),
    'cloud.setupPassword': (a) => ctx().cloud().setupPassword(a.password),
    'cloud.unlock': (a) => ctx().cloud().unlock(a.password),
    'cloud.recover': (a) => ctx().cloud().recover(a.recoveryCode, a.newPassword),
    'cloud.changePassword': (a) => ctx().cloud().changePassword(a.newPassword),
    'cloud.backups': () => ctx().cloud().listBackups(),
    'cloud.upload': (a) => ctx().cloud().upload(a.groups, a.remark),
    'cloud.restore': (a) => ctx().cloud().restore(a.id, a.groups, a.mode, a.dryRun),
    'cloud.backupUpdate': (a) => ctx().cloud().updateBackup(a.id, { remark: a.remark, pinned: a.pinned }),
    'cloud.backupDelete': (a) => ctx().cloud().deleteBackup(a.id),
    'cloud.share': () => ctx().cloud().share(),
    'cloud.shareEnable': (a) => ctx().cloud().enableShare(a.groups),
    'cloud.shareUpdate': (a) => ctx().cloud().updateShare({ groups: a.groups, enabled: a.enabled }),
    'cloud.shareReveal': () => ctx().cloud().revealShare(),
    'cloud.shareReset': () => ctx().cloud().resetShare(),
    'cloud.shareClose': () => ctx().cloud().closeShare(),
    'cloud.shareRefresh': () => ctx().cloud().refreshShare(),
    'cloud.shareLookup': (a) => ctx().cloud().lookupShare(a.code),
    'cloud.sharePull': (a) => ctx().cloud().pullShare(a.code, a.groups, a.dryRun),
    'cloud.shareOpen': (a) => ctx().cloud().shareOpen(String(a?.code ?? '')),
    'cloud.shareImport': (a) => ctx().cloud().shareImport(String(a?.code ?? ''), a.pick, !!a.dryRun),
    'cloud.shareForget': (a) => {
      if (ctx().server) ctx().cloud().shareForget(String(a?.code ?? ''));
    },
    'share.preview': (a) => ctx().cloud().sharePreview(a?.selection ?? {}),
    'share.create': (a) => ctx().cloud().createLink(a?.selection ?? {}, a.options),
    'share.links': () => ctx().cloud().links(),
    'share.revoke': (a) => ctx().cloud().revokeLink(String(a?.id ?? '')),
    'share.reveal': (a) => ctx().cloud().revealLink(String(a?.id ?? '')),

    'feedback.preview': (a) => d.feedback.preview(a?.maskIps !== false),
    'feedback.capture': (_a, owner) => d.feedback.capture(owner),
    'feedback.submit': (a) => d.feedback.submit(a),
    'feedback.mine': () => d.feedback.mine(),
    'diag.push': (a) => diag.push(a?.entries),
    'diag.openDir': () => {
      const dir = d.logDir();
      if (dir) d.openPath(dir);
    },
    'host.test': async (a, owner) => {
      const c = ctx();
      const target = c.hosts.testTarget(a.id, a.input);
      if (target.host.protocol !== 'SSH') throw new UserError('目前只能测试 SSH 主机的连接');
      // 成功和失败都带上完整的连接日志（文档一 6.15.2）；传了 testId 时边测边推送，日志框打开后实时显示
      const trace = new ConnTrace();
      const testId = typeof a.testId === 'string' ? a.testId.slice(0, 64) : null;
      const off = testId ? trace.subscribe(({ entry }) => entry && c.emit(owner, 'host.testLog', { testId, entry })) : () => undefined;
      try {
        const r = await c.pool.test(target, owner, trace);
        return { ok: true as const, ...r, log: trace.entries };
      } catch (e) {
        return { ok: false as const, error: (e as Error).message, log: trace.entries };
      } finally {
        off();
      }
    },
    'host.agentMemory.list': (a) => ctx().hosts.agentMemories(String(a.hostId)),
    'host.agentMemory.save': (a) => ctx().hosts.saveAgentMemory(a.id ? String(a.id) : null, String(a.hostId), String(a.content ?? '')),
    'host.agentMemory.delete': (a) => ctx().hosts.deleteAgentMemory(String(a.id)),
    'host.memoryMarkdown': (a) => {
      if (!d.preset.allowLocalExport) throw new UserError('管理员禁止了导出本地数据');
      const c = ctx();
      const entries = memoryEntries(c, a?.ids);
      return { fileName: memoryFileName(entries.map((e) => e.host), Date.now()), content: hostMemoryMarkdown(entries, Date.now()) };
    },
    'host.summaryNote': async (a) => {
      const c = ctx();
      const now = Date.now();
      const entries = memoryEntries(c, a?.ids, 20).map((e) => ({
        ...e,
        jumpNames: e.host.jumpHostIds.map((id) => c.hosts.get(id)?.name ?? '（已删除）'),
        samples: c.metrics.history(e.host.id, 7),
        forecast: c.metrics.forecast(e.host.id),
        alerts: c.alerts.list({ hostId: e.host.id, from: now - 30 * 86_400_000, limit: 20 }).items,
        runs: c.scheduler.runs({ hostId: e.host.id, limit: 8 }).items,
        commands: c.audit.hostCommands(e.host.id, now - 30 * 86_400_000, 60),
      }));
      const title = entries.length === 1 ? `主机档案 · ${entries[0].host.name}` : `主机档案 · ${entries[0].host.name} 等 ${entries.length} 台`;
      const body = await c.agent.summarizeHosts(entries.map(hostProfileText).join('\n\n---\n\n'), title, a?.model ?? null);
      c.audit.event('HOST_SUMMARY_NOTE', { count: entries.length });
      return { title, body };
    },
    'host.ping': (a) => {
      const c = ctx();
      const ids = Array.isArray(a?.ids) ? a.ids.map(String).slice(0, 2000) : [];
      const targets = ids.flatMap((id) => {
        const h = c.hosts.get(id);
        if (!h) return [];
        const eff = h.protocol === 'SERIAL' ? null : c.hosts.effective(h.id, h.folderId);
        const skipped = h.protocol === 'SERIAL' ? 'serial' : eff && eff.jumpHostIds.length ? 'jump' : h.proxy ? 'proxy' : null;
        return [{ id: h.id, address: h.address, port: h.port, skipped } as const];
      });
      return pingHosts(targets);
    },
    'host.effective': (a) => ctx().hosts.effective(a.id, a.folderId),
    'host.favorite': (a) => ctx().hosts.setFavorite(a.id, a.on),
    'host.tag': (a) => ctx().tags.addRemove(a.hostIds, a.add, a.remove),

    'tag.list': () => ctx().tags.list(),
    'tag.update': (a) => ctx().tags.update(a.id, a.name, a.color),
    'tag.delete': (a) => ctx().tags.delete(a.id),

    'import.preview': (a) => ctx().imports.preview(a.source, a.path),
    'import.commit': (a) => ctx().imports.commit(a.token, a.keys, a.targetFolderId, a.skipDuplicates),
    'export.hosts': async (a) => {
      if (!d.preset.allowLocalExport) throw new UserError('管理员禁止了导出本地数据');
      if (typeof a.path !== 'string' || !isAbsolute(a.path)) throw new UserError('导出路径不正确');
      const c = ctx();
      if (!a.includeSecrets) return c.imports.exportHosts(a.format, a.path, a.hostIds);
      // 包含敏感信息：先验证主密码（没有主密码时 Touch ID），导出的文件是明文
      await security.reauth(a.password, '导出包含密码和私钥的主机列表');
      const r = await c.imports.exportHosts(a.format, a.path, a.hostIds, (h) => {
        // 团队主机没有允许查看密码时不导出秘密
        if (h.team && !h.team.allowReveal) return null;
        if (h.protocol === 'SERIAL') return null;
        try {
          const auth = c.hosts.connectInfo(h.id).auth;
          if (auth.method === 'PASSWORD' && auth.password) return { authMethod: 'PASSWORD', username: auth.username, password: auth.password };
          if (auth.method === 'KEY' && auth.privateKey) return { authMethod: 'KEY', username: auth.username, privateKey: auth.privateKey, passphrase: auth.passphrase };
        } catch {
          // 没有用户名等：这台主机不带秘密
        }
        return null;
      });
      c.audit.event('EXPORT_HOSTS_WITH_SECRETS', { format: a.format, count: r.count, secrets: r.secrets });
      return r;
    },

    'credential.list': () => ctx().credentials.list(),
    'credential.save': (a) => ctx().credentials.save(a.id, a.input),
    'credential.delete': (a) => {
      const c = ctx();
      const used = c.dbAssets.usingCredential(a.id);
      if (used.length) throw new UserError(`这个凭证正被数据库「${used.map((d) => d.name).join('、')}」使用，请先修改它们的密码设置`);
      c.credentials.delete(a.id);
    },
    'credential.reveal': async (a) => {
      const c = ctx();
      c.teamAssets.assertRevealable(a.id);
      const cred = c.credentials.require(a.id);
      await security.reauth(a.password, `查看凭证「${cred.name}」的明文`);
      const view = c.credentials.reveal(a.id);
      c.audit.event('CREDENTIAL_REVEAL', { credentialId: cred.id, name: cred.name, type: cred.type });
      return view;
    },
    'credential.totp': (a) => ctx().credentials.totp(a.id),
    'credential.deploy': (a, owner) => ctx().keyDeploy.deploy(owner, a.id, a.hostIds),
    'credential.rotate': (a, owner) => ctx().keyDeploy.rotate(owner, a.id, a.hostIds),

    'session.openSsh': (a, owner) => ({ sessionId: ctx().sessions.openSsh(owner, a.hostId, a.cols, a.rows) }),
    'session.openLocal': (a, owner) => ({ sessionId: ctx().sessions.openLocal(owner, a.cols, a.rows) }),
    'session.write': (a, owner) => ctx().sessions.write(owner, a.sessionId, a.data),
    'session.resize': (a, owner) => ctx().sessions.resize(owner, a.sessionId, a.cols, a.rows),
    'session.close': (a, owner) => ctx().sessions.close(owner, a.sessionId),
    'session.openTelnet': (a, owner) => ({ sessionId: ctx().sessions.openTelnet(owner, a.hostId, a.cols, a.rows) }),
    'session.openSerial': (a, owner) => ({ sessionId: ctx().sessions.openSerial(owner, a.hostId) }),
    'session.serialSet': (a, owner) =>
      ctx()
        .sessions.serial(owner, a.sessionId)
        .set({ hex: a.hex, timestamp: a.timestamp, dtr: a.dtr, rts: a.rts }),
    'session.serialSendHex': (a, owner) => ctx().sessions.serial(owner, a.sessionId).sendBytes(parseHex(String(a.hex ?? ''))),
    'session.serialSendFile': (a, owner) =>
      ctx()
        .sessions.serial(owner, a.sessionId)
        .sendFile(String(a.path), a.protocol === 'ymodem' ? 'ymodem' : 'xmodem', new AbortController().signal),
    'session.serialCancel': (a, owner) => ctx().sessions.serial(owner, a.sessionId).cancelTransfer(),
    'session.log': (a, owner) => ctx().sessions.setLog(owner, a.sessionId, a.path ? String(a.path) : null),
    'serial.list': () => ctx().sessions.listSerialPorts(),

    'mcp.list': () => {
      const c = ctx();
      const servers = c.mcpRepo.list();
      return { servers, status: servers.map((s) => c.mcpClient.status(s.id)) };
    },
    'mcp.save': (a) => {
      const c = ctx();
      const saved = c.mcpRepo.save(a.id, a.input);
      c.mcpClient.disconnect(saved.id);
      return saved;
    },
    'mcp.delete': (a) => {
      const c = ctx();
      c.mcpClient.disconnect(a.id);
      c.mcpRepo.delete(a.id);
    },
    'mcp.test': (a) => ctx().mcpClient.test(a.id),
    'mcp.host.get': () => ctx().mcpHost.state(),
    'mcp.host.set': async (a) => {
      const c = ctx();
      if (typeof a.port === 'number') c.settings.set('mcp.server.port', a.port);
      if (typeof a.enabled === 'boolean') c.settings.set('mcp.server.enabled', a.enabled);
      if (Array.isArray(a.tools)) c.settings.set('mcp.server.tools', a.tools.filter((t) => MCP_SERVER_TOOLS.some((x) => x.name === t)));
      // 权限（第十三轮）：高危指令要先允许写操作；取消写操作时高危一起取消
      if (typeof a.allowWrite === 'boolean') {
        c.settings.set('mcp.server.allowWrite', a.allowWrite);
        if (!a.allowWrite) c.settings.set('mcp.server.allowDanger', false);
      }
      if (typeof a.allowDanger === 'boolean') c.settings.set('mcp.server.allowDanger', a.allowDanger && c.settings.get('mcp.server.allowWrite'));
      return c.mcpHost.apply();
    },
    'mcp.host.resetToken': () => ctx().mcpHost.resetToken(),

    'sync.localStats': () => ctx().sync.stats(),
    'backup.export': async (a) => {
      if (!d.preset.allowLocalExport) throw new UserError('管理员禁止了导出本地数据');
      const c = ctx();
      // 包含凭证的导出文件里有密码和私钥（用导出密码加密），和「查看明文」一样先验证身份
      if (a.groups.includes('CREDENTIALS')) await security.reauth(a.masterPassword, '导出包含凭证的备份文件');
      const info = await c.sync.export(a.groups, a.filePath, a.password);
      c.audit.event('BACKUP_EXPORT', { groups: info.groups, counts: info.counts });
      return info;
    },
    'backup.inspect': (a) => ctx().sync.inspect(a.filePath),
    'backup.import': async (a) => {
      const c = ctx();
      const r = await c.sync.import(a.filePath, a.password, a.groups, a.mode, !!a.dryRun);
      if (r.applied) c.audit.event('BACKUP_IMPORT', { groups: r.groups, mode: r.mode, autoBackup: r.autoBackup });
      return r;
    },
    'backup.autoList': () => ctx().sync.autoList(),
    'backup.autoRestore': (a) => {
      const c = ctx();
      const r = c.sync.autoRestore(a.name, !!a.dryRun);
      if (r.applied) c.audit.event('BACKUP_RESTORE', { name: a.name, groups: r.groups });
      return r;
    },

    'portforward.list': (a) => {
      const c = ctx();
      return { forwards: c.portForwards.list(a.hostId ?? null), status: c.forwarding.statuses(a.hostId ?? null) };
    },
    'portforward.save': (a) => {
      const c = ctx();
      const host = c.hosts.require(a.hostId);
      if (host.protocol !== 'SSH') throw new UserError('只有 SSH 主机可以设置端口转发');
      if (a.id) c.forwarding.stop(a.id);
      return c.portForwards.save(a.id, a.hostId, a.input);
    },
    'portforward.delete': (a) => {
      const c = ctx();
      c.forwarding.stop(a.id);
      c.portForwards.delete(a.id);
    },
    'portforward.start': (a, owner) => ctx().forwarding.start(owner, a.id),
    'portforward.stop': (a) => ctx().forwarding.stop(a.id),

    'prompt.answer': (a, owner) => ctx().prompts.answer(owner, a.promptId, a.answer),

    'sftp.open': (a, owner) => ctx().sftp.open(owner, a.hostId),
    'sftp.close': (a, owner) => {
      const c = ctx();
      c.edits.stopSftp(a.sftpId);
      c.sftp.close(owner, a.sftpId);
    },
    'sftp.readText': (a, owner) => ctx().edits.readText(owner, a.sftpId, a.path),
    'sftp.writeText': (a, owner) => ctx().edits.writeText(owner, a.sftpId, a.path, String(a.content ?? ''), typeof a.expectMtime === 'number' ? a.expectMtime : null),
    'sftp.editExternal': (a, owner) => ctx().edits.editExternal(owner, a.sftpId, a.path),
    'sftp.editList': (a, owner) => ctx().edits.list(owner, a.sftpId ?? null),
    'sftp.editResolve': (a, owner) => ctx().edits.resolve(owner, a.editId, a.action === 'discard' ? 'discard' : 'overwrite'),
    'sftp.editStop': (a, owner) => ctx().edits.stop(owner, a.editId),
    'sftp.list': (a, owner) => ctx().sftp.list(owner, a.sftpId, a.path),
    'sftp.mkdir': (a, owner) => ctx().sftp.mkdir(owner, a.sftpId, a.path),
    'sftp.rename': (a, owner) => ctx().sftp.rename(owner, a.sftpId, a.from, a.to),
    'sftp.delete': (a, owner) => ctx().sftp.delete(owner, a.sftpId, a.paths),
    'sftp.compress': (a, owner) => ctx().sftp.compress(owner, a.sftpId, a.paths),
    // 文件面板（第十六轮）
    'sftp.createFile': (a, owner) => ctx().sftp.createFile(owner, a.sftpId, a.path),
    'sftp.chmod': (a, owner) => ctx().sftp.chmod(owner, a.sftpId, a.paths, Number(a.mode), !!a.recursive),
    'sftp.copy': (a, owner) => ctx().sftp.copy(owner, a.sftpId, a.paths, a.destDir),
    'sftp.move': (a, owner) => ctx().sftp.move(owner, a.sftpId, a.paths, a.destDir),
    'sftp.archive': (a, owner) => ctx().sftp.archive(owner, a.sftpId, a.paths, String(a.name ?? ''), a.format === 'zip' ? 'zip' : 'tar.gz'),
    'sftp.dragOut': async (a, owner) => {
      const r = await ctx().sftp.downloadForDrag(owner, a.sftpId, a.paths, d.drag.cacheDir(), DRAG_OUT_LIMIT);
      if ('tooLarge' in r) return { started: false, tooLarge: true, total: r.total };
      d.drag.start(owner, r.files);
      return { started: true };
    },

    'local.home': () => ctx().localFs.home(),
    'local.list': (a) => ctx().localFs.list(a.path),
    'local.mkdir': (a) => ctx().localFs.mkdir(a.path),
    'local.rename': (a) => ctx().localFs.rename(a.from, a.to),
    'local.trash': (a) => ctx().localFs.trash(a.paths),
    'local.reveal': (a) => ctx().localFs.reveal(a.path),
    'local.downloadsDir': () => d.downloadsDir(),
    'local.clipboardFiles': () => d.clipboardFiles(),
    'dialog.openFiles': (_a, owner) => d.dialogs.openFiles(owner),
    'dialog.openFile': (a, owner) => d.dialogs.openFile(owner, a.title, a.filters),
    'dialog.openDirectory': (a, owner) => d.dialogs.openDirectory(owner, a.title),
    'dialog.saveFile': (a, owner) => d.dialogs.saveFile(owner, a.title, a.defaultName, a.filters),
    'dialog.saveText': async (a, owner) => {
      const content = String(a.content ?? '');
      if (content.length > 64 * 1024 * 1024) throw new UserError('内容太大（超过 64 MB）');
      const path = await d.dialogs.saveFile(owner, a.title, a.defaultName, a.filters);
      if (!path) return null;
      writeFileSync(path, content, 'utf8');
      return path;
    },

    'monitor.subscribe': (a, owner) => ctx().monitor.subscribe(owner, a.hostId),
    'monitor.unsubscribe': (a, owner) => ctx().monitor.unsubscribe(owner, a.hostId),
    'monitor.alerts': () => ctx().resident.alerts(),
    'alert.list': (a) => {
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, 200) : undefined);
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const pick = <T extends string>(v: unknown, ok: readonly T[]): T | undefined => (ok.includes(v as T) ? (v as T) : undefined);
      return ctx().alerts.list({
        limit: num(a?.limit),
        offset: num(a?.offset),
        source: pick(a?.source, ['MONITOR', 'SCHEDULE', 'EXTERNAL'] as const),
        level: pick(a?.level, ['INFO', 'WARN', 'CRIT'] as const),
        status: pick(a?.status, ['FIRING', 'RESOLVED'] as const),
        hostId: str(a?.hostId),
        q: str(a?.q),
        from: num(a?.from),
        to: num(a?.to),
      });
    },
    'alert.delete': (a) => ctx().alerts.delete(Array.isArray(a.ids) ? a.ids.map(String) : []),
    'alert.diagnose': (a) => ctx().alerts.diagnose(String(a.id)),
    'monitor.kill': (a, owner) => ctx().monitor.kill(owner, a.hostId, a.pid, a.signal),
    'monitor.procs': (a, owner) => ctx().monitor.procs(owner, a.hostId, a.sort === 'mem' ? 'mem' : 'cpu', a.limit),
    'monitor.static': (a, owner) => ctx().monitor.staticInfo(owner, a.hostId),
    'monitor.net': (a, owner) => ctx().monitor.net(owner, a.hostId),
    'monitor.bigfiles': (a, owner) => ctx().monitor.bigFiles(owner, a.hostId, a.paths, Number(a.minMb), Number(a.limit)),
    'monitor.history': (a) => {
      const c = ctx();
      return { samples: c.metrics.history(a.hostId, Number(a.days) || 7), forecast: c.metrics.forecast(a.hostId) };
    },

    'transfer.start': (a, owner) => ({ transferIds: ctx().transfers.start(owner, a.sftpId, a.direction, a.items) }),
    'transfer.cancel': (a, owner) => ctx().transfers.cancel(owner, a.transferId),
    'transfer.pause': (a, owner) => ctx().transfers.pause(owner, a.transferId),
    'transfer.resume': (a, owner) => ctx().transfers.resume(owner, a.transferId),

    'ai.providers.list': () => ctx().providers.list(),
    'ai.providers.save': (a) => {
      if (!d.preset.allowPersonalProvider) throw new UserError('管理员禁止了添加个人 AI 模型');
      const c = ctx();
      if (c.team()?.allowPersonalProvider === false) throw new UserError('管理员只允许使用团队模型，不能添加个人模型');
      return c.providers.save(a.id, a.input);
    },
    'ai.providers.delete': (a) => ctx().providers.delete(a.id),
    'ai.providers.fetchModels': (a) => {
      const c = ctx();
      // 只用来取地址和 Key：模型列表还没有时用一个占位模型通过校验
      const input = a.input.models?.length ? a.input : { ...a.input, models: [{ id: '__probe__', contextWindow: 8000, maxOutput: 1000 }] };
      return fetchModelList(c.providers.resolveDraft(a.id, input, input.models[0].id));
    },
    'ai.providers.probe': (a) => {
      const c = ctx();
      if (typeof a.modelId !== 'string' || !a.modelId.trim()) throw new UserError('请先填写模型 ID');
      const input = a.input.models?.some((m) => m.id === a.modelId) ? a.input : { ...a.input, models: [...(a.input.models ?? []), { id: a.modelId, contextWindow: 128_000, maxOutput: 8192 }] };
      const r = c.providers.resolveDraft(a.id, input, a.modelId);
      if (r.provider.source === 'team') throw new UserError('团队模型由管理员配置，不能在这里检测');
      return probeModel(r, { listModels: () => fetchModelList(r).catch(() => []) });
    },
    'web.status': () => ctx().webSearch.status(),
    'web.saveKey': (a) => ctx().webSearch.saveKey(typeof a.apiKey === 'string' ? a.apiKey : null),
    'web.test': (a) => ctx().webSearch.test(a.setting, typeof a.apiKey === 'string' ? a.apiKey : null, typeof a.query === 'string' ? a.query : undefined),
    'ai.providers.test': async (a) => {
      const c = ctx();
      const started = Date.now();
      const res = await c.runtime.call(
        c.providers.resolveDraft(a.id, a.input, a.modelId),
        {
          system: '这是一次连接测试，请只回复「连接成功」。',
          messages: [{ role: 'user', mode: 'ask', blocks: [{ kind: 'question', text: 'ping' }] }],
          tools: [],
        },
        AbortSignal.timeout(60_000),
      );
      return { latencyMs: Date.now() - started, reply: res.text.trim().slice(0, 200) || '（模型没有返回文字）' };
    },

    'agent.list': () => ctx().agent.list(),
    'agent.create': (a) => ctx().agent.create(a.model),
    'agent.get': (a) => ctx().agent.view(a.id),
    'agent.delete': (a) => ctx().agent.delete(a.id),
    'agent.send': (a, owner) => ctx().agent.send(owner, a.id, a.text, a.mode, a.model, a.refs, a.thinking, a.policy, a.web === true),
    'agent.stop': (a) => ctx().agent.stop(a.id),
    'agent.approve': (a, owner) =>
      ctx().agent.approve(owner, a.id, a.approvalId, {
        decision: a.decision,
        command: a.command,
        confirmText: a.confirmText,
        hosts: Array.isArray(a.hosts) ? a.hosts.map(String) : undefined,
        answer: typeof a.answer === 'string' ? a.answer : undefined,
        memory: typeof a.memory === 'string' ? a.memory : undefined,
      }),
    'agent.compress': (a, owner) => ctx().agent.compress(owner, a.id, a.model),
    'agent.markdown': (a) => ctx().agent.markdown(a.id),
    'agent.summarizeNote': (a) => ctx().agent.summarizeForNote(a.id, a.model ?? null),
    'ai.describeCommand': (a) => ctx().agent.describeCommand(String(a.command ?? ''), typeof a.context === 'string' ? a.context : null, a.model ?? null),
    'agent.export': (a) => {
      if (typeof a.path !== 'string' || !isAbsolute(a.path)) throw new UserError('导出路径不正确');
      writeFileSync(a.path, ctx().agent.markdown(a.id), 'utf8');
    },
    'agent.usage': (a) => ctx().agent.usage(a.id, a.model, a.refs),

    // 数据库资产（第十七轮，文档一 6.31.2）
    'db.list': () => ctx().dbAssets.list(),
    'db.save': (a) => ctx().dbAssets.save(a.id ?? null, a.input),
    'db.duplicate': (a) => ctx().dbAssets.duplicate(a.id),
    'db.delete': (a) => ctx().dbAssets.delete(Array.isArray(a.ids) ? a.ids : []),
    'db.test': (a, owner) => ctx().databases.test(owner, a.id ?? null, a.input),
    // SQL 工作台（第十八轮，文档一 6.32）
    'db.objects': (a, owner) => ctx().workbench.objects(owner, a.id, a),
    'db.columns': (a, owner) => ctx().workbench.columns(owner, a.id, a, a.tables),
    'db.describe': (a, owner) => ctx().workbench.describe(owner, a.id, a, a.table),
    'db.plan': (a) => {
      const { classes: _classes, ...plan } = ctx().workbench.plan(a.id, String(a.sql ?? ''));
      return plan;
    },
    'db.exec': (a, owner) => ctx().workbench.exec(owner, a),
    'db.cancel': (a) => ctx().workbench.cancel(a.runId),
    'db.exportQuery': (a, owner) => ctx().workbench.exportQuery(owner, a),
    'db.ai': (a, owner) => ctx().workbench.ai(owner, a),
    'schedule.testWebhook': (a) => ctx().scheduler.testWebhook(a.webhook),
    'db.exportCsv': (a) => {
      if (typeof a.path !== 'string' || !isAbsolute(a.path)) throw new UserError('导出路径不正确');
      if (!Array.isArray(a.columns) || !Array.isArray(a.rows)) throw new UserError('没有可以导出的数据');
      writeFileSync(a.path, toCsv(a.columns.map(String), a.rows.map((r) => (Array.isArray(r) ? r.map((v) => (v === null ? null : String(v))) : []))), 'utf8');
    },

    'completion.suggest': (a, owner) => ctx().completion.suggest(owner, a.hostId ?? null, a.sessionId ?? null, String(a.prefix ?? ''), AbortSignal.timeout(5000)),
    'completion.matches': (a, owner) => ctx().completion.matches(owner, a.hostId ?? null, String(a.prefix ?? ''), a.limit),
    'history.list': (a, owner) => ctx().completion.history(owner, a.hostId ?? null, { q: a.q ?? '', offset: a.offset, limit: a.limit, refresh: a.refresh }),
    'history.delete': (a) => ctx().completion.deleteHistory(a.hostId ?? null, String(a.command ?? '')),
    'history.clear': (a) => ctx().completion.clearHistory(a.hostId ?? null),
    'file.execCheck': (a, owner) => {
      if (typeof a.path !== 'string' || !a.path.trim()) throw new UserError('没有文件路径');
      return checkExecutable(ctx().pool, owner, a.hostId ?? null, a.path.trim());
    },
    'completion.record': (a) => {
      const c = ctx();
      const command = String(a.command ?? '');
      c.completion.record(a.hostId ?? null, command);
      // 手动输入的命令也进审计（文档一 6.12）：空格开头、# 问 AI 的不记；密码等秘密先脱敏
      const cmd = command.trim();
      if (!cmd || /^\s/.test(command) || cmd.startsWith('#')) return;
      const host = a.hostId ? c.hosts.get(a.hostId) : null;
      c.audit.command({
        source: 'USER',
        hostId: host?.id ?? null,
        hostName: host?.name ?? (a.hostId ? null : '本机'),
        sessionId: a.sessionId ?? null,
        command: new Masker({ maskIps: false, maskPii: false }).mask(cmd).text,
      });
    },
    'server.state': () => ctx().serverState(),
    'approval.pending': () => ctx().server?.approvals.list() ?? [],
    'approval.decide': (a) => {
      const c = ctx();
      if (!c.server) throw new UserError('没有连接服务端');
      const item = c.server.approvals.list().find((x) => x.approvalId === a.approvalId);
      c.server.approvals.decide(a.approvalId, a.decision, a.comment);
      // 审计里记下批准 / 拒绝的是哪条命令（命令先脱敏）
      c.audit.event('REMOTE_APPROVAL', {
        approvalId: a.approvalId,
        decision: a.decision,
        runId: item?.runId,
        taskName: item?.taskName,
        host: item?.host,
        command: item ? new Masker({ maskIps: false, maskPii: false }).mask(item.command).text : undefined,
        risk: item?.risk,
        comment: a.comment?.slice(0, 500) || undefined,
      });
    },
    'task.runs': (a) => {
      const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, 200) : undefined);
      const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const st = ['RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'TIMEOUT', 'CANCELLED', 'ISSUES'].includes(String(a?.status)) ? (a!.status as TaskRunFilter['status']) : undefined;
      return ctx().scheduler.runs({ limit: num(a?.limit), offset: num(a?.offset), taskId: str(a?.taskId), hostId: str(a?.hostId), status: st, q: str(a?.q), from: num(a?.from), to: num(a?.to) });
    },
    'schedule.list': () => ctx().scheduler.list(),
    'schedule.save': (a) => ctx().scheduler.save(typeof a.id === 'string' ? a.id : null, a.input, 'USER', { generatePlan: a.generatePlan === true }),
    'schedule.delete': (a) => ctx().scheduler.delete(String(a.id)),
    'schedule.enable': (a) => ctx().scheduler.enable(String(a.id), !!a.enabled),
    'schedule.runNow': (a) => ctx().scheduler.runNow(String(a.id)),
    'schedule.cancel': (a) => ctx().scheduler.cancel(String(a.runId)),
    'schedule.check': (a) => ctx().scheduler.check(String(a.command ?? ''), Array.isArray(a.hostIds) ? a.hostIds.map(String) : []),
    'schedule.approvals': () => ctx().scheduler.approvals.list(),
    'schedule.decide': (a) => ctx().scheduler.approvals.decide(String(a.id), !!a.approve),
    'schedule.trial': (a, owner) => ctx().scheduler.trial(owner, String(a.token), a.input),
    'schedule.trialCancel': (a) => ctx().scheduler.trialCancel(String(a.token)),
    'task.runNote': async (a) => {
      const c = ctx();
      const v = c.scheduler.run(String(a.runId));
      if (!v) throw new UserError('这条执行记录不存在');
      const time = new Date(v.startedAt).toLocaleString('zh-CN', { hour12: false });
      const title = `${v.taskName ?? '定时任务'} · ${time}`;
      return { title, body: await c.agent.summarizeTaskRun(runNoteInput(v, time), title, null) };
    },
    'schedule.generatePlan': (a) => ctx().scheduler.startPlanGen(String(a.id)),
    'schedule.cancelPlan': (a) => ctx().scheduler.cancelPlanGen(String(a.id)),
    'schedule.checkPlan': (a) => ctx().scheduler.checkPlan(Array.isArray(a.steps) ? a.steps : [], Array.isArray(a.hostIds) ? a.hostIds.map(String) : []),
    'update.state': () => d.updater.get(),
    'update.check': () => d.updater.check(),
    'update.download': () => d.updater.download(),
    'update.install': () => d.updater.install(),
    'update.saveInstaller': () => d.updater.saveInstaller(),
    'update.configure': (a) => d.updater.configure(a ?? {}),
    'batch.check': (a) => ctx().batch.check(a?.hostIds ?? [], a?.command ?? ''),
    'batch.exec': (a) => ctx().batch.exec(a),
    'batch.upload': (a) => ctx().batch.upload(a),
    'batch.list': (a) => ctx().batch.list(a ?? { kind: 'exec' }),
    'batch.get': (a) => ctx().batch.get(String(a?.id ?? '')),
    'batch.cancel': (a) => ctx().batch.cancel(String(a?.id ?? '')),
    'batch.delete': (a) => ctx().batch.delete(Array.isArray(a?.ids) ? a.ids.map(String) : []),
    'batch.inspectLocal': (a) => ctx().batch.inspectLocal(Array.isArray(a?.paths) ? a.paths.map(String) : []),
    'audit.list': (a) => ctx().audit.list(a),
    'recording.list': (a) => {
      const c = ctx();
      return { ...c.recordings.list(a ?? {}), diskBytes: c.recordings.diskUsage() };
    },
    'recording.read': (a) => ctx().recordings.read(a.id),
    'recording.commands': (a) => {
      const c = ctx();
      const info = c.recordings.info(String(a.id));
      const end = info.endedAt ?? Date.now();
      // 命令审计是回车时记的，比录像开始晚；留一点余量
      return c.audit
        .sessionCommands(info.sessionId, info.startedAt - 1000, end + 1000)
        .map((x) => ({ offsetMs: Math.max(0, x.createdAt - info.startedAt), command: x.command, source: x.source, exitCode: x.exitCode }));
    },
    'recording.summarizeNote': async (a) => {
      const c = ctx();
      const id = String(a.id);
      const info = c.recordings.info(id);
      const commands = c.audit
        .sessionCommands(info.sessionId, info.startedAt - 1000, (info.endedAt ?? Date.now()) + 1000)
        .map((x) => ({ offsetMs: Math.max(0, x.createdAt - info.startedAt), command: x.command, source: x.source, exitCode: x.exitCode }));
      const title = String(a.title ?? '').trim().slice(0, 120) || `${info.hostName} 会话`;
      return c.agent.summarizeRecording(recordingTranscript(c.recordings.read(id), commands), { title, description: typeof a.description === 'string' ? a.description.slice(0, 2000) : undefined }, a.model ?? null);
    },
    'recording.export': (a) => {
      const c = ctx();
      c.recordings.exportCast(a.id, a.filePath);
      c.audit.event('RECORDING_EXPORT', { id: a.id });
    },
    'recording.delete': (a) => {
      const c = ctx();
      c.recordings.delete(a.ids);
      c.audit.event('RECORDING_DELETE', { count: a.ids.length });
    },

    'skill.list': () => ctx().skills.list().map(({ content: _content, ...info }) => info),
    'skill.read': (a) => ctx().skills.read(a.id),
    'skill.save': (a) => {
      const { content: _content, ...info } = ctx().skills.save(a.id ?? null, a.content);
      return info;
    },
    'skill.delete': (a) => ctx().skills.delete(a.id),
    'skill.run': (a, owner) => ctx().agent.runSkill(owner, String(a.skillId), a.targets ?? {}, a.params ?? {}, a.model),
    'skill.resolveTargets': (a) => {
      const r = ctx().agent.resolveSkillTargets(null, a.targets ?? {});
      return { hosts: r.hosts.map((h) => ({ id: h.id, name: h.name })), skipped: r.skipped };
    },
    'skill.openDir': () => {
      const s = ctx().skills;
      s.ensureDir();
      d.openPath(s.dir);
    },

    'snippet.list': () => ctx().snippets.library(),
    'snippet.save': (a) => ctx().snippets.save(a.id, a.input),
    'snippet.delete': (a) => ctx().snippets.delete(a.ids),
    'snippet.move': (a) => ctx().snippets.move(a.ids, a.groupId),
    'snippet.group.save': (a) => ctx().snippets.groups.save(a.id, a.name),
    'snippet.group.delete': (a) => ctx().snippets.groups.delete(a.id),
    'snippet.group.reorder': (a) => ctx().snippets.groups.reorder(a.ids),

    'storage.info': async () => {
      const c = ctx();
      const notesDir = c.settings.get('storage.notesDir');
      const dbFile = join(c.dir, 'iterminal.db');
      const size = (f: string): number => {
        try {
          return statSync(f).size;
        } catch {
          return 0;
        }
      };
      const [dataSize, notesSize] = await Promise.all([dirSize(d.storage.dataDir()), notesDir ? dirSize(notesDir) : Promise.resolve(0)]);
      const recordings = c.recordings.list({ limit: 1 }).total;
      return {
        dataDir: d.storage.dataDir(),
        defaultDataDir: d.storage.defaultDir,
        dataError: d.storage.error(),
        profileDir: c.dir,
        notesDir,
        recordingsDir: c.recordings.root(),
        recordingsCustom: !!c.settings.get('storage.recordingsDir'),
        usage: {
          dataDir: dataSize,
          database: size(dbFile) + size(`${dbFile}-wal`) + size(`${dbFile}-shm`),
          recordings: c.recordings.diskUsage(),
          recordingsCount: recordings,
          notesDir: notesSize,
          notesCount: c.notes.list().length,
        },
      };
    },
    'storage.setNotesDir': (a) => {
      const c = ctx();
      const dir = checkDir(a.dir);
      c.settings.set('storage.notesDir', dir);
      return { exported: dir ? c.noteFiles.exportAll(dir) : 0 };
    },
    'storage.setRecordingsDir': (a) => {
      const c = ctx();
      const dir = checkDir(a.dir);
      if (dir && dir === join(c.dir, 'recordings')) {
        c.settings.set('storage.recordingsDir', '');
      } else {
        c.settings.set('storage.recordingsDir', dir);
      }
      return a.move ? c.recordings.moveAll(c.settings.get('storage.recordingsDir')) : { moved: 0, failed: 0 };
    },
    'storage.setDataDir': (a) => d.storage.move(a.dir),
    'storage.reveal': (a) => {
      if (!isAbsolute(a.dir) || !existsSync(a.dir)) throw new UserError('目录不存在');
      d.openPath(a.dir);
    },
    'note.list': () => ctx().notes.library(),
    'note.save': (a) => ctx().notes.save(a.id, a.input),
    'note.importFiles': async (a, owner) => {
      const paths = Array.isArray(a?.paths)
        ? a.paths.map(String)
        : a?.kind === 'word'
          ? await d.dialogs.openFiles(owner, { title: '选择要导入的 Word 文档', filters: [{ name: 'Word 文档', extensions: NOTE_WORD_EXT }] })
          : await d.dialogs.openFiles(owner, { title: '选择要导入的 Markdown 文件', filters: [{ name: 'Markdown / 文本', extensions: NOTE_IMPORT_EXT }] });
      if (!paths.length) return { notes: [], skipped: [] };
      return importNoteFiles(ctx().notes, paths, a?.groupId ?? null);
    },
    'note.revert': (a) => ctx().notes.revert(a.id),
    'note.delete': (a) => ctx().notes.delete(a.ids),
    'note.move': (a) => ctx().notes.move(a.ids, a.groupId),
    'note.pin': (a) => ctx().notes.pin(a.id, a.pinned),
    // 分组改名 / 删除：笔记文件所在的目录跟着变
    'note.group.save': (a) => {
      const c = ctx();
      const id = c.notes.groups.save(a.id, a.name);
      if (a.id) c.noteFiles.sync(c.notes.list().filter((n) => n.groupId === id).map((n) => n.id));
      return id;
    },
    'note.group.delete': (a) => {
      const c = ctx();
      const ids = c.notes.list().filter((n) => n.groupId === a.id).map((n) => n.id);
      c.notes.groups.delete(a.id);
      c.noteFiles.sync(ids);
    },
    'note.group.reorder': (a) => ctx().notes.groups.reorder(a.ids),

    'cmdrule.list': () => {
      const c = ctx();
      const view = (r: ReturnType<typeof c.approval.getRules>[number]) => ({ id: String(r.id), level: r.level, matchType: r.matchType, pattern: r.pattern, note: r.note ?? null });
      return { user: c.commandRules.list(), builtin: c.approval.getRules().map(view), team: c.approval.getTeamRules().map(view) };
    },
    'cmdrule.save': (a) => {
      const c = ctx();
      const r = c.commandRules.save(a.id, a.input);
      c.applyCommandRules();
      return r;
    },
    'cmdrule.delete': (a) => {
      const c = ctx();
      c.commandRules.delete(a.id);
      c.applyCommandRules();
    },
    'cmdrule.setList': (a) => {
      const c = ctx();
      const r = c.commandRules.setList(a.list, a.patterns);
      c.applyCommandRules();
      return r;
    },
    'cmdrule.test': async (a) => {
      const c = ctx();
      const command = String(a.command ?? '').slice(0, 200_000);
      if (!command.trim()) throw new UserError('请输入命令');
      // 按全局默认 Agent 权限、非生产环境判定；不做 LLM 复核
      const ev = await c.approval.evaluate(
        command,
        { agentPolicy: c.settings.get('ai.defaultAgentPolicy'), production: false, policy: c.policy() },
        { autoReadonly: c.settings.get('ai.autoApproveReadonly') },
      );
      const user = new Map(c.commandRules.list().map((r) => [`u:${r.id}`, r]));
      const builtin = new Map(c.approval.getRules().map((r) => [String(r.id), r]));
      const team = new Map(c.approval.getTeamRules().map((r) => [String(r.id), r]));
      return {
        level: ev.effectiveLevel,
        decision: ev.decision,
        reasons: ev.reasons,
        segments: ev.segments.map((sg) => {
          const id = sg.ruleId === undefined ? null : String(sg.ruleId);
          const u = id ? user.get(id) : undefined;
          const t = id && !u ? team.get(id) : undefined;
          const b = id && !u && !t ? builtin.get(id) : undefined;
          return {
            text: sg.text,
            level: sg.level,
            rule: u
              ? `${u.list === 'WHITE' ? '白名单' : u.list === 'DANGER' ? '危险命令' : u.list === 'BLACK' ? '黑名单' : '自定义'}：${u.pattern}`
              : t
                ? (t.note ?? t.pattern)
                : b
                  ? (b.note ?? b.pattern)
                  : null,
            source: u ? ('user' as const) : t ? ('team' as const) : b ? ('builtin' as const) : null,
            unknown: !!sg.unknown,
          };
        }),
      };
    },
    'cmdrule.export': (a) => {
      const c = ctx();
      const s = c.settings.getAll();
      const rules = c.commandRules.list();
      const text = JSON.stringify(
        {
          format: 'itm-command-rules',
          version: 1,
          policy: { l2Decision: s['security.l2Decision'], blacklistDecision: s['security.blacklistDecision'], strict: s['security.strict'], maxLength: s['security.maxLength'] },
          rules: rules.map(({ list, level, matchType, pattern, priority, note, enabled }) => ({ list, level, matchType, pattern, priority, note, enabled })),
        },
        null,
        2,
      );
      writeFileSync(a.filePath, text, { mode: 0o600 });
      return { count: rules.length };
    },
    'cmdrule.import': (a) => {
      const c = ctx();
      let data: { format?: string; policy?: Record<string, unknown>; rules?: unknown[] };
      try {
        if (statSync(a.filePath).size > 2 * 1024 * 1024) throw new UserError('文件太大');
        data = JSON.parse(readFileSync(a.filePath, 'utf8')) as typeof data;
      } catch (e) {
        if (e instanceof UserError) throw e;
        throw new UserError('不是有效的 JSON');
      }
      if (data?.format !== 'itm-command-rules' || !Array.isArray(data.rules)) throw new UserError('不是 iTerminal 导出的命令规则文件');
      if (a.mode === 'replace') c.commandRules.reset();
      const lists: Record<string, string[]> = { WHITE: [], DANGER: [], BLACK: [] };
      if (a.mode === 'merge') for (const r of c.commandRules.list()) if (r.list) lists[r.list].push(r.pattern);
      let added = 0;
      for (const raw of data.rules.slice(0, 500)) {
        const r = raw as { list?: string | null; level?: string; matchType?: string; pattern?: string; priority?: number; note?: string | null; enabled?: boolean };
        if (r.list === 'WHITE' || r.list === 'DANGER' || r.list === 'BLACK') {
          if (typeof r.pattern === 'string' && !lists[r.list].includes(r.pattern)) {
            lists[r.list].push(r.pattern);
            added++;
          }
        } else {
          try {
            c.commandRules.save(null, { level: r.level as never, matchType: r.matchType as never, pattern: String(r.pattern ?? ''), priority: r.priority, note: r.note, enabled: r.enabled });
            added++;
          } catch {
            // 跳过不合法的条目
          }
        }
      }
      for (const l of ['WHITE', 'DANGER', 'BLACK'] as const) c.commandRules.setList(l, lists[l]);
      const p = data.policy ?? {};
      const trySet = <K extends 'security.l2Decision' | 'security.blacklistDecision' | 'security.strict' | 'security.maxLength'>(k: K, v: unknown): void => {
        try {
          if (v !== undefined) c.settings.set(k, v as never);
        } catch {
          // 不合法的值保持原样
        }
      };
      trySet('security.l2Decision', p.l2Decision);
      trySet('security.blacklistDecision', p.blacklistDecision);
      trySet('security.strict', p.strict);
      trySet('security.maxLength', p.maxLength);
      c.applyCommandRules();
      return { added };
    },
    'cmdrule.reset': () => {
      const c = ctx();
      c.commandRules.reset();
      c.settings.set('security.l2Decision', 'CONFIRM');
      c.settings.set('security.blacklistDecision', 'DENY');
      c.settings.set('security.strict', false);
      c.settings.set('security.maxLength', 10000);
      c.applyCommandRules();
    },

    'setting.getAll': () => ctx().settings.getAll(),
    'setting.set': (a) => {
      if (a.key === 'security.touchId' && a.value === true && !security.state().touchIdAvailable) throw new UserError('这台电脑不支持 Touch ID');
      ctx().settings.set(a.key, a.value);
      // 常驻监控的主机、告警阈值、远程监控开关变化：后台订阅跟着变（第二十七轮）
      if (String(a.key).startsWith('monitor.')) ctx().resident.sync();
    },

    'appearance.pickBackground': async (_a, owner) => {
      const c = ctx();
      const src = await d.dialogs.openFile(owner, '选择终端背景（图片或视频）', [
        { name: '图片和视频', extensions: [...BACKGROUND_IMAGE_EXT, ...BACKGROUND_VIDEO_EXT] },
        { name: '图片', extensions: BACKGROUND_IMAGE_EXT },
        { name: '视频（建议 MP4 / H.264）', extensions: BACKGROUND_VIDEO_EXT },
      ]);
      if (!src) return null;
      const ext = extname(src).slice(1).toLowerCase();
      const kind = BACKGROUND_IMAGE_EXT.includes(ext) ? 'image' : BACKGROUND_VIDEO_EXT.includes(ext) ? 'video' : null;
      if (!kind) throw new UserError('只支持图片（PNG、JPG、GIF、WebP、BMP）和视频（MP4、WebM、MOV）');
      const size = statSync(src).size;
      if (size > MAX_BACKGROUND_BYTES) throw new UserError(`文件太大（${Math.round(size / 1024 / 1024)}MB），背景文件不能超过 ${MAX_BACKGROUND_BYTES / 1024 / 1024}MB`);
      // 复制进档案目录：原文件移动或删除后背景仍然在；之前的背景文件删掉
      const dir = join(c.dir, 'appearance');
      mkdirSync(dir, { recursive: true });
      const file = `bg-${randomUUID().slice(0, 8)}.${ext}`;
      copyFileSync(src, join(dir, file));
      for (const f of readdirSync(dir)) if (f !== file && f.startsWith('bg-')) rmSync(join(dir, f), { force: true });
      const bg = { ...c.settings.get('terminal.background'), kind, file } as const;
      c.settings.set('terminal.background', bg);
      return { ...bg, name: basename(src), size };
    },
    'appearance.clearBackground': () => {
      const c = ctx();
      rmSync(join(c.dir, 'appearance'), { recursive: true, force: true });
      const bg = { ...c.settings.get('terminal.background'), kind: 'none' as const, file: '' };
      c.settings.set('terminal.background', bg);
      return bg;
    },
  };
}

/** 终端背景文件的大小上限 */
const MAX_BACKGROUND_BYTES = 512 * 1024 * 1024;
