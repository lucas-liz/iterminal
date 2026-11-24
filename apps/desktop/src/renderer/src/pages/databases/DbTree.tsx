import { useMemo, useState } from 'react';
import { App, Dropdown, Input, Tree, Typography } from 'antd';
import type { DataNode, EventDataNode } from 'antd/es/tree';
import { DbIcon } from '../../components/db/DbIcon';
import { ApartmentOutlined, CopyOutlined, DatabaseOutlined, EditOutlined, EyeOutlined, FileAddOutlined, KeyOutlined, ReloadOutlined, RobotOutlined, SearchOutlined, TableOutlined } from '@ant-design/icons';
import type { DbAsset } from '@itm/protocol';
import { errorMessage } from '../../api';
import { useDatabases } from '../../store/databases';
import { objKey, useSqlWorkbench } from '../../store/sql-workbench';

/** 树上的一个节点代表的东西 */
export interface DbNodeRef {
  kind: 'asset' | 'database' | 'schema' | 'table' | 'column';
  dbId: string;
  database: string | null;
  schema: string | null;
  table: string | null;
  name: string;
}

type Node = DataNode & { ref: DbNodeRef; children?: Node[]; colType?: string };

const enc = (r: DbNodeRef): string => JSON.stringify([r.kind, r.dbId, r.database, r.schema, r.table, r.name]);

export interface DbTreeActions {
  /** 双击表：新标签查询前 100 行 */
  openTable(r: DbNodeRef): void;
  newQuery(r: DbNodeRef): void;
  describe(r: DbNodeRef): void;
  template(r: DbNodeRef, kind: 'select' | 'insert'): void;
  editAsset(a: DbAsset): void;
  askAi(a: DbAsset): void;
}

/**
 * 库表树（第十八轮，文档一 6.32.1）：数据库资产 → 库（PostgreSQL：库 → schema）→ 表 / 视图 → 列。展开时才查询，结果缓存在 store 里（编辑器补全也用）。
 */
export function DbTree({ actions, selected, onSelect }: { actions: DbTreeActions; selected: string[]; onSelect(tables: DbNodeRef[]): void }): React.JSX.Element {
  const { message } = App.useApp();
  const assets = useDatabases((s) => s.list);
  const objects = useSqlWorkbench((s) => s.objects);
  const columns = useSqlWorkbench((s) => s.columns);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string[]>([]);
  const [q, setQ] = useState('');

  const tree = useMemo((): Node[] => {
    const tableNodes = (dbId: string, database: string | null, schema: string | null): Node[] | undefined => {
      const list = objects[objKey(dbId, database, schema)];
      if (!list || list.kind !== 'tables') return undefined;
      const cols = columns[objKey(dbId, database, schema)] ?? [];
      return list.items.map((t): Node => {
        const ref: DbNodeRef = { kind: 'table', dbId, database, schema, table: t.name, name: t.name };
        const mine = cols.filter((c) => c.table === t.name);
        return {
          key: enc(ref),
          ref,
          title: t.name,
          icon: t.type && /VIEW/i.test(t.type) ? <EyeOutlined /> : <TableOutlined />,
          children: mine.length
            ? mine.map((c): Node => {
                const cr: DbNodeRef = { kind: 'column', dbId, database, schema, table: t.name, name: c.name };
                return { key: enc(cr), ref: cr, title: c.name, isLeaf: true, icon: c.key === 'PRI' ? <KeyOutlined /> : <span className="db-col-dot" />, className: 'db-col', colType: c.type };
              })
            : undefined,
        };
      });
    };
    return assets.map((a): Node => {
      const ref: DbNodeRef = { kind: 'asset', dbId: a.id, database: null, schema: null, table: null, name: a.name };
      const top = objects[objKey(a.id, null, null)];
      let children: Node[] | undefined;
      if (top?.kind === 'tables') children = tableNodes(a.id, null, null);
      else if (top?.kind === 'databases') {
        children = top.items.map((d): Node => {
          const dr: DbNodeRef = { kind: 'database', dbId: a.id, database: d.name, schema: null, table: null, name: d.name };
          const sub = objects[objKey(a.id, d.name, null)];
          return {
            key: enc(dr),
            ref: dr,
            title: d.name,
            icon: <DatabaseOutlined />,
            className: d.name === top.current ? 'db-current' : undefined,
            children:
              sub?.kind === 'schemas'
                ? sub.items.map((sc): Node => {
                    const sr: DbNodeRef = { kind: 'schema', dbId: a.id, database: d.name, schema: sc.name, table: null, name: sc.name };
                    return { key: enc(sr), ref: sr, title: sc.name, icon: <ApartmentOutlined />, children: tableNodes(a.id, d.name, sc.name) };
                  })
                : tableNodes(a.id, d.name, null),
          };
        });
      }
      return { key: enc(ref), ref, title: a.name, icon: <DbIcon type={a.type} flavor={a.flavor} size={16} />, children, className: `db-asset-node${a.production ? ' prod' : ''}` };
    });
  }, [assets, objects, columns]);

  // 搜索：只保留名字匹配的表（和它们所在的库），全部展开
  const shown = useMemo((): Node[] => {
    const k = q.trim().toLowerCase();
    if (!k) return tree;
    const walk = (nodes: Node[]): Node[] =>
      nodes.flatMap((n): Node[] => {
        if (n.ref.kind === 'table') return n.ref.name.toLowerCase().includes(k) ? [{ ...n, children: undefined }] : [];
        if (n.ref.kind === 'column') return [];
        const ch = walk(n.children ?? []);
        return ch.length ? [{ ...n, children: ch }] : [];
      });
    return walk(tree);
  }, [tree, q]);
  const allKeys = (nodes: Node[]): string[] => nodes.flatMap((n) => [String(n.key), ...allKeys(n.children ?? [])]);

  const load = async (node: EventDataNode<Node>): Promise<void> => {
    const r = node.ref;
    const st = useSqlWorkbench.getState();
    try {
      if (r.kind === 'asset') await st.loadObjects(r.dbId, null, null);
      else if (r.kind === 'database') await st.loadObjects(r.dbId, r.database, null);
      else if (r.kind === 'schema') await st.loadObjects(r.dbId, r.database, r.schema);
      else if (r.kind === 'table') {
        const cols = await st.loadColumns(r.dbId, r.database, r.schema, [r.name]);
        if (!cols.length) setLoaded((l) => [...l, String(node.key)]);
      }
    } catch (e) {
      void message.error({ content: errorMessage(e), duration: 6 });
      setExpanded((x) => x.filter((key) => key !== String(node.key)));
      throw e;
    }
  };

  const menuOf = (r: DbNodeRef): { key: string; label: string; icon: React.ReactNode; onClick(): void }[] => {
    const asset = assets.find((a) => a.id === r.dbId);
    if (r.kind === 'table')
      return [
        { key: 'open', label: '查询前 100 行', icon: <TableOutlined />, onClick: () => actions.openTable(r) },
        { key: 'describe', label: '查看表结构', icon: <EyeOutlined />, onClick: () => actions.describe(r) },
        { key: 'select', label: '生成 SELECT', icon: <FileAddOutlined />, onClick: () => actions.template(r, 'select') },
        { key: 'insert', label: '生成 INSERT 模板', icon: <FileAddOutlined />, onClick: () => actions.template(r, 'insert') },
        { key: 'copy', label: '复制表名', icon: <CopyOutlined />, onClick: () => void navigator.clipboard.writeText(r.name).then(() => message.success('已复制')) },
      ];
    if (r.kind === 'column') return [{ key: 'copy', label: '复制列名', icon: <CopyOutlined />, onClick: () => void navigator.clipboard.writeText(r.name).then(() => message.success('已复制')) }];
    const items = [
      { key: 'new', label: '新建查询', icon: <FileAddOutlined />, onClick: () => actions.newQuery(r) },
      {
        key: 'refresh',
        label: '刷新',
        icon: <ReloadOutlined />,
        onClick: () => {
          useSqlWorkbench.getState().forget(r.dbId);
          setLoaded((l) => l.filter((k) => !k.includes(JSON.stringify(r.dbId))));
          setExpanded((x) => x.filter((k) => !k.includes(JSON.stringify(r.dbId)) || k === enc({ ...r, kind: 'asset', database: null, schema: null, table: null, name: asset?.name ?? r.name })));
          void useSqlWorkbench.getState().loadObjects(r.dbId, null, null, true).catch((e) => message.error(errorMessage(e)));
        },
      },
    ];
    if (r.kind === 'asset' && asset)
      items.push({ key: 'edit', label: '编辑连接', icon: <EditOutlined />, onClick: () => actions.editAsset(asset) }, { key: 'ai', label: '在 AI 对话里引用', icon: <RobotOutlined />, onClick: () => actions.askAi(asset) });
    return items;
  };

  return (
    <div className="db-tree" data-testid="db-tree">
      <Input size="small" allowClear prefix={<SearchOutlined />} placeholder="搜索已加载的表" value={q} onChange={(e) => setQ(e.target.value)} className="db-tree-search" data-testid="db-tree-search" />
      {assets.length === 0 ? (
        <Typography.Text type="secondary" className="db-tree-empty">
          还没有数据库，到「连接管理」里添加
        </Typography.Text>
      ) : (
        <Tree<Node>
          blockNode
          showIcon
          treeData={shown}
          loadData={load}
          loadedKeys={loaded}
          onLoad={(keys) => setLoaded(keys.map(String))}
          expandedKeys={q.trim() ? allKeys(shown) : expanded}
          onExpand={(keys) => setExpanded(keys.map(String))}
          multiple
          selectedKeys={selected}
          onSelect={(_keys, info) => onSelect(info.selectedNodes.map((n) => n.ref).filter((r) => r.kind === 'table'))}
          titleRender={(n) => (
            <Dropdown trigger={['contextMenu']} menu={{ items: menuOf(n.ref).map(({ onClick: _o, ...i }) => i), onClick: ({ key, domEvent }) => (domEvent.stopPropagation(), menuOf(n.ref).find((i) => i.key === key)?.onClick()) }}>
              <span
                className={`db-tree-title kind-${n.ref.kind}`}
                onDoubleClick={() => n.ref.kind === 'table' && actions.openTable(n.ref)}
                data-testid={`db-node-${n.ref.kind}-${n.ref.name}`}
                title={n.ref.kind === 'column' ? `${n.ref.name} ${n.colType ?? ''}` : undefined}
              >
                {String(n.title)}
                {n.ref.kind === 'column' && <span className="db-col-type">{n.colType}</span>}
              </span>
            </Dropdown>
          )}
        />
      )}
    </div>
  );
}
