/**
 * 自动更新与灰度（文档一 11.5）：electron-updater 的 generic provider，从后端发布服务获取 latest*.yml；
 * 灰度比例（stagingPercentage）由服务端写进 yml，electron-updater 按设备 ID 的哈希决定是否更新；
 * 低于最低支持版本（minimumSupportedVersion）时必须升级。
 */
export type UpdateChannel = 'stable' | 'beta';

export interface UpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  currentVersion: string;
  channel: UpdateChannel;
  /** 管理员用预置配置锁定了渠道 */
  channelLocked: boolean;
  autoCheck: boolean;
  /** 实际使用的更新源（按预置 / 登录 / 默认的服务端地址生成）；null = 没有服务端地址 */
  feedUrl: string | null;
  available: { version: string; releaseDate: string | null; notes: string | null; size: number | null } | null;
  progress: { percent: number; bytesPerSecond: number; transferred: number; total: number } | null;
  error: string | null;
  /** 当前版本低于服务端的最低支持版本：必须升级才能继续使用 */
  forced: boolean;
  minimumVersion: string | null;
  lastCheckAt: number | null;
  /** 「手动下载安装包」保存的位置（自动安装不了时的兜底，第十九轮） */
  savedFile: string | null;
}

/** 比较版本号（x.y.z[-pre]），a > b 返回正数 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: string } => {
    const [main, pre = ''] = v.trim().replace(/^v/i, '').split('-', 2);
    return { nums: main.split('.').map((x) => parseInt(x, 10) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  // 1.0.0-beta < 1.0.0
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}
