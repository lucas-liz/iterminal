// ------------------------------------------------------------------ 数据库资产（文档一 6.31，第十七轮）

import type { AgentPolicy } from './core';

/** MYSQL 也用于 MariaDB 和兼容 MySQL 协议的数据库；POSTGRES 也用于兼容 PostgreSQL 协议的数据库；SQLITE 只支持本机文件 */
export type DbType = 'MYSQL' | 'POSTGRES' | 'SQLITE';
/** OFF：不加密；REQUIRE：加密但不校验证书；VERIFY：加密并校验证书 */
export type DbSslMode = 'OFF' | 'REQUIRE' | 'VERIFY';

export const DB_TYPES: { value: DbType; label: string; defaultPort: number }[] = [
  { value: 'MYSQL', label: 'MySQL / MariaDB', defaultPort: 3306 },
  { value: 'POSTGRES', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'SQLITE', label: 'SQLite（本机文件）', defaultPort: 0 },
];

/**
 * 新建连接第一步选择的数据库产品（第二十七轮）：兼容 MySQL / PostgreSQL 协议的产品用对应的驱动连接，只是默认端口和图标不同；
 * engine 为 null 的是还不支持、以后会加的（Redis、TDengine 等），在选择页显示为「即将支持」。
 */
export interface DbProduct {
  id: string;
  label: string;
  engine: DbType | null;
  defaultPort: number;
  group: 'mysql' | 'postgres' | 'local' | 'soon';
  desc: string;
}

export const DB_PRODUCTS: DbProduct[] = [
  { id: 'mysql', label: 'MySQL', engine: 'MYSQL', defaultPort: 3306, group: 'mysql', desc: '5.6 / 5.7 / 8.x' },
  { id: 'mariadb', label: 'MariaDB', engine: 'MYSQL', defaultPort: 3306, group: 'mysql', desc: '10.x / 11.x' },
  { id: 'tidb', label: 'TiDB', engine: 'MYSQL', defaultPort: 4000, group: 'mysql', desc: '分布式，兼容 MySQL 协议' },
  { id: 'oceanbase', label: 'OceanBase', engine: 'MYSQL', defaultPort: 2881, group: 'mysql', desc: 'MySQL 模式' },
  { id: 'polardb', label: 'PolarDB / RDS', engine: 'MYSQL', defaultPort: 3306, group: 'mysql', desc: '云数据库 MySQL 版' },
  { id: 'doris', label: 'Doris / StarRocks', engine: 'MYSQL', defaultPort: 9030, group: 'mysql', desc: '分析型，FE 查询端口' },
  { id: 'postgres', label: 'PostgreSQL', engine: 'POSTGRES', defaultPort: 5432, group: 'postgres', desc: '10 及以上' },
  { id: 'greenplum', label: 'Greenplum', engine: 'POSTGRES', defaultPort: 5432, group: 'postgres', desc: '兼容 PostgreSQL 协议' },
  { id: 'cockroach', label: 'CockroachDB', engine: 'POSTGRES', defaultPort: 26257, group: 'postgres', desc: '兼容 PostgreSQL 协议' },
  { id: 'sqlite', label: 'SQLite', engine: 'SQLITE', defaultPort: 0, group: 'local', desc: '本机上的数据库文件' },
  { id: 'redis', label: 'Redis', engine: null, defaultPort: 6379, group: 'soon', desc: '键值缓存' },
  { id: 'tdengine', label: 'TDengine', engine: null, defaultPort: 6041, group: 'soon', desc: '时序数据库' },
  { id: 'mongodb', label: 'MongoDB', engine: null, defaultPort: 27017, group: 'soon', desc: '文档数据库' },
  { id: 'clickhouse', label: 'ClickHouse', engine: null, defaultPort: 8123, group: 'soon', desc: '列式分析' },
  { id: 'oracle', label: 'Oracle', engine: null, defaultPort: 1521, group: 'soon', desc: '' },
  { id: 'sqlserver', label: 'SQL Server', engine: null, defaultPort: 1433, group: 'soon', desc: '' },
  { id: 'dameng', label: '达梦 DM', engine: null, defaultPort: 5236, group: 'soon', desc: '' },
  { id: 'kingbase', label: '人大金仓', engine: null, defaultPort: 54321, group: 'soon', desc: 'KingbaseES' },
  { id: 'elasticsearch', label: 'Elasticsearch', engine: null, defaultPort: 9200, group: 'soon', desc: '搜索引擎' },
  { id: 'influxdb', label: 'InfluxDB', engine: null, defaultPort: 8086, group: 'soon', desc: '时序数据库' },
];

/** 数据库记录对应的产品：保存过产品的按产品，旧记录按类型 */
export function dbProductOf(a: { type: DbType; flavor?: string | null }): DbProduct {
  const byFlavor = a.flavor ? DB_PRODUCTS.find((p) => p.id === a.flavor && p.engine === a.type) : undefined;
  return byFlavor ?? DB_PRODUCTS.find((p) => p.engine === a.type)!;
}

export interface DbAsset {
  id: string;
  name: string;
  type: DbType;
  /** 产品（DB_PRODUCTS 的 id，第二十七轮）：显示图标和名称；null = 按类型 */
  flavor?: string | null;
  /** 经过 SSH 主机时是从那台主机看的地址（数据库在那台主机上时是 127.0.0.1） */
  host: string;
  port: number;
  /** 默认库；空表示不指定 */
  database: string;
  username: string;
  /** 本条记录保存了密码（不返回密码本身） */
  hasPassword: boolean;
  /** 引用的凭证（「数据库账号」或「密码」类型）；设置后用凭证的密码（用户名为空时也用凭证的用户名） */
  credentialId: string | null;
  ssl: DbSslMode;
  /** 经过这台 SSH 主机连接（沿用它的跳板机、代理和认证）；null = 直连 */
  viaHostId: string | null;
  /** SQLite：本机文件路径 */
  filePath: string | null;
  /** null = 跟随全局默认（设置 → AI 的默认 Agent 权限） */
  agentPolicy: AgentPolicy | null;
  /** 生产环境：最低按 L1 处理，AI 审批不代批 */
  production: boolean;
  /** SQL 黑名单（正则，不区分大小写），命中时 Agent 直接拒绝 */
  sqlDenylist: string[];
  /** 给 Agent 的说明（用途、重要的表、注意事项） */
  note: string | null;
  updatedAt: number;
}

/** password：undefined = 不修改，null / 空串 = 清除 */
export interface DbAssetInput {
  name: string;
  type: DbType;
  flavor?: string | null;
  host: string;
  port: number;
  database: string;
  username: string;
  password?: string | null;
  credentialId: string | null;
  ssl: DbSslMode;
  viaHostId: string | null;
  filePath: string | null;
  agentPolicy: AgentPolicy | null;
  production: boolean;
  sqlDenylist: string[];
  note: string | null;
}

export type DbTestOutcome = { ok: true; version: string; latencyMs: number; databases: number | null } | { ok: false; error: string };

/** 查询结果（执行卡片里的表格，文档一 6.31.6）：单元格最多 500 字符，NULL 为 null */
export interface DbResultTable {
  columns: string[];
  rows: (string | null)[][];
  /** 返回的行数（不含被截掉的） */
  rowCount: number;
  /** 还有更多的行没有读取（达到行数上限），或者卡片里保存时减少了行数 */
  truncated: boolean;
  durationMs: number;
  /** 写语句影响的行数 */
  affected?: number | null;
}

// ------------------------------------------------------------------ SQL 工作台（文档一 6.32，第十八轮）

/** 库表树的一层：库 / schema / 表和视图 */
export interface DbObject {
  name: string;
  /** 表：TABLE / VIEW / …；库和 schema 为 null */
  type: string | null;
  /** 估算行数（数据库返回的原文） */
  rows: string | null;
  comment: string | null;
}

export interface DbObjectList {
  kind: 'databases' | 'schemas' | 'tables';
  items: DbObject[];
  /** 列出库时：连接默认用的库；列出表时：实际查询的库 */
  current: string | null;
  /** 只列出前 1000 个 */
  truncated: boolean;
}

export interface DbColumnInfo {
  table: string;
  name: string;
  type: string;
  nullable: boolean;
  /** PRI / UNI / MUL（MySQL）或 PRI（PostgreSQL / SQLite 的主键）；没有为 null */
  key: string | null;
  comment: string | null;
}

/** 执行前的分级（工作台弹确认用；主进程执行时再分级一次） */
export interface SqlPlanItem {
  text: string;
  start: number;
  end: number;
  level: 'L0' | 'L1' | 'L2' | 'DENY';
  verb: string;
  reasons: string[];
  /** read 只读 / write 写操作 / danger 高危 / session 会话设置（USE、SET）/ error 不能执行 */
  kind: 'read' | 'write' | 'danger' | 'session' | 'error';
}

export interface SqlPlan {
  items: SqlPlanItem[];
  /** none 直接执行 / click 确认后执行 / type 输入数据库名确认 */
  confirm: 'none' | 'click' | 'type';
  /** 有不能执行的语句时的原因（整批都不执行） */
  error: string | null;
}

export interface SqlExecItem {
  text: string;
  ok: boolean;
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  truncated: boolean;
  affected: number | null;
  durationMs: number;
  error?: string;
}

export interface SqlExecResult {
  items: SqlExecItem[];
  /** 被停止（或超时）时为 true，后面的语句没有执行 */
  stopped: boolean;
  /** 实际连接的库 */
  database: string;
}

export type SqlAiAction = 'nl2sql' | 'explain' | 'optimize' | 'diagnose';
