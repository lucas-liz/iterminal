import { useEffect, useState } from 'react';
import { Alert, App, Button, Checkbox, Space, Spin, Tooltip, Typography } from 'antd';
import { FolderOpenOutlined, ReloadOutlined } from '@ant-design/icons';
import type { StorageInfo } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { formatSize } from '../../util/format';
import { SettingGroup, SettingRow, SettingsSection } from './parts';

function PathText({ path, testId }: { path: string; testId?: string }): React.JSX.Element {
  return (
    <Typography.Text code className="storage-path selectable" data-testid={testId}>
      {path}
    </Typography.Text>
  );
}

/** 「设置 → 存储位置」：本地数据目录、录像目录、笔记文件目录，以及各自占用的空间 */
export function StorageSettings(): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (): Promise<void> => {
    try {
      setInfo(await invoke('storage.info'));
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const pick = (title: string): Promise<string | null> => invoke('dialog.openDirectory', { title });
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const reveal = (dir: string): void => void invoke('storage.reveal', { dir }).catch((e) => message.error(errorMessage(e)));

  const setRecordings = (dir: string): void => {
    let move = true;
    modal.confirm({
      title: dir ? '更换录像目录？' : '恢复默认的录像目录？',
      content: (
        <Space direction="vertical">
          <span>{dir ? `之后的录像保存到：${dir}` : '之后的录像保存到数据目录里。'}</span>
          <Checkbox defaultChecked onChange={(e) => (move = e.target.checked)} data-testid="storage-rec-move">
            把已有的 {info?.usage.recordingsCount ?? 0} 个录像也移过去
          </Checkbox>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            录像文件是加密的，只有本机这个档案能回放。
          </Typography.Text>
        </Space>
      ),
      okText: '更换',
      cancelText: '取消',
      onOk: () =>
        run(async () => {
          const r = await invoke('storage.setRecordingsDir', { dir, move });
          message.success(move ? `已更换，移动了 ${r.moved} 个录像${r.failed ? `，${r.failed} 个移动失败（留在原处）` : ''}` : '已更换');
        }),
    });
  };

  const setNotes = (dir: string): void =>
    void run(async () => {
      const r = await invoke('storage.setNotesDir', { dir });
      message.success(dir ? `已开启，导出了 ${r.exported} 篇笔记` : '已关闭，之后不再写入 Markdown 文件（已有的文件保留）');
    });

  const moveData = (dir: string | null): void => {
    modal.confirm({
      title: dir ? '更换本地数据目录？' : '恢复默认的数据目录？',
      content: (
        <Space direction="vertical">
          <span>{`应用会重启，重启时把全部本地数据（加密数据库、密钥、录像、Skill、设置）复制到：${dir ?? info?.defaultDataDir ?? ''}`}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {`复制完成后使用新目录；原目录「${info?.dataDir ?? ''}」里的数据保留作为备份，确认没问题后可以手动删除。打开的终端会断开。`}
          </Typography.Text>
        </Space>
      ),
      okText: '更换并重启',
      cancelText: '取消',
      onOk: () => run(() => invoke('storage.setDataDir', { dir })),
    });
  };

  if (!info) {
    return (
      <SettingsSection title="存储位置">
        <Spin />
      </SettingsSection>
    );
  }
  const u = info.usage;
  const customData = info.dataDir !== info.defaultDataDir;
  return (
    <SettingsSection
      title="数据"
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={busy} data-testid="storage-refresh">
          刷新
        </Button>
      }
    >
      {info.dataError && <Alert type="error" showIcon style={{ marginBottom: 16 }} message={`上一次更换数据目录失败，仍在使用原目录：${info.dataError}`} />}
      <SettingGroup title="占用空间">
        <div className="storage-usage" data-testid="storage-usage">
          <div>
            <div className="storage-num">{formatSize(u.dataDir)}</div>
            <div className="storage-label">本地数据目录（全部）</div>
          </div>
          <div>
            <div className="storage-num">{formatSize(u.database)}</div>
            <div className="storage-label">加密数据库</div>
          </div>
          <div>
            <div className="storage-num">{formatSize(u.recordings)}</div>
            <div className="storage-label">{`会话录像（${u.recordingsCount} 个）`}</div>
          </div>
          <div>
            <div className="storage-num">{info.notesDir ? formatSize(u.notesDir) : '—'}</div>
            <div className="storage-label">{`笔记文件（${u.notesCount} 篇）`}</div>
          </div>
        </div>
      </SettingGroup>
      <SettingGroup title="目录">
        <SettingRow
          label="本地数据目录"
          description={
            <>
              <PathText path={info.dataDir} testId="storage-data-dir" />
              <div>{customData ? '自定义目录' : '默认目录'} · 更换后重启并复制数据，原目录保留作备份</div>
            </>
          }
        >
          <Space>
            <Tooltip title="在文件管理器中打开">
              <Button icon={<FolderOpenOutlined />} onClick={() => reveal(info.dataDir)} />
            </Tooltip>
            <Button
              disabled={busy}
              onClick={async () => {
                const dir = await pick('选择新的本地数据目录（空目录）');
                if (dir) moveData(dir);
              }}
              data-testid="storage-data-change"
            >
              更换…
            </Button>
            {customData && <Button onClick={() => moveData(null)}>恢复默认</Button>}
          </Space>
        </SettingRow>
        <SettingRow
          label="录像目录"
          description={
            <>
              <PathText path={info.recordingsDir} testId="storage-rec-dir" />
              <div>{info.recordingsCustom ? '自定义目录' : '默认在数据目录的 recordings 里'}</div>
            </>
          }
        >
          <Space>
            <Tooltip title="在文件管理器中打开">
              <Button icon={<FolderOpenOutlined />} onClick={() => reveal(info.recordingsDir)} />
            </Tooltip>
            <Button
              disabled={busy}
              onClick={async () => {
                const dir = await pick('选择录像目录');
                if (dir) setRecordings(dir);
              }}
              data-testid="storage-rec-change"
            >
              更换…
            </Button>
            {info.recordingsCustom && <Button onClick={() => setRecordings('')}>恢复默认</Button>}
          </Space>
        </SettingRow>
        <SettingRow
          label="笔记保存路径"
          description={
            <>
              {info.notesDir ? <PathText path={info.notesDir} testId="storage-notes-dir" /> : <Typography.Text type="secondary">未开启</Typography.Text>}
              <div>开启后同时保存为「分组 / 标题.md」（单向同步，文件里的修改不会读回）</div>
            </>
          }
        >
          <Space>
            {info.notesDir && (
              <Tooltip title="在文件管理器中打开">
                <Button icon={<FolderOpenOutlined />} onClick={() => reveal(info.notesDir)} />
              </Tooltip>
            )}
            <Button
              disabled={busy}
              onClick={async () => {
                const dir = await pick('选择笔记保存目录');
                if (dir) setNotes(dir);
              }}
              data-testid="storage-notes-change"
            >
              {info.notesDir ? '更换…' : '选择目录…'}
            </Button>
            {info.notesDir && <Button onClick={() => setNotes('')}>关闭</Button>}
          </Space>
        </SettingRow>
        <SettingRow label="加密" description="整库 SQLCipher 加密，密码和私钥再单独加密" />
      </SettingGroup>
    </SettingsSection>
  );
}
