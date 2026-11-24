import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PresetConfig } from '@itm/protocol';
import { downloadFile, fileNameOf, fileUrl, pickFile } from '../src/main/services/update/package-download';
import { bundleOf, MacDirectInstaller, needsDirectInstall, type DirectInstaller } from '../src/main/services/update/mac-direct';
import { relaxUnsignedUpdateCheck } from '../src/main/services/update/win-signature';
import { feedUrlOf, UpdaterService, type UpdaterLike } from '../src/main/services/update/updater-service';

const sha512 = (b: Buffer): string => createHash('sha512').update(b).digest('base64');

/** 本地发布服务：/files/{名称} 返回 files 里的内容 */
const files = new Map<string, Buffer>();
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '').replace(/^\/files\//, ''));
    const body = files.get(name);
    if (!body) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-length', body.length);
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/files`;
});
afterAll(() => server.close());

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itm-r19-'));
  files.clear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('安装包下载与校验（第十九轮）', () => {
  it('文件地址相对更新源；文件名解码；mac 按架构挑 arm64 / x64', () => {
    expect(fileUrl('http://s/api/v1/releases/stable/win/x64', 'iTerminal Setup 1.0.1.exe')).toBe('http://s/api/v1/releases/stable/win/x64/iTerminal%20Setup%201.0.1.exe');
    expect(fileUrl('http://s/a/', 'x.zip')).toBe('http://s/a/x.zip');
    expect(fileNameOf('http://s/a/iTerminal%20Setup%201.0.1.exe')).toBe('iTerminal Setup 1.0.1.exe');
    const list = [{ url: 'iTerminal-1.0.1-mac.zip' }, { url: 'iTerminal-1.0.1-arm64-mac.zip' }, { url: 'iTerminal-1.0.1-arm64.dmg' }];
    expect(pickFile(list, ['.zip'], 'arm64')?.url).toBe('iTerminal-1.0.1-arm64-mac.zip');
    expect(pickFile(list, ['.zip'], 'x64')?.url).toBe('iTerminal-1.0.1-mac.zip');
    expect(pickFile(list, ['.dmg', '.zip'], 'arm64')?.url).toBe('iTerminal-1.0.1-arm64.dmg');
    expect(pickFile(list, ['.dmg'], 'x64')).toBeNull();
    // 只有不带 arm64 的文件时（例如只上传了 arm64 那个源、文件名里没写架构），就用它们
    expect(pickFile([{ url: 'app.zip' }], ['.zip'], 'arm64')?.url).toBe('app.zip');
  });

  it('边下边算 SHA-512，校验通过才改名；不一致时删掉临时文件', async () => {
    const body = Buffer.alloc(300_000, 7);
    files.set('a.exe', body);
    const dest = join(dir, 'out', 'a.exe');
    const seen: number[] = [];
    await downloadFile({ url: `${base}/a.exe`, dest, sha512: sha512(body), size: body.length, fetch, onProgress: (p) => seen.push(p.percent) });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(seen.at(-1)).toBe(100);

    const bad = join(dir, 'bad.exe');
    await expect(downloadFile({ url: `${base}/a.exe`, dest: bad, sha512: sha512(Buffer.from('x')), fetch })).rejects.toThrow('SHA-512');
    expect(readdirSync(dir)).toEqual(['out']);
    await expect(downloadFile({ url: `${base}/a.exe`, dest: bad, size: 5, fetch })).rejects.toThrow('大小不对');
    await expect(downloadFile({ url: `${base}/none.exe`, dest: bad, fetch })).rejects.toThrow('HTTP 404');
  });
});

describe('Windows 签名校验（第十九轮）', () => {
  const host = (results: Record<string, string | null | Error>) => {
    const calls: string[] = [];
    const u = {
      verifyUpdateCodeSignature: async (_names: string[], file: string): Promise<string | null> => {
        calls.push(file);
        const r = results[file];
        if (r instanceof Error) throw r;
        return r ?? null;
      },
    };
    return { u, calls };
  };

  it('当前程序没签名（内测包）时不校验新版本；签了名的正式版照常校验', async () => {
    const unsigned = host({ 'C:\\iTerminal.exe': 'publisherNames: Corp Ltd., raw info: {"Status":2}', 'setup.exe': 'not signed' });
    relaxUnsignedUpdateCheck(unsigned.u, 'C:\\iTerminal.exe');
    expect(await unsigned.u.verifyUpdateCodeSignature(['Corp Ltd.'], 'setup.exe')).toBeNull();
    expect(await unsigned.u.verifyUpdateCodeSignature(['Corp Ltd.'], 'setup2.exe')).toBeNull();
    // 当前程序只校验一次
    expect(unsigned.calls).toEqual(['C:\\iTerminal.exe']);

    const signed = host({ 'C:\\iTerminal.exe': null, 'setup.exe': 'publisherNames: Corp Ltd., raw info: {"Status":2}' });
    relaxUnsignedUpdateCheck(signed.u, 'C:\\iTerminal.exe');
    expect(await signed.u.verifyUpdateCodeSignature(['Corp Ltd.'], 'setup.exe')).toMatch(/Status/);
    expect(signed.calls).toEqual(['C:\\iTerminal.exe', 'setup.exe']);

    // PowerShell 不可用、校验当前程序就出错：不拦（和 electron-updater 对旧 PowerShell 的处理一样）
    const broken = host({ 'C:\\iTerminal.exe': new Error('powershell not found') });
    relaxUnsignedUpdateCheck(broken.u, 'C:\\iTerminal.exe');
    expect(await broken.u.verifyUpdateCodeSignature(['Corp Ltd.'], 'setup.exe')).toBeNull();
  });
});

describe('macOS ad-hoc 签名的更新（第十九轮）', () => {
  it('判断是否需要自己安装：ad-hoc / 没签名 → 是，Developer ID → 否', async () => {
    expect(bundleOf('/Applications/iTerminal.app/Contents/MacOS/iTerminal')).toBe('/Applications/iTerminal.app');
    expect(bundleOf('/usr/local/bin/electron')).toBeNull();
    const out = (stderr: string) => async () => ({ stdout: '', stderr });
    expect(await needsDirectInstall('/A.app', out('Signature=adhoc\nTeamIdentifier=not set\n'))).toBe(true);
    expect(await needsDirectInstall('/A.app', out('Authority=Developer ID Application: Corp (AB12CD34EF)\nTeamIdentifier=AB12CD34EF\n'))).toBe(false);
    expect(
      await needsDirectInstall('/A.app', async () => {
        throw new Error('code object is not signed at all');
      }),
    ).toBe(true);
  });

  /** 造一个 ad-hoc 签名的最小 .app */
  const makeApp = (parent: string, version: string, id = 'com.corp.iterminal'): string => {
    const app = join(parent, 'iTerminal.app');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    const exe = join(app, 'Contents', 'MacOS', 'iTerminal');
    writeFileSync(exe, `#!/bin/sh\necho ${version}\n`);
    chmodSync(exe, 0o755);
    writeFileSync(
      join(app, 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>iTerminal</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
</dict></plist>`,
    );
    execFileSync('/usr/bin/codesign', ['-s', '-', '--force', app], { stdio: 'ignore' });
    return app;
  };
  const zipOf = (app: string, zip: string): Buffer => {
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
    return readFileSync(zip);
  };
  const version = (app: string): string => execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();

  it.runIf(process.platform === 'darwin')('下载 zip、校验后在进程退出后替换 .app', async () => {
    const installed = makeApp(join(dir, 'Applications'), '1.0.1');
    const zip = zipOf(makeApp(join(dir, 'build'), '1.0.2'), join(dir, 'new.zip'));
    files.set('iTerminal-1.0.2-arm64-mac.zip', zip);
    const spawned: string[][] = [];
    const inst = new MacDirectInstaller({ bundle: installed, workDir: join(dir, 'pending'), fetch, spawn: (_cmd, args) => spawned.push(args) });
    const url = `${base}/iTerminal-1.0.2-arm64-mac.zip`;

    await expect(inst.prepare({ url, sha512: sha512(zip), size: zip.length, version: '1.0.3', onProgress: () => undefined })).rejects.toThrow('不一致');
    expect(inst.install(true)).toBe(false);
    await inst.prepare({ url, sha512: sha512(zip), size: zip.length, version: '1.0.2', onProgress: () => undefined });
    expect(inst.install(true)).toBe(true);
    // 只安排一次（退出时的 installOnQuit 不会再起一个）
    expect(inst.install(false)).toBe(false);
    const [script, pid, oldApp, newApp, relaunch] = spawned[0];
    expect([oldApp, relaunch]).toEqual([installed, '1']);

    // 真的跑一次脚本：等一个已经退出的进程，不重新打开
    const child = spawn('/bin/sh', ['-c', 'exit 0']);
    await new Promise((r) => child.on('exit', r));
    expect(pid).toBe(String(process.pid));
    execFileSync('/bin/sh', [script, String(child.pid), oldApp, newApp, '0', join(dir, 'install.log')]);
    expect(version(installed)).toBe('1.0.2');
    expect(existsSync(`${installed}.itm-old`)).toBe(false);
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
    expect(readFileSync(join(dir, 'install.log'), 'utf8')).toContain('已安装到');
  });

  it.runIf(process.platform === 'darwin')('不是这个程序的包、签名坏了的包都不装', async () => {
    const installed = makeApp(join(dir, 'Applications'), '1.0.1');
    const other = zipOf(makeApp(join(dir, 'other'), '1.0.2', 'com.example.other'), join(dir, 'other.zip'));
    files.set('other.zip', other);
    const inst = new MacDirectInstaller({ bundle: installed, workDir: join(dir, 'pending'), fetch, spawn: () => undefined });
    await expect(inst.prepare({ url: `${base}/other.zip`, version: '1.0.2', onProgress: () => undefined })).rejects.toThrow('不是这个程序');

    const app = makeApp(join(dir, 'broken'), '1.0.2');
    writeFileSync(join(app, 'Contents', 'MacOS', 'iTerminal'), '#!/bin/sh\necho tampered\n');
    files.set('broken.zip', zipOf(app, join(dir, 'broken.zip')));
    await expect(inst.prepare({ url: `${base}/broken.zip`, version: '1.0.2', onProgress: () => undefined })).rejects.toThrow('代码签名');
    expect(version(installed)).toBe('1.0.1');
  });
});

/** 模拟 electron-updater */
class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  forceDevUpdateConfig = false;
  info: Record<string, unknown> = {};
  downloads = 0;
  installed = false;
  setFeedURL(): void {}
  async checkForUpdates(): Promise<unknown> {
    this.emit('checking-for-update');
    this.emit('update-available', this.info);
    return {};
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloads++;
    throw new Error(
      'New version 1.0.2 is not signed by the application owner: publisherNames: Corp Ltd., raw info: {\n  "SignerCertificate": null,\n  "Status": 2,\n  "StatusMessage": "The file is not digitally signed."\n}',
    );
  }
  quitAndInstall(): void {
    this.installed = true;
  }
}

const preset: PresetConfig = { serverUrl: null, requireLogin: false, updateChannel: null, allowLocalExport: true, allowPersonalProvider: true, source: 'default' };

describe('更新服务：自己安装与手动下载（第十九轮）', () => {
  const info = { version: '1.0.2', minimumSupportedVersion: '1.0.2', files: [{ url: 'iTerminal Setup 1.0.2.exe', sha512: '', size: 0 }, { url: 'iTerminal-1.0.2-mac.zip', sha512: 'abc', size: 9 }] };

  it('有自己的安装方式时不用 electron-updater 下载；安装时安排替换并退出；定时检查不会把「已下载」改回去', async () => {
    const u = new FakeUpdater();
    u.info = info;
    const prepared: { url: string; version: string }[] = [];
    let installs: boolean[] = [];
    const direct: DirectInstaller = {
      exts: ['.zip'],
      async prepare(o) {
        prepared.push({ url: o.url, version: o.version });
        o.onProgress({ percent: 50, bytesPerSecond: 1, transferred: 1, total: 2 });
      },
      install(relaunch) {
        installs.push(relaunch);
        return true;
      },
    };
    let quit = 0;
    const s = new UpdaterService({
      updater: u as unknown as UpdaterLike,
      preset,
      version: '1.0.1',
      configDir: dir,
      emit: () => undefined,
      defaultServer: 'http://srv.example/prod-api',
      direct: async () => direct,
      quit: () => quit++,
    });
    expect(await s.check()).toMatchObject({ status: 'available', forced: true });
    expect(await s.download()).toMatchObject({ status: 'downloaded' });
    expect(u.downloads).toBe(0);
    expect(prepared).toEqual([{ url: `${feedUrlOf('http://srv.example/prod-api', 'stable')}/iTerminal-1.0.2-mac.zip`, version: '1.0.2' }]);
    expect((await s.check()).status).toBe('downloaded');
    s.install();
    expect(installs).toEqual([true]);
    expect(quit).toBe(1);
    expect(u.installed).toBe(false);
    installs = [];
    s.installOnQuit();
    expect(installs).toEqual([false]);
  });

  it('Windows 签名校验失败给出中文原因（不带 raw info）；手动下载安装包到下载目录并打开', async () => {
    const body = Buffer.from('MZ fake installer');
    files.set('iTerminal Setup 1.0.2.exe', body);
    const u = new FakeUpdater();
    u.info = { ...info, files: [{ url: 'iTerminal Setup 1.0.2.exe', sha512: sha512(body), size: body.length }] };
    const opened: string[] = [];
    const downloads = join(dir, 'Downloads');
    mkdirSync(downloads);
    writeFileSync(join(downloads, 'iTerminal Setup 1.0.2.exe'), 'old');
    const s = new UpdaterService({
      updater: u as unknown as UpdaterLike,
      preset,
      version: '1.0.1',
      configDir: dir,
      emit: () => undefined,
      serverOverride: 'http://127.0.0.1:1',
      platform: 'win32',
      manual: { dir: () => downloads, fetch: (url) => fetch(url.replace(/^.*\/releases\/[^/]+\/[^/]+\/[^/]+/, base)), open: (f) => opened.push(f) },
    });
    await expect(s.saveInstaller()).rejects.toThrow('先检查更新');
    await s.check();
    const failed = await s.download();
    expect(failed.status).toBe('error');
    expect(failed.error).toContain('签名和当前程序的发布者不一致');
    expect(failed.error).not.toContain('raw info');

    const st = await s.saveInstaller();
    const saved = join(downloads, 'iTerminal Setup 1.0.2 (1).exe');
    expect(st).toMatchObject({ status: 'error', savedFile: saved, progress: null });
    expect(readFileSync(saved).equals(body)).toBe(true);
    expect(opened).toEqual([saved]);
  });
});
