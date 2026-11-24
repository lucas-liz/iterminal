import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from 'antd';
import type { FileEntry, ConflictPolicy, TransferItem } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useTabs, type Tab } from '../../store/tabs';
import { useTransfers } from '../../store/transfers';
import { joinRemote, parentRemote } from '../../util/format';
import { FilePane, type PathOps } from './FilePane';
import { TransferList } from '../../components/TransferList';
import { askConflict } from '../../components/sftp/conflict';
import { FilePanel } from '../../components/FilePanel';

const isWin = window.itm.platform === 'win32';

const remoteOps: PathOps = { join: joinRemote, parent: parentRemote };

const localOps: PathOps = isWin
  ? {
      join: (dir, name) => (dir.endsWith('\\') ? dir + name : `${dir}\\${name}`),
      parent: (p) => {
        const trimmed = p.replace(/\\+$/, '');
        const i = trimmed.lastIndexOf('\\');
        if (i < 0) return p;
        const up = trimmed.slice(0, i);
        return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
      },
    }
  : remoteOps;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

interface PaneState {
  path: string;
  home: string;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
}

const emptyPane: PaneState = { path: '', home: '', entries: [], loading: true, error: null };

/**
 * SFTP 标签页：左边本地、右边远端。远端窗格和终端右侧的文件面板是同一个组件（第二十六轮），
 * 右键菜单、新建文件、复制 / 剪切 / 粘贴、压缩、权限、收藏目录、列设置、路径历史都一样；
 * 两边可以互相拖动，「上传 / 下载」同名时询问处理方式。
 */
export function SftpView({ tab }: { tab: Tab; active: boolean }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const setTabStatus = useTabs((s) => s.setStatus);
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [local, setLocal] = useState<PaneState>(emptyPane);
  /** 远端窗格当前的目录和内容（上传前检查同名） */
  const remote = useRef<{ path: string; entries: FileEntry[] }>({ path: '', entries: [] });
  const allTransfers = useTransfers((s) => s.items);
  const transfers = useMemo(() => allTransfers.filter((t) => t.sftpId === sftpId), [allTransfers, sftpId]);

  const listLocal = useCallback(
    async (path: string) => {
      setLocal((s) => ({ ...s, loading: true }));
      try {
        const entries = await invoke('local.list', { path });
        setLocal((s) => ({ ...s, path, entries, loading: false, error: null }));
      } catch (e) {
        setLocal((s) => ({ ...s, loading: false }));
        message.error(errorMessage(e));
      }
    },
    [message],
  );

  useEffect(() => {
    setTabStatus(tab.id, 'connecting');
    void (async () => {
      const home = await invoke('local.home');
      setLocal((s) => ({ ...s, home }));
      await listLocal(home);
    })();
  }, [listLocal]);

  // 下载完成后刷新本地窗格（上传完成时远端窗格自己会刷新）
  const doneDownloads = transfers.filter((t) => t.status === 'done' && t.direction === 'download').length;
  const localPath = local.path;
  useEffect(() => {
    if (doneDownloads > 0 && localPath) void listLocal(localPath);
  }, [doneDownloads]);

  /**
   * 发起传输前检查目标是否有同名文件，有则让用户选处理方式。
   * 每次都重新列一遍目标目录（第三十一轮）：窗格不会自动刷新，按旧列表判断会漏掉 / 误报同名
   */
  const transfer = async (direction: 'upload' | 'download', sources: string[]): Promise<void> => {
    if (!sftpId || sources.length === 0) return;
    const target = direction === 'upload' ? remote.current : local;
    const ops = direction === 'upload' ? remoteOps : localOps;
    const items: TransferItem[] = sources.map((src) => {
      const dest = ops.join(target.path, baseName(src));
      return direction === 'upload' ? { localPath: src, remotePath: dest } : { localPath: dest, remotePath: src };
    });
    let fresh: FileEntry[];
    try {
      fresh = direction === 'upload' ? await invoke('sftp.list', { sftpId, path: target.path }) : await invoke('local.list', { path: target.path });
    } catch (e) {
      message.error(errorMessage(e));
      return;
    }
    if (direction === 'download') setLocal((s) => (s.path === target.path ? { ...s, entries: fresh } : s));
    const conflicts = sources.map(baseName).filter((n) => fresh.some((e) => e.name === n));
    const go = async (conflict: ConflictPolicy): Promise<void> => {
      try {
        await invoke('transfer.start', { sftpId, direction, items: items.map((i) => ({ ...i, conflict })) });
      } catch (e) {
        message.error(errorMessage(e));
      }
    };
    if (conflicts.length === 0) {
      void go('overwrite');
      return;
    }
    // 有同名项目时让用户选：覆盖 / 跳过 / 保留两者 / 断点续传
    void askConflict(modal, conflicts).then((policy) => policy && go(policy));
  };

  const guard = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      message.error(errorMessage(e));
      return false;
    }
  };

  return (
    <div className="sftp" data-testid={`sftp-${tab.title}`}>
      <div className="sftp-panes">
        <FilePane
          side="local"
          title="本地"
          {...local}
          pathOps={localOps}
          onNavigate={(p) => void listLocal(p)}
          onRefresh={() => void listLocal(local.path)}
          onMkdir={(p) => guard(async () => (await invoke('local.mkdir', { path: p }), listLocal(local.path)))}
          onRename={(from, to) => guard(async () => (await invoke('local.rename', { from, to }), listLocal(local.path)))}
          onDelete={(entries) =>
            modal.confirm({
              title: `把 ${entries.length} 个项目移到${isWin ? '回收站' : '废纸篓'}？`,
              okText: '移除',
              cancelText: '取消',
              onOk: () => guard(async () => (await invoke('local.trash', { paths: entries.map((e) => e.path) }), listLocal(local.path))),
            })
          }
          onTransfer={(entries) => void transfer('upload', entries.map((e) => e.path))}
          onDropPaths={(paths, from) => from === 'remote' && void transfer('download', paths)}
          onReveal={(e) => void invoke('local.reveal', { path: e.path })}
        />
        <div className="file-pane remote-pane" data-testid="pane-remote">
          <FilePanel
            tab={tab}
            variant="sftp"
            onReady={(r) => {
              if ('error' in r) return setTabStatus(tab.id, 'error');
              setSftpId(r.sftpId);
              setTabStatus(tab.id, 'ready');
            }}
            onListing={(path, entries) => (remote.current = { path, entries })}
            onDownload={(entries) => void transfer('download', entries.map((e) => e.path))}
          />
        </div>
      </div>
      <TransferList sftpId={sftpId} />
    </div>
  );
}
