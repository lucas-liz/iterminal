import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { UserError } from '../../util/errors';
import { downloadFile, fileNameOf, type DownloadProgress } from './package-download';

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
type FetchLike = (url: string) => Promise<Response>;

const execP: Exec = async (file, args) => {
  const r = await promisify(execFile)(file, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
};

/** 自己下载、自己安装的更新方式（不经过 electron-updater 的安装器） */
export interface DirectInstaller {
  /** 用哪种安装包（扩展名，按优先顺序） */
  exts: string[];
  /** 下载并准备好新版本；不能用时抛出 UserError */
  prepare(o: { url: string; sha512?: string; size?: number; version: string; onProgress(p: DownloadProgress): void }): Promise<void>;
  /** 安排在应用退出后安装（relaunch = 装好后重新打开）；没有准备好的更新或者已经安排过返回 false */
  install(relaunch: boolean): boolean;
}

/** 正在运行的 .app（可执行文件在 X.app/Contents/MacOS/ 下）；不在 .app 里返回 null */
export function bundleOf(exe: string): string | null {
  const b = resolve(exe, '../../..');
  return b.endsWith('.app') ? b : null;
}

/**
 * 当前程序是 ad-hoc 签名或者没有签名（没有 Team ID）。Squirrel.Mac 要求新版本满足当前程序的 designated requirement，
 * ad-hoc 签名的要求是 `cdhash H"…"`，每次构建都不一样，所以必然「代码未能满足指定的代码要求」。
 */
export async function needsDirectInstall(bundle: string, exec: Exec = execP): Promise<boolean> {
  try {
    const { stdout, stderr } = await exec('/usr/bin/codesign', ['-dv', '--verbose=2', bundle]);
    const out = `${stdout}\n${stderr}`;
    return /Signature=adhoc/.test(out) || !/TeamIdentifier=(?!not set)\S+/.test(out);
  } catch {
    // code object is not signed at all
    return true;
  }
}

async function plistValue(app: string, key: string, exec: Exec): Promise<string> {
  const { stdout } = await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')]);
  return stdout.trim();
}

/**
 * 等 iTerminal 退出后用新版本替换 .app（失败时换回旧版本），按需重新打开。
 * 参数：PID 旧.app 新.app 是否重新打开 日志文件
 */
const INSTALL_SH = `#!/bin/sh
PID="$1"; OLD="$2"; NEW="$3"; RELAUNCH="$4"; LOG="$5"
exec >>"$LOG" 2>&1
echo "$(date '+%F %T') 等待进程 $PID 退出"
while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done
BAK="$OLD.itm-old"
rm -rf "$BAK"
if mv "$OLD" "$BAK"; then
  if mv "$NEW" "$OLD" 2>/dev/null || { rm -rf "$OLD"; ditto "$NEW" "$OLD"; }; then
    rm -rf "$BAK"
    echo "$(date '+%F %T') 已安装到 $OLD"
  else
    echo "$(date '+%F %T') 替换失败，换回旧版本"
    rm -rf "$OLD"
    mv "$BAK" "$OLD"
  fi
else
  echo "$(date '+%F %T') 无法移动 $OLD"
fi
rm -rf "$(dirname "$NEW")"
if [ "$RELAUNCH" = "1" ]; then open "$OLD"; fi
`;

/**
 * macOS ad-hoc 签名的内测包的自动更新（第十九轮）：下载 zip（校验 SHA-512），用 ditto 解压，检查 Bundle ID、版本号和签名完整性，
 * 应用退出后由独立的 shell 脚本替换 .app。正式签名（Developer ID）的包仍然走 electron-updater / Squirrel.Mac。
 */
export class MacDirectInstaller implements DirectInstaller {
  readonly exts = ['.zip'];
  private ready: string | null = null;
  private scheduled = false;

  constructor(
    private readonly d: {
      /** 当前的 .app */
      bundle: string;
      /** 下载、解压用的目录（每次准备前清空） */
      workDir: string;
      fetch: FetchLike;
      exec?: Exec;
      spawn?: (cmd: string, args: string[]) => void;
      pid?: number;
    },
  ) {}

  private writable(): void {
    const b = this.d.bundle;
    if (b.includes('/AppTranslocation/')) throw new UserError('iTerminal 正在从系统的隔离位置运行，请先把它拖到「应用程序」文件夹，再打开后更新');
    if (b.startsWith('/Volumes/')) throw new UserError('iTerminal 正在从磁盘映像里运行，请先把它拖到「应用程序」文件夹，再打开后更新');
    try {
      accessSync(dirname(b), constants.W_OK);
      accessSync(b, constants.W_OK);
    } catch {
      throw new UserError(`没有权限替换 ${b}，请点「手动下载安装包」安装`);
    }
  }

  async prepare(o: { url: string; sha512?: string; size?: number; version: string; onProgress(p: DownloadProgress): void }): Promise<void> {
    const exec = this.d.exec ?? execP;
    this.ready = null;
    this.writable();
    rmSync(this.d.workDir, { recursive: true, force: true });
    const zip = join(this.d.workDir, fileNameOf(o.url) || 'update.zip');
    await downloadFile({ url: o.url, dest: zip, sha512: o.sha512, size: o.size, fetch: this.d.fetch, onProgress: o.onProgress });
    const stage = join(this.d.workDir, 'stage');
    mkdirSync(stage, { recursive: true });
    try {
      await exec('/usr/bin/ditto', ['-x', '-k', zip, stage]);
    } catch (e) {
      throw new UserError(`解压更新包失败：${firstLine(e)}`);
    }
    rmSync(zip, { force: true });
    const name = readdirSync(stage).find((n) => n.endsWith('.app'));
    if (!name) throw new UserError('更新包里没有 .app，请确认上传的是 electron-builder 生成的 mac zip');
    const next = join(stage, name);
    const [id, mine, version] = await Promise.all([
      plistValue(next, 'CFBundleIdentifier', exec),
      plistValue(this.d.bundle, 'CFBundleIdentifier', exec),
      plistValue(next, 'CFBundleShortVersionString', exec),
    ]).catch((e) => {
      throw new UserError(`读取更新包信息失败：${firstLine(e)}`);
    });
    if (id !== mine) throw new UserError(`更新包不是这个程序（${id}）`);
    if (version !== o.version) throw new UserError(`更新包里的版本是 ${version}，和更新服务上的 ${o.version} 不一致`);
    try {
      await exec('/usr/bin/codesign', ['--verify', '--deep', '--strict', next]);
    } catch (e) {
      throw new UserError(`更新包的代码签名不完整：${firstLine(e)}`);
    }
    await exec('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', next]).catch(() => undefined);
    this.ready = next;
  }

  install(relaunch: boolean): boolean {
    if (!this.ready || this.scheduled) return false;
    this.writable();
    const script = join(this.d.workDir, 'install.sh');
    writeFileSync(script, INSTALL_SH, { mode: 0o755 });
    const args = [script, String(this.d.pid ?? process.pid), this.d.bundle, this.ready, relaunch ? '1' : '0', join(this.d.workDir, 'install.log')];
    if (this.d.spawn) this.d.spawn('/bin/sh', args);
    else spawn('/bin/sh', args, { detached: true, stdio: 'ignore' }).unref();
    this.scheduled = true;
    return true;
  }
}

function firstLine(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return String(err?.stderr || err?.message || e).trim().split('\n')[0];
}

/** 应用里用的工厂：打包后的 ad-hoc 签名 mac 程序才自己安装，第一次用时判断一次 */
export function macDirectFactory(o: { exe: string; workDir: string; fetch: FetchLike; packaged: boolean; platform?: string }): () => Promise<DirectInstaller | null> {
  let p: Promise<DirectInstaller | null> | null = null;
  return () =>
    (p ??= (async () => {
      if (!o.packaged || (o.platform ?? process.platform) !== 'darwin') return null;
      const bundle = bundleOf(o.exe);
      if (!bundle || !(await needsDirectInstall(bundle))) return null;
      return new MacDirectInstaller({ bundle, workDir: o.workDir, fetch: o.fetch });
    })());
}
