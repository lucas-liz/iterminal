import { useEffect, useState } from 'react';
import { App, Button, Empty, Popconfirm, Segmented, Space, Table, Tag, Tooltip, Typography } from 'antd';
import { ApiOutlined, CopyOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import { dbProductOf, type DbAsset } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { useAgent } from '../../store/agent';
import { useApp } from '../../store/app';
import { dbWhere, useDatabases } from '../../store/databases';
import { DbIcon } from '../../components/db/DbIcon';
import { useHosts } from '../../store/hosts';
import { aiAllowed, promptLogin } from '../../util/ai-access';
import { policyLabel } from '../../util/policy';
import { DbEditor } from './DbEditor';
import { SqlWorkbench } from './SqlWorkbench';
import { TopBarSlot } from '../../components/TopBar';

const VIEW_KEY = 'itm.db.view';

const POLICY_COLOR: Record<string, string> = { DENY: 'default', READONLY: 'default', APPROVE: 'default', AI_REVIEW: 'blue', AUTO: 'red', AUTO_ALL: 'red' };

/** 问 AI：引用这个数据库，打开 AI 对话（由用户输入问题） */
function askAi(a: DbAsset): void {
  if (!aiAllowed()) return promptLogin();
  useAgent.getState().toggleDatabase(a.id, true);
  useApp.getState().setPage('ai');
}

/**
 * 数据库（第十七轮，文档一 6.31.2）：Agent 可以直接连接查询的数据库（MySQL / PostgreSQL / 本机 SQLite），
 * 可以经过已有的 SSH 主机连接。在 AI 对话里用 @ 引用后，Agent 用 db_* 工具查表结构、执行 SQL。
 */
export function DatabasesPage(): React.JSX.Element {
  const { message } = App.useApp();
  const list = useDatabases((s) => s.list);
  const hosts = useHosts((s) => s.hosts);
  const globalPolicy = useApp((s) => s.settings['ai.defaultAgentPolicy']);
  const [editing, setEditing] = useState<{ asset: DbAsset | null } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  /** SQL 工作台 / 连接管理（第十八轮）：记在本机；还没有数据库时显示连接管理 */
  const [view, setView] = useState<'workbench' | 'manage'>(() => (localStorage.getItem(VIEW_KEY) === 'manage' ? 'manage' : 'workbench'));
  const loaded = useDatabases((s) => s.loaded);
  // 还没有数据库时显示连接管理；添加了第一个之后也留在这里（不要自己跳走），由用户切换
  useEffect(() => {
    if (loaded && list.length === 0) setView('manage');
  }, [loaded, list.length]);
  const shownView = loaded && list.length === 0 ? 'manage' : view;

  const reload = (): void => void useDatabases.getState().load().catch((e) => message.error(errorMessage(e)));
  useEffect(reload, []);

  const test = async (a: DbAsset): Promise<void> => {
    setTesting(a.id);
    try {
      const r = await invoke('db.test', { id: a.id, input: { ...a, password: undefined } });
      if (r.ok) void message.success(`「${a.name}」连接成功：${r.version} · ${r.latencyMs} ms${r.databases !== null ? ` · ${r.databases} 个库` : ''}`);
      else void message.error({ content: `「${a.name}」连接失败：${r.error}`, duration: 6 });
    } catch (e) {
      void message.error(errorMessage(e));
    } finally {
      setTesting(null);
    }
  };

  const act = (p: Promise<unknown>, ok: string): void => {
    p.then(() => {
      void message.success(ok);
      reload();
    }).catch((e) => message.error(errorMessage(e)));
  };

  return (
    <>
      <TopBarSlot>
        <div className="topbar-ctx">
          <div className="topbar-ctx-title no-drag">
            <span className="topbar-page-name">数据库</span>
            <Segmented
              size="small"
              value={shownView}
              onChange={(v) => {
                setView(v as 'workbench' | 'manage');
                localStorage.setItem(VIEW_KEY, String(v));
              }}
              options={[
                { value: 'workbench', label: 'SQL 工作台', disabled: list.length === 0 },
                { value: 'manage', label: '连接管理' },
              ]}
              data-testid="db-view"
            />
          </div>
          <div className="topbar-ctx-actions no-drag">
            <Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => setEditing({ asset: null })} data-testid="db-new">
              新建数据库
            </Button>
          </div>
        </div>
      </TopBarSlot>
      {shownView === 'workbench' ? (
        <SqlWorkbench onEditAsset={(a) => setEditing({ asset: a })} />
      ) : (
      <div className="audit-body">
        <Table<DbAsset>
          size="small"
          rowKey="id"
          dataSource={list}
          pagination={false}
          data-testid="db-table"
          onRow={(a) => ({ 'data-testid': `db-row-${a.name}`, onDoubleClick: () => setEditing({ asset: a }) }) as React.HTMLAttributes<HTMLElement>}
          locale={{
            emptyText: (
              <Empty
                image={<DatabaseOutlined style={{ fontSize: 40, color: 'var(--itm-text-3, #999)' }} />}
                description="还没有数据库。添加 MySQL、PostgreSQL 或本机 SQLite 文件后，在 AI 对话里 @ 引用，Agent 就能查表结构、执行 SQL 并汇总结果"
              />
            ),
          }}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              ellipsis: true,
              render: (_: string, a) => (
                <Space size={8}>
                  <Tooltip title={dbProductOf(a).label}>
                    <span>
                      <DbIcon type={a.type} flavor={a.flavor} size={22} />
                    </span>
                  </Tooltip>
                  <Typography.Text strong>{a.name}</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {dbProductOf(a).label}
                  </Typography.Text>
                  {a.production && (
                    <Tag color="red" bordered={false}>
                      生产
                    </Tag>
                  )}
                </Space>
              ),
            },
            { title: '地址', key: 'where', ellipsis: true, render: (_, a) => <Typography.Text className="mono" style={{ fontSize: 12 }}>{dbWhere(a)}</Typography.Text> },
            {
              title: '经过',
              key: 'via',
              width: 140,
              ellipsis: true,
              render: (_, a) => (a.type === 'SQLITE' ? <Typography.Text type="secondary">本机文件</Typography.Text> : a.viaHostId ? (hosts.find((h) => h.id === a.viaHostId)?.name ?? <Typography.Text type="danger">（主机已删除）</Typography.Text>) : <Typography.Text type="secondary">直连</Typography.Text>),
            },
            {
              title: 'Agent 权限',
              key: 'policy',
              width: 130,
              render: (_, a) =>
                a.agentPolicy ? (
                  <Tag color={POLICY_COLOR[a.agentPolicy]} bordered={false}>
                    {policyLabel(a.agentPolicy)}
                  </Tag>
                ) : (
                  <Typography.Text type="secondary">默认（{policyLabel(globalPolicy)}）</Typography.Text>
                ),
            },
            { title: '说明', dataIndex: 'note', ellipsis: true, render: (v: string | null) => <Typography.Text type="secondary">{v ?? ''}</Typography.Text> },
            {
              title: '',
              key: 'ops',
              width: 190,
              align: 'right',
              render: (_, a) => (
                <Space size={0}>
                  <Tooltip title="问 AI（引用这个数据库）">
                    <Button size="small" type="text" icon={<RobotOutlined />} onClick={() => askAi(a)} data-testid="db-ask-ai" aria-label="问 AI" />
                  </Tooltip>
                  <Tooltip title="测试连接">
                    <Button size="small" type="text" icon={<ApiOutlined />} loading={testing === a.id} onClick={() => void test(a)} data-testid="db-row-test" aria-label="测试连接" />
                  </Tooltip>
                  <Tooltip title="编辑">
                    <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing({ asset: a })} data-testid="db-edit" aria-label="编辑" />
                  </Tooltip>
                  <Tooltip title="复制">
                    <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => act(invoke('db.duplicate', { id: a.id }), '已复制')} aria-label="复制" />
                  </Tooltip>
                  <Popconfirm title={`删除数据库「${a.name}」？`} description="只删除 iTerminal 里保存的连接，不会动数据库本身" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => act(invoke('db.delete', { ids: [a.id] }), '已删除')}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} data-testid="db-delete" aria-label="删除" />
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </div>
      )}
      <DbEditor
        target={editing}
        onClose={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}
