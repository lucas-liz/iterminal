import { describe, expect, it } from 'vitest';
import { applyPolicy, classifySql, DEFAULT_POLICY, type SqlDialect } from '../src/index';

type Case = [sql: string, level: 'L0' | 'L1' | 'L2' | 'DENY', dialect?: SqlDialect];

/** 文档一 6.31.5 的分级样本 */
const CASES: Case[] = [
  // 只读
  ['SELECT 1', 'L0'],
  ['select * from t_order where id = 5;', 'L0'],
  ['  (SELECT a FROM t) UNION (SELECT b FROM u)  ', 'L0'],
  ['WITH c AS (SELECT id FROM t) SELECT * FROM c', 'L0'],
  ['WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 5) SELECT * FROM r', 'L0', 'postgres'],
  ['SHOW TABLES', 'L0'],
  ['show processlist', 'L0'],
  ['DESCRIBE t_order', 'L0'],
  ['desc t_order', 'L0'],
  ['EXPLAIN SELECT * FROM t', 'L0'],
  ['EXPLAIN FORMAT=JSON SELECT * FROM t', 'L0'],
  ['EXPLAIN DELETE FROM t', 'L0'],
  ['EXPLAIN (COSTS false) SELECT 1', 'L0', 'postgres'],
  ['EXPLAIN ANALYZE SELECT * FROM t', 'L0', 'postgres'],
  ['EXPLAIN QUERY PLAN SELECT * FROM t', 'L0', 'sqlite'],
  ['VALUES (1), (2)', 'L0', 'postgres'],
  ['TABLE t_order', 'L0', 'postgres'],
  ['PRAGMA table_info(t)', 'L0', 'sqlite'],
  ['SELECT REPLACE(name, \'a\', \'b\'), INSERT(name, 1, 2, \'x\') FROM t', 'L0'],
  ["SELECT 'DROP TABLE t; DELETE FROM u' AS s", 'L0'],
  ['SELECT "DELETE FROM t" FROM `update`', 'L0'],
  ['SELECT 1 -- ; DROP TABLE t', 'L0'],
  ['SELECT 1 # ; DROP TABLE t', 'L0', 'mysql'],
  ['SELECT 1 /* ; DROP TABLE t */', 'L0'],
  ['SELECT $$; DROP TABLE t$$', 'L0', 'postgres'],
  ["SELECT E'it\\'s; DROP TABLE t'", 'L0', 'postgres'],
  ['SELECT [weird;name] FROM t', 'L0', 'sqlite'],
  ['SELECT @a := 1', 'L0', 'mysql'],
  ['SELECT id INTO @x FROM t LIMIT 1', 'L0', 'mysql'],
  ['SELECT * FROM t WHERE updated_at > now() ORDER BY id', 'L0'],
  // 加锁读、副作用函数
  ['SELECT * FROM t WHERE id = 1 FOR UPDATE', 'L1'],
  ['SELECT * FROM t FOR NO KEY UPDATE', 'L1', 'postgres'],
  ['SELECT * FROM t LOCK IN SHARE MODE', 'L1', 'mysql'],
  ['SELECT SLEEP(10)', 'L1', 'mysql'],
  ["SELECT nextval('seq')", 'L1', 'postgres'],
  ["SELECT pg_catalog.set_config('search_path', 'x', false)", 'L1', 'postgres'],
  ['SELECT * INTO new_t FROM t', 'L1', 'postgres'],
  ["SELECT * FROM t INTO OUTFILE '/tmp/x'", 'L2', 'mysql'],
  ["SELECT LOAD_FILE('/etc/passwd')", 'L2', 'mysql'],
  ["SELECT pg_read_file('/etc/passwd')", 'L2', 'postgres'],
  ['SELECT pg_terminate_backend(123)', 'L2', 'postgres'],
  ["WITH x AS (SELECT pg_read_file('/etc/passwd')) SELECT * FROM x", 'L2', 'postgres'],
  // 写操作
  ['INSERT INTO t (a) VALUES (1)', 'L1'],
  ['INSERT t VALUES (1)', 'L1', 'mysql'],
  ['REPLACE INTO t VALUES (1)', 'L1', 'mysql'],
  ['INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2', 'L1', 'mysql'],
  ['UPDATE t SET a = 1 WHERE id = 5', 'L1'],
  ['update t1 join t2 on t1.id = t2.id set t1.a = t2.a where t2.flag = 1', 'L1', 'mysql'],
  ['DELETE FROM t WHERE created_at < now() - interval 30 day', 'L1', 'mysql'],
  ['DELETE FROM t WHERE 1=1 AND id = 5', 'L1'],
  ['CREATE TABLE t2 (id int)', 'L1'],
  ['CREATE INDEX idx_a ON t (a)', 'L1'],
  ['CREATE OR REPLACE VIEW v AS SELECT 1', 'L1'],
  ['ALTER TABLE t ADD COLUMN b int', 'L1'],
  ['ALTER TABLE t RENAME TO t3', 'L1'],
  ['COMMENT ON TABLE t IS \'x\'', 'L1', 'postgres'],
  ['ANALYZE TABLE t', 'L1', 'mysql'],
  ['VACUUM', 'L1', 'postgres'],
  ['PRAGMA journal_mode = WAL', 'L1', 'sqlite'],
  ['WITH d AS (SELECT id FROM t) UPDATE u SET a = 1 WHERE id IN (SELECT id FROM d)', 'L1', 'postgres'],
  ['RENAME TABLE a TO b', 'L1', 'mysql'],
  // 高危
  ['DROP TABLE t', 'L2'],
  ['drop database shop', 'L2'],
  ['TRUNCATE TABLE t', 'L2'],
  ['DELETE FROM t', 'L2'],
  ['DELETE FROM t LIMIT 100', 'L2', 'mysql'],
  ['UPDATE t SET a = 1', 'L2'],
  ['UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)', 'L2'],
  ['DELETE FROM t WHERE 1=1', 'L2'],
  ['DELETE FROM t WHERE TRUE', 'L2'],
  ["DELETE FROM t WHERE 'a' = 'a'", 'L2'],
  ['UPDATE t SET a = 1 WHERE id = 5 OR 1 = 1', 'L2'],
  ['ALTER TABLE t DROP COLUMN b', 'L2'],
  ['GRANT ALL ON *.* TO x', 'L2', 'mysql'],
  ["CREATE USER x IDENTIFIED BY 'p'", 'L2', 'mysql'],
  ['ALTER USER x', 'L2'],
  ['SET GLOBAL max_connections = 10', 'L2', 'mysql'],
  ['KILL 123', 'L2', 'mysql'],
  ['CALL p()', 'L2'],
  ['DO $$ BEGIN DELETE FROM t; END $$', 'L2', 'postgres'],
  ["LOAD DATA INFILE '/tmp/x' INTO TABLE t", 'L2', 'mysql'],
  ['WITH d AS (DELETE FROM t WHERE id = 1 RETURNING *) SELECT * FROM d', 'L2', 'postgres'],
  ['EXPLAIN ANALYZE DELETE FROM t', 'L2', 'postgres'],
  ['FROBNICATE t', 'L2'],
  ['ALTER SYSTEM SET work_mem = 1', 'L2', 'postgres'],
  // 拒绝
  ['', 'DENY'],
  ['  ;  ', 'DENY'],
  ['SELECT 1; DROP TABLE t', 'DENY'],
  ['SELECT 1; SELECT 2', 'DENY'],
  ["SELECT 'unterminated", 'DENY'],
  ['SELECT 1 /* open', 'DENY'],
  ['SELECT /*! 1; DROP TABLE t */', 'DENY', 'mysql'],
  ['SELECT /* a /* b */ c */ 1', 'DENY', 'postgres'],
  ['USE shop', 'DENY', 'mysql'],
  ['SET search_path = x', 'DENY', 'postgres'],
  ['SET NAMES utf8mb4', 'DENY', 'mysql'],
  ['BEGIN', 'DENY'],
  ['START TRANSACTION', 'DENY', 'mysql'],
  ['COMMIT', 'DENY'],
  ['LOCK TABLES t WRITE', 'DENY', 'mysql'],
  ["COPY t TO '/tmp/x'", 'DENY', 'postgres'],
  ["ATTACH DATABASE '/tmp/x.db' AS x", 'DENY', 'sqlite'],
];

describe('SQL 分级样本（文档一 6.31.5）', () => {
  it.each(CASES)('%s → %s', (sql, level, dialect) => {
    const c = classifySql(sql, dialect ?? 'mysql');
    expect(c.level, `${sql}：${c.reasons.join('；')}`).toBe(level);
    // MySQL 之外的方言：除方言专属语法外，PostgreSQL / SQLite 下也不能比预期更宽松
    if (!dialect && level !== 'L0') {
      for (const d of ['postgres', 'sqlite'] as const) expect(['L1', 'L2', 'DENY'].indexOf(classifySql(sql, d).level), `${d}: ${sql}`).toBeGreaterThanOrEqual(['L1', 'L2', 'DENY'].indexOf(level));
    }
  });
});

describe('SQL 分级的细节', () => {
  it('结尾的分号和注释被去掉，statement 用于执行', () => {
    const c = classifySql('SELECT 1; -- 完成\n', 'mysql');
    expect(c.level).toBe('L0');
    expect(c.statement).toBe('SELECT 1');
    expect(classifySql('SELECT 1;;', 'postgres').level).toBe('L0');
  });

  it('MySQL 的 --x 不是注释（1--1 是减负一）', () => {
    // 如果把 --(…) 当成注释，就会漏掉后面的 LOAD_FILE
    expect(classifySql("SELECT 1--(SELECT LOAD_FILE('/etc/passwd'))", 'mysql').level).toBe('L2');
  });

  it('MySQL 按两种转义方式判断，取更严格的', () => {
    // NO_BACKSLASH_ESCAPES 下 'a\' 是完整字符串，后面的 LOAD_FILE 会执行
    const c = classifySql("SELECT 'a\\', LOAD_FILE(0x2f657463) -- '", 'mysql');
    expect(classifySql("SELECT 'a\\', LOAD_FILE(0x2f657463) -- '", 'postgres').level).toBe('L2');
    expect(c.level).toBe('L2');
    expect(c.reasons.join('')).toContain('NO_BACKSLASH_ESCAPES');
  });

  it('cursorable / estimable', () => {
    expect(classifySql('SELECT * FROM t', 'postgres').cursorable).toBe(true);
    expect(classifySql('WITH c AS (SELECT 1) SELECT * FROM c', 'postgres').cursorable).toBe(true);
    expect(classifySql('SHOW work_mem', 'postgres').cursorable).toBe(false);
    expect(classifySql('EXPLAIN SELECT 1', 'postgres').cursorable).toBe(false);
    expect(classifySql('SELECT * FROM t FOR UPDATE', 'postgres').cursorable).toBe(false);
    expect(classifySql('UPDATE t SET a = 1 WHERE id = 1', 'mysql').estimable).toBe(true);
    expect(classifySql('INSERT INTO t VALUES (1)', 'mysql').estimable).toBe(false);
    expect(classifySql('SELECT 1', 'mysql').verb).toBe('SELECT');
    expect(classifySql('WITH c AS (SELECT 1) UPDATE t SET a = 1 WHERE id = 2', 'postgres').verb).toBe('UPDATE');
  });

  it('超过 50 KB 拒绝；无法识别的语句标记 unknown（严格模式下拒绝）', () => {
    expect(classifySql(`SELECT '${'x'.repeat(51 * 1024)}'`, 'mysql').level).toBe('DENY');
    const u = classifySql('FROBNICATE t', 'mysql');
    expect(u.segments[0].unknown).toBe(true);
    const strict = applyPolicy(u, 'FROBNICATE t', { agentPolicy: 'APPROVE', production: false, policy: { ...DEFAULT_POLICY, security: { ...DEFAULT_POLICY.security, strict: true } } }, true);
    expect(strict.decision).toBe('DENY');
  });

  it('接入 applyPolicy：只读权限拒绝写，生产环境查询也要批准，黑名单拒绝', () => {
    const ctx = { agentPolicy: 'APPROVE' as const, production: false, policy: DEFAULT_POLICY };
    expect(applyPolicy(classifySql('SELECT 1', 'mysql'), 'SELECT 1', ctx, true).decision).toBe('AUTO');
    expect(applyPolicy(classifySql('UPDATE t SET a=1 WHERE id=1', 'mysql'), 'x', ctx, true).decision).toBe('APPROVE');
    expect(applyPolicy(classifySql('DROP TABLE t', 'mysql'), 'x', ctx, true).decision).toBe('CONFIRM');
    expect(applyPolicy(classifySql('UPDATE t SET a=1 WHERE id=1', 'mysql'), 'x', { ...ctx, agentPolicy: 'READONLY' }, true).decision).toBe('DENY');
    expect(applyPolicy(classifySql('SELECT 1', 'mysql'), 'SELECT 1', { ...ctx, production: true }, true).decision).toBe('APPROVE');
    const sql = 'SELECT * FROM t_payment';
    expect(applyPolicy(classifySql(sql, 'mysql'), sql, { ...ctx, hostDenylist: ['(?i)\\bt_payment\\b'.replace('(?i)', '')] }, true).decision).toBe('DENY');
  });
});

describe('拆分语句、光标所在语句、引用的表（文档一 6.32）', () => {
  it('按分号拆开；字符串、注释、$$ 里的分号不算；只有注释的片段丢掉', async () => {
    const { splitSql, statementAt } = await import('../src/index');
    const sql = "SELECT 'a;b';\n-- 注释; 还是注释\nUPDATE t SET x = 1 WHERE id = 2 ;\n\n /* ; */ ;\nSELECT 3";
    const p = splitSql(sql, 'mysql');
    expect(p.map((x) => x.text)).toEqual(["SELECT 'a;b'", '-- 注释; 还是注释\nUPDATE t SET x = 1 WHERE id = 2', 'SELECT 3']);
    expect(sql.slice(p[2].start, p[2].end)).toBe('SELECT 3');
    expect(splitSql('DO $$ BEGIN PERFORM 1; END $$; SELECT 1', 'postgres').map((x) => x.text)).toEqual(['DO $$ BEGIN PERFORM 1; END $$', 'SELECT 1']);
    expect(splitSql("SELECT 'open", 'mysql')).toHaveLength(1);
    expect(splitSql('  ;; ', 'mysql')).toEqual([]);
    const two = 'SELECT 1;\nSELECT 2;';
    expect(statementAt(two, 'mysql', 3)?.text).toBe('SELECT 1');
    expect(statementAt(two, 'mysql', two.length)?.text).toBe('SELECT 2');
    expect(statementAt(two, 'mysql', 9)?.text).toBe('SELECT 1');
  });

  it('引用的表', async () => {
    const { referencedTables } = await import('../src/index');
    expect(referencedTables('SELECT * FROM shop.t_order o JOIN `t_user` u ON u.id = o.user_id WHERE o.id IN (SELECT order_id FROM t_item)', 'mysql').sort()).toEqual(['t_item', 't_order', 't_user']);
    expect(referencedTables('UPDATE "Sales"."Region" SET name = \'from x\'', 'postgres')).toEqual(['Region']);
    expect(referencedTables("INSERT INTO log (msg) VALUES ('select * from secret')", 'sqlite')).toEqual(['log']);
    expect(referencedTables('-- from ghost\nSELECT 1 FROM DUAL', 'mysql')).toEqual([]);
  });
});
