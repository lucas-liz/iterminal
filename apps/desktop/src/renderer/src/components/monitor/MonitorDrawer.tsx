import { useState } from 'react';
import { Drawer } from 'antd';
import type { MonitorTab } from '../../store/workspace';
import { MonitorPanel } from './MonitorPanel';

/**
 * 监控页的主机详情：右侧抽屉，内容和终端右侧的「监控」面板相同（综合、处理器、显卡、内存、磁盘、网络）。
 */
export function MonitorDrawer({ open, onClose, hostId, hostName }: { open: boolean; onClose(): void; hostId: string; hostName: string }): React.JSX.Element {
  const [tab, setTab] = useState<MonitorTab>('overview');
  return (
    <Drawer open={open} onClose={onClose} placement="right" width={560} title={`实时监控 · ${hostName}`} destroyOnHidden styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}>
      {open && <MonitorPanel hostId={hostId} hostName={hostName} tab={tab} onTab={setTab} />}
    </Drawer>
  );
}
