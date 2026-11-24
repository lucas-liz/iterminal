import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareVersions, type PresetConfig, type UpdateState } from '@itm/protocol';
import { feedUrlOf, UpdaterService, type UpdaterLike } from '../src/main/services/update/updater-service';

/** 模拟 electron-updater：检查时按剧本发事件 */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  forceDevUpdateConfig = false;
  feeds: string[] = [];
  next: { available: boolean; info: Record<string, unknown> } | Error = { available: false, info: { version: '1.0.0' } };
  installed = false;
  setFeedURL(o: { url: string }): void {
    this.feeds.push(o.url);
  }
  async checkForUpdates(): Promise<unknown> {
    this.emit('checking-for-update');
    if (this.next instanceof Error) throw this.next;
    this.emit(this.next.available ? 'update-available' : 'update-not-available', this.next.info);
    return {};
  }
  async downloadUpdate(): Promise<unknown> {
    this.emit('download-progress', { percent: 50, bytesPerSecond: 1000, transferred: 50, total: 100 });
    this.emit('update-downloaded', {});
    return [];
  }
  quitAndInstall(): void {
    this.installed = true;
  }
}

const preset = (p: Partial<PresetConfig> = {}): PresetConfig => ({
  serverUrl: 'https://ops.example.com/',
  requireLogin: false,
  updateChannel: null,
  allowLocalExport: true,
  allowPersonalProvider: true,
  source: 'default',
  ...p,
});

let dir: string;
let events: UpdateState[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-upd-'));
  events = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const make = (u: FakeUpdater, p = preset(), version = '1.2.0') => new UpdaterService({ updater: u as unknown as UpdaterLike, preset: p, version, configDir: dir, emit: (s) => events.push(s) });

describe('自动更新（文档一 11.5）', () => {
  it('版本比较：数字逐段比较，预发布版本低于正式版', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.0', '1.2')).toBe(0);
    expect(compareVersions('1.2.0-beta.2', '1.2.0')).toBeLessThan(0);
    expect(compareVersions('1.2.0-beta.10', '1.2.0-beta.2')).toBeGreaterThan(0);
  });

  it('按服务端地址、渠道、系统和架构生成更新源；没有服务端地址时不检查', async () => {
    expect(feedUrlOf('https://ops.example.com/', 'beta', 'darwin', 'arm64')).toBe('https://ops.example.com/api/v1/releases/beta/mac/arm64');
    const u = new FakeUpdater();
    const s = make(u);
    expect(u.autoDownload).toBe(false);
    expect(s.get().feedUrl).toMatch(/^https:\/\/ops\.example\.com\/api\/v1\/releases\/stable\//);
    const off = make(new FakeUpdater(), preset({ serverUrl: null }));
    expect(off.get().status).toBe('disabled');
    expect((await off.check()).status).toBe('disabled');
  });

  it('发现新版本、下载、安装；低于最低支持版本时强制升级', async () => {
    const u = new FakeUpdater();
    const s = make(u);
    u.next = { available: true, info: { version: '1.3.0', releaseNotes: '<p>修复连接问题</p>', files: [{ size: 2048 }], minimumSupportedVersion: '1.0.0' } };
    const st = await s.check();
    expect(st).toMatchObject({ status: 'available', forced: false, available: { version: '1.3.0', notes: '修复连接问题', size: 2048 } });
    expect(events.map((e) => e.status)).toContain('checking');
    await expect(Promise.resolve().then(() => s.install())).rejects.toThrow('还没有下载完成');
    expect((await s.download()).status).toBe('downloaded');
    s.install();
    expect(u.installed).toBe(true);

    const u2 = new FakeUpdater();
    u2.next = { available: true, info: { version: '2.0.0', minimumSupportedVersion: '1.5.0' } };
    expect(await make(u2).check()).toMatchObject({ forced: true, minimumVersion: '1.5.0' });
  });

  it('切换渠道并保存；没有预置、也没有登录时用默认后台；管理员锁定渠道时不能切换', async () => {
    const u = new FakeUpdater();
    const s = make(u);
    s.configure({ channel: 'beta' });
    expect(u.feeds.at(-1)).toMatch(/\/releases\/beta\//);
    expect(JSON.parse(readFileSync(join(dir, 'update.json'), 'utf8'))).toMatchObject({ channel: 'beta' });
    // 重启后读回配置
    expect(make(new FakeUpdater()).get()).toMatchObject({ channel: 'beta' });
    // 第十二轮：去掉了自定义更新源，旧配置里的 customFeed 不再生效，用默认后台
    const d = new FakeUpdater();
    const withDefault = new UpdaterService({ updater: d as unknown as UpdaterLike, preset: preset({ serverUrl: null }), version: '1.2.0', configDir: dir, emit: () => undefined, defaultServer: 'http://198.51.100.10:51115' });
    expect(withDefault.get().feedUrl).toMatch(/^http:\/\/198\.51\.100\.10:51115\/api\/v1\/releases\/beta\//);
    const locked = make(new FakeUpdater(), preset({ updateChannel: 'stable' }));
    expect(locked.get()).toMatchObject({ channel: 'stable', channelLocked: true });
    expect(() => locked.configure({ channel: 'beta' })).toThrow('锁定');
  });

  it('检查失败给出中文原因', async () => {
    const u = new FakeUpdater();
    u.next = new Error('net::ERR_CONNECTION_REFUSED');
    expect(await make(u).check()).toMatchObject({ status: 'error', error: expect.stringContaining('无法连接到更新服务') });
  });
});

describe('更新源回退（第十六轮）', () => {
  it('前面的更新源连不上或没有版本信息时换下一个；都失败才显示错误', async () => {
    const u = new FakeUpdater();
    const calls: string[] = [];
    u.checkForUpdates = async function (this: FakeUpdater) {
      const feed = this.feeds[this.feeds.length - 1];
      calls.push(feed);
      this.emit('checking-for-update');
      if (feed.startsWith('http://127.0.0.1:8080')) {
        const e = new Error('net::ERR_CONNECTION_REFUSED');
        this.emit('error', e);
        throw e;
      }
      if (feed.startsWith('https://ops.example.com')) throw new Error('HttpError: 404 Not Found');
      this.emit('update-not-available', { version: '1.2.0' });
      return {};
    };
    const s = new UpdaterService({
      updater: u as unknown as UpdaterLike,
      preset: preset(),
      version: '1.2.0',
      configDir: dir,
      emit: (st) => events.push(st),
      adminServer: () => 'http://127.0.0.1:8080',
      defaultServer: 'https://default.example.com',
    });
    expect(s.feeds().map((f) => f.split('/api/')[0])).toEqual(['http://127.0.0.1:8080', 'https://ops.example.com', 'https://default.example.com']);
    const st = await s.check();
    expect(calls.map((f) => f.split('/api/')[0])).toEqual(['http://127.0.0.1:8080', 'https://ops.example.com', 'https://default.example.com']);
    expect(st.status).toBe('not-available');
    expect(st.feedUrl).toMatch(/^https:\/\/default\.example\.com\//);
    // 前面失败时的错误事件没有显示出来
    expect(events.some((e) => e.status === 'error')).toBe(false);
  });

  it('其他错误不换更新源；最后一个也失败时显示错误', async () => {
    const u = new FakeUpdater();
    u.next = new Error('sha512 checksum mismatch');
    const s = new UpdaterService({ updater: u as unknown as UpdaterLike, preset: preset(), version: '1.2.0', configDir: dir, emit: (st) => events.push(st), defaultServer: 'https://default.example.com' });
    const st = await s.check();
    expect(st.status).toBe('error');
    expect(u.feeds.filter((f) => f.startsWith('https://default.example.com'))).toHaveLength(0);
  });
});
