import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Button, Dropdown, Select, Tooltip, Typography } from 'antd';
import { MoreOutlined, ReloadOutlined, SyncOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ProcDetail, ProcStat } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { formatSize } from '../../util/format';
import { MON_COLOR, SectionTitle } from './parts';

/**
 * 进程排行（按 CPU 或内存）：打开时执行一次 ps，可以设置自动刷新间隔；可以结束进程。
 * 远端的 ps 不支持排序时，退回到常驻采集脚本里的前 15 个进程（只有程序名）。
 */
export function ProcRanking({ hostId, sort, fallback }: { hostId: string; sort: 'cpu' | 'mem'; fallback: ProcStat[] }): React.JSX.Element {
  const { message, modal } = App.useApp();
  const [list, setList] = useState<ProcDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [interval, setIntervalSec] = useState(3);
  const [auto, setAuto] = useState(true);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      setList(await invoke('monitor.procs', { hostId, sort, limit: 30 }));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [hostId, sort]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => void load(), interval * 1000);
    return () => clearInterval(t);
  }, [auto, interval, load]);

  const kill = (p: { pid: number; name: string }, signal: 'TERM' | 'KILL'): void => {
    modal.confirm({
      title: `${signal === 'KILL' ? '强制结束' : '结束'}进程 ${p.pid}（${p.name}）？`,
      content: signal === 'KILL' ? '发送 SIGKILL，进程无法做清理' : '发送 SIGTERM，让进程正常退出',
      okText: signal === 'KILL' ? '强制结束' : '结束',
      okButtonProps: { danger: signal === 'KILL' },
      cancelText: '取消',
      onOk: async () => {
        try {
          await invoke('monitor.kill', { hostId, pid: p.pid, signal });
          message.success(`已向进程 ${p.pid}（${p.name}）发送 ${signal}`);
          void load();
        } catch (e) {
          message.error(errorMessage(e));
        }
      },
    });
  };

  const rows: ProcDetail[] =
    list ??
    (error
      ? [...fallback]
          .sort((a, b) => (sort === 'mem' ? b.rss - a.rss : b.cpu - a.cpu))
          .map((p) => ({ pid: p.pid, user: p.user, cpu: p.cpu, mem: p.mem, rss: p.rss, name: p.command, args: p.command }))
      : []);

  return (
    <div className="mx-card mx-procs" data-testid={`proc-ranking-${sort}`}>
      <SectionTitle
        icon={<ThunderboltOutlined />}
        color={MON_COLOR.warn}
        extra={
          <span className="mx-procs-tools">
            <Select
              size="small"
              value={interval}
              onChange={setIntervalSec}
              style={{ width: 64 }}
              options={[3, 5, 10, 30].map((s) => ({ value: s, label: `${s}s` }))}
              aria-label="刷新间隔"
            />
            <Tooltip title={auto ? '停止自动刷新' : '按间隔自动刷新'}>
              <Button size="small" type={auto ? 'default' : 'text'} icon={<SyncOutlined spin={auto && loading} />} onClick={() => setAuto((a) => !a)} className={auto ? 'mx-on' : ''} aria-label="自动刷新" />
            </Tooltip>
            <Button size="small" type="primary" icon={<ReloadOutlined />} loading={loading && !auto} onClick={() => void load()}>
              刷新
            </Button>
          </span>
        }
      >
        {sort === 'cpu' ? '进程 CPU 占用排行' : '内存占用排行'}
      </SectionTitle>
      {error && (
        <Typography.Text type="secondary" className="mx-note">
          {error}
          {fallback.length > 0 && '；下面是采集脚本里的前 15 个进程'}
        </Typography.Text>
      )}
      <div className="mx-proc-list">
        {rows.map((p) => (
          <div key={p.pid} className="mx-proc" data-testid="proc-row">
            <div className="mx-proc-top">
              <span className="mx-pid">{p.pid}</span>
              <Typography.Text strong className="mx-proc-name" ellipsis>
                {p.name}
              </Typography.Text>
              <span className="mx-proc-metric">
                <b style={{ color: sort === 'mem' ? MON_COLOR.bad : MON_COLOR.ok }}>{sort === 'mem' ? formatSize(p.rss * 1024) : `${p.cpu.toFixed(1)}%`}</b>
                <small>{sort === 'mem' ? 'MEM' : 'CPU'}</small>
              </span>
              <span className="mx-proc-metric">
                <b>{sort === 'mem' ? `${p.cpu.toFixed(1)}%` : `${p.mem.toFixed(1)}%`}</b>
                <small>{sort === 'mem' ? 'CPU' : 'MEM'}</small>
              </span>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'TERM', label: '结束进程（TERM）' },
                    { key: 'KILL', label: '强制结束（KILL）', danger: true },
                  ],
                  onClick: ({ key }) => kill(p, key as 'TERM' | 'KILL'),
                }}
              >
                <Button size="small" type="text" icon={<MoreOutlined />} aria-label="进程操作" />
              </Dropdown>
            </div>
            <div className="mx-proc-bottom">
              <span className="mx-user">{p.user}</span>
              <Tooltip title={p.args.length > 60 ? p.args : undefined} placement="topLeft">
                <span className="mx-args">{p.args}</span>
              </Tooltip>
            </div>
          </div>
        ))}
        {!rows.length && !error && <Typography.Text type="secondary">{loading ? '正在读取进程…' : '没有进程'}</Typography.Text>}
      </div>
    </div>
  );
}
