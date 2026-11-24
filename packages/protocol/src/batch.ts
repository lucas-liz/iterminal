/**
 * 批量执行（第三十五轮）：在多台主机上同时执行一条命令 / 脚本，或者把本机文件上传到多台主机。
 * 每次执行是一个任务（BatchJob），每台主机一条结果（BatchHostResult），都保存在本机档案里。
 */
export type BatchKind = 'exec' | 'upload';
/** 任务状态：全部成功 / 全部失败 / 部分失败 / 取消 */
export type BatchStatus = 'running' | 'success' | 'failed' | 'partial' | 'cancelled';
export type BatchHostStatus = 'pending' | 'running' | 'success' | 'failed' | 'denied' | 'timeout' | 'cancelled';

export interface BatchHostResult {
  hostId: string;
  hostName: string;
  address: string;
  /** 登录用的用户名 */
  username: string | null;
  status: BatchHostStatus;
  exitCode: number | null;
  /** 命令输出（标准输出 + 标准错误）；上传时是每个文件的结果 */
  output: string;
  /** 失败原因 */
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** 上传：已传 / 总字节数（只在执行中推送，不保存） */
  bytes?: number;
  totalBytes?: number;
}

/** 选中的本机文件或文件夹 */
export interface BatchLocalItem {
  path: string;
  name: string;
  dir: boolean;
  /** 文件夹为里面所有文件的总大小 */
  size: number;
  /** 文件夹里的文件个数（文件为 1） */
  files: number;
}

export interface BatchJob {
  id: string;
  kind: BatchKind;
  description: string;
  /** exec：命令或脚本内容 */
  command: string | null;
  /** exec：按脚本执行（写成临时脚本文件后执行） */
  script: boolean;
  /** exec：超时时间（秒），0 = 不限制 */
  timeoutSec: number;
  /** upload：远程目录（支持 ${username} / ${home}） */
  remotePath: string | null;
  /** upload：上传的文件和文件夹 */
  files: BatchLocalItem[];
  hostCount: number;
  fileCount: number;
  status: BatchStatus;
  createdAt: number;
  endedAt: number | null;
  /** 各状态的主机数 */
  counts: { success: number; failed: number; running: number; pending: number };
  /** 详情（batch.get、batch.progress 才有） */
  hosts?: BatchHostResult[];
}

export interface BatchExecInput {
  hostIds: string[];
  command: string;
  description?: string;
  /** 0 = 不限制 */
  timeoutSec?: number;
  script?: boolean;
}

export interface BatchUploadInput {
  hostIds: string[];
  localPaths: string[];
  remotePath: string;
  description?: string;
}

export interface BatchFilter {
  kind: BatchKind;
  q?: string;
  status?: BatchStatus | null;
  from?: number;
  to?: number;
  limit?: number;
  offset?: number;
}

/** 执行前的检查：命令的风险等级，命中黑名单的主机 */
export interface BatchCheck {
  level: 'L0' | 'L1' | 'L2' | 'DENY';
  reasons: string[];
  denied: { hostId: string; hostName: string; reasons: string[] }[];
}

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = { running: '执行中', success: '成功', failed: '失败', partial: '部分失败', cancelled: '已取消' };
export const BATCH_HOST_STATUS_LABEL: Record<BatchHostStatus, string> = {
  pending: '等待中',
  running: '执行中',
  success: '成功',
  failed: '失败',
  denied: '已拦截',
  timeout: '超时',
  cancelled: '已取消',
};
/** 上传路径里的变量 */
export const BATCH_PATH_VARS = '${username} 用户名、${home} 用户家目录';
